// Package config stores the CLI login (console base URL + API token) in
// ~/.config/yyt/config.json with 0600 permissions.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const DefaultAPI = "https://console.yyt.life"

type Config struct {
	API   string `json:"api"`
	Token string `json:"token"`
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

// Load reads the file; a missing file yields an empty config, not an error.
func Load() (Config, error) {
	p, err := Path()
	if err != nil {
		return Config{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("%s: %w", p, err)
	}
	return c, nil
}

// Save writes the file atomically with 0600 (the token is a credential).
func Save(c Config) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Remove deletes the file; missing is fine.
func Remove() error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Resolve merges flags > env (YYT_API, YYT_TOKEN) > file > default.
func Resolve(flagAPI, flagToken string) (Config, error) {
	c, err := Load()
	if err != nil {
		return Config{}, err
	}
	if v := os.Getenv("YYT_API"); v != "" {
		c.API = v
	}
	if v := os.Getenv("YYT_TOKEN"); v != "" {
		c.Token = v
	}
	if flagAPI != "" {
		c.API = flagAPI
	}
	if flagToken != "" {
		c.Token = flagToken
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
