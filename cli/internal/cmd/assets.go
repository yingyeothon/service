package cmd

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
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
	TeamID      *string `json:"teamId"`
	TeamName    *string `json:"teamName"`
	ProjectID   *string `json:"projectId"`
	ProjectName *string `json:"projectName"`
	CreatedBy   *string `json:"createdBy"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	// Only on the detail route.
	Versions []assetVersion `json:"versions,omitempty"`
	Bytes    int64          `json:"bytes,omitempty"`
}

type assetVersion struct {
	Version   string `json:"version"`
	Files     int    `json:"files"`
	Bytes     int64  `json:"bytes"`
	CreatedAt int64  `json:"createdAt"`
}

type assetFile struct {
	ID          string `json:"id"`
	BundleID    string `json:"bundleId"`
	Version     string `json:"version"`
	Path        string `json:"path"`
	URL         string `json:"url"`
	ObjectKey   string `json:"objectKey"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	CreatedAt   int64  `json:"createdAt"`
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
		Short: "Game asset bundles: immutable versioned files on the public CDN (a bundle belongs to a project)",
		Long: "Game asset bundles: immutable versioned files on the public CDN.\n\n" +
			"An asset object is public, cached forever and never overwritten: fixing a\n" +
			"file means publishing a new version and pointing the lobby channel's\n" +
			"--map-url at it (`yyt channels update <id> --map-url ...`).\n\n" +
			"<bundle> is an id (ab_…) or a name unique within the team; a name is looked\n" +
			"up in the project context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`). `create`, `upload` and `push` need an explicit context.",
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
		{"project", crumb(b.TeamName, b.ProjectName)},
		{"description", output.Str(b.Description)},
		{"createdBy", output.Str(b.CreatedBy)},
		{"created", output.Time(b.CreatedAt)},
		{"updated", output.Time(b.UpdatedAt)},
	}
	if len(b.Versions) > 0 || b.Bytes > 0 {
		pairs = append(pairs, [2]string{"bytes", fmt.Sprint(b.Bytes)})
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
				rows = append(rows, []string{b.ID, b.Name, crumb(b.TeamName, b.ProjectName), output.Str(b.Description), output.Time(b.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "TEAM/PROJECT", "DESCRIPTION", "UPDATED"}, rows)
		},
	}
}

func newAssetCreate(a *App) *cobra.Command {
	var description string
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create an asset bundle in the project context (explicit)",
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
			var b assetBundle
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/assets/bundles", body, &b); err != nil {
				return err
			}
			return a.printBundle(b)
		},
	}
	c.Flags().StringVar(&description, "description", "", "human-readable description")
	return c
}

func newAssetGet(a *App, bundleID bundleResolver) *cobra.Command {
	return newResourceGet(bundleID, "get <bundle>", "Show one bundle with its versions", "/assets/bundles", a.printBundle)
}

func newAssetUpdate(a *App, bundleID bundleResolver) *cobra.Command {
	return newResourceUpdate(bundleID, "update <bundle>", "Rename a bundle or change its description (empty --description clears it)", "new bundle name (unique within the team)", "/assets/bundles", a.printBundle)
}

func newAssetDelete(a *App, bundleID bundleResolver) *cobra.Command {
	return newResourceDelete(a, bundleID, "delete <bundle>", "Delete a bundle with every version and object it holds", "/assets/bundles")
}

func (a *App) printFiles(bundle, version string, files []assetFile) error {
	if a.jsonOut {
		return a.printer().JSONValue(map[string]any{"bundle": bundle, "version": version, "files": files})
	}
	rows := make([][]string, 0, len(files))
	for _, f := range files {
		rows = append(rows, []string{f.Path, f.ContentType, fmt.Sprint(f.Size), f.URL})
	}
	return a.printer().Table([]string{"PATH", "TYPE", "BYTES", "URL"}, rows)
}

func newAssetFiles(a *App, bundleID bundleResolver) *cobra.Command {
	return &cobra.Command{
		Use:     "files <bundle> <version>",
		Aliases: []string{"version"},
		Short:   "List the files of one version with their public URLs",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], false)
			if err != nil {
				return err
			}
			var res struct {
				Bundle  string      `json:"bundle"`
				Version string      `json:"version"`
				Files   []assetFile `json:"files"`
			}
			path := "/assets/bundles/" + api.PathID(id) + "/versions/" + api.PathID(args[1])
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &res); err != nil {
				return err
			}
			return a.printFiles(res.Bundle, res.Version, res.Files)
		},
	}
}

func newAssetVersionDelete(a *App, bundleID bundleResolver) *cobra.Command {
	return &cobra.Command{
		Use:   "rm-version <bundle> <version>",
		Short: "Delete one version's files and objects",
		Long: "Delete one version's files and objects.\n\n" +
			"Nothing checks whether a channel still points at this version: a client\n" +
			"that cached the URL gets a 404 and cannot load the game at all. Re-point\n" +
			"every lobby channel's --map-url first.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			path := "/assets/bundles/" + api.PathID(id) + "/versions/" + api.PathID(args[1])
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
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
				return err
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
