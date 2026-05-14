package check

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/storage"
)

func setupPaths(t *testing.T) config.Paths {
	t.Helper()
	root := t.TempDir()
	p := config.Paths{
		Volume:    root,
		Config:    filepath.Join(root, "persistence", "config.json"),
		DB:        filepath.Join(root, "persistence", "db.sqlite"),
		Objects:   filepath.Join(root, "persistence", "objects"),
		Heartbeat: filepath.Join(root, "run", "persistd.ready"),
	}
	if err := storage.Init(p); err != nil {
		t.Fatalf("storage.Init: %v", err)
	}
	return p
}

func TestRun_CleanInstall(t *testing.T) {
	paths := setupPaths(t)
	r, err := Run(context.Background(), paths)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if r.HasFatal() {
		t.Errorf("fresh install should not have fatal findings: %+v", r.Findings)
	}
}

func TestRun_DetectsMissingObject(t *testing.T) {
	paths := setupPaths(t)
	ctx := context.Background()
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := sqldb.Begin()
	algo := "blake3"
	hash := "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	if err := db.RetainObject(ctx, tx, algo, hash, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := db.UpsertPath(ctx, tx, db.PathRow{
		Path: "/ghost", Basename: "ghost", State: db.StatePresent, Kind: db.KindFile,
		ObjectAlgorithm: &algo, ObjectHash: &hash, MetadataVersion: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	_ = sqldb.Close()

	r, err := Run(ctx, paths)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !r.HasFatal() {
		t.Errorf("expected fatal finding for missing object, got %+v", r.Findings)
	}
	found := false
	for _, f := range r.Findings {
		if f.Check == "objects_referenced_exist" && f.Severity == Fatal {
			found = true
		}
	}
	if !found {
		t.Errorf("missing object finding not surfaced: %+v", r.Findings)
	}
}

func TestRun_DetectsDanglingParent(t *testing.T) {
	paths := setupPaths(t)
	ctx := context.Background()
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate disk corruption by inserting with foreign keys disabled.
	// Production code keeps FKs on so this state cannot occur normally,
	// but `persistd check` exists for cases where it has happened anyway.
	if _, err := sqldb.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatal(err)
	}
	if _, err := sqldb.ExecContext(ctx,
		`INSERT INTO paths(path, parent_path_id, basename, state, kind, metadata_version) VALUES (?, 9999, ?, 'present', 'file', 1)`,
		"/orphan", "orphan",
	); err != nil {
		t.Fatal(err)
	}
	_ = sqldb.Close()

	r, err := Run(ctx, paths)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !r.HasFatal() {
		t.Errorf("expected fatal finding for dangling parent, got %+v", r.Findings)
	}
}

func TestWalkOrphans_DetectsExtraFile(t *testing.T) {
	paths := setupPaths(t)
	ctx := context.Background()
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		t.Fatal(err)
	}
	defer sqldb.Close()
	store, err := objectstore.Open(paths.Objects)
	if err != nil {
		t.Fatal(err)
	}

	// Plant a file in the store that the DB doesn't know about.
	algoDir := filepath.Join(paths.Objects, objectstore.Algorithm)
	dir := filepath.Join(algoDir, "ab", "cd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	orphanHash := "abcdfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed"
	if err := os.WriteFile(filepath.Join(dir, orphanHash), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	r := &Report{}
	if err := WalkOrphans(ctx, sqldb, store, r); err != nil {
		t.Fatalf("WalkOrphans: %v", err)
	}
	found := false
	for _, f := range r.Findings {
		if f.Check == "orphan_object_files" {
			found = true
		}
	}
	if !found {
		t.Errorf("orphan not detected: %+v", r.Findings)
	}
}
