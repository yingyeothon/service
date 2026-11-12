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

func TestBuiltMetadata(t *testing.T) {
	dir := t.TempDir()
	if m, err := BuiltMetadata(dir, "pro", "debug"); m != nil || err != nil {
		t.Fatalf("no metadata: %+v, %v", m, err)
	}
	// Gradle names the flavor directory in its own case.
	meta := filepath.Join(dir, "build", "app", "outputs", "apk", "proPlus", "debug", "output-metadata.json")
	write(t, meta, `{"applicationId":"com.example.sample.pro.debug","elements":[
	 {"type":"ONE_OF","filters":[{"filterType":"ABI","value":"arm64-v8a"}],"versionCode":2004,"outputFile":"app-proPlus-arm64-v8a-debug.apk"},
	 {"type":"ONE_OF","filters":[{"filterType":"ABI","value":"x86_64"}],"versionCode":4004},
	 {"type":"UNIVERSAL","filters":[],"versionCode":4}]}`)
	m, err := BuiltMetadata(dir, "proplus", "debug")
	if err != nil || m.ApplicationID != "com.example.sample.pro.debug" {
		t.Fatalf("flavored: %+v, %v", m, err)
	}
	for abi, want := range map[string]int{"arm64-v8a": 2004, "x86_64": 4004, "": 4, "x86": 0} {
		if got := m.VersionCode(abi); got != want {
			t.Fatalf("versionCode(%q) = %d, want %d", abi, got, want)
		}
	}
	if m, err := BuiltMetadata(dir, "proplus", "release"); m != nil || err != nil {
		t.Fatalf("other mode: %+v, %v", m, err)
	}
	if (*BuildMetadata)(nil).VersionCode("") != 0 {
		t.Fatal("nil metadata has no versionCode")
	}
	write(t, filepath.Join(dir, "build", "app", "outputs", "apk", "release", "output-metadata.json"), `{oops`)
	if _, err := BuiltMetadata(dir, "", "release"); err == nil {
		t.Fatal("malformed metadata must be an error, not an unchecked build")
	}
	write(t, filepath.Join(dir, "build", "app", "outputs", "apk", "debug", "output-metadata.json"), `{}`)
	if _, err := BuiltMetadata(dir, "", "debug"); err == nil {
		t.Fatal("metadata without an id must be an error")
	}
}

func TestSplitVersion(t *testing.T) {
	for _, c := range []struct {
		in, name string
		build    int
		has      bool
	}{{"1.2.3+45", "1.2.3", 45, true}, {"1.2.3", "1.2.3", 0, false}, {"1.2.3+x", "1.2.3", 0, false}, {"1.2.3+0", "1.2.3", 0, true}} {
		name, build, has := SplitVersion(c.in)
		if name != c.name || build != c.build || has != c.has {
			t.Errorf("SplitVersion(%q) = %q %d %v", c.in, name, build, has)
		}
	}
}
