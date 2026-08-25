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
	if err := putPresigned(ctx, cl, grant, f, st.Size()); err != nil {
		return nil, err
	}
	var artifact catalogArtifact
	if err := cl.Do(ctx, http.MethodPost, "/catalog/uploads/"+api.PathID(grant.UploadID)+"/commit", map[string]any{}, &artifact); err != nil {
		return nil, err
	}
	return &artifact, nil
}

func newCatalog(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:     "catalog",
		Aliases: []string{"cata"}, // legacy cata CLI muscle memory
		Short:   "Binary catalog: apps, groups, artifacts, permissions",
	}
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
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List apps you can see",
		Args:    cobra.NoArgs,
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
		Use:     "delete <name>",
		Aliases: []string{"rm"},
		Short:   "Delete an app (must have no artifacts)",
		Args:    cobra.ExactArgs(1),
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
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List groups you can see",
		Args:    cobra.NoArgs,
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
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete a group (apps are detached, not deleted)",
		Args:    cobra.ExactArgs(1),
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
				arts, err := listArtifacts(cmd.Context(), a, args[0], platform, want)
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
		up.AddCommand(newUploadAndroid(a), newUploadIOS(a))
		artifact.AddCommand(up)
	}
	artifact.AddCommand(&cobra.Command{
		Use:     "delete <app> <id>",
		Aliases: []string{"rm"},
		Short:   "Delete an artifact (removes the CDN object too)",
		Args:    cobra.ExactArgs(2),
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
			Use:     "list",
			Aliases: []string{"ls"},
			Short:   "List permissions",
			Args:    cobra.NoArgs,
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

	c.AddCommand(app, group, artifact, permission, newCatalogDeploy(a), newCatalogBump(a))
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
func listArtifacts(ctx context.Context, a *App, appName, platform string, want map[string]string) ([]catalogArtifact, error) {
	cl, err := a.client()
	if err != nil {
		return nil, err
	}
	path := "/catalog/apps/" + api.PathID(appName) + "/artifacts"
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
func verifyUploaded(ctx context.Context, a *App, appName string, ids []string) (int, error) {
	got := 0
	for attempt := 1; attempt <= 5; attempt++ {
		arts, err := listArtifacts(ctx, a, appName, "", nil)
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
		groupID        string
		description    string
		debugOnly      bool
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
		Long: `Reads pubspec.yaml / build.gradle from --project-path, ensures the app exists
(creating it as you when missing), runs "flutter build" for each --profile,
uploads the outputs with version/build_type/application_id tags, and verifies
the upload by re-reading the artifact list.`,
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
					art, err := uploadArtifact(ctx, cl, name, dst, "android", tags)
					if err != nil {
						return err
					}
					uploaded = append(uploaded, *art)
				}
			}
			verified := 0
			if !noVerify {
				ids := make([]string, 0, len(uploaded))
				for _, art := range uploaded {
					ids = append(ids, art.ID)
				}
				verified, err = verifyUploaded(ctx, a, name, ids)
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
	f.StringVar(&name, "name", "", "app name (default: last segment of the applicationId)")
	f.StringVar(&projectPath, "project-path", ".", "Flutter project directory")
	f.StringArrayVar(&profiles, "build-profile", nil, "debug|release|appbundle|aab|all (repeatable; default release)")
	f.StringVar(&groupID, "group", "", "group id when creating the app")
	f.StringVar(&description, "description", "", "description when creating the app")
	f.BoolVar(&debugOnly, "debug-only", false, "mark the app debug-only when creating it")
	f.StringVar(&stage, "stage", "", "stage tag (e.g. alpha, beta, prod)")
	f.StringVar(&changelog, "note", "", "changelog tag")
	f.StringVar(&bump, "bump", "patch", "version bump when --do-bump: major|minor|patch")
	f.BoolVar(&doBump, "do-bump", false, "bump pubspec version before building")
	f.BoolVar(&splitPerAbi, "split-per-abi", false, "pass --split-per-abi to flutter build (APK profiles; uploads one artifact per ABI)")
	f.StringVar(&targetPlatform, "target-platform", "", "pass --target-platform to flutter build (e.g. android-arm64)")
	f.StringVar(&buildNo, "build", "", "build tag (build number)")
	f.StringVar(&commit, "commit", "", "commit tag (e.g. from `git rev-parse --short HEAD`)")
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
func typedUpload(a *App, platform string, tagFlags []struct{ flag, tag, usage string }, required []string) *cobra.Command {
	var version, stage, changelog string
	var extraTags []string
	values := make([]string, len(tagFlags))
	c := &cobra.Command{
		Use:   platform + " <app> <file>",
		Short: "Upload a " + platform + " artifact with typed tag flags",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
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
			v, err := uploadArtifact(cmd.Context(), cl, args[0], args[1], platform, tags)
			if err != nil {
				return err
			}
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

func newUploadAndroid(a *App) *cobra.Command {
	return typedUpload(a, "android", []struct{ flag, tag, usage string }{
		{"application-id", "application_id", "Android applicationId"},
		{"build-type", "build_type", "debug|release|appbundle"},
		{"build", "build", "build number"},
		{"commit", "commit", "commit hash"},
		{"min-sdk", "min_sdk", "minSdkVersion"},
		{"target-sdk", "target_sdk", "targetSdkVersion"},
		{"abi", "abi", "ABI (e.g. arm64-v8a)"},
	}, []string{"application-id", "build-type"})
}

func newUploadIOS(a *App) *cobra.Command {
	return typedUpload(a, "ios", []struct{ flag, tag, usage string }{
		{"bundle-id", "bundle_id", "iOS bundle identifier"},
		{"build-number", "build_number", "build number"},
		{"distribution-method", "distribution_method", "ad-hoc|app-store|enterprise|development"},
		{"minimum-os-version", "minimum_os_version", "minimum iOS version"},
	}, []string{"bundle-id", "build-number"})
}
