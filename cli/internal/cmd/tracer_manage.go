package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Management of tracer resources through the console (todo/85 P9): create,
// list, get, rename, rotate-key, delete, dsn. The write key is shown to every
// team member on purpose (docs/decisions.md *Debug collector* #6): it ships
// inside debug builds and is protected by rotation and quotas, not secrecy.

// tracerResource is the console's tracer view.
type tracerResource struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	TeamID      *string `json:"teamId"`
	TeamName    *string `json:"teamName"`
	ProjectID   *string `json:"projectId"`
	ProjectName *string `json:"projectName"`
	CreatedBy   *string `json:"createdBy"`
	// Absent for a seatless platform admin.
	WriteKey *string `json:"writeKey,omitempty"`
	// null until the stage has a tracer-url; absent for a seatless admin.
	DSN       *string `json:"dsn,omitempty"`
	ReadURL   *string `json:"readUrl"`
	NoBackup  bool    `json:"noBackup"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

const tracerResourceOutput = "the resource as key/value lines (id, name, project, description, writeKey, dsn, readUrl, backup, createdBy, created, updated; every value on one line); --json: {id,name,writeKey,dsn,readUrl,noBackup,…}"

// tracer resolves a tracer resource id or name (`trc_` is in the shared id
// grammar, IsID).
func (c *ctxClient) tracer(ctx context.Context, arg string, write bool) (string, error) {
	// Ids are minted lowercase; an id typed in capitals means the same row.
	if strings.HasPrefix(strings.ToLower(arg), "trc_") {
		return strings.ToLower(arg), nil
	}
	return c.resource(ctx, "tracer resource", "/tracers", "tracers", arg, write)
}

func (a *App) printTracerResource(v tracerResource) error {
	if a.jsonOut {
		return a.printer().JSONValue(v)
	}
	// Every value is console text a team member may have set: one line each,
	// so a description cannot forge a `dsn:` or `writeKey:` line.
	backup := "none: debug data is disposable and kept at most 30 days"
	if !v.NoBackup {
		backup = "see the console"
	}
	pairs := [][2]string{
		{"id", oneLine(v.ID)},
		{"name", oneLine(v.Name)},
		{"project", oneLine(crumb(v.TeamName, v.ProjectName))},
		{"description", oneLine(output.Str(v.Description))},
	}
	if v.WriteKey != nil {
		pairs = append(pairs, [2]string{"writeKey", oneLine(*v.WriteKey)})
	}
	pairs = append(pairs,
		[2]string{"dsn", oneLine(strOr(v.DSN, dsnAbsent(v)))},
		[2]string{"readUrl", oneLine(strOr(v.ReadURL, "-"))},
		[2]string{"backup", backup},
		[2]string{"createdBy", oneLine(output.Str(v.CreatedBy))},
		[2]string{"created", output.Time(v.CreatedAt)},
		[2]string{"updated", output.Time(v.UpdatedAt)},
	)
	return a.printer().KV(pairs)
}

// dsnAbsent says why a view has no DSN.
func dsnAbsent(v tracerResource) string {
	if v.WriteKey == nil {
		return "- (not shown to a platform admin without a seat)"
	}
	return "- (tracer is not configured on this stage)"
}

var tracerKeyRe = regexp.MustCompile(`^[0-9a-f]{32,64}$`)

// checkedDSN is the view's DSN only if it has the shape the console mints:
// https://<this resource's write key>@<host>/<this resource's id>. A build
// script embeds what this prints, so anything else is refused, not echoed.
func checkedDSN(v tracerResource) (string, error) {
	if v.DSN == nil || *v.DSN == "" {
		return "", errors.New("tracer is not configured on this stage (the console has no tracer-url yet)")
	}
	bad := errors.New("the console returned a DSN in an unexpected shape; refusing to print it")
	if v.WriteKey == nil || !tracerKeyRe.MatchString(*v.WriteKey) || strings.ContainsFunc(*v.DSN, func(r rune) bool { return r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) }) {
		return "", bad
	}
	u, err := url.Parse(*v.DSN)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User == nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", bad
	}
	if _, hasPw := u.User.Password(); hasPw || u.User.Username() != *v.WriteKey || u.Path != "/"+v.ID {
		return "", bad
	}
	return u.String(), nil
}

func strOr(s *string, dflt string) string {
	if s == nil || *s == "" {
		return dflt
	}
	return *s
}

// tracerManagement adds the console-side commands to `yyt tracer`. They never
// use --local (refused) or YYT_TRACER_LOCAL (ignored, so a shell set up for
// local reads still manages console resources): a local tracer has its
// resources in tracer.json.
func (a *App) tracerManagement() []*cobra.Command {
	id := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		if cmd.Flags().Changed("local") {
			return nil, "", errors.New("--local reads a local tracer; resource management goes through the console")
		}
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		res, err := cc.tracer(cmd.Context(), arg, write)
		return cc, res, err
	}
	get := newResourceGet(id, "get <res>", "Show one tracer resource with its write key and DSN", "/tracers", a.printTracerResource)
	get.Example = "  yyt tracer get app-debug\n  yyt tracer get trc_01hf7yavygfgdxpjfmr5r0g6ca --json"
	get.Annotations = map[string]string{OutputAnnotation: tracerResourceOutput}
	del := newResourceDelete(a, id, "delete <res>", "Delete a tracer resource; tracer purges its data after 7 days (no backup)", "/tracers")
	del.Example = "  yyt tracer delete app-debug\n  yyt tracer rm trc_01hf7yavygfgdxpjfmr5r0g6ca --project game"
	del.Annotations = map[string]string{OutputAnnotation: "\"deleted <res>\" (the argument as given)"}
	update := newResourceUpdate(id, "update <res>", "Change a tracer resource's name and/or description (like `kv update`)", "new name (the id and DSN stay)", "/tracers", a.printTracerResource)
	update.Example = "  yyt tracer update app-debug --description \"android debug builds\"\n  yyt tracer update trc_01hf7yavygfgdxpjfmr5r0g6ca --name android-debug"
	update.Annotations = map[string]string{OutputAnnotation: tracerResourceOutput}
	return []*cobra.Command{
		newTracerList(a),
		newTracerCreate(a),
		get,
		newTracerRename(a, id),
		update,
		newTracerRotateKey(a, id),
		del,
		newTracerDSN(a, id),
	}
}

func newTracerList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:         "list",
		Aliases:     []string{"ls"},
		Short:       "List the tracer resources of the project in context",
		Example:     "  yyt tracer list\n  yyt tracer ls --team dooroo --project game --json",
		Annotations: map[string]string{OutputAnnotation: "table ID NAME DSN UPDATED (DSN `-` until the stage has a tracer, and always for a platform admin without a seat); --json: {tracers:[{id,name,writeKey,dsn,readUrl,…}]}"},
		Args:        cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if cmd.Flags().Changed("local") {
				return errors.New("--local reads a local tracer; resource management goes through the console")
			}
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), false)
			if err != nil {
				return err
			}
			var res struct {
				Tracers []tracerResource `json:"tracers"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/projects/"+api.PathID(r.ProjectID)+"/tracers", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Tracers))
			for _, t := range res.Tracers {
				rows = append(rows, cells(t.ID, t.Name, strOr(t.DSN, "-"), output.Time(t.UpdatedAt)))
			}
			return a.printer().Table([]string{"ID", "NAME", "DSN", "UPDATED"}, rows)
		},
	}
}

func newTracerCreate(a *App) *cobra.Command {
	var description string
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a tracer resource in the project context (explicit); prints its write key and DSN",
		Long: "Create a tracer resource: one collection of debug-build data with its own\n" +
			"write key. A project holds 5 by default (`yyt limit request tracer.resources`\n" +
			"for more). The DSN is printed once the stage has a tracer; `yyt tracer dsn`\n" +
			"prints it again for a build script.",
		Example:     "  yyt tracer create app-debug --team dooroo --project game\n  yyt tracer create app-debug --description \"android debug builds\" --json",
		Annotations: map[string]string{OutputAnnotation: tracerResourceOutput},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if cmd.Flags().Changed("local") {
				return errors.New("--local reads a local tracer; resource management goes through the console")
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
			if description != "" {
				body["description"] = description
			}
			var v tracerResource
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/tracers", body, &v); err != nil {
				return err
			}
			return a.printTracerResource(v)
		},
	}
	c.Flags().StringVar(&description, "description", "", "human-readable description")
	return c
}

func newTracerRename(a *App, id idResolver) *cobra.Command {
	var description string
	c := &cobra.Command{
		Use:   "rename <res> <new-name>",
		Short: "Rename a tracer resource (and optionally change its description); the id and DSN stay",
		Example: "  yyt tracer rename app-debug android-debug\n" +
			"  yyt tracer rename trc_01hf7yavygfgdxpjfmr5r0g6ca android-debug --description \"\"",
		Annotations: map[string]string{OutputAnnotation: tracerResourceOutput},
		Args:        cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"name": args[1]}
			nullableDesc(cmd, "description", description, body, "description")
			cc, res, err := id(cmd, args[0], true)
			if err != nil {
				return err
			}
			var v tracerResource
			if err := cc.cl.Do(cmd.Context(), http.MethodPatch, "/tracers/"+api.PathID(res), body, &v); err != nil {
				return err
			}
			return a.printTracerResource(v)
		},
	}
	c.Flags().StringVar(&description, "description", "", "new description (empty clears it)")
	return c
}

func newTracerRotateKey(a *App, id idResolver) *cobra.Command {
	return &cobra.Command{
		Use:         "rotate-key <res>",
		Aliases:     []string{"rotate"},
		Short:       "Replace the write key; builds with the old DSN stop being accepted (rebuild with `yyt tracer dsn`)",
		Example:     "  yyt tracer rotate-key app-debug\n  yyt tracer rotate trc_01hf7yavygfgdxpjfmr5r0g6ca --json",
		Annotations: map[string]string{OutputAnnotation: tracerResourceOutput},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, res, err := id(cmd, args[0], true)
			if err != nil {
				return err
			}
			var v tracerResource
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/tracers/"+api.PathID(res)+"/rotate-key", nil, &v); err != nil {
				return err
			}
			return a.printTracerResource(v)
		},
	}
}

func newTracerDSN(a *App, id idResolver) *cobra.Command {
	return &cobra.Command{
		Use:   "dsn <res>",
		Short: "Print only the DSN, for a build script (fails until the stage has a tracer)",
		Example: "  TRACER_DSN=\"$(yyt tracer dsn app-debug)\"\n" +
			"  yyt tracer dsn trc_01hf7yavygfgdxpjfmr5r0g6ca --profile dev",
		Annotations: map[string]string{OutputAnnotation: "the DSN on one line (https://<key>@<host>/<trc id>); --json: {dsn}"},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, res, err := id(cmd, args[0], false)
			if err != nil {
				return err
			}
			var v tracerResource
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/tracers/"+api.PathID(res), nil, &v); err != nil {
				return err
			}
			if v.WriteKey == nil {
				return errors.New("this resource's key is not shown to you (a platform admin without a seat in the team)")
			}
			dsn, err := checkedDSN(v)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]string{"dsn": dsn})
			}
			_, err = fmt.Fprintln(a.Out, dsn)
			return err
		},
	}
}
