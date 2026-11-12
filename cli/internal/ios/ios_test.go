package ios

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
)

const team = "ABCDE12345"

// The fakes answer to the tools' bare names.
func TestMain(m *testing.M) {
	Security, Codesign, OpenSSL, Plutil = "security", "codesign", "openssl", "plutil"
	os.Exit(m.Run())
}

// profileXML renders the property list of a provisioning profile.
func profileXML(name, appID string, getTaskAllow bool, devices int, expires string, extra string) string {
	var devs string
	if devices > 0 {
		devs = "<key>ProvisionedDevices</key><array>" + strings.Repeat("<string>00008030-000000000000002E</string>", devices) + "</array>"
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Name</key><string>%s</string>
 <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
 <key>ExpirationDate</key><date>%s</date>
 <key>DeveloperCertificates</key><array><data>AAEC
 AwQ=</data></array>
 <key>TimeToLive</key><integer>365</integer>
 <key>Entitlements</key><dict>
  <key>application-identifier</key><string>%s</string>
  <key>get-task-allow</key><%t/>
  <key>keychain-access-groups</key><array><string>%s.*</string></array>
 </dict>
 %s%s
</dict></plist>`, escapeXML(name), expires, appID, getTaskAllow, team, devs, extra)
}

func TestParseProfileAndKind(t *testing.T) {
	for _, c := range []struct {
		name    string
		allow   bool
		devices int
		extra   string
		kind    string
	}{
		{"dev", true, 2, "", Development},
		{"adhoc", false, 3, "", AdHoc},
		{"store", false, 0, "", AppStore},
		{"enterprise", false, 0, "<key>ProvisionsAllDevices</key><true/>", ""},
	} {
		p, err := ParseProfile([]byte(profileXML(c.name+" & <co>", team+".com.example.sample", c.allow, c.devices, "2030-01-02T03:04:05Z", c.extra)))
		if err != nil {
			t.Fatal(err)
		}
		if p.Kind() != c.kind || p.Name != c.name+" & <co>" || p.Devices != c.devices || p.Expires.Year() != 2030 || p.Wildcard() {
			t.Fatalf("%s: %+v kind %q", c.name, p, p.Kind())
		}
	}
	for name, doc := range map[string]string{
		"not xml":        "MIIabc",
		"not a plist":    "<html><body/></html>",
		"no name":        strings.Replace(profileXML("x", team+".a.b", true, 0, "2030-01-02T03:04:05Z", ""), "<key>Name</key><string>x</string>", "", 1),
		"array root":     `<plist version="1.0"><array/></plist>`,
		"value sans key": `<plist version="1.0"><dict><string>x</string></dict></plist>`,
		"deep":           `<plist version="1.0">` + strings.Repeat("<array>", 80) + strings.Repeat("</array>", 80) + `</plist>`,
		"truncated":      `<plist version="1.0"><dict><key>Name</key><string>x`,
	} {
		if _, err := ParseProfile([]byte(doc)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestSelectProfile(t *testing.T) {
	now := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	at := func(y int) time.Time { return time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC) }
	bundle := "com.example.sample"
	all := []Profile{
		{Name: "store", AppID: team + "." + bundle, Expires: at(2027)},
		{Name: "adhoc old", AppID: team + "." + bundle, Devices: 1, Expires: at(2027)},
		{Name: "adhoc expired", AppID: team + "." + bundle, Devices: 1, Expires: at(2026)},
		{Name: "adhoc new", AppID: team + "." + bundle, Devices: 1, Expires: at(2028)},
		{Name: "adhoc wildcard", AppID: team + ".*", Devices: 1, Expires: at(2029)},
		{Name: "adhoc other app", AppID: team + "." + bundle + ".pro", Devices: 1, Expires: at(2029)},
		{Name: "adhoc other team", AppID: "ZZZZZ99999." + bundle, Devices: 1, Expires: at(2029)},
		{Name: "dev wildcard", AppID: team + ".*", GetTaskAllow: true, Devices: 1, Expires: at(2027)},
		{Name: "enterprise", AppID: team + "." + bundle, AllDevices: true, Expires: at(2029)},
	}
	pick := func(profiles []Profile, method string, wildcard bool) string {
		p, ok := SelectProfile(profiles, team, bundle, method, wildcard, now)
		if !ok {
			return ""
		}
		return p.Name
	}
	for _, c := range []struct {
		method   string
		wildcard bool
		want     string
	}{
		// Never the app-store profile for ad-hoc, never an expired one, the
		// exact id before a wildcard, then the latest expiry.
		{AdHoc, false, "adhoc new"},
		{AdHoc, true, "adhoc new"},
		{AppStore, false, "store"},
		{Development, false, "dev wildcard"},
	} {
		if got := pick(all, c.method, c.wildcard); got != c.want {
			t.Errorf("%s (wildcard %v): picked %q, want %q", c.method, c.wildcard, got, c.want)
		}
	}
	only := []Profile{all[4]}
	if got := pick(only, AdHoc, false); got != "" {
		t.Errorf("a wildcard profile was used for distribution: %q", got)
	}
	if got := pick(only, AdHoc, true); got != "adhoc wildcard" {
		t.Errorf("allowWildcard: %q", got)
	}
	if got := pick([]Profile{all[0]}, AdHoc, true); got != "" {
		t.Errorf("an app-store profile passed as ad-hoc: %q", got)
	}
	if got := pick([]Profile{all[2]}, AdHoc, true); got != "" {
		t.Errorf("an expired profile was picked: %q", got)
	}
}

const identities = `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Sample Dev (AAAAA11111)"
  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Distribution: Example Co. (ABCDE12345)"
     2 valid identities found
`

func TestIdentityKeychainAndProbe(t *testing.T) {
	ctx := context.Background()
	var calls []string
	var fail map[string]error
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		if err := fail[name+" "+args[0]]; err != nil {
			return nil, err
		}
		if name == "security" && args[0] == "find-identity" {
			return []byte(identities), nil
		}
		return nil, nil
	}
	dev, err := FindIdentity(ctx, run, Development, team)
	if err != nil || dev.Hash != "0123456789ABCDEF0123456789ABCDEF01234567" || !strings.HasPrefix(dev.Name, "Apple Development:") {
		t.Fatalf("%+v, %v", dev, err)
	}
	for _, m := range []string{AdHoc, AppStore} {
		if id, err := FindIdentity(ctx, run, m, team); err != nil || id.Hash != "89ABCDEF0123456789ABCDEF0123456789ABCDEF" {
			t.Fatalf("%s: %+v, %v", m, id, err)
		}
	}
	onlyDev := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(strings.Split(identities, "\n")[0] + "\n     1 valid identities found\n"), nil
	}
	if _, err := FindIdentity(ctx, onlyDev, AdHoc, team); err == nil || !strings.Contains(err.Error(), `no "Apple Distribution"`) || !strings.Contains(err.Error(), "found: Apple Development") {
		t.Fatalf("err = %v", err)
	}
	none := func(context.Context, string, ...string) ([]byte, error) {
		return []byte("     0 valid identities found\n"), nil
	}
	if _, err := FindIdentity(ctx, none, Development, team); err == nil || !strings.Contains(err.Error(), "found: none") {
		t.Fatalf("err = %v", err)
	}

	calls = nil
	if err := ProbeCodesign(ctx, run, dev); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || !strings.HasPrefix(calls[0], "codesign --force --sign "+dev.Hash+" ") {
		t.Fatalf("probe: %v", calls)
	}
	if _, err := os.Stat(strings.Fields(calls[0])[4]); err == nil {
		t.Fatal("the probe file was left behind")
	}
	fail = map[string]error{"codesign --force": errors.New("errSecInternalComponent")}
	if err := ProbeCodesign(ctx, run, dev); err == nil || !strings.Contains(err.Error(), "errSecInternalComponent") || !strings.Contains(err.Error(), "set-key-partition-list") {
		t.Fatalf("err = %v", err)
	}

	// The keychain password is in argv and nowhere else.
	fail, calls = nil, nil
	const pw = "hunter2-s3cret"
	if err := UnlockKeychain(ctx, run, "/Users/dev/Library/Keychains/login.keychain-db", pw); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || !strings.HasPrefix(calls[0], "security unlock-keychain -p "+pw) ||
		calls[1] != "security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "+pw+" /Users/dev/Library/Keychains/login.keychain-db" {
		t.Fatalf("calls: %v", calls)
	}
	for _, step := range []string{"security unlock-keychain", "security set-key-partition-list"} {
		fail = map[string]error{step: fmt.Errorf("exit status 51: security: %s: bad password %s", step, pw)}
		err := UnlockKeychain(ctx, run, "login.keychain-db", pw)
		if err == nil || strings.Contains(err.Error(), pw) {
			t.Fatalf("%s: err = %v (must fail without the password)", step, err)
		}
	}
}

func TestListProfilesAndAutomaticSigning(t *testing.T) {
	ctx := context.Background()
	home := t.TempDir()
	dirs := ProfileDirs(home)
	for i, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(d, fmt.Sprintf("p%d.mobileprovision", i)), []byte(fmt.Sprintf("profile %d", i)), 0o644)
	}
	_ = os.WriteFile(filepath.Join(dirs[0], "broken.mobileprovision"), []byte("broken"), 0o644)
	_ = os.WriteFile(filepath.Join(dirs[0], "notes.txt"), []byte("x"), 0o644)
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "openssl" || strings.Join(args[:5], " ") != "smime -inform der -verify -noverify" || args[5] != "-in" {
			t.Fatalf("ran %s %v", name, args)
		}
		data, _ := os.ReadFile(args[6])
		if string(data) == "broken" {
			return nil, errors.New("exit status 2")
		}
		return []byte(profileXML(string(data), team+".com.example.sample", false, 1, "2030-01-02T03:04:05Z", "")), nil
	}
	got, undecoded := ListProfiles(ctx, run, append(dirs, filepath.Join(home, "missing")))
	if undecoded != 1 {
		t.Fatalf("undecoded = %d", undecoded)
	}
	if len(got) != 2 || got[0].Name != "profile 0" || got[1].Name != "profile 1" || got[0].Path == "" {
		t.Fatalf("profiles: %+v", got)
	}
	proj := t.TempDir()
	if AutomaticSigning(proj) {
		t.Fatal("no project file")
	}
	pbx := filepath.Join(proj, "ios", "Runner.xcodeproj", "project.pbxproj")
	_ = os.MkdirAll(filepath.Dir(pbx), 0o755)
	_ = os.WriteFile(pbx, []byte("CODE_SIGN_STYLE = Manual;\n"), 0o644)
	if AutomaticSigning(proj) {
		t.Fatal("manual signing read as automatic")
	}
	_ = os.WriteFile(pbx, []byte("\t\t\t\tCODE_SIGN_STYLE = Automatic;\n"), 0o644)
	if !AutomaticSigning(proj) {
		t.Fatal("automatic signing not seen")
	}
}

func TestExportOptions(t *testing.T) {
	manual := string(ExportOptions(AdHoc, team, "com.example.sample", `Sample "Ad Hoc" & <Co>`))
	want := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>ad-hoc</string>
	<key>signingCertificate</key>
	<string>Apple Distribution</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>teamID</key>
	<string>ABCDE12345</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>com.example.sample</key>
		<string>Sample &#34;Ad Hoc&#34; &amp; &lt;Co&gt;</string>
	</dict>
</dict>
</plist>
`
	if manual != want {
		t.Fatalf("manual:\n%s", manual)
	}
	// What was written parses back to the same values.
	v, err := parsePlist([]byte(manual))
	if err != nil || strOf(dictOf(v, "provisioningProfiles"), "com.example.sample") != `Sample "Ad Hoc" & <Co>` {
		t.Fatalf("round trip: %v, %v", v, err)
	}
	auto := string(ExportOptions(Development, team, "com.example.sample", ""))
	wantAuto := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>development</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>ABCDE12345</string>
</dict>
</plist>
`
	if auto != wantAuto {
		t.Fatalf("automatic:\n%s", auto)
	}
}

func infoPlist(bundle, version, build, minOS string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
 <key>CFBundleIdentifier</key><string>%s</string>
 <key>CFBundleShortVersionString</key><string>%s</string>
 <key>CFBundleVersion</key><string>%s</string>
 <key>MinimumOSVersion</key><string>%s</string>
 <key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
 <key>LSRequiresIPhoneOS</key><true/>
</dict></plist>`, bundle, version, build, minOS)
}

func writeIPA(t *testing.T, files map[string]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "한글 앱.ipa")
	f, err := os.Create(p)
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
	return p
}

func TestInspectIPA(t *testing.T) {
	ctx := context.Background()
	bundle := "com.example.sample"
	var ran []string
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		ran = append(ran, name)
		data, err := os.ReadFile(args[len(args)-1])
		if err != nil {
			return nil, err
		}
		switch name {
		case "plutil":
			if strings.Join(args[:4], " ") != "-convert xml1 -o -" {
				t.Fatalf("plutil args: %v", args)
			}
			// The fake "binary plist" is the marker plus the XML.
			return []byte(strings.TrimPrefix(string(data), "bplist00")), nil
		case "openssl":
			return []byte(profileXML("Sample Ad Hoc", string(data), false, 2, "2030-01-02T03:04:05Z", "")), nil
		}
		return nil, errors.New("unexpected tool")
	}
	ipa := writeIPA(t, map[string]string{
		"Payload/Runner.app/Info.plist":                                   "bplist00" + infoPlist(bundle, "1.2.3", "45", "15.5"),
		"Payload/Runner.app/embedded.mobileprovision":                     team + "." + bundle,
		"Payload/Runner.app/Frameworks/App.framework/Info.plist":          infoPlist("io.flutter.flutter.app", "1.0", "1", "13.0"),
		"Payload/Runner.app/PlugIns/Share.appex/Info.plist":               infoPlist(bundle+".share", "1.2.3", "45", "15.5"),
		"Payload/Runner.app/PlugIns/Share.appex/embedded.mobileprovision": "ZZZZZ99999.other",
	})
	info, err := InspectIPA(ctx, run, ipa)
	if err != nil {
		t.Fatal(err)
	}
	if info.BundleID != bundle || info.Version != "1.2.3" || info.Build != "45" || info.MinimumOS != "15.5" ||
		info.Profile == nil || info.Profile.Kind() != AdHoc || info.Profile.AppID != team+"."+bundle {
		t.Fatalf("info: %+v %+v", info, info.Profile)
	}
	if strings.Join(ran, " ") != "plutil openssl" {
		t.Fatalf("tools: %v", ran)
	}
	want := Expect{BundleID: bundle, Version: "1.2.3", Build: "45", MinimumOS: "15.5", Method: AdHoc, Team: team, Signed: true}
	if err := info.Check(want); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Expect){
		`bundle id is "com.example.sample", expected "com.example.sample.pro"`: func(e *Expect) { e.BundleID += ".pro" },
		`version is "1.2.3", expected "1.2.4"`:                                 func(e *Expect) { e.Version = "1.2.4" },
		`build number is "45", expected "46"`:                                  func(e *Expect) { e.Build = "46" },
		`minimum OS is "15.5", expected "16.0"`:                                func(e *Expect) { e.MinimumOS = "16.0" },
		`signed with a ad-hoc profile ("Sample Ad Hoc"), expected app-store`:   func(e *Expect) { e.Method = AppStore },
		`signed with a ad-hoc profile ("Sample Ad Hoc"), expected development`: func(e *Expect) { e.Method = Development },
		"is not for this team and bundle id":                                   func(e *Expect) { e.Team = "ZZZZZ99999" },
	} {
		w := want
		change(&w)
		if err := info.Check(w); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("want %q, got %v", name, err)
		}
	}
	// No minimum configured: the IPA's value is taken as it is.
	w := want
	w.MinimumOS = ""
	if err := info.Check(w); err != nil {
		t.Fatal(err)
	}

	// An XML Info.plist needs no plutil; an unsigned archive has no profile.
	ran = nil
	unsigned := writeIPA(t, map[string]string{"Payload/Runner.app/Info.plist": infoPlist(bundle, "1.2.3", "45", "15.5")})
	info, err = InspectIPA(ctx, run, unsigned)
	if err != nil || info.Profile != nil || len(ran) != 0 {
		t.Fatalf("unsigned: %+v, %v, tools %v", info, err, ran)
	}
	if err := info.Check(want); err == nil || !strings.Contains(err.Error(), "no embedded provisioning profile") {
		t.Fatalf("err = %v", err)
	}
	w = want
	w.Signed = false
	if err := info.Check(w); err != nil {
		t.Fatal(err)
	}

	// A wildcard profile inside a distribution IPA, a minimum OS that is not
	// a version, and an entry given twice.
	wild := Profile{Name: "Wild", AppID: team + ".*", Devices: 2}
	withWild := IPAInfo{BundleID: bundle, Version: "1.2.3", Build: "45", MinimumOS: "15.5", Profile: &wild}
	if err := withWild.Check(want); err == nil || !strings.Contains(err.Error(), "wildcard profile") {
		t.Fatalf("err = %v", err)
	}
	w = want
	w.AllowWildcard = true
	if err := withWild.Check(w); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectIPA(ctx, run, writeIPA(t, map[string]string{"Payload/Runner.app/Info.plist": infoPlist(bundle, "1.2.3", "45", "15.5&#10;x")})); err == nil ||
		!strings.Contains(err.Error(), "MinimumOSVersion") {
		t.Fatalf("err = %v", err)
	}
	twice := filepath.Join(t.TempDir(), "twice.ipa")
	tf, _ := os.Create(twice)
	tz := zip.NewWriter(tf)
	for _, b := range []string{bundle, bundle + ".second"} {
		tw, _ := tz.Create("Payload/Runner.app/Info.plist")
		_, _ = tw.Write([]byte(infoPlist(b, "1.2.3", "45", "15.5")))
	}
	_ = tz.Close()
	_ = tf.Close()
	if _, err := InspectIPA(ctx, run, twice); err == nil || !strings.Contains(err.Error(), "appears twice") {
		t.Fatalf("err = %v", err)
	}

	for name, files := range map[string]map[string]string{
		"no Payload/<name>.app/Info.plist": {"Payload/Runner.app/Frameworks/App.framework/Info.plist": infoPlist(bundle, "1", "1", "1")},
		"more than one app":                {"Payload/A.app/Info.plist": infoPlist(bundle, "1", "1", "1"), "Payload/B.app/Info.plist": infoPlist(bundle, "1", "1", "1")},
		"lacks CFBundleIdentifier":         {"Payload/Runner.app/Info.plist": infoPlist("", "1", "1", "1")},
		"Info.plist:":                      {"Payload/Runner.app/Info.plist": "garbage"},
	} {
		if _, err := InspectIPA(ctx, run, writeIPA(t, files)); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("want %q, got %v", name, err)
		}
	}
	plain := filepath.Join(t.TempDir(), "x.ipa")
	_ = os.WriteFile(plain, []byte("not a zip"), 0o644)
	if _, err := InspectIPA(ctx, run, plain); err == nil {
		t.Error("a file that is not a zip must be an error")
	}
	failing := func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("boom") }
	if _, err := InspectIPA(ctx, failing, ipa); err == nil || !strings.Contains(err.Error(), "plutil") {
		t.Errorf("a plutil failure: %v", err)
	}
}

func TestBuildEnvAndIDs(t *testing.T) {
	env := BuildEnv(func(k string) string {
		return map[string]string{"PATH": "/opt/homebrew/bin:/usr/bin", "LANG": "C"}[k]
	})
	if got := BuildEnv(func(string) string { return "" })["PATH"]; got != "/usr/bin:/bin:/usr/sbin:/sbin" {
		t.Fatalf("an empty PATH must not add the current directory: %q", got)
	}
	if env["PATH"] != "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/bin" || env["LANG"] != "en_US.UTF-8" || env["LC_ALL"] != "en_US.UTF-8" {
		t.Fatalf("env: %v", env)
	}
	env = BuildEnv(func(k string) string {
		return map[string]string{"PATH": "/usr/bin", "LANG": "ko_KR.UTF-8", "LC_ALL": "ko_KR.utf8"}[k]
	})
	if _, set := env["LANG"]; set || env["LC_ALL"] != "" {
		t.Fatalf("a UTF-8 locale must be kept: %v", env)
	}
	for id, ok := range map[string]bool{"ABCDE12345": true, "abcde12345": false, "ABCDE1234": false, "ABCDE12345;rm": false, "": false} {
		if (CheckTeamID(id) == nil) != ok {
			t.Errorf("team id %q", id)
		}
	}
	for id, ok := range map[string]bool{"com.example.sample": true, "com.example.my-app": true, "com.example.my_app": false, "sample": false, "com..x": false, "com.example.*": false} {
		if (CheckBundleID(id) == nil) != ok {
			t.Errorf("bundle id %q", id)
		}
	}
	if !ValidMethod(AdHoc) || ValidMethod("release") || IdentityName(Development) != "Apple Development" || IdentityName(AppStore) != "Apple Distribution" {
		t.Fatal("methods")
	}
}

// What the review of the preflight found.
func TestIdentityTeamAndProfileRules(t *testing.T) {
	ctx := context.Background()
	two := `  1) 1111111111111111111111111111111111111111 "Apple Distribution: Other Co. (ZZZZZ99999)"
  2) 2222222222222222222222222222222222222222 "Apple Distribution: Example Co. (ABCDE12345)"
`
	run := func(context.Context, string, ...string) ([]byte, error) { return []byte(two), nil }
	if id, err := FindIdentity(ctx, run, AdHoc, team); err != nil || !strings.HasPrefix(id.Hash, "2222") {
		t.Fatalf("the requested team's identity must be taken: %+v, %v", id, err)
	}
	if _, err := FindIdentity(ctx, run, AdHoc, "QQQQQ00000"); err == nil || !strings.Contains(err.Error(), "none for this team") {
		t.Fatalf("err = %v", err)
	}

	now := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	later, latest := now.AddDate(1, 0, 0), now.AddDate(2, 0, 0)
	bundle := "com.example.sample"
	app := team + "." + bundle
	// tvOS, and a profile with no expiry date, are not candidates.
	tv, err := ParseProfile([]byte(profileXML("tv", app, false, 0, "2030-01-02T03:04:05Z", "<key>Platform</key><array><string>tvOS</string></array>")))
	if err != nil || !tv.NotIOS || tv.Matches(team, bundle, AppStore, false, now) {
		t.Fatalf("tvOS profile: %+v, %v", tv, err)
	}
	both, _ := ParseProfile([]byte(profileXML("ios", app, false, 0, "2030-01-02T03:04:05Z", "<key>Platform</key><array><string>iOS</string><string>xrOS</string></array>")))
	if both.NotIOS || !both.Matches(team, bundle, AppStore, false, now) {
		t.Fatalf("iOS profile: %+v", both)
	}
	if (Profile{Name: "x", AppID: app}).Matches(team, bundle, AppStore, false, now) {
		t.Fatal("a profile without an expiry date matched")
	}
	// A manually installed profile before an Xcode-managed one, even when
	// the managed one expires later.
	p, ok := SelectProfile([]Profile{
		{Name: "managed", AppID: app, Devices: 1, Expires: latest, XcodeManaged: true},
		{Name: "manual", AppID: app, Devices: 1, Expires: later},
	}, team, bundle, AdHoc, false, now)
	if !ok || p.Name != "manual" {
		t.Fatalf("picked %+v", p)
	}

	// The embedded profile must be the one the export was pinned to, and
	// not expired; "04" is build 4 and "15" is OS 15.0.
	emb := Profile{Name: "same", UUID: "OLD", AppID: app, Devices: 1, Expires: later}
	info := IPAInfo{BundleID: bundle, Version: "1.2.3", Build: "04", MinimumOS: "15.0", Profile: &emb}
	want := Expect{BundleID: bundle, Version: "1.2.3", Build: "4", MinimumOS: "15", Method: AdHoc, Team: team, Signed: true, ProfileUUID: "OLD", Now: now}
	if err := info.Check(want); err != nil {
		t.Fatal(err)
	}
	want.ProfileUUID = "NEW"
	if err := info.Check(want); err == nil || !strings.Contains(err.Error(), "another copy of the profile") {
		t.Fatalf("err = %v", err)
	}
	want.ProfileUUID, want.Now = "", latest
	if err := info.Check(want); err == nil || !strings.Contains(err.Error(), "has expired") {
		t.Fatalf("err = %v", err)
	}
	want.Now, want.MinimumOS = now, "15.1"
	if err := info.Check(want); err == nil || !strings.Contains(err.Error(), "minimum OS") {
		t.Fatalf("err = %v", err)
	}
}
