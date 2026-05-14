// Package processor captures a single live path into persistd's durable
// state: lstat, classify, capture content for regular files via the
// object store, retain object ref-counts, upsert the path row with
// metadata + xattrs, all in one transaction. It is shared by the dirty
// queue handler (watcher-driven) and the rolling audit (audit-driven).
package processor

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/metadata"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
)

// Processor wires the durable stores. One instance is shared by all
// callers; methods are safe for concurrent use as long as the underlying
// *sql.DB is.
type Processor struct {
	sqldb *sql.DB
	store *objectstore.Store
}

// New constructs a Processor.
func New(sqldb *sql.DB, store *objectstore.Store) *Processor {
	return &Processor{sqldb: sqldb, store: store}
}

// Apply captures the live path's current state into the DB and (for
// regular files) into the object store. A missing live path is recorded
// as state=removed.
func (p *Processor) Apply(ctx context.Context, livePath string) error {
	info, err := os.Lstat(livePath)
	if errors.Is(err, os.ErrNotExist) {
		return p.markRemoved(ctx, livePath)
	}
	if err != nil {
		return fmt.Errorf("processor: lstat %s: %w", livePath, err)
	}

	row, xattrs, err := p.buildRow(livePath, info)
	if err != nil {
		return err
	}

	if info.Mode().IsRegular() {
		res, err := p.store.Capture(ctx, livePath)
		if err != nil {
			if errors.Is(err, objectstore.ErrChangedDuringCopy) {
				return err
			}
			return fmt.Errorf("processor: capture %s: %w", livePath, err)
		}
		algo := res.Algorithm
		hash := res.Hash
		size := res.Size
		row.ObjectAlgorithm = &algo
		row.ObjectHash = &hash
		row.Size = &size
		return p.commitFile(ctx, row, xattrs, res)
	}
	return p.commitNonFile(ctx, row, xattrs)
}

func (p *Processor) buildRow(livePath string, info os.FileInfo) (db.PathRow, []metadata.Xattr, error) {
	kind := classifyKind(info)
	row := db.PathRow{
		Path:            livePath,
		Basename:        filepath.Base(livePath),
		State:           db.StatePresent,
		Kind:            kind,
		MetadataVersion: 1,
	}
	mode := int64(info.Mode().Perm())
	row.Mode = &mode
	mtime := info.ModTime().UnixNano()
	row.MtimeNs = &mtime
	now := time.Now().UnixNano()
	row.LastAuditedAtNs = &now

	if kind == db.KindSymlink {
		if target, err := os.Readlink(livePath); err == nil {
			row.SymlinkTarget = &target
		}
	}

	md, err := metadata.Capture(livePath, info)
	if err != nil {
		return db.PathRow{}, nil, fmt.Errorf("processor: metadata.Capture %s: %w", livePath, err)
	}
	row.UID = md.UID
	row.GID = md.GID
	row.HardlinkGroupID = md.HardlinkGroupID
	return row, md.Xattrs, nil
}

func (p *Processor) commitFile(ctx context.Context, row db.PathRow, xattrs []metadata.Xattr, res objectstore.CaptureResult) error {
	tx, err := p.sqldb.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	rollback := func() { _ = tx.Rollback() }

	prev, err := db.GetPath(ctx, tx, row.Path)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		rollback()
		return err
	}
	prevSameObject := prev.ObjectHash != nil && prev.ObjectAlgorithm != nil &&
		*prev.ObjectHash == res.Hash && *prev.ObjectAlgorithm == res.Algorithm
	if prev.ObjectHash != nil && !prevSameObject {
		if err := db.ReleaseObject(ctx, tx, *prev.ObjectAlgorithm, *prev.ObjectHash); err != nil && !errors.Is(err, sql.ErrNoRows) {
			rollback()
			return err
		}
	}
	if !prevSameObject {
		if err := db.RetainObject(ctx, tx, res.Algorithm, res.Hash, res.Size); err != nil {
			rollback()
			return err
		}
	}
	if err := upsertWithXattrs(ctx, tx, row, xattrs); err != nil {
		rollback()
		return err
	}
	return tx.Commit()
}

func (p *Processor) commitNonFile(ctx context.Context, row db.PathRow, xattrs []metadata.Xattr) error {
	tx, err := p.sqldb.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	rollback := func() { _ = tx.Rollback() }

	prev, err := db.GetPath(ctx, tx, row.Path)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		rollback()
		return err
	}
	if prev.ObjectHash != nil && prev.ObjectAlgorithm != nil {
		if err := db.ReleaseObject(ctx, tx, *prev.ObjectAlgorithm, *prev.ObjectHash); err != nil && !errors.Is(err, sql.ErrNoRows) {
			rollback()
			return err
		}
	}
	if err := upsertWithXattrs(ctx, tx, row, xattrs); err != nil {
		rollback()
		return err
	}
	return tx.Commit()
}

func (p *Processor) markRemoved(ctx context.Context, livePath string) error {
	tx, err := p.sqldb.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	rollback := func() { _ = tx.Rollback() }

	prev, err := db.GetPath(ctx, tx, livePath)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return nil
	}
	if err != nil {
		rollback()
		return err
	}
	if prev.State == db.StateRemoved {
		_ = tx.Rollback()
		return nil
	}
	if prev.ObjectAlgorithm != nil && prev.ObjectHash != nil {
		if err := db.ReleaseObject(ctx, tx, *prev.ObjectAlgorithm, *prev.ObjectHash); err != nil && !errors.Is(err, sql.ErrNoRows) {
			rollback()
			return err
		}
	}
	if err := db.MarkRemoved(ctx, tx, livePath); err != nil {
		rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM xattrs WHERE path_id=?`, prev.ID); err != nil {
		rollback()
		return err
	}
	return tx.Commit()
}

func upsertWithXattrs(ctx context.Context, tx *sql.Tx, row db.PathRow, xs []metadata.Xattr) error {
	saved, err := db.UpsertPath(ctx, tx, row)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM xattrs WHERE path_id=?`, saved.ID); err != nil {
		return err
	}
	for _, x := range xs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO xattrs(path_id, name, value) VALUES (?, ?, ?)`,
			saved.ID, x.Name, x.Value,
		); err != nil {
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
