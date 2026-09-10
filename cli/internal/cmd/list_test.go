package cmd

import (
	"strings"
	"testing"
)

// The client half of `docs/decisions.md` *List sort and filter*: the flags
// reach the query, an unknown value is refused before the request is sent, and
// the one pair the route rejects (`--sort role --scope all`) is refused here
// too. The SPA has had these controls since `todo/31`; `yyt` sent none of them.
func TestListSortOrderSearchFlags(t *testing.T) {
	withProject(t)
	empty := func(key string) func(recorded) (int, any) {
		return func(recorded) (int, any) { return 200, map[string]any{key: []any{}} }
	}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /events": empty("events"),
		"GET /shows":  empty("shows"),
	}, nil, nil, nil))

	last := func() string { return f.reqs[len(f.reqs)-1].Path }
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"team", "ls", "--sort", "updatedAt", "--order", "desc"},
			"/teams?order=desc&sort=updatedAt"},
		{[]string{"team", "ls", "--q", "doo"}, "/teams?q=doo"},
		{[]string{"project", "ls", "--sort", "name", "--q", "ga me"},
			"/teams/team_1/projects?q=ga+me&sort=name"},
		{[]string{"channels", "ls", "--sort", "expiresAt", "--kind", "auth"},
			"/projects/prj_1/channels?kind=auth&sort=expiresAt"},
		{[]string{"events", "ls", "--sort", "startsAt", "--order", "asc"},
			"/events?order=asc&sort=startsAt"},
		// Cursor-paged: `--q` only, because the cursor pins the order.
		{[]string{"show", "ls", "--q", "jam"}, "/shows?q=jam"},
		// Nothing asked for, nothing sent.
		{[]string{"events", "ls"}, "/events"},
	} {
		if _, _, err := run(t, f, c.args...); err != nil {
			t.Fatalf("%v: %v", c.args, err)
		}
		if got := last(); got != c.want {
			t.Errorf("%v -> %s, want %s", c.args, got, c.want)
		}
	}

	// Refused before the request, with the vocabulary in the message: a flag
	// whose valid values are discoverable only by being rejected is not a flag.
	for _, c := range [][]string{
		{"team", "ls", "--sort", "nope"},
		{"team", "ls", "--order", "sideways"},
		{"events", "ls", "--sort", "name"},
	} {
		before := len(f.reqs)
		_, _, err := run(t, f, c...)
		if err == nil || !strings.Contains(err.Error(), "must be") {
			t.Fatalf("%v: %v", c, err)
		}
		if len(f.reqs) != before {
			t.Fatalf("%v sent a request anyway", c)
		}
	}
	// `role` is the caller's own seat; an admin listing every team has none.
	if _, _, err := run(t, f, "team", "ls", "--scope", "all", "--sort", "role"); err == nil {
		t.Fatal("--sort role with --scope all must be refused")
	}
	if _, _, err := run(t, f, "team", "ls", "--sort", "role"); err != nil {
		t.Fatalf("--sort role without --scope: %v", err)
	}
}
