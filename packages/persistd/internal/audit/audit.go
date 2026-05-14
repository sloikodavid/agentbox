// Package audit implements the rolling filesystem audit. It walks every
// included live path eventually using a fair multi-cursor scheme so that
// huge subtrees do not starve siblings, and detects deletions by
// per-directory audit epochs rather than full snapshots.
package audit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/scheduler"
)

// Excluder reuses the watch package's interface shape so the same
// /data/persistence/config.json exclude list drives both.
type Excluder interface {
	Excluded(absPath string) bool
}

// Auditor implements scheduler.Source and walks the included live tree
// via multiple round-robin cursors.
type Auditor struct {
	sqldb     *sql.DB
	excluder  Excluder
	batchSize int
	priority  int

	mu      sync.Mutex
	cursors []*cursor
	next    int
}

// Config holds the per-tick audit tunables; mirrors the audit section of
// /data/persistence/config.json.
type Config struct {
	DirectoryBatchSize int
	Priority           int
}

// New constructs an Auditor backed by sqldb. Roots are not registered
// until Start is called.
func New(sqldb *sql.DB, excluder Excluder, cfg Config) *Auditor {
	if excluder == nil {
		excluder = noExcluder{}
	}
	if cfg.DirectoryBatchSize <= 0 {
		cfg.DirectoryBatchSize = 256
	}
	if cfg.Priority == 0 {
		cfg.Priority = 100
	}
	return &Auditor{
		sqldb:     sqldb,
		excluder:  excluder,
		batchSize: cfg.DirectoryBatchSize,
		priority:  cfg.Priority,
	}
}

// Name implements scheduler.Source.
func (a *Auditor) Name() string { return "audit" }

// Priority implements scheduler.Source.
func (a *Auditor) Priority() int { return a.priority }

// CursorCount returns the live cursor count for status reporting.
func (a *Auditor) CursorCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.cursors)
}

// Start registers the audit roots in the DB and creates root-level cursors.
// Safe to call on a fresh DB or after a previous run; existing audit_roots
// rows with matching paths are reused.
func (a *Auditor) Start(ctx context.Context, roots []string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	for _, root := range roots {
		if a.excluder.Excluded(root) {
			continue
		}
		rootID, err := a.upsertRoot(ctx, root)
		if err != nil {
			return err
		}
		cur := &cursor{
			rootID:       rootID,
			path:         root,
			auditStartNs: time.Now().UnixNano(),
		}
		if err := a.persistCursor(ctx, cur); err != nil {
			return err
		}
		a.cursors = append(a.cursors, cur)
	}
	return nil
}

func (a *Auditor) upsertRoot(ctx context.Context, path string) (int64, error) {
	_, err := a.sqldb.ExecContext(ctx,
		`INSERT OR IGNORE INTO audit_roots(path, created_at_ns) VALUES (?, ?)`,
		path, time.Now().UnixNano(),
	)
	if err != nil {
		return 0, fmt.Errorf("audit: upsert root %s: %w", path, err)
	}
	var id int64
	err = a.sqldb.QueryRowContext(ctx, `SELECT root_id FROM audit_roots WHERE path=?`, path).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("audit: lookup root %s: %w", path, err)
	}
	return id, nil
}

func (a *Auditor) persistCursor(ctx context.Context, c *cursor) error {
	res, err := a.sqldb.ExecContext(ctx,
		`INSERT INTO audit_cursors(root_id, parent_cursor_id, path, state, last_progress_at_ns) VALUES (?, NULL, ?, 'active', ?)`,
		c.rootID, c.path, time.Now().UnixNano(),
	)
	if err != nil {
		return fmt.Errorf("audit: persist cursor %s: %w", c.path, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	c.cursorID = id
	return nil
}

func (a *Auditor) deleteCursor(ctx context.Context, c *cursor) {
	_, _ = a.sqldb.ExecContext(ctx, `DELETE FROM audit_cursors WHERE cursor_id=?`, c.cursorID)
}

// RunOne processes one directory batch from the next cursor in the
// round-robin. Returns more=true when forward progress was made and work
// remains; more=false on idle or budget-starved.
func (a *Auditor) RunOne(ctx context.Context, budget *scheduler.Budget) (bool, error) {
	a.mu.Lock()
	if len(a.cursors) == 0 {
		a.mu.Unlock()
		return false, nil
	}
	if !budget.FsOps.TryTake(1) {
		a.mu.Unlock()
		return false, nil
	}
	cur := a.cursors[a.next]
	a.next = (a.next + 1) % len(a.cursors)
	a.mu.Unlock()

	finished, err := a.stepCursor(ctx, cur)
	if err != nil {
		return false, err
	}
	if finished {
		a.removeCursor(ctx, cur)
	}
	return a.CursorCount() > 0, nil
}

func (a *Auditor) removeCursor(ctx context.Context, target *cursor) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i, c := range a.cursors {
		if c == target {
			if c.dir != nil {
				_ = c.dir.Close()
			}
			a.cursors = append(a.cursors[:i], a.cursors[i+1:]...)
			if a.next >= len(a.cursors) && len(a.cursors) > 0 {
				a.next = 0
			}
			break
		}
	}
	a.deleteCursor(ctx, target)
}

// stepCursor reads the next batch of children of cur.path, upserts their
// rows, schedules child cursors for subdirectories, and on completion
// reconciles the parent's children against the audit epoch to tombstone
// rows that were not seen.
func (a *Auditor) stepCursor(ctx context.Context, cur *cursor) (finished bool, err error) {
	if cur.dir == nil {
		if err := a.openDir(ctx, cur); err != nil {
			return true, err
		}
	}
	names, err := cur.dir.Readdirnames(a.batchSize)
	for _, name := range names {
		childPath := filepath.Join(cur.path, name)
		if a.excluder.Excluded(childPath) {
			continue
		}
		if err := a.upsertChild(ctx, cur, childPath); err != nil {
			return false, err
		}
	}
	if errors.Is(err, io.EOF) || len(names) < a.batchSize {
		// Directory exhausted; reconcile deletions.
		if recErr := a.reconcileDirectory(ctx, cur); recErr != nil {
			return true, recErr
		}
		return true, nil
	}
	if err != nil {
		return true, fmt.Errorf("audit: readdir %s: %w", cur.path, err)
	}
	return false, nil
}

func (a *Auditor) openDir(ctx context.Context, cur *cursor) error {
	info, err := os.Lstat(cur.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("audit: lstat %s: %w", cur.path, err)
	}
	// Upsert the cursor's own path row before descending.
	parentRow := db.PathRow{
		Path:            cur.path,
		Basename:        filepath.Base(cur.path),
		State:           db.StatePresent,
		Kind:            db.KindDir,
		MetadataVersion: 1,
	}
	mode := int64(info.Mode().Perm())
	parentRow.Mode = &mode
	mtime := info.ModTime().UnixNano()
	parentRow.MtimeNs = &mtime
	now := time.Now().UnixNano()
	parentRow.LastAuditedAtNs = &now
	if err := a.upsertInTx(ctx, parentRow); err != nil {
		return err
	}
	dir, err := os.Open(cur.path)
	if err != nil {
		return fmt.Errorf("audit: open %s: %w", cur.path, err)
	}
	cur.dir = dir
	cur.auditStartNs = time.Now().UnixNano()
	return nil
}

func (a *Auditor) upsertChild(ctx context.Context, cur *cursor, childPath string) error {
	info, err := os.Lstat(childPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("audit: lstat %s: %w", childPath, err)
	}
	row := db.PathRow{
		Path:            childPath,
		Basename:        filepath.Base(childPath),
		State:           db.StatePresent,
		Kind:            classifyKind(info),
		MetadataVersion: 1,
	}
	mode := int64(info.Mode().Perm())
	row.Mode = &mode
	if info.Mode().IsRegular() {
		size := info.Size()
		row.Size = &size
	}
	if info.Mode()&os.ModeSymlink != 0 {
		if target, err := os.Readlink(childPath); err == nil {
			row.SymlinkTarget = &target
		}
	}
	mtime := info.ModTime().UnixNano()
	row.MtimeNs = &mtime
	now := time.Now().UnixNano()
	row.LastAuditedAtNs = &now
	if err := a.upsertInTx(ctx, row); err != nil {
		return err
	}
	if info.IsDir() {
		a.mu.Lock()
		a.cursors = append(a.cursors, &cursor{
			rootID:       cur.rootID,
			path:         childPath,
			auditStartNs: time.Now().UnixNano(),
		})
		newCur := a.cursors[len(a.cursors)-1]
		a.mu.Unlock()
		if err := a.persistCursor(ctx, newCur); err != nil {
			return err
		}
	}
	return nil
}

func (a *Auditor) upsertInTx(ctx context.Context, row db.PathRow) error {
	tx, err := a.sqldb.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := db.UpsertPath(ctx, tx, row); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// reconcileDirectory tombstones every present child row under cur.path
// whose last_audited_at_ns is older than this audit epoch. That is how
// deletions are discovered without holding the full snapshot in memory.
func (a *Auditor) reconcileDirectory(ctx context.Context, cur *cursor) error {
	prefix := cur.path
	if prefix == "/" {
		prefix = ""
	}
	likeImmediate := prefix + "/%"
	likeDeeper := prefix + "/%/%"
	rows, err := a.sqldb.QueryContext(ctx, `
SELECT path FROM paths
WHERE state='present'
  AND path LIKE ?
  AND path NOT LIKE ?
  AND (last_audited_at_ns IS NULL OR last_audited_at_ns < ?)`,
		likeImmediate, likeDeeper, cur.auditStartNs,
	)
	if err != nil {
		return fmt.Errorf("audit: scan stale children: %w", err)
	}
	var stale []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return err
		}
		stale = append(stale, p)
	}
	rows.Close()
	for _, p := range stale {
		tx, err := a.sqldb.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if err := db.MarkRemoved(ctx, tx, p); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func classifyKind(info os.FileInfo) db.PathKind {
	mode := info.Mode()
	switch {
	case mode.IsDir():
		return db.KindDir
	case mode&os.ModeSymlink != 0:
		return db.KindSymlink
	case mode&os.ModeNamedPipe != 0:
		return db.KindFIFO
	case mode&os.ModeDevice != 0:
		return db.KindDevice
	case mode.IsRegular():
		return db.KindFile
	}
	return db.KindOther
}

type cursor struct {
	cursorID     int64
	rootID       int64
	path         string
	dir          *os.File
	auditStartNs int64
}

type noExcluder struct{}

func (noExcluder) Excluded(string) bool { return false }
