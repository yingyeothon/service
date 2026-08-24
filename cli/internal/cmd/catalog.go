package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/flutter"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/catalog.ts.
type catalogGroup struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	OwnerLogin        *string `json:"ownerLogin"`
	PendingOwnerLogin *string `json:"pendingOwnerLogin"`
	CreatedAt         int64   `json:"createdAt"`
	UpdatedAt         int64   `json:"updatedAt"`
}

type catalogApp struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	Path              string  `json:"path"`
	DebugOnly         bool    `json:"debugOnly"`
	Description       *string `json:"description"`
	GroupID           *string `json:"groupId"`
	OwnerLogin        *string `json:"ownerLogin"`
	PendingOwnerLogin *string `json:"pendingOwnerLogin"`
	CreatedAt         int64   `json:"createdAt"`
	UpdatedAt         int64   `json:"updatedAt"`
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
}

type catalogPermission struct {
	ID        string  `json:"id"`
	Login     *string `json:"login"`
	Pending   bool    `json:"pending"`
	Level     string  `json:"level"`
	CreatedAt int64   `json:"createdAt"`
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

// uploadArtifact runs presign → PUT file → commit.
func uploadArtifact(ctx context.Context, cl *api.Client, appName, filePath, platform string, tags map[string]string) (*catalogArtifact, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var grant uploadGrant
	err = cl.Do(ctx, http.MethodPost, "/catalog/apps/"+api.PathID(appName)+"/artifacts", map[string]any{
		"platform": platform,
		"filename": filepath.Base(filePath),
		"size":     st.Size(),
		"tags":     tags,
	}, &grant)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, grant.Method, grant.URL, f)
	if err != nil {
		return nil, err
	}
	req.ContentLength = st.Size()
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
		return nil, fmt.Errorf("upload PUT failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("upload PUT failed: HTTP %d", res.StatusCode)
	}
	var artifact catalogArtifact
	if err := cl.Do(ctx, http.MethodPost, "/catalog/uploads/"+api.PathID(grant.UploadID)+"/commit", map[string]any{}, &artifact); err != nil {
		return nil, err
	}
	return &artifact, nil
}

func newCatalog(a *App) *cobra.Command {
	c := &cobra.Command{Use: "catalog", Short: "Binary catalog: apps, groups, artifacts, permissions"}
	p := func() output.Printer { return a.printer() }
	do := func(cmd *cobra.Command, method, path string, in, out any) error {
		cl, err := a.client()
		if err != nil {
			return err
		}
		return cl.Do(cmd.Context(), method, path, in, out)
	}

	printApp := func(v catalogApp) error {
		if a.jsonOut {
			return p().JSONValue(v)
		}
		return p().KV([][2]string{
			{"id", v.ID}, {"name", v.Name}, {"path", v.Path},
			{"debugOnly", fmt.Sprint(v.DebugOnly)},
			{"description", output.Str(v.Description)},
			{"group", output.Str(v.GroupID)},
			{"owner", output.Str(v.OwnerLogin)},
			{"created", output.Time(v.CreatedAt)}, {"updated", output.Time(v.UpdatedAt)},
		})
	}
	printGroup := func(v catalogGroup) error {
		if a.jsonOut {
			return p().JSONValue(v)
		}
		return p().KV([][2]string{
			{"id", v.ID}, {"name", v.Name}, {"owner", output.Str(v.OwnerLogin)},
			{"created", output.Time(v.CreatedAt)},
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
	printPermissions := func(perms []catalogPermission) error {
		if a.jsonOut {
			return p().JSONValue(map[string]any{"permissions": perms})
		}
		rows := make([][]string, 0, len(perms))
		for _, pm := range perms {
			pending := ""
			if pm.Pending {
				pending = "yes"
			}
			rows = append(rows, []string{pm.ID, output.Str(pm.Login), pm.Level, pending})
		}
		return p().Table([]string{"ID", "LOGIN", "LEVEL", "PENDING"}, rows)
	}

	// ---- app ----------------------------------------------------------------
	app := &cobra.Command{Use: "app", Short: "Catalog apps"}
	app.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List apps you can see",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var res struct {
				Apps []catalogApp `json:"apps"`
			}
			if err := do(cmd, http.MethodGet, "/catalog/apps", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Apps))
			for _, v := range res.Apps {
				rows = append(rows, []string{v.Name, v.Path, output.Str(v.GroupID), output.Str(v.OwnerLogin), output.Time(v.UpdatedAt)})
			}
			return p().Table([]string{"NAME", "PATH", "GROUP", "OWNER", "UPDATED"}, rows)
		},
	})
	{
		var path, description, groupID string
		var debugOnly bool
		create := &cobra.Command{
			Use:   "create <name>",
			Short: "Create an app (you become the owner)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]any{"name": args[0], "path": path}
				if description != "" {
					body["description"] = description
				}
				if groupID != "" {
					body["groupId"] = groupID
				}
				if debugOnly {
					body["debugOnly"] = true
				}
				var v catalogApp
				if err := do(cmd, http.MethodPost, "/catalog/apps", body, &v); err != nil {
					return err
				}
				return printApp(v)
			},
		}
		create.Flags().StringVar(&path, "path", "", "application id (e.g. life.yyt.my-game)")
		create.Flags().StringVar(&description, "description", "", "description")
		create.Flags().StringVar(&groupID, "group", "", "group id")
		create.Flags().BoolVar(&debugOnly, "debug-only", false, "mark as a debug-only app")
		_ = create.MarkFlagRequired("path")
		app.AddCommand(create)
	}
	app.AddCommand(&cobra.Command{
		Use:   "get <name>",
		Short: "Show one app",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogApp
			if err := do(cmd, http.MethodGet, "/catalog/apps/"+api.PathID(args[0]), nil, &v); err != nil {
				return err
			}
			return printApp(v)
		},
	})
	{
		var description, groupID string
		var noGroup, debugOnly, noDebugOnly bool
		update := &cobra.Command{
			Use:   "update <name>",
			Short: "Update app fields (owner or admin)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]any{}
				if cmd.Flags().Changed("description") {
					body["description"] = description
				}
				if noGroup {
					body["groupId"] = nil
				} else if groupID != "" {
					body["groupId"] = groupID
				}
				if debugOnly {
					body["debugOnly"] = true
				}
				if noDebugOnly {
					body["debugOnly"] = false
				}
				if len(body) == 0 {
					return errors.New("nothing to update: pass --description/--group/--no-group/--debug-only/--no-debug-only")
				}
				var v catalogApp
				if err := do(cmd, http.MethodPatch, "/catalog/apps/"+api.PathID(args[0]), body, &v); err != nil {
					return err
				}
				return printApp(v)
			},
		}
		update.Flags().StringVar(&description, "description", "", "description")
		update.Flags().StringVar(&groupID, "group", "", "group id")
		update.Flags().BoolVar(&noGroup, "no-group", false, "detach from its group")
		update.Flags().BoolVar(&debugOnly, "debug-only", false, "mark as debug-only")
		update.Flags().BoolVar(&noDebugOnly, "no-debug-only", false, "clear debug-only")
		app.AddCommand(update)
	}
	app.AddCommand(&cobra.Command{
		Use:   "delete <name>",
		Short: "Delete an app (must have no artifacts)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := do(cmd, http.MethodDelete, "/catalog/apps/"+api.PathID(args[0]), nil, nil); err != nil {
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
			Use:   "settings <name>",
			Short: "Show or update app settings (owner or admin)",
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
					err = do(cmd, http.MethodPatch, "/catalog/apps/"+api.PathID(args[0])+"/settings", body, &v)
				} else {
					err = do(cmd, http.MethodGet, "/catalog/apps/"+api.PathID(args[0])+"/settings", nil, &v)
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
			Use:   "cleanup <name>",
			Short: "Apply the app's retention policy (owner or admin)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				path := "/catalog/apps/" + api.PathID(args[0]) + "/artifacts/cleanup"
				if dryRun {
					path += "?dryRun=true"
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
				if err := do(cmd, http.MethodPost, path, map[string]any{}, &res); err != nil {
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

	// ---- group --------------------------------------------------------------
	group := &cobra.Command{Use: "group", Short: "Catalog groups"}
	group.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List groups you can see",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var res struct {
				Groups []catalogGroup `json:"groups"`
			}
			if err := do(cmd, http.MethodGet, "/catalog/groups", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Groups))
			for _, v := range res.Groups {
				rows = append(rows, []string{v.ID, v.Name, output.Str(v.OwnerLogin), output.Time(v.CreatedAt)})
			}
			return p().Table([]string{"ID", "NAME", "OWNER", "CREATED"}, rows)
		},
	})
	group.AddCommand(&cobra.Command{
		Use:   "create <name>",
		Short: "Create a group (you become the owner)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogGroup
			if err := do(cmd, http.MethodPost, "/catalog/groups", map[string]any{"name": args[0]}, &v); err != nil {
				return err
			}
			return printGroup(v)
		},
	})
	group.AddCommand(&cobra.Command{
		Use:   "get <id>",
		Short: "Show one group",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogGroup
			if err := do(cmd, http.MethodGet, "/catalog/groups/"+api.PathID(args[0]), nil, &v); err != nil {
				return err
			}
			return printGroup(v)
		},
	})
	group.AddCommand(&cobra.Command{
		Use:   "rename <id> <name>",
		Short: "Rename a group (owner or admin)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogGroup
			if err := do(cmd, http.MethodPatch, "/catalog/groups/"+api.PathID(args[0]), map[string]any{"name": args[1]}, &v); err != nil {
				return err
			}
			return printGroup(v)
		},
	})
	group.AddCommand(&cobra.Command{
		Use:   "delete <id>",
		Short: "Delete a group (apps are detached, not deleted)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := do(cmd, http.MethodDelete, "/catalog/groups/"+api.PathID(args[0]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(a.Out, "deleted")
			return nil
		},
	})
	group.AddCommand(&cobra.Command{
		Use:   "apps <id>",
		Short: "List the apps in a group",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Apps []catalogApp `json:"apps"`
			}
			if err := do(cmd, http.MethodGet, "/catalog/groups/"+api.PathID(args[0])+"/apps", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Apps))
			for _, v := range res.Apps {
				rows = append(rows, []string{v.Name, output.Str(v.OwnerLogin), output.Time(v.UpdatedAt)})
			}
			return p().Table([]string{"NAME", "OWNER", "UPDATED"}, rows)
		},
	})

	// ---- artifact -----------------------------------------------------------
	artifact := &cobra.Command{Use: "artifact", Short: "Build artifacts"}
	{
		var platform string
		list := &cobra.Command{
			Use:   "list <app>",
			Short: "List an app's artifacts (newest first)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				path := "/catalog/apps/" + api.PathID(args[0]) + "/artifacts"
				if platform != "" {
					path += "?platform=" + url.QueryEscape(platform)
				}
				var res struct {
					Artifacts []catalogArtifact `json:"artifacts"`
				}
				if err := do(cmd, http.MethodGet, path, nil, &res); err != nil {
					return err
				}
				if a.jsonOut {
					return p().JSONValue(res)
				}
				rows := make([][]string, 0, len(res.Artifacts))
				for _, v := range res.Artifacts {
					rows = append(rows, []string{v.ID, v.Tags["version"], v.Platform, fmt.Sprint(valOr(v.Size, 0)), output.Time(v.CreatedAt)})
				}
				return p().Table([]string{"ID", "VERSION", "PLATFORM", "SIZE", "CREATED"}, rows)
			},
		}
		list.Flags().StringVar(&platform, "platform", "", "filter by platform")
		artifact.AddCommand(list)
	}
	artifact.AddCommand(&cobra.Command{
		Use:   "get <app> <id>",
		Short: "Show one artifact (with its CDN URL)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogArtifact
			if err := do(cmd, http.MethodGet, "/catalog/apps/"+api.PathID(args[0])+"/artifacts/"+api.PathID(args[1]), nil, &v); err != nil {
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
				cl, err := a.client()
				if err != nil {
					return err
				}
				t, err := parseTags(tags)
				if err != nil {
					return err
				}
				t["version"] = version
				v, err := uploadArtifact(cmd.Context(), cl, args[0], args[1], platform, t)
				if err != nil {
					return err
				}
				return printArtifact(*v)
			},
		}
		up.Flags().StringVar(&platform, "platform", "", "android|ios|web|bin|server|win32|osx|linux")
		up.Flags().StringVar(&version, "version", "", "artifact version tag")
		up.Flags().StringArrayVar(&tags, "tag", nil, "extra tag key=value (repeatable)")
		_ = up.MarkFlagRequired("platform")
		_ = up.MarkFlagRequired("version")
		artifact.AddCommand(up)
	}
	artifact.AddCommand(&cobra.Command{
		Use:   "delete <app> <id>",
		Short: "Delete an artifact (removes the CDN object too)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := do(cmd, http.MethodDelete, "/catalog/apps/"+api.PathID(args[0])+"/artifacts/"+api.PathID(args[1]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(a.Out, "deleted")
			return nil
		},
	})

	// ---- permission ---------------------------------------------------------
	permission := &cobra.Command{Use: "permission", Short: "App/group permissions (owner or admin)"}
	permBase := func(cmd *cobra.Command, appName, groupID string) (string, error) {
		if (appName == "") == (groupID == "") {
			return "", errors.New("pass exactly one of --app <name> or --group <id>")
		}
		if appName != "" {
			return "/catalog/apps/" + api.PathID(appName) + "/permissions", nil
		}
		return "/catalog/groups/" + api.PathID(groupID) + "/permissions", nil
	}
	{
		var appName, groupID string
		list := &cobra.Command{
			Use:   "list",
			Short: "List permissions",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				base, err := permBase(cmd, appName, groupID)
				if err != nil {
					return err
				}
				var res struct {
					Permissions []catalogPermission `json:"permissions"`
				}
				if err := do(cmd, http.MethodGet, base, nil, &res); err != nil {
					return err
				}
				return printPermissions(res.Permissions)
			},
		}
		list.Flags().StringVar(&appName, "app", "", "app name")
		list.Flags().StringVar(&groupID, "group", "", "group id")
		permission.AddCommand(list)
	}
	{
		var appName, groupID string
		grant := &cobra.Command{
			Use:   "grant <login> <read|edit>",
			Short: "Grant (or update) a member's permission; unknown logins become pending",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				base, err := permBase(cmd, appName, groupID)
				if err != nil {
					return err
				}
				var res struct {
					Permissions []catalogPermission `json:"permissions"`
				}
				if err := do(cmd, http.MethodPost, base, map[string]any{"login": args[0], "level": args[1]}, &res); err != nil {
					return err
				}
				return printPermissions(res.Permissions)
			},
		}
		grant.Flags().StringVar(&appName, "app", "", "app name")
		grant.Flags().StringVar(&groupID, "group", "", "group id")
		permission.AddCommand(grant)
	}
	{
		var appName, groupID string
		revoke := &cobra.Command{
			Use:   "revoke <permission-id>",
			Short: "Revoke a permission by its id (see `permission list`)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				base, err := permBase(cmd, appName, groupID)
				if err != nil {
					return err
				}
				if err := do(cmd, http.MethodDelete, base+"/"+api.PathID(args[0]), nil, nil); err != nil {
					return err
				}
				fmt.Fprintln(a.Out, "revoked")
				return nil
			},
		}
		revoke.Flags().StringVar(&appName, "app", "", "app name")
		revoke.Flags().StringVar(&groupID, "group", "", "group id")
		permission.AddCommand(revoke)
	}

	// ---- installer ----------------------------------------------------------
	c.AddCommand(&cobra.Command{
		Use:   "installer",
		Short: "Show the latest installer downloads",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var res struct {
				Downloads []struct {
					URL       string  `json:"url"`
					Filename  string  `json:"filename"`
					Platform  string  `json:"platform"`
					Version   *string `json:"version"`
					CreatedAt int64   `json:"createdAt"`
				} `json:"downloads"`
			}
			if err := do(cmd, http.MethodGet, "/catalog/installer/downloads", nil, &res); err != nil {
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

	c.AddCommand(app, group, artifact, permission, newCatalogDeploy(a))
	return c
}

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

func newCatalogDeploy(a *App) *cobra.Command {
	var (
		name        string
		projectPath string
		profiles    []string
		groupID     string
		description string
		debugOnly   bool
		stage       string
		changelog   string
		bump        string
		doBump      bool
	)
	c := &cobra.Command{
		Use:   "deploy",
		Short: "Build a Flutter Android app and upload the artifacts",
		Long: `Reads pubspec.yaml / build.gradle from --project-path, ensures the app exists
(creating it as you when missing), runs "flutter build" for each --profile,
and uploads the outputs with version/build_type/application_id tags.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			if len(profiles) == 0 {
				profiles = []string{"release"}
			}
			if len(profiles) == 1 && profiles[0] == "all" {
				profiles = []string{"debug", "release", "appbundle"}
			}
			for _, pr := range profiles {
				if _, ok := profileOutput[pr]; !ok {
					return fmt.Errorf("invalid --profile %q (debug|release|appbundle|all)", pr)
				}
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

			// Ensure the app exists; 404 → create it.
			var appRow catalogApp
			err = cl.Do(ctx, http.MethodGet, "/catalog/apps/"+api.PathID(name), nil, &appRow)
			var apiErr *api.Error
			if errors.As(err, &apiErr) && apiErr.Status == 404 {
				body := map[string]any{"name": name, "path": applicationID}
				if description != "" {
					body["description"] = description
				}
				if groupID != "" {
					body["groupId"] = groupID
				}
				if debugOnly {
					body["debugOnly"] = true
				}
				if err := cl.Do(ctx, http.MethodPost, "/catalog/apps", body, &appRow); err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "created app %s\n", name)
			} else if err != nil {
				return err
			}

			label := flutter.Label(projectPath)
			uploaded := make([]catalogArtifact, 0, len(profiles))
			for _, pr := range profiles {
				spec := profileOutput[pr]
				fmt.Fprintf(a.Err, "building %s (%s)…\n", name, pr)
				if err := deployRunner(ctx, projectPath, "flutter", spec.args...); err != nil {
					return fmt.Errorf("flutter build %s: %w", pr, err)
				}
				out := filepath.Join(projectPath, spec.out)
				// Rename so the CDN filename carries app+version+profile.
				dst := filepath.Join(filepath.Dir(out), fmt.Sprintf("%s-%s-%s%s", name, version, pr, spec.ext))
				if err := os.Rename(out, dst); err != nil {
					return err
				}
				tags := map[string]string{
					"version":        version,
					"build_type":     pr, // matches the server enum (debug|release|appbundle)
					"application_id": applicationID,
				}
				if stage != "" {
					tags["stage"] = stage
				}
				if changelog != "" {
					tags["changelog"] = changelog
				}
				if label != "" {
					tags["title"] = label
				}
				fmt.Fprintf(a.Err, "uploading %s…\n", filepath.Base(dst))
				art, err := uploadArtifact(ctx, cl, name, dst, "android", tags)
				if err != nil {
					return err
				}
				uploaded = append(uploaded, *art)
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"app": appRow, "version": version, "artifacts": uploaded})
			}
			for _, art := range uploaded {
				fmt.Fprintf(a.Out, "%s %s %s\n", art.ID, art.Tags["build_type"], art.URL)
			}
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "app name (default: last segment of the applicationId)")
	f.StringVar(&projectPath, "project-path", ".", "Flutter project directory")
	f.StringArrayVar(&profiles, "profile", nil, "debug|release|appbundle|all (repeatable; default release)")
	f.StringVar(&groupID, "group", "", "group id when creating the app")
	f.StringVar(&description, "description", "", "description when creating the app")
	f.BoolVar(&debugOnly, "debug-only", false, "mark the app debug-only when creating it")
	f.StringVar(&stage, "stage", "", "stage tag (e.g. alpha, beta, prod)")
	f.StringVar(&changelog, "note", "", "changelog tag")
	f.StringVar(&bump, "bump", "patch", "version bump when --do-bump: major|minor|patch")
	f.BoolVar(&doBump, "do-bump", false, "bump pubspec version before building")
	return c
}
