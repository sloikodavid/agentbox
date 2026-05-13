# Research: Production-grade file watching/sync architectures that avoid CPU spikes

## Summary

Production systems avoid CPU spikes by treating filesystem events as hints, not truth: they keep an indexed snapshot, process bounded/coalesced event batches, and repair uncertainty with targeted scans or occasional full recrawls. The strongest designs combine monotonic clocks/cookies or version vectors, incremental scans over changed subtrees, concurrency limits, and explicit overflow/degradation paths that trade latency for correctness rather than spinning.

## Findings

1. **Watchman's core pattern is "indexed tree + event stream + clocked incremental queries + recrawl repair."** Watchman maintains in-memory indexes over the watched tree so queries do not crawl in real time, and its `since` generator returns files modified since a clockspec; this lets clients persist the last `clock` and ask only for deltas after reconnect. [Watchman File Queries](https://facebook.github.io/watchman/docs/file-query), [Watchman subscribe](https://facebook.github.io/watchman/docs/cmd/subscribe)

2. **Watchman uses cookies to make asynchronous event streams query-consistent.** For a query or synced clock, it writes a temporary cookie file under an observed directory, waits until the notify thread observes that cookie, and then knows earlier events in the ordered notification stream have been processed. On macOS FSEvents this guarantee is weaker under high load, so Watchman exposes settle windows as a fallback. [Watchman Query Synchronization](https://facebook.github.io/watchman/docs/cookies), [Watchman clock](https://facebook.github.io/watchman/docs/cmd/clock)

3. **Watchman's overflow strategy prefers expensive but bounded correctness over silent drift.** If Linux inotify `max_queued_events` overflows, Watchman receives `IN_Q_OVERFLOW`, assumes all files may have changed, and recrawls the tree to resynchronize. This avoids missed changes but causes spurious notifications and downstream work, so production deployments raise inotify limits and avoid frequent recrawls. [Watchman Troubleshooting](https://facebook.github.io/watchman/docs/troubleshooting), [Watchman Installation / inotify limits](https://facebook.github.io/watchman/docs/install)

4. **Watchman backpressure is built into triggers/subscriptions.** It waits for filesystem settling and VCS locks before firing, batches file lists, runs only one trigger instance at a time, re-evaluates from the prior spawn clock, and marks `WATCHMAN_FILES_OVERFLOW=true` if file arguments/stdin are truncated. Advanced subscriptions can `defer` or `drop` updates during known bulk operations. [Watchman trigger](https://facebook.github.io/watchman/docs/cmd/trigger.html), [Watchman subscribe](https://facebook.github.io/watchman/docs/cmd/subscribe)

5. **Syncthing uses watchers for latency but still schedules randomized full scans for repair.** It detects local changes through regular full scans plus filesystem notifications; by default watchers are enabled and full scans run hourly, randomized between 3/4 and 5/4 of the interval to avoid all folders scanning at once. Even with watchers, Syncthing recommends keeping full scans because some changes may be missed. [Syncthing Understanding Synchronization](https://docs.syncthing.net/v1.29.3/users/syncing)

6. **Syncthing bounds scan and hash work by first checking metadata and only hashing changed files.** During scans, it compares modtime, size, and permissions; only changed files are rehashed into block lists. The scanner code walks either the full root or requested subpaths, skips ignored/internal/temp files, compares against current index entries, and feeds modified regular files to a configurable parallel hasher queue. [Syncthing Understanding Synchronization](https://docs.syncthing.net/v1.29.3/users/syncing), [Syncthing scanner source](https://github.com/syncthing/syncthing/blob/main/lib/scanner/walk.go)

7. **Syncthing's incremental snapshot is its index database plus block lists/version vectors.** Each file is represented by metadata, version vector, sequence number, and block hashes. Syncing compares local and global versions, requests or locally copies only missing blocks, and verifies SHA-256 before writing. Conflicts are explicit files, not implicit overwrites. [Syncthing Understanding Synchronization](https://docs.syncthing.net/v1.29.3/users/syncing)

8. **Syncthing exposes resource knobs that are directly useful for CPU-spike avoidance.** It recommends filesystem notifications to avoid I/O-heavy scans, but also supports limiting folder concurrency, hashers, copiers, pending KiB, concurrent writes, scan progress events, and even Go scheduler/GC settings for low-resource systems. [Syncthing Configuration Tuning](https://docs.syncthing.net/users/tuning.html)

9. **Mutagen's sync loop is snapshot/reconcile/apply, with watches only triggering cycles.** Each cycle scans both endpoints, reconciles endpoint snapshots with an ancestor snapshot via a three-way merge, stages updates, and applies changes. Its architecture is designed so events trigger cycles, but correctness lives in scan snapshots and reconciliation state. [Mutagen File synchronization](https://mutagen.io/documentation/synchronization/)

10. **Mutagen deliberately degrades from native recursive watching to polling to avoid descriptor exhaustion.** On macOS/Windows it uses native recursive watches plus cheap root polling to detect root deletion/recreation. On Linux/BSD it avoids per-file/per-directory descriptor explosion by using polling, with Linux native watches only on recently updated contents for low-latency common cases. [Mutagen Watching](https://mutagen.io/documentation/synchronization/watching/)

11. **Mutagen's accelerated scans are a production example of bounded reconciliation.** With native recursive watching, it tracks changed paths and rescans only those files and parent directories; with poll-based watching it reuses the polling-generated snapshot; without watching it falls back to full scan. It notes that even slightly outdated accelerated snapshots preserve safety because apply-time algorithms detect conflicts missed by the snapshot. [Mutagen Probing and scanning](https://mutagen.io/documentation/synchronization/probing-and-scanning)

12. **Mutagen limits blast radius through modes, safety halts, staging choices, ignores, and entry/size caps.** Safe modes refuse data-losing automatic conflict resolution; root deletion/emptying/type-change can halt the session; staged files can be placed near the sync root for atomic/fast relocation; ignored paths are not scanned; and `maxEntryCount` / `maxStagingFileSize` can bound pathological trees or huge transfers. [Mutagen File synchronization](https://mutagen.io/documentation/synchronization/), [Mutagen Safety mechanisms](https://mutagen.io/documentation/synchronization/safety-mechanisms), [Mutagen Staging](https://mutagen.io/documentation/synchronization/staging/), [Mutagen Ignores](https://mutagen.io/documentation/synchronization/ignores/), [Mutagen Size limits](https://mutagen.io/documentation/synchronization/size-limits/)

13. **Lsyncd shows the classic inotify+rsync batching pattern: collate, delay, run bounded processes, periodically repair.** Lsyncd watches with inotify/FSEvents, collates events for several seconds, then spawns rsync processes. Its default rsync mode aggregates up to `delay` seconds or 1000 uncollapsible events and sends an include list to rsync; configs can set `maxProcesses`, `maxDelays`, and scheduled periodic full syncs. [Lsyncd overview](https://lsyncd.github.io/lsyncd/), [Lsyncd default config](https://lsyncd.github.io/lsyncd/manual/config/layer4/)

14. **Lsyncd's "inlet" abstraction is a useful backpressure/coalescing lesson.** Rather than one process per event, an action can pull all ready events, emit one rsync invocation with a path list, retry failed batches after a delay, and use a startup "blanket event" to block normal events until an initial full sync completes. The docs warn that fetching huge event lists itself can be CPU-heavy. [Lsyncd Config Layer 1: Inlets](https://lsyncd.github.io/lsyncd/manual/config/layer1/)

15. **Chokidar is useful at the app edge, but not a full reconciliation architecture.** It normalizes noisy platform events, defaults to `fs.watch` to avoid polling CPU, supports path filters/depth limits, and has `awaitWriteFinish` for chunked writes and `atomic` for temp-file rename patterns. However, its own docs warn recursive watching consumes resources and `awaitWriteFinish` polls file size, reducing responsiveness; use it as a frontend signaler behind debouncing/snapshot verification. [Chokidar README](https://github.com/paulmillr/chokidar)

16. **Atomic writers should serialize same-file writes and expect delete+rename event shapes.** `write-file-atomic` writes a unique temp file, fsyncs by default, renames it into place, cleans up on error, and queues concurrent writes to the same filename while allowing different files in parallel. Watchers must therefore collapse temp-file/add/unlink/rename sequences into a single logical change or rescan the final path. [write-file-atomic README](https://github.com/npm/write-file-atomic)

## Design lessons

- **Use events as invalidations, not authoritative state.** Maintain a snapshot/index and treat watcher events as a dirty-path set that schedules bounded scans.
- **Have a repair path for every lost-confidence state.** Queue overflow, root deletion/recreation, watcher failure, missed events, and stale snapshots should trigger either a targeted subtree rescan, a full recrawl, or a halted session requiring user action.
- **Track progress with clocks or versions.** Watchman clocks/cookies, Syncthing version vectors/sequence numbers, and Mutagen ancestor snapshots all prevent "what did I miss?" ambiguity after reconnects and crashes.
- **Coalesce before doing work.** Debounce for a short settle period, batch changed paths, drop/defer during known bulk operations, and run at most a bounded number of workers/processes.
- **Bound the expensive stages.** Limit hashers/copiers/processes/concurrent writes, file-list size, entry count, staging size, watch depth, and ignored directories such as `.git`, `node_modules`, build outputs, and temp namespaces.
- **Prefer targeted scans but schedule jittered audits.** Use dirty subpaths and parent directories for low latency; keep randomized periodic full scans/recrawls for watcher unreliability.
- **Separate detection from reconciliation.** Detection says "something changed"; reconciliation compares old snapshot, new snapshot, and peer/ancestor state to produce a small, safe change set.
- **Make overflow visible to downstream tools.** Expose warnings, overflow flags, and "fresh instance" states so clients can choose to requery, rebuild broadly, or avoid trusting truncated lists.
- **Handle atomic/chunked writes explicitly.** Expect temp files and rename swaps; wait for stability only when necessary, and prefer final stat/hash verification over reacting to every intermediate write event.

## Sources

- Kept: Watchman Query Synchronization (https://facebook.github.io/watchman/docs/cookies) - primary explanation of cookie-based consistency.
- Kept: Watchman subscribe (https://facebook.github.io/watchman/docs/cmd/subscribe) - clocks, `since`, settle, defer/drop subscription behavior.
- Kept: Watchman trigger (https://facebook.github.io/watchman/docs/cmd/trigger.html) - batching, single trigger instance, overflow env var.
- Kept: Watchman File Queries (https://facebook.github.io/watchman/docs/file-query) - indexed query generators and incremental `since` model.
- Kept: Watchman Troubleshooting / Installation (https://facebook.github.io/watchman/docs/troubleshooting, https://facebook.github.io/watchman/docs/install) - inotify overflow, recrawl, limits.
- Kept: Syncthing Understanding Synchronization (https://docs.syncthing.net/v1.29.3/users/syncing) - scanning, full scans plus watchers, block lists, versioning, temp writes.
- Kept: Syncthing scanner source (https://github.com/syncthing/syncthing/blob/main/lib/scanner/walk.go) - concrete walker/hasher queue and metadata comparison implementation.
- Kept: Syncthing Configuration Tuning (https://docs.syncthing.net/users/tuning.html) - resource and concurrency controls.
- Kept: Mutagen File synchronization / Watching / Probing and scanning (https://mutagen.io/documentation/synchronization/, https://mutagen.io/documentation/synchronization/watching/, https://mutagen.io/documentation/synchronization/probing-and-scanning) - core cycle, watcher fallback, accelerated scans.
- Kept: Mutagen Safety / Staging / Ignores / Size limits (https://mutagen.io/documentation/synchronization/safety-mechanisms, https://mutagen.io/documentation/synchronization/staging/, https://mutagen.io/documentation/synchronization/ignores/, https://mutagen.io/documentation/synchronization/size-limits/) - bounded operation and failure containment.
- Kept: Mutagen reconcile source (https://github.com/mutagen-io/mutagen/blob/master/pkg/synchronization/core/reconcile.go) - implementation evidence for recursive three-way reconciliation.
- Kept: Lsyncd overview / inlets / default config (https://lsyncd.github.io/lsyncd/, https://lsyncd.github.io/lsyncd/manual/config/layer1/, https://lsyncd.github.io/lsyncd/manual/config/layer4/) - inotify+rsync batching, delay, process limits, periodic full sync.
- Kept: Chokidar README (https://github.com/paulmillr/chokidar) - edge watcher normalization, polling warnings, atomic/chunked write options.
- Kept: write-file-atomic README (https://github.com/npm/write-file-atomic) - temp+rename atomic write behavior and same-file serialization.
- Dropped: StackOverflow Watchman/chokidar issue answers - useful anecdotes but secondary and less authoritative than official docs/source.
- Dropped: Syncthing Medium article by Jakob Borg - informative but redundant with current official docs/source for this brief.
- Dropped: Watchexec inotify limits docs - good generic inotify explanation but redundant with Watchman's own inotify guidance.
- Dropped: Docker-sync Mutagen issue discussion - anecdotal and not needed after primary Mutagen docs/source.

## Gaps

- Exact internal scheduling heuristics for Watchman recrawl throttling and Mutagen polling implementation details were not fully documented in public user docs; source-level review could refine those.
- Quantitative CPU benchmarks across these systems were not found in authoritative sources during this pass. Next step would be controlled benchmarks with synthetic event storms, large ignored directories, and atomic-write workloads.
