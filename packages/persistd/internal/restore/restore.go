// Package restore applies the durable persistd state to the live
// filesystem. It is run by the container entrypoint before Supervisor
// starts services, and uses only the SQLite paths table and the object
// store; it does not consult audit cursors or watcher state.
package restore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
)

// Run applies persisted state to the live filesystem.
func Run(ctx context.Context, paths config.Paths) error {
	if _, _, err := config.LoadOrCreate(paths.Config); err != nil {
		return fmt.Errorf("restore: load config: %w", err)
	}
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		return fmt.Errorf("restore: open db: %w", err)
	}
	defer sqldb.Close()

	store, err := objectstore.Open(paths.Objects)
	if err != nil {
		return fmt.Errorf("restore: open object store: %w", err)
	}

	rows, err := loadRows(ctx, sqldb)
	if err != nil {
		return err
	}

	present, removed := splitByState(rows)

	// Apply present entries in parent-before-child order. Path-string
	// length is a sufficient ordering since every parent path is a prefix
	// of its children and thus strictly shorter.
	sort.Slice(present, func(i, j int) bool { return len(present[i].Path) < len(present[j].Path) })
	for _, r := range present {
		if err := applyPresent(ctx, store, r); err != nil {
			return fmt.Errorf("restore: %s: %w", r.Path, err)
		}
	}

	// Apply tombstones in child-before-parent order so directory removals
	// see empty directories.
	sort.Slice(removed, func(i, j int) bool { return len(removed[i].Path) > len(removed[j].Path) })
	for _, r := range removed {
		if err := applyTombstone(r); err != nil {
			return fmt.Errorf("restore: tombstone %s: %w", r.Path, err)
		}
	}
	return nil
}

func loadRows(ctx context.Context, sqldb *sql.DB) ([]db.PathRow, error) {
	rows, err := sqldb.QueryContext(ctx, `
SELECT path_id, path, parent_path_id, basename, state, kind, mode, uid, gid,
       atime_ns, mtime_ns, ctime_seen_ns, size,
       object_algorithm, object_hash, symlink_target,
       special_major, special_minor, hardlink_group_id,
       content_hash_verified_at_ns, last_audited_at_ns, metadata_version
FROM paths`)
	if err != nil {
		return nil, fmt.Errorf("restore: query paths: %w", err)
	}
	defer rows.Close()
	var out []db.PathRow
	for rows.Next() {
		var r db.PathRow
		if err := rows.Scan(
			&r.ID, &r.Path, &r.ParentID, &r.Basename, &r.State, &r.Kind,
			&r.Mode, &r.UID, &r.GID,
			&r.AtimeNs, &r.MtimeNs, &r.CtimeSeenNs, &r.Size,
			&r.ObjectAlgorithm, &r.ObjectHash, &r.SymlinkTarget,
			&r.SpecialMajor, &r.SpecialMinor, &r.HardlinkGroupID,
			&r.ContentHashVerifiedAtNs, &r.LastAuditedAtNs, &r.MetadataVersion,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func splitByState(rows []db.PathRow) (present, removed []db.PathRow) {
	for _, r := range rows {
		switch r.State {
		case db.StatePresent:
			present = append(present, r)
		case db.StateRemoved:
			removed = append(removed, r)
		}
	}
	return
}

func applyPresent(ctx context.Context, store *objectstore.Store, r db.PathRow) error {
	switch r.Kind {
	case db.KindDir:
		if err := os.MkdirAll(r.Path, 0o755); err != nil {
			return err
		}
	case db.KindFile:
		if r.ObjectAlgorithm == nil || r.ObjectHash == nil {
			return fmt.Errorf("file row missing object reference")
		}
		objPath, err := store.Path(*r.ObjectAlgorithm, *r.ObjectHash)
		if err != nil {
			return err
		}
		if err := ensureParent(r.Path); err != nil {
			return err
		}
		if err := copyFile(objPath, r.Path); err != nil {
			return err
		}
	case db.KindSymlink:
		if r.SymlinkTarget == nil {
			return fmt.Errorf("symlink row missing target")
		}
		if err := ensureParent(r.Path); err != nil {
			return err
		}
		_ = os.Remove(r.Path)
		if err := os.Symlink(*r.SymlinkTarget, r.Path); err != nil {
			return err
		}
	case db.KindFIFO, db.KindDevice, db.KindOther:
		// Deferred to Slice 10; skip without error so restore can proceed.
		return nil
	default:
		return fmt.Errorf("unknown kind %q", r.Kind)
	}
	return applyMetadata(r)
}

func applyTombstone(r db.PathRow) error {
	if err := os.RemoveAll(r.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func ensureParent(p string) error {
	return os.MkdirAll(filepath.Dir(p), 0o755)
}

func copyFile(src, dst string) error {
	_ = os.Remove(dst)
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open object: %w", err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create live file: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("copy: %w", err)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return fmt.Errorf("sync: %w", err)
	}
	return out.Close()
}

func applyMetadata(r db.PathRow) error {
	if r.Kind != db.KindSymlink {
		if r.Mode != nil {
			if err := os.Chmod(r.Path, os.FileMode(*r.Mode)&os.ModePerm); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		if r.AtimeNs != nil && r.MtimeNs != nil {
			at := time.Unix(0, *r.AtimeNs)
			mt := time.Unix(0, *r.MtimeNs)
			if err := os.Chtimes(r.Path, at, mt); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	if r.UID != nil && r.GID != nil {
		if err := lchown(r.Path, int(*r.UID), int(*r.GID)); err != nil {
			return err
		}
	}
	return nil
}
