package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/ws"
)

// `yyt smoke match --deferred`: the deferred mode's HTTP tickets
// (services/match/README.md _Deferred mode_). Every JWT submits a ticket,
// accepts the proposal it is offered and waits for `confirmed`. The API is
// throttled at 5 requests/s per stage, so a polling round of N players is
// spaced at least N/4 s apart and never under a second.

type deferredTicket struct {
	State    string          `json:"state"`
	MatchID  string          `json:"matchId,omitempty"`
	Accepted bool            `json:"accepted,omitempty"`
	Partial  bool            `json:"partial,omitempty"`
	Reason   string          `json:"reason,omitempty"`
	Position int             `json:"position,omitempty"`
	Members  json.RawMessage `json:"members,omitempty"`
}

// deferredPoll is the least time between two polling rounds.
var deferredPoll = time.Second

// deferredSpacing is the least time between two requests of a run.
var deferredSpacing = 250 * time.Millisecond

// ticketRetry retries a submit or an accept that was throttled before it ran:
// a body-less 429/503 or 503 `busy`. Both are idempotent for the caller (a
// waiting ticket is replaced; accept is idempotent).
var ticketRetry = retryPolicy{attempts: 5, base: time.Second, max: 8 * time.Second, classify: func(err error) (bool, time.Duration) {
	var ae *api.Error
	if errors.As(err, &ae) && (ae.Status == 429 || ae.Status == 503) && (strings.HasPrefix(ae.Code, "http_") || isReason(err, "busy")) {
		return true, ae.RetryAfter
	}
	return false, 0
}}

// ticketEndpoints splits a ticketUrl into its origin and the channel's base
// path (`/m/{channelId}`).
func ticketEndpoints(ticketURL string) (origin, base string, err error) {
	u, err := url.Parse(ticketURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || !strings.HasSuffix(u.Path, "/ticket") {
		return "", "", fmt.Errorf("--url %q is not a ticketUrl (https://…/m/<channel>/ticket; `yyt channels get` prints it)", ticketURL)
	}
	return u.Scheme + "://" + u.Host, strings.TrimSuffix(u.Path, "/ticket"), nil
}

func (a *App) smokeDeferred(ctx context.Context, ticketURL string, tokens []string, timeout time.Duration) error {
	origin, base, err := ticketEndpoints(ticketURL)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	players := make([]*api.Client, len(tokens))
	state := make([]deferredTicket, len(tokens))
	say := func(i int, t deferredTicket, note string) {
		if a.jsonOut {
			var m ws.Message
			b, _ := json.Marshal(t)
			_ = json.Unmarshal(b, &m)
			if note != "" {
				m["note"] = note
			}
			_ = a.printer().JSONValue(smokeEvent{Player: i, At: since(start), Msg: m})
			return
		}
		line := t.State
		if t.MatchID != "" {
			line += " " + t.MatchID
		}
		if t.Reason != "" {
			line += " reason=" + t.Reason
		}
		if note != "" {
			line += " (" + note + ")"
		}
		fmt.Fprintf(a.Out, "%6.2fs  player %d  %s\n", since(start), i, line)
	}
	// Every request waits its turn: 4 a second, under the stage's 5/s.
	var last time.Time
	pace := func() error {
		if d := deferredSpacing - time.Since(last); !last.IsZero() && d > 0 {
			if err := sleepFor(ctx, d); err != nil {
				return err
			}
		}
		last = time.Now()
		return nil
	}
	call := func(i int, method, path string, out any) error {
		return ticketRetry.do(ctx, func() error {
			if err := pace(); err != nil {
				return err
			}
			return players[i].Do(ctx, method, path, nil, out)
		})
	}
	for i, tok := range tokens {
		if players[i], err = a.dataClient(origin, tok); err != nil {
			return err
		}
		if err := call(i, http.MethodPost, base+"/ticket", &state[i]); err != nil {
			a.dropTickets(players[:i+1], base)
			return fmt.Errorf("player %d: submit: %w", i, jwtErr(err))
		}
		say(i, state[i], "submitted")
	}
	gap := deferredPoll
	if n := time.Duration(len(tokens)) * time.Second / 4; n > gap {
		gap = n
	}
	for {
		done := 0
		for i := range players {
			t := &state[i]
			switch t.State {
			case "confirmed":
				done++
				continue
			case "expired", "declined", "failed":
				a.dropTickets(players, base)
				return fmt.Errorf("player %d ended %s%s", i, t.State, map[bool]string{true: " (" + t.Reason + ")", false: ""}[t.Reason != ""])
			case "proposed":
				if !t.Accepted {
					var next deferredTicket
					if err := call(i, http.MethodPost, base+"/accept", &next); err != nil {
						a.dropTickets(players, base)
						return fmt.Errorf("player %d: accept: %w", i, jwtErr(err))
					}
					*t = next
					say(i, *t, "accepted")
					continue
				}
			}
			var next deferredTicket
			if err := pace(); err != nil {
				break
			}
			if err := players[i].Do(ctx, http.MethodGet, base+"/ticket", nil, &next); err != nil {
				if errors.Is(ctx.Err(), context.DeadlineExceeded) {
					break
				}
				var ae *api.Error
				if errors.As(err, &ae) && (ae.Status == 429 || ae.Status == 503) {
					continue // throttled: read it next round
				}
				a.dropTickets(players, base)
				return fmt.Errorf("player %d: read: %w", i, jwtErr(err))
			}
			if next.State != t.State || next.Accepted != t.Accepted {
				say(i, next, "")
			}
			*t = next
		}
		done = 0
		for _, t := range state {
			if t.State == "confirmed" {
				done++
			}
		}
		if done == len(players) {
			fmt.Fprintf(a.Err, "ok: %d players confirmed\n", len(players))
			return nil
		}
		if err := sleepFor(ctx, gap); err != nil {
			a.dropTickets(players, base)
			return fmt.Errorf("timed out after %s: %d of %d confirmed", timeout, done, len(players))
		}
	}
}

// isReason reports an API error with `details.reason` == reason.
func isReason(err error, reason string) bool {
	var ae *api.Error
	if !errors.As(err, &ae) {
		return false
	}
	var d struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(ae.Details, &d)
	return d.Reason == reason
}

// dropTickets deletes the players' tickets, best effort, on a fresh context
// so a timed-out run still cleans up.
func (a *App) dropTickets(players []*api.Client, base string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, p := range players {
		if p != nil {
			_ = p.Do(ctx, http.MethodDelete, base+"/ticket", nil, nil)
		}
	}
}
