package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Views mirror services/console/src/kvstore.ts. A collection is a project
// resource like a site; its entries are the rows a game reads and writes
// through the KV API on the state stack, and this is the console-side view
// of the same rows (docs/decisions.md *Key-value store (`kv`)*).
type kvCollection struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Description        *string `json:"description,omitempty"`
	ReadScope          string  `json:"readScope"`
	WriteScope         string  `json:"writeScope"`
	Encrypted          bool    `json:"encrypted"`
	MaxEntries         int     `json:"maxEntries"`
	MaxEntriesPerOwner int     `json:"maxEntriesPerOwner"`
	// The live count; on the list and the detail alike.
	Entries     *int    `json:"entries,omitempty"`
	TeamID      *string `json:"teamId"`
	TeamName    *string `json:"teamName"`
	ProjectID   *string `json:"projectId"`
	ProjectName *string `json:"projectName"`
	CreatedBy   *string `json:"createdBy"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	// Only on the detail and create routes.
	API *kvAPI `json:"api,omitempty"`
}

type kvAPI struct {
	Configured  bool   `json:"configured"`
	BaseURL     string `json:"baseUrl"`
	MetaPath    string `json:"metaPath"`
	EntriesPath string `json:"entriesPath"`
	OwnerPath   string `json:"ownerPath,omitempty"`
}

type kvEntry struct {
	Owner     *string `json:"owner,omitempty"`
	Key       string  `json:"key"`
	Version   int64   `json:"version"`
	Bytes     int     `json:"bytes"`
	ExpiresAt *int64  `json:"expiresAt"`
	ChannelID *string `json:"channelId"`
	UpdatedAt int64   `json:"updatedAt"`
	// Absent for an encrypted collection and for a seatless admin.
	ValueText *string `json:"valueText,omitempty"`
}

type kvEntryPage struct {
	Entries    []kvEntry `json:"entries"`
	NextCursor string    `json:"nextCursor,omitempty"`
}

type kvPutResult struct {
	Owner   *string `json:"owner,omitempty"`
	Key     string  `json:"key"`
	Version int64   `json:"version"`
	Bytes   int     `json:"bytes"`
	Created bool    `json:"created"`
}

var kvScopes = []string{"team", "project", "user"}

func newKvStore(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "kv",
		Short: "Key-value collections: small JSON values a game reads and writes through the KV API (a collection belongs to a project)",
		Long: "Key-value collections under a project: announcements, per-player progress,\n" +
			"public profiles. A collection's read and write scopes say who may reach it\n" +
			"through the KV API on the state stack — `team` (console and `yyt kv` only),\n" +
			"`project` (every player and the server key), `user` (each player its own\n" +
			"namespace; the server key every namespace). The scopes and the encryption\n" +
			"flag are fixed at creation.\n\n" +
			"Values are JSON text stored byte for byte as sent (at most 16 KiB). An\n" +
			"encrypted collection's values can be written and read only through the KV\n" +
			"API; here they show as keys, sizes and times, and can be deleted.\n\n" +
			"<kv> is an id (kv_…) or a name unique within the team; a name is looked up\n" +
			"in the project context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`). `create` needs an explicit context.",
	}
	kvID := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.kv(cmd.Context(), arg, write)
		return cc, id, err
	}
	entry := group(&cobra.Command{
		Use:   "entry",
		Short: "One entry: get, put, delete",
	})
	entry.AddCommand(
		newKvEntryGet(a, kvID),
		newKvEntryPut(a, kvID),
		newKvEntryDelete(a, kvID),
		newKvEntryClear(a, kvID),
	)
	c.AddCommand(
		newKvList(a),
		newKvCreate(a),
		newResourceGet(kvID, "get <kv>", "Show one collection with its scopes, caps, entry count and KV API paths", "/kv", a.printKvCollection),
		newKvUpdate(a, kvID),
		newResourceDelete(a, kvID, "delete <kv>", "Delete a collection and every entry in it (large ones drain in the background)", "/kv"),
		newKvEntries(a, kvID),
		entry,
	)
	return group(c)
}

func (c *ctxClient) kv(ctx context.Context, arg string, write bool) (string, error) {
	return c.resource(ctx, "kv", "/kv", "collections", arg, write)
}

func (a *App) printKvCollection(k kvCollection) error {
	if a.jsonOut {
		return a.printer().JSONValue(k)
	}
	pairs := [][2]string{
		{"id", k.ID},
		{"name", k.Name},
		{"project", crumb(k.TeamName, k.ProjectName)},
		{"description", output.Str(k.Description)},
		{"readScope", k.ReadScope},
		{"writeScope", k.WriteScope},
		{"encrypted", fmt.Sprint(k.Encrypted)},
		{"maxEntries", fmt.Sprint(k.MaxEntries)},
		{"maxEntriesPerOwner", fmt.Sprint(k.MaxEntriesPerOwner)},
	}
	if k.Entries != nil {
		pairs = append(pairs, [2]string{"entries", fmt.Sprint(*k.Entries)})
	}
	pairs = append(pairs,
		[2]string{"createdBy", output.Str(k.CreatedBy)},
		[2]string{"created", output.Time(k.CreatedAt)},
		[2]string{"updated", output.Time(k.UpdatedAt)},
	)
	if k.API != nil {
		pairs = append(pairs,
			[2]string{"apiConfigured", fmt.Sprint(k.API.Configured)},
			[2]string{"apiBase", k.API.BaseURL},
			[2]string{"apiMeta", k.API.MetaPath},
			[2]string{"apiEntries", k.API.EntriesPath},
		)
		if k.API.OwnerPath != "" {
			pairs = append(pairs, [2]string{"apiOwner", k.API.OwnerPath})
		}
	}
	return a.printer().KV(pairs)
}

func newKvList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the collections of the project in context",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), false)
			if err != nil {
				return err
			}
			var res struct {
				Collections []kvCollection `json:"collections"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/projects/"+api.PathID(r.ProjectID)+"/kv", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Collections))
			for _, k := range res.Collections {
				entries := "-"
				if k.Entries != nil {
					entries = fmt.Sprint(*k.Entries)
				}
				rows = append(rows, []string{k.ID, k.Name, k.ReadScope, k.WriteScope, fmt.Sprint(k.Encrypted), entries, output.Time(k.UpdatedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "READ", "WRITE", "ENCRYPTED", "ENTRIES", "UPDATED"}, rows)
		},
	}
}

func newKvCreate(a *App) *cobra.Command {
	var description, readScope, writeScope string
	var encrypted bool
	var maxEntries, maxEntriesPerOwner int
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a collection in the project context (explicit); scopes and encryption are fixed for good",
		Long: "Create a collection. --read and --write are one of team, project, user.\n" +
			"A user read scope needs a user write scope; an encrypted collection needs\n" +
			"project or user scopes. project-read + user-write lets every player list\n" +
			"every owner's entries. None of the three can be changed afterwards.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			for _, s := range []string{readScope, writeScope} {
				if !contains(kvScopes, s) {
					return fmt.Errorf("scope %q: use one of %s", s, strings.Join(kvScopes, ", "))
				}
			}
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), true)
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0], "readScope": readScope, "writeScope": writeScope}
			if description != "" {
				body["description"] = description
			}
			if encrypted {
				body["encrypted"] = true
			}
			if cmd.Flags().Changed("max-entries") {
				body["maxEntries"] = maxEntries
			}
			if cmd.Flags().Changed("max-entries-per-owner") {
				body["maxEntriesPerOwner"] = maxEntriesPerOwner
			}
			var k kvCollection
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/kv", body, &k); err != nil {
				return err
			}
			return a.printKvCollection(k)
		},
	}
	f := c.Flags()
	f.StringVar(&readScope, "read", "", "read scope: team | project | user")
	f.StringVar(&writeScope, "write", "", "write scope: team | project | user")
	f.BoolVar(&encrypted, "encrypted", false, "encrypt values at rest with a key only the state stack holds (values then bypass the console)")
	f.StringVar(&description, "description", "", "human-readable description")
	f.IntVar(&maxEntries, "max-entries", 0, "entries the collection may hold (default 10000, at most 100000)")
	f.IntVar(&maxEntriesPerOwner, "max-entries-per-owner", 0, "entries one player may hold in its namespace (default 100, at most 1000)")
	_ = c.MarkFlagRequired("read")
	_ = c.MarkFlagRequired("write")
	return c
}

// newKvUpdate is its own command rather than newResourceUpdate: the two caps
// are editable beside the name and description, the scopes never.
func newKvUpdate(a *App, kvID idResolver) *cobra.Command {
	var name, description string
	var maxEntries, maxEntriesPerOwner int
	c := &cobra.Command{
		Use:   "update <kv>",
		Short: "Rename a collection, change its description or its caps (scopes and encryption are fixed)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			nullableDesc(cmd, "description", description, body, "description")
			if cmd.Flags().Changed("max-entries") {
				body["maxEntries"] = maxEntries
			}
			if cmd.Flags().Changed("max-entries-per-owner") {
				body["maxEntriesPerOwner"] = maxEntriesPerOwner
			}
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass --name, --description, --max-entries and/or --max-entries-per-owner")
			}
			cc, id, err := kvID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var k kvCollection
			if err := cc.cl.Do(cmd.Context(), http.MethodPatch, "/kv/"+api.PathID(id), body, &k); err != nil {
				return err
			}
			return a.printKvCollection(k)
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "new collection name (unique within the team)")
	f.StringVar(&description, "description", "", "new description (empty clears it)")
	f.IntVar(&maxEntries, "max-entries", 0, "new cap on entries (1..100000)")
	f.IntVar(&maxEntriesPerOwner, "max-entries-per-owner", 0, "new cap on one player's entries (1..1000)")
	return c
}

// kvEntryPath is `/kv/{id}/entries/{key}` plus `?owner=` when one is named.
func kvEntryPath(id, key, owner string) string {
	p := "/kv/" + api.PathID(id) + "/entries/" + api.PathID(key)
	if owner != "" {
		p += "?owner=" + url.QueryEscape(owner)
	}
	return p
}

func (a *App) printKvEntries(rows []kvEntry, next string) error {
	if a.jsonOut {
		v := map[string]any{"entries": rows}
		if next != "" {
			v["nextCursor"] = next
		}
		return a.printer().JSONValue(v)
	}
	out := make([][]string, 0, len(rows))
	for _, e := range rows {
		value := "-"
		if e.ValueText != nil {
			// The table is a glance; a 16 KiB value would make it unreadable.
			// `entry get` and --json carry the whole text.
			value = truncateRunes(*e.ValueText, kvValueColumnRunes)
		}
		out = append(out, []string{output.Str(e.Owner), e.Key, fmt.Sprint(e.Version), fmt.Sprint(e.Bytes), output.TimePtr(e.ExpiresAt), output.Time(e.UpdatedAt), value})
	}
	if err := a.printer().Table([]string{"OWNER", "KEY", "VERSION", "BYTES", "EXPIRES", "UPDATED", "VALUE"}, out); err != nil {
		return err
	}
	if next != "" {
		fmt.Fprintf(a.Err, "more: --cursor %s (or --all)\n", next)
	}
	return nil
}

func newKvEntries(a *App, kvID idResolver) *cobra.Command {
	var prefix, owner, cursor string
	var limit int
	var all bool
	c := &cobra.Command{
		Use:   "entries <kv>",
		Short: "List the entries of a collection (one page; --all walks every page)",
		Long: "List entries. A collection with a user write scope keeps one namespace per\n" +
			"owner: --owner shows one player's rows, none shows every owner's. Values\n" +
			"are shown for a plaintext collection you are seated for; an encrypted one\n" +
			"lists keys, sizes and times only.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := kvID(cmd, args[0], false)
			if err != nil {
				return err
			}
			var rows []kvEntry
			next := cursor
			for {
				q := url.Values{}
				if prefix != "" {
					q.Set("prefix", prefix)
				}
				if owner != "" {
					q.Set("owner", owner)
				}
				if next != "" {
					q.Set("cursor", next)
				}
				if limit > 0 {
					q.Set("limit", fmt.Sprint(limit))
				}
				path := "/kv/" + api.PathID(id) + "/entries"
				if len(q) > 0 {
					path += "?" + q.Encode()
				}
				var page kvEntryPage
				if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &page); err != nil {
					return err
				}
				rows = append(rows, page.Entries...)
				next = page.NextCursor
				if !all || next == "" {
					break
				}
			}
			return a.printKvEntries(rows, next)
		},
	}
	f := c.Flags()
	f.StringVar(&prefix, "prefix", "", "only keys starting with this")
	f.StringVar(&owner, "owner", "", "one owner's namespace (user write scope only)")
	f.StringVar(&cursor, "cursor", "", "continue from a previous page")
	f.IntVar(&limit, "limit", 0, "page size (1..100, default 50)")
	f.BoolVar(&all, "all", false, "follow the cursor until the end")
	return c
}

func newKvEntryGet(a *App, kvID idResolver) *cobra.Command {
	var owner string
	c := &cobra.Command{
		Use:   "get <kv> <key>",
		Short: "Print one entry's value as stored (--json: the whole entry)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := kvID(cmd, args[0], false)
			if err != nil {
				return err
			}
			var e kvEntry
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, kvEntryPath(id, args[1], owner), nil, &e); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(e)
			}
			if e.ValueText == nil {
				// Encrypted, or no seat: the shape is all the console has.
				return a.printer().KV([][2]string{
					{"owner", output.Str(e.Owner)}, {"key", e.Key}, {"version", fmt.Sprint(e.Version)},
					{"bytes", fmt.Sprint(e.Bytes)}, {"expires", output.TimePtr(e.ExpiresAt)}, {"updated", output.Time(e.UpdatedAt)},
					{"value", "(not readable here)"},
				})
			}
			// The value verbatim, for a pipe. Safe without textsafe.Clean because
			// both writers admit only valid JSON, and JSON forbids raw U+0000–001F
			// everywhere — the class Clean strips — so a stored value cannot carry
			// an escape sequence; an escaped `\u001b` prints as six plain bytes.
			// Cleaning would corrupt the one thing this command exists to hand over.
			_, err = fmt.Fprint(a.Out, *e.ValueText)
			return err
		},
	}
	c.Flags().StringVar(&owner, "owner", "", "the owner's namespace (user write scope only)")
	return c
}

func newKvEntryPut(a *App, kvID idResolver) *cobra.Command {
	var owner, value, file string
	var ttl int
	var ifVersion int64
	c := &cobra.Command{
		Use:   "put <kv> <key>",
		Short: "Create or replace one entry from --value, --file or stdin (JSON, at most 16 KiB)",
		Long: "Write one entry. The value is JSON text, stored byte for byte: --value '{…}',\n" +
			"--file path, or stdin when neither is given. --ttl sets an expiry in seconds\n" +
			"(0 clears one; omitted keeps whatever the row has). --if-version makes the\n" +
			"write conditional on the stored version, a compare-and-set: a mismatch is\n" +
			"answered with a conflict that names the current version.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			text, err := kvValueOf(cmd, value, file, a.In)
			if err != nil {
				return err
			}
			if !json.Valid([]byte(text)) {
				return fmt.Errorf("the value is not valid JSON")
			}
			body := map[string]any{"valueText": text}
			if owner != "" {
				body["owner"] = owner
			}
			if cmd.Flags().Changed("ttl") {
				body["ttl"] = ttl
			}
			if cmd.Flags().Changed("if-version") {
				body["ifVersion"] = ifVersion
			}
			cc, id, err := kvID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var r kvPutResult
			if err := cc.cl.Do(cmd.Context(), http.MethodPut, kvEntryPath(id, args[1], ""), body, &r); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(r)
			}
			verb := "updated"
			if r.Created {
				verb = "created"
			}
			fmt.Fprintf(a.Out, "%s %s (version %d, %d bytes)\n", verb, args[1], r.Version, r.Bytes)
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&owner, "owner", "", "the owner's namespace (user write scope only)")
	f.StringVar(&value, "value", "", "the JSON value")
	f.StringVar(&file, "file", "", "read the JSON value from this file")
	f.IntVar(&ttl, "ttl", 0, "expiry in seconds (0 clears; omitted keeps)")
	f.Int64Var(&ifVersion, "if-version", 0, "write only if the stored version is this one")
	return c
}

// kvValueOf picks the one source of the value: --value, --file, or stdin.
func kvValueOf(cmd *cobra.Command, value, file string, in io.Reader) (string, error) {
	hasValue := cmd.Flags().Changed("value")
	hasFile := file != ""
	switch {
	case hasValue && hasFile:
		return "", fmt.Errorf("pass --value or --file, not both")
	case hasValue:
		return value, nil
	case hasFile:
		b, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	if in == nil {
		in = os.Stdin
	}
	b, err := io.ReadAll(in)
	if err != nil {
		return "", err
	}
	if len(b) == 0 {
		return "", fmt.Errorf("no value: pass --value, --file, or pipe the JSON on stdin")
	}
	return string(b), nil
}

func newKvEntryDelete(a *App, kvID idResolver) *cobra.Command {
	var owner string
	c := &cobra.Command{
		Use:     "delete <kv> <key>",
		Aliases: []string{"rm", "remove"},
		Short:   "Delete one entry (allowed on an encrypted collection too)",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := kvID(cmd, args[0], true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, kvEntryPath(id, args[1], owner), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[1])
			return nil
		},
	}
	c.Flags().StringVar(&owner, "owner", "", "the owner's namespace (user write scope only)")
	return c
}

func newKvEntryClear(a *App, kvID idResolver) *cobra.Command {
	var owner string
	c := &cobra.Command{
		Use:   "clear <kv> [--owner <id>]",
		Short: "Delete every entry of one owner (user write scope), or of the shared namespace; repeats until nothing is left",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := kvID(cmd, args[0], true)
			if err != nil {
				return err
			}
			total := 0
			for {
				var r struct {
					Deleted   int  `json:"deleted"`
					Truncated bool `json:"truncated"`
				}
				path := "/kv/" + api.PathID(id) + "/entries"
				if owner != "" {
					path += "?owner=" + url.QueryEscape(owner)
				}
				if err := cc.cl.Do(cmd.Context(), http.MethodDelete, path, nil, &r); err != nil {
					return err
				}
				total += r.Deleted
				if !r.Truncated {
					break
				}
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"deleted": total})
			}
			if owner == "" {
				fmt.Fprintf(a.Out, "deleted %d entries\n", total)
			} else {
				fmt.Fprintf(a.Out, "deleted %d entries of %s\n", total, owner)
			}
			return nil
		},
	}
	c.Flags().StringVar(&owner, "owner", "", "the owner whose namespace is emptied (user write scope); omitted = the shared namespace")
	return c
}

// kvValueColumnRunes bounds the VALUE column of `kv entries`.
const kvValueColumnRunes = 60

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
