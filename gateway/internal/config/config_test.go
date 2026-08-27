package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func base() map[string]string {
	return map[string]string{
		"GATEWAY_STAGE":       "dev",
		"GATEWAY_CONSOLE_URL": "https://console.example.com/",
		"GATEWAY_TOKEN":       goodToken,
		"GATEWAY_REDIS_URL":   "redis://u:p@localhost:6379/0",
	}
}

func TestFromEnvDefaults(t *testing.T) {
	c, err := FromEnv(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != ":8080" || c.ConfigTTL.Seconds() != 60 || c.LogLevel != "info" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.ConsoleURL != "https://console.example.com" {
		t.Fatalf("trailing slash kept: %q", c.ConsoleURL)
	}
}

func TestFromEnvRejects(t *testing.T) {
	cases := map[string]map[string]string{
		"short token":  {"GATEWAY_TOKEN": "short"},
		"no stage":     {"GATEWAY_STAGE": ""},
		"bad stage":    {"GATEWAY_STAGE": "de:v"},
		"no console":   {"GATEWAY_CONSOLE_URL": ""},
		"bad console":  {"GATEWAY_CONSOLE_URL": "ftp://x"},
		"no redis":     {"GATEWAY_REDIS_URL": ""},
		"tls half":     {"GATEWAY_TLS_CERT": "/c.pem"},
		"bad level":    {"GATEWAY_LOG_LEVEL": "loud"},
		"bad ttl":      {"GATEWAY_CONFIG_TTL_SEC": "0"},
		"bad shutdown": {"GATEWAY_SHUTDOWN_TIMEOUT_SEC": "x"},
	}
	for name, over := range cases {
		m := base()
		for k, v := range over {
			m[k] = v
		}
		if _, err := FromEnv(env(m)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestSecretFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "token")
	if err := os.WriteFile(p, []byte(goodToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := base()
	delete(m, "GATEWAY_TOKEN")
	m["GATEWAY_TOKEN_FILE"] = p
	c, err := FromEnv(env(m))
	if err != nil {
		t.Fatal(err)
	}
	if c.Token != goodToken {
		t.Fatalf("token not trimmed: %q", c.Token)
	}
	m["GATEWAY_TOKEN_FILE"] = filepath.Join(dir, "missing")
	_, err = FromEnv(env(m))
	if err == nil || !strings.Contains(err.Error(), "GATEWAY_TOKEN_FILE") {
		t.Fatalf("missing file not reported: %v", err)
	}
}
