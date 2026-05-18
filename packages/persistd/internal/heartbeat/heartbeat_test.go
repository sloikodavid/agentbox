package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWrite_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ready")
	hb := Ready()
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
	if !got.Ready || got.UpdatedAt.IsZero() {
		t.Errorf("round trip mismatch: %+v", got)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if mode := info.Mode().Perm(); mode != 0o644 {
			t.Errorf("mode = %v, want 0644", mode)
		}
	}
}

func TestWrite_CreatesParentDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run", "persistd", "ready")
	if err := Write(path, Ready()); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat ready file: %v", err)
	}
}

func TestReady_IsReady(t *testing.T) {
	hb := Ready()
	if !hb.Ready {
		t.Error("expected ready heartbeat")
	}
}

func TestWrite_AtomicReplace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ready")
	if err := Write(path, Heartbeat{Ready: false}); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, Ready()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var got Heartbeat
	_ = json.Unmarshal(raw, &got)
	if !got.Ready {
		t.Errorf("expected replaced ready content, got %+v", got)
	}
}
