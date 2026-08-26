package flutter

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestVersionRoundtrip(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "pubspec.yaml"), "name: app\nversion: 1.2.3+45\nenvironment:\n  sdk: '>=3.0.0'\n")
	v, err := Version(dir)
	if err != nil || v != "1.2.3+45" {
		t.Fatalf("Version = %q, %v", v, err)
	}
	next, err := BumpVersion(v, BumpPatch)
	if err != nil || next != "1.2.4+46" {
		t.Fatalf("BumpVersion = %q, %v", next, err)
	}
	if n, _ := BumpVersion("2.0.0", BumpMinor); n != "2.1.0+1" {
		t.Fatalf("minor bump without build = %q", n)
	}
	if n, _ := BumpVersion("2.9.9+9", BumpMajor); n != "3.0.0+10" {
		t.Fatalf("major bump = %q", n)
	}
	if err := SetVersion(dir, next); err != nil {
		t.Fatal(err)
	}
	v2, _ := Version(dir)
	if v2 != next {
		t.Fatalf("SetVersion did not stick: %q", v2)
	}
	if _, err := BumpVersion("1.2", BumpPatch); err == nil {
		t.Fatal("expected invalid version error")
	}
}

func TestApplicationIDAndLabel(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "android", "app", "build.gradle.kts"),
		"android {\n  defaultConfig {\n    applicationId = \"life.yyt.console\"\n  }\n}\n")
	id, err := ApplicationID(dir)
	if err != nil || id != "life.yyt.console" {
		t.Fatalf("ApplicationID = %q, %v", id, err)
	}
	write(t, filepath.Join(dir, "android", "app", "src", "main", "res", "values", "strings.xml"),
		`<resources><string name="app_name">YYT Catalog</string></resources>`)
	if l := Label(dir); l != "YYT Catalog" {
		t.Fatalf("Label = %q", l)
	}
	if l := Label(t.TempDir()); l != "" {
		t.Fatalf("missing strings.xml should yield empty label, got %q", l)
	}
}
