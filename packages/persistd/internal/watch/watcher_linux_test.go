//go:build linux

package watch

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func startWatcher(t *testing.T, excluder Excluder, roots ...string) *Watcher {
	t.Helper()
	w, err := New(excluder)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, r := range roots {
		if err := w.AddTree(r); err != nil {
			t.Fatalf("AddTree %s: %v", r, err)
		}
	}
	go func() { _ = w.Run() }()
	t.Cleanup(func() { _ = w.Close() })
	return w
}

func drainOneMatching(t *testing.T, ch <-chan Event, pred func(Event) bool) Event {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("event channel closed")
			}
			if pred(ev) {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out waiting for matching event")
		}
	}
}

func TestWatcher_CreateModifyDelete(t *testing.T) {
	dir := t.TempDir()
	w := startWatcher(t, nil, dir)

	target := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(target, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	drainOneMatching(t, w.Events(), func(e Event) bool {
		return e.Path == target && e.Op == OpCreated
	})

	if err := os.WriteFile(target, []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	drainOneMatching(t, w.Events(), func(e Event) bool {
		return e.Path == target && (e.Op == OpModified)
	})

	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	drainOneMatching(t, w.Events(), func(e Event) bool {
		return e.Path == target && e.Op == OpDeleted
	})
}

func TestWatcher_NewDirectoryGetsWatched(t *testing.T) {
	dir := t.TempDir()
	w := startWatcher(t, nil, dir)

	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	drainOneMatching(t, w.Events(), func(e Event) bool {
		return e.Path == sub && e.Op == OpCreated && e.IsDir
	})

	// Wait for the dispatched watch to actually be installed; addOne and
	// the emit happen in the same goroutine so observing the event means
	// the watch is in place, but extra slack avoids scheduler races.
	deadline := time.Now().Add(2 * time.Second)
	for w.WatchCount() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if w.WatchCount() < 2 {
		t.Fatalf("child watch never installed: count=%d", w.WatchCount())
	}

	child := filepath.Join(sub, "x.txt")
	if err := os.WriteFile(child, []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	drainOneMatching(t, w.Events(), func(e Event) bool {
		return e.Path == child && e.Op == OpCreated
	})
}

func TestWatcher_ExcludedDirectoryIsNotWatched(t *testing.T) {
	dir := t.TempDir()
	excludedSub := filepath.Join(dir, "skip")
	if err := os.MkdirAll(excludedSub, 0o755); err != nil {
		t.Fatal(err)
	}
	excluder := ExcluderFunc(func(p string) bool {
		return strings.HasPrefix(p, excludedSub)
	})
	w := startWatcher(t, excluder, dir)

	// Touching a file inside the excluded directory must not produce an
	// event for that path within a short window.
	skipChild := filepath.Join(excludedSub, "x.txt")
	if err := os.WriteFile(skipChild, []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(200 * time.Millisecond)
	for {
		select {
		case ev := <-w.Events():
			if strings.HasPrefix(ev.Path, excludedSub) {
				t.Fatalf("received event for excluded path: %+v", ev)
			}
		case <-deadline:
			return
		}
	}
}

func TestWatcher_DegradedReasonsInitiallyEmpty(t *testing.T) {
	dir := t.TempDir()
	w := startWatcher(t, nil, dir)
	if reasons := w.DegradedReasons(); len(reasons) != 0 {
		t.Errorf("expected empty degraded reasons, got %v", reasons)
	}
	if count := w.WatchCount(); count != 1 {
		t.Errorf("WatchCount = %d, want 1", count)
	}
}

func TestWatcher_NewRejectsNilExcluderGracefully(t *testing.T) {
	w, err := New(nil)
	if err != nil {
		t.Fatalf("New(nil): %v", err)
	}
	defer w.Close()
	if w.excluder == nil {
		t.Error("expected default excluder to be installed")
	}
}
