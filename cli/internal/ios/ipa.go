package ios

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var osVersion = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,2}$`)

// IPAInfo is what the built archive says about itself.
type IPAInfo struct {
	BundleID  string
	Version   string // CFBundleShortVersionString
	Build     string // CFBundleVersion
	MinimumOS string
	// Profile is the embedded provisioning profile: how the app was really
	// signed. nil when the archive has none (an unsigned build).
	Profile *Profile
}

// maxEntry bounds what is read out of an archive.
const maxEntry = 16 << 20

func readEntry(f *zip.File) ([]byte, error) {
	if f.UncompressedSize64 > maxEntry {
		return nil, fmt.Errorf("%q is larger than %d bytes", f.Name, maxEntry)
	}
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	data, err := io.ReadAll(io.LimitReader(r, maxEntry+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxEntry {
		return nil, fmt.Errorf("%q is larger than %d bytes", f.Name, maxEntry)
	}
	return data, nil
}

// withTemp writes data to a temporary file for a tool that reads a path.
func withTemp(data []byte, fn func(path string) ([]byte, error)) ([]byte, error) {
	dir, err := os.MkdirTemp("", "yyt-ipa-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "entry")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		return nil, err
	}
	return fn(p)
}

// InspectIPA reads Payload/<name>.app/Info.plist and embedded.mobileprovision
// from an IPA. The values come from the archive that will be uploaded, never
// from configuration: an IPA left by another build, or built for another
// bundle id, is caught here. A binary Info.plist is converted with `plutil`.
func InspectIPA(ctx context.Context, run Runner, ipa string) (IPAInfo, error) {
	var info IPAInfo
	fail := func(err error) (IPAInfo, error) {
		return IPAInfo{}, fmt.Errorf("%s: %w", filepath.Base(ipa), err)
	}
	zr, err := zip.OpenReader(ipa)
	if err != nil {
		return fail(err)
	}
	defer zr.Close()
	// Exactly one Payload/<x>.app: nested bundles (extensions, frameworks)
	// have their own Info.plist deeper down and are not the app.
	var plist, provision *zip.File
	app := ""
	for _, f := range zr.File {
		parts := strings.Split(f.Name, "/")
		if len(parts) != 3 || parts[0] != "Payload" || !strings.HasSuffix(parts[1], ".app") {
			continue
		}
		if app != "" && parts[1] != app {
			return fail(errors.New("more than one app in Payload/"))
		}
		app = parts[1]
		switch parts[2] {
		case "Info.plist":
			if plist != nil {
				// Two entries of one name: which one an installer reads
				// is not ours to guess.
				return fail(errors.New("Info.plist appears twice in the app"))
			}
			plist = f
		case "embedded.mobileprovision":
			if provision != nil {
				return fail(errors.New("embedded.mobileprovision appears twice in the app"))
			}
			provision = f
		}
	}
	if plist == nil {
		return fail(errors.New("no Payload/<name>.app/Info.plist"))
	}
	raw, err := readEntry(plist)
	if err != nil {
		return fail(err)
	}
	if bytes.HasPrefix(raw, []byte("bplist")) {
		if raw, err = withTemp(raw, func(p string) ([]byte, error) {
			return run(ctx, Plutil, "-convert", "xml1", "-o", "-", p)
		}); err != nil {
			return fail(fmt.Errorf("plutil %s: %w", path.Base(plist.Name), err))
		}
	}
	root, err := parsePlist(raw)
	if err != nil {
		return fail(fmt.Errorf("Info.plist: %w", err))
	}
	info.BundleID = strOf(root, "CFBundleIdentifier")
	info.Version = strOf(root, "CFBundleShortVersionString")
	info.Build = strOf(root, "CFBundleVersion")
	info.MinimumOS = strOf(root, "MinimumOSVersion")
	if info.BundleID == "" || info.Version == "" || info.Build == "" {
		return fail(errors.New("Info.plist lacks CFBundleIdentifier, CFBundleShortVersionString or CFBundleVersion"))
	}
	// This value becomes a tag even when no expectation is configured.
	if info.MinimumOS != "" && !osVersion.MatchString(info.MinimumOS) {
		return fail(fmt.Errorf("Info.plist MinimumOSVersion %q is not a version", info.MinimumOS))
	}
	if provision != nil {
		data, err := readEntry(provision)
		if err != nil {
			return fail(err)
		}
		xmlPlist, err := withTemp(data, func(p string) ([]byte, error) {
			return run(ctx, OpenSSL, "smime", "-inform", "der", "-verify", "-noverify", "-in", p)
		})
		if err != nil {
			return fail(fmt.Errorf("embedded.mobileprovision: openssl smime: %w", err))
		}
		p, err := ParseProfile(xmlPlist)
		if err != nil {
			return fail(fmt.Errorf("embedded.mobileprovision: %w", err))
		}
		info.Profile = &p
	}
	return info, nil
}

// Expect is what the IPA must turn out to be.
type Expect struct {
	BundleID  string
	Version   string // pubspec x.y.z
	Build     string // pubspec +n
	MinimumOS string // "" = not checked
	Method    string
	Team      string
	// Signed is false for a build that skipped signing; the embedded profile
	// is then not required.
	Signed bool
	// AllowWildcard accepts a team-wide profile for a distribution build.
	AllowWildcard bool
	// ProfileUUID is the installed profile a manual export was pinned to
	// ("" = automatic signing): the export names it by name, and two
	// profiles can share one.
	ProfileUUID string
	// Now, when set, refuses an embedded profile that has expired.
	Now time.Time
}

// Check compares the archive with what the deploy was asked to ship. Every
// difference is an error: there is no development-build exception for the
// bundle id, because an IPA has no suffix convention to excuse one.
func (info IPAInfo) Check(want Expect) error {
	var bad []string
	diff := func(what, got, expected string) {
		if got != expected {
			bad = append(bad, fmt.Sprintf("%s is %q, expected %q", what, got, expected))
		}
	}
	diff("bundle id", info.BundleID, want.BundleID)
	diff("version", info.Version, want.Version)
	// "04" and "4" are one build number, "15" and "15.0" one OS version.
	if sameNumber(info.Build, want.Build) {
		info.Build = want.Build
	}
	diff("build number", info.Build, want.Build)
	if want.MinimumOS != "" && trimZeros(info.MinimumOS) != trimZeros(want.MinimumOS) {
		diff("minimum OS", info.MinimumOS, want.MinimumOS)
	}
	switch {
	case info.Profile == nil && want.Signed:
		bad = append(bad, "the app has no embedded provisioning profile (it was not signed for distribution)")
	case info.Profile != nil:
		p := info.Profile
		if kind := p.Kind(); kind != want.Method {
			if kind == "" {
				kind = "enterprise"
			}
			bad = append(bad, fmt.Sprintf("it is signed with a %s profile (%q), expected %s", kind, p.Name, want.Method))
		}
		if want.ProfileUUID != "" && p.UUID != want.ProfileUUID {
			bad = append(bad, fmt.Sprintf("it embeds another copy of the profile %q than the installed one the export was pinned to (an older profile of the same name?)", p.Name))
		}
		if !want.Now.IsZero() && !p.Expires.After(want.Now) {
			bad = append(bad, fmt.Sprintf("its profile %q has expired", p.Name))
		}
		switch {
		case want.Team == "" || p.AppID == want.Team+"."+want.BundleID:
		case p.AppID == want.Team+".*":
			// The same rule as the preflight: automatic signing must not
			// slip a wildcard profile into a distribution build.
			if want.Method != Development && !want.AllowWildcard {
				bad = append(bad, fmt.Sprintf("its profile %q is a wildcard profile (allowed for development only)", p.Name))
			}
		default:
			bad = append(bad, fmt.Sprintf("its profile %q is not for this team and bundle id", p.Name))
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("the IPA is not what this deploy should upload: %s", strings.Join(bad, "; "))
	}
	return nil
}

func sameNumber(a, b string) bool {
	x, errA := strconv.Atoi(a)
	y, errB := strconv.Atoi(b)
	return errA == nil && errB == nil && x == y
}

// trimZeros drops trailing ".0" segments of a version.
func trimZeros(v string) string {
	for strings.HasSuffix(v, ".0") {
		v = strings.TrimSuffix(v, ".0")
	}
	return v
}
