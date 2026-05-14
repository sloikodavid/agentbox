// Package check implements the deep consistency checker invoked by
// `persistd check`. Each check is independent and contributes findings to
// a Report; the command exits non-zero when any finding is fatal.
package check

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
)

// Severity classifies a Finding. Fatal findings cause the CLI to exit
// non-zero; Warning findings are reported but don't fail the run.
type Severity string

const (
	Fatal   Severity = "fatal"
	Warning Severity = "warning"
)

// Finding is one issue surfaced by the checker.
type Finding struct {
	Severity Severity
	Check    string
	Detail   string
}

// Report aggregates findings and whether the run passed.
type Report struct {
	Findings []Finding
	Checks   []string
}

// HasFatal reports whether any finding is fatal.
func (r *Report) HasFatal() bool {
	for _, f := range r.Findings {
		if f.Severity == Fatal {
			return true
		}
	}
	return false
}

func (r *Report) add(check string, severity Severity, detail string) {
	r.Findings = append(r.Findings, Finding{Severity: severity, Check: check, Detail: detail})
}

// Run executes the full check suite. It never returns an error for
// expected inconsistencies; those land in the report. A non-nil error
// indicates the checker itself could not run (e.g. DB is unopenable).
func Run(ctx context.Context, paths config.Paths) (*Report, error) {
	r := &Report{}

	r.Checks = append(r.Checks, "config")
	if _, _, err := config.LoadOrCreate(paths.Config); err != nil {
		r.add("config", Fatal, err.Error())
	}

	r.Checks = append(r.Checks, "db_schema")
	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		r.add("db_schema", Fatal, err.Error())
		return r, nil
	}
	defer sqldb.Close()

	var schemaCount int
	if err := sqldb.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_info`).Scan(&schemaCount); err != nil {
		r.add("db_schema", Fatal, "schema_info table missing or unreadable: "+err.Error())
	} else if schemaCount == 0 {
		r.add("db_schema", Fatal, "no migrations applied")
	}

	store, err := objectstore.Open(paths.Objects)
	if err != nil {
		r.add("object_store", Fatal, err.Error())
		return r, nil
	}

	r.Checks = append(r.Checks, "objects_referenced_exist")
	if err := checkReferencedObjectsExist(ctx, sqldb, store, r); err != nil {
		return r, fmt.Errorf("check: scan referenced objects: %w", err)
	}

	r.Checks = append(r.Checks, "parent_integrity")
	if err := checkParentIntegrity(ctx, sqldb, r); err != nil {
		return r, fmt.Errorf("check: parent integrity: %w", err)
	}

	r.Checks = append(r.Checks, "object_ref_counts")
	if err := checkObjectRefCounts(ctx, sqldb, r); err != nil {
		return r, fmt.Errorf("check: ref counts: %w", err)
	}

	return r, nil
}

func checkReferencedObjectsExist(ctx context.Context, sqldb *sql.DB, store *objectstore.Store, r *Report) error {
	rows, err := sqldb.QueryContext(ctx, `
SELECT DISTINCT object_algorithm, object_hash
FROM paths
WHERE state='present' AND object_algorithm IS NOT NULL AND object_hash IS NOT NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()
	missing := 0
	for rows.Next() {
		var algo, hash string
		if err := rows.Scan(&algo, &hash); err != nil {
			return err
		}
		exists, err := store.Has(algo, hash)
		if err != nil {
			return err
		}
		if !exists {
			missing++
			r.add("objects_referenced_exist", Fatal, fmt.Sprintf("missing object %s/%s referenced by path row", algo, hash))
			if missing >= 10 {
				r.add("objects_referenced_exist", Warning, "stopping enumeration after 10 missing objects")
				return nil
			}
		}
	}
	return rows.Err()
}

func checkParentIntegrity(ctx context.Context, sqldb *sql.DB, r *Report) error {
	rows, err := sqldb.QueryContext(ctx, `
SELECT p.path, p.parent_path_id
FROM paths p
LEFT JOIN paths parent ON p.parent_path_id = parent.path_id
WHERE p.parent_path_id IS NOT NULL AND parent.path_id IS NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			path     string
			parentID int64
		)
		if err := rows.Scan(&path, &parentID); err != nil {
			return err
		}
		r.add("parent_integrity", Fatal, fmt.Sprintf("path %q has dangling parent_path_id=%d", path, parentID))
	}
	return rows.Err()
}

func checkObjectRefCounts(ctx context.Context, sqldb *sql.DB, r *Report) error {
	rows, err := sqldb.QueryContext(ctx, `
SELECT o.algorithm, o.hash, o.ref_count, o.gc_state,
       (SELECT COUNT(*) FROM paths p
        WHERE p.state='present'
          AND p.object_algorithm=o.algorithm
          AND p.object_hash=o.hash) AS actual_refs
FROM objects o`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			algo, hash, gcState string
			refCount, actual    int64
		)
		if err := rows.Scan(&algo, &hash, &refCount, &gcState, &actual); err != nil {
			return err
		}
		if refCount != actual {
			r.add("object_ref_counts", Warning,
				fmt.Sprintf("object %s/%s ref_count=%d but %d live paths reference it", algo, hash, refCount, actual))
		}
		if actual == 0 && gcState == "live" {
			r.add("object_ref_counts", Warning,
				fmt.Sprintf("object %s/%s is live but has zero live referrers (will be GC'd)", algo, hash))
		}
	}
	return rows.Err()
}

// WalkOrphans scans the object store directory and reports files not
// referenced by any DB row. Separated from Run because it's the most
// expensive check; the CLI calls it only when --deep is passed.
func WalkOrphans(ctx context.Context, sqldb *sql.DB, store *objectstore.Store, r *Report) error {
	r.Checks = append(r.Checks, "orphan_object_files")
	known, err := loadKnownHashes(ctx, sqldb)
	if err != nil {
		return err
	}
	algoDir := store.AlgorithmDir()
	entries, err := os.ReadDir(algoDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, level1 := range entries {
		if !level1.IsDir() {
			continue
		}
		sub1, _ := os.ReadDir(algoDir + "/" + level1.Name())
		for _, level2 := range sub1 {
			if !level2.IsDir() {
				continue
			}
			sub2, _ := os.ReadDir(algoDir + "/" + level1.Name() + "/" + level2.Name())
			for _, obj := range sub2 {
				if obj.IsDir() {
					continue
				}
				if _, ok := known[obj.Name()]; !ok {
					r.add("orphan_object_files", Warning,
						fmt.Sprintf("orphan object file %s/%s/%s", level1.Name(), level2.Name(), obj.Name()))
				}
			}
		}
	}
	return nil
}

func loadKnownHashes(ctx context.Context, sqldb *sql.DB) (map[string]struct{}, error) {
	rows, err := sqldb.QueryContext(ctx, `SELECT hash FROM objects WHERE algorithm=?`, objectstore.Algorithm)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		out[h] = struct{}{}
	}
	return out, rows.Err()
}

