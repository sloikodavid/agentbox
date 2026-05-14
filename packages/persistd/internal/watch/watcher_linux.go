//go:build linux

package watch

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// inotifyMask is the set of events the watcher subscribes to. Picked to
// match the persistd contract: create, delete, modify, attrib, and moves.
const inotifyMask = unix.IN_CREATE | unix.IN_DELETE | unix.IN_MODIFY |
	unix.IN_ATTRIB | unix.IN_MOVED_FROM | unix.IN_MOVED_TO |
	unix.IN_DELETE_SELF | unix.IN_MOVE_SELF | unix.IN_CLOSE_WRITE |
	unix.IN_DONT_FOLLOW | unix.IN_EXCL_UNLINK

// Watcher owns the inotify file descriptor and the wd<->path tables. It is
// safe for concurrent calls to AddTree, Events, Close, and DegradedReasons.
type Watcher struct {
	fd       int
	excluder Excluder
	events   chan Event

	mu        sync.Mutex
	wdToPath  map[int32]string
	pathToWd  map[string]int32
	degraded  []string
	closed    bool
	closeOnce sync.Once
}

// New creates an inotify fd and an empty watcher. AddTree must be called to
// install watches; Run starts the read loop.
func New(excluder Excluder) (*Watcher, error) {
	if excluder == nil {
		excluder = ExcluderFunc(func(string) bool { return false })
	}
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC)
	if err != nil {
		return nil, fmt.Errorf("watch: inotify_init1: %w", err)
	}
	return &Watcher{
		fd:       fd,
		excluder: excluder,
		events:   make(chan Event, 1024),
		wdToPath: map[int32]string{},
		pathToWd: map[string]int32{},
	}, nil
}

// Events returns the channel of dirty-path candidates. The channel closes
// when the watcher is closed.
func (w *Watcher) Events() <-chan Event { return w.events }

// DegradedReasons returns a copy of the current degraded reasons. Used by
// the heartbeat writer.
func (w *Watcher) DegradedReasons() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]string, len(w.degraded))
	copy(out, w.degraded)
	return out
}

// WatchCount returns the number of installed inotify watches.
func (w *Watcher) WatchCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.wdToPath)
}

// AddTree installs a watch on root and every non-excluded directory below
// it. Errors that indicate watch-limit exhaustion mark the watcher
// degraded rather than aborting; rolling audit still covers the un-watched
// subtree.
func (w *Watcher) AddTree(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if !info.IsDir() {
			return nil
		}
		if path != root && w.excluder.Excluded(path) {
			return filepath.SkipDir
		}
		if err := w.addOne(path); err != nil {
			if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EMFILE) {
				w.markDegraded(fmt.Sprintf("watch limit hit at %s", path))
				return filepath.SkipDir
			}
			return err
		}
		return nil
	})
}

func (w *Watcher) addOne(path string) error {
	wd, err := unix.InotifyAddWatch(w.fd, path, inotifyMask)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.wdToPath[int32(wd)] = path
	w.pathToWd[path] = int32(wd)
	return nil
}

func (w *Watcher) removeOne(wd int32) {
	w.mu.Lock()
	path, ok := w.wdToPath[wd]
	if ok {
		delete(w.wdToPath, wd)
		delete(w.pathToWd, path)
	}
	w.mu.Unlock()
}

func (w *Watcher) markDegraded(reason string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, existing := range w.degraded {
		if existing == reason {
			return
		}
	}
	w.degraded = append(w.degraded, reason)
}

// Run starts the read loop and blocks until the watcher is closed or read
// returns a fatal error.
func (w *Watcher) Run() error {
	buf := make([]byte, 16*1024)
	for {
		n, err := unix.Read(w.fd, buf)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			w.mu.Lock()
			closed := w.closed
			w.mu.Unlock()
			if closed {
				return nil
			}
			return fmt.Errorf("watch: read: %w", err)
		}
		if n < unix.SizeofInotifyEvent {
			continue
		}
		w.parse(buf[:n])
	}
}

func (w *Watcher) parse(buf []byte) {
	offset := 0
	for offset+unix.SizeofInotifyEvent <= len(buf) {
		raw := (*unix.InotifyEvent)(unsafe.Pointer(&buf[offset]))
		var name string
		if raw.Len > 0 {
			nameBytes := buf[offset+unix.SizeofInotifyEvent : offset+unix.SizeofInotifyEvent+int(raw.Len)]
			if zero := indexByte(nameBytes, 0); zero >= 0 {
				nameBytes = nameBytes[:zero]
			}
			name = string(nameBytes)
		}
		offset += unix.SizeofInotifyEvent + int(raw.Len)
		w.dispatch(raw, name)
	}
}

func (w *Watcher) dispatch(raw *unix.InotifyEvent, name string) {
	if raw.Mask&unix.IN_Q_OVERFLOW != 0 {
		w.markDegraded("overflow_seen")
		w.emit(Event{Op: OpOverflow})
		return
	}
	w.mu.Lock()
	parent, ok := w.wdToPath[raw.Wd]
	w.mu.Unlock()
	if !ok {
		return
	}
	full := parent
	if name != "" {
		full = filepath.Join(parent, name)
	}
	if w.excluder.Excluded(full) {
		return
	}
	isDir := raw.Mask&unix.IN_ISDIR != 0
	op := classify(raw.Mask)

	if isDir && (op == OpCreated || op == OpMovedTo) {
		if err := w.addOne(full); err != nil {
			if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EMFILE) {
				w.markDegraded(fmt.Sprintf("watch limit hit at %s", full))
			}
		}
	}
	if raw.Mask&(unix.IN_IGNORED|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF) != 0 {
		w.removeOne(raw.Wd)
	}
	if op == OpUnknown {
		return
	}
	w.emit(Event{Path: full, Op: op, IsDir: isDir, Cookie: raw.Cookie})
}

func (w *Watcher) emit(ev Event) {
	w.mu.Lock()
	closed := w.closed
	w.mu.Unlock()
	if closed {
		return
	}
	select {
	case w.events <- ev:
	default:
		w.markDegraded("event_queue_full")
	}
}

// Close stops the read loop and releases inotify resources. The Events
// channel is intentionally not closed; the read loop simply stops emitting,
// which avoids a send-on-closed-channel race with in-flight dispatches.
func (w *Watcher) Close() error {
	var err error
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closed = true
		fd := w.fd
		w.mu.Unlock()
		err = unix.Close(fd)
	})
	return err
}

func classify(mask uint32) Op {
	switch {
	case mask&unix.IN_CREATE != 0:
		return OpCreated
	case mask&unix.IN_MOVED_TO != 0:
		return OpMovedTo
	case mask&unix.IN_MOVED_FROM != 0:
		return OpMovedFrom
	case mask&unix.IN_DELETE != 0, mask&unix.IN_DELETE_SELF != 0:
		return OpDeleted
	case mask&unix.IN_MODIFY != 0, mask&unix.IN_CLOSE_WRITE != 0:
		return OpModified
	case mask&unix.IN_ATTRIB != 0:
		return OpAttrib
	}
	return OpUnknown
}

func indexByte(b []byte, c byte) int {
	for i, v := range b {
		if v == c {
			return i
		}
	}
	return -1
}
