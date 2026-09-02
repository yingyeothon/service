package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/config"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/team.ts (teamRow/projectRow: context.go).
type teamMember struct {
	ID           string  `json:"id"`
	Login        *string `json:"login"`
	PlatformRole *string `json:"platformRole"`
	Role         string  `json:"role"`
	State        string  `json:"state"`
	RequestedAt  int64   `json:"requestedAt"`
	DecidedAt    *int64  `json:"decidedAt"`
	DecidedBy    *string `json:"decidedBy"`
}

type rotationHint struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type removeMemberResult struct {
	Removed string         `json:"removed"`
	Action  string         `json:"action"`
	Rotate  []rotationHint `json:"rotate"`
}

type historyEntry struct {
	ID      string         `json:"id"`
	At      int64          `json:"at"`
	Actor   *string        `json:"actor"`
	Action  string         `json:"action"`
	Subject *string        `json:"subject"`
	Target  *string        `json:"target"`
	Detail  map[string]any `json:"detail"`
}

type comment struct {
	ID        string  `json:"id"`
	BodyMd    string  `json:"bodyMd"`
	CreatedBy *string `json:"createdBy"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
	Mine      bool    `json:"mine"`
}

type discussion struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"teamId"`
	Title     string    `json:"title"`
	BodyMd    string    `json:"bodyMd"`
	CreatedBy *string   `json:"createdBy"`
	CreatedAt int64     `json:"createdAt"`
	UpdatedAt int64     `json:"updatedAt"`
	Mine      bool      `json:"mine"`
	Comments  []comment `json:"comments,omitempty"`
}

// commentPairs renders a comment thread as `comment <id>: by time: body` rows.
func commentPairs(cms []comment) [][2]string {
	pairs := make([][2]string, 0, len(cms))
	for _, cm := range cms {
		pairs = append(pairs, [2]string{"comment " + cm.ID, output.Str(cm.CreatedBy) + " " + output.Time(cm.CreatedAt) + ": " + cm.BodyMd})
	}
	return pairs
}

// readBody returns a markdown body given inline or as @file.
func readBody(s string) (string, error) {
	if strings.HasPrefix(s, "@") {
		b, err := os.ReadFile(s[1:])
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	return s, nil
}

// nullableDesc maps an explicit empty --description to JSON null (clear).
func nullableDesc(cmd *cobra.Command, flag, val string, body map[string]any, key string) {
	if !cmd.Flags().Changed(flag) {
		return
	}
	body[key] = nullable(val)
}

func (a *App) printTeam(t teamRow) error {
	if a.jsonOut {
		return a.printer().JSONValue(t)
	}
	pairs := [][2]string{
		{"id", t.ID}, {"name", t.Name}, {"role", t.Role},
	}
	if t.Role != "pending" {
		pairs = append(pairs,
			[2]string{"description", output.Str(t.Description)},
			[2]string{"adminLocked", fmt.Sprint(t.AdminLocked)},
			[2]string{"createdBy", output.Str(t.CreatedBy)},
			[2]string{"created", output.Time(t.CreatedAt)},
			[2]string{"updated", output.Time(t.UpdatedAt)},
		)
	}
	if t.Counts != nil {
		pairs = append(pairs,
			[2]string{"owners", fmt.Sprint(t.Counts.Owners)},
			[2]string{"members", fmt.Sprint(t.Counts.Members)},
			[2]string{"pending", fmt.Sprint(t.Counts.Pending)},
			[2]string{"projects", fmt.Sprint(t.Counts.Projects)},
		)
	}
	return a.printer().KV(pairs)
}

func (a *App) printMembers(ms []teamMember) error {
	if a.jsonOut {
		return a.printer().JSONValue(map[string]any{"members": ms})
	}
	rows := make([][]string, 0, len(ms))
	for _, m := range ms {
		rows = append(rows, []string{m.ID, output.Str(m.Login), m.Role, m.State, output.Time(m.RequestedAt), output.Str(m.DecidedBy)})
	}
	return a.printer().Table([]string{"ID", "LOGIN", "ROLE", "STATE", "REQUESTED", "DECIDED BY"}, rows)
}

func (a *App) printMember(m teamMember) error {
	if a.jsonOut {
		return a.printer().JSONValue(m)
	}
	return a.printer().KV([][2]string{
		{"id", m.ID}, {"login", output.Str(m.Login)}, {"role", m.Role}, {"state", m.State},
		{"requested", output.Time(m.RequestedAt)}, {"decided", output.TimePtr(m.DecidedAt)}, {"decidedBy", output.Str(m.DecidedBy)},
	})
}

// printRotation is the kick/leave nudge: nothing is revoked (a rotation
// mid-game kills it), so the operator gets the list and decides.
func (a *App) printRotation(res *removeMemberResult) {
	if res == nil || len(res.Rotate) == 0 {
		return
	}
	fmt.Fprintf(a.Err, "the departed member still knows the credentials of %d channel(s); rotate them (`yyt channels rotate-secret` / `redis-user issue` / `doc-key issue`):\n", len(res.Rotate))
	for _, r := range res.Rotate {
		fmt.Fprintf(a.Err, "  %s  %s  %s\n", output.Clean(r.ID), output.Clean(r.Kind), output.Clean(r.Name))
	}
}

func (a *App) printDiscussion(d discussion) error {
	if a.jsonOut {
		return a.printer().JSONValue(d)
	}
	if err := a.printer().KV([][2]string{
		{"id", d.ID}, {"title", d.Title}, {"by", output.Str(d.CreatedBy)},
		{"created", output.Time(d.CreatedAt)}, {"updated", output.Time(d.UpdatedAt)},
	}); err != nil {
		return err
	}
	fmt.Fprintln(a.Out)
	fmt.Fprintln(a.Out, output.Clean(d.BodyMd))
	return a.printComments(d.Comments)
}

func (a *App) printComments(cs []comment) error {
	for _, c := range cs {
		fmt.Fprintf(a.Out, "\n--- %s  %s  %s\n%s\n", output.Clean(c.ID), output.Clean(output.Str(c.CreatedBy)), output.Time(c.CreatedAt), output.Clean(c.BodyMd))
	}
	return nil
}

func (a *App) printComment(c comment) error {
	if a.jsonOut {
		return a.printer().JSONValue(c)
	}
	return a.printer().KV([][2]string{
		{"id", c.ID}, {"by", output.Str(c.CreatedBy)}, {"created", output.Time(c.CreatedAt)}, {"body", c.BodyMd},
	})
}

func newTeam(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "team",
		Short: "Teams: the membership that grants access to every project inside",
		Long: "Teams: the membership that grants access to every project inside.\n\n" +
			"Commands that take [team] use the context (--team, YYT_TEAM, " + ContextFile + ",\n" +
			"`yyt team use`) when it is omitted; there is no global team listing —\n" +
			"join by exact name, or an owner adds your GitHub login.",
	}
	// teamOf resolves the optional positional team (id or name) or the context.
	teamOf := func(cmd *cobra.Command, args []string, write bool) (*ctxClient, resolved, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, resolved{}, err
		}
		if len(args) > 0 {
			cc.spec.Team, cc.spec.TeamSource = args[0], "argument"
		}
		r, err := cc.team(cmd.Context(), write)
		return cc, r, err
	}

	var scope string
	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the teams you sit in or asked to join (admins: --scope all)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			q := ""
			if scope != "" {
				q = "?scope=" + url.QueryEscape(scope)
			}
			var res struct {
				Teams []teamRow `json:"teams"`
			}
			if err := cl.Do(cmd.Context(), http.MethodGet, "/teams"+q, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Teams))
			for _, t := range res.Teams {
				rows = append(rows, []string{t.ID, t.Name, t.Role, output.Str(t.Description)})
			}
			return a.printer().Table([]string{"ID", "NAME", "ROLE", "DESCRIPTION"}, rows)
		},
	}
	list.Flags().StringVar(&scope, "scope", "", "mine (default) | all (admin)")
	c.AddCommand(list)

	{
		var description string
		create := &cobra.Command{
			Use:   "create <name>",
			Short: "Create a team (you become its owner)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cl, err := a.client()
				if err != nil {
					return err
				}
				body := map[string]any{"name": args[0]}
				if description != "" {
					body["description"] = description
				}
				var t teamRow
				if err := cl.Do(cmd.Context(), http.MethodPost, "/teams", body, &t); err != nil {
					return err
				}
				return a.printTeam(t)
			},
		}
		create.Flags().StringVar(&description, "description", "", "markdown description")
		c.AddCommand(create)
	}
	c.AddCommand(&cobra.Command{
		Use:   "join <name>",
		Short: "Ask to join a team by its exact name (an owner approves)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var t teamRow
			if err := cl.Do(cmd.Context(), http.MethodPost, "/teams/join", map[string]any{"name": args[0]}, &t); err != nil {
				return err
			}
			fmt.Fprintln(a.Err, "requested; an owner approves with `yyt team members approve <your member id>`")
			return a.printTeam(t)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "get [team]",
		Short: "Show a team with its member and project counts",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, r, err := teamOf(cmd, args, false)
			if err != nil {
				return err
			}
			var t teamRow
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/teams/"+api.PathID(r.TeamID), nil, &t); err != nil {
				return err
			}
			return a.printTeam(t)
		},
	})
	{
		var name, description string
		update := &cobra.Command{
			Use:   "update [team] [--name n] [--description d]",
			Short: "Rename or describe a team (owner); empty --description clears it",
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
				cc, r, err := teamOf(cmd, args, true)
				if err != nil {
					return err
				}
				var t teamRow
				if err := cc.cl.Do(cmd.Context(), http.MethodPatch, "/teams/"+api.PathID(r.TeamID), body, &t); err != nil {
					return err
				}
				return a.printTeam(t)
			},
		}
		update.Flags().StringVar(&name, "name", "", "new name (globally unique)")
		update.Flags().StringVar(&description, "description", "", "markdown description (empty clears)")
		c.AddCommand(update)
	}
	c.AddCommand(&cobra.Command{
		Use:     "delete [team]",
		Aliases: []string{"rm"},
		Short:   "Delete an empty team (owner or admin); projects must be deleted first",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, r, err := teamOf(cmd, args, true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, "/teams/"+api.PathID(r.TeamID), nil, nil); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"id": r.TeamID, "deleted": true})
			}
			fmt.Fprintf(a.Out, "deleted %s\n", r.TeamName)
			return nil
		},
	})
	{
		var locked bool
		lock := &cobra.Command{
			Use:   "admin-lock [team] --locked=true|false",
			Short: "Admin: lock the team so only platform admins may change it (installer trust)",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				if !cmd.Flags().Changed("locked") {
					return errors.New("--locked=true|false is required")
				}
				cc, r, err := teamOf(cmd, args, true)
				if err != nil {
					return err
				}
				var t teamRow
				if err := cc.cl.Do(cmd.Context(), http.MethodPut, "/teams/"+api.PathID(r.TeamID)+"/admin-lock", map[string]any{"locked": locked}, &t); err != nil {
					return err
				}
				return a.printTeam(t)
			},
		}
		lock.Flags().BoolVar(&locked, "locked", false, "lock (true) or unlock (false)")
		c.AddCommand(lock)
	}
	c.AddCommand(&cobra.Command{
		Use:   "use <team>",
		Short: "Store the team (by name or id) as this profile's default context; clears the default project",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
			if err != nil {
				return err
			}
			if cfg.Profile == "" {
				return errors.New("no profile to store into (--token/YYT_TOKEN override the profile); run `yyt login` first")
			}
			cc.spec.Team, cc.spec.TeamSource = args[0], "argument"
			r, err := cc.team(cmd.Context(), true)
			if err != nil {
				return err
			}
			if err := config.SetContext(cfg.Profile, &r.TeamID, nil); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"profile": cfg.Profile, "team": r.TeamID, "teamName": r.TeamName})
			}
			fmt.Fprintf(a.Out, "profile %s now defaults to team %s (%s)\n", cfg.Profile, r.TeamName, r.TeamID)
			return nil
		},
	})
	{
		var limit int
		var cursor string
		hist := &cobra.Command{
			Use:   "history [team]",
			Short: "Show the team's append-only history (newest first)",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cc, r, err := teamOf(cmd, args, false)
				if err != nil {
					return err
				}
				qv := url.Values{}
				if limit > 0 {
					qv.Set("limit", fmt.Sprint(limit))
				}
				if cursor != "" {
					qv.Set("cursor", cursor)
				}
				q := ""
				if len(qv) > 0 {
					q = "?" + qv.Encode()
				}
				var res struct {
					History []historyEntry `json:"history"`
					Next    *string        `json:"next"`
				}
				if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/teams/"+api.PathID(r.TeamID)+"/history"+q, nil, &res); err != nil {
					return err
				}
				if a.jsonOut {
					return a.printer().JSONValue(res)
				}
				rows := make([][]string, 0, len(res.History))
				for _, h := range res.History {
					rows = append(rows, []string{output.Time(h.At), output.Str(h.Actor), h.Action, output.Str(h.Subject), output.Str(h.Target)})
				}
				if err := a.printer().Table([]string{"AT", "ACTOR", "ACTION", "SUBJECT", "TARGET"}, rows); err != nil {
					return err
				}
				if res.Next != nil && *res.Next != "" {
					fmt.Fprintf(a.Err, "more: --cursor %s\n", *res.Next)
				}
				return nil
			},
		}
		hist.Flags().IntVar(&limit, "limit", 0, "page size")
		hist.Flags().StringVar(&cursor, "cursor", "", "continue from a previous page")
		c.AddCommand(hist)
	}

	c.AddCommand(a.teamMembersCmd(teamOf), a.teamDiscussionCmd(teamOf))
	return group(c)
}

type teamResolver func(cmd *cobra.Command, args []string, write bool) (*ctxClient, resolved, error)

// teamMembersCmd: seats are addressed by member id (`yyt team members ls`).
// The team comes from the context; `--team` names another one.
func (a *App) teamMembersCmd(teamOf teamResolver) *cobra.Command {
	c := &cobra.Command{Use: "members", Short: "Team seats: list, add by login, approve/promote/demote/kick, leave"}
	c.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List seats (pending requests included, for owners)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, r, err := teamOf(cmd, nil, false)
			if err != nil {
				return err
			}
			var res struct {
				Members []teamMember `json:"members"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/teams/"+api.PathID(r.TeamID)+"/members", nil, &res); err != nil {
				return err
			}
			return a.printMembers(res.Members)
		},
	})
	{
		var role string
		add := &cobra.Command{
			Use:   "add <github-login>",
			Short: "Seat a platform member immediately (owner); --role owner|member",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				if role != "owner" && role != "member" {
					return fmt.Errorf("--role must be owner|member (got %q)", role)
				}
				cc, r, err := teamOf(cmd, nil, true)
				if err != nil {
					return err
				}
				var m teamMember
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/teams/"+api.PathID(r.TeamID)+"/members",
					map[string]any{"login": args[0], "role": role}, &m); err != nil {
					return err
				}
				return a.printMember(m)
			},
		}
		add.Flags().StringVar(&role, "role", "member", "owner|member")
		c.AddCommand(add)
	}
	setRole := func(use, short, role string) *cobra.Command {
		return &cobra.Command{
			Use:   use + " <member-id>",
			Short: short,
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cc, r, err := teamOf(cmd, nil, true)
				if err != nil {
					return err
				}
				var m teamMember
				if err := cc.cl.Do(cmd.Context(), http.MethodPatch,
					"/teams/"+api.PathID(r.TeamID)+"/members/"+api.PathID(args[0]), map[string]any{"role": role}, &m); err != nil {
					return err
				}
				return a.printMember(m)
			},
		}
	}
	c.AddCommand(
		setRole("approve", "Approve a pending request as a member (owner)", "member"),
		setRole("promote", "Make a member an owner (owner; a seatless admin may appoint any platform member, themselves included)", "owner"),
		setRole("demote", "Make an owner a member (owner; the last owner cannot be demoted)", "member"),
	)
	remove := func(use, short string, self bool) *cobra.Command {
		args := cobra.ExactArgs(1)
		if self {
			args = cobra.NoArgs
		}
		return &cobra.Command{
			Use:   use,
			Short: short,
			Args:  args,
			RunE: func(cmd *cobra.Command, argv []string) error {
				cc, r, err := teamOf(cmd, nil, true)
				if err != nil {
					return err
				}
				mid := ""
				if self {
					var me struct {
						ID string `json:"id"`
					}
					if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/me", nil, &me); err != nil {
						return err
					}
					mid = me.ID
				} else {
					mid = argv[0]
				}
				var res removeMemberResult
				if err := cc.cl.Do(cmd.Context(), http.MethodDelete,
					"/teams/"+api.PathID(r.TeamID)+"/members/"+api.PathID(mid), nil, &res); err != nil {
					return err
				}
				if a.jsonOut {
					if res.Removed == "" {
						return a.printer().JSONValue(map[string]any{"removed": mid, "action": "declined"})
					}
					return a.printer().JSONValue(res)
				}
				if res.Removed == "" {
					fmt.Fprintf(a.Out, "declined %s\n", mid)
					return nil
				}
				fmt.Fprintf(a.Out, "%s %s\n", res.Action, res.Removed)
				a.printRotation(&res)
				return nil
			},
		}
	}
	c.AddCommand(
		remove("kick <member-id>", "Remove a seat, or decline a pending request (owner); lists credentials to rotate", false),
		remove("leave", "Give up your own seat, or withdraw your pending request", true),
	)
	return group(c)
}

func (a *App) teamDiscussionCmd(teamOf teamResolver) *cobra.Command {
	c := &cobra.Command{Use: "discussion", Aliases: []string{"discussions", "dsc"}, Short: "Team discussions (markdown) and their comments"}
	base := func(cmd *cobra.Command, write bool) (*ctxClient, string, error) {
		cc, r, err := teamOf(cmd, nil, write)
		if err != nil {
			return nil, "", err
		}
		return cc, "/teams/" + api.PathID(r.TeamID) + "/discussions", nil
	}
	c.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List discussions (newest first)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, p, err := base(cmd, false)
			if err != nil {
				return err
			}
			var res struct {
				Discussions []discussion `json:"discussions"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, p, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Discussions))
			for _, d := range res.Discussions {
				rows = append(rows, []string{d.ID, d.Title, output.Str(d.CreatedBy), output.Time(d.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "TITLE", "BY", "UPDATED"}, rows)
		},
	})
	{
		var body string
		create := &cobra.Command{
			Use:   "create <title> --body <md|@file>",
			Short: "Open a discussion",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := readBody(body)
				if err != nil {
					return err
				}
				cc, p, err := base(cmd, true)
				if err != nil {
					return err
				}
				var d discussion
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, p, map[string]any{"title": args[0], "bodyMd": md}, &d); err != nil {
					return err
				}
				return a.printDiscussion(d)
			},
		}
		create.Flags().StringVar(&body, "body", "", "markdown body, or @file")
		_ = create.MarkFlagRequired("body")
		c.AddCommand(create)
	}
	c.AddCommand(&cobra.Command{
		Use:   "get <id>",
		Short: "Show a discussion with its comments",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, p, err := base(cmd, false)
			if err != nil {
				return err
			}
			var d discussion
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, p+"/"+api.PathID(args[0]), nil, &d); err != nil {
				return err
			}
			return a.printDiscussion(d)
		},
	})
	{
		var title, body string
		update := &cobra.Command{
			Use:   "update <id> [--title t] [--body md|@file]",
			Short: "Edit your discussion",
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
				if len(patch) == 0 {
					return errors.New("nothing to update: pass --title and/or --body")
				}
				cc, p, err := base(cmd, true)
				if err != nil {
					return err
				}
				var d discussion
				if err := cc.cl.Do(cmd.Context(), http.MethodPatch, p+"/"+api.PathID(args[0]), patch, &d); err != nil {
					return err
				}
				return a.printDiscussion(d)
			},
		}
		update.Flags().StringVar(&title, "title", "", "new title")
		update.Flags().StringVar(&body, "body", "", "markdown body, or @file")
		c.AddCommand(update)
	}
	c.AddCommand(&cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete a discussion (author or owner)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, p, err := base(cmd, true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, p+"/"+api.PathID(args[0]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[0])
			return nil
		},
	})
	c.AddCommand(a.commentCmd("discussion", func(cmd *cobra.Command, parent string) (*ctxClient, string, error) {
		cc, p, err := base(cmd, true)
		if err != nil {
			return nil, "", err
		}
		return cc, p + "/" + api.PathID(parent) + "/comments", nil
	}))
	return group(c)
}

// commentCmd is shared by discussions and issues: `comment add|update|rm`.
func (a *App) commentCmd(parentKind string, parentPath func(cmd *cobra.Command, parent string) (*ctxClient, string, error)) *cobra.Command {
	c := &cobra.Command{Use: "comment", Aliases: []string{"comments"}, Short: "Comments on a " + parentKind}
	// withBody is `<verb> <parent> [...] --body`: read the markdown first (a
	// bad @file must not cost a request), then resolve, then send it.
	withBody := func(use, short string, nargs int, method string, path func(p string, args []string) string) *cobra.Command {
		var body string
		cmd := &cobra.Command{
			Use:   use,
			Short: short,
			Args:  cobra.ExactArgs(nargs),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := readBody(body)
				if err != nil {
					return err
				}
				cc, p, err := parentPath(cmd, args[0])
				if err != nil {
					return err
				}
				var cm comment
				if err := cc.cl.Do(cmd.Context(), method, path(p, args), map[string]any{"bodyMd": md}, &cm); err != nil {
					return err
				}
				return a.printComment(cm)
			},
		}
		cmd.Flags().StringVar(&body, "body", "", "markdown body, or @file")
		_ = cmd.MarkFlagRequired("body")
		return cmd
	}
	c.AddCommand(withBody("add <"+parentKind+"> --body <md|@file>", "Add a comment", 1, http.MethodPost,
		func(p string, _ []string) string { return p }))
	c.AddCommand(withBody("update <"+parentKind+"> <comment-id> --body <md|@file>", "Edit your comment", 2, http.MethodPatch,
		func(p string, args []string) string { return p + "/" + api.PathID(args[1]) }))
	c.AddCommand(&cobra.Command{
		Use:     "delete <" + parentKind + "> <comment-id>",
		Aliases: []string{"rm"},
		Short:   "Delete a comment (author or owner)",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, p, err := parentPath(cmd, args[0])
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, p+"/"+api.PathID(args[1]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[1])
			return nil
		},
	})
	return group(c)
}
