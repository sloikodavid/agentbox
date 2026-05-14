package scheduler

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Source is a unit of work persistd schedules. Lower Priority runs first.
// RunOne does at most one chunk of work bounded by the Budget; it returns
// more=true ONLY when it made forward progress and has additional work
// queued. Returning more=false (whether the source is idle or temporarily
// budget-starved) yields to the next source. Sources must not loop
// internally - the scheduler is responsible for fairness and for honoring
// the deadline.
type Source interface {
	Name() string
	Priority() int
	RunOne(ctx context.Context, budget *Budget) (more bool, err error)
}

// Status describes the runtime state of the scheduler for the heartbeat.
type Status struct {
	IdleSources   []string
	BusySources   []string
	LastTickError error
}

// Scheduler coordinates work across all Sources under shared token budgets.
type Scheduler struct {
	fsOps          *TokenBucket
	hashBytes      *TokenBucket
	maxWorkPerTick time.Duration
	yieldBetween   time.Duration
	now            func() time.Time

	mu      sync.Mutex
	sources []Source
	status  Status
}

// Config holds the tunables read from /data/persistence/config.json.
type Config struct {
	MaxFsOpsPerSecond     float64
	MaxHashBytesPerSecond float64
	MaxWorkPerTick        time.Duration
	YieldBetween          time.Duration
}

// New constructs a Scheduler from the given config. now defaults to
// time.Now; tests inject a fake clock.
func New(cfg Config, now func() time.Time) *Scheduler {
	if now == nil {
		now = time.Now
	}
	if cfg.MaxWorkPerTick <= 0 {
		cfg.MaxWorkPerTick = 10 * time.Millisecond
	}
	if cfg.YieldBetween <= 0 {
		cfg.YieldBetween = time.Millisecond
	}
	return &Scheduler{
		fsOps:          NewTokenBucket(cfg.MaxFsOpsPerSecond, cfg.MaxFsOpsPerSecond, now),
		hashBytes:      NewTokenBucket(cfg.MaxHashBytesPerSecond, cfg.MaxHashBytesPerSecond, now),
		maxWorkPerTick: cfg.MaxWorkPerTick,
		yieldBetween:   cfg.YieldBetween,
		now:            now,
	}
}

// Register adds a source. Sources can be added before or after Run starts.
func (s *Scheduler) Register(src Source) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sources = append(s.sources, src)
	sort.SliceStable(s.sources, func(i, j int) bool {
		return s.sources[i].Priority() < s.sources[j].Priority()
	})
}

// Status returns a snapshot of the last completed tick.
func (s *Scheduler) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := s.status
	cp.IdleSources = append([]string(nil), s.status.IdleSources...)
	cp.BusySources = append([]string(nil), s.status.BusySources...)
	return cp
}

// Tick runs one scheduling tick: walk sources in priority order, allow
// each to consume budget until the deadline expires or all sources are
// idle. Returns nil normally; returns the first fatal source error if any.
func (s *Scheduler) Tick(ctx context.Context) error {
	s.mu.Lock()
	sources := append([]Source(nil), s.sources...)
	s.mu.Unlock()

	budget := &Budget{
		FsOps:     s.fsOps,
		HashBytes: s.hashBytes,
		Deadline:  s.now().Add(s.maxWorkPerTick),
	}

	idle := make([]string, 0, len(sources))
	busy := make([]string, 0, len(sources))
	var firstErr error

	for _, src := range sources {
		more := true
		didWork := false
		for more {
			if ctx.Err() != nil {
				firstErr = ctx.Err()
				break
			}
			if budget.Expired(s.now()) {
				break
			}
			var err error
			more, err = src.RunOne(ctx, budget)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				break
			}
			if more {
				didWork = true
			} else {
				break
			}
		}
		if didWork {
			busy = append(busy, src.Name())
		} else {
			idle = append(idle, src.Name())
		}
		if budget.Expired(s.now()) {
			break
		}
	}

	s.mu.Lock()
	s.status = Status{IdleSources: idle, BusySources: busy, LastTickError: firstErr}
	s.mu.Unlock()
	return firstErr
}

// Run loops Tick with a yield between ticks until ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.Tick(ctx); err != nil && err != context.Canceled && err != context.DeadlineExceeded {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.yieldBetween):
		}
	}
}
