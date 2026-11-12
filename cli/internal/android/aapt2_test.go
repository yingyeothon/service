package android

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Output shapes captured from aapt2 36.0.0 (ids replaced).
const badging = `package: name='com.example.sample.debug' versionCode='2021' versionName='1.1.19' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'
minSdkVersion:'24'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
`

const xmltree = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: package="com.example.sample" (Raw: "com.example.sample")
    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=2011 (Raw: "2011")
    A: http://schemas.android.com/apk/res/android:versionName(0x0101021c)="1.0.10" (Raw: "1.0.10")
    A: http://schemas.android.com/apk/res/android:compileSdkVersion(0x01010572)=36 (Raw: "36")
      E: uses-sdk (line=7)
        A: http://schemas.android.com/apk/res/android:minSdkVersion(0x0101020c)=24 (Raw: "24")
        A: http://schemas.android.com/apk/res/android:targetSdkVersion(0x01010270)=36 (Raw: "36")
      E: queries (line=9)
        E: package (line=10)
          A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.example.other" (Raw: "com.example.other")
`

func TestParse(t *testing.T) {
	want := Info{Package: "com.example.sample.debug", VersionCode: 2021, MinSdk: "24", TargetSdk: "36"}
	if got, err := ParseBadging([]byte(badging)); err != nil || got != want {
		t.Fatalf("badging: %+v, %v", got, err)
	}
	// Older aapt2 builds print sdkVersion.
	if got, _ := ParseBadging([]byte(strings.Replace(badging, "minSdkVersion:", "sdkVersion:", 1))); got != want {
		t.Fatalf("sdkVersion form: %+v", got)
	}
	want = Info{Package: "com.example.sample", VersionCode: 2011, MinSdk: "24", TargetSdk: "36"}
	if got, err := ParseXMLTree([]byte(xmltree)); err != nil || got != want {
		t.Fatalf("xmltree: %+v, %v", got, err)
	}
	// Output without the trailing "(Raw: …)".
	if got, _ := ParseXMLTree([]byte(strings.ReplaceAll(xmltree, ` (Raw: "2011")`, ""))); got.VersionCode != 2011 {
		t.Fatalf("bare value: %+v", got)
	}
	for name, out := range map[string]string{
		"empty":          "",
		"no versionCode": "package: name='com.example.sample' versionCode='' versionName=''\n",
		"no package":     "package: name='' versionCode='3'\n",
	} {
		if _, err := ParseBadging([]byte(out)); err == nil {
			t.Errorf("badging %s: want an error", name)
		}
	}
	if _, err := ParseXMLTree([]byte(strings.Replace(xmltree, "versionCode(", "versionKode(", 1))); err == nil {
		t.Error("xmltree without a versionCode must be an error")
	}
	if _, err := ParseXMLTree([]byte("E: manifest\n")); err == nil {
		t.Error("xmltree without a package must be an error")
	}
}

func writeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
}

func TestInspect(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	aab := filepath.Join(dir, "app-release.aab")
	writeZip(t, aab, map[string]string{manifestInBundle: "proto-manifest", "base/dex/classes.dex": "x"})
	var tmpZip string
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "aapt2" {
			t.Fatalf("ran %s", name)
		}
		switch strings.Join(args[:2], " ") {
		case "dump badging":
			return []byte(badging), nil
		case "dump xmltree":
			if args[2] != "--file" || args[3] != "AndroidManifest.xml" {
				t.Fatalf("xmltree args: %v", args)
			}
			tmpZip = args[4]
			zr, err := zip.OpenReader(tmpZip)
			if err != nil {
				t.Fatal(err)
			}
			defer zr.Close()
			if len(zr.File) != 1 || zr.File[0].Name != "AndroidManifest.xml" {
				t.Fatalf("the temporary zip must hold only the manifest at its root: %v", zr.File)
			}
			return []byte(xmltree), nil
		}
		return nil, errors.New("unexpected")
	}
	if info, err := InspectAPK(ctx, run, "aapt2", filepath.Join(dir, "a.apk")); err != nil || info.VersionCode != 2021 {
		t.Fatalf("apk: %+v, %v", info, err)
	}
	info, err := InspectAAB(ctx, run, "aapt2", aab)
	if err != nil || info.Package != "com.example.sample" || info.VersionCode != 2011 {
		t.Fatalf("aab: %+v, %v", info, err)
	}
	if _, err := os.Stat(tmpZip); err == nil {
		t.Fatal("the temporary zip was left behind")
	}
	// Not a bundle, and a bundle without a base manifest.
	plain := filepath.Join(dir, "plain.aab")
	_ = os.WriteFile(plain, []byte("not a zip"), 0o644)
	if _, err := InspectAAB(ctx, run, "aapt2", plain); err == nil {
		t.Fatal("a file that is not a zip must be an error")
	}
	writeZip(t, plain, map[string]string{"feature/manifest/AndroidManifest.xml": "x"})
	if _, err := InspectAAB(ctx, run, "aapt2", plain); err == nil || !strings.Contains(err.Error(), manifestInBundle) {
		t.Fatalf("err = %v, want a missing manifest", err)
	}
	failing := func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("boom") }
	if _, err := InspectAPK(ctx, failing, "aapt2", "a.apk"); err == nil {
		t.Fatal("an aapt2 failure must be an error")
	}
	if _, err := InspectAAB(ctx, failing, "aapt2", aab); err == nil {
		t.Fatal("an aapt2 failure must be an error")
	}
}

func TestFindAAPT2(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("ANDROID_SDK_ROOT", "")
	t.Setenv("ANDROID_HOME", "")
	t.Setenv("AAPT2", "")
	t.Setenv("LOCALAPPDATA", "")
	if _, err := FindAAPT2(); !errors.Is(err, ErrNoAAPT2) {
		t.Fatalf("err = %v, want ErrNoAAPT2", err)
	}
	sdk := filepath.Join(t.TempDir(), "sdk")
	t.Setenv("ANDROID_HOME", sdk)
	for _, v := range []string{"9.0.0", "34.0.0", "36.0.0", "100.0.0"} {
		d := filepath.Join(sdk, "build-tools", v)
		_ = os.MkdirAll(d, 0o755)
		if v != "100.0.0" { // the newest directory is an incomplete install
			_ = os.WriteFile(filepath.Join(d, exeName()), []byte("x"), 0o755)
		}
	}
	got, err := FindAAPT2()
	if want := filepath.Join(sdk, "build-tools", "36.0.0", exeName()); err != nil || got != want {
		t.Fatalf("got %q, %v; want %q", got, err, want)
	}
	// The project's own SDK comes before the environment's.
	mine := filepath.Join(t.TempDir(), "project-sdk")
	_ = os.MkdirAll(filepath.Join(mine, "build-tools", "30.0.0"), 0o755)
	_ = os.WriteFile(filepath.Join(mine, "build-tools", "30.0.0", exeName()), []byte("x"), 0o755)
	if got, err := FindAAPT2("", mine); err != nil || got != filepath.Join(mine, "build-tools", "30.0.0", exeName()) {
		t.Fatalf("project sdk: %q, %v", got, err)
	}
	t.Setenv("ANDROID_HOME", "")
	local := t.TempDir()
	winSdk := filepath.Join(local, "Android", "Sdk", "build-tools", "1.0.0")
	_ = os.MkdirAll(winSdk, 0o755)
	_ = os.WriteFile(filepath.Join(winSdk, exeName()), []byte("x"), 0o755)
	t.Setenv("LOCALAPPDATA", local)
	if got, err := FindAAPT2(); err != nil || got != filepath.Join(winSdk, exeName()) {
		t.Fatalf("LOCALAPPDATA sdk: %q, %v", got, err)
	}
	own := filepath.Join(t.TempDir(), "my-aapt2")
	_ = os.WriteFile(own, []byte("x"), 0o755)
	t.Setenv("AAPT2", own)
	if got, err := FindAAPT2(); err != nil || got != own {
		t.Fatalf("AAPT2: %q, %v", got, err)
	}
	// A wrong AAPT2 is an error, not a reason to use the SDK's.
	t.Setenv("AAPT2", filepath.Join(home, "missing"))
	if _, err := FindAAPT2(); err == nil || errors.Is(err, ErrNoAAPT2) {
		t.Fatalf("err = %v, want a bad AAPT2 error", err)
	}
}

func TestVersionLess(t *testing.T) {
	for _, c := range [][2]string{{"9.0.0", "34.0.0"}, {"34.0.0", "36.0.0"}, {"36.0.0", "36.1.0"}, {"36.0.0", "100.0.0"}, {"36.0.0-rc1", "36.0.0"}, {"35.0.1", "36.0.0-rc1"}, {"36.0", "36.0.1"}} {
		if !versionLess(c[0], c[1]) || versionLess(c[1], c[0]) {
			t.Errorf("want %s < %s", c[0], c[1])
		}
	}
}
