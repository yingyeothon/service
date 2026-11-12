package ios

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The tools are named by absolute path: `security` is handed the keychain
// password, and none of them should be whatever a PATH entry offers. (Tests
// replace these with bare names.)
var (
	Security = "/usr/bin/security"
	Codesign = "/usr/bin/codesign"
	OpenSSL  = "/usr/bin/openssl"
	Plutil   = "/usr/bin/plutil"
)

// Runner runs a tool and returns its stdout.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// Methods are the build profiles of an iOS deploy and the values of the
// `distribution_method` tag.
const (
	Development = "development"
	AdHoc       = "ad-hoc"
	AppStore    = "app-store"
)

// Methods lists them in help order.
var Methods = []string{Development, AdHoc, AppStore}

// ValidMethod reports whether m is a build profile.
func ValidMethod(m string) bool {
	return m == Development || m == AdHoc || m == AppStore
}

// IdentityName is the certificate kind a method signs with.
func IdentityName(method string) string {
	if method == Development {
		return "Apple Development"
	}
	return "Apple Distribution"
}

var (
	teamID   = regexp.MustCompile(`^[A-Z0-9]{10}$`)
	bundleID = regexp.MustCompile(`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`)
)

// CheckTeamID validates an Apple team id (ten upper-case letters or digits).
func CheckTeamID(id string) error {
	if !teamID.MatchString(id) {
		return errors.New("the Apple team id must be 10 upper-case letters or digits (--ios-team-id, IOS_TEAM_ID)")
	}
	return nil
}

// CheckBundleID validates a bundle identifier: dotted, letters, digits and
// hyphens only (an underscore is not allowed by Apple).
func CheckBundleID(id string) error {
	if !bundleID.MatchString(id) {
		return fmt.Errorf("invalid bundle id %q (dotted; letters, digits and - only, no _)", id)
	}
	return nil
}

// UnlockKeychain unlocks a keychain and lets codesign use its private keys
// without a GUI prompt: what a build over ssh needs, where the login keychain
// is locked. The password travels in argv (`security` offers nothing else),
// so no error or log line here may carry the arguments.
func UnlockKeychain(ctx context.Context, run Runner, keychain, password string) error {
	if _, err := run(ctx, Security, "unlock-keychain", "-p", password, keychain); err != nil {
		return fmt.Errorf("security unlock-keychain failed for %s (wrong CI_KEYCHAIN_PASSWORD?)", keychain)
	}
	if _, err := run(ctx, Security, "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain); err != nil {
		return fmt.Errorf("security set-key-partition-list failed for %s", keychain)
	}
	return nil
}

// Identity is one code-signing identity of the keychain search list.
type Identity struct {
	Hash string
	Name string
}

var identityLine = regexp.MustCompile(`(?m)^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"`)

// FindIdentity returns the valid identity a method signs with. A
// distribution certificate carries its team in the name — "Apple
// Distribution: Example Co. (ABCDE12345)" — so with several teams in one
// keychain the requested team's is taken, and its absence is an error here
// rather than at the end of the archive. A development certificate's
// parenthesis is a personal id, so the first one is taken.
func FindIdentity(ctx context.Context, run Runner, method, team string) (Identity, error) {
	want := IdentityName(method)
	out, err := run(ctx, Security, "find-identity", "-v", "-p", "codesigning")
	if err != nil {
		return Identity{}, fmt.Errorf("security find-identity: %w", err)
	}
	var seen []string
	var ofKind []Identity
	for _, m := range identityLine.FindAllSubmatch(out, -1) {
		name := string(m[2])
		if strings.HasPrefix(name, want+":") {
			ofKind = append(ofKind, Identity{Hash: string(m[1]), Name: name})
		}
		seen = append(seen, strings.SplitN(name, ":", 2)[0])
	}
	for _, id := range ofKind {
		if method == Development || team == "" || strings.HasSuffix(id.Name, "("+team+")") {
			return id, nil
		}
	}
	if len(ofKind) > 0 {
		return Identity{}, fmt.Errorf("the keychain has %q identities, but none for this team: install the team's certificate with its private key", want)
	}
	have := "none"
	if len(seen) > 0 {
		have = strings.Join(seen, ", ")
	}
	return Identity{}, fmt.Errorf("no %q code-signing identity is available to this shell (found: %s): install the certificate with its private key, and over ssh set CI_KEYCHAIN_PASSWORD so the keychain can be unlocked", want, have)
}

// ProbeCodesign signs a throwaway copy of /bin/echo. An identity can be
// listed and still be unusable from a shell (errSecInternalComponent: the
// keychain is locked or codesign is not on the key's partition list), and
// Xcode reports that only at the end of a long archive.
func ProbeCodesign(ctx context.Context, run Runner, id Identity) error {
	dir, err := os.MkdirTemp("", "yyt-codesign-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	probe := filepath.Join(dir, "probe")
	data, err := os.ReadFile("/bin/echo")
	if err != nil {
		// Not a Mac (tests): any file serves the fake.
		data = []byte("probe")
	}
	if err := os.WriteFile(probe, data, 0o700); err != nil {
		return err
	}
	if _, err := run(ctx, Codesign, "--force", "--sign", id.Hash, probe); err != nil {
		return fmt.Errorf("%q is installed but codesign cannot use its private key from this shell (%w): unlock the keychain and grant codesign access — set CI_KEYCHAIN_PASSWORD, or run `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <password> <keychain>`", id.Name, err)
	}
	return nil
}

// Profile is a decoded provisioning profile.
type Profile struct {
	Name         string
	UUID         string
	Path         string
	AppID        string // <team>.<bundle id> or <team>.*
	GetTaskAllow bool
	Devices      int
	AllDevices   bool // an enterprise profile
	Expires      time.Time
	XcodeManaged bool
	NotIOS       bool // the profile names its platforms and iOS is not one
}

// Kind is the distribution method a profile signs for; the three differ only
// in get-task-allow and the device list. "" for anything else (enterprise).
func (p Profile) Kind() string {
	switch {
	case p.AllDevices:
		return ""
	case p.GetTaskAllow:
		return Development
	case p.Devices > 0:
		return AdHoc
	}
	return AppStore
}

// Wildcard reports a profile for every app of its team.
func (p Profile) Wildcard() bool { return strings.HasSuffix(p.AppID, ".*") }

// ParseProfile reads the property list inside a .mobileprovision.
func ParseProfile(xmlPlist []byte) (Profile, error) {
	v, err := parsePlist(xmlPlist)
	if err != nil {
		return Profile{}, err
	}
	root, ok := v.(map[string]any)
	if !ok {
		return Profile{}, errors.New("provisioning profile is not a dict")
	}
	ent := dictOf(root, "Entitlements")
	p := Profile{Name: strOf(root, "Name"), UUID: strOf(root, "UUID"), AppID: strOf(ent, "application-identifier")}
	if platforms, ok := root["Platform"].([]any); ok && len(platforms) > 0 {
		p.NotIOS = true
		for _, v := range platforms {
			if name, _ := v.(string); name == "iOS" {
				p.NotIOS = false
			}
		}
	}
	p.GetTaskAllow, _ = boolOf(ent, "get-task-allow")
	p.XcodeManaged, _ = boolOf(root, "IsXcodeManaged")
	p.AllDevices, _ = boolOf(root, "ProvisionsAllDevices")
	if devices, ok := root["ProvisionedDevices"].([]any); ok {
		p.Devices = len(devices)
	}
	p.Expires, _ = root["ExpirationDate"].(time.Time)
	if p.Name == "" || p.AppID == "" {
		return Profile{}, errors.New("provisioning profile has no Name or application-identifier")
	}
	return p, nil
}

// DecodeProfile extracts the property list from a signed .mobileprovision
// with openssl (`security cms -D` fails on Xcode-managed profiles).
func DecodeProfile(ctx context.Context, run Runner, path string) (Profile, error) {
	out, err := run(ctx, OpenSSL, "smime", "-inform", "der", "-verify", "-noverify", "-in", path)
	if err != nil {
		return Profile{}, fmt.Errorf("openssl smime: %w", err)
	}
	p, err := ParseProfile(out)
	if err != nil {
		return Profile{}, err
	}
	p.Path = path
	return p, nil
}

// ProfileDirs are where Xcode (16+, then older) keeps installed profiles.
func ProfileDirs(home string) []string {
	return []string{
		filepath.Join(home, "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
		filepath.Join(home, "Library", "MobileDevice", "Provisioning Profiles"),
	}
}

// ListProfiles decodes every installed profile. A file that does not decode
// is skipped, since one broken profile must not hide the others, and counted:
// when nothing decodes, "no profile matched" would be a guess.
func ListProfiles(ctx context.Context, run Runner, dirs []string) (profiles []Profile, undecoded int) {
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".mobileprovision") {
				continue
			}
			p, err := DecodeProfile(ctx, run, filepath.Join(dir, e.Name()))
			if err != nil {
				undecoded++
				continue
			}
			profiles = append(profiles, p)
		}
	}
	return profiles, undecoded
}

// Matches reports whether a profile can sign team's bundle for method. A
// wildcard profile is accepted for development only, unless allowed: a
// distribution build signed with one loses its app-specific entitlements
// (push, associated domains).
func (p Profile) Matches(team, bundle, method string, allowWildcard bool, now time.Time) bool {
	switch p.AppID {
	case team + "." + bundle:
	case team + ".*":
		if method != Development && !allowWildcard {
			return false
		}
	default:
		return false
	}
	if p.Kind() != method || p.NotIOS {
		return false
	}
	// A profile without an expiry date is not one Apple issued.
	return p.Expires.After(now)
}

// SelectProfile picks the profile to export with: an exact app id before a
// wildcard, a manually installed one before an Xcode-managed one, then the
// one that expires last (the reference script took the
// first match and did not look at expiry).
func SelectProfile(profiles []Profile, team, bundle, method string, allowWildcard bool, now time.Time) (Profile, bool) {
	var ok []Profile
	for _, p := range profiles {
		if p.Matches(team, bundle, method, allowWildcard, now) {
			ok = append(ok, p)
		}
	}
	if len(ok) == 0 {
		return Profile{}, false
	}
	sort.SliceStable(ok, func(i, j int) bool {
		if ok[i].Wildcard() != ok[j].Wildcard() {
			return !ok[i].Wildcard()
		}
		// A manual export works without an Apple account in Xcode; an
		// Xcode-managed profile forces automatic signing.
		if ok[i].XcodeManaged != ok[j].XcodeManaged {
			return !ok[i].XcodeManaged
		}
		return ok[i].Expires.After(ok[j].Expires)
	})
	return ok[0], true
}

// AutomaticSigning reports whether the Xcode project signs automatically, in
// which case a missing profile is Xcode's to create at export time.
func AutomaticSigning(projectPath string) bool {
	data, err := os.ReadFile(filepath.Join(projectPath, "ios", "Runner.xcodeproj", "project.pbxproj"))
	return err == nil && strings.Contains(string(data), "CODE_SIGN_STYLE = Automatic;")
}

// ExportOptions renders ExportOptions.plist. An empty profile name means
// automatic signing; otherwise the export is pinned to that profile and the
// method's certificate kind.
func ExportOptions(method, team, bundle, profileName string) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`)
	kv := func(indent, k, v string) {
		fmt.Fprintf(&b, "%s<key>%s</key>\n%s<string>%s</string>\n", indent, escapeXML(k), indent, escapeXML(v))
	}
	kv("\t", "method", method)
	if profileName == "" {
		kv("\t", "signingStyle", "automatic")
		kv("\t", "teamID", team)
	} else {
		kv("\t", "signingCertificate", IdentityName(method))
		kv("\t", "signingStyle", "manual")
		kv("\t", "teamID", team)
		b.WriteString("\t<key>provisioningProfiles</key>\n\t<dict>\n")
		kv("\t\t", bundle, profileName)
		b.WriteString("\t</dict>\n")
	}
	b.WriteString("</dict>\n</plist>\n")
	return []byte(b.String())
}

// BuildEnv returns the environment changes an export needs, as KEY=VALUE:
// the system tools ahead of Homebrew on PATH (Xcode's IPA step runs
// /usr/bin/rsync, which picks its helper from PATH and breaks on Homebrew's),
// and a UTF-8 locale (CocoaPods and xcodebuild fail without one in a
// headless session).
func BuildEnv(getenv func(string) string) map[string]string {
	path := "/usr/bin:/bin:/usr/sbin:/sbin"
	if rest := getenv("PATH"); rest != "" {
		// No trailing ":" for an empty PATH: that would mean the current
		// directory, which is the project.
		path += ":" + rest
	}
	env := map[string]string{"PATH": path}
	utf8 := func(v string) bool {
		v = strings.ToLower(v)
		return strings.Contains(v, "utf-8") || strings.Contains(v, "utf8")
	}
	lang := getenv("LANG")
	if !utf8(lang) {
		lang = "en_US.UTF-8"
		env["LANG"] = lang
	}
	if !utf8(getenv("LC_ALL")) {
		env["LC_ALL"] = lang
	}
	return env
}
