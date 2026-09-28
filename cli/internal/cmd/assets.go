package cmd

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/assets.ts.
type assetBundle struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	// "versioned" or "live", fixed at creation.
	Mode        string  `json:"mode"`
	TeamID      *string `json:"teamId"`
	TeamName    *string `json:"teamName"`
	ProjectID   *string `json:"projectId"`
	ProjectName *string `json:"projectName"`
	CreatedBy   *string `json:"createdBy"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	// Only on the detail route.
	Versions []assetVersion `json:"versions,omitempty"`
	Files    int            `json:"files,omitempty"`
	Bytes    int64          `json:"bytes,omitempty"`
}

type assetVersion struct {
	Version   string `json:"version"`
	Files     int    `json:"files"`
	Bytes     int64  `json:"bytes"`
	CreatedAt int64  `json:"createdAt"`
}

type assetFile struct {
	ID          string  `json:"id"`
	BundleID    string  `json:"bundleId"`
	Version     string  `json:"version"`
	Path        string  `json:"path"`
	URL         string  `json:"url"`
	ObjectKey   string  `json:"objectKey"`
	ContentType string  `json:"contentType"`
	Size        int64   `json:"size"`
	SHA256      *string `json:"sha256"`
	Mutable     bool    `json:"mutable"`
	StaleSince  *int64  `json:"staleSince"`
	CreatedAt   int64   `json:"createdAt"`
}

// modeOf reads an older console's missing mode as what it was: versioned.
func modeOf(mode string) string {
	if mode == "" {
		return "versioned"
	}
	return mode
}

// liveHint turns the console's refusal of a version on a live bundle into
// the command that does work there.
func liveHint(err error, bundle string) error {
	var ae *api.Error
	if errors.As(err, &ae) && ae.Status == http.StatusBadRequest && strings.Contains(ae.Message, "live bundle") {
		return fmt.Errorf("%w (%s is a live bundle: use `yyt asset sync %s <dir>`)", err, bundle, bundle)
	}
	return err
}

// uploadAssetFile runs presign → PUT file → commit for one file of a bundle
// version. `bundle` is the bundle id. `path` is the file's location *inside*
// the bundle, which is what the map JSON's relative references resolve
// against — not the local filename.
func uploadAssetFile(ctx context.Context, cl *api.Client, bundle, version, path, localPath string) (*assetFile, error) {
	return uploadFile[assetFile](ctx, cl, localPath, "/assets/bundles/"+api.PathID(bundle)+"/files", func(size int64) map[string]any {
		return map[string]any{
			"version": version,
			"path":    path,
			"size":    size,
		}
	}, "/assets/uploads/")
}

func newAssets(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "asset",
		Short: "Game asset bundles: files on the public CDN, versioned or live (a bundle belongs to a project)",
		Long: "Game asset bundles: files on the public CDN.\n\n" +
			"A versioned bundle (the default) keeps every file under a version: an\n" +
			"object is public, cached forever and never overwritten, so fixing a file\n" +
			"means publishing a new version and pointing the lobby channel's --map-url\n" +
			"at it (`yyt channels update <id> --map-url ...`).\n\n" +
			"A live bundle (`create --mode live`) has one namespace kept in step with a\n" +
			"directory by `asset sync`: files are immutable unless matched by --mutable\n" +
			"(a manifest, served no-cache and replaced in place), and every upload\n" +
			"carries its SHA-256, so unchanged files are never sent again.\n\n" +
			"<bundle> is an id (ab_…) or a name unique within the team; a name is looked\n" +
			"up in the project context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`). `create`, `upload`, `push` and `sync` need an explicit\n" +
			"context.",
	}
	// bundleID resolves <bundle> (id or name); write=true refuses auto-selection.
	bundleID := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.bundle(cmd.Context(), arg, write)
		return cc, id, err
	}
	c.AddCommand(
		newAssetList(a),
		newAssetCreate(a),
		newAssetGet(a, bundleID),
		newAssetUpdate(a, bundleID),
		newAssetDelete(a, bundleID),
		newAssetFiles(a, bundleID),
		newAssetVersionDelete(a, bundleID),
		newAssetUpload(a, bundleID),
		newAssetPush(a, bundleID),
		newAssetRm(a, bundleID),
		newAssetSync(a, bundleID),
		newAssetDownload(a, bundleID),
	)
	return group(c)
}

type bundleResolver = idResolver

func (a *App) printBundle(b assetBundle) error {
	if a.jsonOut {
		return a.printer().JSONValue(b)
	}
	pairs := [][2]string{
		{"id", b.ID},
		{"name", b.Name},
		{"mode", modeOf(b.Mode)},
		{"project", crumb(b.TeamName, b.ProjectName)},
		{"description", output.Str(b.Description)},
		{"createdBy", output.Str(b.CreatedBy)},
		{"created", output.Time(b.CreatedAt)},
		{"updated", output.Time(b.UpdatedAt)},
	}
	if len(b.Versions) > 0 || b.Bytes > 0 {
		pairs = append(pairs, [2]string{"files", fmt.Sprint(b.Files)}, [2]string{"bytes", fmt.Sprint(b.Bytes)})
	}
	if err := a.printer().KV(pairs); err != nil {
		return err
	}
	if len(b.Versions) == 0 {
		return nil
	}
	rows := make([][]string, 0, len(b.Versions))
	for _, v := range b.Versions {
		rows = append(rows, []string{v.Version, fmt.Sprint(v.Files), fmt.Sprint(v.Bytes), output.Time(v.CreatedAt)})
	}
	fmt.Fprintln(a.Out)
	return a.printer().Table([]string{"VERSION", "FILES", "BYTES", "CREATED"}, rows)
}

func newAssetList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the bundles of the project in context, or of every team you sit in",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			path := "/assets/bundles"
			if cc.spec.explicitTeam() || cc.spec.explicitProject() {
				r, err := cc.project(cmd.Context(), false)
				if err != nil {
					return err
				}
				path = "/projects/" + api.PathID(r.ProjectID) + "/assets/bundles"
			}
			var res struct {
				Bundles []assetBundle `json:"bundles"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Bundles))
			for _, b := range res.Bundles {
				rows = append(rows, []string{b.ID, b.Name, modeOf(b.Mode), crumb(b.TeamName, b.ProjectName), output.Str(b.Description), output.Time(b.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "MODE", "TEAM/PROJECT", "DESCRIPTION", "UPDATED"}, rows)
		},
	}
}

func newAssetCreate(a *App) *cobra.Command {
	var description, mode string
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create an asset bundle in the project context (explicit)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if mode != "versioned" && mode != "live" {
				return fmt.Errorf("--mode is versioned or live, not %q", mode)
			}
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), true)
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0]}
			// Only when it is not the default: an older console's strict body
			// refuses a key it does not know, and versioned is what it makes.
			if mode == "live" {
				body["mode"] = mode
			}
			if description != "" {
				body["description"] = description
			}
			var b assetBundle
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/assets/bundles", body, &b); err != nil {
				return err
			}
			return a.printBundle(b)
		},
	}
	c.Flags().StringVar(&description, "description", "", "human-readable description")
	c.Flags().StringVar(&mode, "mode", "versioned", "versioned (files under versions, never overwritten) or live (one namespace kept by `asset sync`); fixed at creation")
	return c
}

func newAssetGet(a *App, bundleID bundleResolver) *cobra.Command {
	return newResourceGet(bundleID, "get <bundle>", "Show one bundle with its versions", "/assets/bundles", a.printBundle)
}

func newAssetUpdate(a *App, bundleID bundleResolver) *cobra.Command {
	return newResourceUpdate(bundleID, "update <bundle>", "Rename a bundle or change its description (empty --description clears it)", "new bundle name (unique within the team)", "/assets/bundles", a.printBundle)
}

// deleteRounds bounds how often a delete is repeated after a 202: each round
// deletes up to a few thousand objects, and a bundle holds at most 20,000.
const deleteRounds = 50

// repeatDelete sends DELETE until the console answers 204. A bundle or
// version delete stops before the Lambda's deadline and answers 202 with its
// progress; the deleted rows are gone, so the next round resumes.
func (a *App) repeatDelete(ctx context.Context, cl *api.Client, path string) error {
	total := 0
	for round := 0; round < deleteRounds; round++ {
		var p struct {
			Deleted int `json:"deleted"`
			Failed  int `json:"failed"`
		}
		status, err := cl.DoStatus(ctx, http.MethodDelete, path, nil, &p)
		if err != nil {
			return err
		}
		if status != http.StatusAccepted {
			return nil
		}
		total += p.Deleted
		fmt.Fprintf(a.Err, "deleted %d object(s) so far; continuing\n", total)
	}
	return fmt.Errorf("still deleting after %d rounds (%d objects); run the command again", deleteRounds, total)
}

func newAssetDelete(a *App, bundleID bundleResolver) *cobra.Command {
	// Not `rm`: `asset rm <bundle> <path...>` deletes files, and one missing
	// argument must not turn that into deleting the whole bundle.
	return &cobra.Command{
		Use:     "delete <bundle>",
		Aliases: []string{"remove"},
		Short:   "Delete a bundle with every version and object it holds",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			if err := a.repeatDelete(cmd.Context(), cc.cl, "/assets/bundles/"+api.PathID(id)); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[0])
			return nil
		},
	}
}

// shortSHA is the first 12 hex digits, enough to tell files apart in a table.
func shortSHA(sha *string) string {
	if sha == nil || len(*sha) < 12 {
		return output.Str(sha)
	}
	return (*sha)[:12]
}

func fileFlags(f assetFile) string {
	var flags []string
	if f.Mutable {
		flags = append(flags, "mutable")
	}
	if f.StaleSince != nil {
		flags = append(flags, "stale")
	}
	if len(flags) == 0 {
		return "-"
	}
	return strings.Join(flags, ",")
}

func (a *App) printFiles(bundle, version string, files []assetFile) error {
	if a.jsonOut {
		return a.printer().JSONValue(map[string]any{"bundle": bundle, "version": version, "files": files})
	}
	rows := make([][]string, 0, len(files))
	for _, f := range files {
		rows = append(rows, []string{f.Path, f.ContentType, fmt.Sprint(f.Size), shortSHA(f.SHA256), fileFlags(f), f.URL})
	}
	return a.printer().Table([]string{"PATH", "TYPE", "BYTES", "SHA-256", "FLAGS", "URL"}, rows)
}

// listAssetFiles follows every page of a bundle's files: one version of a
// versioned bundle (`version` set) or the whole namespace of a live one.
// `do` is the caller's request function (sync rate-limits and retries it).
// With `mustExist` a version that holds nothing is a 404 (the versions
// route); without, it is an empty list (what a sync into a new version sees).
func listAssetFiles(ctx context.Context, do apiCall, id, version string, mustExist bool) ([]assetFile, error) {
	var files []assetFile
	cursor := ""
	for {
		var res struct {
			Files []assetFile `json:"files"`
			Next  *string     `json:"next"`
		}
		var path string
		switch {
		case version != "" && mustExist:
			path = "/assets/bundles/" + api.PathID(id) + "/versions/" + api.PathID(version) + "?limit=1000"
		case version != "":
			path = "/assets/bundles/" + api.PathID(id) + "/files?limit=1000&version=" + url.QueryEscape(version)
		default:
			path = "/assets/bundles/" + api.PathID(id) + "/files?limit=1000"
		}
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		if err := do(ctx, http.MethodGet, path, nil, &res); err != nil {
			return nil, err
		}
		files = append(files, res.Files...)
		if res.Next == nil || *res.Next == "" || *res.Next == cursor {
			return files, nil
		}
		cursor = *res.Next
	}
}

// apiCall is the shape of api.Client.Do, so a caller can wrap it.
type apiCall func(ctx context.Context, method, path string, in, out any) error

func newAssetFiles(a *App, bundleID bundleResolver) *cobra.Command {
	return &cobra.Command{
		Use:     "files <bundle> [version]",
		Aliases: []string{"version"},
		Short:   "List a version's files (or a live bundle's) with their public URLs",
		Long: "List the files of one version of a versioned bundle, or every file of a\n" +
			"live bundle (which takes no version), with their public URLs, SHA-256 and\n" +
			"flags (mutable, stale).",
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], false)
			if err != nil {
				return err
			}
			version := ""
			if len(args) == 2 {
				version = args[1]
			}
			// The routes page by path; a version holds at most the hard
			// `asset.filesPerVersion` (5,000) and a live bundle the hard
			// `asset.filesPerBundle` (20,000), so follow every page.
			files, err := listAssetFiles(cmd.Context(), cc.cl.Do, id, version, true)
			if err != nil {
				return err
			}
			return a.printFiles(args[0], version, files)
		},
	}
}

func newAssetVersionDelete(a *App, bundleID bundleResolver) *cobra.Command {
	return &cobra.Command{
		Use:   "rm-version <bundle> <version>",
		Short: "Delete one version's files and objects",
		Long: "Delete one version's files and objects.\n\n" +
			"The console refuses while a lobby channel of the bundle's team still\n" +
			"points its --map-url into the version: re-point those first. Anyone else\n" +
			"who cached a URL of the version gets a 404 afterwards. A large version is\n" +
			"deleted in rounds; the command repeats until the console says it is done.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			path := "/assets/bundles/" + api.PathID(id) + "/versions/" + api.PathID(args[1])
			if err := a.repeatDelete(cmd.Context(), cc.cl, path); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s/%s\n", args[0], args[1])
			return nil
		},
	}
}

func newAssetUpload(a *App, bundleID bundleResolver) *cobra.Command {
	var path string
	c := &cobra.Command{
		Use:   "upload <bundle> <version> <file>",
		Short: "Upload one file into a bundle version (presigned PUT + commit)",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			inBundle := path
			if inBundle == "" {
				inBundle = filepath.Base(args[2])
			}
			f, err := uploadAssetFile(cmd.Context(), cc.cl, id, args[1], inBundle, args[2])
			if err != nil {
				return liveHint(err, args[0])
			}
			return a.printFiles(args[0], args[1], []assetFile{*f})
		},
	}
	c.Flags().StringVar(&path, "path", "", "path inside the bundle (default: the file's base name)")
	return c
}

func newAssetPush(a *App, bundleID bundleResolver) *cobra.Command {
	c := &cobra.Command{
		Use:   "push <bundle> <version> <dir>",
		Short: "Upload a whole directory as one bundle version",
		Long: "Upload a whole directory as one bundle version.\n\n" +
			"Every file keeps its path relative to <dir>, so the relative references\n" +
			"inside a map JSON keep resolving once the bundle is on the CDN.",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			cl := cc.cl
			bundle, version, dir := args[0], args[1], args[2]
			local, err := collectAssetFiles(dir)
			if err != nil {
				return err
			}
			if len(local) == 0 {
				return fmt.Errorf("no files under %s", dir)
			}
			uploaded := make([]assetFile, 0, len(local))
			for _, rel := range local {
				f, err := uploadAssetFile(cmd.Context(), cl, id, version, rel, filepath.Join(dir, filepath.FromSlash(rel)))
				if err != nil {
					if len(uploaded) == 0 {
						if hinted := liveHint(err, bundle); hinted != err {
							return hinted
						}
					}
					// Partial versions are harmless: nothing points at this
					// version until a channel's --map-url does. Name what landed,
					// and say how to retry — a published path is write-once, so
					// re-running push as-is would 409 on the files that did land.
					return fmt.Errorf("%s: %w (uploaded %d/%d; retry with `yyt asset rm-version %s %s` first, or push a new version)",
						rel, err, len(uploaded), len(local), bundle, version)
				}
				uploaded = append(uploaded, *f)
			}
			return a.printFiles(bundle, version, uploaded)
		},
	}
	return c
}

// collectAssetFiles lists regular files under `dir` as slash-separated paths
// relative to it, sorted. Dot-files and symlinks are skipped: a symlink would
// upload whatever it points at under a name that hides its origin.
func collectAssetFiles(dir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if p != dir && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}
