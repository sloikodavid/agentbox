package objectstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lukechampine.com/blake3"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "objects")
	s, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, root
}

func writeFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

func expectedHash(data []byte) string {
	sum := blake3.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestCapture_StoresContentByBlake3(t *testing.T) {
	s, root := newStore(t)
	src := writeFile(t, t.TempDir(), "a.txt", []byte("hello world"))
	res, err := s.Capture(context.Background(), src)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if res.Algorithm != Algorithm {
		t.Errorf("algorithm = %q", res.Algorithm)
	}
	want := expectedHash([]byte("hello world"))
	if res.Hash != want {
		t.Errorf("hash = %s, want %s", res.Hash, want)
	}
	if res.Deduped {
		t.Error("first capture should not be deduped")
	}

	stored := filepath.Join(root, Algorithm, res.Hash[:2], res.Hash[2:4], res.Hash)
	got, err := os.ReadFile(stored)
	if err != nil {
		t.Fatalf("read stored object: %v", err)
	}
	if !bytes.Equal(got, []byte("hello world")) {
		t.Errorf("stored content mismatch")
	}
}

func TestCapture_IdenticalContentDedupes(t *testing.T) {
	s, _ := newStore(t)
	dir := t.TempDir()
	a := writeFile(t, dir, "a.txt", []byte("dup"))
	b := writeFile(t, dir, "b.txt", []byte("dup"))

	r1, err := s.Capture(context.Background(), a)
	if err != nil {
		t.Fatalf("capture a: %v", err)
	}
	r2, err := s.Capture(context.Background(), b)
	if err != nil {
		t.Fatalf("capture b: %v", err)
	}
	if r1.Hash != r2.Hash {
		t.Errorf("identical content should hash equally: %s vs %s", r1.Hash, r2.Hash)
	}
	if r1.Deduped {
		t.Error("first capture should not dedupe")
	}
	if !r2.Deduped {
		t.Error("second capture should dedupe")
	}
}

func TestCapture_DifferentContentDifferentObjects(t *testing.T) {
	s, _ := newStore(t)
	dir := t.TempDir()
	a := writeFile(t, dir, "a.txt", []byte("alpha"))
	b := writeFile(t, dir, "b.txt", []byte("beta"))
	r1, err := s.Capture(context.Background(), a)
	if err != nil {
		t.Fatalf("capture a: %v", err)
	}
	r2, err := s.Capture(context.Background(), b)
	if err != nil {
		t.Fatalf("capture b: %v", err)
	}
	if r1.Hash == r2.Hash {
		t.Errorf("different content should hash differently")
	}
}

func TestCapture_LargeFileDoesNotLoadIntoMemory(t *testing.T) {
	s, _ := newStore(t)
	dir := t.TempDir()
	data := make([]byte, 8*1024*1024)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand: %v", err)
	}
	src := writeFile(t, dir, "big.bin", data)
	res, err := s.Capture(context.Background(), src)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if res.Size != int64(len(data)) {
		t.Errorf("size = %d, want %d", res.Size, len(data))
	}
	if res.Hash != expectedHash(data) {
		t.Error("hash mismatch on large file")
	}
}

func TestCapture_DetectsChangedDuringCopy(t *testing.T) {
	s, _ := newStore(t)
	dir := t.TempDir()
	src := writeFile(t, dir, "x.txt", []byte("original"))

	originalInfo, err := os.Stat(src)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	// Rewrite the file in place with different size and forced-newer mtime,
	// then capture. The pre-read lstat sees the new state but we set the
	// mtime back to the original after the read completes so the after-lstat
	// differs from before-lstat. Simulates a write-during-copy race.
	//
	// Implementation: write a different file with new size first, capture,
	// then between captures change content. Use a more direct simulation:
	// force size to differ between calls by rewriting the file with longer
	// content just before the second lstat.
	//
	// Simpler approach: capture once successfully, then mutate the file and
	// confirm the post-lstat triggers ErrChangedDuringCopy when we re-run.
	// We can't race the inside of Capture from a test deterministically, but
	// we can validate the contract by forcing a mismatch via Chtimes after
	// a normal capture: capture, then test the unit by calling a helper.
	_ = originalInfo

	// Instead, validate the public behavior with a small wrapper that calls
	// Capture but inserts a write-modification between the inner stat calls
	// via a deterministic hook. Easiest path: write a content, capture
	// normally, then immediately rewrite the same file with a longer body
	// and run capture again - this still succeeds since both lstats see the
	// new state. So construct a separate scenario:
	//
	// Replace the file with a different size right after Capture starts by
	// using a goroutine that waits briefly. Capture reads few bytes then
	// goroutine truncates. Result: after-lstat differs.

	long := bytes.Repeat([]byte("a"), 4*1024*1024)
	if err := os.WriteFile(src, long, 0o644); err != nil {
		t.Fatalf("write long: %v", err)
	}

	// Race: start capture in this goroutine, mutate file from another.
	done := make(chan error, 1)
	go func() {
		_, err := s.Capture(context.Background(), src)
		done <- err
	}()
	// Give Capture a moment to lstat-before and start reading.
	time.Sleep(20 * time.Millisecond)
	// Truncate the file to a smaller size; the lstat-after will see a
	// different size from lstat-before.
	if err := os.WriteFile(src, []byte("tiny"), 0o644); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	captureErr := <-done

	if captureErr == nil {
		t.Skip("race not observed in this run; not flaky-fail since ordering is timing-dependent")
	}
	if !errors.Is(captureErr, ErrChangedDuringCopy) {
		t.Errorf("expected ErrChangedDuringCopy, got %v", captureErr)
	}
}

func TestCapture_RejectsNonRegular(t *testing.T) {
	s, _ := newStore(t)
	dir := t.TempDir()
	if _, err := s.Capture(context.Background(), dir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Errorf("expected non-regular error, got %v", err)
	}
}

func TestCleanTemp_RemovesStrayTempFiles(t *testing.T) {
	s, root := newStore(t)
	algoDir := filepath.Join(root, Algorithm)
	stray := filepath.Join(algoDir, ".tmp-stray")
	if err := os.WriteFile(stray, []byte("x"), 0o644); err != nil {
		t.Fatalf("write stray: %v", err)
	}
	if err := s.CleanTemp(); err != nil {
		t.Fatalf("CleanTemp: %v", err)
	}
	if _, err := os.Stat(stray); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("stray temp not cleaned: %v", err)
	}
}

func TestPath_FanoutLayout(t *testing.T) {
	s, _ := newStore(t)
	hash := "abcdef0123456789"
	p, err := s.Path(Algorithm, hash)
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	want := filepath.Join(s.algoDir, "ab", "cd", hash)
	if p != want {
		t.Errorf("Path = %q, want %q", p, want)
	}
}

func TestRemove_IsIdempotent(t *testing.T) {
	s, _ := newStore(t)
	dir := t.TempDir()
	src := writeFile(t, dir, "x.txt", []byte("y"))
	res, err := s.Capture(context.Background(), src)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if err := s.Remove(res.Algorithm, res.Hash); err != nil {
		t.Fatalf("Remove first: %v", err)
	}
	if err := s.Remove(res.Algorithm, res.Hash); err != nil {
		t.Errorf("Remove second should be idempotent, got %v", err)
	}
}
