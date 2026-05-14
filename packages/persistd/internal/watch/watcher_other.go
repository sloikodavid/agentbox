//go:build !linux

package watch

import "errors"

// Watcher is a non-functional stub on non-Linux platforms. persistd runs
// in a Linux container in production; the stub exists so the package
// compiles for local dev and tooling on macOS and Windows.
type Watcher struct{}

// ErrUnsupported is returned by all Watcher methods on non-Linux builds.
var ErrUnsupported = errors.New("watch: inotify is Linux-only")

// New always returns ErrUnsupported on non-Linux builds.
func New(_ Excluder) (*Watcher, error) { return nil, ErrUnsupported }

// Events returns a closed channel so callers do not block.
func (w *Watcher) Events() <-chan Event {
	ch := make(chan Event)
	close(ch)
	return ch
}

// DegradedReasons returns the single reason "unsupported_platform".
func (w *Watcher) DegradedReasons() []string { return []string{"unsupported_platform"} }

// WatchCount always reports zero on non-Linux builds.
func (w *Watcher) WatchCount() int { return 0 }

// AddTree is a no-op stub.
func (w *Watcher) AddTree(string) error { return ErrUnsupported }

// Run is a no-op stub.
func (w *Watcher) Run() error { return ErrUnsupported }

// Close is a no-op stub.
func (w *Watcher) Close() error { return nil }
