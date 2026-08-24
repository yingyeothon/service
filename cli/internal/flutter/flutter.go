// Package flutter parses Flutter project metadata (pubspec version, Android
// applicationId, app label) for `yyt catalog deploy`. Ported from the legacy
// catalog CLI; regex-based so no YAML dependency is needed.
package flutter

import (
	"encoding/xml"
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

// Label reads `app_name` from android strings.xml; "" when absent.
func Label(projectPath string) string {
	data, err := os.ReadFile(filepath.Join(projectPath,
		"android", "app", "src", "main", "res", "values", "strings.xml"))
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
