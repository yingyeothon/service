package cmd

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
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
	// Site names (docs/decisions.md *Site domains* §10): the claimed name, the
	// site's own origin and its host suffix (null on a stage without the
	// per-site host), and the target of a move in flight.
	Domain     *string `json:"domain"`
	HostURL    *string `json:"hostUrl"`
	HostSuffix *string `json:"hostSuffix"`
	MovingTo   *string `json:"movingTo"`
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
	// Kind is `upload` or `move` (a rename: no zip); empty from an older API.
	Kind     string  `json:"kind,omitempty"`
	MoveTo   *string `json:"moveTo"`
	MoveFrom *string `json:"moveFrom"`
}

// siteName is one row of the site-name ledger (admin, `GET /admin/site-names/{name}`).
type siteName struct {
	Name       string  `json:"name"`
	TeamID     *string `json:"teamId"`
	Kind       string  `json:"kind"`
	CreatedBy  *string `json:"createdBy"`
	CreatedAt  int64   `json:"createdAt"`
	ReleasedAt *int64  `json:"releasedAt"`
	Served     bool    `json:"served"`
	PurgedAt   *int64  `json:"purgedAt"`
}

// primaryURL is the link a site is reached by (docs/decisions.md *Site
// domains* §10): its own host only once it has a name, because an unnamed
// site may be a `/<slug>/` build that works on the path URL alone.
func (s site) primaryURL() string {
	if s.Domain != nil && s.HostURL != nil {
		return *s.HostURL
	}
	return s.PublicURL
}

// state is the site's one word, as the console's sites table shows it: a
// move in flight, then a deploy in flight, then whether anything is live.
func (s site) state() string {
	switch {
	case s.MovingTo != nil:
		return "moving"
	case s.Busy:
		return "deploying"
	case s.CurrentDeployID != nil:
		return "live"
	default:
		return "empty"
	}
}

// queuedMove says the view is a move in flight: busy, with its target named.
// PATCH answers 202 for one, but the client sees only the view.
func (s site) queuedMove() bool {
	return s.Busy && s.MovingTo != nil
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
			"(dev: https://dev-g.yyt.life/<slug>/) and, where the stage has it, on the site's\n" +
			"own host https://<slug>.g.yyt.life/ (dev: https://<slug>.dev-g.yyt.life/). The\n" +
			"slug is random until the site claims a name (`update --domain <name>`), which\n" +
			"replaces it on both hosts: the files move and the old URLs stop working. One\n" +
			"live tree per site, no history: a deploy replaces the previous files.\n\n" +
			siteSharedOriginWarning + "\n\n" +
			"Build hints: a relative base (vite `base: \"./\"`) works on both hosts; `/`\n" +
			"(absolute `/assets/...` references, Flutter `--base-href /`) only on the site's\n" +
			"own host; `/<slug>/` (vite `base: \"/<slug>/\"`, Flutter `--base-href /<slug>/`)\n" +
			"only on the path URL, and a claim changes the slug, so rebuild such a build\n" +
			"after it. Runtime config is a file in the build (e.g. config.json), never a token.\n\n" +
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
		newSiteNames(a),
	)
	return group(c)
}

type siteResolver = idResolver

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
		{"url", s.primaryURL()},
		{"domain", output.Str(s.Domain)},
		{"hostUrl", output.Str(s.HostURL)},
		{"publicUrl", s.PublicURL},
		{"basePath", s.BasePath},
		{"movingTo", output.Str(s.MovingTo)},
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
		kind := d.Kind
		if kind == "" {
			kind = "upload"
		}
		out = append(out, []string{d.ID, kind, output.Str(d.MoveTo), d.Status, fmt.Sprint(d.Files), fmt.Sprint(d.Bytes), output.Str(d.Error), output.Str(d.CreatedBy), output.Time(d.CreatedAt)})
	}
	return a.printer().Table([]string{"DEPLOY", "KIND", "MOVE_TO", "STATUS", "FILES", "BYTES", "ERROR", "BY", "CREATED"}, out)
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
				rows = append(rows, []string{s.ID, s.Name, crumb(s.TeamName, s.ProjectName), s.primaryURL(), s.state(), output.Str(s.CurrentDeployID), output.Time(s.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "TEAM/PROJECT", "URL", "STATE", "LIVE", "UPDATED"}, rows)
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
	return newResourceGet(siteID, "get <site>", "Show one site with its URL, base path and recent deploys", "/sites", a.printSite)
}

// newSiteUpdate is its own command rather than newResourceUpdate: a domain
// claim moves the files (202) and is waited for like a deploy.
func newSiteUpdate(a *App, siteID siteResolver) *cobra.Command {
	var name, description, domain string
	var clearDomain, noWait bool
	var wait time.Duration
	c := &cobra.Command{
		Use:   "update <site>",
		Short: "Rename a site, change its description (empty clears it), or claim or clear its domain name",
		Long: "Rename a site, change its description (an empty --description clears it),\n" +
			"claim a name for it (--domain) or go back to a random slug (--clear-domain).\n" +
			"Only the flags given are sent.\n\n" +
			"A name is 3-32 of a-z, 0-9 and - and globally unique; it replaces the slug\n" +
			"on both hosts. A site with files is moved by the console like a deploy (it\n" +
			"counts against the hourly deploy caps, and a team gets one name request per\n" +
			"second): this command waits until the move settles unless --no-wait. The\n" +
			"old URLs stop working when it completes, a `/<slug>/` build must be\n" +
			"rebuilt, and a name that has served files stays with this team.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			nullableDesc(cmd, "description", description, body, "description")
			if cmd.Flags().Changed("domain") {
				if strings.TrimSpace(domain) == "" {
					return fmt.Errorf("--domain needs a name; --clear-domain goes back to a random slug")
				}
				body["domain"] = domain
			}
			if clearDomain {
				body["domain"] = nil // untyped nil: JSON null
			}
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass --name, --description, --domain or --clear-domain")
			}
			cc, id, err := siteID(cmd, args[0], true)
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			path := "/sites/" + api.PathID(id)
			var s site
			if err := cc.cl.Do(ctx, http.MethodPatch, path, body, &s); err != nil {
				return siteDomainHint(err)
			}
			// Only a domain request queues a move; a rename of a site that is
			// moving for another reason does not wait for that move.
			if _, sent := body["domain"]; !sent {
				return a.printSite(s)
			}
			// Busy without a target is not what a queued move answers: re-read
			// once rather than guess (a view that has not caught up, or a
			// deploy of the site's own).
			if s.Busy && s.MovingTo == nil {
				var again site
				if err := cc.cl.Do(ctx, http.MethodGet, path, nil, &again); err == nil {
					s = again
				}
			}
			if !s.queuedMove() {
				return a.printSite(s)
			}
			target := *s.MovingTo
			fmt.Fprintf(a.Err, "move to %s queued\n", output.Clean(target))
			if noWait {
				return a.printSite(s)
			}
			s, err = waitSiteMove(ctx, cc.cl, path, s, wait)
			if err != nil {
				return err
			}
			if s.Slug != target {
				// Deploys are newest first: the first move to the target is this one.
				for _, d := range s.Deploys {
					if d.Kind == "move" && d.MoveTo != nil && *d.MoveTo == target {
						_ = a.printDeploys([]siteDeploy{d})
						return fmt.Errorf("move %s to %s %s: %s", d.ID, output.Clean(target), d.Status, output.Str(d.Error))
					}
				}
				return fmt.Errorf("the move to %s did not land; check `yyt site deploys`", output.Clean(target))
			}
			return a.printSite(s)
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "new site name (unique within the team)")
	f.StringVar(&description, "description", "", "new description (empty clears it)")
	f.StringVar(&domain, "domain", "", "claim this name for the site's host and path (3-32 of a-z, 0-9, -)")
	f.BoolVar(&clearDomain, "clear-domain", false, "give the name up and move back to a random slug")
	f.DurationVar(&wait, "wait", 6*time.Minute, "how long to poll for a move to finish")
	f.BoolVar(&noWait, "no-wait", false, "return right after a move is queued; poll with `yyt site get`")
	c.MarkFlagsMutuallyExclusive("domain", "clear-domain")
	return c
}

// siteDomainHint adds a line of advice to a refused name request. The
// *api.Error stays reachable through errors.As, so the exit code is unchanged.
func siteDomainHint(err error) error {
	var ae *api.Error
	if !errors.As(err, &ae) {
		return err
	}
	var d struct {
		Reason string `json:"reason"`
		Names  []struct {
			Name string `json:"name"`
		} `json:"names"`
	}
	_ = json.Unmarshal(ae.Details, &d)
	var hint string
	switch {
	case ae.Status == http.StatusConflict && d.Reason == "domain_taken":
		hint = "a name that has served files stays with the team that used it; pick another"
	case ae.Status == http.StatusConflict && d.Reason == "domain_cap":
		names := make([]string, 0, len(d.Names))
		for _, n := range d.Names {
			names = append(names, n.Name)
		}
		hint = "the team is at its limit of names in use or released in the last 30 days (" + strings.Join(names, ", ") + "); reclaiming one of them does not add to the count"
	case ae.Status == http.StatusConflict && d.Reason == "domain_cleaning":
		hint = "the name's old files are still being deleted; retry in a minute"
	case ae.Status == http.StatusTooManyRequests:
		hint = "one name request per team per second, and a rename counts against the hourly deploy caps"
	default:
		return err
	}
	return fmt.Errorf("%w\nhint: %s", err, output.Clean(hint))
}

// newSiteNames is the platform admin's view of the site-name ledger
// (docs/decisions.md *Site domains* §5): who keeps a name, and releasing it.
func newSiteNames(a *App) *cobra.Command {
	c := group(&cobra.Command{
		Use:   "name",
		Short: "Site names across the platform (platform admin): who keeps one, and releasing it",
		Long: "A name (or a random slug) that has served files stays with its team for good;\n" +
			"a platform admin's release, with a reason for the audit log, is the one way it\n" +
			"becomes claimable again. The release deletes what is left under the name and\n" +
			"is refused while a site uses it.",
	})
	show := &cobra.Command{
		Use:     "show <name>",
		Aliases: []string{"get"},
		Short:   "Show the ledger row behind a site name",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var n siteName
			if err := cl.Do(cmd.Context(), http.MethodGet, "/admin/site-names/"+api.PathID(strings.ToLower(args[0])), nil, &n); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(n)
			}
			return a.printer().KV([][2]string{
				{"name", n.Name},
				{"team", output.Str(n.TeamID)},
				{"kind", n.Kind},
				{"createdBy", output.Str(n.CreatedBy)},
				{"created", output.Time(n.CreatedAt)},
				{"inUse", fmt.Sprint(n.ReleasedAt == nil)},
				{"released", output.TimePtr(n.ReleasedAt)},
				{"served", fmt.Sprint(n.Served)},
				{"purged", output.TimePtr(n.PurgedAt)},
			})
		},
	}
	var reason string
	release := &cobra.Command{
		Use:   "release <name> --reason <text>",
		Short: "Free a kept site name for every team (deletes its files; refused while a site uses it)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			r := strings.TrimSpace(reason)
			if r == "" || len([]rune(r)) > 500 {
				return fmt.Errorf("--reason is required (1-500 characters)")
			}
			cl, err := a.client()
			if err != nil {
				return err
			}
			n := strings.ToLower(args[0])
			if err := cl.Do(cmd.Context(), http.MethodPost, "/admin/site-names/"+api.PathID(n)+"/release", map[string]any{"reason": r}, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "released %s\n", output.Clean(n))
			return nil
		},
	}
	release.Flags().StringVar(&reason, "reason", "", "why, for the audit log (required, 1-500 characters)")
	_ = release.MarkFlagRequired("reason")
	c.AddCommand(show, release)
	return c
}

func newSiteDelete(a *App, siteID siteResolver) *cobra.Command {
	return newResourceDelete(a, siteID, "delete <site>", "Delete a site and every file it serves (refused while a deploy is in flight)", "/sites")
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
	var exclude []string
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
			payload, err := siteZipOf(args[1], exclude)
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
			fmt.Fprintf(a.Out, "live: %s (%d files, %d bytes)\n", s.primaryURL(), d.Files, d.Bytes)
			return nil
		},
	}
	f := c.Flags()
	f.DurationVar(&wait, "wait", 6*time.Minute, "how long to poll for the deploy to finish")
	f.BoolVar(&noWait, "no-wait", false, "return right after commit; poll with `yyt site deploys`")
	f.StringArrayVar(&exclude, "exclude", nil, "glob (path.Match on the slash path) to leave out of a directory deploy, e.g. '*.map' or 'assets/*.map'; repeatable")
	return c
}

// waitSiteDeploy polls the deploy until it leaves queued/extracting or
// `wait` runs out.
func waitSiteDeploy(ctx context.Context, cl *api.Client, path string, d siteDeploy, wait time.Duration) (siteDeploy, error) {
	return pollSite(ctx, cl, path, d, wait,
		func(d siteDeploy) bool { return d.Status == "queued" || d.Status == "extracting" },
		func(d siteDeploy) error {
			return fmt.Errorf("deploy %s still %s after %s; check `yyt site deploys`", d.ID, d.Status, wait)
		},
		func(d siteDeploy, err error) error {
			return fmt.Errorf("polling deploy %s failed (%w); it may still finish — check `yyt site deploys`", d.ID, err)
		})
}

// waitSiteMove polls the site until it is no longer busy (the move settled,
// either way) or `wait` runs out.
func waitSiteMove(ctx context.Context, cl *api.Client, path string, s site, wait time.Duration) (site, error) {
	target := output.Clean(output.Str(s.MovingTo))
	return pollSite(ctx, cl, path, s, wait,
		func(s site) bool { return s.Busy },
		func(site) error {
			return fmt.Errorf("the move to %s is still in flight after %s; check `yyt site get`", target, wait)
		},
		func(_ site, err error) error {
			return fmt.Errorf("polling the site failed (%w); the move to %s may still finish — check `yyt site get`", err, target)
		})
}

// pollSite re-reads `path` with backoff (1 s → 5 s) while `pending` holds,
// until `wait` runs out (`stuck`). Ten pollers at 1 s would eat the console's
// reserved concurrency during an event, hence the backoff. The work keeps
// running server-side, so one flaky poll must not turn into "failed" on the
// terminal: it gives up (`lost`) after three misses in a row.
func pollSite[T any](ctx context.Context, cl *api.Client, path string, v T, wait time.Duration, pending func(T) bool, stuck func(T) error, lost func(T, error) error) (T, error) {
	deadline := time.Now().Add(wait)
	delay := time.Second
	misses := 0
	for pending(v) {
		if time.Now().After(deadline) {
			return v, stuck(v)
		}
		select {
		case <-ctx.Done():
			return v, ctx.Err()
		case <-time.After(delay):
		}
		if delay < 5*time.Second {
			delay += time.Second
		}
		var next T
		if err := cl.Do(ctx, http.MethodGet, path, nil, &next); err != nil {
			misses++
			if misses >= 3 {
				return v, lost(v, err)
			}
			continue
		}
		misses = 0
		v = next
	}
	return v, nil
}

// siteZipOf returns the bytes to upload: a `.zip` file as-is, a directory
// zipped in memory with slash paths relative to it. Dot-files, dot-directories
// and symlinks are skipped, like `asset push`.
// `exclude` globs are matched against the whole slash path and its base name.
func siteZipOf(path string, exclude []string) ([]byte, error) {
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
	rels = slices.DeleteFunc(rels, func(rel string) bool {
		for _, g := range exclude {
			if ok, _ := filepath.Match(g, rel); ok {
				return true
			}
			if ok, _ := filepath.Match(g, rel[strings.LastIndex(rel, "/")+1:]); ok {
				return true
			}
		}
		return false
	})
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
