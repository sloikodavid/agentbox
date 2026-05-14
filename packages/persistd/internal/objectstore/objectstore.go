// Package objectstore writes regular file contents into the durable
// BLAKE3-addressed object store under /data/persistence/objects/blake3.
// Captured objects are immutable; identical content dedupes to one file.
package objectstore

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"lukechampine.com/blake3"
)

// Algorithm is the fixed hash algorithm used as the object-store
// subdirectory name. Identity-tied to the on-disk layout.
const Algorithm = "blake3"

// FanoutDepth is the number of two-hex-char directory levels used to fan
// out the hash space so no single directory holds the entire store.
const FanoutDepth = 2

// ErrChangedDuringCopy is returned by Capture when an lstat after the read
// indicates the source file was modified mid-stream. The caller should
// requeue the path.
var ErrChangedDuringCopy = errors.New("objectstore: source changed during copy")

// Store is a handle to one on-disk object store rooted at a directory.
type Store struct {
	root    string
	algoDir string
}

// CaptureResult describes the outcome of capturing one source file.
type CaptureResult struct {
	Algorithm string
	Hash      string
	Size      int64
	// Deduped is true when the object was already in the store and the
	// temp file we wrote was discarded.
	Deduped bool
}

// Open returns a Store rooted at objectsRoot. The "blake3" subdirectory is
// created lazily; callers should typically have already called
// storage.Init for the full layout.
func Open(objectsRoot string) (*Store, error) {
	algoDir := filepath.Join(objectsRoot, Algorithm)
	if err := os.MkdirAll(algoDir, 0o755); err != nil {
		return nil, fmt.Errorf("objectstore: create %s: %w", algoDir, err)
	}
	return &Store{root: objectsRoot, algoDir: algoDir}, nil
}

// AlgorithmDir returns the absolute directory holding all objects for
// the configured algorithm (e.g. .../objects/blake3).
func (s *Store) AlgorithmDir() string { return s.algoDir }

// Path returns the absolute on-disk path for an object identified by
// (algorithm, hash). The file may or may not exist.
func (s *Store) Path(algorithm, hash string) (string, error) {
	if algorithm != Algorithm {
		return "", fmt.Errorf("objectstore: unsupported algorithm %q", algorithm)
	}
	if len(hash) < FanoutDepth*2 {
		return "", fmt.Errorf("objectstore: hash %q too short", hash)
	}
	parts := []string{s.algoDir}
	for i := 0; i < FanoutDepth; i++ {
		parts = append(parts, hash[i*2:i*2+2])
	}
	parts = append(parts, hash)
	return filepath.Join(parts...), nil
}

// Has reports whether the (algorithm, hash) object already exists on disk.
func (s *Store) Has(algorithm, hash string) (bool, error) {
	p, err := s.Path(algorithm, hash)
	if err != nil {
		return false, err
	}
	_, err = os.Lstat(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// Capture streams src into the object store. If the source file is modified
// between the pre-read and post-read lstat, returns ErrChangedDuringCopy.
// The temp file is removed on any error path so the store never accumulates
// partial objects from this call.
func (s *Store) Capture(ctx context.Context, src string) (CaptureResult, error) {
	beforeInfo, err := os.Lstat(src)
	if err != nil {
		return CaptureResult{}, fmt.Errorf("objectstore: lstat before %s: %w", src, err)
	}
	if !beforeInfo.Mode().IsRegular() {
		return CaptureResult{}, fmt.Errorf("objectstore: %s is not a regular file", src)
	}

	temp, err := os.CreateTemp(s.algoDir, ".tmp-*")
	if err != nil {
		return CaptureResult{}, fmt.Errorf("objectstore: create temp: %w", err)
	}
	tempPath := temp.Name()
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			_ = os.Remove(tempPath)
		}
	}()

	hasher := blake3.New(32, nil)
	source, err := os.Open(src)
	if err != nil {
		_ = temp.Close()
		return CaptureResult{}, fmt.Errorf("objectstore: open %s: %w", src, err)
	}

	written, copyErr := io.Copy(io.MultiWriter(temp, hasher), readerWithCtx{ctx: ctx, r: source})
	_ = source.Close()
	if copyErr != nil {
		_ = temp.Close()
		return CaptureResult{}, fmt.Errorf("objectstore: stream %s: %w", src, copyErr)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return CaptureResult{}, fmt.Errorf("objectstore: sync temp: %w", err)
	}
	if err := temp.Close(); err != nil {
		return CaptureResult{}, fmt.Errorf("objectstore: close temp: %w", err)
	}

	afterInfo, err := os.Lstat(src)
	if err != nil {
		return CaptureResult{}, fmt.Errorf("objectstore: lstat after %s: %w", src, err)
	}
	if afterInfo.Size() != beforeInfo.Size() || !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		return CaptureResult{}, ErrChangedDuringCopy
	}
	if written != beforeInfo.Size() {
		return CaptureResult{}, ErrChangedDuringCopy
	}

	hash := hex.EncodeToString(hasher.Sum(nil))
	finalPath, err := s.Path(Algorithm, hash)
	if err != nil {
		return CaptureResult{}, err
	}

	exists, err := s.Has(Algorithm, hash)
	if err != nil {
		return CaptureResult{}, err
	}
	if exists {
		return CaptureResult{Algorithm: Algorithm, Hash: hash, Size: written, Deduped: true}, nil
	}

	if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
		return CaptureResult{}, fmt.Errorf("objectstore: create object dir: %w", err)
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		if alreadyThere, _ := s.Has(Algorithm, hash); alreadyThere {
			return CaptureResult{Algorithm: Algorithm, Hash: hash, Size: written, Deduped: true}, nil
		}
		return CaptureResult{}, fmt.Errorf("objectstore: rename into store: %w", err)
	}
	cleanupTemp = false
	return CaptureResult{Algorithm: Algorithm, Hash: hash, Size: written, Deduped: false}, nil
}

// Remove deletes an object file from the store. Used by the GC after the
// SQLite ref_count has reached zero and the row has been transitioned.
func (s *Store) Remove(algorithm, hash string) error {
	p, err := s.Path(algorithm, hash)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("objectstore: remove %s/%s: %w", algorithm, hash, err)
	}
	return nil
}

// CleanTemp removes any stray .tmp-* files left over from a previous run.
// Safe to call at startup before the daemon begins issuing captures.
func (s *Store) CleanTemp() error {
	entries, err := os.ReadDir(s.algoDir)
	if err != nil {
		return fmt.Errorf("objectstore: scan temps: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if len(name) >= 5 && name[:5] == ".tmp-" {
			_ = os.Remove(filepath.Join(s.algoDir, name))
		}
	}
	return nil
}

type readerWithCtx struct {
	ctx context.Context
	r   io.Reader
}

func (r readerWithCtx) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}
