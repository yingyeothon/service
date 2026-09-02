package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setConfig(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "nested", "config.json")
	t.Setenv("YYT_CONFIG", p)
	t.Setenv("YYT_API", "")
	t.Setenv("YYT_TOKEN", "")
	t.Setenv("YYT_PROFILE", "")
	return p
}

func TestRenameProfile(t *testing.T) {
	setConfig(t)
	_ = SaveProfile("dev", Profile{API: "https://x", Token: "yyt_abc"})
	_ = SaveProfile("prod", Profile{API: "https://y", Token: "yyt_def"})
	if err := RenameProfile("nope", "other"); err == nil ||
		!strings.Contains(err.Error(), "unknown profile") {
		t.Fatalf("expected unknown profile error, got %v", err)
	}
	if err := RenameProfile("dev", "prod"); err == nil ||
		!strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected conflict error, got %v", err)
	}
	if err := RenameProfile("dev", ""); err == nil {
		t.Fatal("expected empty-name error")
	}
	if err := RenameProfile("dev", "dev"); err != nil {
		t.Fatal("same-name rename should be a no-op:", err)
	}
	// default marker moves with the renamed profile
	if err := RenameProfile("dev", "local"); err != nil {
		t.Fatal(err)
	}
	f, _ := LoadFile()
	if _, ok := f.Profiles["dev"]; ok {
		t.Fatalf("old name kept: %+v", f)
	}
	if f.Profiles["local"].Token != "yyt_abc" || f.Default != "local" {
		t.Fatalf("%+v", f)
	}
	// renaming a non-default profile leaves the default alone
	if err := RenameProfile("prod", "live"); err != nil {
		t.Fatal(err)
	}
	f, _ = LoadFile()
	if f.Default != "local" || f.Profiles["live"].Token != "yyt_def" {
		t.Fatalf("%+v", f)
	}
}

func TestSaveLoadRemoveProfiles(t *testing.T) {
	p := setConfig(t)
	f, err := LoadFile()
	if err != nil || len(f.Profiles) != 0 {
		t.Fatalf("empty load: %v %+v", err, f)
	}
	if err := SaveProfile("dev", Profile{API: "https://x", Token: "yyt_abc"}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %o", st.Mode().Perm())
	}
	f, _ = LoadFile()
	if f.Profiles["dev"].Token != "yyt_abc" || f.Default != "dev" {
		t.Fatalf("%+v", f)
	}
	// second profile does not steal the default
	_ = SaveProfile("prod", Profile{API: "https://y", Token: "yyt_def"})
	f, _ = LoadFile()
	if f.Default != "dev" || len(f.Profiles) != 2 {
		t.Fatalf("%+v", f)
	}
	if err := SetDefault("prod"); err != nil {
		t.Fatal(err)
	}
	if err := SetDefault("nope"); err == nil {
		t.Fatal("expected unknown profile error")
	}
	if err := RemoveProfile("prod"); err != nil {
		t.Fatal(err)
	}
	f, _ = LoadFile()
	if f.Default != "dev" { // sole survivor becomes default
		t.Fatalf("%+v", f)
	}
	if err := RemoveProfile("prod"); err != nil {
		t.Fatal("second remove should be a no-op:", err)
	}
}

func TestLegacyFlatMigration(t *testing.T) {
	p := setConfig(t)
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	_ = os.WriteFile(p, []byte(`{"api":"https://old","token":"yyt_old"}`), 0o600)
	f, err := LoadFile()
	if err != nil {
		t.Fatal(err)
	}
	if f.Default != DefaultProfile || f.Profiles[DefaultProfile].Token != "yyt_old" {
		t.Fatalf("%+v", f)
	}
	// file was rewritten in the new schema with 0600
	b, _ := os.ReadFile(p)
	var doc map[string]any
	_ = json.Unmarshal(b, &doc)
	if _, ok := doc["profiles"]; !ok {
		t.Fatalf("not migrated: %s", b)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %o", st.Mode().Perm())
	}
	c, err := Resolve("", "", "")
	if err != nil || c.Token != "yyt_old" || c.API != "https://old" || c.Profile != DefaultProfile {
		t.Fatalf("%v %+v", err, c)
	}
}

func TestResolvePrecedence(t *testing.T) {
	setConfig(t)
	c, _ := Resolve("", "", "")
	if c.API != DefaultAPI || c.Token != "" {
		t.Fatalf("default: %+v", c)
	}
	_ = SaveProfile("default", Profile{API: "https://file/", Token: "file"})
	c, _ = Resolve("", "", "")
	if c.API != "https://file" || c.Token != "file" {
		t.Fatalf("file: %+v", c)
	}
	t.Setenv("YYT_TOKEN", "env")
	c, _ = Resolve("", "", "")
	if c.Token != "env" {
		t.Fatalf("env: %+v", c)
	}
	c, _ = Resolve("", "https://flag", "flag")
	if c.API != "https://flag" || c.Token != "flag" {
		t.Fatalf("flag: %+v", c)
	}
}

func TestResolveProfileSelection(t *testing.T) {
	setConfig(t)
	_ = SaveProfile("dev", Profile{API: "https://dev", Token: "d"})
	_ = SaveProfile("prod", Profile{API: "https://prod", Token: "p"})
	c, err := Resolve("prod", "", "")
	if err != nil || c.API != "https://prod" || c.Token != "p" || c.Profile != "prod" {
		t.Fatalf("%v %+v", err, c)
	}
	t.Setenv("YYT_PROFILE", "prod")
	c, _ = Resolve("", "", "")
	if c.Profile != "prod" {
		t.Fatalf("env profile: %+v", c)
	}
	// flag wins over env
	c, _ = Resolve("dev", "", "")
	if c.Profile != "dev" || c.Token != "d" {
		t.Fatalf("flag profile: %+v", c)
	}
	// unknown explicit profile fails with the known list
	_, err = Resolve("stage", "", "")
	if err == nil || !strings.Contains(err.Error(), "dev, prod") {
		t.Fatalf("expected unknown-profile error, got %v", err)
	}
	// ...unless flags/env fully supply credentials
	c, err = Resolve("stage", "https://flag", "tok")
	if err != nil || c.Token != "tok" {
		t.Fatalf("%v %+v", err, c)
	}
}

func TestDefaultNotStolenByNewProfile(t *testing.T) {
	setConfig(t)
	_ = SaveProfile("dev", Profile{API: "https://dev", Token: "d"})
	_ = SaveProfile("prod", Profile{API: "https://prod", Token: "p"})
	_ = RemoveProfile("dev") // default was dev; two→one leaves prod as default
	f, _ := LoadFile()
	if f.Default != "prod" {
		t.Fatalf("%+v", f)
	}
	_ = SaveProfile("dev2", Profile{API: "https://dev2", Token: "d2"})
	f, _ = LoadFile()
	if f.Default != "prod" { // new profile must not steal the default
		t.Fatalf("default stolen: %+v", f)
	}
	// default removed with >=2 remaining: default stays empty, not reassigned
	_ = RemoveProfile("prod")
	f, _ = LoadFile()
	if f.Default != "dev2" { // sole survivor becomes default
		t.Fatalf("%+v", f)
	}
}

func TestLoadCorrupt(t *testing.T) {
	p := setConfig(t)
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	_ = os.WriteFile(p, []byte("{"), 0o600)
	if _, err := LoadFile(); err == nil {
		t.Fatal("expected error")
	}
}

func TestSetContextPinsAndClears(t *testing.T) {
	setConfig(t)
	if err := SaveProfile("dev", Profile{API: "https://x", Token: "yyt_abc"}); err != nil {
		t.Fatal(err)
	}
	if err := SetContext("nope", nil, nil); err == nil || !strings.Contains(err.Error(), `unknown profile "nope"`) {
		t.Fatalf("expected unknown profile, got %v", err)
	}
	team, project := "team_1", "prj_1"
	if err := SetContext("dev", &team, &project); err != nil {
		t.Fatal(err)
	}
	f, _ := LoadFile()
	if f.Profiles["dev"].Team != "team_1" || f.Profiles["dev"].Project != "prj_1" {
		t.Fatalf("%+v", f.Profiles["dev"])
	}
	// Setting the team alone clears the project pinned under the old team.
	other := "team_2"
	if err := SetContext("dev", &other, nil); err != nil {
		t.Fatal(err)
	}
	f, _ = LoadFile()
	if f.Profiles["dev"].Team != "team_2" || f.Profiles["dev"].Project != "" {
		t.Fatalf("%+v", f.Profiles["dev"])
	}
	// Renaming to the same name writes nothing and is not an error.
	if err := RenameProfile("dev", "dev"); err != nil {
		t.Fatal(err)
	}
}

func TestRenameSameNameWritesNothing(t *testing.T) {
	p := setConfig(t)
	if err := SaveProfile("dev", Profile{API: "https://x", Token: "yyt_abc"}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(p)
	_ = os.Chmod(p, 0o400) // a write would now fail
	t.Cleanup(func() { _ = os.Chmod(p, 0o600) })
	if err := RenameProfile("dev", "dev"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(p)
	if string(before) != string(after) {
		t.Fatal("file rewritten")
	}
}
