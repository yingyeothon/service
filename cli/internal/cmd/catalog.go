package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/flutter"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/catalog.ts. Apps belong to a project;
// who may write is the team membership, so there is no owner/group/permission.
type catalogApp struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Path        string  `json:"path"`
	Description *string `json:"description"`
	TeamID      *string `json:"teamId"`
	TeamName    *string `json:"teamName"`
	ProjectID   *string `json:"projectId"`
	ProjectName *string `json:"projectName"`
	CreatedBy   *string `json:"createdBy"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
}

type catalogSettings struct {
	SlackHookURL       *string `json:"slackHookUrl"`
	SlackChannel       *string `json:"slackChannel"`
	MessageTemplate    *string `json:"messageTemplate"`
	KeepRecentVersions int     `json:"keepRecentVersions"`
}

type catalogArtifact struct {
	ID        string            `json:"id"`
	AppID     string            `json:"appId"`
	Platform  string            `json:"platform"`
	URL       string            `json:"url"`
	ObjectKey *string           `json:"objectKey"`
	Size      *int64            `json:"size"`
	Hash      *string           `json:"hash"`
	Tags      map[string]string `json:"tags"`
	CreatedAt int64             `json:"createdAt"`
	IOS       *struct {
		ManifestURL string `json:"manifestUrl"`
		InstallURL  string `json:"installUrl"`
	} `json:"ios,omitempty"`
	// Version is set only by the commit response: the project version the
	// artifact's version tag names, created and linked by the console.
	Version *artifactVersion `json:"version,omitempty"`
}

type artifactVersion struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	LinkID  string `json:"linkId"`
	Created bool   `json:"created"`
}

// reportVersionLink says on stderr which project version the console linked
// the artifact to (stdout keeps the artifact itself).
func (a *App) reportVersionLink(art *catalogArtifact) {
	if art == nil || art.Version == nil {
		return
	}
	if art.Version.Created {
		fmt.Fprintf(a.Err, "created version %s (%s)\n", art.Version.Name, art.Version.ID)
	}
	fmt.Fprintf(a.Err, "linked to version %s (%s)\n", art.Version.Name, art.Version.ID)
}

type uploadGrant struct {
	UploadID  string            `json:"uploadId"`
	Key       string            `json:"key"`
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt int64             `json:"expiresAt"`
}

func parseTags(pairs []string) (map[string]string, error) {
	tags := map[string]string{}
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		if !ok || k == "" || v == "" {
			return nil, fmt.Errorf("invalid --tag %q (want key=value)", p)
		}
		tags[k] = v
	}
	return tags, nil
}

// putPresigned uploads `body` to the presigned URL the console handed out. The
// signed headers must be sent verbatim: `content-type` is part of the
// signature, so substituting one turns the PUT into a 403.
func putPresigned(ctx context.Context, cl *api.Client, grant uploadGrant, body io.Reader, size int64) error {
	req, err := http.NewRequestWithContext(ctx, grant.Method, grant.URL, body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	for k, v := range grant.Headers {
		req.Header.Set(k, v)
	}
	httpClient := cl.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	// The presigned PUT of a large binary can exceed the client's API timeout.
	res, err := (&http.Client{Transport: httpClient.Transport}).Do(req)
	if err != nil {
		return fmt.Errorf("upload PUT failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("upload PUT failed: HTTP %d", res.StatusCode)
	}
	return nil
}

// uploadFile runs presign → PUT file → commit for one local file. `presign`
// is the route that grants the URL, `body` its request given the file size,
// and `commitPrefix` the route the upload id is committed under.
func uploadFile[T any](ctx context.Context, cl *api.Client, localPath, presign string, body func(size int64) map[string]any, commitPrefix string) (*T, error) {
	f, err := os.Open(localPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var grant uploadGrant
	if err := cl.Do(ctx, http.MethodPost, presign, body(st.Size()), &grant); err != nil {
		return nil, err
	}
	if err := putPresigned(ctx, cl, grant, f, st.Size()); err != nil {
		return nil, err
	}
	var out T
	if err := cl.Do(ctx, http.MethodPost, commitPrefix+api.PathID(grant.UploadID)+"/commit", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// uploadArtifact runs presign → PUT file → commit. appID is the app's id.
func uploadArtifact(ctx context.Context, cl *api.Client, appID, filePath, platform string, tags map[string]string) (*catalogArtifact, error) {
	return uploadFile[catalogArtifact](ctx, cl, filePath, "/catalog/apps/"+api.PathID(appID)+"/artifacts", func(size int64) map[string]any {
		return map[string]any{
			"platform": platform,
			"filename": filepath.Base(filePath),
			"size":     size,
			"tags":     tags,
		}
	}, "/catalog/uploads/")
}

func newCatalog(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:     "catalog",
		Aliases: []string{"cata"}, // legacy cata CLI muscle memory
		Short:   "Binary catalog: apps and their build artifacts (an app belongs to a project)",
		Long: "Binary catalog: apps and their build artifacts. An app belongs to a project.\n\n" +
			"<app> is an id (ca_…) or a name unique within the team; a name is looked up across\n" +
			"the team context (--team, YYT_TEAM, " + ContextFile + ", `yyt team use`), or within the\n" +
			"project context when one is set. Uploads and `deploy` need an explicit team.",
	}
	p := func() output.Printer { return a.printer() }
	// appID resolves <app> (id or name); write=true refuses auto-selection.
	appID := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.app(cmd.Context(), arg, write)
		return cc, id, err
	}
	// appDo resolves <app> then issues one request on its id path.
	appDo := func(cmd *cobra.Command, write bool, method, arg, suffix string, in, out any) error {
		cc, id, err := appID(cmd, arg, write)
		if err != nil {
			return err
		}
		return cc.cl.Do(cmd.Context(), method, "/catalog/apps/"+api.PathID(id)+suffix, in, out)
	}

	printApp := func(v catalogApp) error {
		if a.jsonOut {
			return p().JSONValue(v)
		}
		return p().KV([][2]string{
			{"id", v.ID}, {"name", v.Name}, {"path", v.Path},
			{"project", crumb(v.TeamName, v.ProjectName)},
			{"description", output.Str(v.Description)},
			{"createdBy", output.Str(v.CreatedBy)},
			{"created", output.Time(v.CreatedAt)}, {"updated", output.Time(v.UpdatedAt)},
		})
	}
	printArtifact := func(v catalogArtifact) error {
		if a.jsonOut {
			return p().JSONValue(v)
		}
		tags := make([]string, 0, len(v.Tags))
		for k, tv := range v.Tags {
			tags = append(tags, k+"="+tv)
		}
		sort.Strings(tags)
		pairs := [][2]string{
			{"id", v.ID}, {"platform", v.Platform}, {"url", v.URL},
			{"size", fmt.Sprint(valOr(v.Size, 0))}, {"tags", strings.Join(tags, " ")},
			{"created", output.Time(v.CreatedAt)},
		}
		if v.IOS != nil {
			pairs = append(pairs, [2]string{"install", v.IOS.InstallURL})
		}
		return p().KV(pairs)
	}

	// ---- app ----------------------------------------------------------------
	app := &cobra.Command{Use: "app", Short: "Catalog apps"}
	app.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the apps of the project or team in context, or of every team you sit in",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			path := "/catalog/apps"
			if cc.spec.explicitProject() {
				r, err := cc.project(cmd.Context(), false)
				if err != nil {
					return err
				}
				path = "/projects/" + api.PathID(r.ProjectID) + "/catalog/apps"
			} else if cc.spec.explicitTeam() {
				r, err := cc.team(cmd.Context(), false)
				if err != nil {
					return err
				}
				path = "/teams/" + api.PathID(r.TeamID) + "/catalog/apps"
			}
			var res struct {
				Apps []catalogApp `json:"apps"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Apps))
			for _, v := range res.Apps {
				rows = append(rows, []string{v.ID, v.Name, v.Path, crumb(v.TeamName, v.ProjectName), output.Time(v.UpdatedAt)})
			}
			return p().Table([]string{"ID", "NAME", "PATH", "TEAM/PROJECT", "UPDATED"}, rows)
		},
	})
	{
		var path, description string
		create := &cobra.Command{
			Use:   "create <name> --path <applicationId>",
			Short: "Create an app in the project context (explicit)",
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
				body := map[string]any{"name": args[0], "path": path}
				if description != "" {
					body["description"] = description
				}
				var v catalogApp
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/catalog/apps", body, &v); err != nil {
					return err
				}
				return printApp(v)
			},
		}
		create.Flags().StringVar(&path, "path", "", "application id (e.g. life.yyt.my-game)")
		create.Flags().StringVar(&description, "description", "", "description")
		_ = create.MarkFlagRequired("path")
		app.AddCommand(create)
	}
	app.AddCommand(&cobra.Command{
		Use:   "get <app>",
		Short: "Show one app",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogApp
			if err := appDo(cmd, false, http.MethodGet, args[0], "", nil, &v); err != nil {
				return err
			}
			return printApp(v)
		},
	})
	{
		var name, path, description string
		update := &cobra.Command{
			Use:   "update <app> [--name n] [--path p] [--description d]",
			Short: "Update app fields; empty --description clears it",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]any{}
				if cmd.Flags().Changed("name") {
					body["name"] = name
				}
				if cmd.Flags().Changed("path") {
					body["path"] = path
				}
				nullableDesc(cmd, "description", description, body, "description")
				if len(body) == 0 {
					return errors.New("nothing to update: pass --name, --path and/or --description")
				}
				var v catalogApp
				if err := appDo(cmd, true, http.MethodPatch, args[0], "", body, &v); err != nil {
					return err
				}
				return printApp(v)
			},
		}
		update.Flags().StringVar(&name, "name", "", "new name (unique within the team)")
		update.Flags().StringVar(&path, "path", "", "application id")
		update.Flags().StringVar(&description, "description", "", "description (empty clears)")
		app.AddCommand(update)
	}
	app.AddCommand(&cobra.Command{
		Use:     "delete <app>",
		Aliases: []string{"rm"},
		Short:   "Delete an app (must have no artifacts)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := appDo(cmd, true, http.MethodDelete, args[0], "", nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(a.Out, "deleted")
			return nil
		},
	})
	{
		var slackHook, slackChannel, template string
		var keep int
		settings := &cobra.Command{
			Use:   "settings <app>",
			Short: "Show or update app settings",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]any{}
				if cmd.Flags().Changed("slack-hook") {
					body["slackHookUrl"] = nullable(slackHook)
				}
				if cmd.Flags().Changed("slack-channel") {
					body["slackChannel"] = nullable(slackChannel)
				}
				if cmd.Flags().Changed("template") {
					body["messageTemplate"] = nullable(template)
				}
				if cmd.Flags().Changed("keep") {
					body["keepRecentVersions"] = keep
				}
				var v catalogSettings
				var err error
				if len(body) > 0 {
					err = appDo(cmd, true, http.MethodPatch, args[0], "/settings", body, &v)
				} else {
					err = appDo(cmd, false, http.MethodGet, args[0], "/settings", nil, &v)
				}
				if err != nil {
					return err
				}
				if a.jsonOut {
					return p().JSONValue(v)
				}
				return p().KV([][2]string{
					{"slackHookUrl", output.Str(v.SlackHookURL)},
					{"slackChannel", output.Str(v.SlackChannel)},
					{"messageTemplate", output.Str(v.MessageTemplate)},
					{"keepRecentVersions", fmt.Sprint(v.KeepRecentVersions)},
				})
			},
		}
		settings.Flags().StringVar(&slackHook, "slack-hook", "", "Slack webhook URL (https://hooks.slack.com/…, empty clears)")
		settings.Flags().StringVar(&slackChannel, "slack-channel", "", "Slack channel (empty clears)")
		settings.Flags().StringVar(&template, "template", "", "message template (empty clears)")
		settings.Flags().IntVar(&keep, "keep", 0, "keep this many recent versions")
		app.AddCommand(settings)
	}
	{
		var dryRun bool
		cleanup := &cobra.Command{
			Use:   "cleanup <app>",
			Short: "Apply the app's retention policy",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				suffix := "/artifacts/cleanup"
				if dryRun {
					suffix += "?dryRun=true"
				}
				var res struct {
					DryRun   bool `json:"dryRun"`
					Executed bool `json:"executed"`
					Deleted  int  `json:"deleted"`
					Preview  struct {
						KeepRecentVersions int `json:"keepRecentVersions"`
						TotalArtifacts     int `json:"totalArtifacts"`
						Deletions          []struct {
							ArtifactID string `json:"artifactId"`
							Platform   string `json:"platform"`
							Version    string `json:"version"`
							Reason     string `json:"reason"`
						} `json:"deletions"`
					} `json:"preview"`
				}
				if err := appDo(cmd, !dryRun, http.MethodPost, args[0], suffix, map[string]any{}, &res); err != nil {
					return err
				}
				if a.jsonOut {
					return p().JSONValue(res)
				}
				rows := make([][]string, 0, len(res.Preview.Deletions))
				for _, d := range res.Preview.Deletions {
					rows = append(rows, []string{d.ArtifactID, d.Version, d.Platform, d.Reason})
				}
				if err := p().Table([]string{"ARTIFACT", "VERSION", "PLATFORM", "REASON"}, rows); err != nil {
					return err
				}
				if res.Executed {
					fmt.Fprintf(a.Out, "deleted %d artifact(s)\n", res.Deleted)
				} else {
					fmt.Fprintf(a.Out, "dry run: would delete %d of %d artifact(s)\n",
						len(res.Preview.Deletions), res.Preview.TotalArtifacts)
				}
				return nil
			},
		}
		cleanup.Flags().BoolVar(&dryRun, "dry-run", false, "preview without deleting")
		app.AddCommand(cleanup)
	}

	// ---- artifact -----------------------------------------------------------
	artifact := &cobra.Command{Use: "artifact", Short: "Build artifacts"}
	{
		var platform string
		var filters []string
		list := &cobra.Command{
			Use:     "list <app>",
			Aliases: []string{"ls"},
			Short:   "List an app's artifacts (newest first)",
			Args:    cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				want, err := parseTags(filters)
				if err != nil {
					return fmt.Errorf("invalid --filter: %w", err)
				}
				cc, id, err := appID(cmd, args[0], false)
				if err != nil {
					return err
				}
				arts, err := listArtifacts(cmd.Context(), cc.cl, id, platform, want)
				if err != nil {
					return err
				}
				if a.jsonOut {
					return p().JSONValue(map[string]any{"artifacts": arts})
				}
				rows := make([][]string, 0, len(arts))
				for _, v := range arts {
					rows = append(rows, []string{v.ID, v.Tags["version"], v.Platform, fmt.Sprint(valOr(v.Size, 0)), output.Time(v.CreatedAt)})
				}
				return p().Table([]string{"ID", "VERSION", "PLATFORM", "SIZE", "CREATED"}, rows)
			},
		}
		list.Flags().StringVar(&platform, "platform", "", "filter by platform")
		list.Flags().StringArrayVar(&filters, "filter", nil, "tag filter key=value (repeatable, applied client-side)")
		artifact.AddCommand(list)
	}
	artifact.AddCommand(&cobra.Command{
		Use:   "get <app> <artifact-id>",
		Short: "Show one artifact (with its CDN URL)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogArtifact
			if err := appDo(cmd, false, http.MethodGet, args[0], "/artifacts/"+api.PathID(args[1]), nil, &v); err != nil {
				return err
			}
			return printArtifact(v)
		},
	})
	{
		var platform, version string
		var tags []string
		up := &cobra.Command{
			Use:   "upload <app> <file>",
			Short: "Upload a file as a new artifact (presigned PUT + commit)",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				t, err := parseTags(tags)
				if err != nil {
					return err
				}
				t["version"] = version
				cc, id, err := appID(cmd, args[0], true)
				if err != nil {
					return err
				}
				v, err := uploadArtifact(cmd.Context(), cc.cl, id, args[1], platform, t)
				if err != nil {
					return err
				}
				a.reportVersionLink(v)
				return printArtifact(*v)
			},
		}
		up.Flags().StringVar(&platform, "platform", "", "android|ios|bin|server|win32|osx|linux")
		up.Flags().StringVar(&version, "version", "", "artifact version tag")
		up.Flags().StringArrayVar(&tags, "tag", nil, "extra tag key=value (repeatable)")
		_ = up.MarkFlagRequired("platform")
		_ = up.MarkFlagRequired("version")
		up.AddCommand(newUploadAndroid(a, appID), newUploadIOS(a, appID))
		artifact.AddCommand(up)
	}
	artifact.AddCommand(&cobra.Command{
		Use:     "delete <app> <artifact-id>",
		Aliases: []string{"rm"},
		Short:   "Delete an artifact (removes the CDN object too)",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := appDo(cmd, true, http.MethodDelete, args[0], "/artifacts/"+api.PathID(args[1]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(a.Out, "deleted")
			return nil
		},
	})

	// ---- installer ----------------------------------------------------------
	c.AddCommand(&cobra.Command{
		Use:   "installer",
		Short: "Show the latest installer downloads",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var res struct {
				Downloads []struct {
					URL       string  `json:"url"`
					Filename  string  `json:"filename"`
					Platform  string  `json:"platform"`
					Version   *string `json:"version"`
					CreatedAt int64   `json:"createdAt"`
				} `json:"downloads"`
			}
			if err := cl.Do(cmd.Context(), http.MethodGet, "/catalog/installer/downloads", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Downloads))
			for _, d := range res.Downloads {
				rows = append(rows, []string{d.Filename, output.Str(d.Version), d.Platform, d.URL})
			}
			return p().Table([]string{"FILE", "VERSION", "PLATFORM", "URL"}, rows)
		},
	})

	c.AddCommand(group(app), group(artifact), newCatalogDeploy(a), newCatalogBump(a))
	return group(c)
}

type appResolver = idResolver

func valOr[T any](p *T, def T) T {
	if p == nil {
		return def
	}
	return *p
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ---- deploy ---------------------------------------------------------------

// commandRunner lets tests fake `flutter build`.
type commandRunner func(ctx context.Context, dir, name string, args ...string) error

func execRunner(ctx context.Context, dir, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// profileOutput maps a build profile to the flutter build args and output path.
var profileOutput = map[string]struct {
	args []string
	out  string
	ext  string
}{
	"debug":     {[]string{"build", "apk", "--debug"}, filepath.Join("build", "app", "outputs", "flutter-apk", "app-debug.apk"), ".apk"},
	"release":   {[]string{"build", "apk", "--release"}, filepath.Join("build", "app", "outputs", "flutter-apk", "app-release.apk"), ".apk"},
	"appbundle": {[]string{"build", "appbundle", "--release"}, filepath.Join("build", "app", "outputs", "bundle", "release", "app-release.aab"), ".aab"},
}

// Runner is swapped by tests; the default shells out to `flutter`.
var deployRunner commandRunner = execRunner

// verifyDelay is the pause between upload-verification retries (tests shrink it).
var verifyDelay = 2 * time.Second

// normalizeProfile maps legacy aliases (cata used "aab") to the server enum.
func normalizeProfile(pr string) string {
	if pr == "aab" {
		return "appbundle"
	}
	return pr
}

// buildOutput is one file produced by a flutter build.
type buildOutput struct {
	path string
	abi  string // non-empty for --split-per-abi APKs
}

// cleanBuildOutputs removes any previous build outputs that the post-build
// glob could match, so a stale split APK from an earlier build (e.g. a wider
// --target-platform) is never re-uploaded under the new version.
func cleanBuildOutputs(projectPath, pr string) error {
	spec := profileOutput[pr]
	paths := []string{filepath.Join(projectPath, spec.out)}
	if spec.ext == ".apk" {
		dir := filepath.Join(projectPath, "build", "app", "outputs", "flutter-apk")
		matches, err := filepath.Glob(filepath.Join(dir, "app-*-"+pr+".apk"))
		if err != nil {
			return err
		}
		paths = append(paths, matches...)
	}
	for _, p := range paths {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove stale build output %s: %w", p, err)
		}
	}
	return nil
}

// buildOutputs locates the files a profile build produced. With splitPerAbi,
// APK profiles emit app-<abi>-<profile>.apk files which we glob.
func buildOutputs(projectPath, pr string, splitPerAbi bool) ([]buildOutput, error) {
	spec := profileOutput[pr]
	if !splitPerAbi || spec.ext != ".apk" {
		return []buildOutput{{path: filepath.Join(projectPath, spec.out)}}, nil
	}
	dir := filepath.Join(projectPath, "build", "app", "outputs", "flutter-apk")
	matches, err := filepath.Glob(filepath.Join(dir, "app-*-"+pr+".apk"))
	if err != nil {
		return nil, err
	}
	outs := make([]buildOutput, 0, len(matches))
	for _, m := range matches {
		base := filepath.Base(m)
		abi := strings.TrimSuffix(strings.TrimPrefix(base, "app-"), "-"+pr+".apk")
		outs = append(outs, buildOutput{path: m, abi: abi})
	}
	if len(outs) == 0 {
		return nil, fmt.Errorf("no split APKs found in %s (expected app-<abi>-%s.apk)", dir, pr)
	}
	sort.Slice(outs, func(i, j int) bool { return outs[i].path < outs[j].path })
	return outs, nil
}

// listArtifacts fetches an app's artifacts and applies a client-side tag filter
// (the server only filters by platform).
func listArtifacts(ctx context.Context, cl *api.Client, appID, platform string, want map[string]string) ([]catalogArtifact, error) {
	path := "/catalog/apps/" + api.PathID(appID) + "/artifacts"
	if platform != "" {
		path += "?platform=" + url.QueryEscape(platform)
	}
	var res struct {
		Artifacts []catalogArtifact `json:"artifacts"`
	}
	if err := cl.Do(ctx, http.MethodGet, path, nil, &res); err != nil {
		return nil, err
	}
	if len(want) == 0 {
		return res.Artifacts, nil
	}
	filtered := make([]catalogArtifact, 0, len(res.Artifacts))
	for _, v := range res.Artifacts {
		ok := true
		for k, val := range want {
			if v.Tags[k] != val {
				ok = false
				break
			}
		}
		if ok {
			filtered = append(filtered, v)
		}
	}
	return filtered, nil
}

// verifyUploaded re-reads the artifact list until every just-uploaded artifact
// id shows up (ported from the legacy cata verifyUploadedArtifact; 5 attempts).
// Matching by id — not by version tag — so artifacts from earlier deploys of
// the same version can never satisfy the check.
func verifyUploaded(ctx context.Context, cl *api.Client, appID string, ids []string) (int, error) {
	got := 0
	for attempt := 1; attempt <= 5; attempt++ {
		arts, err := listArtifacts(ctx, cl, appID, "", nil)
		if err != nil {
			return 0, fmt.Errorf("verify: %w", err)
		}
		present := make(map[string]bool, len(arts))
		for _, v := range arts {
			present[v.ID] = true
		}
		got = 0
		for _, id := range ids {
			if present[id] {
				got++
			}
		}
		if got >= len(ids) {
			return got, nil
		}
		if attempt < 5 {
			select {
			case <-ctx.Done():
				return got, ctx.Err()
			case <-time.After(verifyDelay):
			}
		}
	}
	return got, fmt.Errorf("verify: only %d of %d uploaded artifact(s) visible in the list", got, len(ids))
}

// addTagIf sets a tag when the value is non-empty.
func addTagIf(tags map[string]string, key, val string) {
	if val != "" {
		tags[key] = val
	}
}

func newCatalogDeploy(a *App) *cobra.Command {
	var (
		name           string
		projectPath    string
		profiles       []string
		description    string
		stage          string
		changelog      string
		bump           string
		doBump         bool
		splitPerAbi    bool
		targetPlatform string
		buildNo        string
		commit         string
		minSdk         string
		targetSdk      string
		abiTag         string
		extraTags      []string
		noVerify       bool
	)
	c := &cobra.Command{
		Use:   "deploy",
		Short: "Build a Flutter Android app and upload the artifacts",
		Long: `Reads pubspec.yaml / build.gradle from --project-path, finds the app by name in
the team context (explicit: --team, YYT_TEAM, ` + ContextFile + ` next to the project, or
` + "`yyt team use`" + `), runs "flutter build" for each --profile, uploads the outputs
with version/build_type/application_id tags, and verifies the upload by re-reading
the artifact list. A missing app is created in the project context if one is set
(--project/YYT_PROJECT/...), else in the project named after the --project-path
directory (created when missing).`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			if len(profiles) == 0 {
				profiles = []string{"release"}
			}
			if len(profiles) == 1 && profiles[0] == "all" {
				profiles = []string{"debug", "release", "appbundle"}
			}
			for i, pr := range profiles {
				profiles[i] = normalizeProfile(pr)
				if _, ok := profileOutput[profiles[i]]; !ok {
					return fmt.Errorf("invalid --build-profile %q (debug|release|appbundle|aab|all)", pr)
				}
			}
			userTags, err := parseTags(extraTags)
			if err != nil {
				return err
			}
			applicationID, err := flutter.ApplicationID(projectPath)
			if err != nil {
				return err
			}
			if name == "" {
				name = applicationID[strings.LastIndex(applicationID, ".")+1:]
			}
			version, err := flutter.Version(projectPath)
			if err != nil {
				return err
			}

			// Resolve the context before touching pubspec so a missing context
			// fails without a side effect, and say where the app will land
			// before anything is created.
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			team, err := cc.scope(ctx, true)
			if err != nil {
				return err
			}
			cl := cc.cl
			fmt.Fprintf(a.Err, "deploying %s to %s\n", name, team)

			if doBump {
				b, err := flutter.ParseBump(bump)
				if err != nil {
					return err
				}
				next, err := flutter.BumpVersion(version, b)
				if err != nil {
					return err
				}
				if err := flutter.SetVersion(projectPath, next); err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "bumped version %s -> %s\n", version, next)
				version = next
			}

			// Ensure the app exists in the project; not found → create it there.
			var appRow catalogApp
			appID, err := cc.app(ctx, name, true)
			var apiErr *api.Error
			if errors.As(err, &apiErr) && apiErr.Status == 404 {
				// With a project context the lookup was narrowed; an app of that
				// name in another project of the team would make the create a 409,
				// so say where it lives instead.
				if team.ProjectID != "" {
					rows, err := cc.teamApps(ctx, team.TeamID)
					if err != nil {
						return err
					}
					for _, row := range rows {
						if strings.EqualFold(row.Name, name) && row.ProjectID != team.ProjectID {
							return fmt.Errorf("app %q already exists in team %s under project %s, not %s: drop --project or pass --project %s", name, team.TeamName, row.ProjectID, team.ProjectName, row.ProjectID)
						}
					}
				}
				abs, err := filepath.Abs(projectPath)
				if err != nil {
					return err
				}
				r, created, err := cc.projectIn(ctx, team, filepath.Base(abs))
				if created {
					fmt.Fprintf(a.Err, "created project %s (%s)\n", r.ProjectName, r.ProjectID)
				}
				if err != nil {
					return err
				}
				body := map[string]any{"name": name, "path": applicationID}
				if description != "" {
					body["description"] = description
				}
				if err := cl.Do(ctx, http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/catalog/apps", body, &appRow); err != nil {
					return err
				}
				appID = appRow.ID
				fmt.Fprintf(a.Err, "created app %s (%s) in %s\n", name, appID, r)
			} else if err != nil {
				return err
			} else if err := cl.Do(ctx, http.MethodGet, "/catalog/apps/"+api.PathID(appID), nil, &appRow); err != nil {
				return err
			}

			label := flutter.Label(projectPath)
			uploaded := make([]catalogArtifact, 0, len(profiles))
			for _, pr := range profiles {
				spec := profileOutput[pr]
				buildArgs := append([]string{}, spec.args...)
				if splitPerAbi && spec.ext == ".apk" {
					buildArgs = append(buildArgs, "--split-per-abi")
				}
				if targetPlatform != "" {
					buildArgs = append(buildArgs, "--target-platform", targetPlatform)
				}
				if err := cleanBuildOutputs(projectPath, pr); err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "building %s (%s)…\n", name, pr)
				if err := deployRunner(ctx, projectPath, "flutter", buildArgs...); err != nil {
					return fmt.Errorf("flutter build %s: %w", pr, err)
				}
				outs, err := buildOutputs(projectPath, pr, splitPerAbi)
				if err != nil {
					return err
				}
				for _, out := range outs {
					// Rename so the CDN filename carries app+version+profile(+abi).
					suffix := ""
					if out.abi != "" {
						suffix = "-" + out.abi
					}
					dst := filepath.Join(filepath.Dir(out.path),
						fmt.Sprintf("%s-%s-%s%s%s", name, version, pr, suffix, spec.ext))
					if err := os.Rename(out.path, dst); err != nil {
						return err
					}
					tags := map[string]string{
						"version":        version,
						"build_type":     pr, // matches the server enum (debug|release|appbundle)
						"application_id": applicationID,
					}
					addTagIf(tags, "stage", stage)
					addTagIf(tags, "changelog", changelog)
					addTagIf(tags, "title", label)
					addTagIf(tags, "build", buildNo)
					addTagIf(tags, "commit", commit)
					addTagIf(tags, "min_sdk", minSdk)
					addTagIf(tags, "target_sdk", targetSdk)
					addTagIf(tags, "abi", abiTag)
					if out.abi != "" {
						tags["abi"] = out.abi
					}
					for k, v := range userTags {
						tags[k] = v
					}
					fmt.Fprintf(a.Err, "uploading %s…\n", filepath.Base(dst))
					art, err := uploadArtifact(ctx, cl, appID, dst, "android", tags)
					if err != nil {
						return err
					}
					a.reportVersionLink(art)
					uploaded = append(uploaded, *art)
				}
			}
			verified := 0
			if !noVerify {
				ids := make([]string, 0, len(uploaded))
				for _, art := range uploaded {
					ids = append(ids, art.ID)
				}
				verified, err = verifyUploaded(ctx, cl, appID, ids)
				if err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "verified: %d artifact(s) visible for version %s\n", verified, version)
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{
					"app": appRow, "version": version, "artifacts": uploaded, "verified": verified,
				})
			}
			for _, art := range uploaded {
				fields := []string{art.ID, art.Tags["build_type"]}
				if abi := art.Tags["abi"]; abi != "" {
					fields = append(fields, abi)
				}
				fields = append(fields, art.URL)
				fmt.Fprintln(a.Out, strings.Join(fields, " "))
			}
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "app name (default: last segment of the applicationId; pass one when that segment looks like an id, e.g. q_game)")
	f.StringVar(&projectPath, "project-path", ".", "Flutter project directory (also where the "+ContextFile+" search starts)")
	f.StringArrayVar(&profiles, "build-profile", nil, "debug|release|appbundle|aab|all (repeatable; default release)")
	f.StringVar(&description, "description", "", "description when creating the app")
	f.StringVar(&stage, "stage", "", "stage tag (e.g. alpha, beta, prod)")
	f.StringVar(&changelog, "note", "", "changelog tag")
	f.StringVar(&bump, "bump", "patch", "version bump when --do-bump: major|minor|patch")
	f.BoolVar(&doBump, "do-bump", false, "bump pubspec version before building")
	f.BoolVar(&splitPerAbi, "split-per-abi", false, "pass --split-per-abi to flutter build (APK profiles; uploads one artifact per ABI)")
	f.StringVar(&targetPlatform, "target-platform", "", "pass --target-platform to flutter build (e.g. android-arm64)")
	f.StringVar(&buildNo, "build", "", "build tag (build number)")
	f.StringVar(&commit, "commit", "", "commit tag (e.g. from 'git rev-parse --short HEAD')")
	f.StringVar(&minSdk, "min-sdk", "", "min_sdk tag")
	f.StringVar(&targetSdk, "target-sdk", "", "target_sdk tag")
	f.StringVar(&abiTag, "abi", "", "abi tag (overridden per file when --split-per-abi)")
	f.StringArrayVar(&extraTags, "tag", nil, "extra tag key=value (repeatable; server allowlist applies)")
	f.BoolVar(&noVerify, "no-verify", false, "skip the post-upload artifact list verification")
	return c
}

// newCatalogBump is the standalone pubspec bump (legacy `cata app bump`).
// It never touches git; commit/push stays with the calling script.
func newCatalogBump(a *App) *cobra.Command {
	var projectPath, bump string
	c := &cobra.Command{
		Use:   "bump",
		Short: "Bump the pubspec.yaml version (+build number); no git commit",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			b, err := flutter.ParseBump(bump)
			if err != nil {
				return err
			}
			cur, err := flutter.Version(projectPath)
			if err != nil {
				return err
			}
			next, err := flutter.BumpVersion(cur, b)
			if err != nil {
				return err
			}
			if err := flutter.SetVersion(projectPath, next); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"from": cur, "to": next})
			}
			fmt.Fprintf(a.Out, "bumped version %s -> %s\n", cur, next)
			return nil
		},
	}
	c.Flags().StringVar(&projectPath, "project-path", ".", "Flutter project directory")
	c.Flags().StringVar(&bump, "bump", "patch", "major|minor|patch")
	return c
}

// typedUpload builds an upload subcommand with platform-specific tag flags
// on top of the generic presign → PUT → commit flow.
func typedUpload(a *App, appID appResolver, platform string, tagFlags []struct{ flag, tag, usage string }, required []string) *cobra.Command {
	var version, stage, changelog string
	var extraTags []string
	values := make([]string, len(tagFlags))
	c := &cobra.Command{
		Use:   platform + " <app> <file>",
		Short: "Upload a " + platform + " artifact with typed tag flags",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			tags, err := parseTags(extraTags)
			if err != nil {
				return err
			}
			tags["version"] = version
			addTagIf(tags, "stage", stage)
			addTagIf(tags, "changelog", changelog)
			for i, tf := range tagFlags {
				addTagIf(tags, tf.tag, values[i])
			}
			cc, id, err := appID(cmd, args[0], true)
			if err != nil {
				return err
			}
			v, err := uploadArtifact(cmd.Context(), cc.cl, id, args[1], platform, tags)
			if err != nil {
				return err
			}
			a.reportVersionLink(v)
			if a.jsonOut {
				return a.printer().JSONValue(v)
			}
			fmt.Fprintf(a.Out, "%s %s\n", v.ID, v.URL)
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&version, "version", "", "artifact version tag")
	f.StringVar(&stage, "stage", "", "stage tag")
	f.StringVar(&changelog, "changelog", "", "changelog tag")
	f.StringArrayVar(&extraTags, "tag", nil, "extra tag key=value (repeatable)")
	for i, tf := range tagFlags {
		f.StringVar(&values[i], tf.flag, "", tf.usage)
	}
	_ = c.MarkFlagRequired("version")
	for _, r := range required {
		_ = c.MarkFlagRequired(r)
	}
	return c
}

func newUploadAndroid(a *App, appID appResolver) *cobra.Command {
	return typedUpload(a, appID, "android", []struct{ flag, tag, usage string }{
		{"application-id", "application_id", "Android applicationId"},
		{"build-type", "build_type", "debug|release|appbundle"},
		{"build", "build", "build number"},
		{"commit", "commit", "commit hash"},
		{"min-sdk", "min_sdk", "minSdkVersion"},
		{"target-sdk", "target_sdk", "targetSdkVersion"},
		{"abi", "abi", "ABI (e.g. arm64-v8a)"},
	}, []string{"application-id", "build-type"})
}

func newUploadIOS(a *App, appID appResolver) *cobra.Command {
	return typedUpload(a, appID, "ios", []struct{ flag, tag, usage string }{
		{"bundle-id", "bundle_id", "iOS bundle identifier"},
		{"build-number", "build_number", "build number"},
		{"distribution-method", "distribution_method", "ad-hoc|app-store|enterprise|development"},
		{"minimum-os-version", "minimum_os_version", "minimum iOS version"},
	}, []string{"bundle-id", "build-number"})
}
