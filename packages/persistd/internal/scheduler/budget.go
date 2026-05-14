// Package scheduler owns the single token-budgeted loop that drives all
// persistd background work: dirty watcher paths, rolling audit, DB
// verification, and object garbage collection. The contract is that no
// source ever spikes CPU to catch up; lag grows instead.
package scheduler

import (
	"sync"
	"time"
)

// TokenBucket is a classic refilling bucket. Capacity caps the burst size;
// refill happens lazily on access proportional to elapsed time.
type TokenBucket struct {
	mu        sync.Mutex
	capacity  float64
	rate      float64 // tokens per second
	tokens    float64
	lastFill  time.Time
	now       func() time.Time
}

// NewTokenBucket constructs a bucket with the given capacity and refill
// rate. now is optional and defaults to time.Now; tests inject a fake clock.
func NewTokenBucket(capacity, ratePerSec float64, now func() time.Time) *TokenBucket {
	if now == nil {
		now = time.Now
	}
	return &TokenBucket{
		capacity: capacity,
		rate:     ratePerSec,
		tokens:   capacity,
		lastFill: now(),
		now:      now,
	}
}

func (b *TokenBucket) refill() {
	now := b.now()
	elapsed := now.Sub(b.lastFill).Seconds()
	if elapsed <= 0 {
		return
	}
	b.tokens += elapsed * b.rate
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.lastFill = now
}

// TryTake consumes n tokens if available. Returns false without consuming
// otherwise.
func (b *TokenBucket) TryTake(n float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	if b.tokens < n {
		return false
	}
	b.tokens -= n
	return true
}

// Available returns the current number of tokens, refilled to the call time.
func (b *TokenBucket) Available() float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	return b.tokens
}

// Budget bundles the per-tick scheduling constraints handed to a Source.
type Budget struct {
	FsOps     *TokenBucket
	HashBytes *TokenBucket
	// Deadline marks when the current tick must yield even if budget
	// remains. Sources should periodically check time.Now() against this.
	Deadline time.Time
}

// Expired reports whether the deadline has passed.
func (b *Budget) Expired(now time.Time) bool {
	return !b.Deadline.IsZero() && !now.Before(b.Deadline)
}
