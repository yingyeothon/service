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
	if l := Label(dir, "", "release"); l != "YYT Catalog" {
		t.Fatalf("Label = %q", l)
	}
	if l := Label(t.TempDir(), "", "release"); l != "" {
		t.Fatalf("missing strings.xml should yield empty label, got %q", l)
	}
}

func TestLabelPrefersTheMostSpecificSourceSet(t *testing.T) {
	dir := t.TempDir()
	set := func(name, label string) {
		write(t, filepath.Join(dir, "android", "app", "src", name, "res", "values", "strings.xml"),
			`<resources><string name="app_name">`+label+`</string></resources>`)
	}
	set("pro", "Pro")
	set("proDebug", "[D] Pro")
	set("debug", "Debug")
	set("lite", "Lite")
	for _, c := range []struct{ flavor, mode, want string }{
		{"pro", "debug", "[D] Pro"},
		{"pro", "release", "Pro"},
		{"", "debug", "Debug"},
		{"lite", "release", "Lite"},
		{"lite", "debug", "Debug"}, // build type outranks flavor
		{"max", "release", ""},
	} {
		if got := Label(dir, c.flavor, c.mode); got != c.want {
			t.Errorf("Label(%q, %q) = %q, want %q", c.flavor, c.mode, got, c.want)
		}
	}
}

func TestBuiltApplicationID(t *testing.T) {
	dir := t.TempDir()
	if id, err := BuiltApplicationID(dir, "pro", "debug"); id != "" || err != nil {
		t.Fatalf("no metadata: %q, %v", id, err)
	}
	// Gradle names the flavor directory in its own case.
	meta := filepath.Join(dir, "build", "app", "outputs", "apk", "proPlus", "debug", "output-metadata.json")
	write(t, meta, `{"applicationId":"com.example.sample.pro.debug"}`)
	if id, err := BuiltApplicationID(dir, "proplus", "debug"); id != "com.example.sample.pro.debug" || err != nil {
		t.Fatalf("flavored: %q, %v", id, err)
	}
	if id, err := BuiltApplicationID(dir, "proplus", "release"); id != "" || err != nil {
		t.Fatalf("other mode: %q, %v", id, err)
	}
	write(t, filepath.Join(dir, "build", "app", "outputs", "apk", "release", "output-metadata.json"), `{oops`)
	if _, err := BuiltApplicationID(dir, "", "release"); err == nil {
		t.Fatal("malformed metadata must be an error, not an unchecked build")
	}
	write(t, filepath.Join(dir, "build", "app", "outputs", "apk", "debug", "output-metadata.json"), `{}`)
	if _, err := BuiltApplicationID(dir, "", "debug"); err == nil {
		t.Fatal("metadata without an id must be an error")
	}
}
