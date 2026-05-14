package restore

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/storage"
)

func setupPaths(t *testing.T, live string) config.Paths {
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

func seedFile(t *testing.T, paths config.Paths, livePath string, content []byte, mode int64) {
	t.Helper()
	ctx := context.Background()
	store, err := objectstore.Open(paths.Objects)
	if err != nil {
		t.Fatalf("objectstore.Open: %v", err)
	}
	tmpSrc := filepath.Join(t.TempDir(), "seed")
	if err := os.WriteFile(tmpSrc, content, 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	res, err := store.Capture(ctx, tmpSrc)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer sqldb.Close()
	tx, err := sqldb.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := db.RetainObject(ctx, tx, res.Algorithm, res.Hash, res.Size); err != nil {
		t.Fatalf("retain: %v", err)
	}
	algo := res.Algorithm
	hash := res.Hash
	size := res.Size
	if _, err := db.UpsertPath(ctx, tx, db.PathRow{
		Path: livePath, Basename: filepath.Base(livePath), State: db.StatePresent, Kind: db.KindFile,
		Mode: &mode, Size: &size, ObjectAlgorithm: &algo, ObjectHash: &hash, MetadataVersion: 1,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func seedDir(t *testing.T, paths config.Paths, livePath string, mode int64) {
	t.Helper()
	ctx := context.Background()
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer sqldb.Close()
	tx, err := sqldb.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := db.UpsertPath(ctx, tx, db.PathRow{
		Path: livePath, Basename: filepath.Base(livePath), State: db.StatePresent, Kind: db.KindDir,
		Mode: &mode, MetadataVersion: 1,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func seedSymlink(t *testing.T, paths config.Paths, livePath, target string) {
	t.Helper()
	ctx := context.Background()
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer sqldb.Close()
	tx, err := sqldb.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := db.UpsertPath(ctx, tx, db.PathRow{
		Path: livePath, Basename: filepath.Base(livePath), State: db.StatePresent, Kind: db.KindSymlink,
		SymlinkTarget: &target, MetadataVersion: 1,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func seedTombstone(t *testing.T, paths config.Paths, livePath string) {
	t.Helper()
	ctx := context.Background()
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer sqldb.Close()
	tx, err := sqldb.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := db.UpsertPath(ctx, tx, db.PathRow{
		Path: livePath, Basename: filepath.Base(livePath), State: db.StateRemoved, Kind: db.KindFile, MetadataVersion: 1,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func TestRun_CreatesDirectoriesAndFiles(t *testing.T) {
	live := t.TempDir()
	paths := setupPaths(t, live)

	dirPath := filepath.Join(live, "sub")
	filePath := filepath.Join(live, "sub", "hello.txt")
	seedDir(t, paths, dirPath, 0o755)
	seedFile(t, paths, filePath, []byte("hi"), 0o644)

	if err := Run(context.Background(), paths); err != nil {
		t.Fatalf("Run: %v", err)
	}

	info, err := os.Stat(dirPath)
	if err != nil || !info.IsDir() {
		t.Errorf("dir not restored: %v", err)
	}
	got, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if string(got) != "hi" {
		t.Errorf("content = %q, want hi", got)
	}
}

func TestRun_RestoresSymlink(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("symlink target semantics are Linux-only; persistd runs in a Linux container")
	}
	live := t.TempDir()
	paths := setupPaths(t, live)
	link := filepath.Join(live, "ln")
	seedSymlink(t, paths, link, "./target")

	if err := Run(context.Background(), paths); err != nil {
		t.Fatalf("Run: %v", err)
	}
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("readlink: %v", err)
	}
	if target != "./target" {
		t.Errorf("symlink target = %q", target)
	}
}

func TestRun_AppliesTombstones(t *testing.T) {
	live := t.TempDir()
	paths := setupPaths(t, live)
	stranded := filepath.Join(live, "stranded.txt")
	if err := os.WriteFile(stranded, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	seedTombstone(t, paths, stranded)

	if err := Run(context.Background(), paths); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := os.Stat(stranded); !os.IsNotExist(err) {
		t.Errorf("tombstone did not remove file: %v", err)
	}
}

func TestRun_FailsOnMissingObject(t *testing.T) {
	live := t.TempDir()
	paths := setupPaths(t, live)

	target := filepath.Join(live, "ghost.txt")
	seedFile(t, paths, target, []byte("ephemeral"), 0o644)

	// Wipe the captured object so restore sees a dangling reference.
	objectsRoot := filepath.Join(paths.Objects, "blake3")
	if err := filepath.Walk(objectsRoot, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return os.Remove(p)
		}
		return nil
	}); err != nil {
		t.Fatalf("walk objects: %v", err)
	}

	if err := Run(context.Background(), paths); err == nil {
		t.Error("expected error for missing object")
	}
}
