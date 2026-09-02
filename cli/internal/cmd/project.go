package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/config"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/team.ts.
type projectVersion struct {
	ID        string  `json:"id"`
	ProjectID string  `json:"projectId"`
	Name      string  `json:"name"`
	Note      *string `json:"note"`
	CreatedBy *string `json:"createdBy"`
	CreatedAt int64   `json:"createdAt"`
	// Live link counts per kind (artifact retention cascades the link).
	ArtifactCount int           `json:"artifactCount"`
	AssetCount    int           `json:"assetCount"`
	Links         []versionLink `json:"links,omitempty"`
}

type versionLink struct {
	ID           string  `json:"id"`
	VersionID    string  `json:"versionId"`
	Kind         string  `json:"kind"`
	ArtifactID   *string `json:"artifactId"`
	BundleID     *string `json:"bundleId"`
	AssetVersion *string `json:"assetVersion"`
	CreatedAt    int64   `json:"createdAt"`
}

type issue struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Number    int       `json:"number"`
	Title     string    `json:"title"`
	BodyMd    string    `json:"bodyMd"`
	Status    string    `json:"status"`
	VersionID *string   `json:"versionId"`
	CreatedBy *string   `json:"createdBy"`
	CreatedAt int64     `json:"createdAt"`
	UpdatedAt int64     `json:"updatedAt"`
	ClosedAt  *int64    `json:"closedAt"`
	Comments  []comment `json:"comments,omitempty"`
}

func (a *App) printProject(p projectRow) error {
	if a.jsonOut {
		return a.printer().JSONValue(p)
	}
	pairs := [][2]string{
		{"id", p.ID}, {"name", p.Name}, {"team", p.TeamName + " (" + p.TeamID + ")"},
		{"description", output.Str(p.Description)}, {"createdBy", output.Str(p.CreatedBy)},
		{"created", output.Time(p.CreatedAt)}, {"updated", output.Time(p.UpdatedAt)},
	}
	if p.Counts != nil {
		pairs = append(pairs,
			[2]string{"channels", fmt.Sprint(p.Counts.Channels)},
			[2]string{"apps", fmt.Sprint(p.Counts.Apps)},
			[2]string{"bundles", fmt.Sprint(p.Counts.Bundles)},
			[2]string{"sites", fmt.Sprint(p.Counts.Sites)},
			[2]string{"versions", fmt.Sprint(p.Counts.Versions)},
			[2]string{"issues", fmt.Sprint(p.Counts.Issues)},
		)
	}
	return a.printer().KV(pairs)
}

func (a *App) printVersion(v projectVersion) error {
	if a.jsonOut {
		return a.printer().JSONValue(v)
	}
	if err := a.printer().KV([][2]string{
		{"id", v.ID}, {"name", v.Name}, {"note", output.Str(v.Note)},
		{"artifacts", strconv.Itoa(v.ArtifactCount)}, {"assets", strconv.Itoa(v.AssetCount)},
		{"createdBy", output.Str(v.CreatedBy)}, {"created", output.Time(v.CreatedAt)},
	}); err != nil {
		return err
	}
	if len(v.Links) == 0 {
		return nil
	}
	rows := make([][]string, 0, len(v.Links))
	for _, l := range v.Links {
		target := output.Str(l.ArtifactID)
		if l.Kind == "asset_version" {
			target = output.Str(l.BundleID) + "@" + output.Str(l.AssetVersion)
		}
		rows = append(rows, []string{l.ID, l.Kind, target, output.Time(l.CreatedAt)})
	}
	fmt.Fprintln(a.Out)
	return a.printer().Table([]string{"LINK", "KIND", "TARGET", "CREATED"}, rows)
}

func (a *App) printIssue(i issue) error {
	if a.jsonOut {
		return a.printer().JSONValue(i)
	}
	if err := a.printer().KV([][2]string{
		{"number", fmt.Sprint(i.Number)}, {"id", i.ID}, {"title", i.Title}, {"status", i.Status},
		{"version", output.Str(i.VersionID)}, {"by", output.Str(i.CreatedBy)},
		{"created", output.Time(i.CreatedAt)}, {"updated", output.Time(i.UpdatedAt)}, {"closed", output.TimePtr(i.ClosedAt)},
	}); err != nil {
		return err
	}
	if i.BodyMd != "" {
		fmt.Fprintln(a.Out)
		fmt.Fprintln(a.Out, output.Clean(i.BodyMd))
	}
	return a.printComments(i.Comments)
}

func newProject(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "project",
		Short: "Projects: the unit that owns channels, catalog apps, asset bundles, versions and issues",
		Long: "Projects: the unit that owns channels, catalog apps, asset bundles, versions and issues.\n\n" +
			"Commands that take [project] use the context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`) when it is omitted; a read command auto-selects the only\n" +
			"project of the only team, a write command never does.",
	}
	// projectOf resolves the optional positional project (id or name) or the context.
	projectOf := func(cmd *cobra.Command, args []string, write bool) (*ctxClient, resolved, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, resolved{}, err
		}
		if len(args) > 0 {
			cc.spec.Project, cc.spec.ProjectSource = args[0], "argument"
		}
		r, err := cc.project(cmd.Context(), write)
		return cc, r, err
	}

	c.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the projects of the team in context",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.team(cmd.Context(), false)
			if err != nil {
				return err
			}
			var res struct {
				Projects []projectRow `json:"projects"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/teams/"+api.PathID(r.TeamID)+"/projects", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Projects))
			for _, p := range res.Projects {
				rows = append(rows, []string{p.ID, p.Name, p.TeamName, output.Str(p.Description), output.Time(p.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "TEAM", "DESCRIPTION", "UPDATED"}, rows)
		},
	})
	{
		var description string
		create := &cobra.Command{
			Use:   "create <name>",
			Short: "Create a project in the team in context (explicit --team or `yyt team use`)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cc, err := a.ctxClient(cmd)
				if err != nil {
					return err
				}
				r, err := cc.team(cmd.Context(), true)
				if err != nil {
					return err
				}
				body := map[string]any{"name": args[0]}
				if description != "" {
					body["description"] = description
				}
				var p projectRow
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/teams/"+api.PathID(r.TeamID)+"/projects", body, &p); err != nil {
					return err
				}
				return a.printProject(p)
			},
		}
		create.Flags().StringVar(&description, "description", "", "markdown description")
		c.AddCommand(create)
	}
	c.AddCommand(&cobra.Command{
		Use:   "get [project]",
		Short: "Show a project with its resource counts",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, r, err := projectOf(cmd, args, false)
			if err != nil {
				return err
			}
			var p projectRow
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/projects/"+api.PathID(r.ProjectID), nil, &p); err != nil {
				return err
			}
			return a.printProject(p)
		},
	})
	{
		var name, description string
		update := &cobra.Command{
			Use:   "update [project] [--name n] [--description d]",
			Short: "Rename or describe a project; empty --description clears it",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]any{}
				if cmd.Flags().Changed("name") {
					body["name"] = name
				}
				nullableDesc(cmd, "description", description, body, "description")
				if len(body) == 0 {
					return errors.New("nothing to update: pass --name and/or --description")
				}
				cc, r, err := projectOf(cmd, args, true)
				if err != nil {
					return err
				}
				var p projectRow
				if err := cc.cl.Do(cmd.Context(), http.MethodPatch, "/projects/"+api.PathID(r.ProjectID), body, &p); err != nil {
					return err
				}
				return a.printProject(p)
			},
		}
		update.Flags().StringVar(&name, "name", "", "new name (unique within the team)")
		update.Flags().StringVar(&description, "description", "", "markdown description (empty clears)")
		c.AddCommand(update)
	}
	c.AddCommand(&cobra.Command{
		Use:     "delete [project]",
		Aliases: []string{"rm"},
		Short:   "Delete an empty project (owner or admin); channels, apps and bundles must go first",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, r, err := projectOf(cmd, args, true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, "/projects/"+api.PathID(r.ProjectID), nil, nil); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"id": r.ProjectID, "deleted": true})
			}
			fmt.Fprintf(a.Out, "deleted %s\n", r.ProjectName)
			return nil
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "use <project>",
		Short: "Store the project (by name or id) — and its team — as this profile's default context",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
			if err != nil {
				return err
			}
			if cfg.Profile == "" {
				return errors.New("no profile to store into (--token/YYT_TOKEN override the profile); run `yyt login` first")
			}
			// A name needs a team to resolve in; a read-style auto-select is fine
			// here because the result is then pinned explicitly.
			_, r, err := projectOf(cmd, args, false)
			if err != nil {
				return err
			}
			if err := config.SetContext(cfg.Profile, &r.TeamID, &r.ProjectID); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"profile": cfg.Profile, "team": r.TeamID, "teamName": r.TeamName, "project": r.ProjectID, "projectName": r.ProjectName})
			}
			fmt.Fprintf(a.Out, "profile %s now defaults to %s\n", cfg.Profile, r)
			return nil
		},
	})

	c.AddCommand(a.projectVersionCmd(projectOf), a.projectIssueCmd(projectOf))
	return group(c)
}

type projectResolver func(cmd *cobra.Command, args []string, write bool) (*ctxClient, resolved, error)

func (a *App) projectVersionCmd(projectOf projectResolver) *cobra.Command {
	c := &cobra.Command{Use: "version", Aliases: []string{"versions", "ver"}, Short: "Project versions and their links to artifacts / asset versions"}
	base := func(cmd *cobra.Command, write bool) (*ctxClient, resolved, string, error) {
		cc, r, err := projectOf(cmd, nil, write)
		if err != nil {
			return nil, resolved{}, "", err
		}
		return cc, r, "/projects/" + api.PathID(r.ProjectID) + "/versions", nil
	}
	// verPath resolves <version> (id or exact name) under the project.
	verPath := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, r, p, err := base(cmd, write)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.version(cmd.Context(), r.ProjectID, arg)
		if err != nil {
			return nil, "", err
		}
		return cc, p + "/" + api.PathID(id), nil
	}
	c.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List versions (newest first)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, _, p, err := base(cmd, false)
			if err != nil {
				return err
			}
			var res struct {
				Versions []projectVersion `json:"versions"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, p, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Versions))
			for _, v := range res.Versions {
				rows = append(rows, []string{v.ID, v.Name, output.Str(v.Note), strconv.Itoa(v.ArtifactCount), strconv.Itoa(v.AssetCount), output.Str(v.CreatedBy), output.Time(v.CreatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "NOTE", "ARTIFACTS", "ASSETS", "BY", "CREATED"}, rows)
		},
	})
	{
		var note string
		create := &cobra.Command{
			Use:   "create <name> [--note md|@file]",
			Short: "Create a version (any name; `bump` needs semver)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]any{"name": args[0]}
				if cmd.Flags().Changed("note") {
					md, err := readBody(note)
					if err != nil {
						return err
					}
					body["note"] = md
				}
				cc, _, p, err := base(cmd, true)
				if err != nil {
					return err
				}
				var v projectVersion
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, p, body, &v); err != nil {
					return err
				}
				return a.printVersion(v)
			},
		}
		create.Flags().StringVar(&note, "note", "", "markdown note, or @file")
		c.AddCommand(create)
	}
	c.AddCommand(&cobra.Command{
		Use:   "bump [patch|minor|major]",
		Short: "Create the next semver version after the latest one (default patch)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			part := "patch"
			if len(args) == 1 {
				part = args[0]
			}
			if part != "patch" && part != "minor" && part != "major" {
				return fmt.Errorf("part must be patch|minor|major (got %q)", part)
			}
			cc, _, p, err := base(cmd, true)
			if err != nil {
				return err
			}
			var v projectVersion
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, p+"/bump", map[string]any{"part": part}, &v); err != nil {
				return err
			}
			return a.printVersion(v)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "get <version>",
		Short: "Show a version with its links",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, p, err := verPath(cmd, args[0], false)
			if err != nil {
				return err
			}
			var v projectVersion
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, p, nil, &v); err != nil {
				return err
			}
			return a.printVersion(v)
		},
	})
	{
		var note string
		update := &cobra.Command{
			Use:   "update <version> --note <md|@file>",
			Short: "Replace the note (empty clears it)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := readBody(note)
				if err != nil {
					return err
				}
				cc, p, err := verPath(cmd, args[0], true)
				if err != nil {
					return err
				}
				var v projectVersion
				if err := cc.cl.Do(cmd.Context(), http.MethodPatch, p, map[string]any{"note": nullable(md)}, &v); err != nil {
					return err
				}
				return a.printVersion(v)
			},
		}
		update.Flags().StringVar(&note, "note", "", "markdown note, or @file (empty clears)")
		_ = update.MarkFlagRequired("note")
		c.AddCommand(update)
	}
	c.AddCommand(&cobra.Command{
		Use:     "delete <version>",
		Aliases: []string{"rm"},
		Short:   "Delete a version and its links (issues keep no reference)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, p, err := verPath(cmd, args[0], true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, p, nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[0])
			return nil
		},
	})
	{
		var artifact, bundle, assetVersion string
		link := &cobra.Command{
			Use:   "link <version> (--artifact <artifact-id> | --bundle <bundle> --asset-version <v>)",
			Short: "Link a catalog artifact or an asset bundle version to this version",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				var body map[string]any
				switch {
				case artifact != "" && bundle == "" && assetVersion == "":
					body = map[string]any{"kind": "artifact", "artifactId": artifact}
				case artifact == "" && bundle != "" && assetVersion != "":
					body = map[string]any{"kind": "asset_version", "assetVersion": assetVersion}
				default:
					return errors.New("pass either --artifact <id>, or --bundle <id|name> with --asset-version <v>")
				}
				cc, p, err := verPath(cmd, args[0], true)
				if err != nil {
					return err
				}
				if bundle != "" {
					id, err := cc.bundle(cmd.Context(), bundle, true)
					if err != nil {
						return err
					}
					body["bundleId"] = id
				}
				var l versionLink
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, p+"/links", body, &l); err != nil {
					return err
				}
				if a.jsonOut {
					return a.printer().JSONValue(l)
				}
				fmt.Fprintf(a.Out, "linked %s\n", l.ID)
				return nil
			},
		}
		link.Flags().StringVar(&artifact, "artifact", "", "catalog artifact id (art_…)")
		link.Flags().StringVar(&bundle, "bundle", "", "asset bundle id or name")
		link.Flags().StringVar(&assetVersion, "asset-version", "", "asset bundle version")
		c.AddCommand(link)
	}
	c.AddCommand(&cobra.Command{
		Use:   "unlink <version> <link-id>",
		Short: "Remove a link",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, p, err := verPath(cmd, args[0], true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, p+"/links/"+api.PathID(args[1]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "unlinked %s\n", args[1])
			return nil
		},
	})
	return group(c)
}

func (a *App) projectIssueCmd(projectOf projectResolver) *cobra.Command {
	c := &cobra.Command{Use: "issue", Aliases: []string{"issues"}, Short: "Project issues (per-project numbers) and their comments"}
	base := func(cmd *cobra.Command, write bool) (*ctxClient, resolved, string, error) {
		cc, r, err := projectOf(cmd, nil, write)
		if err != nil {
			return nil, resolved{}, "", err
		}
		return cc, r, "/projects/" + api.PathID(r.ProjectID) + "/issues", nil
	}
	issuePath := func(cmd *cobra.Command, n string, write bool) (*ctxClient, resolved, string, error) {
		if _, err := strconv.Atoi(n); err != nil {
			return nil, resolved{}, "", fmt.Errorf("issue number must be an integer (got %q)", n)
		}
		cc, r, p, err := base(cmd, write)
		if err != nil {
			return nil, resolved{}, "", err
		}
		return cc, r, p + "/" + n, nil
	}
	{
		var status string
		list := &cobra.Command{
			Use:     "list [--status open|closed]",
			Aliases: []string{"ls"},
			Short:   "List issues (open ones by default)",
			Args:    cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				cc, _, p, err := base(cmd, false)
				if err != nil {
					return err
				}
				if status != "" {
					p += "?status=" + url.QueryEscape(status)
				}
				var res struct {
					Issues []issue `json:"issues"`
				}
				if err := cc.cl.Do(cmd.Context(), http.MethodGet, p, nil, &res); err != nil {
					return err
				}
				if a.jsonOut {
					return a.printer().JSONValue(res)
				}
				rows := make([][]string, 0, len(res.Issues))
				for _, i := range res.Issues {
					rows = append(rows, []string{fmt.Sprint(i.Number), i.Status, i.Title, output.Str(i.VersionID), output.Str(i.CreatedBy), output.Time(i.UpdatedAt)})
				}
				return a.printer().Table([]string{"#", "STATUS", "TITLE", "VERSION", "BY", "UPDATED"}, rows)
			},
		}
		list.Flags().StringVar(&status, "status", "", "open|closed (server default: open)")
		c.AddCommand(list)
	}
	{
		var body, version string
		create := &cobra.Command{
			Use:   "create <title> [--body md|@file] [--version <id|name>]",
			Long:  "Open an issue. --version takes a version id or name; a name the project does not have yet is created.",
			Short: "Open an issue",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := readBody(body)
				if err != nil {
					return err
				}
				cc, r, p, err := base(cmd, true)
				if err != nil {
					return err
				}
				in := map[string]any{"title": args[0], "bodyMd": md}
				if version != "" {
					id, name, created, err := cc.ensureVersion(cmd.Context(), r.ProjectID, version)
					if err != nil {
						return err
					}
					if created {
						fmt.Fprintf(a.Err, "created version %s (%s)\n", name, id)
					}
					in["versionId"] = id
				}
				var i issue
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, p, in, &i); err != nil {
					return err
				}
				return a.printIssue(i)
			},
		}
		create.Flags().StringVar(&body, "body", "", "markdown body, or @file")
		create.Flags().StringVar(&version, "version", "", "project version to attach (id or name; a missing name is created)")
		c.AddCommand(create)
	}
	c.AddCommand(&cobra.Command{
		Use:   "get <number>",
		Short: "Show an issue with its comments",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, _, p, err := issuePath(cmd, args[0], false)
			if err != nil {
				return err
			}
			var i issue
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, p, nil, &i); err != nil {
				return err
			}
			return a.printIssue(i)
		},
	})
	{
		var title, body, version string
		var noVersion bool
		update := &cobra.Command{
			Use:   "update <number> [--title t] [--body md|@file] [--version v | --no-version]",
			Short: "Edit an issue (any member)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				patch := map[string]any{}
				if cmd.Flags().Changed("title") {
					patch["title"] = title
				}
				if cmd.Flags().Changed("body") {
					md, err := readBody(body)
					if err != nil {
						return err
					}
					patch["bodyMd"] = md
				}
				if noVersion && version != "" {
					return errors.New("--version and --no-version are contradictory")
				}
				if noVersion {
					patch["versionId"] = nil
				}
				if len(patch) == 0 && version == "" {
					return errors.New("nothing to update: pass --title, --body, --version or --no-version")
				}
				cc, r, p, err := issuePath(cmd, args[0], true)
				if err != nil {
					return err
				}
				if version != "" {
					id, name, created, err := cc.ensureVersion(cmd.Context(), r.ProjectID, version)
					if err != nil {
						return err
					}
					if created {
						fmt.Fprintf(a.Err, "created version %s (%s)\n", name, id)
					}
					patch["versionId"] = id
				}
				var i issue
				if err := cc.cl.Do(cmd.Context(), http.MethodPatch, p, patch, &i); err != nil {
					return err
				}
				return a.printIssue(i)
			},
		}
		update.Flags().StringVar(&title, "title", "", "new title")
		update.Flags().StringVar(&body, "body", "", "markdown body, or @file")
		update.Flags().StringVar(&version, "version", "", "project version to attach (id or name; a missing name is created)")
		update.Flags().BoolVar(&noVersion, "no-version", false, "detach the version")
		c.AddCommand(update)
	}
	transition := func(action, short string) *cobra.Command {
		return &cobra.Command{
			Use:   action + " <number>",
			Short: short,
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cc, _, p, err := issuePath(cmd, args[0], true)
				if err != nil {
					return err
				}
				var i issue
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, p+"/"+action, map[string]any{}, &i); err != nil {
					return err
				}
				return a.printIssue(i)
			},
		}
	}
	c.AddCommand(transition("close", "Close an issue (issues are never deleted)"), transition("reopen", "Reopen a closed issue"))
	c.AddCommand(a.commentCmd("issue", func(cmd *cobra.Command, parent string) (*ctxClient, string, error) {
		cc, _, p, err := issuePath(cmd, parent, true)
		if err != nil {
			return nil, "", err
		}
		return cc, p + "/comments", nil
	}))
	return group(c)
}
