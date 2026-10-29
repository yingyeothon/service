package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Push channel upkeep (docs/decisions.md *Push notifications* #11b–d): the
// channel's recipient uploads, its token count and send history, and the
// last daily pool sweep (platform admin).

type pushUpload struct {
	ID             string  `json:"id"`
	Size           int64   `json:"size"`
	CreatedBy      string  `json:"createdBy"`
	CreatedByLogin *string `json:"createdByLogin"`
	CreatedAt      int64   `json:"createdAt"`
	UsableUntil    int64   `json:"usableUntil"`
	Pending        bool    `json:"pending"`
	InUse          bool    `json:"inUse"`
}

type pushStats struct {
	Tokens struct {
		Count  int  `json:"count"`
		Capped bool `json:"capped"`
	} `json:"tokens"`
	TokenCap int    `json:"tokenCap"`
	Since    string `json:"since"`
	Days     []struct {
		Day          string `json:"day"`
		Calls        int    `json:"calls"`
		Sent         int    `json:"sent"`
		NoToken      int    `json:"noToken"`
		Failed       int    `json:"failed"`
		Unregistered int    `json:"unregistered"`
	} `json:"days"`
}

func (a *App) pushUploadCmd(resolve channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:     "upload",
		Aliases: []string{"uploads"},
		Short:   "Recipient CSV uploads of a push channel: list, and remove one to free a pending place (20 per channel)",
	}
	var asServer bool
	var limit int
	var cursor string
	ls := &cobra.Command{
		Use:     "ls <channel>",
		Aliases: []string{"list"},
		Short:   "List the channel's uploads, newest first: size, who uploaded, whether one still counts against the 20",
		Example: "  yyt push upload ls alerts\n  yyt push upload ls alerts --limit 50 --json\n  yyt push upload ls push_0123abcd --as-server",
		Annotations: map[string]string{OutputAnnotation: "table ID BYTES STATE BY CREATED USABLE UNTIL, then \"more: --cursor …\" or \"<n> of <max> pending places used\" on stderr; " +
			"--json: {uploads:[{id,size,createdBy,createdAt,usableUntil,pending,inUse}],next,max}"},
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			jc, base, err := a.campaignAPI(cc, id, asServer)
			if err != nil {
				return err
			}
			q := url.Values{}
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			path := base + "/uploads"
			if len(q) > 0 {
				path += "?" + q.Encode()
			}
			var res struct {
				Uploads []pushUpload `json:"uploads"`
				Next    *string      `json:"next"`
				Max     int          `json:"max"`
			}
			if err := jc.Do(cmd.Context(), http.MethodGet, path, nil, &res); err != nil {
				return withCampaignHint(serverErr(err, asServer), id)
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Uploads))
			pending := 0
			for _, u := range res.Uploads {
				state := "free"
				switch {
				case u.InUse:
					state = "in use"
					pending++
				case u.Pending:
					state = "pending"
					pending++
				}
				by := u.CreatedBy
				if u.CreatedByLogin != nil {
					by = *u.CreatedByLogin
				}
				rows = append(rows, []string{u.ID, strconv.FormatInt(u.Size, 10), state, output.Clean(by), output.Time(u.CreatedAt), output.Time(u.UsableUntil)})
			}
			if err := a.printer().Table([]string{"ID", "BYTES", "STATE", "BY", "CREATED", "USABLE UNTIL"}, rows); err != nil {
				return err
			}
			if res.Next != nil {
				fmt.Fprintf(a.Err, "more: --cursor %s\n", *res.Next)
			}
			if res.Max > 0 && res.Next == nil {
				fmt.Fprintf(a.Err, "%d of %d pending places used\n", pending, res.Max)
			}
			return nil
		},
	}
	ls.Flags().IntVar(&limit, "limit", 0, "page size, 1 to 100 (default 20)")
	ls.Flags().StringVar(&cursor, "cursor", "", "the `more: --cursor …` value of the previous page")
	asServerFlag(ls, &asServer)
	var rmServer bool
	rm := &cobra.Command{
		Use:         "rm <channel> <upload>",
		Aliases:     []string{"remove"},
		Short:       "Remove an upload no running job reads (an upload in use answers upload_in_use)",
		Example:     "  yyt push upload rm alerts pu_0123abcd\n  yyt push upload rm alerts pu_0123abcd --json",
		Annotations: map[string]string{OutputAnnotation: "\"deleted <upload>\"; --json: {id,deleted:true}"},
		Args:        cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !strings.HasPrefix(args[1], "pu_") {
				return fmt.Errorf("%q is not an upload id (pu_…; yyt push upload ls %s)", args[1], args[0])
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			jc, base, err := a.campaignAPI(cc, id, rmServer)
			if err != nil {
				return err
			}
			if err := jc.Do(cmd.Context(), http.MethodDelete, base+"/uploads/"+api.PathID(args[1]), nil, nil); err != nil {
				return withCampaignHint(serverErr(err, rmServer), id)
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"id": args[1], "deleted": true})
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[1])
			return nil
		},
	}
	asServerFlag(rm, &rmServer)
	c.AddCommand(ls, rm)
	return group(c)
}

func (a *App) pushStatsCmd(resolve channelResolver) *cobra.Command {
	var days int
	c := &cobra.Command{
		Use:     "stats <channel> [--days 14]",
		Short:   "Device tokens held against the channel's cap, and the sends of the last days",
		Example: "  yyt push channel stats alerts\n  yyt push channel stats alerts --days 30 --json",
		Annotations: map[string]string{OutputAnnotation: "key/value tokens, tokenCap, since, then table DAY CALLS SENT NO TOKEN FAILED UNREGISTERED " +
			"(or \"no send in this window\"); --json: {tokens:{count,capped},tokenCap,since,days:[{day,calls,sent,noToken,failed,unregistered}]}"},
		Long: "The channel's registered device tokens against push.tokensPerChannel (a new\n" +
			"token past it is refused 409; `yyt limit request push.tokensPerChannel …`), and\n" +
			"per UTC day the sends — targeted sends and campaign jobs alike (a broadcast\n" +
			"is one call to the topic): calls, users sent, without a token, failed (of\n" +
			"which unregistered). Days without a send are left out; kept 30 days.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			path := "/channels/" + api.PathID(id) + "/push/stats"
			if days > 0 {
				path += "?days=" + strconv.Itoa(days)
			}
			var res pushStats
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			count := strconv.Itoa(res.Tokens.Count)
			if res.Tokens.Capped {
				count += " (at the cap)"
			}
			if err := a.printer().KV([][2]string{{"tokens", count}, {"tokenCap", strconv.Itoa(res.TokenCap)}, {"since", res.Since}}); err != nil {
				return err
			}
			if len(res.Days) == 0 {
				fmt.Fprintln(a.Out, "no send in this window")
				return nil
			}
			rows := make([][]string, 0, len(res.Days))
			for _, d := range res.Days {
				rows = append(rows, []string{d.Day, strconv.Itoa(d.Calls), strconv.Itoa(d.Sent), strconv.Itoa(d.NoToken), strconv.Itoa(d.Failed), strconv.Itoa(d.Unregistered)})
			}
			fmt.Fprintln(a.Out)
			return a.printer().Table([]string{"DAY", "CALLS", "SENT", "NO TOKEN", "FAILED", "UNREGISTERED"}, rows)
		},
	}
	c.Flags().IntVar(&days, "days", 0, "how many UTC days back, 1 to 30 (default 14)")
	return c
}

type pushSweepSlot struct {
	Slot            string `json:"slot"`
	Claims          int    `json:"claims"`
	FirebaseApps    *int   `json:"firebaseApps"`
	PendingDeletion *int   `json:"pendingDeletion"`
	Orphans         int    `json:"orphans"`
	Removed         int    `json:"removed"`
	Missing         int    `json:"missing"`
	Foreign         int    `json:"foreign"`
	Filled          int    `json:"filled"`
	Repaired        int    `json:"repaired"`
	Released        int    `json:"released"`
	Restored        int    `json:"restored"`
	Lost            int    `json:"lost"`
	Unread          bool   `json:"unread"`
	AutoClosed      bool   `json:"autoClosed"`
	AutoOpened      bool   `json:"autoOpened"`
}

type pushSweepRecord struct {
	At     int64 `json:"at"`
	Tokens struct {
		Channels int `json:"channels"`
		Stale    int `json:"stale"`
	} `json:"tokens"`
	Truncated bool     `json:"truncated"`
	Released  int      `json:"released"`
	Kept      int      `json:"kept"`
	Failed    []string `json:"failed"`
	Pool      *struct {
		Unreadable    bool `json:"unreadable"`
		Unprovisioned []struct {
			Slot   string `json:"slot"`
			Claims int    `json:"claims"`
		} `json:"unprovisioned"`
		Skipped []struct {
			Slot   string `json:"slot"`
			Reason string `json:"reason"`
		} `json:"skipped"`
	} `json:"pool"`
	Reconcile *struct {
		Truncated bool            `json:"truncated"`
		Slots     []pushSweepSlot `json:"slots"`
	} `json:"reconcile"`
}

func (a *App) pushSweepCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "sweep",
		Short:   "What the last daily sweep found per slot: orphans, missing and foreign apps, auto-closes (platform admin)",
		Example: "  yyt push pool sweep\n  yyt push pool sweep --json",
		Annotations: map[string]string{OutputAnnotation: "key/value at, stale tokens, claims released/kept, failed phases, truncated, then table SLOT CLAIMS APPS ORPHANS MISSING FOREIGN RESTORED LOST CLEANED AUTO " +
			"(or \"no sweep recorded in the last 8 days …\"); --json: {last:{at,tokens,released,kept,failed,pool,reconcile:{slots:[…]}}|null}"},
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var res struct {
				Last *pushSweepRecord `json:"last"`
			}
			if err := cl.Do(cmd.Context(), http.MethodGet, "/admin/push/sweep", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			if res.Last == nil {
				fmt.Fprintln(a.Out, "no sweep recorded in the last 8 days (it runs daily at 18:00 UTC)")
				return nil
			}
			l := res.Last
			failed := "-"
			if len(l.Failed) > 0 {
				failed = strings.Join(l.Failed, ",")
			}
			pairs := [][2]string{
				{"at", output.Time(l.At)},
				{"stale tokens", fmt.Sprintf("%d in %d channels", l.Tokens.Stale, l.Tokens.Channels)},
				{"claims released", strconv.Itoa(l.Released)}, {"claims kept", strconv.Itoa(l.Kept)},
				{"failed phases", failed}, {"truncated", strconv.FormatBool(l.Truncated)},
			}
			if p := l.Pool; p != nil {
				if p.Unreadable {
					pairs = append(pairs, [2]string{"pool", "unreadable"})
				}
				for _, u := range p.Unprovisioned {
					pairs = append(pairs, [2]string{"unprovisioned", fmt.Sprintf("%s (%d claims)", u.Slot, u.Claims)})
				}
				for _, s := range p.Skipped {
					pairs = append(pairs, [2]string{"skipped", s.Slot + ": " + output.Clean(s.Reason)})
				}
			}
			if err := a.printer().KV(pairs); err != nil {
				return err
			}
			if l.Reconcile == nil || len(l.Reconcile.Slots) == 0 {
				return nil
			}
			opt := func(p *int) string {
				if p == nil {
					return "-"
				}
				return strconv.Itoa(*p)
			}
			rows := make([][]string, 0, len(l.Reconcile.Slots))
			for _, s := range l.Reconcile.Slots {
				auto := "-"
				switch {
				case s.AutoClosed:
					auto = "closed"
				case s.AutoOpened:
					auto = "opened"
				}
				if s.Unread {
					auto = "unread"
				}
				rows = append(rows, []string{s.Slot, strconv.Itoa(s.Claims), opt(s.FirebaseApps), strconv.Itoa(s.Orphans), strconv.Itoa(s.Missing), strconv.Itoa(s.Foreign), strconv.Itoa(s.Restored), strconv.Itoa(s.Lost), strconv.Itoa(s.Removed + s.Released), auto})
			}
			fmt.Fprintln(a.Out)
			if err := a.printer().Table([]string{"SLOT", "CLAIMS", "APPS", "ORPHANS", "MISSING", "FOREIGN", "RESTORED", "LOST", "CLEANED", "AUTO"}, rows); err != nil {
				return err
			}
			for _, s := range l.Reconcile.Slots {
				if s.Lost > 0 {
					fmt.Fprintf(a.Err, "note: %s: %d push channel(s) lost their Firebase app for good; their claim was released and they must be recreated\n", s.Slot, s.Lost)
				}
			}
			if l.Reconcile.Truncated {
				fmt.Fprintln(a.Err, "note: the reconciliation stopped early; the next sweep continues")
			}
			return nil
		},
	}
}
