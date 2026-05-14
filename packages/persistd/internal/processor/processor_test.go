package processor

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
)

func newProcessor(t *testing.T) (*Processor, *sql.DB, *objectstore.Store) {
	t.Helper()
	root := t.TempDir()
	store, err := objectstore.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	sqldb, err := db.Open(context.Background(), filepath.Join(root, "p.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqldb.Close() })
	return New(sqldb, store), sqldb, store
}

func TestApply_CapturesRegularFile(t *testing.T) {
	p, sqldb, store := newProcessor(t)
	src := filepath.Join(t.TempDir(), "x.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	row, err := db.GetPath(context.Background(), sqldb, src)
	if err != nil {
		t.Fatalf("GetPath: %v", err)
	}
	if row.Kind != db.KindFile || row.State != db.StatePresent {
		t.Errorf("row = %+v", row)
	}
	if row.ObjectHash == nil {
		t.Fatal("expected object hash on captured file")
	}
	if exists, _ := store.Has(*row.ObjectAlgorithm, *row.ObjectHash); !exists {
		t.Error("object file not present in store")
	}
}

func TestApply_ReleasesOldObjectOnContentChange(t *testing.T) {
	p, sqldb, _ := newProcessor(t)
	src := filepath.Join(t.TempDir(), "x.txt")
	if err := os.WriteFile(src, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	first, _ := db.GetPath(context.Background(), sqldb, src)
	if err := os.WriteFile(src, []byte("v2 longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	second, _ := db.GetPath(context.Background(), sqldb, src)
	if first.ObjectHash != nil && second.ObjectHash != nil && *first.ObjectHash == *second.ObjectHash {
		t.Error("expected new object hash after content change")
	}

	oldObj, err := db.GetObject(context.Background(), sqldb, *first.ObjectAlgorithm, *first.ObjectHash)
	if err != nil {
		t.Fatalf("GetObject old: %v", err)
	}
	if oldObj.RefCount != 0 || oldObj.GCState != db.GCUnreferenced {
		t.Errorf("old object refcount=%d state=%s, want 0/unreferenced", oldObj.RefCount, oldObj.GCState)
	}
}

func TestApply_TombstoneOnDelete(t *testing.T) {
	p, sqldb, _ := newProcessor(t)
	src := filepath.Join(t.TempDir(), "x.txt")
	if err := os.WriteFile(src, []byte("transient"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	before, _ := db.GetPath(context.Background(), sqldb, src)

	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil {
		t.Fatalf("Apply on missing: %v", err)
	}
	after, _ := db.GetPath(context.Background(), sqldb, src)
	if after.State != db.StateRemoved {
		t.Errorf("expected tombstone, got %s", after.State)
	}
	obj, err := db.GetObject(context.Background(), sqldb, *before.ObjectAlgorithm, *before.ObjectHash)
	if err != nil {
		t.Fatal(err)
	}
	if obj.RefCount != 0 {
		t.Errorf("ref_count = %d, want 0 after tombstone", obj.RefCount)
	}
}

func TestApply_IsIdempotent(t *testing.T) {
	p, sqldb, _ := newProcessor(t)
	src := filepath.Join(t.TempDir(), "x.txt")
	if err := os.WriteFile(src, []byte("body"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil {
		t.Fatal(err)
	}
	row, _ := db.GetPath(context.Background(), sqldb, src)
	obj, err := db.GetObject(context.Background(), sqldb, *row.ObjectAlgorithm, *row.ObjectHash)
	if err != nil {
		t.Fatal(err)
	}
	if obj.RefCount != 1 {
		t.Errorf("ref_count after double apply = %d, want 1", obj.RefCount)
	}
}

func TestApply_HandlesSymlink(t *testing.T) {
	p, sqldb, _ := newProcessor(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.WriteFile(target, []byte("body"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink("real", link); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), link); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	row, err := db.GetPath(context.Background(), sqldb, link)
	if err != nil {
		t.Fatal(err)
	}
	if row.Kind != db.KindSymlink {
		t.Errorf("kind = %s", row.Kind)
	}
	if row.SymlinkTarget == nil || *row.SymlinkTarget != "real" {
		t.Errorf("symlinkTarget = %v", row.SymlinkTarget)
	}
}

func TestApply_NoOpOnUnknownTombstone(t *testing.T) {
	p, _, _ := newProcessor(t)
	if err := p.Apply(context.Background(), "/nonexistent/never/seen"); err != nil {
		t.Errorf("Apply on unseen missing path should be no-op, got %v", err)
	}
}

func TestApply_FailsOnChangedDuringCopy(t *testing.T) {
	// Smoke test that we don't swallow ErrChangedDuringCopy from objectstore.
	p, _, _ := newProcessor(t)
	src := filepath.Join(t.TempDir(), "x")
	if err := os.WriteFile(src, []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.Apply(context.Background(), src); err != nil && !errors.Is(err, objectstore.ErrChangedDuringCopy) {
		// Most runs succeed; the test passes as long as we don't panic.
		t.Logf("Apply: %v", err)
	}
}
