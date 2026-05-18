// Package heartbeat writes the runtime ready file consumed by code-server.
package heartbeat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Heartbeat is the runtime ready document. Its presence means persistd has
// completed startup and is ready to protect the live filesystem.
type Heartbeat struct {
	Ready     bool      `json:"ready"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Ready returns a heartbeat representing a ready persistd daemon.
func Ready() Heartbeat {
	return Heartbeat{Ready: true, UpdatedAt: time.Now().UTC()}
}

// Write atomically replaces the heartbeat file at path.
func Write(path string, hb Heartbeat) error {
	if hb.UpdatedAt.IsZero() {
		hb.UpdatedAt = time.Now().UTC()
	}
	data, err := json.MarshalIndent(hb, "", "\t")
	if err != nil {
		return fmt.Errorf("heartbeat: marshal: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("heartbeat: create dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".heartbeat-*")
	if err != nil {
		return fmt.Errorf("heartbeat: create temp: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("heartbeat: write temp: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("heartbeat: chmod temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("heartbeat: close temp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("heartbeat: rename: %w", err)
	}
	return nil
}
