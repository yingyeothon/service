package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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

// event mirrors console's eventView / list item (docs/decisions.md *Hackathon
// workflow*): a date vote plus a versioned page.
type event struct {
	ID            string        `json:"id"`
	Title         string        `json:"title"`
	Status        string        `json:"status"`
	BodyMd        string        `json:"bodyMd,omitempty"`
	Place         string        `json:"place"`
	PlaceURL      *string       `json:"placeUrl,omitempty"`
	DurationHours int           `json:"durationHours"`
	VoteUntil     int64         `json:"voteUntil"`
	StartsAt      *int64        `json:"startsAt"`
	Options       []eventOption `json:"options,omitempty"`
	Voters        *int          `json:"voters,omitempty"`
	Owner         *string       `json:"owner"`
	Mine          bool          `json:"mine"`
	CanEdit       bool          `json:"canEdit,omitempty"`
	Revision      int           `json:"revision,omitempty"`
	CreatedAt     int64         `json:"createdAt"`
	UpdatedAt     int64         `json:"updatedAt"`
	PublishedAt   *int64        `json:"publishedAt"`
	CancelledAt   *int64        `json:"cancelledAt,omitempty"`
	CancelledBy   *string       `json:"cancelledBy,omitempty"`
	PosterURL     *string       `json:"posterUrl,omitempty"`
	HasPoster     bool          `json:"hasPoster,omitempty"`
	Comments      []comment     `json:"comments,omitempty"`
}

type eventOption struct {
	ID       string `json:"id"`
	StartsAt int64  `json:"startsAt"`
	Mine     bool   `json:"mine"`
	Votes    *int   `json:"votes,omitempty"`
}

type eventRevision struct {
	Revision      int     `json:"revision"`
	EditedBy      *string `json:"editedBy"`
	EditedAt      int64   `json:"editedAt"`
	Title         string  `json:"title"`
	Place         string  `json:"place"`
	PlaceURL      *string `json:"placeUrl"`
	DurationHours int     `json:"durationHours"`
	PosterKey     *string `json:"posterKey"`
	BodyMd        string  `json:"bodyMd,omitempty"`
}

type eventPoster struct {
	ID          string  `json:"id"`
	Key         string  `json:"key"`
	ContentType string  `json:"contentType"`
	Size        int64   `json:"size"`
	UploadedBy  *string `json:"uploadedBy"`
	UploadedAt  int64   `json:"uploadedAt"`
	ReplacedAt  *int64  `json:"replacedAt"`
	DeletedAt   *int64  `json:"deletedAt"`
	Current     bool    `json:"current"`
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

// parseWhen accepts RFC3339 (`2026-09-12T14:00:00+09:00`), a date-time
// without zone (`2026-09-12T14:00` or `2026-09-12 14:00`, local time) or a
// bare unix-seconds integer.
func parseWhen(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Unix(), nil
	}
	for _, layout := range []string{"2006-01-02T15:04", "2006-01-02 15:04", "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t.Unix(), nil
		}
	}
	return 0, fmt.Errorf("cannot parse time %q (use RFC3339, YYYY-MM-DDTHH:MM or unix seconds)", s)
}

func newEvents(a *App) *cobra.Command {
	c := group(&cobra.Command{Use: "events", Short: "Hackathon events: date vote, page revisions, comments, poster"})
	p := func() output.Printer { return a.printer() }

	printEvent := func(e event) error {
		if a.jsonOut {
			return p().JSONValue(e)
		}
		pairs := [][2]string{
			{"id", e.ID}, {"title", e.Title}, {"status", e.Status}, {"owner", output.Str(e.Owner)},
			{"place", e.Place},
		}
		if e.PlaceURL != nil {
			pairs = append(pairs, [2]string{"map", *e.PlaceURL})
		}
		pairs = append(pairs,
			[2]string{"hours", strconv.Itoa(e.DurationHours)},
			[2]string{"vote until", output.Time(e.VoteUntil)},
			[2]string{"starts", output.TimePtr(e.StartsAt)},
		)
		for _, o := range e.Options {
			line := output.Time(o.StartsAt)
			if o.Votes != nil {
				line += fmt.Sprintf(" (%d votes)", *o.Votes)
			}
			if o.Mine {
				line += " *"
			}
			pairs = append(pairs, [2]string{"option " + o.ID, line})
		}
		if e.Voters != nil {
			pairs = append(pairs, [2]string{"voters", strconv.Itoa(*e.Voters)})
		}
		pairs = append(pairs,
			[2]string{"revision", strconv.Itoa(e.Revision)},
			[2]string{"created", output.Time(e.CreatedAt)},
			[2]string{"published", output.TimePtr(e.PublishedAt)},
		)
		if e.CancelledAt != nil {
			pairs = append(pairs, [2]string{"cancelled", output.Time(*e.CancelledAt) + " by " + output.Str(e.CancelledBy)})
		}
		if e.PosterURL != nil {
			pairs = append(pairs, [2]string{"poster", *e.PosterURL})
		}
		if e.BodyMd != "" {
			pairs = append(pairs, [2]string{"body", e.BodyMd})
		}
		for _, cm := range e.Comments {
			pairs = append(pairs, [2]string{"comment " + cm.ID, output.Str(cm.CreatedBy) + " " + output.Time(cm.CreatedAt) + ": " + cm.BodyMd})
		}
		return p().KV(pairs)
	}
	do := func(cmd *cobra.Command, method, path string, in, out any) error {
		cl, err := a.client()
		if err != nil {
			return err
		}
		return cl.Do(cmd.Context(), method, path, in, out)
	}
	eventPath := func(id string) string { return "/events/" + api.PathID(id) }

	c.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List events (anonymous: waiting/opened/closed; members: everything but others' drafts)",
		Args:    cobra.NoArgs,
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
				rows = append(rows, []string{e.ID, e.Status, e.Title, output.TimePtr(e.StartsAt), e.Place, output.Str(e.Owner), poster})
			}
			return p().Table([]string{"ID", "STATUS", "TITLE", "STARTS", "PLACE", "OWNER", "POSTER"}, rows)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "get <event-id>",
		Short: "Show one event (options, tally once the vote closed, comments)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var e event
			if err := do(cmd, http.MethodGet, eventPath(args[0]), nil, &e); err != nil {
				return err
			}
			return printEvent(e)
		},
	})
	{
		var body, place, placeURL, voteUntil string
		var options []string
		var hours int
		cc := &cobra.Command{
			Use:   "create <title>",
			Short: "Create a draft (member; max 3 drafts): page + place + candidate dates + vote deadline",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := bodyArg(body)
				if err != nil {
					return err
				}
				until, err := parseWhen(voteUntil)
				if err != nil {
					return err
				}
				starts := make([]int64, 0, len(options))
				for _, o := range options {
					s, err := parseWhen(o)
					if err != nil {
						return err
					}
					starts = append(starts, s)
				}
				in := map[string]any{"title": args[0], "bodyMd": md, "place": place, "durationHours": hours, "voteUntil": until, "options": starts}
				if placeURL != "" {
					in["placeUrl"] = placeURL
				}
				var e event
				if err := do(cmd, http.MethodPost, "/events", in, &e); err != nil {
					return err
				}
				return printEvent(e)
			},
		}
		cc.Flags().StringVar(&body, "body", "", "markdown body (or @file)")
		cc.Flags().StringVar(&place, "place", "", "venue (free text)")
		cc.Flags().StringVar(&placeURL, "place-url", "", "map link (http(s))")
		cc.Flags().IntVar(&hours, "hours", 0, "duration in hours (1–72)")
		cc.Flags().StringVar(&voteUntil, "vote-until", "", "vote deadline (RFC3339, YYYY-MM-DDTHH:MM local, or unix seconds)")
		cc.Flags().StringArrayVar(&options, "option", nil, "candidate start time (repeatable, 1–10)")
		_ = cc.MarkFlagRequired("place")
		_ = cc.MarkFlagRequired("hours")
		_ = cc.MarkFlagRequired("vote-until")
		_ = cc.MarkFlagRequired("option")
		c.AddCommand(cc)
	}
	{
		var title, body, place, placeURL, voteUntil string
		var options []string
		var hours int
		var clearPlaceURL bool
		cc := &cobra.Command{
			Use:   "update <event-id>",
			Short: "Edit the page (owner/admin; every edit is a revision); --vote-until/--option/--hours only while draft",
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
				if cmd.Flags().Changed("place") {
					patch["place"] = place
				}
				if cmd.Flags().Changed("place-url") {
					patch["placeUrl"] = placeURL
				}
				if clearPlaceURL {
					patch["placeUrl"] = nil
				}
				if cmd.Flags().Changed("hours") {
					patch["durationHours"] = hours
				}
				if cmd.Flags().Changed("vote-until") {
					until, err := parseWhen(voteUntil)
					if err != nil {
						return err
					}
					patch["voteUntil"] = until
				}
				if cmd.Flags().Changed("option") {
					starts := make([]int64, 0, len(options))
					for _, o := range options {
						s, err := parseWhen(o)
						if err != nil {
							return err
						}
						starts = append(starts, s)
					}
					patch["options"] = starts
				}
				if len(patch) == 0 {
					return errors.New("nothing to update: pass --title, --body, --place, --place-url, --clear-place-url, --hours, --vote-until and/or --option")
				}
				var e event
				if err := do(cmd, http.MethodPatch, eventPath(args[0]), patch, &e); err != nil {
					return err
				}
				return printEvent(e)
			},
		}
		cc.Flags().StringVar(&title, "title", "", "new title")
		cc.Flags().StringVar(&body, "body", "", "new markdown body (or @file)")
		cc.Flags().StringVar(&place, "place", "", "new venue")
		cc.Flags().StringVar(&placeURL, "place-url", "", "new map link")
		cc.Flags().BoolVar(&clearPlaceURL, "clear-place-url", false, "remove the map link")
		cc.Flags().IntVar(&hours, "hours", 0, "new duration in hours (draft only)")
		cc.Flags().StringVar(&voteUntil, "vote-until", "", "new vote deadline (draft only)")
		cc.Flags().StringArrayVar(&options, "option", nil, "replace every candidate start time (repeatable, draft only)")
		c.AddCommand(cc)
	}
	simple := func(use, short, action string) *cobra.Command {
		return &cobra.Command{
			Use:   use + " <event-id>",
			Short: short,
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				var e event
				if err := do(cmd, http.MethodPost, eventPath(args[0])+"/"+action, nil, &e); err != nil {
					return err
				}
				return printEvent(e)
			},
		}
	}
	c.AddCommand(simple("publish", "Open the date vote (owner/admin, draft → voting)", "publish"))
	c.AddCommand(simple("cancel", "Cancel the event before it closes (owner/admin)", "cancel"))
	c.AddCommand(&cobra.Command{
		Use:     "delete <event-id>",
		Aliases: []string{"rm"},
		Short:   "Delete an event with its history (platform admin)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return do(cmd, http.MethodDelete, eventPath(args[0]), nil, nil)
		},
	})

	// ---- votes ----
	c.AddCommand(&cobra.Command{
		Use:   "vote <event-id> <option-id>...",
		Short: "Pick every date you can make (replaces your previous picks; while voting)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				EventID   string   `json:"eventId"`
				OptionIDs []string `json:"optionIds"`
			}
			if err := do(cmd, http.MethodPut, eventPath(args[0])+"/vote", map[string]any{"optionIds": args[1:]}, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			return p().KV([][2]string{{"event", res.EventID}, {"voted", strings.Join(res.OptionIDs, " ")}})
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "unvote <event-id>",
		Short: "Withdraw all your picks (while voting)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return do(cmd, http.MethodDelete, eventPath(args[0])+"/vote", nil, nil)
		},
	})

	// ---- history ----
	c.AddCommand(&cobra.Command{
		Use:   "history <event-id>",
		Short: "List the page revisions (who changed what, when)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Revisions []eventRevision `json:"revisions"`
			}
			if err := do(cmd, http.MethodGet, eventPath(args[0])+"/revisions", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Revisions))
			for _, r := range res.Revisions {
				poster := ""
				if r.PosterKey != nil {
					poster = "yes"
				}
				rows = append(rows, []string{strconv.Itoa(r.Revision), output.Str(r.EditedBy), output.Time(r.EditedAt), r.Title, r.Place, strconv.Itoa(r.DurationHours), poster})
			}
			return p().Table([]string{"REV", "BY", "AT", "TITLE", "PLACE", "HOURS", "POSTER"}, rows)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "diff <event-id> <rev-a> <rev-b>",
		Short: "Show what changed between two revisions (unified diff of the page)",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			var ra, rb eventRevision
			if err := do(cmd, http.MethodGet, eventPath(args[0])+"/revisions/"+api.PathID(args[1]), nil, &ra); err != nil {
				return err
			}
			if err := do(cmd, http.MethodGet, eventPath(args[0])+"/revisions/"+api.PathID(args[2]), nil, &rb); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(map[string]any{"a": ra, "b": rb, "diff": diffLines(revisionText(ra), revisionText(rb))})
			}
			_, err := fmt.Fprint(a.Out, unifiedDiff(fmt.Sprintf("r%d", ra.Revision), fmt.Sprintf("r%d", rb.Revision), revisionText(ra), revisionText(rb)))
			return err
		},
	})

	// ---- comments ----
	cm := group(&cobra.Command{Use: "comments", Short: "Comments on an event (members, once published)"})
	cm.AddCommand(&cobra.Command{
		Use:     "list <event-id>",
		Aliases: []string{"ls"},
		Short:   "List comments",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var e event
			if err := do(cmd, http.MethodGet, eventPath(args[0]), nil, &e); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(map[string]any{"comments": e.Comments})
			}
			rows := make([][]string, 0, len(e.Comments))
			for _, x := range e.Comments {
				rows = append(rows, []string{x.ID, output.Str(x.CreatedBy), output.Time(x.CreatedAt), x.BodyMd})
			}
			return p().Table([]string{"ID", "BY", "AT", "BODY"}, rows)
		},
	})
	{
		var body string
		cc := &cobra.Command{
			Use:   "add <event-id>",
			Short: "Post a comment",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := bodyArg(body)
				if err != nil {
					return err
				}
				var x comment
				if err := do(cmd, http.MethodPost, eventPath(args[0])+"/comments", map[string]any{"bodyMd": md}, &x); err != nil {
					return err
				}
				if a.jsonOut {
					return p().JSONValue(x)
				}
				return p().KV([][2]string{{"id", x.ID}, {"by", output.Str(x.CreatedBy)}, {"body", x.BodyMd}})
			},
		}
		cc.Flags().StringVar(&body, "body", "", "markdown (or @file)")
		_ = cc.MarkFlagRequired("body")
		cm.AddCommand(cc)
	}
	{
		var body string
		cc := &cobra.Command{
			Use:   "edit <event-id> <comment-id>",
			Short: "Edit your comment",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				md, err := bodyArg(body)
				if err != nil {
					return err
				}
				var x comment
				if err := do(cmd, http.MethodPatch, eventPath(args[0])+"/comments/"+api.PathID(args[1]), map[string]any{"bodyMd": md}, &x); err != nil {
					return err
				}
				if a.jsonOut {
					return p().JSONValue(x)
				}
				return p().KV([][2]string{{"id", x.ID}, {"body", x.BodyMd}})
			},
		}
		cc.Flags().StringVar(&body, "body", "", "markdown (or @file)")
		_ = cc.MarkFlagRequired("body")
		cm.AddCommand(cc)
	}
	cm.AddCommand(&cobra.Command{
		Use:     "delete <event-id> <comment-id>",
		Aliases: []string{"rm"},
		Short:   "Delete a comment (author or admin)",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return do(cmd, http.MethodDelete, eventPath(args[0])+"/comments/"+api.PathID(args[1]), nil, nil)
		},
	})
	c.AddCommand(cm)

	// ---- poster ----
	poster := group(&cobra.Command{Use: "poster", Short: "Event poster (owner/admin, any status before closed)"})
	poster.AddCommand(&cobra.Command{
		Use:   "upload <event-id> <file.png|jpg>",
		Short: "Upload a poster (≤5MB) through a presigned PUT and attach it (replaces the previous one)",
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
			if err := do(cmd, http.MethodPost, eventPath(args[0])+"/poster", map[string]any{"contentType": ct, "size": len(data)}, &signed); err != nil {
				return err
			}
			// Plain client: the presigned URL must not carry the console bearer.
			if err := putObject(cmd.Context(), &http.Client{Timeout: 60 * time.Second}, "poster", signed.URL, signed.Headers, data); err != nil {
				return err
			}
			var e event
			if err := do(cmd, http.MethodPost, eventPath(args[0])+"/poster/commit", map[string]any{"key": signed.Key}, &e); err != nil {
				return err
			}
			return printEvent(e)
		},
	})
	poster.AddCommand(&cobra.Command{
		Use:     "delete <event-id>",
		Aliases: []string{"rm"},
		Short:   "Remove the poster",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return do(cmd, http.MethodDelete, eventPath(args[0])+"/poster", nil, nil)
		},
	})
	poster.AddCommand(&cobra.Command{
		Use:   "history <event-id>",
		Short: "List every poster upload (who, when, size; replaced objects are deleted)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Posters []eventPoster `json:"posters"`
			}
			if err := do(cmd, http.MethodGet, eventPath(args[0])+"/posters", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Posters))
			for _, x := range res.Posters {
				state := "replaced"
				if x.Current {
					state = "current"
				} else if x.DeletedAt == nil {
					state = "replaced (object pending delete)"
				}
				rows = append(rows, []string{x.ID, output.Str(x.UploadedBy), output.Time(x.UploadedAt), x.ContentType, strconv.FormatInt(x.Size, 10), state})
			}
			return p().Table([]string{"ID", "BY", "AT", "TYPE", "SIZE", "STATE"}, rows)
		},
	})
	c.AddCommand(poster)
	return c
}

// revisionText is the page as one text so a line diff covers every field.
func revisionText(r eventRevision) string {
	var b strings.Builder
	fmt.Fprintf(&b, "title: %s\n", r.Title)
	fmt.Fprintf(&b, "place: %s\n", r.Place)
	fmt.Fprintf(&b, "placeUrl: %s\n", output.Str(r.PlaceURL))
	fmt.Fprintf(&b, "durationHours: %d\n", r.DurationHours)
	fmt.Fprintf(&b, "poster: %s\n", output.Str(r.PosterKey))
	b.WriteString("---\n")
	b.WriteString(r.BodyMd)
	if !strings.HasSuffix(r.BodyMd, "\n") {
		b.WriteString("\n")
	}
	return b.String()
}

// putObject uploads bytes to a presigned URL with exactly the signed headers.
// `what` names the thing in the error, so posters and screenshots can share it.
//
// `hc` must be a bare client: the presigned URL carries its own signature and
// must never see the console bearer (pinned by a test).
func putObject(ctx context.Context, hc *http.Client, what, signedURL string, headers map[string]string, data []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, signedURL, bytes.NewReader(data))
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
		// Never the URL: Go's `*url.Error` prints it in full, query string
		// and all, and a presigned URL's query **is** a temporary credential
		// (`X-Amz-Credential`, `X-Amz-Signature`) plus the object key. The
		// cause alone is enough to tell a timeout from a refusal, and this
		// path is driven from a smoke script into a log.
		var ue *url.Error
		if errors.As(err, &ue) {
			return fmt.Errorf("%s upload failed: %w", what, ue.Err)
		}
		return fmt.Errorf("%s upload failed: %w", what, err)
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		// The status and S3's own error code, never the body: an S3 error
		// document quotes the access key id, the string-to-sign and the key.
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("%s upload failed: HTTP %d%s", what, res.StatusCode, s3Code(b))
	}
	return nil
}

// s3Code pulls the `<Code>` element out of an S3 error document, so a failure
// is diagnosable without echoing the document.
func s3Code(body []byte) string {
	const open, close = "<Code>", "</Code>"
	i := strings.Index(string(body), open)
	if i < 0 {
		return ""
	}
	rest := string(body)[i+len(open):]
	j := strings.Index(rest, close)
	if j < 0 || j > 64 {
		return ""
	}
	return " " + rest[:j]
}
