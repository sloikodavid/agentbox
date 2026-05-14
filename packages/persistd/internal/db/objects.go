package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// GCState enumerates the durable lifecycle of an object-store entry.
type GCState string

const (
	GCLive         GCState = "live"
	GCUnreferenced GCState = "unreferenced"
	GCDeleting     GCState = "deleting"
)

// ObjectRow is the durable representation of a content-addressed object.
type ObjectRow struct {
	Algorithm   string
	Hash        string
	Size        int64
	RefCount    int64
	CreatedAtNs int64
	GCState     GCState
}

// RetainObject ensures an objects row exists for (algorithm, hash) and
// increments ref_count by one. When the row is created the size and
// created_at fields are taken from the call; on an existing row size must
// match the stored value (a sanity check against hash collisions of
// different sizes).
func RetainObject(ctx context.Context, tx *sql.Tx, algorithm, hash string, size int64) error {
	if algorithm == "" || hash == "" {
		return errors.New("db: RetainObject requires non-empty algorithm and hash")
	}
	var (
		existingSize int64
		state        string
	)
	err := tx.QueryRowContext(ctx,
		`SELECT size, gc_state FROM objects WHERE algorithm=? AND hash=?`,
		algorithm, hash,
	).Scan(&existingSize, &state)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err := tx.ExecContext(ctx,
			`INSERT INTO objects(algorithm, hash, size, ref_count, created_at_ns, gc_state) VALUES (?, ?, ?, 1, ?, 'live')`,
			algorithm, hash, size, time.Now().UnixNano(),
		)
		if err != nil {
			return fmt.Errorf("db: insert object %s/%s: %w", algorithm, hash, err)
		}
		return nil
	case err != nil:
		return fmt.Errorf("db: probe object %s/%s: %w", algorithm, hash, err)
	}
	if existingSize != size {
		return fmt.Errorf("db: object %s/%s size mismatch (stored=%d new=%d)", algorithm, hash, existingSize, size)
	}
	_, err = tx.ExecContext(ctx,
		`UPDATE objects SET ref_count=ref_count+1, gc_state='live' WHERE algorithm=? AND hash=?`,
		algorithm, hash,
	)
	if err != nil {
		return fmt.Errorf("db: increment object %s/%s: %w", algorithm, hash, err)
	}
	return nil
}

// ReleaseObject decrements ref_count by one. When ref_count reaches zero the
// row transitions to gc_state='unreferenced' for the background GC to pick up.
// Returns sql.ErrNoRows if the object is unknown.
func ReleaseObject(ctx context.Context, tx *sql.Tx, algorithm, hash string) error {
	res, err := tx.ExecContext(ctx,
		`UPDATE objects SET ref_count=ref_count-1 WHERE algorithm=? AND hash=? AND ref_count>0`,
		algorithm, hash,
	)
	if err != nil {
		return fmt.Errorf("db: release object %s/%s: %w", algorithm, hash, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	_, err = tx.ExecContext(ctx,
		`UPDATE objects SET gc_state='unreferenced' WHERE algorithm=? AND hash=? AND ref_count=0 AND gc_state='live'`,
		algorithm, hash,
	)
	if err != nil {
		return fmt.Errorf("db: mark unreferenced %s/%s: %w", algorithm, hash, err)
	}
	return nil
}

// GetObject fetches a single object row.
func GetObject(ctx context.Context, q Queryer, algorithm, hash string) (ObjectRow, error) {
	var o ObjectRow
	err := q.QueryRowContext(ctx,
		`SELECT algorithm, hash, size, ref_count, created_at_ns, gc_state FROM objects WHERE algorithm=? AND hash=?`,
		algorithm, hash,
	).Scan(&o.Algorithm, &o.Hash, &o.Size, &o.RefCount, &o.CreatedAtNs, &o.GCState)
	if errors.Is(err, sql.ErrNoRows) {
		return ObjectRow{}, sql.ErrNoRows
	}
	if err != nil {
		return ObjectRow{}, fmt.Errorf("db: get object %s/%s: %w", algorithm, hash, err)
	}
	return o, nil
}
