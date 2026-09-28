package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Catalog listings (docs/decisions.md *Catalog listings*): a team publishes an
// app to anyone or to the platform members it names; a listing always points
// at the app's newest artifact per platform. The commands map 1:1 onto the
// console's listing routes; `<app>` resolves like every other catalog command.

type catalogListing struct {
	AppID       string   `json:"appId"`
	AppName     string   `json:"appName"`
	TeamID      string   `json:"teamId"`
	TeamName    *string  `json:"teamName"`
	Title       string   `json:"title"`
	Summary     *string  `json:"summary"`
	Tags        []string `json:"tags"`
	Audience    string   `json:"audience"`
	PublishedBy *string  `json:"publishedBy"`
	PublishedAt int64    `json:"publishedAt"`
	UpdatedAt   int64    `json:"updatedAt"`
	TakenDown   bool     `json:"takenDown"`
}

type catalogListingViewer struct {
	Login   *string `json:"login"`
	AddedBy *string `json:"addedBy"`
	AddedAt int64   `json:"addedAt"`
}

// publicListing is a row of GET /catalog/listings: what a reader gets.
type publicListing struct {
	AppID       string            `json:"appId"`
	AppName     string            `json:"appName"`
	TeamName    *string           `json:"teamName"`
	Title       string            `json:"title"`
	Summary     *string           `json:"summary"`
	Tags        []string          `json:"tags"`
	Audience    string            `json:"audience"`
	PublishedAt int64             `json:"publishedAt"`
	UpdatedAt   int64             `json:"updatedAt"`
	Artifacts   []catalogArtifact `json:"artifacts"`
}

func newCatalogListingCommands(a *App, appID appResolver) []*cobra.Command {
	p := func() output.Printer { return a.printer() }
	// listingDo resolves <app> then issues one request under its listing path.
	listingDo := func(cmd *cobra.Command, write bool, method, arg, suffix string, in, out any) error {
		cc, id, err := appID(cmd, arg, write)
		if err != nil {
			return err
		}
		return cc.cl.Do(cmd.Context(), method, "/catalog/apps/"+api.PathID(id)+"/listing"+suffix, in, out)
	}
	printListing := func(v catalogListing) error {
		if a.jsonOut {
			return p().JSONValue(v)
		}
		pairs := [][2]string{
			{"app", v.AppName + " (" + v.AppID + ")"},
			{"team", output.Str(v.TeamName)},
			{"title", v.Title},
			// A summary may span lines; a key/value line shows its first.
			{"summary", firstLine(output.Str(v.Summary))},
			{"tags", strings.Join(v.Tags, " ")},
			{"audience", v.Audience},
			{"publishedBy", output.Str(v.PublishedBy)},
			{"published", output.Time(v.PublishedAt)},
			{"updated", output.Time(v.UpdatedAt)},
		}
		if v.TakenDown {
			pairs = append(pairs, [2]string{"takenDown", "true (hidden by a platform admin)"})
		}
		return p().KV(pairs)
	}

	listing := &cobra.Command{
		Use:   "listing <app>",
		Short: "Show the app's listing (how it is published)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v catalogListing
			if err := listingDo(cmd, false, http.MethodGet, args[0], "", nil, &v); err != nil {
				return err
			}
			return printListing(v)
		},
	}

	var title, summary, audience string
	var tags []string
	publish := &cobra.Command{
		Use:   "publish <app> --title <title> --audience public|members [--summary s] [--tag t]...",
		Short: "Publish the app (its newest artifact per platform) to everyone or to named members",
		Long: "Publish the app's newest artifact per platform, now and for every later upload,\n" +
			"to everyone (`--audience public`) or to the members named with `viewer add`\n" +
			"(`--audience members`). Running it again replaces title, summary, tags and\n" +
			"audience whole. A listing a platform admin took down stays hidden.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			title = strings.TrimSpace(title)
			if title == "" {
				return errors.New("--title is required")
			}
			if audience != "public" && audience != "members" {
				return errors.New("--audience must be public or members")
			}
			body := map[string]any{"title": title, "audience": audience}
			if cmd.Flags().Changed("summary") {
				body["summary"] = nullable(summary)
			}
			if tags == nil {
				tags = []string{}
			}
			body["tags"] = tags
			var v catalogListing
			if err := listingDo(cmd, true, http.MethodPut, args[0], "", body, &v); err != nil {
				return err
			}
			return printListing(v)
		},
	}
	publish.Flags().StringVar(&title, "title", "", "listing title (1-100 chars)")
	publish.Flags().StringVar(&summary, "summary", "", "summary shown to readers (omitted or empty clears it: a publish replaces the listing whole)")
	publish.Flags().StringVar(&audience, "audience", "public", "public or members")
	publish.Flags().StringArrayVar(&tags, "tag", nil, "lowercase slug tag, repeatable (max 10)")

	unpublish := &cobra.Command{
		Use:   "unpublish <app>",
		Short: "Remove the app's listing (already fetched CDN links stay valid)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := listingDo(cmd, true, http.MethodDelete, args[0], "", nil, nil); err != nil {
				return err
			}
			fmt.Fprintln(a.Out, "unpublished")
			return nil
		},
	}

	viewer := &cobra.Command{Use: "viewer", Short: "The members a `members` listing names (never a team seat)"}
	viewer.AddCommand(&cobra.Command{
		Use:   "add <app> <github-login>",
		Short: "Name an approved platform member as a reader of the listing",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var v struct {
				Login string `json:"login"`
				Added bool   `json:"added"`
			}
			if err := listingDo(cmd, true, http.MethodPost, args[0], "/viewers", map[string]any{"login": args[1]}, &v); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(v)
			}
			if v.Added {
				fmt.Fprintf(a.Out, "added %s\n", output.Clean(v.Login))
			} else {
				fmt.Fprintf(a.Out, "%s was already named\n", output.Clean(v.Login))
			}
			return nil
		},
	})
	viewer.AddCommand(&cobra.Command{
		Use:     "rm <app> <github-login>",
		Aliases: []string{"remove", "delete"},
		Short:   "Stop naming a member (does not revoke links already fetched)",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := listingDo(cmd, true, http.MethodDelete, args[0], "/viewers/"+api.PathID(args[1]), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "removed %s\n", output.Clean(args[1]))
			return nil
		},
	})
	viewer.AddCommand(&cobra.Command{
		Use:     "ls <app>",
		Aliases: []string{"list"},
		Short:   "List the named members",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Viewers []catalogListingViewer `json:"viewers"`
			}
			if err := listingDo(cmd, false, http.MethodGet, args[0], "/viewers", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return p().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Viewers))
			for _, v := range res.Viewers {
				rows = append(rows, []string{output.Str(v.Login), output.Str(v.AddedBy), output.Time(v.AddedAt)})
			}
			return p().Table([]string{"LOGIN", "ADDED_BY", "ADDED"}, rows)
		},
	})

	var q, tag, platform, sortKey, order string
	listings := &cobra.Command{
		Use:     "listings",
		Aliases: []string{"browse"},
		Short:   "Browse published apps you may read (public, named for you, or your teams')",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if sortKey != "" && sortKey != "publishedAt" && sortKey != "title" {
				return errors.New("--sort must be publishedAt or title")
			}
			if order != "" && order != "asc" && order != "desc" {
				return errors.New("--order must be asc or desc")
			}
			cl, err := a.client()
			if err != nil {
				return err
			}
			qs := url.Values{}
			for k, v := range map[string]string{"q": q, "tag": tag, "platform": platform, "sort": sortKey, "order": order} {
				if v != "" {
					qs.Set(k, v)
				}
			}
			path := "/catalog/listings"
			if len(qs) > 0 {
				path += "?" + qs.Encode()
			}
			// `--json` prints the server's rows as sent (a typed re-marshal
			// would drop `latestArtifact`/`applicationIds` and add fields
			// the public row deliberately lacks); the table reads the typed view.
			var raw json.RawMessage
			if err := cl.Do(cmd.Context(), http.MethodGet, path, nil, &raw); err != nil {
				return err
			}
			if a.jsonOut {
				var v any
				if err := json.Unmarshal(raw, &v); err != nil {
					return err
				}
				return p().JSONValue(v)
			}
			var res struct {
				Listings []publicListing `json:"listings"`
			}
			if err := json.Unmarshal(raw, &res); err != nil {
				return err
			}
			rows := make([][]string, 0, len(res.Listings))
			for _, l := range res.Listings {
				platforms := make([]string, 0, len(l.Artifacts))
				for _, art := range l.Artifacts {
					platforms = append(platforms, art.Platform)
				}
				rows = append(rows, []string{
					l.AppID, l.Title, output.Str(l.TeamName), l.Audience,
					strings.Join(l.Tags, ","), strings.Join(platforms, ","), output.Time(l.PublishedAt),
				})
			}
			return p().Table([]string{"APP", "TITLE", "TEAM", "AUDIENCE", "TAGS", "PLATFORMS", "PUBLISHED"}, rows)
		},
	}
	listings.Flags().StringVar(&q, "q", "", "search title and summary")
	listings.Flags().StringVar(&tag, "tag", "", "one tag")
	listings.Flags().StringVar(&platform, "platform", "", "only listings with an artifact of this platform")
	listings.Flags().StringVar(&sortKey, "sort", "", "publishedAt or title")
	listings.Flags().StringVar(&order, "order", "", "asc or desc")

	return []*cobra.Command{listing, publish, unpublish, group(viewer), listings}
}

// firstLine is a multi-line value as one key/value line: its first line, with
// an ellipsis when more follows.
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimRight(s[:i], "\r") + " …"
	}
	return s
}
