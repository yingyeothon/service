package cmd

import (
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/spf13/cobra"
)

/*
 * The client half of `docs/decisions.md` *List sort and filter*. Every console
 * list route validates `sort` against its own vocabulary — the response field
 * names, not column names — plus `order` and, where the list searches, `q`.
 * The SPA has had the controls since `todo/31`; `yyt` sent none of them, so a
 * `--json` caller had to sort a page that the server had already ordered
 * differently, and searching meant fetching everything.
 *
 * The vocabularies are repeated here rather than fetched: they are part of each
 * command's `--help`, and a flag whose valid values are only discoverable by
 * being rejected is not a flag. `--kind` on `channels list` has been validated
 * this way since it was written.
 */

type listOpts struct {
	sort     string
	order    string
	q        string
	sortKeys []string
	hasQ     bool
}

// addListFlags registers `--sort`/`--order` (and `--q` for a searchable list)
// on a list command. `what` names what the search matches, since it differs per
// route (a team's name, an event's title).
func addListFlags(c *cobra.Command, sortKeys []string, what string) *listOpts {
	o := &listOpts{sortKeys: sortKeys, hasQ: what != ""}
	c.Flags().StringVar(&o.sort, "sort", "", "sort by "+strings.Join(sortKeys, "|"))
	c.Flags().StringVar(&o.order, "order", "", "asc|desc (default: the sort key's own)")
	if o.hasQ {
		c.Flags().StringVar(&o.q, "q", "", "search by "+what)
	}
	return o
}

// apply writes the chosen values into a query, refusing a value the route would
// answer 400 for.
func (o *listOpts) apply(v url.Values) error {
	if o.sort != "" {
		if !slices.Contains(o.sortKeys, o.sort) {
			return fmt.Errorf("--sort must be %s (got %q)", strings.Join(o.sortKeys, "|"), o.sort)
		}
		v.Set("sort", o.sort)
	}
	if o.order != "" {
		if o.order != "asc" && o.order != "desc" {
			return fmt.Errorf("--order must be asc|desc (got %q)", o.order)
		}
		v.Set("order", o.order)
	}
	// An empty `q` is dropped rather than sent: the route treats it as absent
	// anyway, and a bare `--q ''` should not look like a filter in the URL.
	if o.q != "" {
		v.Set("q", o.q)
	}
	return nil
}

// restrict narrows the vocabulary for this invocation, for a sort key that
// another flag makes meaningless. `listOpts` belongs to one command tree and
// the tree is rebuilt per process, so this cannot leak into another run.
func (o *listOpts) restrict(keys []string) { o.sortKeys = keys }

// query returns `?a=b&…`, or "" when nothing was asked for.
func (o *listOpts) query(extra url.Values) (string, error) {
	v := url.Values{}
	for k, vals := range extra {
		for _, s := range vals {
			v.Add(k, s)
		}
	}
	if err := o.apply(v); err != nil {
		return "", err
	}
	if len(v) == 0 {
		return "", nil
	}
	return "?" + v.Encode(), nil
}

// The sort vocabularies, mirroring `packages/console-db`'s `*_SORT_KEYS`.
var (
	teamSortKeys = []string{"name", "role", "createdBy", "updatedAt"}
	// `role` is the caller's own seat, which an admin listing every team does
	// not have — the route refuses it with `--scope all`.
	allTeamSortKeys = []string{"name", "createdBy", "updatedAt"}
	projectSortKeys = []string{"name", "description", "createdBy", "updatedAt"}
	channelSortKeys = []string{"name", "kind", "projectName", "id", "status", "expiresAt"}
	eventSortKeys   = []string{"title", "status", "startsAt", "place", "createdBy"}
)
