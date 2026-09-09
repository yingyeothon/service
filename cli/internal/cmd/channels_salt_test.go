package cmd

import (
	"strings"
	"testing"
)

// An auth channel created before player ids were salted derives them from
// public inputs, so a listed id can be traced back to the provider account it
// came from. The CLI has to say so where an owner will see it, and has to stay
// quiet on the normal case (`docs/decisions.md` *Player ids are salted per
// auth channel*).
func TestChannelsGetWarnsOnlyOnUnsaltedPlayerIds(t *testing.T) {
	channel := func(salted any) map[string]any {
		c := map[string]any{}
		for k, v := range sampleChannel {
			c[k] = v
		}
		if salted != nil {
			c["saltedIds"] = salted
		}
		return c
	}
	const warn = "not salted"

	for _, tc := range []struct {
		name   string
		salted any
		want   bool
	}{
		{"unsalted", false, true},
		{"salted", true, false},
		// An older console that does not send the field at all: absent is not
		// `false`, and guessing either way would be a lie.
		{"absent", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := channel(tc.salted)
			f := newFake(t, map[string]func(recorded) (int, any){
				"GET /channels/auth_0123": func(recorded) (int, any) { return 200, body },
			})
			out, _, err := run(t, f, "channels", "get", "auth_0123")
			if err != nil {
				t.Fatalf("run: %v", err)
			}
			if got := strings.Contains(out, warn); got != tc.want {
				t.Fatalf("warning present=%v want=%v in\n%s", got, tc.want, out)
			}
		})
	}
}
