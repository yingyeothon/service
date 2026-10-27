package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Catalog share links (docs/decisions.md *Catalog share links and install
// bridge*): an install page link for an app, either a token link that expires
// in 1, 7 or 30 days (its URL is returned once, by create) or the permanent
// link a public listing has. The commands map 1:1 onto the console's
// share-link routes; `<app>` resolves like every other catalog command.

type shareLink struct {
	ID        string  `json:"id"`
	Label     *string `json:"label"`
	CreatedBy *string `json:"createdBy"`
	CreatedAt int64   `json:"createdAt"`
	ExpiresAt int64   `json:"expiresAt"`
	RevokedAt *int64  `json:"revokedAt"`
	Live      bool    `json:"live"`
}

type shareLinkList struct {
	Links     []shareLink `json:"links"`
	PublicURL *string     `json:"publicUrl"`
	Limit     int         `json:"limit"`
}

// shareStatus is a link's one-word state; revoked wins over expired.
func shareStatus(l shareLink) string {
	switch {
	case l.RevokedAt != nil:
		return "revoked"
	case l.Live:
		return "live"
	default:
		return "expired"
	}
}

func newCatalogShareCommand(a *App, appID appResolver) *cobra.Command {
	p := func() output.Printer { return a.printer() }
	// shareDo resolves <app> then issues one request under its share-links path.
	shareDo := func(cmd *cobra.Command, write bool, method, arg, suffix string, in, out any) error {
		cc, id, err := appID(cmd, arg, write)
		if err != nil {
			return err
		}
		return cc.cl.Do(cmd.Context(), method, "/catalog/apps/"+api.PathID(id)+"/share-links"+suffix, in, out)
	}
	// printRaw prints a server body as sent, so `--json` never drops a field.
	printRaw := func(raw json.RawMessage) error {
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return err
		}
		return p().JSONValue(v)
	}

	share := &cobra.Command{
		Use:   "share",
		Short: "Install page links for an app: expiring token links and the public listing's link",
		Long: "Install page links for an app. A token link opens the install page for the app's\n" +
			"newest artifact per platform until it expires (1, 7 or 30 days) or is revoked; it\n" +
			"works whether or not the app is listed, and its URL is shown only once, at create.\n" +
			"An app whose listing is public also has a permanent link (`share public`).\n" +
			"At most 20 token links per app are live at a time.",
	}

	var days int
	var label string
	create := &cobra.Command{
		Use:   "create <app> [--days 1|7|30] [--label text]",
		Short: "Create a token link and print its URL (shown only this once)",
		Example: "  yyt catalog share create my-game\n" +
			"  yyt catalog share create my-game --days 30 --label \"playtest group\"\n" +
			"  yyt catalog share create ca_0123 --days 1 --json",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if days != 1 && days != 7 && days != 30 {
				return errors.New("--days must be 1, 7 or 30")
			}
			body := map[string]any{"expiresInDays": days}
			if cmd.Flags().Changed("label") {
				l := strings.TrimSpace(label)
				if utf8.RuneCountInString(l) > 100 {
					return errors.New("--label is at most 100 characters")
				}
				if strings.IndexFunc(l, unicode.IsControl) >= 0 {
					return errors.New("--label must not contain control characters")
				}
				if l != "" {
					body["label"] = l
				}
			}
			var raw json.RawMessage
			if err := shareDo(cmd, true, http.MethodPost, args[0], "", body, &raw); err != nil {
				var ae *api.Error
				if errors.As(err, &ae) && ae.Status == http.StatusConflict {
					return fmt.Errorf("%w\nrevoke one first: yyt catalog share ls %s; yyt catalog share rm %s <id>", err, args[0], args[0])
				}
				return err
			}
			if a.jsonOut {
				return printRaw(raw)
			}
			var v struct {
				shareLink
				URL string `json:"url"`
			}
			if err := json.Unmarshal(raw, &v); err != nil {
				return err
			}
			fmt.Fprintln(a.Out, output.Clean(v.URL))
			fmt.Fprintf(a.Err, "share link %s expires %s; the URL is not shown again\n", v.ID, output.Time(v.ExpiresAt))
			return nil
		},
	}
	create.Flags().IntVar(&days, "days", 7, "days until the link expires: 1, 7 or 30")
	create.Flags().StringVar(&label, "label", "", "the team's own note (max 100 chars, never shown to a recipient)")

	ls := &cobra.Command{
		Use:     "ls <app>",
		Aliases: []string{"list"},
		Short:   "List the app's token links (live, expired and revoked) and its public link",
		Example: "  yyt catalog share ls my-game\n" +
			"  yyt catalog share ls my-game --json",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var raw json.RawMessage
			if err := shareDo(cmd, false, http.MethodGet, args[0], "", nil, &raw); err != nil {
				return err
			}
			if a.jsonOut {
				return printRaw(raw)
			}
			var res shareLinkList
			if err := json.Unmarshal(raw, &res); err != nil {
				return err
			}
			rows := make([][]string, 0, len(res.Links))
			for _, l := range res.Links {
				rows = append(rows, []string{
					l.ID, output.Str(l.Label), output.Str(l.CreatedBy),
					output.Time(l.CreatedAt), output.Time(l.ExpiresAt), shareStatus(l),
				})
			}
			if err := p().Table([]string{"ID", "LABEL", "BY", "CREATED", "EXPIRES", "STATUS"}, rows); err != nil {
				return err
			}
			if res.PublicURL != nil && *res.PublicURL != "" {
				fmt.Fprintf(a.Out, "public link: %s\n", output.Clean(*res.PublicURL))
			}
			return nil
		},
	}

	rm := &cobra.Command{
		Use:     "rm <app> <id>",
		Aliases: []string{"remove", "revoke", "delete"},
		Short:   "Revoke a token link (revoking twice is a no-op)",
		Example: "  yyt catalog share rm my-game shl_01J…",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := shareDo(cmd, true, http.MethodDelete, args[0], "/"+api.PathID(args[1]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "revoked %s\n", output.Clean(args[1]))
			return nil
		},
	}

	public := &cobra.Command{
		Use:   "public <app>",
		Short: "Print the permanent link of a public listing",
		Long: "Print the app's permanent install page link. It exists only while the app's\n" +
			"listing is published with `--audience public` and not taken down.",
		Example: "  yyt catalog share public my-game",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res shareLinkList
			if err := shareDo(cmd, false, http.MethodGet, args[0], "", nil, &res); err != nil {
				return err
			}
			if res.PublicURL == nil || *res.PublicURL == "" {
				return fmt.Errorf("%s has no public link: its listing must be published as public "+
					"(yyt catalog publish %s --title <title> --audience public) and not taken down; "+
					"use `yyt catalog share create %s` for an expiring link instead",
					args[0], args[0], args[0])
			}
			if a.jsonOut {
				return p().JSONValue(map[string]string{"publicUrl": *res.PublicURL})
			}
			fmt.Fprintln(a.Out, output.Clean(*res.PublicURL))
			return nil
		},
	}

	share.AddCommand(create, ls, rm, public)
	return group(share)
}
