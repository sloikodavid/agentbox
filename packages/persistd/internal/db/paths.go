package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// PathState enumerates the durable lifecycle of a path row.
type PathState string

const (
	StatePresent PathState = "present"
	StateRemoved PathState = "removed"
)

// PathKind enumerates the supported filesystem entry kinds.
type PathKind string

const (
	KindFile    PathKind = "file"
	KindDir     PathKind = "dir"
	KindSymlink PathKind = "symlink"
	KindFIFO    PathKind = "fifo"
	KindDevice  PathKind = "device"
	KindOther   PathKind = "other"
)

// PathRow is the durable representation of a single live-tree path. Fields
// match the migration column order; pointer types model nullable columns.
type PathRow struct {
	ID                       int64
	Path                     string
	ParentID                 *int64
	Basename                 string
	State                    PathState
	Kind                     PathKind
	Mode                     *int64
	UID                      *int64
	GID                      *int64
	AtimeNs                  *int64
	MtimeNs                  *int64
	CtimeSeenNs              *int64
	Size                     *int64
	ObjectAlgorithm          *string
	ObjectHash               *string
	SymlinkTarget            *string
	SpecialMajor             *int64
	SpecialMinor             *int64
	HardlinkGroupID          *string
	ContentHashVerifiedAtNs  *int64
	LastAuditedAtNs          *int64
	MetadataVersion          int64
}

// UpsertPath inserts or replaces the current-state row for row.Path. The
// returned PathRow has ID populated.
func UpsertPath(ctx context.Context, tx *sql.Tx, row PathRow) (PathRow, error) {
	res, err := tx.ExecContext(ctx, `
INSERT INTO paths(
    path, parent_path_id, basename, state, kind, mode, uid, gid,
    atime_ns, mtime_ns, ctime_seen_ns, size,
    object_algorithm, object_hash, symlink_target,
    special_major, special_minor, hardlink_group_id,
    content_hash_verified_at_ns, last_audited_at_ns, metadata_version
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(path) DO UPDATE SET
    parent_path_id=excluded.parent_path_id,
    basename=excluded.basename,
    state=excluded.state,
    kind=excluded.kind,
    mode=excluded.mode,
    uid=excluded.uid,
    gid=excluded.gid,
    atime_ns=excluded.atime_ns,
    mtime_ns=excluded.mtime_ns,
    ctime_seen_ns=excluded.ctime_seen_ns,
    size=excluded.size,
    object_algorithm=excluded.object_algorithm,
    object_hash=excluded.object_hash,
    symlink_target=excluded.symlink_target,
    special_major=excluded.special_major,
    special_minor=excluded.special_minor,
    hardlink_group_id=excluded.hardlink_group_id,
    content_hash_verified_at_ns=excluded.content_hash_verified_at_ns,
    last_audited_at_ns=excluded.last_audited_at_ns,
    metadata_version=excluded.metadata_version
`,
		row.Path, row.ParentID, row.Basename, row.State, row.Kind,
		row.Mode, row.UID, row.GID,
		row.AtimeNs, row.MtimeNs, row.CtimeSeenNs, row.Size,
		row.ObjectAlgorithm, row.ObjectHash, row.SymlinkTarget,
		row.SpecialMajor, row.SpecialMinor, row.HardlinkGroupID,
		row.ContentHashVerifiedAtNs, row.LastAuditedAtNs, row.MetadataVersion,
	)
	if err != nil {
		return PathRow{}, fmt.Errorf("db: upsert path %q: %w", row.Path, err)
	}
	id, err := res.LastInsertId()
	if err != nil || id == 0 {
		err = tx.QueryRowContext(ctx, `SELECT path_id FROM paths WHERE path=?`, row.Path).Scan(&id)
		if err != nil {
			return PathRow{}, fmt.Errorf("db: lookup path %q after upsert: %w", row.Path, err)
		}
	}
	row.ID = id
	return row, nil
}

// MarkRemoved transitions the path to state=removed and clears object linkage.
// Returns sql.ErrNoRows if no row matched.
func MarkRemoved(ctx context.Context, tx *sql.Tx, path string) error {
	res, err := tx.ExecContext(ctx, `
UPDATE paths
SET state='removed',
    object_algorithm=NULL,
    object_hash=NULL,
    size=NULL,
    metadata_version=metadata_version+1
WHERE path=?`, path)
	if err != nil {
		return fmt.Errorf("db: mark removed %q: %w", path, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// GetPath fetches the row for an absolute path. Returns sql.ErrNoRows if absent.
func GetPath(ctx context.Context, q Queryer, path string) (PathRow, error) {
	row := q.QueryRowContext(ctx, `
SELECT path_id, path, parent_path_id, basename, state, kind, mode, uid, gid,
       atime_ns, mtime_ns, ctime_seen_ns, size,
       object_algorithm, object_hash, symlink_target,
       special_major, special_minor, hardlink_group_id,
       content_hash_verified_at_ns, last_audited_at_ns, metadata_version
FROM paths WHERE path=?`, path)
	var r PathRow
	err := row.Scan(
		&r.ID, &r.Path, &r.ParentID, &r.Basename, &r.State, &r.Kind,
		&r.Mode, &r.UID, &r.GID,
		&r.AtimeNs, &r.MtimeNs, &r.CtimeSeenNs, &r.Size,
		&r.ObjectAlgorithm, &r.ObjectHash, &r.SymlinkTarget,
		&r.SpecialMajor, &r.SpecialMinor, &r.HardlinkGroupID,
		&r.ContentHashVerifiedAtNs, &r.LastAuditedAtNs, &r.MetadataVersion,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return PathRow{}, sql.ErrNoRows
	}
	if err != nil {
		return PathRow{}, fmt.Errorf("db: get path %q: %w", path, err)
	}
	return r, nil
}

// Queryer is the read surface shared by *sql.DB and *sql.Tx.
type Queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}
