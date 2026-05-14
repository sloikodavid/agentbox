// Package config loads and validates the persistd user configuration and
// resolves runtime path settings from environment variables.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Paths holds the resolved filesystem locations persistd uses at runtime.
// All fields are absolute paths.
type Paths struct {
	Volume        string
	Config        string
	DB            string
	Objects       string
	Heartbeat     string
}

// Exclude lists path patterns that persistd will not capture.
type Exclude struct {
	RootRelative []string `json:"rootRelative"`
}

// Audit holds the scheduler token-bucket budget for the rolling audit.
type Audit struct {
	MaxWorkMsPerTick          int `json:"maxWorkMsPerTick"`
	MaxFilesystemOpsPerSecond int `json:"maxFilesystemOpsPerSecond"`
	MaxHashBytesPerSecond     int `json:"maxHashBytesPerSecond"`
	DirectoryBatchSize        int `json:"directoryBatchSize"`
}

// Config is the durable user-editable configuration.
type Config struct {
	Exclude Exclude `json:"exclude"`
	Audit   Audit   `json:"audit"`
}

// Default returns the built-in default configuration written on first boot.
func Default() Config {
	return Config{
		Exclude: Exclude{
			RootRelative: []string{
				"/.dockerenv",
				"/data",
				"/dev",
				"/proc",
				"/run",
				"/sys",
				"/tmp",
				"/home/user/.cache",
				"/home/user/.local/share/Trash",
				"/opt/agentbox",
				"/opt/code-server",
				"/etc/supervisor",
				"/usr/share/applications/agentbox.desktop",
				"/var/cache/apt/archives",
				"/var/lib/apt/lists/lock",
				"/var/lib/dpkg/lock",
				"/var/lib/dpkg/lock-frontend",
				"/var/lib/dpkg/triggers/Lock",
				"/var/run",
			},
		},
		Audit: Audit{
			MaxWorkMsPerTick:          10,
			MaxFilesystemOpsPerSecond: 2000,
			MaxHashBytesPerSecond:     20000000,
			DirectoryBatchSize:        256,
		},
	}
}

// ResolvePaths reads the AGENTBOX_* environment variables and returns the
// resolved paths. AGENTBOX_VOLUME_PATH (default /data) seeds the derived
// defaults; each AGENTBOX_PERSISTENCE_*_PATH override wins if set.
func ResolvePaths(env func(string) string) Paths {
	volume := env("AGENTBOX_VOLUME_PATH")
	if volume == "" {
		volume = "/data"
	}
	persistence := path.Join(volume, "persistence")
	p := Paths{
		Volume:    volume,
		Config:    path.Join(persistence, "config.json"),
		DB:        path.Join(persistence, "db.sqlite"),
		Objects:   path.Join(persistence, "objects"),
		Heartbeat: "/run/agentbox/persistd.ready",
	}
	if v := env("AGENTBOX_PERSISTENCE_CONFIG_PATH"); v != "" {
		p.Config = v
	}
	if v := env("AGENTBOX_PERSISTENCE_DB_PATH"); v != "" {
		p.DB = v
	}
	if v := env("AGENTBOX_PERSISTENCE_OBJECTS_PATH"); v != "" {
		p.Objects = v
	}
	if v := env("AGENTBOX_PERSISTENCE_HEARTBEAT_PATH"); v != "" {
		p.Heartbeat = v
	}
	return p
}

// LoadOrCreate returns the configuration at path, writing the default when no
// file exists. Returns created=true when a default was written.
func LoadOrCreate(path string) (cfg Config, created bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		def := Default()
		if err := writeDefault(path, def); err != nil {
			return Config{}, false, err
		}
		return def, true, nil
	}
	if err != nil {
		return Config{}, false, fmt.Errorf("read config: %w", err)
	}
	parsed, err := Parse(data)
	if err != nil {
		return Config{}, false, err
	}
	return parsed, false, nil
}

// Parse strictly decodes config JSON. Unknown fields are rejected.
func Parse(data []byte) (Config, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var cfg Config
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
	}
	if dec.More() {
		return Config{}, errors.New("parse config: trailing data after JSON document")
	}
	if err := validate(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func validate(cfg Config) error {
	for _, p := range cfg.Exclude.RootRelative {
		if !strings.HasPrefix(p, "/") {
			return fmt.Errorf("exclude.rootRelative entry %q must start with '/'", p)
		}
	}
	if cfg.Audit.MaxWorkMsPerTick < 0 {
		return errors.New("audit.maxWorkMsPerTick must be >= 0")
	}
	if cfg.Audit.MaxFilesystemOpsPerSecond < 0 {
		return errors.New("audit.maxFilesystemOpsPerSecond must be >= 0")
	}
	if cfg.Audit.MaxHashBytesPerSecond < 0 {
		return errors.New("audit.maxHashBytesPerSecond must be >= 0")
	}
	if cfg.Audit.DirectoryBatchSize < 0 {
		return errors.New("audit.directoryBatchSize must be >= 0")
	}
	return nil
}

func writeDefault(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "\t")
	if err != nil {
		return fmt.Errorf("encode default config: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write default config: %w", err)
	}
	return nil
}
