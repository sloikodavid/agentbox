// Package heartbeat writes the runtime status file consumed by the gateway
// readiness check at /run/agentbox/persistd.ready.
package heartbeat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Status enumerates the values for Heartbeat.Status.
type Status string

const (
	StatusOK       Status = "ok"
	StatusDegraded Status = "degraded"
	StatusDisabled Status = "disabled"
)

// Mode enumerates the daemon mode reported in the heartbeat.
type Mode string

const (
	ModeWatch   Mode = "watch"
	ModeRestore Mode = "restore"
	ModeStarting Mode = "starting"
)

// Heartbeat is the runtime status document. JSON shape is part of the
// contract with the gateway readiness check; only add fields, never remove.
type Heartbeat struct {
	UpdatedAt        time.Time `json:"updatedAt"`
	Status           Status    `json:"status"`
	Mode             Mode      `json:"mode"`
	WatcherCount     int       `json:"watcherCount"`
	DegradedReasons  []string  `json:"degradedReasons"`
	DirtyBacklog     int       `json:"dirtyBacklog"`
	AuditCursorCount int       `json:"auditCursorCount"`
	LastError        *string   `json:"lastError"`
}

// Disabled returns a heartbeat representing the refuse-to-persist state.
func Disabled(reason string) Heartbeat {
	return Heartbeat{
		UpdatedAt:       time.Now().UTC(),
		Status:          StatusDisabled,
		Mode:            ModeWatch,
		DegradedReasons: []string{reason},
	}
}

// Write atomically replaces the heartbeat file at path with hb. The parent
// directory must already exist.
func Write(path string, hb Heartbeat) error {
	if hb.DegradedReasons == nil {
		hb.DegradedReasons = []string{}
	}
	if hb.UpdatedAt.IsZero() {
		hb.UpdatedAt = time.Now().UTC()
	}
	data, err := json.MarshalIndent(hb, "", "\t")
	if err != nil {
		return fmt.Errorf("heartbeat: marshal: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
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
