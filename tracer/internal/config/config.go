// Package config loads tracer's JSON configuration: listen address, database
// path and the per-project DSN write keys.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
)

// DefaultMaxEnvelopeBytes caps the decompressed size of one envelope.
const DefaultMaxEnvelopeBytes = 20 << 20

// Project is one DSN target. Key is the public DSN key; it only authorizes writes.
type Project struct {
	ID   int    `json:"id"`
	Slug string `json:"slug"`
	Key  string `json:"key"`
}

// Config is the whole configuration file.
type Config struct {
	Listen           string    `json:"listen"`
	DB               string    `json:"db"`
	MaxEnvelopeBytes int64     `json:"max_envelope_bytes"`
	Projects         []Project `json:"projects"`
}

// Load reads and validates a config file.
func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(b)
}

// Parse decodes and validates config JSON.
func Parse(b []byte) (*Config, error) {
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if c.MaxEnvelopeBytes <= 0 {
		c.MaxEnvelopeBytes = DefaultMaxEnvelopeBytes
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) validate() error {
	if c.DB == "" {
		return errors.New("config: db is required")
	}
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("config: listen: %w", err)
	}
	// docs/tracer.md: listen on loopback or the docker bridge, never every interface.
	if host == "" || host == "0.0.0.0" || host == "::" {
		return fmt.Errorf("config: listen %q binds all interfaces; use loopback or the docker bridge address", c.Listen)
	}
	ids := map[int]bool{}
	keys := map[string]bool{}
	for _, p := range c.Projects {
		if p.ID <= 0 || p.Slug == "" || p.Key == "" {
			return fmt.Errorf("config: project %+v needs id, slug and key", p)
		}
		if ids[p.ID] || keys[p.Key] {
			return fmt.Errorf("config: duplicate project id or key (project %d)", p.ID)
		}
		ids[p.ID], keys[p.Key] = true, true
	}
	return nil
}

// ProjectByID returns the project with the given numeric id.
func (c *Config) ProjectByID(id int) (Project, bool) {
	for _, p := range c.Projects {
		if p.ID == id {
			return p, true
		}
	}
	return Project{}, false
}
