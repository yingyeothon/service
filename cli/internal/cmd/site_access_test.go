package cmd

import (
	"strings"
	"testing"
)

func TestSiteAuthInputAndRedaction(t *testing.T) {
	password := "1234"
	var sent map[string]any
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"PUT /sites/st_1/auth": func(r recorded) (int, any) {
			sent = r.Body
			return 202, siteWith(map[string]any{"access": map[string]any{"mode": "basic", "username": "viewer", "suspended": false, "sync": "submitted", "available": true}})
		},
	}, nil, nil, nil))
	out, errout, err := runIn(t, f, strings.NewReader(password+"\n"), "site", "auth", "set", "st_1", "--username", "viewer", "--password-stdin")
	if err != nil {
		t.Fatal(err)
	}
	if sent["password"] != password || sent["username"] != "viewer" || sent["mode"] != "basic" {
		t.Fatal("incorrect authentication payload")
	}
	if strings.Contains(out+errout, password) {
		t.Fatal("password leaked in output")
	}
	if !strings.Contains(out, "https://k3x9q2mzp.dev-g.yyt.life/") {
		t.Fatal("protected site must use its independent host")
	}
	if _, _, err = run(t, f, "site", "auth", "clear", "st_1"); err == nil {
		t.Fatal("public transition needs explicit confirmation")
	}
}

func TestSiteAuthUnicodeAndMinimum(t *testing.T) {
	for _, value := range []string{"가나다라", "🔑🌿🌙🍀", strings.Repeat("🔑", 128)} {
		t.Run(value[:4], func(t *testing.T) {
			f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){"PUT /sites/st_1/auth": func(r recorded) (int, any) {
				if r.Body["password"] != value {
					t.Fatal("credentials changed")
				}
				return 202, sampleSite
			}}, nil, nil, nil))
			if _, _, err := runIn(t, f, strings.NewReader(value+"\n"), "site", "auth", "set", "st_1", "--username", "viewer", "--password-stdin"); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, value := range []string{"abc", "🔑🔑🔑", strings.Repeat("x", 129), "ab\ncd"} {
		f := newFake(t, ctxRoutes(nil, nil, nil, nil))
		if _, _, err := runIn(t, f, strings.NewReader(value), "site", "auth", "set", "st_1", "--username", "viewer", "--password-stdin"); err == nil {
			t.Fatal("invalid value accepted")
		}
	}
}
