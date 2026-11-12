package cmd

// `catalog deploy --platform ios`. The file is not named *_ios.go: Go would
// build that for GOOS=ios only.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/flutter"
	"github.com/yingyeothon/service/cli/internal/ios"
	"github.com/yingyeothon/service/cli/internal/textsafe"
)

// Swapped by tests: the host OS, the process environment fix-up, the home
// directory and the clock.
var (
	hostOS        = runtime.GOOS
	applyBuildEnv = func() {
		for k, v := range ios.BuildEnv(os.Getenv) {
			_ = os.Setenv(k, v)
		}
	}
	userHome = os.UserHomeDir
	clockNow = time.Now
)

// iosBuild is `build.ios` of the project's .yyt.json.
type iosBuild struct {
	BundleID             string                     `json:"bundleId"`
	TeamID               string                     `json:"teamId"`
	MinimumOsVersion     string                     `json:"minimumOsVersion"`
	UseCocoapods         *bool                      `json:"useCocoapods"`
	AllowWildcardProfile bool                       `json:"allowWildcardProfile"`
	VersionTag           string                     `json:"versionTag"`
	Profiles             map[string]iosProfileBuild `json:"profiles"`
}

// iosProfileBuild is what one iOS build profile adds.
type iosProfileBuild struct {
	Stage           string   `json:"stage"`
	DartDefines     []string `json:"dartDefines"`
	DartDefineFiles []string `json:"dartDefineFiles"`
}

var osVersionText = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,2}$`)

func (c iosBuild) validate() error {
	if c.BundleID != "" {
		if err := ios.CheckBundleID(c.BundleID); err != nil {
			return fmt.Errorf("ios.bundleId: %w", err)
		}
	}
	if c.TeamID != "" {
		if err := ios.CheckTeamID(c.TeamID); err != nil {
			return fmt.Errorf("ios.teamId: %w", err)
		}
	}
	if c.MinimumOsVersion != "" && !osVersionText.MatchString(c.MinimumOsVersion) {
		return errors.New("ios.minimumOsVersion must look like 15.5")
	}
	if c.VersionTag != "" && c.VersionTag != "full" && c.VersionTag != "marketing" {
		return fmt.Errorf("ios.versionTag %q (full|marketing)", c.VersionTag)
	}
	for name, p := range c.Profiles {
		if !ios.ValidMethod(name) {
			return fmt.Errorf("ios.profiles: unknown profile %q (%s)", name, strings.Join(ios.Methods, "|"))
		}
		if err := checkProfileValues("ios.profiles."+name, p.Stage, p.DartDefines); err != nil {
			return err
		}
	}
	return nil
}

// iosFlags are the reserved `flutter build ipa` arguments: each would change
// how the archive is signed or exported behind the preflight's back.
var iosReservedFlags = map[string]string{
	"--export-options-plist": "deploy writes ExportOptions.plist from the signing preflight",
	"--export-method":        "use --build-profile",
	"--no-codesign":          "an unsigned archive cannot be installed; deploy uploads signed IPAs only",
	"--codesign":             "signing is always on",
}

// iosDeploy carries the flag values of one `--platform ios` run.
type iosDeploy struct {
	a   *App
	cmd *cobra.Command

	projectPath, name, description       string
	profiles                             []string
	stage, changelog, commit, buildNo    string
	bump                                 string
	doBump                               bool
	flavor, variant, bundleID, teamID    string
	defines, defineFiles, extraTags      []string
	noteSkips, passthrough               []string
	noUpload, noVerify, noCreate         bool
	noDriftCheck, requireClean           bool
	versionTag, prebuild, requireFlutter string
	noPrebuild, printConfig              bool
	skipPreflight, checkSigning          bool
	cocoapods                            bool
}

// signing is the preflight's answer for one profile.
type signing struct {
	Profile   string `json:"profile"`
	Identity  string `json:"identity,omitempty"`
	Automatic bool   `json:"automatic"`
	// Provisioning is the installed profile the export is pinned to; empty
	// with automatic signing.
	Provisioning string `json:"provisioningProfile,omitempty"`
	Expires      string `json:"expires,omitempty"`
	Wildcard     bool   `json:"wildcard,omitempty"`
	XcodeManaged bool   `json:"xcodeManaged,omitempty"`

	exportName string // the profile name ExportOptions pins; "" = automatic
	exportUUID string // that profile's UUID, compared with the IPA's
}

func iosTool(ctx context.Context, name string, args ...string) ([]byte, error) {
	return deployOutput(ctx, "", name, args...)
}

// iosPreflight proves, before a long archive, that this shell can sign for
// the profile: an identity of the right kind that codesign can really use,
// and an installed provisioning profile of the right kind for the bundle id
// (or Xcode's automatic signing when the project is set up for it).
func iosPreflight(ctx context.Context, projectPath, method, team, bundle string, allowWildcard bool, installed []ios.Profile) (signing, error) {
	res := signing{Profile: method}
	id, err := ios.FindIdentity(ctx, iosTool, method, team)
	if err != nil {
		return res, err
	}
	if err := ios.ProbeCodesign(ctx, iosTool, id); err != nil {
		return res, err
	}
	res.Identity = id.Name
	p, ok := ios.SelectProfile(installed, team, bundle, method, allowWildcard, clockNow())
	switch {
	case ok:
		res.Provisioning, res.Wildcard, res.XcodeManaged = p.Name, p.Wildcard(), p.XcodeManaged
		if !p.Expires.IsZero() {
			res.Expires = p.Expires.UTC().Format("2006-01-02")
		}
		// An Xcode-managed profile cannot be named in a manual export.
		if p.XcodeManaged {
			res.Automatic = true
		} else {
			res.exportName, res.exportUUID = p.Name, p.UUID
		}
	case ios.AutomaticSigning(projectPath):
		res.Automatic = true
	default:
		return res, fmt.Errorf("no installed provisioning profile signs %s for %s (team and bundle id must match; development: get-task-allow; ad-hoc: a device list; app-store: neither; a wildcard profile only for development; expired profiles are skipped), and the Xcode project does not sign automatically: install the profile, or pass --skip-signing-preflight for a project that signs on its own", bundle, method)
	}
	return res, nil
}

func (d *iosDeploy) run(ctx context.Context) error {
	a, cmd, projectPath := d.a, d.cmd, d.projectPath
	changed := cmd.Flags().Changed
	for _, f := range []string{"split-per-abi", "target-platform", "application-id", "version-code-offset", "min-sdk", "target-sdk", "abi"} {
		if changed(f) {
			return fmt.Errorf("--%s is an Android option; it has no meaning with --platform ios", f)
		}
	}
	if len(d.profiles) == 0 {
		return fmt.Errorf("--platform ios needs --build-profile (%s)", strings.Join(ios.Methods, "|"))
	}
	for _, pr := range d.profiles {
		if !ios.ValidMethod(pr) {
			return fmt.Errorf("invalid --build-profile %q for --platform ios (%s)", pr, strings.Join(ios.Methods, "|"))
		}
	}
	if d.checkSigning && d.skipPreflight {
		return errors.New("--check-signing and --skip-signing-preflight cannot be combined")
	}
	if err := checkPassthrough(d.passthrough); err != nil {
		return err
	}
	for _, arg := range d.passthrough {
		name, _, _ := strings.Cut(arg, "=")
		if hint, ok := iosReservedFlags[name]; ok {
			return fmt.Errorf("%s cannot be passed after --: %s", name, hint)
		}
	}
	userTags, err := parseTags(d.extraTags)
	if err != nil {
		return err
	}
	for _, k := range []string{"bundle_id", "build_number", "distribution_method", "minimum_os_version"} {
		if _, set := userTags[k]; set {
			return fmt.Errorf("--tag %s: deploy sets this tag from the built file", k)
		}
	}

	cfg, cfgPath, err := findBuildConfig(projectPath)
	if err != nil {
		return err
	}
	var ic iosBuild
	if cfg.IOS != nil {
		ic = *cfg.IOS
	}
	versionTag, noCreate, commit, changelog := d.versionTag, d.noCreate, d.commit, d.changelog
	noteSkips, requireFlutter, prebuild := d.noteSkips, d.requireFlutter, d.prebuild
	if !changed("version-tag") {
		for _, v := range []string{cfg.VersionTag, ic.VersionTag} {
			if v != "" {
				versionTag = v
			}
		}
	}
	if versionTag != "full" && versionTag != "marketing" {
		return fmt.Errorf("invalid --version-tag %q (full|marketing)", versionTag)
	}
	if !changed("no-create") && cfg.Create != nil {
		noCreate = !*cfg.Create
	}
	if !changed("commit") {
		commit = cfg.Commit
	}
	if !changed("note") {
		changelog = cfg.Note
	}
	if !changed("note-skip") {
		noteSkips = cfg.NoteSkip
	}
	var skips []*regexp.Regexp
	for _, raw := range noteSkips {
		if raw == "" {
			continue
		}
		re, err := regexp.Compile(raw)
		if err != nil {
			return fmt.Errorf("--note-skip: %w", err)
		}
		skips = append(skips, re)
	}
	if !changed("require-flutter") {
		requireFlutter = cfg.RequireFlutter
	}
	if d.noPrebuild && changed("prebuild") {
		return errors.New("--prebuild and --no-prebuild cannot be combined")
	}
	if d.noPrebuild {
		prebuild = ""
	} else if !changed("prebuild") {
		prebuild = cfg.Prebuild
	}
	hook, err := hookPath(projectPath, prebuild)
	if err != nil {
		return err
	}
	cocoapods := d.cocoapods
	if !changed("cocoapods") && ic.UseCocoapods != nil {
		cocoapods = *ic.UseCocoapods
	}

	// Which app and which bundle id: flag > variant preset > build.ios.
	// The preset need not carry a bundleId: an Android-only variants file is
	// usable with --bundle-id. What an upload needs is checked below.
	variant, preset, err := resolveVariant(projectPath, d.variant, d.flavor, false)
	if err != nil {
		return err
	}
	flavor, name, bundle := d.flavor, d.name, d.bundleID
	if flavor, err = mergePreset("--flavor", flavor, preset.Flavor, variant); err != nil {
		return err
	}
	if name, err = mergePreset("--name", name, preset.App, variant); err != nil {
		return err
	}
	if bundle, err = mergePreset("--bundle-id", bundle, preset.BundleID, variant); err != nil {
		return err
	}
	if bundle == "" && variant == "" {
		bundle = ic.BundleID
	}
	if bundle == "" && variant != "" {
		// build.ios.bundleId is the flavorless app's: an edition has its own.
		return fmt.Errorf("variant %s has no \"bundleId\": add it to the preset or pass --bundle-id", variant)
	}
	if bundle == "" {
		// Never read from the Xcode project: with flavors it holds several,
		// and the IPA is checked against this value.
		return errors.New("--platform ios needs the bundle id: --bundle-id, a variant's \"bundleId\", or build.ios.bundleId in " + ContextFile)
	}
	if err := ios.CheckBundleID(bundle); err != nil {
		return err
	}
	if err := checkIdentity(flavor, name, ""); err != nil {
		return err
	}
	if name == "" {
		if flavor != "" && !d.noUpload {
			return fmt.Errorf("--flavor %s: pass --name (the catalog app of this flavor) or use a variant with \"app\"", flavor)
		}
		name = bundle[strings.LastIndex(bundle, ".")+1:]
	}

	version, err := flutter.Version(projectPath)
	if err != nil {
		return err
	}
	bumpFrom := version
	if d.doBump {
		b, err := flutter.ParseBump(d.bump)
		if err != nil {
			return err
		}
		if version, err = flutter.BumpVersion(version, b); err != nil {
			return err
		}
	}
	versionName, buildNumber, hasBuild := flutter.SplitVersion(version)
	if !hasBuild && !d.checkSigning {
		return fmt.Errorf("--platform ios needs a build number in the pubspec version (x.y.z+n), found %s", version)
	}
	tagVersion := version
	if versionTag == "marketing" {
		tagVersion = versionName
	}

	flagArgs, flagKeys, err := dartDefineArgs(d.defines, d.defineFiles, d.printConfig)
	if err != nil {
		return err
	}
	type iosPlan struct {
		profilePlan
		export string // ExportOptions.plist path, set right before the build
	}
	plans := make([]iosPlan, 0, len(d.profiles))
	for _, pr := range d.profiles {
		pb := ic.Profiles[pr]
		plan := profilePlan{Profile: pr, Stage: pb.Stage}
		if changed("stage") {
			plan.Stage = d.stage
		}
		defArgs, defKeys, defFiles, err := profileDefines(cfgPath, projectPath, pr, pb.DartDefines, pb.DartDefineFiles, flagArgs, flagKeys, d.defineFiles, d.printConfig)
		if err != nil {
			return err
		}
		plan.DefineKeys, plan.DefineFiles = defKeys, defFiles
		plan.args = []string{"build", "ipa", "--release"}
		if flavor != "" {
			plan.args = append(plan.args, "--flavor", flavor)
		}
		plan.args = append(plan.args, defArgs...)
		plan.args = append(plan.args, d.passthrough...)
		plan.Flutter = append([]string{"flutter"}, maskDefines(plan.args)...)
		plan.Flutter = append(plan.Flutter, "--export-options-plist=<generated>")
		plans = append(plans, iosPlan{profilePlan: plan})
	}

	team := d.teamID
	if team == "" {
		team = os.Getenv("IOS_TEAM_ID")
	}
	if team == "" {
		team = ic.TeamID
	}
	if d.printConfig {
		teamShown := ""
		if team != "" {
			// Present or not is what a comparison needs; the id itself
			// stays out of logs.
			teamShown = "set"
		}
		res := map[string]any{
			"config": cfgPath, "platform": "ios", "version": version, "versionTag": versionTag,
			"variant": variant, "flavor": flavor, "app": name, "bundleId": bundle, "teamId": teamShown,
			"minimumOsVersion": ic.MinimumOsVersion, "useCocoapods": cocoapods, "allowWildcardProfile": ic.AllowWildcardProfile,
			"create": !noCreate, "commit": commit, "note": changelog, "noteSkip": noteSkips,
			"requireFlutter": requireFlutter, "prebuild": prebuild,
			"driftCheck": !d.noDriftCheck, "requireClean": d.requireClean, "upload": !d.noUpload,
			"signingPreflight": !d.skipPreflight,
		}
		type view struct {
			Profile     string   `json:"profile"`
			Stage       string   `json:"stage,omitempty"`
			DefineKeys  []string `json:"dartDefines,omitempty"`
			DefineFiles []string `json:"dartDefineFiles,omitempty"`
			Flutter     []string `json:"flutter"`
		}
		shown := make([]profilePlan, 0, len(plans))
		views := make([]view, 0, len(plans))
		for _, p := range plans {
			shown = append(shown, p.profilePlan)
			views = append(views, view{p.Profile, p.Stage, p.DefineKeys, p.DefineFiles, p.Flutter})
		}
		res["profiles"] = views
		return printMergedConfig(a, res, shown)
	}

	if hostOS != "darwin" {
		return fmt.Errorf("--platform ios builds on macOS only (this is %s): nothing was built", hostOS)
	}
	if team == "" {
		return errors.New("--platform ios needs the Apple team id: --ios-team-id, IOS_TEAM_ID, or build.ios.teamId in a private " + ContextFile)
	}
	if err := ios.CheckTeamID(team); err != nil {
		return err
	}

	var (
		repo           *repoGuard
		autoNoteWanted = changelog == "auto" && !d.noUpload
	)
	if !d.checkSigning {
		if err := d.cheapRefusals(ctx, requireFlutter, cocoapods); err != nil {
			return err
		}
		if repo, err = startRepoGuard(ctx, projectPath, repoWants{
			noDriftCheck: d.noDriftCheck, commitAuto: commit == "auto", noteAuto: autoNoteWanted, requireClean: d.requireClean}); err != nil {
			return err
		}
		if commit == "auto" {
			if commit, err = repo.commit(ctx); err != nil {
				return err
			}
		}
		if autoNoteWanted {
			if changelog, err = repo.note(ctx, skips); err != nil {
				return err
			}
		}
	}
	// Signing preflight, before the console or pubspec are touched. The
	// keychain is changed only now, after every refusal that needs no key.
	if pw := os.Getenv("CI_KEYCHAIN_PASSWORD"); pw != "" {
		// Nothing started after this needs it: the prebuild script, pod,
		// flutter and Xcode's build phases are project code.
		_ = os.Unsetenv("CI_KEYCHAIN_PASSWORD")
		keychain := os.Getenv("CI_KEYCHAIN_PATH")
		if keychain == "" {
			home, err := userHome()
			if err != nil {
				return err
			}
			keychain = filepath.Join(home, "Library", "Keychains", "login.keychain-db")
		}
		fmt.Fprintf(a.Err, "unlocking keychain %s\n", keychain)
		if err := ios.UnlockKeychain(ctx, iosTool, keychain, pw); err != nil {
			return err
		}
	}
	signs := make([]signing, len(plans))
	if d.skipPreflight {
		for i, p := range plans {
			signs[i] = signing{Profile: p.Profile, Automatic: true}
		}
		fmt.Fprintln(a.Err, "note: signing preflight skipped; exporting with automatic signing")
	} else {
		home, err := userHome()
		if err != nil {
			return err
		}
		installed, undecoded := ios.ListProfiles(ctx, iosTool, ios.ProfileDirs(home))
		if undecoded > 0 {
			if len(installed) == 0 {
				// "No profile matched" would be a guess, and the automatic
				// fallback an unchecked one.
				return fmt.Errorf("none of the %d installed provisioning profiles could be decoded with %s: cannot tell what this host can sign", undecoded, ios.OpenSSL)
			}
			fmt.Fprintf(a.Err, "note: %d installed provisioning profile(s) could not be decoded and were skipped\n", undecoded)
		}
		for i, p := range plans {
			if signs[i], err = iosPreflight(ctx, projectPath, p.Profile, team, bundle, ic.AllowWildcardProfile, installed); err != nil {
				return fmt.Errorf("%s: %w", p.Profile, err)
			}
			how := "automatic signing"
			if signs[i].Provisioning != "" {
				how = fmt.Sprintf("profile %q", textsafe.Clean(signs[i].Provisioning))
				if signs[i].Wildcard {
					how += " (wildcard)"
				}
				if signs[i].Automatic {
					how += " (Xcode-managed, automatic export)"
				}
			}
			fmt.Fprintf(a.Err, "signing %s: %s, %s\n", p.Profile, textsafe.Clean(signs[i].Identity), how)
		}
	}
	if d.checkSigning {
		if a.jsonOut {
			return a.printer().JSONValue(map[string]any{"bundleId": bundle, "signing": signs})
		}
		for _, s := range signs {
			how := "automatic signing (no installed profile matched; Xcode decides at export, not verified here)"
			if s.Provisioning != "" {
				how = fmt.Sprintf("profile %q expires %s", textsafe.Clean(s.Provisioning), s.Expires)
				if s.Wildcard {
					how += ", wildcard"
				}
				if s.Automatic {
					how += ", Xcode-managed (automatic export)"
				}
			}
			fmt.Fprintf(a.Out, "%s: %s; %s\n", s.Profile, textsafe.Clean(s.Identity), how)
		}
		return nil
	}

	if d.noUpload {
		var ignored []string
		for _, n := range []string{"name", "description", "stage", "note", "build", "tag", "no-verify", "version-tag", "no-create", "note-skip"} {
			if changed(n) {
				ignored = append(ignored, "--"+n)
			}
		}
		if len(ignored) > 0 {
			fmt.Fprintf(a.Err, "note: --no-upload ignores %s\n", strings.Join(ignored, ", "))
		}
	}

	var (
		cc         *ctxClient
		cl         *api.Client
		team0      resolved
		appRow     catalogApp
		appID      string
		appMissing bool
	)
	if !d.noUpload {
		if cc, err = a.ctxClient(cmd); err != nil {
			return err
		}
		if team0, err = cc.scope(ctx, true); err != nil {
			return err
		}
		cl = cc.cl
		fmt.Fprintf(a.Err, "deploying %s to %s\n", name, team0)
		if appID, appMissing, err = findDeployApp(ctx, cc, team0, name, &appRow); err != nil {
			return err
		}
		if appMissing && noCreate {
			return &api.Error{Status: http.StatusNotFound, Code: "not_found",
				Message: fmt.Sprintf("app %q does not exist in %s and --no-create is set", name, team0)}
		}
	}

	if d.doBump {
		if err := flutter.SetVersion(projectPath, version); err != nil {
			return err
		}
		fmt.Fprintf(a.Err, "bumped version %s -> %s\n", bumpFrom, version)
	}
	if err := runHook(ctx, a, projectPath, prebuild, hook, version); err != nil {
		return err
	}
	// From here on the system tools come first on PATH (Xcode's IPA step
	// breaks on Homebrew's rsync); the prebuild script above still ran with
	// the caller's own environment.
	applyBuildEnv()
	if cocoapods {
		// The Podfile reads what `pub get` generates.
		if err := deployRunner(ctx, projectPath, "flutter", "pub", "get"); err != nil {
			return fmt.Errorf("flutter pub get: %w", err)
		}
		fmt.Fprintln(a.Err, "installing CocoaPods dependencies…")
		if err := deployRunner(ctx, filepath.Join(projectPath, "ios"), "pod", "install"); err != nil {
			return fmt.Errorf("pod install: %w", err)
		}
	}

	// The baseline includes what the hook and `pod install` wrote
	// (Podfile.lock), so only a change during the builds is drift.
	if err := repo.setBaseline(ctx); err != nil {
		return err
	}

	type builtIPA struct {
		plan profilePlan
		path string
		info ios.IPAInfo
	}
	ipaDir := filepath.Join(projectPath, "build", "ios", "ipa")
	// Kept apart from Flutter's output directory, which is emptied before
	// every build of the run.
	outDir := filepath.Join(projectPath, "build", "ios", "yyt")
	var built []builtIPA
	for i, plan := range plans {
		// A leftover IPA of another build must not be the one uploaded.
		if err := removeIPAs(ipaDir); err != nil {
			return err
		}
		plist, err := writeExportOptions(ios.ExportOptions(plan.Profile, team, bundle, signs[i].exportName))
		if err != nil {
			return err
		}
		fmt.Fprintf(a.Err, "building %s (%s)…\n", name, describeBuild(plan.Profile, flavor, plan.DefineKeys, plan.DefineFiles))
		err = func() error {
			defer os.Remove(plist)
			return deployRunner(ctx, projectPath, "flutter", append(append([]string{}, plan.args...), "--export-options-plist="+plist)...)
		}()
		if err != nil {
			return fmt.Errorf("flutter build ipa (%s): %w", plan.Profile, err)
		}
		ipas, err := listIPAs(ipaDir)
		if err != nil {
			return err
		}
		if len(ipas) != 1 {
			return fmt.Errorf("expected exactly one .ipa in %s after the build, found %d", ipaDir, len(ipas))
		}
		info, err := ios.InspectIPA(ctx, iosTool, ipas[0])
		if err != nil {
			return err
		}
		// What the archive says, against what this deploy was asked to
		// ship; the tags below are the archive's values.
		if err := info.Check(ios.Expect{
			BundleID: bundle, Version: versionName, Build: fmt.Sprint(buildNumber), MinimumOS: ic.MinimumOsVersion,
			Method: plan.Profile, Team: team, Signed: true, AllowWildcard: ic.AllowWildcardProfile,
			ProfileUUID: signs[i].exportUUID, Now: clockNow(),
		}); err != nil {
			return err
		}
		// Flutter names the IPA after the product, which may not be ASCII;
		// the upload gets the same name shape as an Android artifact.
		dst := filepath.Join(outDir, fmt.Sprintf("%s-%s-%s.ipa", name, version, plan.Profile))
		if err := os.MkdirAll(outDir, 0o755); err != nil {
			return err
		}
		if err := copyFile(ipas[0], dst); err != nil {
			return err
		}
		built = append(built, builtIPA{plan: plan.profilePlan, path: dst, info: info})
	}
	if err := repo.check(ctx); err != nil {
		return err
	}
	if d.noUpload {
		type out struct {
			Path             string `json:"path"`
			BuildType        string `json:"buildType"`
			BundleID         string `json:"bundleId"`
			BuildNumber      string `json:"buildNumber"`
			MinimumOsVersion string `json:"minimumOsVersion,omitempty"`
		}
		outs := make([]out, 0, len(built))
		for _, b := range built {
			outs = append(outs, out{b.path, b.plan.Profile, b.info.BundleID, b.info.Build, b.info.MinimumOS})
		}
		if a.jsonOut {
			res := map[string]any{"version": version, "outputs": outs}
			if commit != "" {
				res["commit"] = commit
			}
			return a.printer().JSONValue(res)
		}
		for _, o := range outs {
			fmt.Fprintln(a.Out, o.Path, o.BuildType)
		}
		return nil
	}

	if appMissing {
		if appID, err = createDeployApp(ctx, a, cc, team0, name, bundle, d.description, projectPath, &appRow); err != nil {
			return err
		}
	}
	uploaded := make([]catalogArtifact, 0, len(built))
	for _, b := range built {
		tags := map[string]string{
			"version":             tagVersion,
			"bundle_id":           b.info.BundleID,
			"build_number":        b.info.Build,
			"distribution_method": b.plan.Profile,
		}
		addTagIf(tags, "minimum_os_version", b.info.MinimumOS)
		addTagIf(tags, "stage", b.plan.Stage)
		addTagIf(tags, "changelog", changelog)
		addTagIf(tags, "build", d.buildNo)
		addTagIf(tags, "commit", commit)
		for k, v := range userTags {
			tags[k] = v
		}
		fmt.Fprintf(a.Err, "uploading %s…\n", filepath.Base(b.path))
		art, err := uploadArtifact(ctx, cl, appID, b.path, "ios", tags)
		if err != nil {
			return err
		}
		a.reportVersionLink(art)
		uploaded = append(uploaded, *art)
	}
	verified := 0
	if !d.noVerify {
		ids := make([]string, 0, len(uploaded))
		for _, art := range uploaded {
			ids = append(ids, art.ID)
		}
		if verified, err = verifyUploaded(ctx, cl, appID, ids); err != nil {
			return err
		}
		fmt.Fprintf(a.Err, "verified: %d artifact(s) visible for version %s\n", verified, tagVersion)
	}
	if a.jsonOut {
		res := map[string]any{"app": appRow, "version": tagVersion, "artifacts": uploaded, "verified": verified}
		if commit != "" {
			res["commit"] = commit
		}
		return a.printer().JSONValue(res)
	}
	for i, art := range uploaded {
		// The profile this run built, not what the response echoes.
		fmt.Fprintln(a.Out, art.ID, built[i].plan.Profile, art.URL)
	}
	return nil
}

func listIPAs(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".ipa") {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out, nil
}

func removeIPAs(dir string) error {
	ipas, err := listIPAs(dir)
	if err != nil {
		return err
	}
	for _, p := range ipas {
		if err := os.Remove(p); err != nil {
			return fmt.Errorf("remove stale build output %s: %w", p, err)
		}
	}
	return nil
}

// writeExportOptions writes the plist to a private temporary file; the
// caller removes it after the build.
func writeExportOptions(data []byte) (string, error) {
	f, err := os.CreateTemp("", "yyt-export-options-*.plist")
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// cheapRefusals are the checks that need neither the keychain nor the
// console: the Flutter version and the CocoaPods setup.
func (d *iosDeploy) cheapRefusals(ctx context.Context, requireFlutter string, cocoapods bool) error {
	if requireFlutter != "" {
		got, err := flutterVersion(ctx, d.projectPath)
		if err != nil {
			return err
		}
		if got != requireFlutter {
			return fmt.Errorf("this project requires Flutter %s, the flutter on PATH is %s", requireFlutter, got)
		}
	}
	// A Podfile the config does not expect (or the reverse) means the
	// project's dependency setup is not what the deploy was written for.
	_, podErr := os.Stat(filepath.Join(d.projectPath, "ios", "Podfile"))
	switch {
	case podErr == nil && !cocoapods:
		return errors.New("ios/Podfile exists but CocoaPods is off: pass --cocoapods or set build.ios.useCocoapods, or finish the move to Swift packages and delete the Podfile")
	case podErr != nil && cocoapods:
		return errors.New("CocoaPods is on (--cocoapods / build.ios.useCocoapods) but ios/Podfile is missing")
	}
	return nil
}
