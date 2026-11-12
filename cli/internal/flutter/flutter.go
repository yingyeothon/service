// Package flutter parses Flutter project metadata (pubspec version, Android
// applicationId, app label) for `yyt catalog deploy`. Ported from the legacy
// catalog CLI; regex-based so no YAML dependency is needed.
package flutter

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var versionLine = regexp.MustCompile(`(?m)^version:\s*(\S+)\s*$`)

// Version reads `version:` from pubspec.yaml (e.g. `1.2.3+45`).
func Version(projectPath string) (string, error) {
	data, err := os.ReadFile(filepath.Join(projectPath, "pubspec.yaml"))
	if err != nil {
		return "", fmt.Errorf("read pubspec.yaml: %w", err)
	}
	m := versionLine.FindSubmatch(data)
	if m == nil {
		return "", fmt.Errorf("version field not found in pubspec.yaml")
	}
	return string(m[1]), nil
}

// SetVersion rewrites the `version:` line in pubspec.yaml.
func SetVersion(projectPath, version string) error {
	p := filepath.Join(projectPath, "pubspec.yaml")
	data, err := os.ReadFile(p)
	if err != nil {
		return fmt.Errorf("read pubspec.yaml: %w", err)
	}
	if !versionLine.Match(data) {
		return fmt.Errorf("version field not found in pubspec.yaml")
	}
	updated := versionLine.ReplaceAllString(string(data), "version: "+version)
	return os.WriteFile(p, []byte(updated), 0o644)
}

type Bump string

const (
	BumpMajor Bump = "major"
	BumpMinor Bump = "minor"
	BumpPatch Bump = "patch"
)

func ParseBump(raw string) (Bump, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(BumpMajor):
		return BumpMajor, nil
	case string(BumpMinor):
		return BumpMinor, nil
	case "", string(BumpPatch):
		return BumpPatch, nil
	default:
		return "", fmt.Errorf("invalid bump %q (allowed: major, minor, patch)", raw)
	}
}

// BumpVersion bumps `1.2.3+45` → `1.2.4+46` (build number always +1, missing = 1).
func BumpVersion(raw string, bump Bump) (string, error) {
	version := strings.TrimSpace(raw)
	base, build := version, ""
	if i := strings.Index(version, "+"); i >= 0 {
		base, build = strings.TrimSpace(version[:i]), strings.TrimSpace(version[i+1:])
	}
	seg := strings.Split(base, ".")
	if len(seg) != 3 {
		return "", fmt.Errorf("invalid version %q", base)
	}
	v := make([]int, 3)
	for i, s := range seg {
		n, err := strconv.Atoi(s)
		if err != nil {
			return "", fmt.Errorf("invalid version segment %q", s)
		}
		v[i] = n
	}
	switch bump {
	case BumpMajor:
		v[0], v[1], v[2] = v[0]+1, 0, 0
	case BumpMinor:
		v[1], v[2] = v[1]+1, 0
	case BumpPatch:
		v[2]++
	}
	n := 1
	if build != "" {
		b, err := strconv.Atoi(build)
		if err != nil {
			return "", fmt.Errorf("invalid build number %q", build)
		}
		n = b + 1
	}
	return fmt.Sprintf("%d.%d.%d+%d", v[0], v[1], v[2], n), nil
}

var applicationID = regexp.MustCompile(`applicationId\s*=?\s*"([^"]+)"`)

// ApplicationID reads applicationId from android/app/build.gradle(.kts).
func ApplicationID(projectPath string) (string, error) {
	var lastErr error
	for _, name := range []string{"build.gradle", "build.gradle.kts"} {
		p := filepath.Join(projectPath, "android", "app", name)
		data, err := os.ReadFile(p)
		if err != nil {
			lastErr = err
			continue
		}
		m := applicationID.FindSubmatch(data)
		if m == nil {
			return "", fmt.Errorf("applicationId not found in %s", p)
		}
		return string(m[1]), nil
	}
	return "", fmt.Errorf("build.gradle(.kts) not found: %w", lastErr)
}

type stringsXML struct {
	Strings []struct {
		Name  string `xml:"name,attr"`
		Value string `xml:",chardata"`
	} `xml:"string"`
}

// Label reads `app_name` from the Android string resources of the variant
// being built; "" when absent. Gradle's source set priority is build variant,
// build type, product flavor, main, so the lookup order is <flavor><Mode>,
// <mode>, <flavor>, main. mode is debug or release.
func Label(projectPath, flavor, mode string) string {
	var sets []string
	if flavor != "" {
		if mode != "" {
			sets = append(sets, flavor+strings.ToUpper(mode[:1])+mode[1:])
		}
	}
	if mode != "" {
		sets = append(sets, mode)
	}
	if flavor != "" {
		sets = append(sets, flavor)
	}
	sets = append(sets, "main")
	for _, set := range sets {
		if l := labelIn(filepath.Join(projectPath, "android", "app", "src", set, "res", "values", "strings.xml")); l != "" {
			return l
		}
	}
	return ""
}

func labelIn(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var res stringsXML
	if xml.Unmarshal(data, &res) != nil {
		return ""
	}
	for _, s := range res.Strings {
		if s.Name == "app_name" {
			return s.Value
		}
	}
	return ""
}

// OutputMetadataPath is where the Android Gradle plugin describes the APKs of
// one variant: build/app/outputs/apk/[<flavor>/]<mode>/output-metadata.json.
// Gradle names the flavor directory in its own case, so it is matched
// case-insensitively; "" when a flavor is given and has no directory yet.
func OutputMetadataPath(projectPath, flavor, mode string) string {
	base := filepath.Join(projectPath, "build", "app", "outputs", "apk")
	if flavor == "" {
		return filepath.Join(base, mode, "output-metadata.json")
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() && strings.EqualFold(e.Name(), flavor) {
			return filepath.Join(base, e.Name(), mode, "output-metadata.json")
		}
	}
	return ""
}

// BuildMetadata is what the Android Gradle plugin recorded about the APKs of
// one variant.
type BuildMetadata struct {
	// ApplicationID is the packaged id, build-type suffix included
	// (e.g. `com.example.app.debug`).
	ApplicationID string
	// versionCodes maps an ABI split to its versionCode; "" is the output
	// without an ABI filter (the universal APK).
	versionCodes map[string]int
}

// VersionCode is the packaged versionCode of the APK for abi ("" for the
// unsplit APK); 0 when the metadata does not describe that output.
func (m *BuildMetadata) VersionCode(abi string) int {
	if m == nil {
		return 0
	}
	return m.versionCodes[abi]
}

// BuiltMetadata reads the output metadata of the last APK build of a variant.
// nil with a nil error means Gradle left no metadata to read.
func BuiltMetadata(projectPath, flavor, mode string) (*BuildMetadata, error) {
	p := OutputMetadataPath(projectPath, flavor, mode)
	if p == "" {
		return nil, nil
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var meta struct {
		ApplicationID string `json:"applicationId"`
		Elements      []struct {
			Filters []struct {
				FilterType string `json:"filterType"`
				Value      string `json:"value"`
			} `json:"filters"`
			VersionCode int `json:"versionCode"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("parse %s: %w", p, err)
	}
	if meta.ApplicationID == "" {
		return nil, fmt.Errorf("%s has no applicationId", p)
	}
	out := &BuildMetadata{ApplicationID: meta.ApplicationID, versionCodes: map[string]int{}}
	for _, e := range meta.Elements {
		abi := ""
		for _, f := range e.Filters {
			if f.FilterType == "ABI" {
				abi = f.Value
			}
		}
		if e.VersionCode > 0 {
			out.versionCodes[abi] = e.VersionCode
		}
	}
	return out, nil
}

// SplitVersion splits a pubspec version `x.y.z+n` into its name and build
// number; hasBuild is false when there is no numeric `+n`.
func SplitVersion(version string) (name string, build int, hasBuild bool) {
	name, raw, found := strings.Cut(version, "+")
	if !found {
		return name, 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return name, 0, false
	}
	return name, n, true
}
