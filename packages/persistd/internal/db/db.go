// Package db owns the persistd SQLite schema, migrations, and CRUD for
// paths and objects. SQLite is the durable truth for metadata, path state,
// tombstones, object references, audit state, and restore state.
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open opens (creating if necessary) the SQLite database at path and applies
// any pending migrations. The returned *sql.DB is configured for the
// persistd one-writer durability model.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(DELETE)&_pragma=synchronous(FULL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	if err := applyMigrations(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

type migration struct {
	version int
	name    string
	sql     string
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return nil, fmt.Errorf("db: read migrations: %w", err)
	}
	var out []migration
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		stem := strings.TrimSuffix(e.Name(), ".sql")
		idx := strings.IndexByte(stem, '_')
		if idx <= 0 {
			return nil, fmt.Errorf("db: migration %q must be named <version>_<name>.sql", e.Name())
		}
		var version int
		if _, err := fmt.Sscanf(stem[:idx], "%d", &version); err != nil {
			return nil, fmt.Errorf("db: migration %q has non-numeric version: %w", e.Name(), err)
		}
		body, err := fs.ReadFile(migrationsFS, "migrations/"+e.Name())
		if err != nil {
			return nil, fmt.Errorf("db: read %s: %w", e.Name(), err)
		}
		out = append(out, migration{version: version, name: stem[idx+1:], sql: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i, m := range out {
		if m.version != i+1 {
			return nil, fmt.Errorf("db: migration versions must be sequential starting at 1; got %d at index %d", m.version, i)
		}
	}
	return out, nil
}

func applyMigrations(ctx context.Context, db *sql.DB) error {
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	applied, err := appliedVersions(ctx, db)
	if err != nil {
		return err
	}
	for _, m := range migrations {
		if applied[m.version] {
			continue
		}
		if err := applyOne(ctx, db, m); err != nil {
			return fmt.Errorf("db: apply migration %d (%s): %w", m.version, m.name, err)
		}
	}
	return nil
}

func appliedVersions(ctx context.Context, db *sql.DB) (map[int]bool, error) {
	var name string
	err := db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_info'`).Scan(&name)
	if err == sql.ErrNoRows {
		return map[int]bool{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("db: probe schema_info: %w", err)
	}
	rows, err := db.QueryContext(ctx, `SELECT version FROM schema_info`)
	if err != nil {
		return nil, fmt.Errorf("db: read schema_info: %w", err)
	}
	defer rows.Close()
	out := map[int]bool{}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out[v] = true
	}
	return out, rows.Err()
}

func applyOne(ctx context.Context, db *sql.DB, m migration) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, m.sql); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_info(version, name, applied_at_ns) VALUES (?, ?, ?)`,
		m.version, m.name, time.Now().UnixNano(),
	); err != nil {
		return err
	}
	return tx.Commit()
}
