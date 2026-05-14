package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/heartbeat"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/restore"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/storage"
)

const usage = `usage: persistd <command>

commands:
  restore   apply durable persistence state to the live filesystem
  watch     run the persistence daemon
  status    print current daemon status
  check     run deep consistency checks
`

// restoreFailedMarker is the runtime file that, when present, instructs
// persistd watch to refuse to persist. Lives under /run so it is cleared
// across reboots.
func restoreFailedMarker(paths config.Paths) string {
	return filepath.Join(filepath.Dir(paths.Heartbeat), "persistd.restore-failed")
}

// restoreErrorLog is the durable, user-readable failure report written when
// persistd restore cannot apply state.
func restoreErrorLog(paths config.Paths) string {
	return filepath.Join(filepath.Dir(paths.Config), "restore-error.log")
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
		if err := runStatus(); err != nil {
			fmt.Fprintf(os.Stderr, "persistd status: %v\n", err)
			os.Exit(1)
		}
	case "check":
		fmt.Println("persistd check: not implemented yet")
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
	// Clear any prior failure marker on a fresh attempt; recreated below if
	// this attempt fails.
	_ = os.Remove(restoreFailedMarker(paths))

	if err := restore.Run(ctx, paths); err != nil {
		fmt.Fprintf(os.Stderr, "persistd restore: FAILED: %v\n", err)
		writeRestoreFailure(paths, err)
		// Exit 0 so the entrypoint's exec supervisord still runs; the
		// failure is observable via the marker file and watch's disabled
		// heartbeat.
		return 0
	}
	fmt.Println("persistd restore: ok")
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

func runWatch() int {
	paths := config.ResolvePaths(os.Getenv)
	if err := storage.Init(paths); err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: storage init: %v\n", err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if _, err := os.Stat(restoreFailedMarker(paths)); err == nil {
		return runDisabled(ctx, paths)
	} else if !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "persistd watch: stat marker: %v\n", err)
		return 1
	}

	// Real inotify watcher lands in Slice 7. Until then, hold the process
	// open and publish a starting heartbeat so Supervisor and the gateway
	// see a live daemon.
	return runHeartbeatOnly(ctx, paths)
}

func runDisabled(ctx context.Context, paths config.Paths) int {
	hb := heartbeat.Disabled("restore failed; see " + restoreErrorLog(paths))
	if err := heartbeat.Write(paths.Heartbeat, hb); err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: write heartbeat: %v\n", err)
	}
	fmt.Fprintln(os.Stderr, "persistd watch: DISABLED - restore failed; daemon is refusing to persist")
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return 0
		case <-ticker.C:
			_ = heartbeat.Write(paths.Heartbeat, heartbeat.Disabled("restore failed; see "+restoreErrorLog(paths)))
		}
	}
}

func runHeartbeatOnly(ctx context.Context, paths config.Paths) int {
	write := func() {
		hb := heartbeat.Heartbeat{
			Status:          heartbeat.StatusDegraded,
			Mode:            heartbeat.ModeStarting,
			DegradedReasons: []string{"watcher not yet implemented (pending Slice 7)"},
		}
		_ = heartbeat.Write(paths.Heartbeat, hb)
	}
	write()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return 0
		case <-ticker.C:
			write()
		}
	}
}

func runStatus() error {
	paths := config.ResolvePaths(os.Getenv)
	if err := storage.Init(paths); err != nil {
		return err
	}
	cfg, created, err := config.LoadOrCreate(paths.Config)
	if err != nil {
		return err
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
	} else if _, err := os.Stat(restoreFailedMarker(paths)); err == nil {
		report["status"] = "disabled"
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}
