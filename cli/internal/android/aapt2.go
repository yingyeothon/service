// Package android reads what an Android build packaged (package id,
// versionCode, SDK levels) out of the built APK or bundle with aapt2.
package android

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// Runner runs a command and returns its stdout; tests fake aapt2 with it.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// ErrNoAAPT2 means no aapt2 was found and none was named.
var ErrNoAAPT2 = errors.New("aapt2 not found (set AAPT2, or install Android build-tools and set ANDROID_HOME)")

// Info is the part of a packaged manifest deploy checks and tags.
type Info struct {
	Package     string
	VersionCode int
	MinSdk      string
	TargetSdk   string
}

func exeName() string {
	if runtime.GOOS == "windows" {
		return "aapt2.exe"
	}
	return "aapt2"
}

// FindAAPT2 returns $AAPT2, else the aapt2 of the newest build-tools of an
// Android SDK: the given directories first (the project's own `sdk.dir`),
// then $ANDROID_HOME, $ANDROID_SDK_ROOT, ~/Android/Sdk, ~/Library/Android/sdk
// and %LOCALAPPDATA%\Android\Sdk. A set AAPT2 that is not a file is an error
// rather than a reason to look elsewhere: the caller named the tool to trust.
func FindAAPT2(sdkDirs ...string) (string, error) {
	if p := os.Getenv("AAPT2"); p != "" {
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			return "", fmt.Errorf("AAPT2=%s is not a file", p)
		}
		return p, nil
	}
	sdks := append(append([]string{}, sdkDirs...), os.Getenv("ANDROID_HOME"), os.Getenv("ANDROID_SDK_ROOT"))
	if home, err := os.UserHomeDir(); err == nil {
		sdks = append(sdks, filepath.Join(home, "Android", "Sdk"), filepath.Join(home, "Library", "Android", "sdk"))
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		sdks = append(sdks, filepath.Join(local, "Android", "Sdk"))
	}
	for _, sdk := range sdks {
		if sdk == "" {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(sdk, "build-tools"))
		if err != nil {
			continue
		}
		var versions []string
		for _, e := range entries {
			if e.IsDir() {
				versions = append(versions, e.Name())
			}
		}
		sort.Slice(versions, func(i, j int) bool { return versionLess(versions[j], versions[i]) })
		for _, v := range versions {
			p := filepath.Join(sdk, "build-tools", v, exeName())
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				return p, nil
			}
		}
	}
	return "", ErrNoAAPT2
}

// versionLess orders build-tools directory names by their numeric fields:
// "34.0.0" < "36.0.0-rc1" < "36.0.0" < "36.0.1" < "100.0.0".
func versionLess(a, b string) bool {
	split := func(r rune) bool { return r == '.' || r == '-' }
	af, bf := strings.FieldsFunc(a, split), strings.FieldsFunc(b, split)
	for i := 0; i < len(af) && i < len(bf); i++ {
		an, aerr := strconv.Atoi(af[i])
		bn, berr := strconv.Atoi(bf[i])
		switch {
		case aerr == nil && berr == nil:
			if an != bn {
				return an < bn
			}
		case af[i] != bf[i]:
			return af[i] < bf[i]
		}
	}
	// One is the other plus a tail: a numeric tail is newer, a pre-release
	// tail ("-rc1") is older.
	if len(af) < len(bf) {
		_, err := strconv.Atoi(bf[len(af)])
		return err == nil
	}
	if len(af) > len(bf) {
		_, err := strconv.Atoi(af[len(bf)])
		return err != nil
	}
	return false
}

var (
	badgingPackage = regexp.MustCompile(`(?m)^package: name='([^']*)' versionCode='([0-9]*)'`)
	badgingMinSdk  = regexp.MustCompile(`(?m)^(?:sdkVersion|minSdkVersion):'([0-9A-Za-z_.]+)'`)
	badgingTarget  = regexp.MustCompile(`(?m)^targetSdkVersion:'([0-9A-Za-z_.]+)'`)

	treePackage     = regexp.MustCompile(`(?m)^\s*A: package="([^"]*)"`)
	treeVersionCode = regexp.MustCompile(`(?m)^\s*A: [^\n]*android:versionCode\([^)]*\)=([0-9]+)(?:\s|$)`)
	treeMinSdk      = regexp.MustCompile(`(?m)^\s*A: [^\n]*android:minSdkVersion\([^)]*\)=([0-9]+)(?:\s|$)`)
	treeTargetSdk   = regexp.MustCompile(`(?m)^\s*A: [^\n]*android:targetSdkVersion\([^)]*\)=([0-9]+)(?:\s|$)`)
)

// ParseBadging reads `aapt2 dump badging <apk>` output.
func ParseBadging(out []byte) (Info, error) {
	m := badgingPackage.FindSubmatch(out)
	if m == nil {
		return Info{}, errors.New("no package line in the aapt2 badging output")
	}
	info := Info{Package: string(m[1])}
	info.VersionCode, _ = strconv.Atoi(string(m[2]))
	if m := badgingMinSdk.FindSubmatch(out); m != nil {
		info.MinSdk = string(m[1])
	}
	if m := badgingTarget.FindSubmatch(out); m != nil {
		info.TargetSdk = string(m[1])
	}
	return finish(info)
}

// ParseXMLTree reads `aapt2 dump xmltree` output of an AndroidManifest.xml.
func ParseXMLTree(out []byte) (Info, error) {
	m := treePackage.FindSubmatch(out)
	if m == nil {
		return Info{}, errors.New("no package attribute in the aapt2 xmltree output")
	}
	info := Info{Package: string(m[1])}
	if m := treeVersionCode.FindSubmatch(out); m != nil {
		info.VersionCode, _ = strconv.Atoi(string(m[1]))
	}
	if m := treeMinSdk.FindSubmatch(out); m != nil {
		info.MinSdk = string(m[1])
	}
	if m := treeTargetSdk.FindSubmatch(out); m != nil {
		info.TargetSdk = string(m[1])
	}
	return finish(info)
}

func finish(info Info) (Info, error) {
	if info.Package == "" {
		return Info{}, errors.New("the manifest has an empty package")
	}
	if info.VersionCode <= 0 {
		return Info{}, errors.New("the manifest has no versionCode")
	}
	return info, nil
}

// InspectAPK reads an APK's manifest summary.
func InspectAPK(ctx context.Context, run Runner, aapt2, apk string) (Info, error) {
	out, err := run(ctx, aapt2, "dump", "badging", apk)
	if err != nil {
		return Info{}, fmt.Errorf("aapt2 dump badging %s: %w", filepath.Base(apk), err)
	}
	info, err := ParseBadging(out)
	if err != nil {
		return Info{}, fmt.Errorf("%s: %w", filepath.Base(apk), err)
	}
	return info, nil
}

// manifestInBundle is the base module's manifest (protobuf XML).
const manifestInBundle = "base/manifest/AndroidManifest.xml"

// maxManifest bounds what is copied out of a bundle.
const maxManifest = 16 << 20

// InspectAAB reads a bundle's base manifest. aapt2 has no bundle reader, but
// it reads a proto manifest from a zip that holds it at the root, so the
// manifest is copied into a temporary one-file zip (no bundletool needed).
func InspectAAB(ctx context.Context, run Runner, aapt2, aab string) (Info, error) {
	fail := func(err error) (Info, error) {
		return Info{}, fmt.Errorf("%s: %w", filepath.Base(aab), err)
	}
	zr, err := zip.OpenReader(aab)
	if err != nil {
		return fail(err)
	}
	defer zr.Close()
	var src *zip.File
	for _, f := range zr.File {
		if f.Name == manifestInBundle {
			src = f
			break
		}
	}
	if src == nil {
		return fail(fmt.Errorf("no %s in the bundle", manifestInBundle))
	}
	if src.UncompressedSize64 > maxManifest {
		return fail(fmt.Errorf("%s is larger than %d bytes", manifestInBundle, maxManifest))
	}
	dir, err := os.MkdirTemp("", "yyt-aab-")
	if err != nil {
		return fail(err)
	}
	defer os.RemoveAll(dir)
	tmp := filepath.Join(dir, "manifest.zip")
	if err := writeManifestZip(src, tmp); err != nil {
		return fail(err)
	}
	out, err := run(ctx, aapt2, "dump", "xmltree", "--file", "AndroidManifest.xml", tmp)
	if err != nil {
		return fail(fmt.Errorf("aapt2 dump xmltree: %w", err))
	}
	info, err := ParseXMLTree(out)
	if err != nil {
		return fail(err)
	}
	return info, nil
}

func writeManifestZip(src *zip.File, dst string) error {
	in, err := src.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(out)
	w, err := zw.Create("AndroidManifest.xml")
	if err == nil {
		_, err = io.Copy(w, io.LimitReader(in, maxManifest))
	}
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}
