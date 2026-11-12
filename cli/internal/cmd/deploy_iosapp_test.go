package cmd

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/ios"
)

const (
	iosTeam   = "ABCDE12345"
	iosBundle = "com.example.sample"
)

func iosProfileXML(name, appID string, getTaskAllow bool, devices int, expires string, managed bool) string {
	devs := ""
	if devices > 0 {
		devs = "<key>ProvisionedDevices</key><array>" + strings.Repeat("<string>00008030-00000000000000</string>", devices) + "</array>"
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
 <key>Name</key><string>%s</string>
 <key>ExpirationDate</key><date>%s</date>
 <key>IsXcodeManaged</key><%t/>
 <key>Entitlements</key><dict>
  <key>application-identifier</key><string>%s</string>
  <key>get-task-allow</key><%t/>
 </dict>
 %s
</dict></plist>`, name, expires, managed, appID, getTaskAllow, devs)
}

func iosInfoPlist(bundle, version, build, minOS string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
 <key>CFBundleIdentifier</key><string>%s</string>
 <key>CFBundleShortVersionString</key><string>%s</string>
 <key>CFBundleVersion</key><string>%s</string>
 <key>MinimumOSVersion</key><string>%s</string>
</dict></plist>`, bundle, version, build, minOS)
}

// iosHost is the fake Mac: its keychain, installed profiles and what the
// next `flutter build ipa` packages.
type iosHost struct {
	t          *testing.T
	home       string
	identities string
	codesign   error
	tools      []string // every tool call, arguments included

	// The IPA the fake build writes.
	ipaName  string
	info     string // Info.plist
	embedded string // embedded.mobileprovision ("" = none)
	second   string // a second .ipa the build leaves
	onBuild  func(n int, args []string)
	unlock   error
	git      func(args []string) ([]byte, error)
	flutter  string
	exports  []string
	builds   [][]string
	pods     []string
}

const bothIdentities = `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Sample Dev (AAAAA11111)"
  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Distribution: Example Co. (ABCDE12345)"
     2 valid identities found
`

func (h *iosHost) install(name, xml string) {
	h.t.Helper()
	writeFile(h.t, filepath.Join(h.home, "Library", "MobileDevice", "Provisioning Profiles", name+".mobileprovision"), xml)
}

// newIOSHost fakes a Mac with both identities and an ad-hoc profile, and a
// build that packages what the project asks for.
func newIOSHost(t *testing.T, proj string) *iosHost {
	t.Helper()
	adhoc := iosProfileXML("Sample Ad Hoc", iosTeam+"."+iosBundle, false, 2, "2030-01-01T00:00:00Z", false)
	h := &iosHost{t: t, home: t.TempDir(), identities: bothIdentities, ipaName: "샘플 앱.ipa",
		info: iosInfoPlist(iosBundle, "1.2.3", "4", "15.5"), embedded: adhoc}
	h.install("adhoc", adhoc)
	// The fakes answer to the tools' bare names.
	prevTools := [4]string{ios.Security, ios.Codesign, ios.OpenSSL, ios.Plutil}
	ios.Security, ios.Codesign, ios.OpenSSL, ios.Plutil = "security", "codesign", "openssl", "plutil"
	t.Cleanup(func() {
		ios.Security, ios.Codesign, ios.OpenSSL, ios.Plutil = prevTools[0], prevTools[1], prevTools[2], prevTools[3]
	})
	prevOS, prevEnv, prevHome, prevNow := hostOS, applyBuildEnv, userHome, clockNow
	hostOS = "darwin"
	envApplied := 0
	applyBuildEnv = func() { envApplied++ }
	userHome = func() (string, error) { return h.home, nil }
	clockNow = func() time.Time { return time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { hostOS, applyBuildEnv, userHome, clockNow = prevOS, prevEnv, prevHome, prevNow })

	fakeBuild(t, func(dir string, args []string) error {
		if args[0] == "pub" {
			h.pods = append(h.pods, "flutter "+strings.Join(args, " "))
			return nil
		}
		h.builds = append(h.builds, args)
		if os.Getenv("CI_KEYCHAIN_PASSWORD") != "" {
			t.Error("the build inherited the keychain password")
		}
		if envApplied == 0 {
			t.Error("the build ran before the environment was fixed up")
		}
		ipaDir := filepath.Join(dir, "build", "ios", "ipa")
		if left, _ := os.ReadDir(ipaDir); len(left) != 0 {
			t.Errorf("stale IPAs survived the clean: %v", left)
		}
		for _, a := range args {
			if p, ok := strings.CutPrefix(a, "--export-options-plist="); ok {
				data, err := os.ReadFile(p)
				if err != nil {
					return err
				}
				h.exports = append(h.exports, string(data))
			}
		}
		if h.onBuild != nil {
			h.onBuild(len(h.builds), args)
		}
		if h.ipaName == "" {
			return nil
		}
		if h.second != "" {
			writeFile(t, filepath.Join(ipaDir, h.second), "another")
		}
		if err := os.MkdirAll(ipaDir, 0o755); err != nil {
			return err
		}
		f, err := os.Create(filepath.Join(ipaDir, h.ipaName))
		if err != nil {
			return err
		}
		zw := zip.NewWriter(f)
		w, _ := zw.Create("Payload/Runner.app/Info.plist")
		_, _ = w.Write([]byte(h.info))
		if h.embedded != "" {
			w, _ = zw.Create("Payload/Runner.app/embedded.mobileprovision")
			_, _ = w.Write([]byte(h.embedded))
		}
		_ = zw.Close()
		return f.Close()
	})
	fakeHook = func(dir, name string) error {
		h.pods = append(h.pods, otherRuns[len(otherRuns)-1])
		if os.Getenv("CI_KEYCHAIN_PASSWORD") != "" {
			t.Errorf("%s inherited the keychain password", name)
		}
		return nil
	}
	deployOutput = func(_ context.Context, _, name string, args ...string) ([]byte, error) {
		h.tools = append(h.tools, name+" "+strings.Join(args, " "))
		switch name {
		case "git":
			if h.git != nil {
				return h.git(args)
			}
			return nil, errors.New("fatal: not a git repository")
		case "flutter":
			if h.flutter != "" {
				return []byte(`{"frameworkVersion":"` + h.flutter + `"}`), nil
			}
		case "security":
			if args[0] == "find-identity" {
				return []byte(h.identities), nil
			}
			return nil, h.unlock
		case "codesign":
			return nil, h.codesign
		case "openssl":
			return os.ReadFile(args[len(args)-1])
		}
		return nil, fmt.Errorf("%s is not available in this test", name)
	}
	_ = proj
	return h
}

func iosArgs(proj string, extra ...string) []string {
	return append([]string{"catalog", "deploy", "--platform", "ios", "--project-path", proj, "--name", "demo",
		"--bundle-id", iosBundle, "--ios-team-id", iosTeam, "--build-profile", "ad-hoc", "--no-verify"}, extra...)
}

// The whole path: preflight, a manual ExportOptions pinned to the installed
// ad-hoc profile, build, the IPA read back, and an upload tagged from it.
func TestDeployIOS(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeFile(t, filepath.Join(proj, "build", "ios", "ipa", "old.ipa"), "stale")
	h := newIOSHost(t, proj)
	const pw = "hunter2-s3cret"
	t.Setenv("CI_KEYCHAIN_PASSWORD", pw)
	t.Setenv("CI_KEYCHAIN_PATH", "")
	t.Setenv("SAMPLE_DSN", "dsn-s3cret")
	f, committed := deployFake(t)
	out, errs, err := run(t, f, iosArgs(proj, "--stage", "beta", "--dart-define", "SAMPLE_DSN", "--flavor", "pro", "--commit", "abc1234", "--", "--obfuscate")...)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.builds) != 1 {
		t.Fatalf("builds: %v", h.builds)
	}
	got := strings.Join(h.builds[0], " ")
	if !strings.HasPrefix(got, "build ipa --release --flavor pro --dart-define=SAMPLE_DSN=dsn-s3cret --obfuscate --export-options-plist=") {
		t.Fatalf("build args: %q", got)
	}
	for _, want := range []string{"<string>ad-hoc</string>", "<string>manual</string>", "<string>Apple Distribution</string>",
		"<key>" + iosBundle + "</key>", "<string>Sample Ad Hoc</string>", "<string>" + iosTeam + "</string>"} {
		if !strings.Contains(h.exports[0], want) {
			t.Fatalf("ExportOptions lacks %s:\n%s", want, h.exports[0])
		}
	}
	plist := strings.TrimPrefix(h.builds[0][len(h.builds[0])-1], "--export-options-plist=")
	if _, err := os.Stat(plist); err == nil {
		t.Fatal("the temporary ExportOptions.plist was left behind")
	}
	tags := (*committed)[0]
	for k, want := range map[string]string{"version": "1.2.3+4", "bundle_id": iosBundle, "build_number": "4",
		"distribution_method": "ad-hoc", "minimum_os_version": "15.5", "stage": "beta", "commit": "abc1234"} {
		if tags[k] != want {
			t.Fatalf("tag %s = %v, want %s", k, tags[k], want)
		}
	}
	// The upload has an ASCII name, whatever the product is called.
	if _, err := os.Stat(filepath.Join(proj, "build", "ios", "yyt", "demo-1.2.3+4-ad-hoc.ipa")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errs, `signing ad-hoc: Apple Distribution: Example Co. (ABCDE12345), profile "Sample Ad Hoc"`) ||
		!strings.Contains(errs, "defines SAMPLE_DSN") || !strings.Contains(out, "ad-hoc") {
		t.Fatalf("output:\n%s\n%s", out, errs)
	}
	// The keychain was unlocked with the password in argv, and neither it
	// nor the define value was printed.
	tools := strings.Join(h.tools, "\n")
	if !strings.Contains(tools, "security unlock-keychain -p "+pw+" "+filepath.Join(h.home, "Library", "Keychains", "login.keychain-db")) ||
		!strings.Contains(tools, "security set-key-partition-list") || !strings.Contains(tools, "codesign --force --sign 89ABCDEF") {
		t.Fatalf("tools:\n%s", tools)
	}
	if strings.Contains(out+errs, "s3cret") {
		t.Fatalf("a secret was printed:\n%s\n%s", out, errs)
	}
}

// Everything the preflight exists for: each of these stops before a build,
// a bump or a console request.
func TestDeployIOSPreflightRefusals(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *iosHost, proj string)
		args  []string
		want  string
	}{
		{"not macOS", func(*iosHost, string) { hostOS = "linux" }, nil, "builds on macOS only (this is linux)"},
		{"no team id", nil, []string{"--ios-team-id", ""}, "needs the Apple team id"},
		{"bad team id", nil, []string{"--ios-team-id", "abc"}, "team id must be 10"},
		{"no identity", func(h *iosHost, _ string) { h.identities = "     0 valid identities found\n" }, nil, `no "Apple Distribution" code-signing identity`},
		{"only a development identity", func(h *iosHost, _ string) {
			h.identities = strings.Split(bothIdentities, "\n")[0] + "\n"
		}, nil, "found: Apple Development"},
		{"codesign cannot use the key", func(h *iosHost, _ string) { h.codesign = errors.New("errSecInternalComponent") }, nil, "codesign cannot use its private key"},
		{"app-store profile for ad-hoc", func(h *iosHost, _ string) {
			h.install("adhoc", iosProfileXML("Store", iosTeam+"."+iosBundle, false, 0, "2030-01-01T00:00:00Z", false))
		}, nil, "no installed provisioning profile signs"},
		{"development profile for ad-hoc", func(h *iosHost, _ string) {
			h.install("adhoc", iosProfileXML("Dev", iosTeam+"."+iosBundle, true, 2, "2030-01-01T00:00:00Z", false))
		}, nil, "no installed provisioning profile signs"},
		{"expired", func(h *iosHost, _ string) {
			h.install("adhoc", iosProfileXML("Old", iosTeam+"."+iosBundle, false, 2, "2026-01-01T00:00:00Z", false))
		}, nil, "no installed provisioning profile signs"},
		{"wildcard for distribution", func(h *iosHost, _ string) {
			h.install("adhoc", iosProfileXML("Wild", iosTeam+".*", false, 2, "2030-01-01T00:00:00Z", false))
		}, nil, "no installed provisioning profile signs"},
		{"another app's profile", func(h *iosHost, _ string) {
			h.install("adhoc", iosProfileXML("Pro", iosTeam+"."+iosBundle+".pro", false, 2, "2030-01-01T00:00:00Z", false))
		}, nil, "no installed provisioning profile signs"},
		{"Podfile without cocoapods", func(_ *iosHost, proj string) { writeFile(t, filepath.Join(proj, "ios", "Podfile"), "") }, nil, "ios/Podfile exists but CocoaPods is off"},
		{"cocoapods without Podfile", nil, []string{"--cocoapods"}, "ios/Podfile is missing"},
		{"android profile", nil, []string{"--build-profile", "release"}, `invalid --build-profile "release" for --platform ios`},
		{"android flag", nil, []string{"--split-per-abi"}, "--split-per-abi is an Android option"},
		{"reserved passthrough", nil, []string{"--", "--no-codesign"}, "--no-codesign cannot be passed after --"},
		{"export method passthrough", nil, []string{"--", "--export-method=app-store"}, "--export-method cannot be passed after --"},
		{"tag deploy owns", nil, []string{"--tag", "bundle_id=com.example.other"}, "--tag bundle_id: deploy sets"},
		{"bundle id with underscore", nil, []string{"--bundle-id", "com.example.my_app"}, "invalid bundle id"},
		{"check and skip", nil, []string{"--check-signing", "--skip-signing-preflight"}, "cannot be combined"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			h := newIOSHost(t, proj)
			t.Setenv("IOS_TEAM_ID", "")
			t.Setenv("CI_KEYCHAIN_PASSWORD", "")
			if c.setup != nil {
				c.setup(h, proj)
			}
			f, committed := deployFake(t)
			_, _, err := run(t, f, iosArgs(proj, append([]string{"--do-bump"}, c.args...)...)...)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); len(h.builds) != 0 || len(*committed) != 0 || len(f.reqs) != 0 || !strings.Contains(string(b), "1.2.3+4") {
				t.Fatalf("side effects before the refusal: builds %d, requests %d, pubspec %s", len(h.builds), len(f.reqs), b)
			}
		})
	}
}

// Without a matching profile, a project that signs automatically exports
// automatically; so does an Xcode-managed profile, and --skip-signing-preflight.
func TestDeployIOSAutomaticSigning(t *testing.T) {
	for name, setup := range map[string]func(h *iosHost, proj string) []string{
		"automatic project": func(h *iosHost, proj string) []string {
			_ = os.Remove(filepath.Join(h.home, "Library", "MobileDevice", "Provisioning Profiles", "adhoc.mobileprovision"))
			writeFile(t, filepath.Join(proj, "ios", "Runner.xcodeproj", "project.pbxproj"), "CODE_SIGN_STYLE = Automatic;\n")
			return nil
		},
		"xcode-managed profile": func(h *iosHost, _ string) []string {
			h.install("adhoc", iosProfileXML("iOS Team Ad Hoc Provisioning Profile", iosTeam+"."+iosBundle, false, 2, "2030-01-01T00:00:00Z", true))
			return nil
		},
		"skipped preflight": func(h *iosHost, _ string) []string {
			h.identities = ""
			return []string{"--skip-signing-preflight"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			h := newIOSHost(t, proj)
			extra := setup(h, proj)
			f, committed := deployFake(t)
			if _, _, err := run(t, f, iosArgs(proj, extra...)...); err != nil {
				t.Fatal(err)
			}
			if len(h.exports) != 1 || !strings.Contains(h.exports[0], "<string>automatic</string>") || strings.Contains(h.exports[0], "provisioningProfiles") {
				t.Fatalf("ExportOptions:\n%v", h.exports)
			}
			if len(*committed) != 1 {
				t.Fatalf("uploads: %v", *committed)
			}
		})
	}
}

// The archive decides: an IPA that is not the bundle id, version, build,
// minimum OS or signing kind this deploy is for is not uploaded.
func TestDeployIOSChecksTheIPA(t *testing.T) {
	adhoc := iosProfileXML("Sample Ad Hoc", iosTeam+"."+iosBundle, false, 2, "2030-01-01T00:00:00Z", false)
	for want, change := range map[string]func(h *iosHost){
		`bundle id is "com.example.sample.debug"`: func(h *iosHost) { h.info = iosInfoPlist(iosBundle+".debug", "1.2.3", "4", "15.5") },
		`version is "1.2.2"`:                      func(h *iosHost) { h.info = iosInfoPlist(iosBundle, "1.2.2", "4", "15.5") },
		`build number is "3"`:                     func(h *iosHost) { h.info = iosInfoPlist(iosBundle, "1.2.3", "3", "15.5") },
		`minimum OS is "13.0", expected "15.5"`:   func(h *iosHost) { h.info = iosInfoPlist(iosBundle, "1.2.3", "4", "13.0") },
		"signed with a app-store profile": func(h *iosHost) {
			h.embedded = iosProfileXML("Store", iosTeam+"."+iosBundle, false, 0, "2030-01-01T00:00:00Z", false)
		},
		"signed with a development profile": func(h *iosHost) {
			h.embedded = iosProfileXML("Dev", iosTeam+".*", true, 2, "2030-01-01T00:00:00Z", false)
		},
		"is a wildcard profile": func(h *iosHost) {
			h.embedded = iosProfileXML("Wild", iosTeam+".*", false, 2, "2030-01-01T00:00:00Z", false)
		},
		"MinimumOSVersion":                   func(h *iosHost) { h.info = iosInfoPlist(iosBundle, "1.2.3", "4", "15.5&#10;x") },
		"is not for this team and bundle id": func(h *iosHost) { h.embedded = strings.Replace(adhoc, iosTeam, "ZZZZZ99999", 1) },
		"no embedded provisioning profile":   func(h *iosHost) { h.embedded = "" },
		"expected exactly one .ipa":          func(h *iosHost) { h.ipaName = "" },
	} {
		t.Run(want, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			writeFile(t, filepath.Join(proj, ContextFile), `{"team":"dooroo","project":"game","build":{"ios":{"minimumOsVersion":"15.5"}}}`)
			h := newIOSHost(t, proj)
			change(h)
			committed := &[]map[string]any{}
			listCalls := 0
			var f *fakeConsole
			routes := deployRoutes(&f, committed, &listCalls, 1)
			routes["GET /projects/prj_1/catalog/apps"] = func(recorded) (int, any) { return 200, map[string]any{"apps": []any{}} }
			created := false
			routes["POST /projects/prj_1/catalog/apps"] = func(recorded) (int, any) { created = true; return 201, map[string]any{"id": "ca_1"} }
			f = newFake(t, routes)
			withProject(t)
			_, _, err := run(t, f, iosArgs(proj)...)
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("err = %v, want %q", err, want)
			}
			if created || len(*committed) != 0 {
				t.Fatal("the app was created or the IPA uploaded despite the mismatch")
			}
		})
	}
}

// --check-signing, --print-config (on any OS), --no-upload and the config.
func TestDeployIOSConfigAndReports(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeFile(t, filepath.Join(proj, ContextFile), `{"team":"dooroo","project":"game",
	 "variants":{"pro":{"flavor":"pro","app":"demo","applicationId":"com.example.sample.pro","bundleId":"com.example.sample"}},
	 "build":{"versionTag":"full","ios":{"teamId":"ABCDE12345","versionTag":"marketing","useCocoapods":true,
	  "profiles":{"ad-hoc":{"stage":"beta","dartDefines":["SAMPLE_DSN"]},"development":{"stage":"dev"}}}}}`)
	writeFile(t, filepath.Join(proj, "ios", "Podfile"), "platform :ios, '15.5'\n")
	h := newIOSHost(t, proj)
	h.install("dev", iosProfileXML("Sample Dev", iosTeam+".*", true, 2, "2029-06-01T00:00:00Z", false))
	t.Setenv("IOS_TEAM_ID", "")
	t.Setenv("CI_KEYCHAIN_PASSWORD", "")
	t.Setenv("SAMPLE_DSN", "dsn-s3cret")
	f, committed := deployFake(t)
	base := []string{"catalog", "deploy", "--platform", "ios", "--project-path", proj, "--variant", "pro", "--no-verify"}

	out, _, err := run(t, f, append(base, "--build-profile", "ad-hoc", "--build-profile", "development", "--check-signing")...)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`ad-hoc: Apple Distribution: Example Co. (ABCDE12345); profile "Sample Ad Hoc" expires 2030-01-01`,
		`development: Apple Development: Sample Dev (AAAAA11111); profile "Sample Dev" expires 2029-06-01, wildcard`} {
		if !strings.Contains(out, want) {
			t.Fatalf("--check-signing lacks %q:\n%s", want, out)
		}
	}
	if len(h.builds) != 0 || len(f.reqs) != 0 {
		t.Fatal("--check-signing built or called the console")
	}

	// --print-config needs no Mac and prints neither the team id nor a value.
	hostOS = "linux"
	out, _, err = run(t, f, append(base, "--build-profile", "ad-hoc", "--print-config")...)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"platform: ios", "bundleId: com.example.sample", "teamId: set", "versionTag: marketing", "useCocoapods: true",
		`ad-hoc (stage "beta"): flutter build ipa --release --flavor pro --dart-define=SAMPLE_DSN=*** --export-options-plist=<generated>`} {
		if !strings.Contains(out, want) {
			t.Fatalf("--print-config lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, iosTeam) || strings.Contains(out, "s3cret") {
		t.Fatalf("--print-config printed the team id or a define value:\n%s", out)
	}
	hostOS = "darwin"

	// --no-upload: built and checked, no console; the config's stage, tag
	// rule and CocoaPods setting apply to the upload run.
	out, _, err = run(t, f, append(base, "--build-profile", "ad-hoc", "--no-upload", "--json")...)
	if err != nil || !strings.Contains(out, `"bundleId": "com.example.sample"`) || !strings.Contains(out, `"buildNumber": "4"`) || len(f.reqs) != 0 {
		t.Fatalf("--no-upload: %v\n%s", err, out)
	}
	if _, _, err := run(t, f, append(base, "--build-profile", "ad-hoc")...); err != nil {
		t.Fatal(err)
	}
	if got := (*committed)[0]; got["version"] != "1.2.3" || got["build_number"] != "4" || got["stage"] != "beta" {
		t.Fatalf("tags: %v", got)
	}
	if n := len(h.pods); n < 2 || h.pods[n-2] != "flutter pub get" || h.pods[n-1] != "pod install in ios" {
		t.Fatalf("pod install: %v", h.pods)
	}

	// build.ios is as strict as the rest of the config.
	for want, doc := range map[string]string{
		`unknown field "bundleid2"`:           `{"build":{"ios":{"bundleid2":"x"}}}`,
		`must be spelled "bundleId"`:          `{"build":{"ios":{"bundleID":"com.example.sample"}}}`,
		"unknown profile":                     `{"build":{"ios":{"profiles":{"release":{}}}}}`,
		"ios.teamId":                          `{"build":{"ios":{"teamId":"abc"}}}`,
		"ios.minimumOsVersion":                `{"build":{"ios":{"minimumOsVersion":"fifteen"}}}`,
		"is the CLI's own":                    `{"build":{"ios":{"profiles":{"ad-hoc":{"dartDefines":["YYT_TOKEN"]}}}}}`,
		`variant pro has no "bundleId"`:       `{"variants":{"pro":{"flavor":"pro","app":"demo","applicationId":"com.example.sample.pro"}}}`,
		"--bundle-id com.example.x disagrees": `{"variants":{"pro":{"flavor":"pro","app":"demo","bundleId":"com.example.sample"}}}`,
	} {
		writeFile(t, filepath.Join(proj, ContextFile), doc)
		args := append(base, "--build-profile", "ad-hoc")
		if strings.Contains(want, "disagrees") {
			args = append(args, "--bundle-id", "com.example.x")
		}
		if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s: err = %v, want %q", doc, err, want)
		}
	}
}

// The iOS options need --platform ios, and the platform is validated.
func TestDeployPlatformFlag(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	calls := fakeBuild(t, func(string, []string) error { return nil })
	f := newFake(t, ctxRoutes(nil, nil, nil, nil))
	withProject(t)
	for want, args := range map[string][]string{
		"--bundle-id needs --platform ios":     {"--bundle-id", "com.example.sample"},
		"--check-signing needs --platform ios": {"--check-signing"},
		"--ios-team-id needs --platform ios":   {"--ios-team-id", "ABCDE12345"},
		`invalid --platform "macos"`:           {"--platform", "macos"},
		"needs --build-profile":                {"--platform", "ios", "--bundle-id", "com.example.sample"},
		"needs the bundle id":                  {"--platform", "ios", "--build-profile", "ad-hoc"},
	} {
		_, _, err := run(t, f, append([]string{"catalog", "deploy", "--project-path", proj}, args...)...)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want %q", err, want)
		}
	}
	if len(*calls) != 0 || len(f.reqs) != 0 {
		t.Fatal("side effects before the refusal")
	}
}

// Two profiles in one run: each gets its own identity, ExportOptions, stage
// and defines, and the second build still starts from an empty ipa/.
func TestDeployIOSTwoProfiles(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeFile(t, filepath.Join(proj, ContextFile), `{"team":"dooroo","project":"game","build":{"versionTag":"marketing","ios":{"bundleId":"com.example.sample",
	 "profiles":{"ad-hoc":{"stage":"beta","dartDefines":["BETA_KEY"]},"development":{"stage":"dev","dartDefines":["DEV_KEY"]}}}}}`)
	h := newIOSHost(t, proj)
	adhoc := h.embedded
	dev := iosProfileXML("Sample Dev", iosTeam+"."+iosBundle, true, 2, "2030-01-01T00:00:00Z", false)
	h.install("dev", dev)
	h.onBuild = func(n int, _ []string) {
		// The second build packages a development-signed app.
		if n == 2 {
			h.embedded = dev
		} else {
			h.embedded = adhoc
		}
	}
	t.Setenv("BETA_KEY", "b")
	t.Setenv("DEV_KEY", "d")
	t.Setenv("CI_KEYCHAIN_PASSWORD", "")
	t.Setenv("IOS_TEAM_ID", iosTeam)
	f, committed := deployFake(t)
	out, _, err := run(t, f, "catalog", "deploy", "--platform", "ios", "--project-path", proj, "--name", "demo",
		"--build-profile", "ad-hoc", "--build-profile", "development", "--tag", "title=Sample", "--note", "typed", "--build", "nightly")
	if err != nil {
		t.Fatal(err)
	}
	b0, b1 := strings.Join(h.builds[0], " "), strings.Join(h.builds[1], " ")
	if len(h.builds) != 2 || !strings.Contains(b0, "--dart-define=BETA_KEY=b") || strings.Contains(b0, "DEV_KEY") ||
		!strings.Contains(b1, "--dart-define=DEV_KEY=d") || strings.Contains(b1, "BETA_KEY") {
		t.Fatalf("builds: %v", h.builds)
	}
	if !strings.Contains(h.exports[0], "<string>ad-hoc</string>") || !strings.Contains(h.exports[0], "Apple Distribution") || !strings.Contains(h.exports[0], "Sample Ad Hoc") ||
		!strings.Contains(h.exports[1], "<string>development</string>") || !strings.Contains(h.exports[1], "Apple Development") || !strings.Contains(h.exports[1], "Sample Dev") {
		t.Fatalf("exports:\n%s\n%s", h.exports[0], h.exports[1])
	}
	for i, want := range []map[string]string{
		{"distribution_method": "ad-hoc", "stage": "beta", "version": "1.2.3", "title": "Sample", "changelog": "typed", "build": "nightly"},
		{"distribution_method": "development", "stage": "dev", "version": "1.2.3"},
	} {
		for k, v := range want {
			if (*committed)[i][k] != v {
				t.Fatalf("upload %d tag %s = %v, want %s", i, k, (*committed)[i][k], v)
			}
		}
	}
	// What was sent is the renamed copy, as an ios artifact.
	var files []string
	for _, r := range f.reqs {
		if r.Method == "POST" && strings.HasSuffix(r.Path, "/artifacts") {
			files = append(files, fmt.Sprint(r.Body["platform"], " ", r.Body["filename"]))
		}
	}
	if strings.Join(files, "|") != "ios demo-1.2.3+4-ad-hoc.ipa|ios demo-1.2.3+4-development.ipa" {
		t.Fatalf("presign requests: %v", files)
	}
	if !strings.Contains(out, "ad-hoc") || !strings.Contains(out, "development") {
		t.Fatalf("output:\n%s", out)
	}
}

// Team id: flag > IOS_TEAM_ID > build.ios.teamId. Bundle id: flag > config.
func TestDeployIOSIdentityPrecedence(t *testing.T) {
	const flagTeam, envTeam, cfgTeam = "FLAGT00001", "ENVTT00002", "CFGTT00003"
	for _, c := range []struct {
		name, env, want string
		args            []string
	}{
		{"config", "", cfgTeam, nil},
		{"env over config", envTeam, envTeam, nil},
		{"flag over env", envTeam, flagTeam, []string{"--ios-team-id", flagTeam}},
	} {
		t.Run(c.name, func(t *testing.T) {
			proj := makeFlutterProject(t, "1.2.3+4")
			writeFile(t, filepath.Join(proj, ContextFile), `{"build":{"ios":{"bundleId":"com.example.sample","teamId":"`+cfgTeam+`"}}}`)
			h := newIOSHost(t, proj)
			h.identities = strings.ReplaceAll(bothIdentities, iosTeam, c.want)
			prof := iosProfileXML("P", c.want+"."+iosBundle, false, 2, "2030-01-01T00:00:00Z", false)
			h.install("adhoc", prof)
			h.embedded = prof
			t.Setenv("IOS_TEAM_ID", c.env)
			t.Setenv("CI_KEYCHAIN_PASSWORD", "")
			if _, _, err := run(t, newFake(t, nil), append([]string{"catalog", "deploy", "--platform", "ios", "--project-path", proj,
				"--build-profile", "ad-hoc", "--no-upload"}, c.args...)...); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(h.exports[0], "<string>"+c.want+"</string>") {
				t.Fatalf("team in ExportOptions:\n%s", h.exports[0])
			}
		})
	}
	// --bundle-id beats build.ios.bundleId, and the profile is searched
	// for the id in force.
	proj := makeFlutterProject(t, "1.2.3+4")
	writeFile(t, filepath.Join(proj, ContextFile), `{"build":{"ios":{"bundleId":"com.example.other"}}}`)
	newIOSHost(t, proj)
	t.Setenv("CI_KEYCHAIN_PASSWORD", "")
	if _, _, err := run(t, newFake(t, nil), "catalog", "deploy", "--platform", "ios", "--project-path", proj, "--build-profile", "ad-hoc",
		"--bundle-id", iosBundle, "--ios-team-id", iosTeam, "--no-upload"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, newFake(t, nil), "catalog", "deploy", "--platform", "ios", "--project-path", proj, "--build-profile", "ad-hoc",
		"--ios-team-id", iosTeam, "--no-upload"); err == nil || !strings.Contains(err.Error(), "no installed provisioning profile signs com.example.other") {
		t.Fatalf("the config's bundle id must be the one searched for: %v", err)
	}
}

// The keychain: its path, the order (unlock before the identity is looked
// up, after the refusals that need no key), and a failed unlock.
func TestDeployIOSKeychain(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	h := newIOSHost(t, proj)
	const pw = "hunter2-s3cret"
	t.Setenv("IOS_TEAM_ID", "")
	t.Setenv("CI_KEYCHAIN_PASSWORD", pw)
	t.Setenv("CI_KEYCHAIN_PATH", "/Users/ci/build.keychain-db")
	if _, _, err := run(t, newFake(t, nil), iosArgs(proj, "--no-upload")...); err != nil {
		t.Fatal(err)
	}
	index := func(prefix string) int {
		for i, c := range h.tools {
			if strings.HasPrefix(c, prefix) {
				return i
			}
		}
		return -1
	}
	unlock, find := index("security unlock-keychain -p "+pw+" /Users/ci/build.keychain-db"), index("security find-identity")
	if unlock < 0 || find < 0 || unlock > find {
		t.Fatalf("unlock at %d, find-identity at %d:\n%s", unlock, find, strings.Join(h.tools, "\n"))
	}
	if os.Getenv("CI_KEYCHAIN_PASSWORD") != "" {
		t.Fatal("the password was left in the environment")
	}
	// A failed unlock stops the run, without the password in the message.
	t.Setenv("CI_KEYCHAIN_PASSWORD", pw)
	h.unlock, h.builds = errors.New("exit status 51: bad password "+pw), nil
	_, errs, err := run(t, newFake(t, nil), iosArgs(proj, "--no-upload")...)
	if err == nil || !strings.Contains(err.Error(), "unlock-keychain failed") || strings.Contains(err.Error()+errs, pw) || len(h.builds) != 0 {
		t.Fatalf("err = %v", err)
	}
	// A refusal that needs no key comes before the keychain is touched.
	t.Setenv("CI_KEYCHAIN_PASSWORD", pw)
	h.unlock, h.tools = nil, nil
	if _, _, err := run(t, newFake(t, nil), iosArgs(proj, "--no-upload", "--cocoapods")...); err == nil || index("security") >= 0 {
		t.Fatalf("err = %v; security ran before the Podfile refusal: %v", err, h.tools)
	}
}

// git, the console and the hook on the iOS path.
func TestDeployIOSSharedGuards(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	writeScript(t, filepath.Join(proj, "pre.sh"))
	writeFile(t, filepath.Join(proj, ContextFile), `{"team":"dooroo","project":"game","build":{"commit":"auto","note":"auto","noteSkip":["^Bump"],"create":false,
	 "prebuild":"pre.sh","requireFlutter":"3.47.8","ios":{"bundleId":"com.example.sample","teamId":"ABCDE12345"}}}`)
	h := newIOSHost(t, proj)
	t.Setenv("IOS_TEAM_ID", "")
	t.Setenv("CI_KEYCHAIN_PASSWORD", "")
	head, status := headA, ""
	h.git = func(args []string) ([]byte, error) {
		args = args[len(gitBase):]
		line := strings.Join(args, " ")
		switch {
		case line == "rev-parse --is-inside-work-tree":
			return []byte("true\n"), nil
		case line == "rev-parse -q --verify HEAD":
			return []byte(head + "\n"), nil
		case strings.HasPrefix(line, "rev-parse --short "):
			return []byte(args[2][:7] + "\n"), nil
		case args[0] == "status":
			return []byte(status), nil
		case args[0] == "diff":
			return []byte(status), nil
		case strings.Contains(line, " log "):
			return []byte("Bump version to 1.2.3+4\nReal change\n"), nil
		}
		return nil, errors.New("unexpected git")
	}
	h.flutter = "3.47.9"
	base := []string{"catalog", "deploy", "--platform", "ios", "--project-path", proj, "--name", "demo", "--build-profile", "ad-hoc"}

	// requireFlutter, before the keychain or a build.
	f, committed := deployFake(t)
	if _, _, err := run(t, f, base...); err == nil || !strings.Contains(err.Error(), "requires Flutter 3.47.8") || len(h.builds) != 0 {
		t.Fatalf("err = %v", err)
	}
	h.flutter = "3.47.8"

	// create:false with a missing app: not found, nothing built.
	missing := deployRoutes(&f, committed, new(int), 1)
	missing["GET /projects/prj_1/catalog/apps"] = func(recorded) (int, any) { return 200, map[string]any{"apps": []any{}} }
	f = newFake(t, missing)
	withProject(t)
	var ae *api.Error
	if _, _, err := run(t, f, base...); !errors.As(err, &ae) || ae.Status != 404 || len(h.builds) != 0 {
		t.Fatalf("create:false: err = %v", err)
	}

	// The whole run: bump, hook, commit and note from git, verified upload.
	f, committed = deployFake(t)
	hooks := 0
	fakeHook = func(_, name string) error {
		if strings.HasSuffix(name, "pre.sh") {
			hooks++
			if b, _ := os.ReadFile(filepath.Join(proj, "pubspec.yaml")); !strings.Contains(string(b), "1.2.4+5") {
				t.Error("the hook ran before the bump")
			}
		}
		return nil
	}
	h.info = iosInfoPlist(iosBundle, "1.2.4", "5", "15.5")
	if _, errs, err := run(t, f, append(base, "--do-bump")...); err != nil || !strings.Contains(errs, "verified: 1 artifact") {
		t.Fatalf("err = %v\n%s", err, errs)
	}
	if got := (*committed)[0]; hooks != 1 || got["commit"] != "1111111" || got["changelog"] != "Real change" || got["version"] != "1.2.4+5" {
		t.Fatalf("hooks %d, tags %v", hooks, got)
	}

	// Drift during the build refuses the upload.
	f, committed = deployFake(t)
	h.onBuild = func(int, []string) { head = headB }
	if _, _, err := run(t, f, base...); err == nil || !strings.Contains(err.Error(), "HEAD moved") || len(*committed) != 0 {
		t.Fatalf("drift: err = %v, uploads %v", err, *committed)
	}
	// --no-prebuild.
	head, hooks, h.onBuild = headA, 0, nil
	f, _ = deployFake(t)
	if _, _, err := run(t, f, append(base, "--no-prebuild", "--no-upload")...); err != nil || hooks != 0 {
		t.Fatalf("--no-prebuild: %v, hooks %d", err, hooks)
	}
}

// Every entry of the refusal lists, two IPAs, and undecodable profiles.
func TestDeployIOSRefusalLists(t *testing.T) {
	proj := makeFlutterProject(t, "1.2.3+4")
	h := newIOSHost(t, proj)
	t.Setenv("CI_KEYCHAIN_PASSWORD", "")
	f := newFake(t, nil)
	for flag, val := range map[string]string{"--split-per-abi": "", "--target-platform": "android-arm64", "--application-id": "com.example.sample",
		"--version-code-offset": "1", "--min-sdk": "24", "--target-sdk": "36", "--abi": "arm64-v8a"} {
		args := iosArgs(proj, flag)
		if val != "" {
			args = append(args, val)
		}
		if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), flag+" is an Android option") {
			t.Fatalf("%s: err = %v", flag, err)
		}
	}
	for _, pass := range []string{"--export-options-plist=x.plist", "--export-method=ad-hoc", "--no-codesign", "--codesign", "--flavor=pro", "--dart-define=K=v", "--verbose"} {
		name, _, _ := strings.Cut(pass, "=")
		if _, _, err := run(t, f, iosArgs(proj, "--", pass)...); err == nil || !strings.Contains(err.Error(), name+" cannot be passed after --") {
			t.Fatalf("%s: err = %v", pass, err)
		}
	}
	for _, tag := range []string{"bundle_id", "build_number", "distribution_method", "minimum_os_version"} {
		if _, _, err := run(t, f, iosArgs(proj, "--tag", tag+"=x")...); err == nil || !strings.Contains(err.Error(), "--tag "+tag+": deploy sets") {
			t.Fatalf("%s: err = %v", tag, err)
		}
	}
	android := []string{"catalog", "deploy", "--project-path", proj}
	for flag, val := range map[string]string{"--skip-signing-preflight": "", "--cocoapods": "", "--check-signing": "", "--bundle-id": iosBundle, "--ios-team-id": iosTeam} {
		args := append(append([]string{}, android...), flag)
		if val != "" {
			args = append(args, val)
		}
		if _, _, err := run(t, f, args...); err == nil || !strings.Contains(err.Error(), flag+" needs --platform ios") {
			t.Fatalf("%s: err = %v", flag, err)
		}
	}
	if len(h.builds) != 0 {
		t.Fatal("a refused run built")
	}
	// A pubspec without a build number.
	plain := makeFlutterProject(t, "1.2.3")
	if _, _, err := run(t, f, iosArgs(plain, "--no-upload")...); err == nil || !strings.Contains(err.Error(), "needs a build number") {
		t.Fatalf("err = %v", err)
	}
	// Two IPAs after the build: which one is the build's is not guessed.
	h.second = "Other.ipa"
	if _, _, err := run(t, f, iosArgs(proj, "--no-upload")...); err == nil || !strings.Contains(err.Error(), "expected exactly one .ipa") {
		t.Fatalf("err = %v", err)
	}
	// Profiles that cannot be decoded are not "no profile".
	h.second, h.builds = "", nil
	writeFile(t, filepath.Join(proj, "ios", "Runner.xcodeproj", "project.pbxproj"), "CODE_SIGN_STYLE = Automatic;\n")
	inner := deployOutput
	deployOutput = func(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
		if name == "openssl" {
			return nil, errors.New("exit status 1")
		}
		return inner(ctx, dir, name, args...)
	}
	if _, _, err := run(t, f, iosArgs(proj, "--no-upload")...); err == nil || !strings.Contains(err.Error(), "could be decoded") || len(h.builds) != 0 {
		t.Fatalf("err = %v", err)
	}
}
