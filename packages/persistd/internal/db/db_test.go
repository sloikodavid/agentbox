package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := Open(context.Background(), filepath.Join(dir, "test.sqlite"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestOpen_AppliesMigrations(t *testing.T) {
	db := openTestDB(t)
	var version int
	if err := db.QueryRow(`SELECT MAX(version) FROM schema_info`).Scan(&version); err != nil {
		t.Fatalf("query schema_info: %v", err)
	}
	if version < 1 {
		t.Fatalf("expected at least one migration applied, got version %d", version)
	}
}

func TestOpen_IsIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.sqlite")
	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	_ = db.Close()
	db2, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer db2.Close()
	var count int
	if err := db2.QueryRow(`SELECT COUNT(*) FROM schema_info`).Scan(&count); err != nil {
		t.Fatalf("count schema_info: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 schema_info row, got %d", count)
	}
}

func mustBegin(t *testing.T, db *sql.DB) *sql.Tx {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	return tx
}

func TestUpsertPath_RoundTrip(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	tx := mustBegin(t, db)
	row := PathRow{
		Path:            "/home/user/x",
		Basename:        "x",
		State:           StatePresent,
		Kind:            KindFile,
		MetadataVersion: 1,
	}
	saved, err := UpsertPath(ctx, tx, row)
	if err != nil {
		t.Fatalf("UpsertPath: %v", err)
	}
	if saved.ID == 0 {
		t.Fatal("expected non-zero path_id")
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	got, err := GetPath(ctx, db, "/home/user/x")
	if err != nil {
		t.Fatalf("GetPath: %v", err)
	}
	if got.State != StatePresent || got.Kind != KindFile || got.Basename != "x" {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestUpsertPath_ReplacesCurrentState(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	tx := mustBegin(t, db)
	if _, err := UpsertPath(ctx, tx, PathRow{Path: "/a", Basename: "a", State: StatePresent, Kind: KindFile, MetadataVersion: 1}); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	size := int64(99)
	if _, err := UpsertPath(ctx, tx, PathRow{Path: "/a", Basename: "a", State: StatePresent, Kind: KindFile, Size: &size, MetadataVersion: 2}); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	got, err := GetPath(ctx, db, "/a")
	if err != nil {
		t.Fatalf("GetPath: %v", err)
	}
	if got.Size == nil || *got.Size != 99 {
		t.Errorf("expected size=99, got %+v", got.Size)
	}
	if got.MetadataVersion != 2 {
		t.Errorf("expected metadata_version=2, got %d", got.MetadataVersion)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM paths WHERE path='/a'`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("expected exactly one current-state row, got %d", count)
	}
}

func TestMarkRemoved_ProducesTombstone(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	tx := mustBegin(t, db)
	algo := "blake3"
	hash := "deadbeef"
	if err := RetainObject(ctx, tx, algo, hash, 10); err != nil {
		t.Fatalf("RetainObject: %v", err)
	}
	if _, err := UpsertPath(ctx, tx, PathRow{
		Path: "/file", Basename: "file", State: StatePresent, Kind: KindFile,
		ObjectAlgorithm: &algo, ObjectHash: &hash, MetadataVersion: 1,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := MarkRemoved(ctx, tx, "/file"); err != nil {
		t.Fatalf("MarkRemoved: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	got, err := GetPath(ctx, db, "/file")
	if err != nil {
		t.Fatalf("GetPath: %v", err)
	}
	if got.State != StateRemoved {
		t.Errorf("state = %q, want removed", got.State)
	}
	if got.ObjectHash != nil {
		t.Errorf("object_hash should be NULL on tombstone, got %v", *got.ObjectHash)
	}
}

func TestMarkRemoved_UnknownPath(t *testing.T) {
	db := openTestDB(t)
	tx := mustBegin(t, db)
	err := MarkRemoved(context.Background(), tx, "/nope")
	_ = tx.Rollback()
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected ErrNoRows, got %v", err)
	}
}

func TestRetainAndReleaseObject(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	algo := "blake3"
	hash := "abc123"

	tx := mustBegin(t, db)
	if err := RetainObject(ctx, tx, algo, hash, 1024); err != nil {
		t.Fatalf("retain 1: %v", err)
	}
	if err := RetainObject(ctx, tx, algo, hash, 1024); err != nil {
		t.Fatalf("retain 2: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	got, err := GetObject(ctx, db, algo, hash)
	if err != nil {
		t.Fatalf("GetObject: %v", err)
	}
	if got.RefCount != 2 || got.GCState != GCLive {
		t.Errorf("after 2 retains: ref_count=%d state=%s", got.RefCount, got.GCState)
	}

	tx = mustBegin(t, db)
	if err := ReleaseObject(ctx, tx, algo, hash); err != nil {
		t.Fatalf("release 1: %v", err)
	}
	if err := ReleaseObject(ctx, tx, algo, hash); err != nil {
		t.Fatalf("release 2: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	got, err = GetObject(ctx, db, algo, hash)
	if err != nil {
		t.Fatalf("GetObject after release: %v", err)
	}
	if got.RefCount != 0 || got.GCState != GCUnreferenced {
		t.Errorf("after 2 releases: ref_count=%d state=%s, want 0/unreferenced", got.RefCount, got.GCState)
	}
}

func TestRetainObject_SizeMismatch(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	tx := mustBegin(t, db)
	if err := RetainObject(ctx, tx, "blake3", "h", 10); err != nil {
		t.Fatalf("retain: %v", err)
	}
	if err := RetainObject(ctx, tx, "blake3", "h", 11); err == nil {
		t.Error("expected size-mismatch error")
	}
	_ = tx.Rollback()
}

func TestTransactionAtomicity(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	tx := mustBegin(t, db)
	if _, err := UpsertPath(ctx, tx, PathRow{Path: "/rolled", Basename: "rolled", State: StatePresent, Kind: KindFile, MetadataVersion: 1}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	_, err := GetPath(ctx, db, "/rolled")
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expected ErrNoRows after rollback, got %v", err)
	}
}
