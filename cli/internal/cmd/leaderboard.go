package cmd

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/leaderboard.ts. A board is a project
// resource like a kv collection; its scores are the rows a game submits
// through the LB API on the state stack, and this is the console-side view of
// the same rows (docs/decisions.md *Serverless clients* #1-#4).
//
// There is no `score put`: the console never writes a score, which is what
// makes every row name the credential that wrote it.
type lbBoard struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Description   *string  `json:"description,omitempty"`
	Submit        string   `json:"submit"`
	Rule          string   `json:"rule"`
	Order         string   `json:"order"`
	Periods       []string `json:"periods"`
	MaxEntries    int      `json:"maxEntries"`
	RetainPeriods int      `json:"retainPeriods"`
	// Only on the detail route: the live bucket it counted.
	Period      string  `json:"period,omitempty"`
	PeriodKey   *string `json:"periodKey,omitempty"`
	Scores      *int    `json:"scores,omitempty"`
	TeamID      *string `json:"teamId"`
	TeamName    *string `json:"teamName"`
	ProjectID   *string `json:"projectId"`
	ProjectName *string `json:"projectName"`
	CreatedBy   *string `json:"createdBy"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	// Only on the detail and create routes.
	API *lbAPI `json:"api,omitempty"`
}

type lbAPI struct {
	Configured bool   `json:"configured"`
	BaseURL    string `json:"baseUrl"`
	MetaPath   string `json:"metaPath"`
	NamePath   string `json:"namePath,omitempty"`
	TopPath    string `json:"topPath"`
	ScorePath  string `json:"scorePath"`
}

type lbScore struct {
	Rank      int     `json:"rank"`
	Owner     string  `json:"owner"`
	Score     int64   `json:"score"`
	Meta      *string `json:"meta"`
	ChannelID *string `json:"channelId"`
	UpdatedAt int64   `json:"updatedAt"`
}

type lbScorePage struct {
	Period    string    `json:"period"`
	PeriodKey string    `json:"periodKey"`
	Total     int       `json:"total"`
	Scores    []lbScore `json:"scores"`
}

// lbOwnerScore is one owner in one bucket: the page's row plus where it sits.
type lbOwnerScore struct {
	lbScore
	Period    string `json:"period"`
	PeriodKey string `json:"periodKey"`
	Total     int    `json:"total"`
}

var (
	lbSubmits = []string{"server", "owner"}
	lbRules   = []string{"best", "latest", "sum"}
	lbOrders  = []string{"desc", "asc"}
	lbPeriods = []string{"alltime", "daily", "weekly"}
)

func newLeaderboard(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:     "lb",
		Aliases: []string{"leaderboard"},
		Short:   "Leaderboards: ranked scores a game submits through the LB API (a board belongs to a project)",
		Long: "Leaderboards under a project. A board's --submit says who may write a score\n" +
			"through the LB API on the state stack: `server` is the auth channel's doc\n" +
			"apiKey alone, `owner` also lets a player write its own row (the apiKey may\n" +
			"still write anyone's). --rule says how a new score meets the stored one\n" +
			"(best | latest | sum), --order which end ranks first (desc, or asc for\n" +
			"times), and --periods which buckets exist (alltime, daily, weekly, in\n" +
			"Asia/Seoul). None of those four can be changed afterwards.\n\n" +
			"`yyt lb` reads and deletes; it never writes a score, so every row names the\n" +
			"credential that wrote it. Scores are safe integers, and an optional `meta`\n" +
			"is JSON text stored byte for byte (at most 1 KiB).\n\n" +
			"<lb> is an id (lb_…) or a name unique within the team; a name is looked up\n" +
			"in the project context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`). `create` needs an explicit context.",
	}
	lbID := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.leaderboard(cmd.Context(), arg, write)
		return cc, id, err
	}
	score := group(&cobra.Command{
		Use:   "score",
		Short: "One owner's score: get, delete (there is no put — the console never writes one)",
	})
	score.AddCommand(
		newLbScoreGet(a, lbID),
		newLbScoreDelete(a, lbID),
	)
	c.AddCommand(
		newLbList(a),
		newLbCreate(a),
		newResourceGet(lbID, "get <lb>", "Show one board with its rules, caps, live bucket and LB API paths", "/leaderboards", a.printLbBoard),
		newLbUpdate(a, lbID),
		newResourceDelete(a, lbID, "delete <lb>", "Delete a board and every score on it (large ones drain in the background)", "/leaderboards"),
		newLbTop(a, lbID),
		newLbClear(a, lbID),
		score,
	)
	return group(c)
}

func (c *ctxClient) leaderboard(ctx context.Context, arg string, write bool) (string, error) {
	return c.resource(ctx, "leaderboard", "/leaderboards", "leaderboards", arg, write)
}

func (a *App) printLbBoard(b lbBoard) error {
	if a.jsonOut {
		return a.printer().JSONValue(b)
	}
	pairs := [][2]string{
		{"id", b.ID},
		{"name", b.Name},
		{"project", crumb(b.TeamName, b.ProjectName)},
		{"description", output.Str(b.Description)},
		{"submit", b.Submit},
		{"rule", b.Rule},
		{"order", b.Order},
		{"periods", strings.Join(b.Periods, ",")},
		{"maxEntries", fmt.Sprint(b.MaxEntries)},
		{"retainPeriods", fmt.Sprint(b.RetainPeriods)},
	}
	// The live bucket, so an operator never has to work out today's key. One
	// line: `alltime` has no key, and an empty `periodKey:` row would read as
	// a missing value rather than as "this bucket has none".
	if b.Period != "" {
		key := ""
		if b.PeriodKey != nil {
			key = *b.PeriodKey
		}
		pairs = append(pairs, [2]string{"period", b.Period + lbKeySuffix(key)})
	}
	if b.Scores != nil {
		pairs = append(pairs, [2]string{"scores", fmt.Sprint(*b.Scores)})
	}
	pairs = append(pairs,
		[2]string{"createdBy", output.Str(b.CreatedBy)},
		[2]string{"created", output.Time(b.CreatedAt)},
		[2]string{"updated", output.Time(b.UpdatedAt)},
	)
	if b.API != nil {
		pairs = append(pairs,
			[2]string{"apiConfigured", fmt.Sprint(b.API.Configured)},
			[2]string{"apiBase", b.API.BaseURL},
			[2]string{"apiMeta", b.API.MetaPath},
		)
		if b.API.NamePath != "" {
			pairs = append(pairs, [2]string{"apiName", b.API.NamePath})
		}
		pairs = append(pairs,
			[2]string{"apiTop", b.API.TopPath},
			[2]string{"apiScore", b.API.ScorePath},
		)
	}
	return a.printer().KV(pairs)
}

func newLbList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the boards of the project in context",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), false)
			if err != nil {
				return err
			}
			var res struct {
				Leaderboards []lbBoard `json:"leaderboards"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/projects/"+api.PathID(r.ProjectID)+"/leaderboards", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Leaderboards))
			for _, b := range res.Leaderboards {
				rows = append(rows, []string{b.ID, b.Name, b.Submit, b.Rule, b.Order, strings.Join(b.Periods, ","), fmt.Sprint(b.MaxEntries), output.Time(b.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "SUBMIT", "RULE", "ORDER", "PERIODS", "MAX", "UPDATED"}, rows)
		},
	}
}

func newLbCreate(a *App) *cobra.Command {
	var description, submit, rule, order string
	var periods []string
	var maxEntries, retainPeriods int
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a board in the project context (explicit); submit, rule, order and periods are fixed for good",
		Long: "Create a board. --submit is server | owner, --rule best | latest | sum,\n" +
			"--order desc | asc, --periods a comma list of alltime, daily and weekly\n" +
			"(at least one). One submission updates every configured bucket at once, and\n" +
			"the keys are computed in Asia/Seoul by the platform, never by the client.\n" +
			"None of the four can be changed afterwards: a board that changed how a new\n" +
			"score meets the stored one would be ranking rows written under two rules.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !contains(lbSubmits, submit) {
				return fmt.Errorf("submit %q: use one of %s", submit, strings.Join(lbSubmits, ", "))
			}
			if !contains(lbRules, rule) {
				return fmt.Errorf("rule %q: use one of %s", rule, strings.Join(lbRules, ", "))
			}
			if !contains(lbOrders, order) {
				return fmt.Errorf("order %q: use one of %s", order, strings.Join(lbOrders, ", "))
			}
			chosen, err := lbPeriodList(periods)
			if err != nil {
				return err
			}
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), true)
			if err != nil {
				return err
			}
			body := map[string]any{
				"name":    args[0],
				"submit":  submit,
				"rule":    rule,
				"order":   order,
				"periods": chosen,
			}
			if description != "" {
				body["description"] = description
			}
			if cmd.Flags().Changed("max-entries") {
				body["maxEntries"] = maxEntries
			}
			if cmd.Flags().Changed("retain-periods") {
				body["retainPeriods"] = retainPeriods
			}
			var b lbBoard
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/leaderboards", body, &b); err != nil {
				return err
			}
			return a.printLbBoard(b)
		},
	}
	f := c.Flags()
	f.StringVar(&submit, "submit", "", "who may write a score: server | owner")
	f.StringVar(&rule, "rule", "best", "how a new score meets the stored one: best | latest | sum")
	f.StringVar(&order, "order", "desc", "which end ranks first: desc | asc (asc for times)")
	f.StringSliceVar(&periods, "periods", []string{"alltime"}, "buckets to keep: alltime,daily,weekly")
	f.StringVar(&description, "description", "", "human-readable description")
	f.IntVar(&maxEntries, "max-entries", 0, "scores one period bucket may hold (default 2000, at most 10000)")
	f.IntVar(&retainPeriods, "retain-periods", 0, "past buckets kept per period (default 4, at most 12; 0 keeps only the live one)")
	_ = c.MarkFlagRequired("submit")
	return c
}

// lbPeriodList validates the --periods list and puts it in the canonical order
// the server stores, so the first one — the bucket every read defaults to — is
// the same whatever order the flag named them in.
func lbPeriodList(chosen []string) ([]string, error) {
	out := make([]string, 0, len(lbPeriods))
	seen := map[string]bool{}
	for _, p := range chosen {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !contains(lbPeriods, p) {
			return nil, fmt.Errorf("period %q: use one of %s", p, strings.Join(lbPeriods, ", "))
		}
		if seen[p] {
			return nil, fmt.Errorf("period %q is named twice", p)
		}
		seen[p] = true
	}
	for _, p := range lbPeriods {
		if seen[p] {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("--periods needs at least one of %s", strings.Join(lbPeriods, ", "))
	}
	return out, nil
}

// newLbUpdate is its own command rather than newResourceUpdate: the two caps
// are editable beside the name and description, the four rules never.
func newLbUpdate(a *App, lbID idResolver) *cobra.Command {
	var name, description string
	var maxEntries, retainPeriods int
	c := &cobra.Command{
		Use:   "update <lb>",
		Short: "Rename a board, change its description or its caps (submit, rule, order and periods are fixed)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			nullableDesc(cmd, "description", description, body, "description")
			if cmd.Flags().Changed("max-entries") {
				body["maxEntries"] = maxEntries
			}
			if cmd.Flags().Changed("retain-periods") {
				body["retainPeriods"] = retainPeriods
			}
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass --name, --description, --max-entries and/or --retain-periods")
			}
			cc, id, err := lbID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var b lbBoard
			if err := cc.cl.Do(cmd.Context(), http.MethodPatch, "/leaderboards/"+api.PathID(id), body, &b); err != nil {
				return err
			}
			return a.printLbBoard(b)
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "new board name (unique within the team)")
	f.StringVar(&description, "description", "", "new description (empty clears it)")
	f.IntVar(&maxEntries, "max-entries", 0, "new cap on scores per period bucket (1..10000)")
	f.IntVar(&retainPeriods, "retain-periods", 0, "new number of past buckets kept (0..12)")
	return c
}

// lbBucketQuery is `?period=` when one is named; absent means the board's first
// period at its live key, which the server resolves against its own clock.
func lbBucketQuery(period string) string {
	if period == "" {
		return ""
	}
	return "?period=" + url.QueryEscape(period)
}

func newLbTop(a *App, lbID idResolver) *cobra.Command {
	var period string
	var limit, offset int
	c := &cobra.Command{
		Use:   "top <lb>",
		Short: "Show one bucket's ranked scores",
		Long: "Print a page of one bucket, already ranked — equal scores share a rank.\n" +
			"--period names the live bucket by period (alltime, daily, weekly) or a past\n" +
			"one by key (2026-09-10, 2026-W37); omitted means the board's first period at\n" +
			"its live key. A client never computes a key itself.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := lbID(cmd, args[0], false)
			if err != nil {
				return err
			}
			q := url.Values{}
			if period != "" {
				q.Set("period", period)
			}
			if limit > 0 {
				q.Set("limit", fmt.Sprint(limit))
			}
			if offset > 0 {
				q.Set("offset", fmt.Sprint(offset))
			}
			path := "/leaderboards/" + api.PathID(id) + "/scores"
			if len(q) > 0 {
				path += "?" + q.Encode()
			}
			var page lbScorePage
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &page); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(page)
			}
			rows := make([][]string, 0, len(page.Scores))
			for _, s := range page.Scores {
				meta := "-"
				if s.Meta != nil {
					// The table is a glance; `--json` and `score get` carry the
					// whole text.
					meta = truncateRunes(*s.Meta, lbMetaColumnRunes)
				}
				rows = append(rows, []string{fmt.Sprint(s.Rank), s.Owner, fmt.Sprint(s.Score), meta, output.Str(s.ChannelID), output.Time(s.UpdatedAt)})
			}
			if err := a.printer().Table([]string{"RANK", "OWNER", "SCORE", "META", "CHANNEL", "UPDATED"}, rows); err != nil {
				return err
			}
			// On stderr, so a piped table stays a table: which bucket answered
			// is the one thing a caller cannot see from the rows.
			fmt.Fprintf(a.Err, "bucket %s%s, %d score(s) in it\n", page.Period, lbKeySuffix(page.PeriodKey), page.Total)
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&period, "period", "", "period name (alltime|daily|weekly) or a past bucket key")
	f.IntVar(&limit, "limit", 0, "page size (1..100, default 20)")
	f.IntVar(&offset, "offset", 0, "skip this many rows")
	return c
}

func newLbScoreGet(a *App, lbID idResolver) *cobra.Command {
	var period string
	c := &cobra.Command{
		Use:   "get <lb> <ownerId>",
		Short: "Show one owner's score and rank in a bucket",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := lbID(cmd, args[0], false)
			if err != nil {
				return err
			}
			path := "/leaderboards/" + api.PathID(id) + "/scores/" + api.PathID(args[1]) + lbBucketQuery(period)
			var s lbOwnerScore
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &s); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(s)
			}
			return a.printer().KV([][2]string{
				{"period", s.Period + lbKeySuffix(s.PeriodKey)},
				{"owner", s.Owner},
				{"score", fmt.Sprint(s.Score)},
				{"rank", fmt.Sprintf("%d of %d", s.Rank, s.Total)},
				{"meta", output.Str(s.Meta)},
				{"channel", output.Str(s.ChannelID)},
				{"updated", output.Time(s.UpdatedAt)},
			})
		},
	}
	c.Flags().StringVar(&period, "period", "", "period name or a past bucket key (default: the board's first period, live)")
	return c
}

func newLbScoreDelete(a *App, lbID idResolver) *cobra.Command {
	return &cobra.Command{
		Use:     "delete <lb> <ownerId>",
		Aliases: []string{"rm", "remove"},
		Short:   "Delete one owner's score from every period of the board",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := lbID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var r struct {
				Deleted int `json:"deleted"`
			}
			path := "/leaderboards/" + api.PathID(id) + "/scores/" + api.PathID(args[1])
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, path, nil, &r); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(r)
			}
			// Every bucket, said plainly: taking a cheat off today's board and
			// leaving them on last week's is not a removal.
			fmt.Fprintf(a.Out, "deleted %d row(s) of %s across every period\n", r.Deleted, args[1])
			return nil
		},
	}
}

func newLbClear(a *App, lbID idResolver) *cobra.Command {
	return &cobra.Command{
		Use:   "clear <lb> <period>",
		Short: "Delete every score in one bucket; repeats until nothing is left",
		Long: "Empty one bucket. <period> is a period name (alltime, daily, weekly) for the\n" +
			"live bucket or a key (2026-09-10, 2026-W37) for a past one. Other periods\n" +
			"keep their scores; use `lb delete` for the whole board.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := lbID(cmd, args[0], true)
			if err != nil {
				return err
			}
			total := 0
			for {
				var r struct {
					Deleted   int  `json:"deleted"`
					Truncated bool `json:"truncated"`
				}
				path := "/leaderboards/" + api.PathID(id) + "/periods/" + api.PathID(args[1])
				if err := cc.cl.Do(cmd.Context(), http.MethodDelete, path, nil, &r); err != nil {
					return err
				}
				total += r.Deleted
				if !r.Truncated {
					break
				}
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"deleted": total})
			}
			fmt.Fprintf(a.Out, "deleted %d score(s) in %s\n", total, args[1])
			return nil
		},
	}
}

// lbKeySuffix renders a bucket key beside its period; alltime has none.
func lbKeySuffix(key string) string {
	if key == "" {
		return ""
	}
	return " " + key
}

// lbMetaColumnRunes bounds the META column of `lb top`.
const lbMetaColumnRunes = 40
