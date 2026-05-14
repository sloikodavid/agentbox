package audit

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/scheduler"
)

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	sqldb, err := db.Open(context.Background(), filepath.Join(dir, "test.sqlite"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = sqldb.Close() })
	return sqldb
}

func newBudget() *scheduler.Budget {
	return &scheduler.Budget{
		FsOps:     scheduler.NewTokenBucket(10000, 10000, nil),
		HashBytes: scheduler.NewTokenBucket(1e9, 1e9, nil),
	}
}

func drainAudit(t *testing.T, a *Auditor) {
	t.Helper()
	budget := newBudget()
	ctx := context.Background()
	for i := 0; i < 10000; i++ {
		more, err := a.RunOne(ctx, budget)
		if err != nil {
			t.Fatalf("RunOne: %v", err)
		}
		if !more {
			return
		}
	}
	t.Fatal("audit did not converge")
}

func TestAudit_DiscoversTreeFromScratch(t *testing.T) {
	live := t.TempDir()
	mustWrite(t, filepath.Join(live, "a.txt"), "alpha")
	mustMkdir(t, filepath.Join(live, "sub"))
	mustWrite(t, filepath.Join(live, "sub", "b.txt"), "beta")

	sqldb := newTestDB(t)
	a := New(sqldb, nil, Config{DirectoryBatchSize: 16})
	if err := a.Start(context.Background(), []string{live}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	drainAudit(t, a)

	wantPaths := []string{
		live,
		filepath.Join(live, "a.txt"),
		filepath.Join(live, "sub"),
		filepath.Join(live, "sub", "b.txt"),
	}
	for _, p := range wantPaths {
		row, err := db.GetPath(context.Background(), sqldb, p)
		if err != nil {
			t.Errorf("missing path %q: %v", p, err)
			continue
		}
		if row.State != db.StatePresent {
			t.Errorf("path %q state = %q", p, row.State)
		}
	}
}

func TestAudit_ExcludedSubtreeNotDescended(t *testing.T) {
	live := t.TempDir()
	mustMkdir(t, filepath.Join(live, "skip"))
	mustWrite(t, filepath.Join(live, "skip", "secret.txt"), "x")
	mustWrite(t, filepath.Join(live, "ok.txt"), "y")

	skipPrefix := filepath.Join(live, "skip")
	excluder := excluderFunc(func(p string) bool {
		return strings.HasPrefix(p, skipPrefix)
	})
	sqldb := newTestDB(t)
	a := New(sqldb, excluder, Config{DirectoryBatchSize: 16})
	if err := a.Start(context.Background(), []string{live}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	drainAudit(t, a)

	if _, err := db.GetPath(context.Background(), sqldb, filepath.Join(live, "skip", "secret.txt")); err == nil {
		t.Error("excluded file was indexed")
	}
	if _, err := db.GetPath(context.Background(), sqldb, filepath.Join(live, "ok.txt")); err != nil {
		t.Errorf("included file not indexed: %v", err)
	}
}

func TestAudit_DeletionsTombstonedOnSecondPass(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reconcileDirectory uses SQL LIKE 'path/%' which assumes forward-slash paths; persistd runs in a Linux container")
	}
	live := t.TempDir()
	doomed := filepath.Join(live, "doomed.txt")
	mustWrite(t, doomed, "transient")
	mustWrite(t, filepath.Join(live, "survivor.txt"), "kept")

	sqldb := newTestDB(t)
	a := New(sqldb, nil, Config{DirectoryBatchSize: 16})
	if err := a.Start(context.Background(), []string{live}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	drainAudit(t, a)

	// Remove the live file and run a fresh audit cycle.
	if err := os.Remove(doomed); err != nil {
		t.Fatal(err)
	}
	a2 := New(sqldb, nil, Config{DirectoryBatchSize: 16})
	if err := a2.Start(context.Background(), []string{live}); err != nil {
		t.Fatalf("Start (2): %v", err)
	}
	drainAudit(t, a2)

	row, err := db.GetPath(context.Background(), sqldb, doomed)
	if err != nil {
		t.Fatalf("doomed row missing entirely: %v", err)
	}
	if row.State != db.StateRemoved {
		t.Errorf("doomed state = %q, want removed", row.State)
	}
	row, err = db.GetPath(context.Background(), sqldb, filepath.Join(live, "survivor.txt"))
	if err != nil || row.State != db.StatePresent {
		t.Errorf("survivor lost: row=%+v err=%v", row, err)
	}
}

func TestAudit_HugeDirectoryDoesNotStarveSiblings(t *testing.T) {
	live := t.TempDir()
	hot := filepath.Join(live, "hot")
	cold := filepath.Join(live, "cold")
	mustMkdir(t, hot)
	mustMkdir(t, cold)
	for i := 0; i < 60; i++ {
		mustWrite(t, filepath.Join(hot, formatName(i)), "x")
	}
	mustWrite(t, filepath.Join(cold, "lonely.txt"), "y")

	sqldb := newTestDB(t)
	// Batch size smaller than hot directory forces multiple cursor turns;
	// round-robin should reach cold before hot finishes.
	a := New(sqldb, nil, Config{DirectoryBatchSize: 8})
	if err := a.Start(context.Background(), []string{live}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	drainAudit(t, a)

	if _, err := db.GetPath(context.Background(), sqldb, filepath.Join(cold, "lonely.txt")); err != nil {
		t.Errorf("cold file never reached: %v", err)
	}
}

func TestAudit_CursorCountReportsLiveCursors(t *testing.T) {
	live := t.TempDir()
	mustMkdir(t, filepath.Join(live, "sub"))
	sqldb := newTestDB(t)
	a := New(sqldb, nil, Config{DirectoryBatchSize: 16})
	if err := a.Start(context.Background(), []string{live}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if a.CursorCount() != 1 {
		t.Errorf("initial cursor count = %d, want 1", a.CursorCount())
	}
	drainAudit(t, a)
	if a.CursorCount() != 0 {
		t.Errorf("post-drain cursor count = %d, want 0", a.CursorCount())
	}
}

type excluderFunc func(string) bool

func (f excluderFunc) Excluded(p string) bool { return f(p) }

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func formatName(i int) string {
	const hex = "0123456789abcdef"
	return string([]byte{'f', hex[(i>>4)&0xf], hex[i&0xf]})
}
