package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/limits.ts. A value is a number or the
// string "unlimited", so it stays raw JSON until printed.
type limitRow struct {
	Key       string         `json:"key"`
	Unit      string         `json:"unit"`
	Soft      any            `json:"soft"`
	Hard      any            `json:"hard"`
	Effective any            `json:"effective"`
	Usage     *float64       `json:"usage"`
	Override  *limitOverride `json:"override"`
}

type limitOverride struct {
	Value          any     `json:"value"`
	ExpiresAt      *int64  `json:"expiresAt"`
	Note           string  `json:"note"`
	RequestID      *string `json:"requestId"`
	GrantedBy      string  `json:"grantedBy"`
	GrantedByLogin *string `json:"grantedByLogin"`
	GrantedAt      int64   `json:"grantedAt"`
}

type limitScopeView struct {
	Kind string  `json:"kind"`
	ID   string  `json:"id"`
	Name *string `json:"name,omitempty"`
}

type limitRequest struct {
	ID             string         `json:"id"`
	TeamID         string         `json:"teamId"`
	TeamName       *string        `json:"teamName"`
	Scope          limitScopeView `json:"scope"`
	Key            string         `json:"key"`
	Unit           *string        `json:"unit"` // null for a retired key
	RequestedValue any            `json:"requestedValue"`
	Reason         string         `json:"reason"`
	Status         string         `json:"status"`
	DecidedValue   any            `json:"decidedValue"`
	DecisionNote   *string        `json:"decisionNote"`
	CreatedBy      string         `json:"createdBy"`
	CreatedByLogin *string        `json:"createdByLogin"`
	CreatedAt      int64          `json:"createdAt"`
	DecidedBy      *string        `json:"decidedBy"`
	DecidedByLogin *string        `json:"decidedByLogin"`
	DecidedAt      *int64         `json:"decidedAt"`
}

var sizeRe = regexp.MustCompile(`(?i)^(\d+)\s*(b|kib|mib|gib)?$`)

// parseLimitValue reads `unlimited`, a plain number, or a byte size in binary
// units (`256MiB`, `4 GiB`, `512KiB`); a decimal unit (`MB`) is refused rather
// than guessed at.
func parseLimitValue(s string) (any, error) {
	s = strings.TrimSpace(s)
	if strings.EqualFold(s, "unlimited") {
		return "unlimited", nil
	}
	m := sizeRe.FindStringSubmatch(s)
	if m == nil {
		return nil, fmt.Errorf("value %q: want a number, a size like 256MiB, or unlimited", s)
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || n <= 0 {
		return nil, fmt.Errorf("value %q: must be a positive whole number", s)
	}
	mult := map[string]int64{"": 1, "b": 1, "kib": 1 << 10, "mib": 1 << 20, "gib": 1 << 30}[strings.ToLower(m[2])]
	if n > (1<<53)/mult {
		return nil, fmt.Errorf("value %q is too large", s)
	}
	return n * mult, nil
}

// parseSpan reads a duration with a day unit on top of Go's (`7d`, `12h`, `90m`).
func parseSpan(s string) (time.Duration, error) {
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("duration %q: want e.g. 7d, 12h", s)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("duration %q: want e.g. 7d, 12h", s)
	}
	return d, nil
}

// formatLimit prints a value in its unit: `256 MiB`, `50`, `28 days`, `unlimited`.
func formatLimit(unit string, v any) string {
	switch x := v.(type) {
	case nil:
		return "-"
	case string:
		return x
	case float64:
		n := int64(x)
		switch unit {
		case "bytes":
			for _, u := range []struct {
				n    int64
				name string
			}{{1 << 30, "GiB"}, {1 << 20, "MiB"}, {1 << 10, "KiB"}} {
				if n >= u.n && n%u.n == 0 {
					return fmt.Sprintf("%d %s", n/u.n, u.name)
				}
			}
			if n >= 1<<20 {
				return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
			}
			return fmt.Sprintf("%d B", n)
		case "seconds":
			return fmt.Sprintf("%d days", n/86400)
		}
		return strconv.FormatInt(n, 10)
	}
	return fmt.Sprint(v)
}

func newLimits(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:     "limit",
		Aliases: []string{"limits"},
		Short:   "Asset and channel limits: see them, ask for more, and (admin) grant or refuse",
		Long: "Asset and channel limits (docs/decisions.md \"Limit requests\").\n\n" +
			"Every limit has a soft value every scope gets and a hard ceiling a platform\n" +
			"admin may grant up to. A limit belongs to a bundle (--bundle), a channel\n" +
			"(--channel) or, with neither, the project in context. Sizes take binary\n" +
			"units (256MiB, 3GiB); a channel's lifetime takes only `unlimited`.",
	}
	var bundle, channel string
	addScope := func(cmd *cobra.Command) {
		cmd.Flags().StringVar(&bundle, "bundle", "", "an asset bundle (id or name in the project context)")
		cmd.Flags().StringVar(&channel, "channel", "", "a channel (id or name in the project context)")
	}
	// scopeOf resolves --bundle / --channel / the project context to `kind:id`.
	scopeOf := func(cmd *cobra.Command, write bool) (*ctxClient, string, string, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", "", "", err
		}
		ctx := cmd.Context()
		switch {
		case bundle != "" && channel != "":
			return nil, "", "", "", errors.New("pass one of --bundle and --channel")
		case bundle != "":
			id, err := cc.bundle(ctx, bundle, write)
			return cc, "bundle", id, "bundle:" + id, err
		case channel != "":
			id, err := cc.channel(ctx, channel, write)
			return cc, "channel", id, "channel:" + id, err
		}
		r, err := cc.project(ctx, write)
		if err != nil {
			return nil, "", "", "", err
		}
		return cc, "project", r.ProjectID, "project:" + r.ProjectID, nil
	}

	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "Show a scope's limits: usage, the effective value, soft and hard, and pending requests",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, _, _, scope, err := scopeOf(cmd, false)
			if err != nil {
				return err
			}
			var res struct {
				Scope     limitScopeView `json:"scope"`
				TeamID    string         `json:"teamId"`
				ExpiresAt *int64         `json:"expiresAt,omitempty"`
				Limits    []limitRow     `json:"limits"`
				Pending   []limitRequest `json:"pending"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/limits?scope="+url.QueryEscape(scope), nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Limits))
			for _, l := range res.Limits {
				usage := "-"
				if l.Usage != nil {
					usage = formatLimit(l.Unit, *l.Usage)
				}
				if l.Key == "channel.lifetime" && res.ExpiresAt != nil {
					usage = expiryText(*res.ExpiresAt)
				}
				over := "-"
				if o := l.Override; o != nil {
					over = formatLimit(l.Unit, o.Value)
					if o.ExpiresAt != nil {
						over += " until " + output.Time(*o.ExpiresAt)
					}
				}
				rows = append(rows, []string{l.Key, usage, formatLimit(l.Unit, l.Effective), formatLimit(l.Unit, l.Soft), formatLimit(l.Unit, l.Hard), over})
			}
			if err := a.printer().Table([]string{"LIMIT", "USAGE", "EFFECTIVE", "SOFT", "HARD", "OVERRIDE"}, rows); err != nil {
				return err
			}
			// Who raised what and why, which the table has no room for.
			var notes [][2]string
			for _, l := range res.Limits {
				if o := l.Override; o != nil {
					notes = append(notes, [2]string{l.Key, fmt.Sprintf("by %s at %s: %s", output.Str(o.GrantedByLogin), output.Time(o.GrantedAt), o.Note)})
				}
			}
			if len(notes) > 0 {
				fmt.Fprintln(a.Out)
				if err := a.printer().KV(notes); err != nil {
					return err
				}
			}
			if len(res.Pending) == 0 {
				return nil
			}
			fmt.Fprintln(a.Out)
			return a.printRequests(res.Pending)
		},
	}
	addScope(list)

	var reason string
	request := &cobra.Command{
		Use:   "request <limit> <value|unlimited>",
		Short: "Ask a platform admin for a higher limit (one pending per limit; 7 days after a refusal)",
		Example: "  yyt limit request asset.fileBytes 64MiB --bundle music --reason \"48 kHz tracks\"\n" +
			"  yyt limit request channel.lifetime unlimited --channel lobby --reason \"always-on demo\"",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(reason) == "" {
				return errors.New("--reason is required: say what the limit is for")
			}
			value, err := parseLimitValue(args[1])
			if err != nil {
				return err
			}
			cc, _, _, scope, err := scopeOf(cmd, true)
			if err != nil {
				return err
			}
			var r limitRequest
			body := map[string]any{"scope": scope, "key": args[0], "value": value, "reason": reason}
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/limit-requests", body, &r); err != nil {
				return withRetryAt(err)
			}
			return a.printRequest(r)
		},
	}
	addScope(request)
	request.Flags().StringVar(&reason, "reason", "", "what the limit is for (required; the team and admins read it)")

	var status, cursor string
	var all bool
	var pageSize int
	requests := &cobra.Command{
		Use:   "requests",
		Short: "List the team's limit requests, newest first (--all: every team's, admin)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			q := url.Values{}
			if status != "" {
				q.Set("status", status)
			}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			if pageSize > 0 {
				q.Set("limit", strconv.Itoa(pageSize))
			}
			var cl *api.Client
			path := "/admin/limit-requests"
			if all {
				c, err := a.client()
				if err != nil {
					return err
				}
				cl = c
			} else {
				cc, err := a.ctxClient(cmd)
				if err != nil {
					return err
				}
				r, err := cc.team(cmd.Context(), false)
				if err != nil {
					return err
				}
				cl = cc.cl
				path = "/limit-requests"
				q.Set("team", r.TeamID)
			}
			var res struct {
				Requests []limitRequest `json:"requests"`
				Next     *string        `json:"next"`
				Pending  *int           `json:"pending,omitempty"`
			}
			if err := cl.Do(cmd.Context(), http.MethodGet, path+"?"+q.Encode(), nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			if err := a.printRequests(res.Requests); err != nil {
				return err
			}
			if res.Pending != nil {
				fmt.Fprintf(a.Err, "pending across every team: %d\n", *res.Pending)
			}
			if res.Next != nil {
				fmt.Fprintf(a.Err, "more: --cursor %s\n", *res.Next)
			}
			return nil
		},
	}
	requests.Flags().StringVar(&status, "status", "", "pending | approved | rejected | cancelled")
	requests.Flags().StringVar(&cursor, "cursor", "", "continue after a previous page")
	requests.Flags().IntVar(&pageSize, "limit", 0, "rows per page (default 50, max 200)")
	requests.Flags().BoolVar(&all, "all", false, "every team's requests (platform admin)")

	decide := func(use, short, verb string, needNote bool, withValue bool) *cobra.Command {
		var note, value string
		cmd := &cobra.Command{
			Use:   use,
			Short: short,
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				if needNote && strings.TrimSpace(note) == "" {
					return errors.New("--note is required")
				}
				body := map[string]any{}
				if note != "" {
					body["note"] = note
				}
				if value != "" {
					v, err := parseLimitValue(value)
					if err != nil {
						return err
					}
					body["value"] = v
				}
				cl, err := a.client()
				if err != nil {
					return err
				}
				path := "/limit-requests/" + api.PathID(args[0]) + "/" + verb
				if verb != "cancel" {
					path = "/admin" + path
				}
				var r limitRequest
				if err := cl.Do(cmd.Context(), http.MethodPost, path, body, &r); err != nil {
					return err
				}
				return a.printRequest(r)
			},
		}
		if verb != "cancel" {
			cmd.Flags().StringVar(&note, "note", "", "a note for the team")
		}
		if withValue {
			cmd.Flags().StringVar(&value, "value", "", "grant this instead of the requested value (≤ the hard ceiling)")
		}
		return cmd
	}

	var note, expires string
	set := &cobra.Command{
		Use:   "set <limit> <value|unlimited>",
		Short: "Set a scope's limit directly, without a request (platform admin; --note required)",
		Example: "  yyt limit set asset.bundleBytes 1GiB --bundle ab_0123 --expires 7d --note \"contest week\"\n" +
			"  yyt limit set channel.lifetime unlimited --channel lobby_0123 --note \"public demo\"",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(note) == "" {
				return errors.New("--note is required")
			}
			value, err := parseLimitValue(args[1])
			if err != nil {
				return err
			}
			body := map[string]any{"value": value, "note": note}
			if expires != "" {
				d, err := parseSpan(expires)
				if err != nil {
					return err
				}
				body["expiresAt"] = time.Now().Add(d).Unix()
			}
			cc, kind, id, _, err := scopeOf(cmd, true)
			if err != nil {
				return err
			}
			var res struct {
				Key       string         `json:"key"`
				Unit      string         `json:"unit"`
				Effective any            `json:"effective"`
				Override  *limitOverride `json:"override"`
			}
			path := "/admin/limit-overrides/" + kind + "/" + api.PathID(id) + "/" + api.PathID(args[0])
			if err := cc.cl.Do(cmd.Context(), http.MethodPut, path, body, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			pairs := [][2]string{{"limit", res.Key}, {"effective", formatLimit(res.Unit, res.Effective)}}
			if o := res.Override; o != nil {
				pairs = append(pairs, [2]string{"expires", output.TimePtr(o.ExpiresAt)}, [2]string{"note", o.Note})
			}
			return a.printer().KV(pairs)
		},
	}
	addScope(set)
	set.Flags().StringVar(&note, "note", "", "why (required; kept in the audit log)")
	set.Flags().StringVar(&expires, "expires", "", "a temporary raise: lapse after this long (e.g. 7d; not for channel.lifetime)")

	var revokeNote string
	revoke := &cobra.Command{
		Use:   "revoke <limit>",
		Short: "Drop a scope's override (platform admin); a channel's lifetime returns to 28 days",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(revokeNote) == "" {
				return errors.New("--note is required")
			}
			cc, kind, id, scope, err := scopeOf(cmd, true)
			if err != nil {
				return err
			}
			path := "/admin/limit-overrides/" + kind + "/" + api.PathID(id) + "/" + api.PathID(args[0])
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, path, map[string]any{"note": revokeNote}, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "revoked %s on %s\n", args[0], scope)
			return nil
		},
	}
	addScope(revoke)
	revoke.Flags().StringVar(&revokeNote, "note", "", "why (required; kept in the audit log)")

	get := &cobra.Command{
		Use:   "get <request-id>",
		Short: "Show one request with its reason and, once decided, the grant and the admin's note",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var r limitRequest
			if err := cl.Do(cmd.Context(), http.MethodGet, "/limit-requests/"+api.PathID(args[0]), nil, &r); err != nil {
				return err
			}
			return a.printRequest(r)
		},
	}

	c.AddCommand(
		list, request, requests, get,
		decide("cancel <request-id>", "Cancel a pending request (the requester, or a team owner); counts as a refusal for 7 days", "cancel", false, false),
		decide("approve <request-id>", "Approve a pending request (platform admin)", "approve", false, true),
		decide("reject <request-id>", "Refuse a pending request (platform admin; --note required)", "reject", true, false),
		set, revoke,
	)
	return c
}

func (a *App) printRequests(rs []limitRequest) error {
	rows := make([][]string, 0, len(rs))
	for _, r := range rs {
		unit := output.Str(r.Unit)
		scope := r.Scope.Kind + " " + r.Scope.ID
		if r.Scope.Name != nil && *r.Scope.Name != "" {
			scope = r.Scope.Kind + " " + *r.Scope.Name
		}
		rows = append(rows, []string{r.ID, output.Str(r.TeamName), scope, r.Key, formatLimit(unit, r.RequestedValue), r.Status, output.Str(r.CreatedByLogin), output.Time(r.CreatedAt)})
	}
	return a.printer().Table([]string{"ID", "TEAM", "SCOPE", "LIMIT", "REQUESTED", "STATUS", "BY", "CREATED"}, rows)
}

func (a *App) printRequest(r limitRequest) error {
	if a.jsonOut {
		return a.printer().JSONValue(r)
	}
	unit := output.Str(r.Unit)
	pairs := [][2]string{
		{"id", r.ID},
		{"team", output.Str(r.TeamName)},
		{"scope", r.Scope.Kind + " " + r.Scope.ID},
		{"limit", r.Key},
		{"requested", formatLimit(unit, r.RequestedValue)},
		{"status", r.Status},
		{"by", output.Str(r.CreatedByLogin)},
		{"created", output.Time(r.CreatedAt)},
	}
	if r.Status == "approved" {
		pairs = append(pairs, [2]string{"granted", formatLimit(unit, r.DecidedValue)})
	}
	if r.DecidedAt != nil {
		pairs = append(pairs, [2]string{"decided", output.Time(*r.DecidedAt)}, [2]string{"decidedBy", output.Str(r.DecidedByLogin)})
	}
	if r.DecisionNote != nil {
		pairs = append(pairs, [2]string{"note", *r.DecisionNote})
	}
	pairs = append(pairs, [2]string{"reason", r.Reason})
	return a.printer().KV(pairs)
}

// withRetryAt adds the cooldown's end, as a time, to a 429 whose details
// carry `retryAt` (unix seconds): the raw number is what the API sends.
func withRetryAt(err error) error {
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != http.StatusTooManyRequests {
		return err
	}
	var d struct {
		RetryAt int64 `json:"retryAt"`
	}
	if json.Unmarshal(ae.Details, &d) != nil || d.RetryAt == 0 {
		return err
	}
	return fmt.Errorf("%w (you can ask again after %s)", err, output.Time(d.RetryAt))
}
