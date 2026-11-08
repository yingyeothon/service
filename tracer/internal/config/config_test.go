package config

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodLocal = `{"resources":[{"id":"trc_01abc","writeKey":"aaaaaaaaaaaaaaaaaaaa"}],"readToken":"yyt_` +
	`000000000000000000000000000000000000000000000000"}`

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func localFile(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "tracer.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func serverEnv() map[string]string {
	return map[string]string{
		"TRACER_STAGE":       "dev",
		"TRACER_CONSOLE_URL": "https://console.example/",
		"TRACER_TOKEN":       strings.Repeat("t", 32),
		"TRACER_LISTEN":      "127.0.0.1:8095",
		"TRACER_DATA_DIR":    "/data",
	}
}

func TestServerMode(t *testing.T) {
	c, err := FromEnv(envOf(serverEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != ModeServer || c.ConsoleURL != "https://console.example" || c.StageBytes != 512<<20 || c.DiskMaxPct != 70 {
		t.Fatalf("unexpected %+v", c)
	}
	if c.DBPath() != "/data/tracer.db" || c.BlobDir() != "/data/blobs" {
		t.Fatalf("paths %s %s", c.DBPath(), c.BlobDir())
	}
	env := serverEnv()
	env["TRACER_CONSOLE_URL"] = "http://127.0.0.1:9000"
	if _, err := FromEnv(envOf(env)); err != nil {
		t.Fatalf("loopback http console refused: %v", err)
	}
	env["TRACER_STAGE"] = "prod"
	if c, err := FromEnv(envOf(env)); err != nil || c.StageBytes != 1536<<20 {
		t.Fatalf("prod: %v %d", err, c.StageBytes)
	}
}

func TestServerModeRefusals(t *testing.T) {
	cases := map[string]func(m map[string]string){
		"short token":    func(m map[string]string) { m["TRACER_TOKEN"] = "short" },
		"no stage":       func(m map[string]string) { delete(m, "TRACER_STAGE") },
		"no data dir":    func(m map[string]string) { delete(m, "TRACER_DATA_DIR") },
		"bad url":        func(m map[string]string) { m["TRACER_CONSOLE_URL"] = "ftp://x" },
		"plain http":     func(m map[string]string) { m["TRACER_CONSOLE_URL"] = "http://console.example" },
		"relative url":   func(m map[string]string) { m["TRACER_CONSOLE_URL"] = "console.example" },
		"unknown stage":  func(m map[string]string) { m["TRACER_STAGE"] = "staging" },
		"public listen":  func(m map[string]string) { m["TRACER_LISTEN"] = "10.0.0.5:8095" },
		"port range":     func(m map[string]string) { m["TRACER_LISTEN"] = "127.0.0.1:99999" },
		"port zero":      func(m map[string]string) { m["TRACER_LISTEN"] = "127.0.0.1:0" },
		"local config":   func(m map[string]string) { m["TRACER_LOCAL_CONFIG"] = "tracer.json" },
		"dump dir":       func(m map[string]string) { m["TRACER_DUMP_DIR"] = "/tmp/d" },
		"wildcard":       func(m map[string]string) { m["TRACER_LISTEN"] = ":8095" },
		"wildcard v4":    func(m map[string]string) { m["TRACER_LISTEN"] = "0.0.0.0:8095" },
		"wildcard v6":    func(m map[string]string) { m["TRACER_LISTEN"] = "[::]:8095" },
		"hostname":       func(m map[string]string) { m["TRACER_LISTEN"] = "localhost:8095" },
		"bad level":      func(m map[string]string) { m["TRACER_LOG_LEVEL"] = "trace" },
		"bad bytes":      func(m map[string]string) { m["TRACER_STAGE_BYTES"] = "-1" },
		"bad pct":        func(m map[string]string) { m["TRACER_DISK_MAX_PCT"] = "100" },
		"stage with sep": func(m map[string]string) { m["TRACER_STAGE"] = "dev:x" },
	}
	for name, mutate := range cases {
		env := serverEnv()
		mutate(env)
		if _, err := FromEnv(envOf(env)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestTokenFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "token")
	os.WriteFile(p, []byte(strings.Repeat("f", 40)+"\n"), 0o600)
	env := serverEnv()
	env["TRACER_TOKEN"] = ""
	env["TRACER_TOKEN_FILE"] = p
	c, err := FromEnv(envOf(env))
	if err != nil || c.Token != strings.Repeat("f", 40) {
		t.Fatalf("token file: %v %q", err, c.Token)
	}
	env["TRACER_TOKEN_FILE"] = p + ".missing"
	if _, err := FromEnv(envOf(env)); err == nil {
		t.Fatal("missing token file accepted")
	}
}

func TestLocalMode(t *testing.T) {
	p := localFile(t, goodLocal)
	c, err := FromEnv(envOf(map[string]string{"TRACER_LOCAL_CONFIG": p, "TRACER_DUMP_DIR": "/tmp/d"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != ModeLocal || c.Stage != "local" || c.Listen != DefaultListen || c.DataDir != "tracer-data" {
		t.Fatalf("unexpected %+v", c)
	}
	if got := c.Local.KeyHashes["trc_01abc"]; got != sha256.Sum256([]byte("aaaaaaaaaaaaaaaaaaaa")) {
		t.Fatal("key not hashed")
	}
	if c.Local.Resources[0].DailyBytes != DefaultDailyBytes {
		t.Fatalf("dailyBytes default %d", c.Local.Resources[0].DailyBytes)
	}
	for _, listen := range []string{"[::1]:8095", "127.0.0.2:1"} {
		if _, err := FromEnv(envOf(map[string]string{"TRACER_LOCAL_CONFIG": p, "TRACER_LISTEN": listen})); err != nil {
			t.Errorf("loopback %s refused: %v", listen, err)
		}
	}
}

func TestLocalModeRefusals(t *testing.T) {
	p := localFile(t, goodLocal)
	for _, listen := range []string{"10.0.0.5:8095", "0.0.0.0:8095", ":8095", "localhost:8095"} {
		if _, err := FromEnv(envOf(map[string]string{"TRACER_LOCAL_CONFIG": p, "TRACER_LISTEN": listen})); err == nil {
			t.Errorf("local listen %s accepted", listen)
		}
	}
	if _, err := FromEnv(envOf(map[string]string{"TRACER_LOCAL_CONFIG": p, "TRACER_TOKEN": strings.Repeat("t", 32)})); err == nil {
		t.Error("token without console accepted")
	}
	if _, err := FromEnv(envOf(map[string]string{"TRACER_LOCAL_CONFIG": p + ".missing"})); err == nil {
		t.Error("missing tracer.json accepted")
	}
}

func TestParseLocalRefusals(t *testing.T) {
	cases := map[string]string{
		"numeric id":     `{"resources":[{"id":"7","writeKey":"aaaaaaaaaaaaaaaa"}]}`,
		"upper id":       `{"resources":[{"id":"trc_ABC","writeKey":"aaaaaaaaaaaaaaaa"}]}`,
		"short key":      `{"resources":[{"id":"trc_a","writeKey":"short"}]}`,
		"duplicate id":   `{"resources":[{"id":"trc_a","writeKey":"aaaaaaaaaaaaaaaa"},{"id":"trc_a","writeKey":"bbbbbbbbbbbbbbbb"}]}`,
		"duplicate key":  `{"resources":[{"id":"trc_a","writeKey":"aaaaaaaaaaaaaaaa"},{"id":"trc_b","writeKey":"aaaaaaaaaaaaaaaa"}]}`,
		"bad token":      `{"resources":[],"readToken":"yyt_short"}`,
		"unknown field":  `{"resources":[],"projects":[]}`,
		"negative quota": `{"resources":[{"id":"trc_a","writeKey":"aaaaaaaaaaaaaaaa","dailyBytes":-1}]}`,
	}
	for name, body := range cases {
		if _, err := ParseLocal([]byte(body)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
