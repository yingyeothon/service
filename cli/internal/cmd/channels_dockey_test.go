package cmd

import (
	"strings"
	"testing"
)

func TestChannelsDocKey(t *testing.T) {
	apiKey := "yds.auth_9." + strings.Repeat("ab", 32)
	block := map[string]any{
		"channelId": "auth_9",
		"docUrl":    "https://doc-dev.yyt.life",
		"writePath": "/s/{ownerId}",
	}
	show := map[string]any{"issued": false, "documents": 0}
	issued := map[string]any{"issued": true, "apiKey": apiKey}
	for k, v := range block {
		show[k] = v
		issued[k] = v
	}
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /channels/auth_9/doc-key":    func(recorded) (int, any) { return 200, show },
		"POST /channels/auth_9/doc-key":   func(recorded) (int, any) { return 200, issued },
		"DELETE /channels/auth_9/doc-key": func(recorded) (int, any) { return 200, map[string]any{"revoked": true} },
	})

	out, _, err := run(t, f, "channels", "doc-key", "show", "auth_9")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"auth_9", "https://doc-dev.yyt.life", "/s/{ownerId}", "issued", "false", "documents"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
	// The key is minted once and never read back; `show` must not imply otherwise.
	if strings.Contains(out, apiKey) {
		t.Fatalf("show must not print the key: %s", out)
	}

	out, errOut, err := run(t, f, "channels", "doc-key", "issue", "auth_9")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, apiKey) {
		t.Fatalf("issue must print the key once: %s", out)
	}
	if !strings.Contains(errOut, "not shown again") {
		t.Fatalf("issue must warn the key is shown once: %s", errOut)
	}

	out, _, err = run(t, f, "channels", "doc-key", "revoke", "auth_9")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "revoked the document key of auth_9") {
		t.Fatalf("unexpected revoke output: %s", out)
	}

	none := newFake(t, map[string]func(recorded) (int, any){
		"DELETE /channels/auth_9/doc-key": func(recorded) (int, any) { return 200, map[string]any{"revoked": false} },
	})
	out, _, err = run(t, none, "channels", "doc-key", "revoke", "auth_9")
	if err != nil {
		t.Fatal(err)
	}
	// Revoking twice is not an error; the second call has nothing to remove.
	if !strings.Contains(out, "had no document key") {
		t.Fatalf("unexpected empty revoke output: %s", out)
	}
}
