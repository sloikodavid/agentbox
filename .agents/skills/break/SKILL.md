---
name: break
description: Use when the user wants adversarial testing - brute-force a module, exploit edge cases, fuzz behavior, stress performance, prove production readiness, harden code, or write many temporary tests to intentionally break something before keeping only clean coverage.
---

# Break

Try to break the thing on purpose.

This skill is for adversarial validation, not for adding a giant permanent test suite. The goal is to discover real bugs, fix the important ones when asked, and leave behind the smallest clean coverage that protects the behavior.

## Standard

Do not say something is production-ready because the happy path works.

Production-ready means:

- The public interface has been tested as users/callers actually use it.
- Important invariants are named and attacked directly.
- Edge cases are not guessed; they are turned into executable probes.
- Temporary brute-force tests are deleted or distilled before finishing.
- Permanent tests cover behavior, not implementation trivia.
- Performance cliffs and resource risks are attacked with realistic stress probes.
- Remaining risk is stated plainly.

## Workflow

### 1. Identify the contract

Inspect the code before writing tests.

Find:

- Public interface: functions, classes, CLI commands, endpoints, files, schemas, config, env vars.
- Observable behavior: outputs, side effects, persisted data, network calls, process lifecycle, errors.
- Invariants: what must always be true.
- Exclusions and boundaries: paths, auth, permissions, scopes, feature flags, unsupported cases.
- Compatibility: old data, old config, old CLI behavior, migration behavior.
- Dependencies: filesystems, runtimes, SDKs, databases, queues, browsers, clocks, random sources, networks.
- Network contract: protocols, methods, headers, auth, redirects, proxies, TLS, retries, timeouts, streaming, backpressure, idempotency, rate limits, and partial responses.
- Performance envelope: expected input sizes, concurrency, latency budget, memory budget, startup cost, steady-state cost, and known PaaS/container limits.

If any dependency behavior matters and could have changed, use the `research` skill first.

### 2. Build an attack matrix

List concrete ways the module might be wrong. Include the boring cases and the weird cases.

Use categories that fit the module:

- Boundary inputs: empty, huge, unicode, paths, dot segments, case sensitivity, symlinks, invalid IDs.
- State transitions: create/update/delete/recreate, type replacement, stale state, migrations.
- Ordering: startup, shutdown, retries, idempotency, double calls, partial calls.
- Concurrency: overlapping public calls, racing writes, cancellation, background work.
- Persistence: stale data, tombstones, manifests, restore semantics, backward compatibility.
- Exclusions: exact excluded values, descendants, similar prefixes that should not be excluded.
- Failure modes: dependency errors, permission errors, missing files, corrupt data, timeout, partial success.
- Networking: DNS failure, connection refusal, connection reset, slowloris, half-closed sockets, TLS errors, proxy headers, redirects, retries, duplicate requests, out-of-order responses, streaming interruption, malformed responses, large responses, rate limits.
- Resource pressure: many files/items, deep trees, large payloads, event storms, rate limits.
- Performance cliffs: algorithmic blowups, sequential bottlenecks, unbounded queues, memory growth, repeated full scans, N+1 I/O, excessive logging, slow startup, slow shutdown.
- Security boundaries: escaping roots/scopes, confused deputy, following links, using stale trust.
- Type replacements: file to directory, directory to file, symlink to file, object shape changes.
- Time: same timestamp, clock skew, TTL boundaries, debounce windows.

Prioritize tests that would cause user-visible data loss, security issues, corruption, startup failure, false readiness, runaway resource use, or unacceptable latency.

### 3. Write temporary adversarial tests

Create a temporary test file when the probe count would bloat the real suite.

Good temporary names:

- `tests/<thing>.break.test.ts`
- `tests/<thing>.adversarial.test.ts`
- `tests/<thing>.fuzz.test.ts`

Rules:

- Prefer the public interface. Do not test private helpers unless there is no public seam.
- Prefer real local substitutes: temp dirs, local servers, in-memory stores, fake clocks.
- Do not mock modules the project owns unless there is a real seam.
- Make fuzz deterministic with explicit seeds.
- Add dozens of probes if useful, but keep each probe tied to a named invariant.
- Include at least one model/property-style test when the domain has a natural model.
- Tests should fail for real behavior bugs, not platform quirks. Skip or branch for OS-specific semantics when needed.
- Add stress probes for performance-sensitive paths, but keep them bounded and deterministic enough to run locally.
- Measure wall time, counts, memory, or operation volume when that evidence would change the design. Avoid brittle microbenchmarks unless the user explicitly asks for benchmarking.

A good invariant test shape:

```text
setup live/user-visible state
exercise only public interface
observe result through public interface or durable side effect
assert final behavior, not internal call order
```

### 4. Stress performance deliberately

Performance testing here is not benchmark theatre. It is looking for cliffs that would surprise production.

Probe:

- 10x and 100x common-case sizes.
- Deep nesting.
- Wide fanout.
- Large payloads.
- Slow or flaky network responses.
- Streaming bodies and backpressure.
- Repeated calls.
- Concurrent calls.
- Startup with existing data.
- Shutdown with in-flight work.
- Retry loops and failure storms.

Watch for:

- O(n²) behavior where O(n) is expected.
- Full scans triggered by tiny changes.
- Unbounded memory or queue growth.
- Too many filesystem/database/network operations.
- Long event-loop stalls.
- Leaked timers, watchers, handles, temp files, or child processes.
- Logs or metrics becoming the bottleneck.

Keep only durable performance coverage:

- A small regression test for a proven cliff.
- A bounded smoke stress test if it is fast and non-flaky.
- A documented manual benchmark command if runtime varies too much for CI.

### 5. Run, exploit, and reduce

Run the temporary suite repeatedly while fixing or classifying failures.

For each failure:

- Confirm it is a real product bug, not a bad test.
- Minimize the reproduction.
- Fix the behavior at the module that owns the invariant.
- Avoid adding abstraction just to satisfy the test.
- Re-run targeted tests, then broader checks.

If the user only asked for a review, do not edit. Return the exploit tests and findings instead.

If the user asked to harden/fix, make the smallest clean fixes that protect the contract.

### 6. Promote only clean coverage

Before finishing:

- Delete the temporary brute-force file unless the user explicitly wants it kept.
- Promote only high-value regressions into the permanent suite.
- Keep permanent tests compact and behavior-focused.
- Do not leave dozens of near-duplicate edge-case tests.
- Do not keep tests that freeze implementation details.
- Do not add production knobs, logs, adapters, or dependencies unless the bug proves they are needed.

Permanent tests should usually include:

- One or two representative edge cases per invariant.
- One regression for each real bug fixed.
- One small model/property test only if it stays fast and deterministic.

### 7. Validate like it matters

Run the strongest relevant checks:

- Typecheck.
- Targeted tests.
- Full test suite when feasible.
- Lint/format if code changed.
- Build or smoke test when lifecycle/deployment behavior changed.
- Bounded stress/performance probe when performance or resource behavior changed.

If a check cannot run, say why and name the next-best substitute.

## Output

Report concisely:

- **Temporary attack coverage** - how many probes and what categories.
- **Bugs found** - real failures, root cause, fix.
- **Permanent coverage kept** - which tests were promoted and why.
- **Performance evidence** - stress probes run, cliffs found or ruled out, remaining limits.
- **Bloat removed** - temporary files deleted, duplicate probes not kept.
- **Validation** - exact commands and results.
- **Residual risk** - what is still not proven and why.

Do not claim 100% certainty. Say what was proven, what was stress-tested, and what remains inherently best-effort.
