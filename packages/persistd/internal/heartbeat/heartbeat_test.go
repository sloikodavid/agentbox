package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWrite_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "persistd.ready")
	hb := Heartbeat{
		Status:           StatusOK,
		Mode:             ModeWatch,
		WatcherCount:     12,
		DirtyBacklog:     3,
		AuditCursorCount: 4,
	}
	if err := Write(path, hb); err != nil {
		t.Fatalf("Write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got Heartbeat
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Status != StatusOK || got.WatcherCount != 12 || got.DirtyBacklog != 3 {
		t.Errorf("round trip mismatch: %+v", got)
	}
	if got.DegradedReasons == nil {
		t.Error("degradedReasons should serialize as [] not null")
	}
}

func TestDisabled_HasReason(t *testing.T) {
	hb := Disabled("restore failed")
	if hb.Status != StatusDisabled {
		t.Errorf("status = %q", hb.Status)
	}
	if len(hb.DegradedReasons) != 1 || hb.DegradedReasons[0] != "restore failed" {
		t.Errorf("degradedReasons = %v", hb.DegradedReasons)
	}
}

func TestWrite_AtomicReplace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "persistd.ready")
	if err := Write(path, Disabled("first")); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, Disabled("second")); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var got Heartbeat
	_ = json.Unmarshal(raw, &got)
	if got.DegradedReasons[0] != "second" {
		t.Errorf("expected replaced content, got %v", got.DegradedReasons)
	}
}
