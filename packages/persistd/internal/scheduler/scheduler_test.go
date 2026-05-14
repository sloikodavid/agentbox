package scheduler

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestTokenBucket_TryTakeRespectsCapacity(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	b := NewTokenBucket(5, 10, clock)
	if !b.TryTake(5) {
		t.Fatal("first take should succeed")
	}
	if b.TryTake(1) {
		t.Fatal("bucket should be empty")
	}
	now = now.Add(500 * time.Millisecond) // 0.5s at 10/s = 5 tokens
	if !b.TryTake(5) {
		t.Fatal("expected refill to provide 5 tokens after 500ms")
	}
}

func TestTokenBucket_CannotExceedCapacity(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(10, 5, func() time.Time { return now })
	now = now.Add(time.Hour) // would refill 18000 tokens if uncapped
	if avail := b.Available(); avail > 10 {
		t.Errorf("available = %v, want <= 10", avail)
	}
}

type fakeSource struct {
	name        string
	priority    int
	calls       atomic.Int64
	workRemaining atomic.Int64
	consumeOps  int
}

func (f *fakeSource) Name() string   { return f.name }
func (f *fakeSource) Priority() int  { return f.priority }
func (f *fakeSource) RunOne(_ context.Context, budget *Budget) (bool, error) {
	f.calls.Add(1)
	if f.consumeOps > 0 && !budget.FsOps.TryTake(float64(f.consumeOps)) {
		return false, nil
	}
	f.workRemaining.Add(-1)
	return f.workRemaining.Load() > 0, nil
}

func TestScheduler_HigherPriorityRunsFirst(t *testing.T) {
	dirty := &fakeSource{name: "dirty", priority: 10, consumeOps: 1}
	audit := &fakeSource{name: "audit", priority: 100, consumeOps: 1}
	dirty.workRemaining.Store(2)
	audit.workRemaining.Store(10)

	s := New(Config{
		MaxFsOpsPerSecond:     2, // only enough budget for dirty
		MaxHashBytesPerSecond: 1e9,
		MaxWorkPerTick:        10 * time.Millisecond,
	}, nil)
	s.Register(audit)
	s.Register(dirty)

	if err := s.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if dirty.calls.Load() == 0 {
		t.Error("dirty source should have been served")
	}
	if dirty.workRemaining.Load() != 0 {
		t.Errorf("dirty workRemaining = %d, want 0", dirty.workRemaining.Load())
	}
	if audit.workRemaining.Load() != 10 {
		t.Errorf("audit should not have consumed budget while dirty held priority; remaining=%d", audit.workRemaining.Load())
	}
}

func TestScheduler_BudgetExhaustionGrowsBacklog(t *testing.T) {
	audit := &fakeSource{name: "audit", priority: 100, consumeOps: 1}
	audit.workRemaining.Store(1000)

	s := New(Config{
		MaxFsOpsPerSecond:     5,
		MaxHashBytesPerSecond: 1e9,
		MaxWorkPerTick:        time.Second,
	}, nil)
	s.Register(audit)
	if err := s.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	// Budget caps work at 5 ops; the remaining 995 stays as backlog.
	if remaining := audit.workRemaining.Load(); remaining < 990 {
		t.Errorf("scheduler did not respect budget: remaining=%d (expected ~995)", remaining)
	}
}

func TestScheduler_TickRespectsDeadline(t *testing.T) {
	slow := &slowSource{name: "slow", priority: 50, sleep: 5 * time.Millisecond}
	s := New(Config{
		MaxFsOpsPerSecond:     1000,
		MaxHashBytesPerSecond: 1e9,
		MaxWorkPerTick:        12 * time.Millisecond,
	}, nil)
	s.Register(slow)
	start := time.Now()
	if err := s.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if took := time.Since(start); took > 50*time.Millisecond {
		t.Errorf("Tick honored deadline poorly: %s", took)
	}
}

type slowSource struct {
	name     string
	priority int
	sleep    time.Duration
	calls    atomic.Int64
}

func (s *slowSource) Name() string  { return s.name }
func (s *slowSource) Priority() int { return s.priority }
func (s *slowSource) RunOne(ctx context.Context, _ *Budget) (bool, error) {
	s.calls.Add(1)
	select {
	case <-time.After(s.sleep):
	case <-ctx.Done():
	}
	return true, nil
}

func TestDirtyQueue_DedupesAndCapsBacklog(t *testing.T) {
	q := NewDirtyQueue(3)
	if !q.Enqueue("/a") {
		t.Fatal("first enqueue should accept")
	}
	if q.Enqueue("/a") {
		t.Error("duplicate enqueue should be rejected")
	}
	q.Enqueue("/b")
	q.Enqueue("/c")
	if q.Enqueue("/d") {
		t.Error("enqueue past cap should be rejected")
	}
	if q.OverflowCount() != 1 {
		t.Errorf("overflow = %d, want 1", q.OverflowCount())
	}
	if q.Len() != 3 {
		t.Errorf("len = %d, want 3", q.Len())
	}
}

func TestDirtyQueue_DequeueFIFO(t *testing.T) {
	q := NewDirtyQueue(8)
	q.Enqueue("/a")
	q.Enqueue("/b")
	if p, _ := q.Dequeue(); p != "/a" {
		t.Errorf("first dequeue = %q, want /a", p)
	}
	if p, _ := q.Dequeue(); p != "/b" {
		t.Errorf("second dequeue = %q, want /b", p)
	}
	if _, ok := q.Dequeue(); ok {
		t.Error("empty queue should return false")
	}
}

func TestDirtySource_RunsPathsThroughHandler(t *testing.T) {
	q := NewDirtyQueue(8)
	q.Enqueue("/a")
	q.Enqueue("/b")
	var got []string
	src := NewDirtySource(q, 10, func(_ context.Context, p string) error {
		got = append(got, p)
		return nil
	})
	s := New(Config{MaxFsOpsPerSecond: 10, MaxHashBytesPerSecond: 1e9, MaxWorkPerTick: 100 * time.Millisecond}, nil)
	s.Register(src)
	_ = s.Tick(context.Background())
	if len(got) != 2 || got[0] != "/a" || got[1] != "/b" {
		t.Errorf("handler saw %v, want [/a /b]", got)
	}
	if q.Len() != 0 {
		t.Errorf("queue not drained: %d", q.Len())
	}
}

func TestScheduler_StatusReportsBacklog(t *testing.T) {
	audit := &fakeSource{name: "audit", priority: 100, consumeOps: 1}
	audit.workRemaining.Store(5)
	s := New(Config{MaxFsOpsPerSecond: 100, MaxHashBytesPerSecond: 1e9, MaxWorkPerTick: 50 * time.Millisecond}, nil)
	s.Register(audit)
	_ = s.Tick(context.Background())
	st := s.Status()
	if len(st.BusySources) == 0 && len(st.IdleSources) == 0 {
		t.Error("status should report sources")
	}
}
