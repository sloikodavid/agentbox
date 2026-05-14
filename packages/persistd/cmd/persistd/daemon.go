package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/audit"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/db"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/gc"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/heartbeat"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/objectstore"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/processor"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/scheduler"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/watch"
)

// runDaemon wires watcher + scheduler + audit + dirty queue + GC + heartbeat
// into the long-running persistd watch loop. It returns when ctx is
// cancelled (SIGTERM/SIGINT) or a fatal error occurs.
func runDaemon(ctx context.Context, paths config.Paths) int {
	cfg, _, err := config.LoadOrCreate(paths.Config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: load config: %v\n", err)
		return 1
	}

	sqldb, err := db.Open(ctx, paths.DB)
	if err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: open db: %v\n", err)
		return 1
	}
	defer sqldb.Close()

	store, err := objectstore.Open(paths.Objects)
	if err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: open object store: %v\n", err)
		return 1
	}
	_ = store.CleanTemp()

	proc := processor.New(sqldb, store)
	exc := newExcluder(cfg.Exclude.RootRelative)
	roots := discoverRoots(exc)

	watcher, err := watch.New(exc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: inotify init: %v\n", err)
		return 1
	}
	defer watcher.Close()
	for _, r := range roots {
		if err := watcher.AddTree(r); err != nil {
			fmt.Fprintf(os.Stderr, "persistd watch: AddTree %s: %v\n", r, err)
		}
	}

	auditor := audit.New(sqldb, exc, audit.Config{
		DirectoryBatchSize: cfg.Audit.DirectoryBatchSize,
		Priority:           100,
	})
	if err := auditor.Start(ctx, roots); err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: audit.Start: %v\n", err)
		return 1
	}

	queue := scheduler.NewDirtyQueue(4096)
	dirty := scheduler.NewDirtySource(queue, 10, func(ctx context.Context, path string) error {
		if err := proc.Apply(ctx, path); err != nil {
			fmt.Fprintf(os.Stderr, "persistd watch: apply %s: %v\n", path, err)
		}
		return nil
	})
	gcCol := gc.New(sqldb, store, gc.Config{Priority: 1000})

	sched := scheduler.New(scheduler.Config{
		MaxFsOpsPerSecond:     float64(maxOr(cfg.Audit.MaxFilesystemOpsPerSecond, 2000)),
		MaxHashBytesPerSecond: float64(maxOr(cfg.Audit.MaxHashBytesPerSecond, 20_000_000)),
		MaxWorkPerTick:        time.Duration(maxOr(cfg.Audit.MaxWorkMsPerTick, 10)) * time.Millisecond,
	}, nil)
	sched.Register(dirty)
	sched.Register(auditor)
	sched.Register(gcCol)

	go func() {
		if err := watcher.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "persistd watch: watcher: %v\n", err)
		}
	}()
	go pumpEvents(ctx, watcher, queue)
	go func() {
		if err := sched.Run(ctx); err != nil && err != context.Canceled {
			fmt.Fprintf(os.Stderr, "persistd watch: scheduler: %v\n", err)
		}
	}()

	hbTicker := time.NewTicker(5 * time.Second)
	defer hbTicker.Stop()
	writeWatchHeartbeat(paths, watcher, queue, auditor, gcCol, sqldb)
	for {
		select {
		case <-ctx.Done():
			return 0
		case <-hbTicker.C:
			writeWatchHeartbeat(paths, watcher, queue, auditor, gcCol, sqldb)
		}
	}
}

func pumpEvents(ctx context.Context, watcher *watch.Watcher, queue *scheduler.DirtyQueue) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-watcher.Events():
			if !ok {
				return
			}
			if ev.Op == watch.OpOverflow || ev.Path == "" {
				continue
			}
			queue.Enqueue(ev.Path)
		}
	}
}

func writeWatchHeartbeat(paths config.Paths, watcher *watch.Watcher, queue *scheduler.DirtyQueue, auditor *audit.Auditor, gcCol *gc.Collector, sqldb interface{}) {
	hb := heartbeat.Heartbeat{
		Status:           heartbeat.StatusOK,
		Mode:             heartbeat.ModeWatch,
		WatcherCount:     watcher.WatchCount(),
		DegradedReasons:  watcher.DegradedReasons(),
		DirtyBacklog:     queue.Len(),
		AuditCursorCount: auditor.CursorCount(),
	}
	if len(hb.DegradedReasons) > 0 {
		hb.Status = heartbeat.StatusDegraded
	}
	if err := heartbeat.Write(paths.Heartbeat, hb); err != nil {
		fmt.Fprintf(os.Stderr, "persistd watch: heartbeat: %v\n", err)
	}
}

func maxOr(v, fallback int) int {
	if v > 0 {
		return v
	}
	return fallback
}

// excluder matches an absolute path against the user-configured list of
// excluded prefixes. A path is excluded when it equals, or is a child of,
// any configured entry.
type excluder struct {
	prefixes []string
}

func newExcluder(prefixes []string) *excluder {
	out := make([]string, 0, len(prefixes))
	for _, p := range prefixes {
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	return &excluder{prefixes: out}
}

// Excluded implements watch.Excluder and audit.Excluder.
func (e *excluder) Excluded(absPath string) bool {
	for _, p := range e.prefixes {
		if absPath == p {
			return true
		}
		if strings.HasPrefix(absPath, p) && (len(absPath) == len(p) || absPath[len(p)] == '/') {
			return true
		}
	}
	return false
}

// discoverRoots returns every top-level entry of "/" that is not excluded,
// so the watcher and audit cover the included tree without needing to
// duplicate the include/exclude logic in two places.
func discoverRoots(exc *excluder) []string {
	entries, err := os.ReadDir("/")
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		full := "/" + e.Name()
		if exc.Excluded(full) {
			continue
		}
		out = append(out, full)
	}
	return out
}
