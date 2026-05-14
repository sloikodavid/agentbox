// Package watch is the raw Linux inotify watcher persistd uses to detect
// live filesystem changes. The watcher is intentionally lower-level than
// fsnotify because the scheduler/audit design needs access to overflow,
// move cookies, and watch-limit signals that abstractions hide.
package watch

// Op enumerates the watcher-event kinds the rest of persistd consumes.
type Op int

const (
	OpUnknown Op = iota
	OpCreated
	OpModified
	OpDeleted
	OpAttrib
	OpMovedFrom
	OpMovedTo
	OpOverflow
)

// String renders Op for logging.
func (o Op) String() string {
	switch o {
	case OpCreated:
		return "created"
	case OpModified:
		return "modified"
	case OpDeleted:
		return "deleted"
	case OpAttrib:
		return "attrib"
	case OpMovedFrom:
		return "moved_from"
	case OpMovedTo:
		return "moved_to"
	case OpOverflow:
		return "overflow"
	}
	return "unknown"
}

// Event is a single filesystem-change candidate produced by the watcher.
// Path is the absolute live path; for OpOverflow it is empty.
type Event struct {
	Path  string
	Op    Op
	IsDir bool
	// Cookie groups MovedFrom/MovedTo pairs so the scheduler can detect
	// renames within the watched tree.
	Cookie uint32
}

// Excluder decides whether an absolute path should be skipped. The
// watcher does not walk excluded directories.
type Excluder interface {
	Excluded(absPath string) bool
}

// ExcluderFunc adapts a function to the Excluder interface.
type ExcluderFunc func(absPath string) bool

// Excluded reports whether path is excluded.
func (f ExcluderFunc) Excluded(path string) bool { return f(path) }
