package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadRemove(t *testing.T) {
	p := filepath.Join(t.TempDir(), "nested", "config.json")
	t.Setenv("YYT_CONFIG", p)
	c, err := Load()
	if err != nil || c != (Config{}) {
		t.Fatalf("empty load: %v %+v", err, c)
	}
	if err := Save(Config{API: "https://x", Token: "yyt_abc"}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %o", st.Mode().Perm())
	}
	c, _ = Load()
	if c.Token != "yyt_abc" || c.API != "https://x" {
		t.Fatalf("%+v", c)
	}
	if err := Remove(); err != nil {
		t.Fatal(err)
	}
	if err := Remove(); err != nil {
		t.Fatal("second remove should be a no-op:", err)
	}
}

func TestResolvePrecedence(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("YYT_CONFIG", p)
	t.Setenv("YYT_API", "")
	t.Setenv("YYT_TOKEN", "")
	c, _ := Resolve("", "")
	if c.API != DefaultAPI || c.Token != "" {
		t.Fatalf("default: %+v", c)
	}
	_ = Save(Config{API: "https://file/", Token: "file"})
	c, _ = Resolve("", "")
	if c.API != "https://file" || c.Token != "file" {
		t.Fatalf("file: %+v", c)
	}
	t.Setenv("YYT_TOKEN", "env")
	c, _ = Resolve("", "")
	if c.Token != "env" {
		t.Fatalf("env: %+v", c)
	}
	c, _ = Resolve("https://flag", "flag")
	if c.API != "https://flag" || c.Token != "flag" {
		t.Fatalf("flag: %+v", c)
	}
}

func TestLoadCorrupt(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("YYT_CONFIG", p)
	_ = os.WriteFile(p, []byte("{"), 0o600)
	if _, err := Load(); err == nil {
		t.Fatal("expected error")
	}
}
