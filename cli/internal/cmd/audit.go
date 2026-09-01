package cmd

import (
	"net/http"
	"net/url"
	"strconv"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

type auditRow struct {
	ID     string  `json:"id"`
	Actor  *string `json:"actor"`
	Action string  `json:"action"`
	Target *string `json:"target"`
	At     int64   `json:"at"`
}

type auditDetail struct {
	auditRow
	Detail          *string `json:"detail"`
	DetailTruncated bool    `json:"detailTruncated"`
}

func newAudit(a *App) *cobra.Command {
	c := group(&cobra.Command{
		Use:   "audit",
		Short: "The platform audit log (admin only)",
		Long: "Every recorded write on the platform. Moderation carries the reason\n" +
			"the operator gave. A listed row never carries its detail — a deletion\n" +
			"snapshot is far too large to page — so `get` is how you read one.",
	})
	p := func() output.Printer { return a.printer() }
	do := func(cmd *cobra.Command, method, path string, out any) error {
		cl, err := a.client()
		if err != nil {
			return err
		}
		return cl.Do(cmd.Context(), method, path, nil, out)
	}

	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List audit rows, newest first",
		Args:    cobra.NoArgs,
	}
	var action, prefix, target, actor, from, to, cursor string
	var limit int
	var all bool
	list.Flags().StringVar(&action, "action", "", "exact action (exclusive with --action-prefix)")
	list.Flags().StringVar(&prefix, "action-prefix", "", "action prefix, e.g. show.")
	list.Flags().StringVar(&target, "target", "", "the id the action was about")
	list.Flags().StringVar(&actor, "actor", "", "GitHub login of who did it")
	list.Flags().StringVar(&from, "from", "", "only at or after this time (RFC3339, YYYY-MM-DDTHH:MM or unix seconds)")
	list.Flags().StringVar(&to, "to", "", "only at or before this time")
	list.Flags().StringVar(&cursor, "cursor", "", "continue from a previous page")
	list.Flags().IntVar(&limit, "limit", 0, "rows per page (max 200)")
	list.Flags().BoolVar(&all, "all", false, "follow the cursor to the end")
	list.RunE = func(cmd *cobra.Command, _ []string) error {
		qv := url.Values{}
		for k, v := range map[string]string{
			"action": action, "actionPrefix": prefix, "target": target, "actor": actor,
		} {
			if v != "" {
				qv.Set(k, v)
			}
		}
		for k, v := range map[string]string{"from": from, "to": to} {
			if v == "" {
				continue
			}
			sec, err := parseWhen(v)
			if err != nil {
				return err
			}
			qv.Set(k, strconv.FormatInt(sec, 10))
		}
		if limit > 0 {
			qv.Set("limit", strconv.Itoa(limit))
		}
		rows := []auditRow{}
		next := cursor
		var last *string
		for {
			if next != "" {
				qv.Set("cursor", next)
			}
			q := ""
			if len(qv) > 0 {
				q = "?" + qv.Encode()
			}
			var res struct {
				Rows []auditRow `json:"rows"`
				Next *string    `json:"next"`
			}
			if err := do(cmd, http.MethodGet, "/admin/audit"+q, &res); err != nil {
				return err
			}
			rows = append(rows, res.Rows...)
			last = res.Next
			// An empty cursor is not a cursor: without this the loop would
			// re-request the same page forever and repeat its rows.
			if !all || res.Next == nil || *res.Next == "" {
				break
			}
			next = *res.Next
		}
		if a.jsonOut {
			return p().JSONValue(map[string]any{"rows": rows, "next": last})
		}
		out := make([][]string, 0, len(rows))
		for _, r := range rows {
			out = append(out, []string{
				output.Time(r.At), r.Action, output.Str(r.Actor), output.Str(r.Target), r.ID,
			})
		}
		if err := p().Table([]string{"WHEN", "ACTION", "ACTOR", "TARGET", "ID"}, out); err != nil {
			return err
		}
		return moreHint(a, last)
	}

	get := &cobra.Command{
		Use:     "get <id>",
		Aliases: []string{"show"},
		Short:   "Read one audit row with its detail",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var d auditDetail
			if err := do(cmd, http.MethodGet, "/admin/audit/"+api.PathID(args[0]), &d); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(d)
			}
			pairs := [][2]string{
				{"id", d.ID}, {"when", output.Time(d.At)}, {"action", d.Action},
				{"actor", output.Str(d.Actor)}, {"target", output.Str(d.Target)},
			}
			if d.Detail != nil {
				body := *d.Detail
				if d.DetailTruncated {
					body += "\n(shortened: this row is larger than the detail read returns)"
				}
				pairs = append(pairs, [2]string{"detail", body})
			}
			return p().KV(pairs)
		},
	}

	c.AddCommand(list, get)
	return c
}
