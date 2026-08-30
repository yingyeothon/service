package cmd

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/sites.ts.
type site struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Slug            string  `json:"slug"`
	Description     *string `json:"description"`
	TeamID          *string `json:"teamId"`
	TeamName        *string `json:"teamName"`
	ProjectID       *string `json:"projectId"`
	ProjectName     *string `json:"projectName"`
	CreatedBy       *string `json:"createdBy"`
	PublicURL       string  `json:"publicUrl"`
	BasePath        string  `json:"basePath"`
	CurrentDeployID *string `json:"currentDeployId"`
	Busy            bool    `json:"busy"`
	CreatedAt       int64   `json:"createdAt"`
	UpdatedAt       int64   `json:"updatedAt"`
	// Only on the detail route.
	CurrentDeploy *siteDeploy  `json:"currentDeploy,omitempty"`
	Deploys       []siteDeploy `json:"deploys,omitempty"`
}

type siteDeploy struct {
	ID        string  `json:"id"`
	SiteID    string  `json:"siteId"`
	Status    string  `json:"status"`
	ZipBytes  int64   `json:"zipBytes"`
	Bytes     int64   `json:"bytes"`
	Files     int     `json:"files"`
	Error     *string `json:"error"`
	CreatedBy *string `json:"createdBy"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

type siteDeployGrant struct {
	DeployID  string            `json:"deployId"`
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt int64             `json:"expiresAt"`
}

// siteSharedOriginWarning is byte-identical to SITE_SHARED_ORIGIN_WARNING in
// services/console/src/sites.ts and the SPA (docs/decisions.md *Static sites*).
const siteSharedOriginWarning = "Every site on this host shares one origin: another site here can read this page, its storage and its in-memory state (same-origin frames). Never keep a credential (JWT, API token) in localStorage, sessionStorage or IndexedDB; use short-lived tokens minted per session and treat this host as untrusted."

// siteMaxZipBytes mirrors SITE_MAX_ZIP_BYTES (decision 4).
const siteMaxZipBytes = 5 * 1024 * 1024

func newSites(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "site",
		Short: "Static sites: a zip or a build directory served at the shared static host (a site belongs to a project)",
		Long: "Static sites: a build directory or zip published at https://g.yyt.life/<slug>/\n" +
			"(dev: https://dev-g.yyt.life/<slug>/). One live tree per site, no history: a\n" +
			"deploy replaces the previous files and invalidates the CDN path.\n\n" +
			siteSharedOriginWarning + "\n\n" +
			"Build for the base path the site reports (`yyt site get`): vite `base: \"./\"`\n" +
			"(relative) or `base: \"/<slug>/\"`, Flutter `--base-href /<slug>/`; absolute\n" +
			"`/assets/...` references break. Runtime config is a file in the build\n" +
			"(e.g. config.json), never a token.\n\n" +
			"<site> is an id (st_…) or a name unique within the team; a name is looked up\n" +
			"in the project context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`). `create` and `deploy` need an explicit context.",
	}
	siteID := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.site(cmd.Context(), arg, write)
		return cc, id, err
	}
	c.AddCommand(
		newSiteList(a),
		newSiteCreate(a),
		newSiteGet(a, siteID),
		newSiteUpdate(a, siteID),
		newSiteDelete(a, siteID),
		newSiteDeploy(a, siteID),
		newSiteDeploys(a, siteID),
	)
	return group(c)
}

type siteResolver func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error)

func (c *ctxClient) site(ctx context.Context, arg string, write bool) (string, error) {
	return c.resource(ctx, "site", "/sites", "sites", arg, write)
}

func (a *App) printSite(s site) error {
	if a.jsonOut {
		return a.printer().JSONValue(s)
	}
	pairs := [][2]string{
		{"id", s.ID},
		{"name", s.Name},
		{"project", crumb(s.TeamName, s.ProjectName)},
		{"url", s.PublicURL},
		{"basePath", s.BasePath},
		{"description", output.Str(s.Description)},
		{"createdBy", output.Str(s.CreatedBy)},
		{"created", output.Time(s.CreatedAt)},
		{"updated", output.Time(s.UpdatedAt)},
		{"live", output.Str(s.CurrentDeployID)},
		{"busy", fmt.Sprint(s.Busy)},
	}
	if err := a.printer().KV(pairs); err != nil {
		return err
	}
	if len(s.Deploys) == 0 {
		return nil
	}
	fmt.Fprintln(a.Out)
	return a.printDeploys(s.Deploys)
}

func (a *App) printDeploys(rows []siteDeploy) error {
	if a.jsonOut {
		return a.printer().JSONValue(map[string]any{"deploys": rows})
	}
	out := make([][]string, 0, len(rows))
	for _, d := range rows {
		out = append(out, []string{d.ID, d.Status, fmt.Sprint(d.Files), fmt.Sprint(d.Bytes), output.Str(d.Error), output.Str(d.CreatedBy), output.Time(d.CreatedAt)})
	}
	return a.printer().Table([]string{"DEPLOY", "STATUS", "FILES", "BYTES", "ERROR", "BY", "CREATED"}, out)
}

func newSiteList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the sites of the project in context, or of every team you sit in",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			path := "/sites"
			if cc.spec.explicitTeam() || cc.spec.explicitProject() {
				r, err := cc.project(cmd.Context(), false)
				if err != nil {
					return err
				}
				path = "/projects/" + api.PathID(r.ProjectID) + "/sites"
			}
			var res struct {
				Sites []site `json:"sites"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Sites))
			for _, s := range res.Sites {
				rows = append(rows, []string{s.ID, s.Name, crumb(s.TeamName, s.ProjectName), s.PublicURL, output.Str(s.CurrentDeployID), output.Time(s.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "TEAM/PROJECT", "URL", "LIVE", "UPDATED"}, rows)
		},
	}
}

func newSiteCreate(a *App) *cobra.Command {
	var description string
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a site in the project context (explicit); prints its URL and base path",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), true)
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0]}
			if description != "" {
				body["description"] = description
			}
			var s site
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/sites", body, &s); err != nil {
				return err
			}
			if err := a.printSite(s); err != nil {
				return err
			}
			if !a.jsonOut {
				fmt.Fprintln(a.Err, siteSharedOriginWarning)
			}
			return nil
		},
	}
	c.Flags().StringVar(&description, "description", "", "human-readable description")
	return c
}

func newSiteGet(a *App, siteID siteResolver) *cobra.Command {
	return &cobra.Command{
		Use:   "get <site>",
		Short: "Show one site with its URL, base path and recent deploys",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := siteID(cmd, args[0], false)
			if err != nil {
				return err
			}
			var s site
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/sites/"+api.PathID(id), nil, &s); err != nil {
				return err
			}
			return a.printSite(s)
		},
	}
}

func newSiteUpdate(a *App, siteID siteResolver) *cobra.Command {
	var name, description string
	c := &cobra.Command{
		Use:   "update <site>",
		Short: "Rename a site or change its description (empty --description clears it)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			if cmd.Flags().Changed("description") {
				if description == "" {
					body["description"] = nil
				} else {
					body["description"] = description
				}
			}
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass --name and/or --description")
			}
			cc, id, err := siteID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var s site
			if err := cc.cl.Do(cmd.Context(), http.MethodPatch, "/sites/"+api.PathID(id), body, &s); err != nil {
				return err
			}
			return a.printSite(s)
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "new site name (unique within the team)")
	f.StringVar(&description, "description", "", "new description (empty clears it)")
	return c
}

func newSiteDelete(a *App, siteID siteResolver) *cobra.Command {
	return &cobra.Command{
		Use:     "delete <site>",
		Aliases: []string{"rm", "remove"},
		Short:   "Delete a site and every file it serves (refused while a deploy is in flight)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := siteID(cmd, args[0], true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, "/sites/"+api.PathID(id), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[0])
			return nil
		},
	}
}

func newSiteDeploys(a *App, siteID siteResolver) *cobra.Command {
	return &cobra.Command{
		Use:     "deploys <site>",
		Aliases: []string{"history"},
		Short:   "List the recent deploys of a site, newest first",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := siteID(cmd, args[0], false)
			if err != nil {
				return err
			}
			var res struct {
				Deploys []siteDeploy `json:"deploys"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/sites/"+api.PathID(id)+"/deploys", nil, &res); err != nil {
				return err
			}
			return a.printDeploys(res.Deploys)
		},
	}
}

func newSiteDeploy(a *App, siteID siteResolver) *cobra.Command {
	var wait time.Duration
	var noWait bool
	c := &cobra.Command{
		Use:   "deploy <site> <dir|file.zip>",
		Short: "Publish a build directory (zipped here) or a zip; waits until it is live",
		Long: "Publish a build directory or a zip as the site's new live tree.\n\n" +
			"A directory is zipped in memory (dot-files and symlinks skipped; at most\n" +
			"5 MiB compressed). The console extracts it asynchronously: this command polls\n" +
			"the deploy until it is live or failed and prints the public URL. The\n" +
			"previous files keep serving until the new set is complete; files missing\n" +
			"from the new build are removed.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := siteID(cmd, args[0], true)
			if err != nil {
				return err
			}
			payload, err := siteZipOf(args[1])
			if err != nil {
				return err
			}
			if len(payload) > siteMaxZipBytes {
				return fmt.Errorf("zip is %d bytes; a site deploy is at most %d bytes (5 MiB) — trim source maps or large media", len(payload), siteMaxZipBytes)
			}
			ctx := cmd.Context()
			var grant siteDeployGrant
			if err := cc.cl.Do(ctx, http.MethodPost, "/sites/"+api.PathID(id)+"/deploys", map[string]any{"size": len(payload)}, &grant); err != nil {
				return err
			}
			if err := putPresigned(ctx, cc.cl, uploadGrant{UploadID: grant.DeployID, URL: grant.URL, Method: grant.Method, Headers: grant.Headers}, bytes.NewReader(payload), int64(len(payload))); err != nil {
				return err
			}
			var d siteDeploy
			deployPath := "/sites/" + api.PathID(id) + "/deploys/" + api.PathID(grant.DeployID)
			if err := cc.cl.Do(ctx, http.MethodPost, deployPath+"/commit", map[string]any{}, &d); err != nil {
				return err
			}
			if noWait {
				return a.printDeploys([]siteDeploy{d})
			}
			d, err = waitSiteDeploy(ctx, cc.cl, deployPath, d, wait)
			if err != nil {
				return err
			}
			if d.Status != "live" {
				_ = a.printDeploys([]siteDeploy{d})
				return fmt.Errorf("deploy %s %s: %s", d.ID, d.Status, output.Str(d.Error))
			}
			var s site
			if err := cc.cl.Do(ctx, http.MethodGet, "/sites/"+api.PathID(id), nil, &s); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"deploy": d, "site": s})
			}
			fmt.Fprintf(a.Out, "live: %s (%d files, %d bytes)\n", s.PublicURL, d.Files, d.Bytes)
			return nil
		},
	}
	f := c.Flags()
	f.DurationVar(&wait, "wait", 6*time.Minute, "how long to poll for the deploy to finish")
	f.BoolVar(&noWait, "no-wait", false, "return right after commit; poll with `yyt site deploys`")
	return c
}

// waitSiteDeploy polls the deploy with backoff (1 s → 5 s) until it leaves
// queued/extracting or `wait` runs out. Ten pollers at 1 s would eat the
// console's reserved concurrency during an event, hence the backoff.
func waitSiteDeploy(ctx context.Context, cl *api.Client, path string, d siteDeploy, wait time.Duration) (siteDeploy, error) {
	deadline := time.Now().Add(wait)
	delay := time.Second
	misses := 0
	for d.Status == "queued" || d.Status == "extracting" {
		if time.Now().After(deadline) {
			return d, fmt.Errorf("deploy %s still %s after %s; check `yyt site deploys`", d.ID, d.Status, wait)
		}
		select {
		case <-ctx.Done():
			return d, ctx.Err()
		case <-time.After(delay):
		}
		if delay < 5*time.Second {
			delay += time.Second
		}
		var next siteDeploy
		if err := cl.Do(ctx, http.MethodGet, path, nil, &next); err != nil {
			// The deploy keeps running server-side; one flaky poll must not
			// turn into "failed" on the terminal. Give up after a few in a row.
			misses++
			if misses >= 3 {
				return d, fmt.Errorf("polling deploy %s failed (%w); it may still finish — check `yyt site deploys`", d.ID, err)
			}
			continue
		}
		misses = 0
		d = next
	}
	return d, nil
}

// siteZipOf returns the bytes to upload: a `.zip` file as-is, a directory
// zipped in memory with slash paths relative to it. Dot-files, dot-directories
// and symlinks are skipped, like `asset push`.
func siteZipOf(path string) ([]byte, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		if strings.ToLower(filepath.Ext(path)) != ".zip" {
			return nil, fmt.Errorf("%s is neither a directory nor a .zip file", path)
		}
		return os.ReadFile(path)
	}
	rels, err := collectAssetFiles(path)
	if err != nil {
		return nil, err
	}
	if len(rels) == 0 {
		return nil, fmt.Errorf("no files under %s", path)
	}
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, rel := range rels {
		f, err := os.Open(filepath.Join(path, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		entry, err := w.CreateHeader(&zip.FileHeader{Name: rel, Method: zip.Deflate})
		if err != nil {
			f.Close()
			return nil, err
		}
		_, err = io.Copy(entry, f)
		f.Close()
		if err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
