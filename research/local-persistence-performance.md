# Local persistence performance/design review

## Scope reviewed

Local source and current diff only. No source edits were made.

Relevant current files:

- `rootfs/opt/agentbox/persistence/watch.ts`.
- `rootfs/opt/agentbox/persistence/reconcile.ts`.
- `rootfs/opt/agentbox/persistence/index.ts`.
- `rootfs/opt/agentbox/persistence/rootfs.ts`.
- `rootfs/opt/agentbox/persistence/copy.ts`.
- `rootfs/opt/agentbox/defaults.ts`.
- `tests/persistence.test.ts`.

The diff currently introduces reconciliation/repair around persistence. Staged work added scoped/root reconciliation and periodic full reconciliation; unstaged work switches startup/periodic full reconciliation to `repairPersistedRootfs()` and extends the interval from `60_000` to `600_000` ms.

## Why reconciliation spiked CPU

The expensive shape is a full root reconciliation, especially when called at watch startup or on an interval.

Evidence:

- `watch.ts:297-300` starts the root watcher, recursively inventories root entries, then calls `options.repair()` in the current unstaged version. In the staged version this was `options.reconcile(paths.rootPath)`, which is the main CPU spike source.
- `watch.ts:311-315` runs a periodic full repair. In the staged version this was `reconcileSafely(paths.rootPath)` every full interval.
- `reconcile.ts:31-52` implements `reconcileRootfs()`. For `paths.rootPath`, `collectLiveEntries()` recursively walks every persistable live root entry (`reconcile.ts:106-147`) and `collectStaleStoredEntries()` walks the stored mirror (`reconcile.ts:169-220`).
- For every live entry, `shouldRecordPresentEntry()` does live and stored `lstat()` calls and sometimes `readlink()` (`reconcile.ts:222-264`). A root scope therefore means O(live-root entries + stored-mirror entries) filesystem syscalls plus JS path work.
- `rootfs.ts:95-112` recomputes/resolves the exclusion list on every `shouldPersist()` call. During a root walk this multiplies path resolution/string work across the whole image tree.
- `watch.ts:354-388` also recursively walks directories to install non-recursive watchers. That is a separate startup cost, but it compounds with a full root reconciliation if both happen at startup.

Design issue: the live root contains the image baseline, not just user changes. A full root reconciliation treats the image as the discovery universe, so it repeatedly proves that a huge number of unchanged baseline files do not need persistence. That is exactly the work to avoid.

## Useful existing information to piggyback

### Stored mirror

- Stored files live under `paths.filesPath` (`rootfs.ts:44-53`) and are addressed by `storedPathForLivePath()` (`rootfs.ts:161-166`).
- The mirror contains persisted deltas, not the whole image baseline. It is therefore a much smaller and semantically better repair universe than `/`.
- Current unstaged `repairPersistedRootfs()` already uses this idea: it walks `options.paths.filesPath`, checks only the live counterpart for each stored entry, and records changes/removals (`reconcile.ts:54-79`).
- Caveat: the current implementation still materializes all stored entries, all live entries, and sorts them (`reconcile.ts:57-69`). For a large persisted tree this is less bad than a root walk but still spiky.

### Tombstones / removal markers

- Removals are stored in `paths.removedFilesPath` using `.__removed__` marker files (`rootfs.ts:11`, `rootfs.ts:134-140`, `rootfs.ts:168-182`).
- Stores clear relevant removal markers via `unmarkRemoved()` (`rootfs.ts:143-159`, `index.ts:206`).
- Restore applies markers through `applyRemovalMarkers()` (`rootfs.ts:185-206`).
- Repair should scan tombstones too, not only `filesPath`: a missed recreate of a previously removed path can be detected by checking whether the tombstoned live path now exists, then recording it present and clearing the tombstone. If it still does not exist, the marker is already the desired state.

### Hardlink map

- `PersistenceImpl` has an in-memory `hardlinks` map (`index.ts:58`) keyed by live `dev:ino` and used while storing files (`index.ts:187-203`).
- `copyPersistedRoot()` reconstructs hardlinks during restore using stored file `dev:ino` groups (`copy.ts:25-61`).
- `shouldRecordPresentEntry()` currently returns true for every multi-link live file (`reconcile.ts:260-262`), so periodic repair can repeatedly recopy/relink unchanged hardlinked files. Use the hardlink map/stored mirror groups as a targeted optimization instead of forcing every hardlink through `record()` on every pass.
- Limitation: a new hardlink path that was never stored/tombstoned cannot be found without either a watcher event for that path or scanning the live tree containing it.

### Watcher dirty paths

- Watch events are accumulated in `dirtyScopes` (`watch.ts:37`) and collapsed before reconciliation (`watch.ts:108-114`, `watch.ts:334-351`).
- Current unstaged event handling schedules the exact changed path for present and removed entries (`watch.ts:171-185`). This is the right direction: a file change should not reconcile the parent directory or root just to discover siblings.
- Current root-entry polling still schedules `paths.rootPath` for some top-level file/catch cases (`watch.ts:243-249`). Those should become exact `livePath` candidates where possible; otherwise a single top-level file change can reintroduce root-scope reconciliation.

### Heartbeat

- Heartbeat already includes `updatedAt`, `watcherCount`, and `failedWatchers` (`watch.ts:60-68`; `types.ts:12-15`). Readiness accepts extra JSON fields because it only checks those required fields (`gateway/readiness.ts:184-244`).
- This can report repair/backlog state without another coordination channel: e.g. optional `repairPending`, `repairCursor`, `lastRepairAt`, or `lastRepairError` fields.
- Important: heartbeat should be emitted before long repair work and updated between batches. Current startup calls repair before the first `beat()` (`watch.ts:297-318`), so a large repair can delay readiness even if watchers are already active.

## Recommended single non-spiky repair mechanism

Use one bounded candidate-repair pipeline for all repair sources. Do not run full root snapshots on a timer.

### Candidate sources

Feed the same repair queue from:

1. Watcher dirty paths (`dirtyScopes`) with highest priority.
2. Stored mirror entries from `paths.filesPath`, scanned incrementally.
3. Tombstone markers from `paths.removedFilesPath`, scanned incrementally.
4. Watcher failures from heartbeat/status as explicit degraded candidates, if a targeted subtree scan is acceptable for the failed path.

### Candidate operation

For each candidate live path:

- If excluded, prune any stored mirror entry and stale tombstone for that path.
- If live exists:
  - If no stored counterpart, or metadata/content/link target indicates drift, `record({ type: "present", livePath })`.
  - Clear tombstones through existing `unmarkRemoved()` path via `store()`.
  - For directories discovered from a dirty event, enumerate only that dirty directory/subtree, not root.
- If live is missing and stored counterpart exists:
  - `record({ type: "removed", livePath })`, or remove stored subtree without a tombstone when a live non-directory ancestor means the old subtree is structurally impossible.
- If only a tombstone exists and live is still missing, no-op.

### Make it non-spiky

- Process a small time/entry budget per tick, then yield back to the event loop. Example policy: dirty paths first, then up to N mirror/tombstone entries or ~25-50 ms of work, then `setTimeout(..., 0/low interval).unref()`.
- Do not build whole-root or whole-mirror maps. Walk `filesPath`/`removedFilesPath` as async generators and checkpoint cursors.
- Walk the stored mirror top-down. If a stored directory's live counterpart is absent, record the directory removal and skip its stored descendants; `removeStoredPath()` will delete the subtree (`rootfs.ts:124-131`). This avoids the current collect/sort/stale-ancestor pass (`reconcile.ts:57-79`, `reconcile.ts:169-193`).
- Emit heartbeat before repair starts and after each batch. Optional heartbeat fields can expose backlog/cursor without breaking readiness parsing.
- Keep `reconcileRootfs(livePath)` for explicit/manual or scoped dirty-subtree reconciliation, but do not call it with `paths.rootPath` from watch startup or periodic timers.

## Specific recommendations

1. Keep the unstaged direction of replacing watch startup/full root reconciliation with persisted-set repair, but make `repairPersistedRootfs()` incremental. Current one-shot mirror repair is better than root reconciliation but can still spike on large persisted mirrors.
2. Include tombstone scanning in repair. The current repair only walks `paths.filesPath` (`reconcile.ts:57-58`), so tombstone-only paths are not repair candidates.
3. Avoid scheduling root from watcher/root polling. Review `watch.ts:243-249`; schedule exact top-level file paths instead of `paths.rootPath` where possible.
4. Emit heartbeat before startup repair. Current `beat()` is after `options.repair()` (`watch.ts:297-318`), which can delay readiness.
5. Avoid unconditional re-recording of hardlinked files. `reconcile.ts:260-262` makes every hardlink look dirty forever. Piggyback `PersistenceImpl.hardlinks` (`index.ts:58`, `index.ts:187-203`) and/or stored mirror inode groups to distinguish unchanged hardlink topology from actual drift.
6. Cache resolved exclusion roots in `RootfsPaths` or a persistence policy object. `isExcludedPath()` currently rebuilds resolved exclusions per path (`rootfs.ts:95-112`), which is costly during any large scan.
7. Treat missed creation of a never-persisted, never-tombstoned path as an explicit limit. Without a watcher event or a live subtree scan, the existing metadata cannot discover that path. The system should rely on watcher health/readiness for that class, not hide it behind periodic full-root scans.

## Validation targets

Existing tests that cover the intended behavior:

- Scoped reconcile for updates/creates/removals: `tests/persistence.test.ts:199-233`.
- Directory/file replacement: `tests/persistence.test.ts:251-267`.
- Hardlink repair behavior: `tests/persistence.test.ts:332-348`.
- Watch startup must not persist unchanged image baseline: `tests/persistence.test.ts:394-406`.
- Dirty file change must not persist unchanged sibling: `tests/persistence.test.ts:408-432`.
- Nested watcher deletion recovery: `tests/persistence.test.ts:467-506`.

Add/keep tests for:

- Periodic/startup repair scans stored mirror but does not walk/persist root baseline.
- Tombstone-only repair: live path recreated after a missed event clears the tombstone and persists the new live path.
- Large mirror repair yields between batches and heartbeat updates during repair.
- Top-level file change/root-entry polling does not call root-scope reconcile.
