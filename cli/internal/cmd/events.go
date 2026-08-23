package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// event mirrors console's eventView / list item; `winner` is only on the detail view.
type event struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Status      string    `json:"status"`
	BodyMd      string    `json:"bodyMd,omitempty"`
	CreatedAt   int64     `json:"createdAt"`
	UpdatedAt   int64     `json:"updatedAt"`
	PublishedAt *int64    `json:"publishedAt"`
	Winner      *proposal `json:"winner,omitempty"`
	PosterURL   *string   `json:"posterUrl,omitempty"`
	HasPoster   bool      `json:"hasPoster,omitempty"`
}

type proposal struct {
	ID          string  `json:"id"`
	EventID     string  `json:"eventId"`
	MemberLogin *string `json:"memberLogin"`
	Title       string  `json:"title"`
	BodyMd      string  `json:"bodyMd"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	Mine        bool    `json:"mine"`
	Votes       *int    `json:"votes,omitempty"`
}

var posterTypes = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}

// bodyArg resolves `--body` as literal markdown or `@file`.
func bodyArg(s string) (string, error) {
	if strings.HasPrefix(s, "@") {
		b, err := os.ReadFile(s[1:])
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	return s, nil
}

func newEvents(a *App) *cobra.Command {
	c := &cobra.Command{Use: "events", Short: "Hackathon events: proposals, votes, posters"}
	p := func() output.Printer { return a.printer() }

	printEvent := func(e event) error {
		if a.jsonOut {
			return p().JSONValue(e)
		}
		pairs := [][2]string{
			{"id", e.ID}, {"title", e.Title}, {"status", e.Status},
			{"created", output.Time(e.CreatedAt)}, {"published", output.TimePtr(e.PublishedAt)},
		}
		if e.Winner != nil {
			votes := ""
			if e.Winner.Votes != nil {
				votes = fmt.Sprintf(" (%d votes)", *e.Winner.Votes)
			}
			pairs = append(pairs, [2]string{"winner", e.Winner.ID + " " + e.Winner.Title + votes})
		}
		if e.PosterURL != nil {
			pairs = append(pairs, [2]string{"poster", *e.PosterURL})
		}
		if e.BodyMd != "" {
			pairs = append(pairs, [2]string{"body", e.BodyMd})
		}
		return p().KV(pairs)
	}
	printProposal := func(pr proposal) error {
		if a.jsonOut {
			return p().JSONValue(pr)
		}
		pairs := [][2]string{{"id", pr.ID}, {"event", pr.EventID}, {"by", output.Str(pr.MemberLogin)}, {"title", pr.Title}}
		if pr.Votes != nil {
			pairs = append(pairs, [2]string{"votes", fmt.Sprint(*pr.Votes)})
		}
		pairs = append(pairs, [2]string{"body", pr.BodyMd})
		return p().KV(pairs)
	}
	do := func(cmd *cobra.Command, method, path string, in, out any) error {
		cl, err := a.client()
		if err != nil {
			return err
		}
		return cl.Do(cmd.Context(), method, path, in, out)
	}

	c.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List events (anonymous sees published/closed only)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var res struct {
				Events []event `json:"events"`
			}
			if err := do(cmd, http.MethodGet, "/events", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Events))
			for _, e := range res.Events {
				poster := ""
				if e.HasPoster {
					poster = "yes"
				}
				rows = append(rows, []string{e.ID, e.Status, e.Title, output.Time(e.CreatedAt), output.TimePtr(e.PublishedAt), poster})
			}
			return p().Table([]string{"ID", "STATUS", "TITLE", "CREATED", "PUBLISHED", "POSTER"}, rows)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "get <event-id>",
		Short: "Show one event",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var e event
			if err := do(cmd, http.MethodGet, "/events/"+api.PathID(args[0]), nil, &e); err != nil {
				return err
			}
			return printEvent(e)
		},
	})
	{
		var body string
		cc := &cobra.Command{
			Use:   "create <title>",
			Short: "Create an event (admin; starts as draft)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := bodyArg(body)
				if err != nil {
					return err
				}
				var e event
				if err := do(cmd, http.MethodPost, "/events", map[string]any{"title": args[0], "bodyMd": md}, &e); err != nil {
					return err
				}
				return printEvent(e)
			},
		}
		cc.Flags().StringVar(&body, "body", "", "markdown body (or @file)")
		c.AddCommand(cc)
	}
	{
		var title, body string
		cc := &cobra.Command{
			Use:   "update <event-id>",
			Short: "Change title/body (admin)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				patch := map[string]any{}
				if cmd.Flags().Changed("title") {
					patch["title"] = title
				}
				if cmd.Flags().Changed("body") {
					md, err := bodyArg(body)
					if err != nil {
						return err
					}
					patch["bodyMd"] = md
				}
				if len(patch) == 0 {
					return errors.New("nothing to update: pass --title and/or --body")
				}
				var e event
				if err := do(cmd, http.MethodPatch, "/events/"+api.PathID(args[0]), patch, &e); err != nil {
					return err
				}
				return printEvent(e)
			},
		}
		cc.Flags().StringVar(&title, "title", "", "new title")
		cc.Flags().StringVar(&body, "body", "", "new markdown body (or @file)")
		c.AddCommand(cc)
	}
	c.AddCommand(&cobra.Command{
		Use:   "transition <event-id> <to>",
		Short: "Advance the status (admin): draft→proposing→voting→decided→published→closed",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var e event
			if err := do(cmd, http.MethodPost, "/events/"+api.PathID(args[0])+"/transition", map[string]any{"to": args[1]}, &e); err != nil {
				return err
			}
			return printEvent(e)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "decide <event-id> <proposal-id>",
		Short: "Pick the winning proposal (admin, while decided)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var e event
			if err := do(cmd, http.MethodPost, "/events/"+api.PathID(args[0])+"/decide", map[string]any{"proposalId": args[1]}, &e); err != nil {
				return err
			}
			return printEvent(e)
		},
	})

	// ---- proposals ----
	pc := &cobra.Command{Use: "proposals", Short: "Proposals of an event"}
	pc.AddCommand(&cobra.Command{
		Use:   "list <event-id>",
		Short: "List proposals (vote counts appear once voting has ended)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Proposals []proposal `json:"proposals"`
				MyVote    *string    `json:"myVote"`
			}
			if err := do(cmd, http.MethodGet, "/events/"+api.PathID(args[0])+"/proposals", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Proposals))
			for _, pr := range res.Proposals {
				votes := ""
				if pr.Votes != nil {
					votes = fmt.Sprint(*pr.Votes)
				}
				mark := ""
				if res.MyVote != nil && *res.MyVote == pr.ID {
					mark = "*"
				}
				rows = append(rows, []string{mark, pr.ID, output.Str(pr.MemberLogin), pr.Title, votes, output.Time(pr.CreatedAt)})
			}
			return p().Table([]string{"", "ID", "BY", "TITLE", "VOTES", "CREATED"}, rows)
		},
	})
	{
		var body string
		cc := &cobra.Command{
			Use:   "create <event-id> <title>",
			Short: "Submit a proposal (while proposing)",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := bodyArg(body)
				if err != nil {
					return err
				}
				var pr proposal
				if err := do(cmd, http.MethodPost, "/events/"+api.PathID(args[0])+"/proposals", map[string]any{"title": args[1], "bodyMd": md}, &pr); err != nil {
					return err
				}
				return printProposal(pr)
			},
		}
		cc.Flags().StringVar(&body, "body", "", "markdown body (or @file)")
		pc.AddCommand(cc)
	}
	{
		var title, body string
		cc := &cobra.Command{
			Use:   "update <event-id> <proposal-id>",
			Short: "Edit your proposal (while proposing)",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				patch := map[string]any{}
				if cmd.Flags().Changed("title") {
					patch["title"] = title
				}
				if cmd.Flags().Changed("body") {
					md, err := bodyArg(body)
					if err != nil {
						return err
					}
					patch["bodyMd"] = md
				}
				if len(patch) == 0 {
					return errors.New("nothing to update: pass --title and/or --body")
				}
				var pr proposal
				if err := do(cmd, http.MethodPatch, "/events/"+api.PathID(args[0])+"/proposals/"+api.PathID(args[1]), patch, &pr); err != nil {
					return err
				}
				return printProposal(pr)
			},
		}
		cc.Flags().StringVar(&title, "title", "", "new title")
		cc.Flags().StringVar(&body, "body", "", "new markdown body (or @file)")
		pc.AddCommand(cc)
	}
	pc.AddCommand(&cobra.Command{
		Use:   "delete <event-id> <proposal-id>",
		Short: "Withdraw your proposal (admins: remove any until decided)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return do(cmd, http.MethodDelete, "/events/"+api.PathID(args[0])+"/proposals/"+api.PathID(args[1]), nil, nil)
		},
	})
	c.AddCommand(pc)

	// ---- votes ----
	c.AddCommand(&cobra.Command{
		Use:   "vote <event-id> <proposal-id>",
		Short: "Cast or change your vote (while voting)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				EventID    string `json:"eventId"`
				ProposalID string `json:"proposalId"`
			}
			if err := do(cmd, http.MethodPut, "/events/"+api.PathID(args[0])+"/vote", map[string]any{"proposalId": args[1]}, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			return p().KV([][2]string{{"event", res.EventID}, {"voted", res.ProposalID}})
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "unvote <event-id>",
		Short: "Withdraw your vote (while voting)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return do(cmd, http.MethodDelete, "/events/"+api.PathID(args[0])+"/vote", nil, nil)
		},
	})

	// ---- poster ----
	poster := &cobra.Command{Use: "poster", Short: "Event poster (admin)"}
	poster.AddCommand(&cobra.Command{
		Use:   "upload <event-id> <file.png|jpg>",
		Short: "Upload a poster (≤5MB) through a presigned PUT and attach it",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ct, ok := posterTypes[strings.ToLower(filepath.Ext(args[1]))]
			if !ok {
				return errors.New("poster must be a .png, .jpg or .jpeg file")
			}
			data, err := os.ReadFile(args[1])
			if err != nil {
				return err
			}
			var signed struct {
				Key     string            `json:"key"`
				URL     string            `json:"url"`
				Headers map[string]string `json:"headers"`
			}
			if err := do(cmd, http.MethodPost, "/events/"+api.PathID(args[0])+"/poster", map[string]any{"contentType": ct, "size": len(data)}, &signed); err != nil {
				return err
			}
			// Plain client: the presigned URL must not carry the console bearer.
			if err := putObject(cmd.Context(), &http.Client{Timeout: 60 * time.Second}, signed.URL, signed.Headers, data); err != nil {
				return err
			}
			var e event
			if err := do(cmd, http.MethodPost, "/events/"+api.PathID(args[0])+"/poster/commit", map[string]any{"key": signed.Key}, &e); err != nil {
				return err
			}
			return printEvent(e)
		},
	})
	poster.AddCommand(&cobra.Command{
		Use:   "delete <event-id>",
		Short: "Remove the poster",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return do(cmd, http.MethodDelete, "/events/"+api.PathID(args[0])+"/poster", nil, nil)
		},
	})
	c.AddCommand(poster)
	return c
}

// putObject uploads bytes to a presigned URL with exactly the signed headers.
func putObject(ctx context.Context, hc *http.Client, url string, headers map[string]string, data []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(data))
	for k, v := range headers {
		if strings.EqualFold(k, "content-length") {
			continue
		}
		req.Header.Set(k, v)
	}
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("poster upload failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}
