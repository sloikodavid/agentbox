package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/check"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/restore"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/storage"
)

const usage = `usage: persistd <command>

commands:
  restore   apply durable persistd state to the live filesystem
  watch     run the persistd daemon
  status    print current daemon status (--json for machine output)
  check     run deep consistency checks (--deep also walks orphan objects)
`

func restoreFailedMarker(paths config.Paths) string {
	return filepath.Join(filepath.Dir(paths.Heartbeat), "restore-failed")
}

func watchFailedMarker(paths config.Paths) string {
	return filepath.Join(filepath.Dir(paths.Heartbeat), "watch-failed")
}

func restoreErrorLog(paths config.Paths) string {
	return filepath.Join(filepath.Dir(paths.Config), "restore-error.log")
}

func watchErrorLog(paths config.Paths) string {
	return filepath.Join(filepath.Dir(paths.Config), "watch-error.log")
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "restore":
		os.Exit(runRestore())
	case "watch":
		os.Exit(runWatch())
	case "status":
		os.Exit(runStatus(os.Args[2:]))
	case "check":
		os.Exit(runCheck(os.Args[2:]))
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "persistd: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
}

func runRestore() int {
	ctx := context.Background()
	paths := config.ResolvePaths(os.Getenv)
	if err := storage.Init(paths); err != nil {
		fmt.Fprintf(os.Stderr, "persistd restore: storage init: %v\n", err)
		writeRestoreFailure(paths, fmt.Errorf("storage init: %w", err))
		return 0
	}
	_ = os.Remove(restoreFailedMarker(paths))

	if err := restore.Run(ctx, paths); err != nil {
		fmt.Fprintf(os.Stderr, "persistd restore: FAILED: %v\n", err)
		writeRestoreFailure(paths, err)
		return 0
	}
	fmt.Println("persistd restore: success")
	return 0
}

func writeRestoreFailure(paths config.Paths, restoreErr error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	report := fmt.Sprintf("persistd restore failed at %s\n\n%v\n", now, restoreErr)
	if err := os.MkdirAll(filepath.Dir(restoreErrorLog(paths)), 0o755); err == nil {
		_ = os.WriteFile(restoreErrorLog(paths), []byte(report), 0o644)
	}
	if err := os.MkdirAll(filepath.Dir(restoreFailedMarker(paths)), 0o755); err == nil {
		_ = os.WriteFile(restoreFailedMarker(paths), []byte(now+"\n"), 0o644)
	}
}

func writeWatchFailure(paths config.Paths, watchErr error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	report := fmt.Sprintf("persistd watch failed at %s\n\n%v\n", now, watchErr)
	_ = os.Remove(paths.Heartbeat)
	if err := os.MkdirAll(filepath.Dir(watchErrorLog(paths)), 0o755); err == nil {
		_ = os.WriteFile(watchErrorLog(paths), []byte(report), 0o644)
	}
	if err := os.MkdirAll(filepath.Dir(watchFailedMarker(paths)), 0o755); err == nil {
		_ = os.WriteFile(watchFailedMarker(paths), []byte(now+"\n"), 0o644)
	}
}

func failWatch(paths config.Paths, format string, args ...any) int {
	err := fmt.Errorf(format, args...)
	fmt.Fprintf(os.Stderr, "persistd watch: %v\n", err)
	writeWatchFailure(paths, err)
	return 1
}

func runWatch() int {
	paths := config.ResolvePaths(os.Getenv)
	if err := storage.Init(paths); err != nil {
		return failWatch(paths, "storage init: %w", err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	_ = os.Remove(watchFailedMarker(paths))

	if _, err := os.Stat(restoreFailedMarker(paths)); err == nil {
		return runDisabled(ctx, paths)
	} else if !errors.Is(err, os.ErrNotExist) {
		return failWatch(paths, "stat marker: %w", err)
	}

	return runDaemon(ctx, paths)
}

func runDisabled(ctx context.Context, paths config.Paths) int {
	_ = os.Remove(paths.Heartbeat)
	fmt.Fprintln(os.Stderr, "persistd watch: DISABLED - restore failed; daemon is refusing to persist")
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return 0
		case <-ticker.C:
			_ = os.Remove(paths.Heartbeat)
		}
	}
}

func runStatus(args []string) int {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "emit machine-readable JSON")
	_ = fs.Parse(args)

	paths := config.ResolvePaths(os.Getenv)
	if err := storage.Init(paths); err != nil {
		fmt.Fprintf(os.Stderr, "persistd status: %v\n", err)
		return 1
	}
	cfg, created, err := config.LoadOrCreate(paths.Config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "persistd status: %v\n", err)
		return 1
	}

	report := map[string]any{
		"paths":         paths,
		"configCreated": created,
		"excludeCount":  len(cfg.Exclude.RootRelative),
		"auditTickMs":   cfg.Audit.MaxWorkMsPerTick,
		"objectAlgo":    storage.ObjectAlgorithm,
	}
	if data, err := os.ReadFile(paths.Heartbeat); err == nil {
		var hb map[string]any
		if json.Unmarshal(data, &hb) == nil {
			report["heartbeat"] = hb
		}
	}
	if _, err := os.Stat(restoreFailedMarker(paths)); err == nil {
		report["restoreMarker"] = "present"
	}
	if _, err := os.Stat(watchFailedMarker(paths)); err == nil {
		report["watchMarker"] = "present"
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	printHumanStatus(report)
	return 0
}

func printHumanStatus(report map[string]any) {
	fmt.Printf("persistd status:\n")
	if hb, ok := report["heartbeat"].(map[string]any); ok {
		fmt.Printf("  ready:    %v\n", hb["ready"])
		fmt.Printf("  updated:  %v\n", hb["updatedAt"])
	} else {
		fmt.Printf("  (not ready)\n")
	}
	fmt.Printf("  exclusions: %v entries\n", report["excludeCount"])
	if v, ok := report["restoreMarker"]; ok {
		fmt.Printf("  restoreMarker: %v\n", v)
	}
	if v, ok := report["watchMarker"]; ok {
		fmt.Printf("  watchMarker: %v\n", v)
	}
}

func runCheck(args []string) int {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	deep := fs.Bool("deep", false, "also walk the object store for orphan files")
	asJSON := fs.Bool("json", false, "emit machine-readable JSON")
	_ = fs.Parse(args)

	ctx := context.Background()
	paths := config.ResolvePaths(os.Getenv)
	if err := storage.Init(paths); err != nil {
		fmt.Fprintf(os.Stderr, "persistd check: %v\n", err)
		return 2
	}
	report, err := check.Run(ctx, paths)
	if err != nil {
		fmt.Fprintf(os.Stderr, "persistd check: %v\n", err)
		return 2
	}
	if *deep {
		sqldb, dbErr := db.Open(ctx, paths.DB)
		if dbErr != nil {
			fmt.Fprintf(os.Stderr, "persistd check: deep walk open db: %v\n", dbErr)
		} else {
			store, storeErr := objectstore.Open(paths.Objects)
			if storeErr != nil {
				fmt.Fprintf(os.Stderr, "persistd check: deep walk open store: %v\n", storeErr)
			} else if err := check.WalkOrphans(ctx, sqldb, store, report); err != nil {
				fmt.Fprintf(os.Stderr, "persistd check: deep walk: %v\n", err)
			}
			_ = sqldb.Close()
		}
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(report)
	} else {
		printHumanCheck(report)
	}
	if report.HasFatal() {
		return 1
	}
	return 0
}

func printHumanCheck(report *check.Report) {
	fmt.Printf("persistd check: ran %d checks\n", len(report.Checks))
	if len(report.Findings) == 0 {
		fmt.Println("  no findings - all checks passed")
		return
	}
	for _, f := range report.Findings {
		fmt.Printf("  [%s] %s: %s\n", f.Severity, f.Check, f.Detail)
	}
}
