package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/config"
)

// `yyt push send`: the targeted send (docs/push.md _Targeted send_), a state
// stack route on the channel's `apiBase` with the stored channel apiKey as
// Bearer. The route is not idempotent, so only a throttled call — a 503/429
// from API Gateway or Lambda without this API's error body, which never ran —
// is retried; anything else, a transport error included, is reported.

// pushSendMaxUsers is the route's cap on user ids per call.
const pushSendMaxUsers = 500

type pushSendResult struct {
	UserID string `json:"userId"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

type pushSendAnswer struct {
	Results []pushSendResult `json:"results"`
	Sent    int              `json:"sent"`
	NoToken int              `json:"noToken"`
	Failed  int              `json:"failed"`
}

// sendThrottled is the retry policy of a send: a body-less 503/429 only.
var sendThrottled = retryPolicy{attempts: 5, base: time.Second, max: 16 * time.Second, classify: func(err error) (bool, time.Duration) {
	var ae *api.Error
	if errors.As(err, &ae) && (ae.Status == 429 || ae.Status == 503) && strings.HasPrefix(ae.Code, "http_") {
		return true, ae.RetryAfter
	}
	return false, 0
}}

// splitUsers flattens repeated and comma-separated --user values, folding
// duplicates in first-seen order.
func splitUsers(vals []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range vals {
		for _, u := range strings.Split(v, ",") {
			if u = strings.TrimSpace(u); u != "" && !seen[u] {
				seen[u] = true
				out = append(out, u)
			}
		}
	}
	return out
}

// parsePairs turns `k=v` flags into a map; a key may not repeat.
func parsePairs(flag string, vals []string) (map[string]string, error) {
	m := map[string]string{}
	for _, kv := range vals {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			return nil, fmt.Errorf("--%s takes key=value (got %q)", flag, kv)
		}
		if _, dup := m[k]; dup {
			return nil, fmt.Errorf("--%s %s given twice", flag, k)
		}
		m[k] = v
	}
	return m, nil
}

func (a *App) pushSendCmd(resolve channelResolver) *cobra.Command {
	var users, data []string
	var title, body, priority, collapse string
	var ttl int
	c := &cobra.Command{
		Use:   "send <channel> --user <id>[,<id>…] [--data k=v …] [--title t --body b] [--priority high|normal] [--ttl sec] [--collapse-key k]",
		Short: "Send to up to 500 users of a push channel with its stored apiKey (`push key set`); prints one line per user",
		Example: "  yyt push send alerts --user u_0123abcd --title \"Your turn\" --body \"dooroo played a move\"\n" +
			"  yyt push send alerts --user u_0123abcd,u_4567cdef --data screen=match --priority high --ttl 3600\n" +
			"  yyt push send push_0123abcd --user u_0123abcd --data kind=ping --json",
		Annotations: map[string]string{OutputAnnotation: "table USER STATUS REASON, then \"sent <n> · no-token <n> · failed <n>\"; " +
			"--json: {results:[{userId,status,reason}],sent,noToken,failed}"},
		Long: "The targeted send (docs/push.md, Targeted send): POST {apiBase}/push/{channel}/send\n" +
			"with the channel apiKey stored by `yyt push key set` (or `rotate --save`).\n" +
			"At least one of --data and --title is needed. The route is not idempotent:\n" +
			"a throttled call (a 503/429 without a body: it never ran) is retried with\n" +
			"a backoff, nothing else is. Resend only the users that failed with\n" +
			"`budget` or `unavailable`. Exits 1 when any user failed.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ids := splitUsers(users)
			if len(ids) == 0 {
				return errors.New("--user is required")
			}
			if len(ids) > pushSendMaxUsers {
				return fmt.Errorf("%d users; one send takes at most %d", len(ids), pushSendMaxUsers)
			}
			d, err := parsePairs("data", data)
			if err != nil {
				return err
			}
			if title == "" && body != "" {
				return errors.New("--body needs --title")
			}
			if title == "" && len(d) == 0 {
				return errors.New("nothing to send: give --data and/or --title")
			}
			req := map[string]any{"userIds": ids}
			if len(d) > 0 {
				req["data"] = d
			}
			if title != "" {
				req["notification"] = map[string]string{"title": title, "body": body}
			}
			if priority != "" {
				if priority != "high" && priority != "normal" {
					return errors.New("--priority must be high or normal")
				}
				req["priority"] = priority
			}
			if cmd.Flags().Changed("ttl") {
				req["ttlSec"] = ttl
			}
			if collapse != "" {
				req["collapseKey"] = collapse
			}
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			key, err := pushKeyOf(cc, id)
			if err != nil {
				return err
			}
			var ch channel
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(id), nil, &ch); err != nil {
				return err
			}
			if ch.APIBase == "" {
				return errors.New("this stage has no state stack (the channel shows no apiBase)")
			}
			st, err := a.dataClient(ch.APIBase, key)
			if err != nil {
				return err
			}
			var ans pushSendAnswer
			if err := sendThrottled.do(cmd.Context(), func() error {
				return st.Do(cmd.Context(), http.MethodPost, "/push/"+api.PathID(id)+"/send", req, &ans)
			}); err != nil {
				return dataPlaneErr(err)
			}
			if err := a.printSendAnswer(ans); err != nil {
				return err
			}
			if ans.Failed > 0 {
				var again []string
				for _, r := range ans.Results {
					if r.Status == "failed" && (r.Reason == "budget" || r.Reason == "unavailable") {
						again = append(again, r.UserID)
					}
				}
				if len(again) > 0 {
					return fmt.Errorf("%d of %d users failed; resend the retryable ones with --user %s", ans.Failed, len(ans.Results), strings.Join(again, ","))
				}
				return fmt.Errorf("%d of %d users failed (not retryable)", ans.Failed, len(ans.Results))
			}
			return nil
		},
	}
	f := c.Flags()
	f.StringArrayVar(&users, "user", nil, "user id of the push channel's auth channel; repeat or comma-separate (at most 500)")
	f.StringArrayVar(&data, "data", nil, "data key=value, repeatable (string values)")
	f.StringVar(&title, "title", "", "notification title")
	f.StringVar(&body, "body", "", "notification body (needs --title)")
	f.StringVar(&priority, "priority", "", "high | normal")
	f.IntVar(&ttl, "ttl", 0, "seconds FCM keeps an undelivered message (0–2419200)")
	f.StringVar(&collapse, "collapse-key", "", "replace an undelivered message with the same key")
	return c
}

func (a *App) printSendAnswer(ans pushSendAnswer) error {
	if a.jsonOut {
		return a.printer().JSONValue(ans)
	}
	rows := append([]pushSendResult(nil), ans.Results...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Status > rows[j].Status })
	tw := a.printer()
	table := [][]string{}
	for _, r := range rows {
		table = append(table, []string{r.UserID, r.Status, r.Reason})
	}
	if err := tw.Table([]string{"USER", "STATUS", "REASON"}, table); err != nil {
		return err
	}
	fmt.Fprintf(a.Out, "sent %s · no-token %s · failed %s\n", strconv.Itoa(ans.Sent), strconv.Itoa(ans.NoToken), strconv.Itoa(ans.Failed))
	return nil
}

// dataClient is a client for a data-plane host (the state stack) holding a
// channel credential instead of the console token. The base comes from a
// console answer, so it gets the console URL's own check: https only (plain
// http for localhost), before a key or a JWT is sent to it.
func (a *App) dataClient(base, key string) (*api.Client, error) {
	if err := config.CheckAPI(base); err != nil {
		return nil, fmt.Errorf("refusing to send a credential to %q: https only", base)
	}
	cl := api.New(base, key)
	cl.DataPlane = true
	return cl, nil
}

// dataPlaneErr rewords a 401/403 from a data-plane route, which `Execute`
// would otherwise blame on the console token.
func dataPlaneErr(err error) error {
	return dataPlaneErrAs(err, "the stored channel apiKey was refused (rotated? store the new one with `yyt push key set`)")
}

// jwtErr rewords a refused player JWT, which `Execute` would blame on the
// console token.
func jwtErr(err error) error {
	return dataPlaneErrAs(err, "the player JWT was refused (expired, or of another auth channel?)")
}

func dataPlaneErrAs(err error, msg string) error {
	var ae *api.Error
	if errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403) {
		return fmt.Errorf("%s: %s", msg, ae.Message)
	}
	return err
}
