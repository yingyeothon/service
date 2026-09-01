package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/shows.ts.
type showSummary struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	ACL       string  `json:"acl"`
	EventID   *string `json:"eventId"`
	CreatedBy *string `json:"createdBy"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
	ClosedAt  *int64  `json:"closedAt"`
}

type showGrant struct {
	Login     *string `json:"login"`
	GrantedBy *string `json:"grantedBy"`
	GrantedAt int64   `json:"grantedAt"`
}

type showDetail struct {
	showSummary
	BodyMd     string  `json:"bodyMd"`
	ClosedBy   *string `json:"closedBy"`
	EntryCount int     `json:"entryCount"`
	CanWrite   bool    `json:"canWrite"`
	CanManage  bool    `json:"canManage"`
	// Owner and admins only, and an empty list is not the same as absent.
	Grants []showGrant `json:"grants"`
}

type showTarget struct {
	Kind      string  `json:"kind"`
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Ref       *string `json:"ref"`
	Available bool    `json:"available"`
	URL       *string `json:"url"`
}

type showShot struct {
	ID          string `json:"id"`
	ContentType string `json:"contentType"`
	Size        int    `json:"size"`
	URL         string `json:"url"`
}

type showComment struct {
	ID        string  `json:"id"`
	BodyMd    string  `json:"bodyMd"`
	CreatedBy *string `json:"createdBy"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
	Mine      bool    `json:"mine"`
}

type showEntry struct {
	ID           string     `json:"id"`
	ShowID       string     `json:"showId"`
	Title        string     `json:"title"`
	BodyMd       string     `json:"bodyMd"`
	CreatedBy    *string    `json:"createdBy"`
	CreatedAt    int64      `json:"createdAt"`
	UpdatedAt    int64      `json:"updatedAt"`
	Target       showTarget `json:"target"`
	Shots        []showShot `json:"shots"`
	Likes        int        `json:"likes"`
	CommentCount int        `json:"commentCount"`
	Liked        bool       `json:"liked"`
	// Only on the detail route.
	// No `omitempty` on these: `false` is the answer a closed show gives, and
	// a missing key would read as "the route did not say".
	Comments    []showComment `json:"comments"`
	CanWrite    bool          `json:"canWrite"`
	CanEdit     bool          `json:"canEdit"`
	CanModerate bool          `json:"canModerate"`
	CanReact    bool          `json:"canReact"`
}

type shotGrant struct {
	ID      string            `json:"id"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

// screenshotsMax mirrors the API's cap so a mistyped command fails before
// anything is uploaded.
const screenshotsMax = 3

// moreHint tells a table run how to reach the next page. Without it `--cursor`
// advertises paging the caller has no way to perform (`yyt team history` sets
// the precedent).
func moreHint(a *App, next *string) error {
	if next == nil || *next == "" {
		return nil
	}
	_, err := fmt.Fprintf(a.Err, "more: --cursor %s\n", *next)
	return err
}

// reportDone prints a mutation's confirmation, as JSON when `--json` is set.
// `output.Printer.KV` does not consult the flag, so every mutating command in
// this family would otherwise ignore it (`cli/README.md`).
func reportDone(a *App, pairs [][2]string) error {
	if a.jsonOut {
		m := make(map[string]string, len(pairs))
		for _, kv := range pairs {
			m[kv[0]] = kv[1]
		}
		return a.printer().JSONValue(m)
	}
	return a.printer().KV(pairs)
}

func newShows(a *App) *cobra.Command {
	c := group(&cobra.Command{
		Use:   "show",
		Short: "Shows: a gallery of what members built",
		Long: "A show is platform-global: it belongs to no team and no project, so\n" +
			"these commands take no context. What an entry points at does — the\n" +
			"app, bundle or site you exhibit is resolved in the project context\n" +
			"(--team/--project, YYT_TEAM/YYT_PROJECT, " + ContextFile + ").",
	})
	p := func() output.Printer { return a.printer() }
	do := func(cmd *cobra.Command, method, path string, in, out any) error {
		cl, err := a.client()
		if err != nil {
			return err
		}
		return cl.Do(cmd.Context(), method, path, in, out)
	}
	done := func(pairs ...[2]string) error { return reportDone(a, pairs) }
	showPath := func(id string) string { return "/shows/" + api.PathID(id) }
	entryPath := func(show, entry string) string {
		return showPath(show) + "/entries/" + api.PathID(entry)
	}
	qs := func(kv map[string]string) string {
		qv := url.Values{}
		for k, v := range kv {
			if v != "" {
				qv.Set(k, v)
			}
		}
		if len(qv) == 0 {
			return ""
		}
		return "?" + qv.Encode()
	}

	printShow := func(s showDetail) error {
		if a.jsonOut {
			return p().JSONValue(s)
		}
		state := "open"
		if s.ClosedAt != nil {
			state = "closed " + output.Time(*s.ClosedAt)
		}
		who := "members"
		if s.ACL == "public" {
			who = "everyone"
		}
		pairs := [][2]string{
			{"id", s.ID}, {"title", s.Title},
			{"who may see it", who},
			{"state", state},
			{"entries", strconv.Itoa(s.EntryCount)},
			{"owner", output.Str(s.CreatedBy)},
			{"created", output.Time(s.CreatedAt)},
		}
		if s.EventID != nil {
			pairs = append(pairs, [2]string{"event", *s.EventID})
		}
		for _, g := range s.Grants {
			pairs = append(pairs, [2]string{"may submit", output.Str(g.Login) + " (by " + output.Str(g.GrantedBy) + ")"})
		}
		if s.BodyMd != "" {
			pairs = append(pairs, [2]string{"body", s.BodyMd})
		}
		return p().KV(pairs)
	}

	printEntry := func(e showEntry) error {
		if a.jsonOut {
			return p().JSONValue(e)
		}
		target := e.Target.Kind + " " + e.Target.Name
		if !e.Target.Available {
			target += " (no longer available)"
		}
		pairs := [][2]string{{"id", e.ID}, {"title", e.Title}, {"exhibits", target}}
		if e.Target.Ref != nil {
			pairs = append(pairs, [2]string{"build", *e.Target.Ref})
		}
		if e.Target.URL != nil {
			pairs = append(pairs, [2]string{"link", *e.Target.URL})
		}
		pairs = append(pairs,
			[2]string{"by", output.Str(e.CreatedBy)},
			[2]string{"created", output.Time(e.CreatedAt)},
			[2]string{"likes", strconv.Itoa(e.Likes)},
		)
		for _, s := range e.Shots {
			pairs = append(pairs, [2]string{"screenshot " + s.ID, s.URL})
		}
		if e.BodyMd != "" {
			pairs = append(pairs, [2]string{"body", e.BodyMd})
		}
		for _, cm := range e.Comments {
			pairs = append(pairs, [2]string{"comment " + cm.ID, output.Str(cm.CreatedBy) + " " + output.Time(cm.CreatedAt) + ": " + cm.BodyMd})
		}
		return p().KV(pairs)
	}

	/* ---- shows ---------------------------------------------------------- */

	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List shows you may see",
		Args:    cobra.NoArgs,
	}
	var listState, listCursor string
	list.Flags().StringVar(&listState, "state", "", "only 'open' or 'closed' shows")
	list.Flags().StringVar(&listCursor, "cursor", "", "continue from a previous page")
	list.RunE = func(cmd *cobra.Command, _ []string) error {
		var res struct {
			Shows []showSummary `json:"shows"`
			Next  *string       `json:"next"`
		}
		if err := do(cmd, http.MethodGet, "/shows"+qs(map[string]string{"state": listState, "cursor": listCursor}), nil, &res); err != nil {
			return err
		}
		if a.jsonOut {
			return p().JSONValue(res)
		}
		rows := make([][]string, 0, len(res.Shows))
		for _, s := range res.Shows {
			st := "open"
			if s.ClosedAt != nil {
				st = "closed"
			}
			rows = append(rows, []string{s.ID, s.Title, s.ACL, st, output.Str(s.CreatedBy), output.Time(s.CreatedAt)})
		}
		if err := p().Table([]string{"ID", "TITLE", "ACL", "STATE", "OWNER", "CREATED"}, rows); err != nil {
			return err
		}
		return moreHint(a, res.Next)
	}

	get := &cobra.Command{
		Use:   "get <show>",
		Short: "Show one gallery (owner and admins also see who may submit)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var s showDetail
			if err := do(cmd, http.MethodGet, showPath(args[0]), nil, &s); err != nil {
				return err
			}
			return printShow(s)
		},
	}

	create := &cobra.Command{
		Use:   "create <title>",
		Short: "Open a show (any non-pending member)",
		Args:  cobra.ExactArgs(1),
	}
	var createBody, createACL string
	create.Flags().StringVar(&createBody, "body", "", "markdown page, or @file")
	create.Flags().StringVar(&createACL, "acl", "public", "who may see it: public|member_only")
	create.RunE = func(cmd *cobra.Command, args []string) error {
		md, err := bodyArg(createBody)
		if err != nil {
			return err
		}
		in := map[string]any{"title": args[0], "acl": createACL}
		if md != "" {
			in["bodyMd"] = md
		}
		var res struct {
			ID string `json:"id"`
		}
		if err := do(cmd, http.MethodPost, "/shows", in, &res); err != nil {
			return err
		}
		var s showDetail
		if err := do(cmd, http.MethodGet, showPath(res.ID), nil, &s); err != nil {
			return err
		}
		return printShow(s)
	}

	update := &cobra.Command{
		Use:   "update <show>",
		Short: "Edit the title, page or audience (owner or admin)",
		Long: "Narrowing the audience is always allowed; opening a member-only show\n" +
			"to everyone is refused once it has entries — people submitted to the\n" +
			"audience they were shown.",
		Args: cobra.ExactArgs(1),
	}
	var upTitle, upBody, upACL, upReason string
	update.Flags().StringVar(&upTitle, "title", "", "new title")
	update.Flags().StringVar(&upBody, "body", "", "markdown page, or @file")
	update.Flags().StringVar(&upACL, "acl", "", "public|member_only")
	update.Flags().StringVar(&upReason, "reason", "", "required when an admin edits somebody else's show")
	update.RunE = func(cmd *cobra.Command, args []string) error {
		in := map[string]any{}
		if upTitle != "" {
			in["title"] = upTitle
		}
		if upBody != "" {
			md, err := bodyArg(upBody)
			if err != nil {
				return err
			}
			in["bodyMd"] = md
		}
		if upACL != "" {
			in["acl"] = upACL
		}
		if len(in) == 0 {
			return fmt.Errorf("nothing to update: pass --title, --body or --acl")
		}
		if upReason != "" {
			in["reason"] = upReason
		}
		if err := do(cmd, http.MethodPatch, showPath(args[0]), in, nil); err != nil {
			return err
		}
		var s showDetail
		if err := do(cmd, http.MethodGet, showPath(args[0]), nil, &s); err != nil {
			return err
		}
		return printShow(s)
	}

	state := func(verb, short string) *cobra.Command {
		doneState := map[string]string{"close": "closed", "reopen": "open"}[verb]
		c := &cobra.Command{
			Use:   verb + " <show>",
			Short: short,
			Args:  cobra.ExactArgs(1),
		}
		var reason string
		c.Flags().StringVar(&reason, "reason", "", "required when an admin acts on somebody else's show")
		c.RunE = func(cmd *cobra.Command, args []string) error {
			in := map[string]any{}
			if reason != "" {
				in["reason"] = reason
			}
			if err := do(cmd, http.MethodPost, showPath(args[0])+"/"+verb, in, nil); err != nil {
				return err
			}
			return done([2]string{"show", args[0]}, [2]string{"state", doneState})
		}
		return c
	}

	del := &cobra.Command{
		Use:     "delete <show>",
		Aliases: []string{"rm", "remove"},
		Short:   "Delete a show and everything on it (platform admin only)",
		Long: "Deleting destroys other people's entries, screenshots and comments,\n" +
			"so a reason is always required and is recorded in the audit log with a\n" +
			"snapshot of what existed.",
		Args: cobra.ExactArgs(1),
	}
	var delReason string
	del.Flags().StringVar(&delReason, "reason", "", "why it is being removed (required)")
	del.RunE = func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(delReason) == "" {
			return fmt.Errorf("--reason is required to delete a show")
		}
		if err := do(cmd, http.MethodDelete, showPath(args[0]), map[string]any{"reason": delReason}, nil); err != nil {
			return err
		}
		return done([2]string{"deleted", args[0]})
	}

	submittable := &cobra.Command{
		Use:   "submittable <show>",
		Short: "What you may still put up here (yours, not already entered)",
		Long: "Resolved through the teams you hold a seat in, so a platform admin\n" +
			"with no seat sees nothing — the answer is 'what may *I* exhibit',\n" +
			"never an inventory of the platform.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Targets []struct {
					Kind string `json:"kind"`
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"targets"`
			}
			if err := do(cmd, http.MethodGet, showPath(args[0])+"/submittable", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Targets))
			for _, t := range res.Targets {
				rows = append(rows, []string{t.Kind, t.Name, t.ID})
			}
			return p().Table([]string{"KIND", "NAME", "ID"}, rows)
		},
	}

	fromEvent := &cobra.Command{
		Use:   "from-event <event>",
		Short: "Open a show for an event (its owner or an admin)",
		Long: "Refused with 409 until the event is visible to an anonymous visitor:\n" +
			"an event still taking date votes, and one cancelled after it was\n" +
			"published, are both invisible to the world.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				ID string `json:"id"`
			}
			if err := do(cmd, http.MethodPost, "/events/"+api.PathID(args[0])+"/show", map[string]any{}, &res); err != nil {
				return err
			}
			var sh showDetail
			if err := do(cmd, http.MethodGet, showPath(res.ID), nil, &sh); err != nil {
				return err
			}
			return printShow(sh)
		},
	}

	c.AddCommand(list, get, create, update, submittable, fromEvent,
		state("close", "Close a show: read-only, and reversible"),
		state("reopen", "Reopen a closed show"),
		del,
		newShowGrants(a, do, p, showPath),
		newShowEntries(a, do, p, qs, showPath, entryPath, printEntry),
	)
	return c
}

func newShowGrants(
	a *App,
	do func(*cobra.Command, string, string, any, any) error,
	p func() output.Printer,
	showPath func(string) string,
) *cobra.Command {
	g := group(&cobra.Command{
		Use:   "grants",
		Short: "Who may put work up (owner or admin)",
		Long: "A grant is write access to one show for one member. There is no read\n" +
			"grant: who may *see* a show is its audience setting.",
	})
	grantPath := func(show, login string) string {
		return showPath(show) + "/grants/" + api.PathID(login)
	}
	g.AddCommand(&cobra.Command{
		Use:     "list <show>",
		Aliases: []string{"ls"},
		Short:   "List the grants",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Grants []showGrant `json:"grants"`
			}
			if err := do(cmd, http.MethodGet, showPath(args[0])+"/grants", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Grants))
			for _, x := range res.Grants {
				rows = append(rows, []string{output.Str(x.Login), output.Str(x.GrantedBy), output.Time(x.GrantedAt)})
			}
			return p().Table([]string{"LOGIN", "BY", "WHEN"}, rows)
		},
	})
	add := &cobra.Command{
		Use:   "add <show> <github-login>",
		Short: "Let a member put work up",
		Long: "An unknown login and an already-granted one answer alike: the route\n" +
			"must not tell anyone whether a GitHub login is a member here.",
		Args: cobra.ExactArgs(2),
	}
	var addReason string
	add.Flags().StringVar(&addReason, "reason", "", "required when an admin grants on somebody else's show")
	add.RunE = func(cmd *cobra.Command, args []string) error {
		in := map[string]any{}
		if addReason != "" {
			in["reason"] = addReason
		}
		if err := do(cmd, http.MethodPut, grantPath(args[0], args[1]), in, nil); err != nil {
			return err
		}
		return reportDone(a, [][2]string{{"granted", args[1]}, {"note", "no answer either way: a login that is not a member here looks the same"}})
	}
	rm := &cobra.Command{
		Use:   "rm <show> <github-login>",
		Short: "Take the grant back",
		Args:  cobra.ExactArgs(2),
	}
	var rmReason string
	rm.Flags().StringVar(&rmReason, "reason", "", "required when an admin acts on somebody else's show")
	rm.RunE = func(cmd *cobra.Command, args []string) error {
		in := map[string]any{}
		if rmReason != "" {
			in["reason"] = rmReason
		}
		if err := do(cmd, http.MethodDelete, grantPath(args[0], args[1]), in, nil); err != nil {
			return err
		}
		return reportDone(a, [][2]string{{"revoked", args[1]}, {"note", "no answer either way: a login that held no grant looks the same"}})
	}
	g.AddCommand(add, rm)
	return g
}

func newShowEntries(
	a *App,
	do func(*cobra.Command, string, string, any, any) error,
	p func() output.Printer,
	qs func(map[string]string) string,
	showPath func(string) string,
	entryPath func(string, string) string,
	printEntry func(showEntry) error,
) *cobra.Command {
	e := group(&cobra.Command{
		Use:   "entries",
		Short: "What is on the wall",
		Long: "An entry exhibits exactly one deliverable — a catalog app, an asset\n" +
			"bundle or a site. Submitting is publication: the name and the link of\n" +
			"what you pick become visible to everyone who can see the show.",
	})

	list := &cobra.Command{
		Use:     "list <show>",
		Aliases: []string{"ls"},
		Short:   "List the entries",
		Args:    cobra.ExactArgs(1),
	}
	var sort, cursor string
	list.Flags().StringVar(&sort, "sort", "new", "new|likes")
	list.Flags().StringVar(&cursor, "cursor", "", "continue from a previous page (cursors belong to their sort order)")
	list.RunE = func(cmd *cobra.Command, args []string) error {
		var res struct {
			Entries []showEntry `json:"entries"`
			Next    *string     `json:"next"`
		}
		path := showPath(args[0]) + "/entries" + qs(map[string]string{"sort": sort, "cursor": cursor})
		if err := do(cmd, http.MethodGet, path, nil, &res); err != nil {
			return err
		}
		if a.jsonOut {
			return p().JSONValue(res)
		}
		rows := make([][]string, 0, len(res.Entries))
		for _, x := range res.Entries {
			target := x.Target.Kind + " " + x.Target.Name
			if !x.Target.Available {
				target += " (gone)"
			}
			rows = append(rows, []string{
				x.ID, x.Title, target, output.Str(x.CreatedBy),
				strconv.Itoa(x.Likes), strconv.Itoa(x.CommentCount),
			})
		}
		if err := p().Table([]string{"ID", "TITLE", "EXHIBITS", "BY", "LIKES", "COMMENTS"}, rows); err != nil {
			return err
		}
		return moreHint(a, res.Next)
	}

	get := &cobra.Command{
		Use:   "get <show> <entry>",
		Short: "Show one entry with its screenshots and comments",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var x showEntry
			if err := do(cmd, http.MethodGet, entryPath(args[0], args[1]), nil, &x); err != nil {
				return err
			}
			return printEntry(x)
		},
	}

	submit := &cobra.Command{
		Use:   "submit <show> <title>",
		Short: "Put one of your deliverables up",
		Long: "Pick exactly one of --app, --bundle or --site (a name is resolved in\n" +
			"the project context; an id is taken as is).\n\n" +
			"--screenshot may be given up to 3 times. Every file is read and\n" +
			"checked before the entry is created, so a bad path fails without\n" +
			"putting anything up; if an upload still fails afterwards the error\n" +
			"names the entry so you can finish it with `entries update`.",
		Args: cobra.ExactArgs(2),
	}
	var appName, bundleName, siteName, subBody, subReason string
	var shots []string
	submit.Flags().StringVar(&appName, "app", "", "catalog app to exhibit (name or id)")
	submit.Flags().StringVar(&bundleName, "bundle", "", "asset bundle to exhibit (name or id)")
	submit.Flags().StringVar(&siteName, "site", "", "site to exhibit (name or id)")
	submit.Flags().StringVar(&subBody, "body", "", "markdown, or @file")
	submit.Flags().StringVar(&subReason, "reason", "", "required when a seatless admin submits another team's resource")
	submit.Flags().StringArrayVar(&shots, "screenshot", nil, "png or jpeg to upload (repeatable, max 3)")
	submit.RunE = func(cmd *cobra.Command, args []string) error {
		// Everything local first: a bad file must not leave an entry on the
		// wall that this command then failed to finish.
		files, err := readScreenshots(shots)
		if err != nil {
			return err
		}
		md, err := bodyArg(subBody)
		if err != nil {
			return err
		}
		kind, target, err := resolveTarget(a, cmd, appName, bundleName, siteName)
		if err != nil {
			return err
		}
		in := map[string]any{"targetKind": kind, "targetId": target, "title": args[1]}
		if md != "" {
			in["bodyMd"] = md
		}
		if subReason != "" {
			in["reason"] = subReason
		}
		var res struct {
			ID string `json:"id"`
		}
		if err := do(cmd, http.MethodPost, showPath(args[0])+"/entries", in, &res); err != nil {
			return err
		}
		if len(files) > 0 {
			if err := putScreenshots(cmd, do, entryPath(args[0], res.ID), files, subReason); err != nil {
				// Name what was created: re-running `submit` would be a 409,
				// so the caller needs the id to finish or remove it.
				return fmt.Errorf(
					"entry %s was created but its screenshots were not: %w\n"+
						"finish with: yyt show entries update %s %s --screenshot …",
					res.ID, err, args[0], res.ID)
			}
		}
		var x showEntry
		if err := do(cmd, http.MethodGet, entryPath(args[0], res.ID), nil, &x); err != nil {
			return err
		}
		return printEntry(x)
	}

	update := &cobra.Command{
		Use:   "update <show> <entry>",
		Short: "Edit an entry (its author, the show owner or an admin)",
		Long: "--screenshot replaces the whole set and may be given up to 3 times;\n" +
			"omitting it keeps the screenshots the entry has, and\n" +
			"--clear-screenshots empties them.",
		Args: cobra.ExactArgs(2),
	}
	var upTitle, upBody, upRef, upReason string
	var upShots []string
	var clearShots bool
	update.Flags().StringVar(&upTitle, "title", "", "new title")
	update.Flags().StringVar(&upBody, "body", "", "markdown, or @file")
	update.Flags().StringVar(&upRef, "build", "", "move the exhibited build forward (an artifact id, or a bundle version)")
	update.Flags().StringVar(&upReason, "reason", "", "required when an admin edits somebody else's entry")
	update.Flags().StringArrayVar(&upShots, "screenshot", nil, "png or jpeg to upload (repeatable, max 3; replaces the whole set)")
	update.Flags().BoolVar(&clearShots, "clear-screenshots", false, "remove every screenshot")
	update.RunE = func(cmd *cobra.Command, args []string) error {
		if clearShots && len(upShots) > 0 {
			return fmt.Errorf("--clear-screenshots and --screenshot are exclusive")
		}
		// Local work first, so a bad file cannot half-apply the PATCH.
		files, err := readScreenshots(upShots)
		if err != nil {
			return err
		}
		in := map[string]any{}
		if upTitle != "" {
			in["title"] = upTitle
		}
		if upBody != "" {
			md, err := bodyArg(upBody)
			if err != nil {
				return err
			}
			in["bodyMd"] = md
		}
		if upRef != "" {
			in["targetRef"] = upRef
		}
		// A reason on its own is not an edit: it would spend a write slot and
		// leave an audit row saying nothing changed.
		if len(in) == 0 && !clearShots && len(files) == 0 {
			return fmt.Errorf(
				"nothing to update: pass --title, --body, --build, --screenshot or --clear-screenshots")
		}
		if upReason != "" {
			in["reason"] = upReason
		}
		if len(in) > 0 && (upTitle != "" || upBody != "" || upRef != "") {
			if err := do(cmd, http.MethodPatch, entryPath(args[0], args[1]), in, nil); err != nil {
				return err
			}
		}
		if clearShots {
			clear := map[string]any{"ids": []string{}}
			if upReason != "" {
				clear["reason"] = upReason
			}
			if err := do(cmd, http.MethodPut, entryPath(args[0], args[1])+"/shots", clear, nil); err != nil {
				return err
			}
		} else if len(files) > 0 {
			if err := putScreenshots(cmd, do, entryPath(args[0], args[1]), files, upReason); err != nil {
				return err
			}
		}
		var x showEntry
		if err := do(cmd, http.MethodGet, entryPath(args[0], args[1]), nil, &x); err != nil {
			return err
		}
		return printEntry(x)
	}

	del := &cobra.Command{
		Use:     "delete <show> <entry>",
		Aliases: []string{"rm", "remove"},
		Short:   "Take an entry off the wall",
		Long: "Its author, the show owner, an admin — and anyone who can write what\n" +
			"it exhibits, so a team is never forced to destroy its own work to take\n" +
			"it down.",
		Args: cobra.ExactArgs(2),
	}
	var delReason string
	del.Flags().StringVar(&delReason, "reason", "", "required when an admin removes somebody else's entry")
	del.RunE = func(cmd *cobra.Command, args []string) error {
		in := map[string]any{}
		if delReason != "" {
			in["reason"] = delReason
		}
		if err := do(cmd, http.MethodDelete, entryPath(args[0], args[1]), in, nil); err != nil {
			return err
		}
		return reportDone(a, [][2]string{{"removed", args[1]}})
	}

	like := func(verb, method, short string) *cobra.Command {
		return &cobra.Command{
			Use:   verb + " <show> <entry>",
			Short: short,
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				if err := do(cmd, method, entryPath(args[0], args[1])+"/like", nil, nil); err != nil {
					return err
				}
				return reportDone(a, [][2]string{{verb, args[1]}})
			},
		}
	}

	e.AddCommand(list, get, submit, update, del,
		like("like", http.MethodPut, "Like an entry (idempotent)"),
		like("unlike", http.MethodDelete, "Take your like back (idempotent)"),
		newShowEntryComments(a, do, p, entryPath),
	)
	return e
}

func newShowEntryComments(
	a *App,
	do func(*cobra.Command, string, string, any, any) error,
	p func() output.Printer,
	entryPath func(string, string) string,
) *cobra.Command {
	cm := group(&cobra.Command{
		Use:   "comments",
		Short: "Comments on an entry (any signed-in non-pending reader)",
	})
	one := func(show, entry, id string) string {
		return entryPath(show, entry) + "/comments/" + api.PathID(id)
	}
	cm.AddCommand(&cobra.Command{
		Use:     "list <show> <entry>",
		Aliases: []string{"ls"},
		Short:   "List the comments",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var x showEntry
			if err := do(cmd, http.MethodGet, entryPath(args[0], args[1]), nil, &x); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(x.Comments)
			}
			rows := make([][]string, 0, len(x.Comments))
			for _, c := range x.Comments {
				rows = append(rows, []string{c.ID, output.Str(c.CreatedBy), output.Time(c.CreatedAt), c.BodyMd})
			}
			return p().Table([]string{"ID", "BY", "WHEN", "BODY"}, rows)
		},
	})
	add := &cobra.Command{
		Use:   "add <show> <entry>",
		Short: "Add a comment",
		Args:  cobra.ExactArgs(2),
	}
	var addBody string
	add.Flags().StringVar(&addBody, "body", "", "markdown, or @file (required)")
	_ = add.MarkFlagRequired("body")
	add.RunE = func(cmd *cobra.Command, args []string) error {
		md, err := bodyArg(addBody)
		if err != nil {
			return err
		}
		if strings.TrimSpace(md) == "" {
			return fmt.Errorf("--body is required")
		}
		var res struct {
			ID string `json:"id"`
		}
		if err := do(cmd, http.MethodPost, entryPath(args[0], args[1])+"/comments", map[string]any{"bodyMd": md}, &res); err != nil {
			return err
		}
		return reportDone(a, [][2]string{{"added", res.ID}})
	}
	edit := &cobra.Command{
		Use:   "edit <show> <entry> <comment>",
		Short: "Edit a comment (its author, the show owner or an admin)",
		Args:  cobra.ExactArgs(3),
	}
	var editBody, editReason string
	edit.Flags().StringVar(&editBody, "body", "", "markdown, or @file (required)")
	edit.Flags().StringVar(&editReason, "reason", "", "required when an admin edits somebody else's comment")
	_ = edit.MarkFlagRequired("body")
	edit.RunE = func(cmd *cobra.Command, args []string) error {
		md, err := bodyArg(editBody)
		if err != nil {
			return err
		}
		if strings.TrimSpace(md) == "" {
			return fmt.Errorf("--body is required")
		}
		in := map[string]any{"bodyMd": md}
		if editReason != "" {
			in["reason"] = editReason
		}
		if err := do(cmd, http.MethodPatch, one(args[0], args[1], args[2]), in, nil); err != nil {
			return err
		}
		return reportDone(a, [][2]string{{"edited", args[2]}})
	}
	del := &cobra.Command{
		Use:     "delete <show> <entry> <comment>",
		Aliases: []string{"rm", "remove"},
		Short:   "Delete a comment",
		Args:    cobra.ExactArgs(3),
	}
	var delReason string
	del.Flags().StringVar(&delReason, "reason", "", "required when an admin removes somebody else's comment")
	del.RunE = func(cmd *cobra.Command, args []string) error {
		in := map[string]any{}
		if delReason != "" {
			in["reason"] = delReason
		}
		if err := do(cmd, http.MethodDelete, one(args[0], args[1], args[2]), in, nil); err != nil {
			return err
		}
		return reportDone(a, [][2]string{{"deleted", args[2]}})
	}
	cm.AddCommand(add, edit, del)
	return cm
}

// resolveTarget turns exactly one of --app/--bundle/--site into `(kind, id)`.
// A name is resolved in the project context; an id passes straight through.
func resolveTarget(a *App, cmd *cobra.Command, app, bundle, site string) (string, string, error) {
	picked := 0
	for _, v := range []string{app, bundle, site} {
		if v != "" {
			picked++
		}
	}
	if picked != 1 {
		return "", "", fmt.Errorf("pick exactly one of --app, --bundle or --site")
	}
	cc, err := a.ctxClient(cmd)
	if err != nil {
		return "", "", err
	}
	switch {
	case app != "":
		id, err := cc.app(cmd.Context(), app, true)
		return "app", id, err
	case bundle != "":
		id, err := cc.bundle(cmd.Context(), bundle, true)
		return "bundle", id, err
	default:
		id, err := cc.site(cmd.Context(), site, true)
		return "site", id, err
	}
}

// screenshotMaxBytes mirrors the API's `POSTER_MAX_BYTES`, so an oversized
// file is refused here rather than after an entry has been created.
const screenshotMaxBytes = 5 * 1024 * 1024

type shotFile struct {
	ContentType string `json:"contentType"`
	Size        int    `json:"size"`
	data        []byte
}

// readScreenshots reads and validates every file **before** anything is
// created. Everything it checks is local and knowable up front; doing it after
// the entry POST would leave an entry on the wall that the command then failed
// to finish, and re-running it is a 409 because the target is already up.
func readScreenshots(files []string) ([]shotFile, error) {
	out := make([]shotFile, 0, len(files))
	if len(files) > screenshotsMax {
		return nil, fmt.Errorf("at most %d screenshots per entry", screenshotsMax)
	}
	for _, f := range files {
		ct, ok := posterTypes[strings.ToLower(filepath.Ext(f))]
		if !ok {
			return nil, fmt.Errorf("%s: screenshots must be .png, .jpg or .jpeg", f)
		}
		data, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		if len(data) == 0 || len(data) > screenshotMaxBytes {
			return nil, fmt.Errorf("%s: screenshots must be 1 byte to 5 MB", f)
		}
		out = append(out, shotFile{ContentType: ct, Size: len(data), data: data})
	}
	return out, nil
}

// putScreenshots presigns the whole batch in one call, PUTs each file, then
// commits the list — one commit sets the entry's screenshots, so a failed
// upload leaves it with exactly the ones it already had.
//
// One presign for the batch, not one per file: each presign takes the caller's
// 500 ms write slot, so a call per file would 429 on the second.
func putScreenshots(
	cmd *cobra.Command,
	do func(*cobra.Command, string, string, any, any) error,
	entry string,
	shots []shotFile,
	reason string,
) error {
	in := map[string]any{"files": shots}
	// Both halves take a reason: an admin acting on somebody else's entry is
	// refused without one, and the presign is a recorded write too.
	if reason != "" {
		in["reason"] = reason
	}
	var res struct {
		Grants []shotGrant `json:"grants"`
	}
	if err := do(cmd, http.MethodPost, entry+"/shots", in, &res); err != nil {
		return err
	}
	if len(res.Grants) != len(shots) {
		return fmt.Errorf("expected %d upload grants, got %d", len(shots), len(res.Grants))
	}
	// A bare client: the presigned URL carries its own signature, and the
	// console bearer must never travel to S3.
	hc := &http.Client{Timeout: 60 * time.Second}
	ids := make([]string, 0, len(res.Grants))
	for i, g := range res.Grants {
		if err := putObject(cmd.Context(), hc, "screenshot", g.URL, g.Headers, shots[i].data); err != nil {
			return err
		}
		ids = append(ids, g.ID)
	}
	// Screenshots are addressed by id: the object key is server-minted and no
	// client ever holds one.
	commit := map[string]any{"ids": ids}
	if reason != "" {
		commit["reason"] = reason
	}
	return do(cmd, http.MethodPut, entry+"/shots", commit, nil)
}
