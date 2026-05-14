package scheduler

import (
	"context"
	"sync"
)

// DirtyQueue is the bounded FIFO of watcher-emitted dirty paths. The
// scheduler drives it as a Source. The queue itself is concurrent-safe
// and may be enqueued from any goroutine (the watcher).
type DirtyQueue struct {
	mu       sync.Mutex
	paths    []string
	seen     map[string]struct{}
	maxSize  int
	overflow int
}

// NewDirtyQueue returns a queue with the given maximum size. Enqueue past
// max increments the overflow counter and drops the new entry; rolling
// audit will still discover the path.
func NewDirtyQueue(maxSize int) *DirtyQueue {
	if maxSize <= 0 {
		maxSize = 4096
	}
	return &DirtyQueue{
		seen:    map[string]struct{}{},
		maxSize: maxSize,
	}
}

// Enqueue adds a path. Duplicate adjacent paths are collapsed via the
// seen-set to avoid storming on a hot file. Reports whether the path was
// newly accepted.
func (q *DirtyQueue) Enqueue(path string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.seen[path]; ok {
		return false
	}
	if len(q.paths) >= q.maxSize {
		q.overflow++
		return false
	}
	q.paths = append(q.paths, path)
	q.seen[path] = struct{}{}
	return true
}

// Len reports the current backlog.
func (q *DirtyQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.paths)
}

// OverflowCount returns how many enqueues were dropped due to the cap.
func (q *DirtyQueue) OverflowCount() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.overflow
}

// Dequeue removes and returns the next path, or "" when empty.
func (q *DirtyQueue) Dequeue() (string, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.paths) == 0 {
		return "", false
	}
	p := q.paths[0]
	q.paths = q.paths[1:]
	delete(q.seen, p)
	return p, true
}

// DirtySource turns a DirtyQueue into a Scheduler Source. Each RunOne
// processes one path through the supplied handler.
type DirtySource struct {
	queue    *DirtyQueue
	priority int
	handler  func(ctx context.Context, path string) error
}

// NewDirtySource wires the dirty queue into the scheduler. priority should
// be lower (higher priority) than audit.
func NewDirtySource(queue *DirtyQueue, priority int, handler func(ctx context.Context, path string) error) *DirtySource {
	return &DirtySource{queue: queue, priority: priority, handler: handler}
}

// Name implements Source.
func (d *DirtySource) Name() string { return "dirty" }

// Priority implements Source.
func (d *DirtySource) Priority() int { return d.priority }

// RunOne implements Source. Each call drains one path against one fs-op
// token. Returns more=true only when work made forward progress and the
// queue still has entries; budget exhaustion yields without spinning.
func (d *DirtySource) RunOne(ctx context.Context, budget *Budget) (bool, error) {
	if !budget.FsOps.TryTake(1) {
		return false, nil
	}
	path, ok := d.queue.Dequeue()
	if !ok {
		return false, nil
	}
	if d.handler != nil {
		if err := d.handler(ctx, path); err != nil {
			return false, err
		}
	}
	return d.queue.Len() > 0, nil
}
