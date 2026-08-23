package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/ws"
)

// smokeEvent is one line of the smoke report (also the --json shape).
type smokeEvent struct {
	Player int        `json:"player"`
	At     float64    `json:"at"`
	Msg    ws.Message `json:"msg,omitempty"`
	Error  string     `json:"error,omitempty"`
}

type smokeFlags struct {
	url     string
	jwts    []string
	jwtFile string
	timeout time.Duration
}

func (f *smokeFlags) bind(c *cobra.Command, urlHelp, timeoutFlag, timeoutHelp string, timeoutDefault time.Duration) {
	c.Flags().StringVar(&f.url, "url", "", urlHelp)
	c.Flags().StringArrayVar(&f.jwts, "jwt", nil, "player JWT from the auth channel (repeatable; one socket per token)")
	c.Flags().StringVar(&f.jwtFile, "jwt-file", "", "file with one JWT per line (keeps tokens out of shell history)")
	c.Flags().DurationVar(&f.timeout, timeoutFlag, timeoutDefault, timeoutHelp)
	_ = c.MarkFlagRequired("url")
}

func (f *smokeFlags) tokens() ([]string, error) {
	out := append([]string{}, f.jwts...)
	if f.jwtFile != "" {
		fh, err := os.Open(f.jwtFile)
		if err != nil {
			return nil, err
		}
		defer fh.Close()
		sc := bufio.NewScanner(fh)
		for sc.Scan() {
			if t := strings.TrimSpace(sc.Text()); t != "" {
				out = append(out, t)
			}
		}
		if err := sc.Err(); err != nil {
			return nil, err
		}
	}
	if len(out) == 0 {
		return nil, errors.New("at least one --jwt (or --jwt-file) is required")
	}
	return out, nil
}

func newSmoke(a *App) *cobra.Command {
	c := &cobra.Command{Use: "smoke", Short: "Exercise the match/topic WebSocket protocols with real JWTs"}
	c.AddCommand(newSmokeMatch(a), newSmokeTopic(a))
	return c
}

// smokeResult counts players by outcome: `failed` got a failure frame or an
// error, `unfinished` never reached a terminal frame before the deadline.
type smokeResult struct {
	players, failed, unfinished int
}

// smokeRun connects one socket per token, runs `play` per connection and
// streams events until every player hit a terminal frame or the deadline.
func (a *App) smokeRun(ctx context.Context, url string, tokens []string, timeout time.Duration,
	play func(i int, c *ws.Conn) error, terminal func(m ws.Message) bool) (smokeResult, error) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	events := make(chan smokeEvent, 256)
	conns := make([]*ws.Conn, len(tokens))
	for i, t := range tokens {
		c, err := ws.Dial(ctx, url, t)
		if err != nil {
			for _, o := range conns {
				if o != nil {
					_ = o.Close()
				}
			}
			return smokeResult{}, fmt.Errorf("player %d: %w", i+1, err)
		}
		conns[i] = c
	}
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	emit := func(e smokeEvent) bool {
		select {
		case events <- e:
			return true
		case <-ctx.Done():
			return false
		}
	}
	for i, c := range conns {
		go func(i int, c *ws.Conn) {
			if err := play(i, c); err != nil {
				emit(smokeEvent{Player: i + 1, At: since(start), Error: err.Error()})
				return
			}
			for {
				// The context deadline (timeout) always fires first; this guard only covers a stalled ctx.
				m, ok, err := c.Next(ctx, 2*timeout)
				if err != nil {
					if ctx.Err() == nil {
						emit(smokeEvent{Player: i + 1, At: since(start), Error: err.Error()})
					}
					return
				}
				if !ok {
					emit(smokeEvent{Player: i + 1, At: since(start), Error: "timeout"})
					return
				}
				if !emit(smokeEvent{Player: i + 1, At: since(start), Msg: m}) || terminal(m) {
					return
				}
			}
		}(i, c)
	}
	res := smokeResult{players: len(conns)}
	enc := json.NewEncoder(a.Out)
	handle := func(e smokeEvent) {
		if a.jsonOut {
			_ = enc.Encode(e)
		} else if e.Error != "" {
			fmt.Fprintf(a.Out, "[%6.2fs] p%d  ERROR %s\n", e.At, e.Player, e.Error)
		} else {
			b, _ := json.Marshal(e.Msg)
			fmt.Fprintf(a.Out, "[%6.2fs] p%d  %s\n", e.At, e.Player, b)
		}
		if e.Error != "" || isFailure(e.Msg) {
			res.failed++
		}
		if e.Error != "" || terminal(e.Msg) {
			res.unfinished--
		}
	}
	res.unfinished = len(conns)
	for res.unfinished > 0 {
		select {
		case e := <-events:
			handle(e)
		case <-ctx.Done():
			// Drain what arrived right before the deadline so it is reported.
			for {
				select {
				case e := <-events:
					handle(e)
					continue
				default:
				}
				break
			}
			return res, context.DeadlineExceeded
		}
	}
	return res, nil
}

func since(t time.Time) float64 { return float64(time.Since(t).Milliseconds()) / 1000 }

func isFailure(m ws.Message) bool {
	switch m.Type() {
	case "failed", "error", "expired", "closed", "replaced":
		return true
	}
	return false
}

func newSmokeMatch(a *App) *cobra.Command {
	var f smokeFlags
	c := &cobra.Command{
		Use:   "match --url <wsUrl> --jwt <t> [--jwt <t> ...]",
		Short: "Queue one player per JWT on a match channel and print matched/failed",
		Long: `Connects every JWT to the match channel's wsUrl (from "yyt channels get"),
then waits for {type:"matched"} or {type:"failed"} on each socket. No ping is
sent: connecting enqueues the player, and a ping that lands after the match
already formed is answered with {type:"failed", reason:"closed"}.
Exit code 1 when any player fails or times out.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			tokens, err := f.tokens()
			if err != nil {
				return err
			}
			res, err := a.smokeRun(cmd.Context(), f.url, tokens, f.timeout,
				func(int, *ws.Conn) error { return nil },
				func(m ws.Message) bool { t := m.Type(); return t == "matched" || t == "failed" || t == "replaced" })
			if errors.Is(err, context.DeadlineExceeded) {
				return fmt.Errorf("timed out: %d of %d players got no terminal message", res.unfinished, res.players)
			}
			if err != nil {
				return err
			}
			if res.failed > 0 {
				return fmt.Errorf("%d of %d players did not get matched", res.failed, res.players)
			}
			fmt.Fprintf(a.Err, "ok: %d players matched\n", len(tokens))
			return nil
		},
	}
	f.bind(c, "match channel wsUrl (wss://match…/?channel=<id>)", "timeout", "how long to wait for matched/failed", 90*time.Second)
	return c
}

func newSmokeTopic(a *App) *cobra.Command {
	var f smokeFlags
	c := &cobra.Command{
		Use:   "topic --url <wsUrl> --jwt <t> [--jwt <t> ...]",
		Short: "Join a topic with one member per JWT, send a message each, print what arrives",
		Long: `Connects every JWT to a topic wsUrl (returned by POST /t on the topic API),
sends {type:"msg", payload:{hello:<n>}} from each member and prints every frame
received during --wait. The wsUrl looks like wss://topic-ws…/?topic=<topicId>. Exit code 1 on error/expired/closed frames.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			tokens, err := f.tokens()
			if err != nil {
				return err
			}
			// Healthy members never "finish": the run ends at --wait by design.
			res, err := a.smokeRun(cmd.Context(), f.url, tokens, f.timeout,
				func(i int, c *ws.Conn) error {
					return c.Send(map[string]any{"type": "msg", "payload": map[string]any{"hello": i + 1}})
				},
				func(m ws.Message) bool { return isFailure(m) })
			if err != nil && !errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			if res.failed > 0 {
				return fmt.Errorf("%d of %d members received a failure frame or error", res.failed, res.players)
			}
			fmt.Fprintf(a.Err, "done after %s\n", f.timeout)
			return nil
		},
	}
	f.bind(c, "topic wsUrl (returned by POST /t on the topic API)", "wait", "how long to collect frames", 5*time.Second)
	return c
}
