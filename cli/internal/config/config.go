// Package config stores CLI logins (console base URL + API token) per profile
// in ~/.config/yyt/config.json with 0600 permissions.
//
// File schema: {"profiles":{"<name>":{"api","token"}},"default":"<name>"}.
// A legacy flat file {"api","token"} is migrated to the "default" profile on
// first load (re-saved once with 0600; read-only locations keep working with
// the in-memory migration).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const DefaultAPI = "https://console.yyt.life"

// DefaultProfile is the profile name used when none is configured.
const DefaultProfile = "default"

// Profile is one stored login plus its default team/project context
// (`yyt team use`, `yyt project use`). Team and project ids are not secrets.
type Profile struct {
	API     string `json:"api"`
	Token   string `json:"token"`
	Team    string `json:"team,omitempty"`
	Project string `json:"project,omitempty"`
}

// File is the on-disk config document.
type File struct {
	Profiles map[string]Profile `json:"profiles"`
	Default  string             `json:"default,omitempty"`
}

// Config is the resolved per-invocation credential set.
type Config struct {
	API     string
	Token   string
	Profile string // profile name the values came from ("" when purely flags/env)
	// Default team/project of the selected profile. They survive a --token /
	// YYT_TOKEN override (which blanks Profile): the credential changed, the
	// working context the user chose did not.
	Team    string
	Project string
}

// Path returns the config file location. YYT_CONFIG overrides it (tests, CI).
func Path() (string, error) {
	if p := os.Getenv("YYT_CONFIG"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "yyt", "config.json"), nil
}

// legacyDoc matches both the old flat schema and the new one during load.
type legacyDoc struct {
	API      string             `json:"api"`
	Token    string             `json:"token"`
	Profiles map[string]Profile `json:"profiles"`
	Default  string             `json:"default"`
}

// LoadFile reads the config file, migrating a legacy flat file to the
// profile schema (re-saved once). A missing file yields an empty File.
func LoadFile() (File, error) {
	p, err := Path()
	if err != nil {
		return File{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return File{Profiles: map[string]Profile{}}, nil
	}
	if err != nil {
		return File{}, err
	}
	var doc legacyDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		return File{}, fmt.Errorf("%s: %w", p, err)
	}
	f := File{Profiles: doc.Profiles, Default: doc.Default}
	if f.Profiles == nil {
		f.Profiles = map[string]Profile{}
	}
	if len(doc.Profiles) == 0 && (doc.API != "" || doc.Token != "") {
		// Legacy flat file → migrate once. A failed re-save (read-only config
		// location) is fine: the in-memory migration still serves this run.
		f.Profiles[DefaultProfile] = Profile{API: doc.API, Token: doc.Token}
		f.Default = DefaultProfile
		_ = SaveFile(f)
	}
	return f, nil
}

// SaveFile writes the file atomically with 0600 (tokens are credentials).
func SaveFile(f File) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	// Unique temp name so concurrent writers cannot truncate each other's file
	// mid-rename; chmod covers a pre-existing file with looser permissions.
	tf, err := os.CreateTemp(filepath.Dir(p), ".config-*.tmp")
	if err != nil {
		return err
	}
	tmp := tf.Name()
	defer os.Remove(tmp) // no-op after a successful rename
	if err := tf.Chmod(0o600); err != nil {
		tf.Close()
		return err
	}
	if _, err := tf.Write(append(b, '\n')); err != nil {
		tf.Close()
		return err
	}
	if err := tf.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// SaveProfile stores one profile's credentials, keeping the team/project
// defaults already stored under that name (a re-login must not drop them);
// the first stored profile becomes the default.
func SaveProfile(name string, pr Profile) error {
	f, err := LoadFile()
	if err != nil {
		return err
	}
	if old, ok := f.Profiles[name]; ok {
		if pr.Team == "" {
			pr.Team = old.Team
		}
		if pr.Project == "" {
			pr.Project = old.Project
		}
	}
	f.Profiles[name] = pr
	// Only a sole profile auto-becomes the default; never silently steal it
	// when other profiles exist (e.g. right after logging out of the default).
	if f.Default == "" && len(f.Profiles) == 1 {
		f.Default = name
	}
	return SaveFile(f)
}

// RemoveProfile deletes one profile; removing the default clears it (or moves
// it to the sole remaining profile). Missing profile is fine.
func RemoveProfile(name string) error {
	f, err := LoadFile()
	if err != nil {
		return err
	}
	delete(f.Profiles, name)
	if f.Default == name {
		f.Default = ""
		if len(f.Profiles) == 1 {
			for n := range f.Profiles {
				f.Default = n
			}
		}
	}
	return SaveFile(f)
}

// errUnchanged tells withProfile that nothing needs saving.
var errUnchanged = errors.New("unchanged")

// withProfile loads the file, hands `mutate` the named profile (the same
// "unknown profile" error for a missing one) and saves unless it reports
// errUnchanged. SaveFile stays the single write path.
func withProfile(name string, mutate func(f *File, pr Profile) error) error {
	f, err := LoadFile()
	if err != nil {
		return err
	}
	pr, ok := f.Profiles[name]
	if !ok {
		return fmt.Errorf("unknown profile %q (known: %s)", name, knownNames(f))
	}
	if err := mutate(&f, pr); err != nil {
		if errors.Is(err, errUnchanged) {
			return nil
		}
		return err
	}
	return SaveFile(f)
}

// RenameProfile renames a stored profile, moving the default marker with it.
func RenameProfile(oldName, newName string) error {
	return withProfile(oldName, func(f *File, pr Profile) error {
		if newName == "" {
			return fmt.Errorf("profile name must not be empty")
		}
		if oldName == newName {
			return errUnchanged
		}
		if _, exists := f.Profiles[newName]; exists {
			return fmt.Errorf("profile %q already exists", newName)
		}
		delete(f.Profiles, oldName)
		f.Profiles[newName] = pr
		if f.Default == oldName {
			f.Default = newName
		}
		return nil
	})
}

// SetContext stores the default team and/or project of an existing profile.
// A nil pointer leaves that field alone; an empty string clears it. Setting
// the team always clears the project: a project pin is only meaningful under
// the team it was chosen in, and `yyt team use` is the user asking to start
// over from the team.
func SetContext(name string, team, project *string) error {
	return withProfile(name, func(f *File, pr Profile) error {
		if team != nil {
			pr.Team = *team
			pr.Project = ""
		}
		if project != nil {
			pr.Project = *project
		}
		f.Profiles[name] = pr
		return nil
	})
}

// SetDefault marks an existing profile as the default.
func SetDefault(name string) error {
	return withProfile(name, func(f *File, _ Profile) error {
		f.Default = name
		return nil
	})
}

func knownNames(f File) string {
	if len(f.Profiles) == 0 {
		return "none — run `yyt login`"
	}
	names := make([]string, 0, len(f.Profiles))
	for n := range f.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// ProfileName resolves which profile a command should use:
// flag > YYT_PROFILE > file default > "default".
func ProfileName(flagProfile string, f File) (name string, explicit bool) {
	if flagProfile != "" {
		return flagProfile, true
	}
	if v := os.Getenv("YYT_PROFILE"); v != "" {
		return v, true
	}
	if f.Default != "" {
		return f.Default, false
	}
	return DefaultProfile, false
}

// Resolve merges flags > env (YYT_API, YYT_TOKEN) > selected profile > default.
// An explicitly requested profile (flag or YYT_PROFILE) must exist unless both
// API and token are fully supplied by flags/env.
func Resolve(flagProfile, flagAPI, flagToken string) (Config, error) {
	f, err := LoadFile()
	if err != nil {
		return Config{}, err
	}
	name, explicit := ProfileName(flagProfile, f)
	pr, ok := f.Profiles[name]
	c := Config{API: pr.API, Token: pr.Token, Profile: name, Team: pr.Team, Project: pr.Project}
	if v := os.Getenv("YYT_API"); v != "" {
		c.API = v
	}
	if v := os.Getenv("YYT_TOKEN"); v != "" {
		c.Token = v
		c.Profile = "" // the credential is not the profile's — don't claim it is
	}
	if flagAPI != "" {
		c.API = flagAPI
	}
	if flagToken != "" {
		c.Token = flagToken
		c.Profile = ""
	}
	if explicit && !ok && (c.API == "" || c.Token == "") {
		return Config{}, fmt.Errorf("unknown profile %q (known: %s); run `yyt login --profile %s`",
			name, knownNames(f), name)
	}
	if c.API == "" {
		c.API = DefaultAPI
	}
	c.API = strings.TrimRight(c.API, "/")
	if err := CheckAPI(c.API); err != nil {
		return Config{}, err
	}
	return c, nil
}

// CheckAPI refuses to send a bearer token over plain http (except localhost).
func CheckAPI(api string) error {
	u, err := url.Parse(api)
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid console URL %q", api)
	}
	h := u.Hostname()
	local := h == "localhost" || h == "127.0.0.1" || h == "::1"
	if u.Scheme == "https" || (u.Scheme == "http" && local) {
		return nil
	}
	return fmt.Errorf("console URL must use https (got %q)", api)
}
