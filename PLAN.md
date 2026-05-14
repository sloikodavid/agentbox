# Persistd Plan

Replace the current TypeScript persistence implementation with a single Go daemon named `persistd`.

This is a clean break. There are no existing users or persisted data to migrate. Do not preserve old internal module paths, old storage paths, or old TypeScript persistence seams. Preserve only the product goal: a PaaS-friendly persistent root experience without privileged mounts.

Useful skills for implementation agents:

- `.agents/skills/research/SKILL.md` - use before touching Go dependencies, SQLite, BLAKE3, inotify, xattrs, ACLs, capabilities, Docker, or Supervisor behavior.
- `.agents/skills/refactor/SKILL.md` - use when shaping package/module seams or deleting the TypeScript persistence implementation.
- `.agents/skills/break/SKILL.md` - use for adversarial temporary tests, performance probes, and edge-case hardening.

## Final contract

### User-facing behavior

Agentbox persists every included live path under `/` eventually, even when:

- the watcher misses an event,
- `persistd` was down when a file was created,
- a path is created outside the usual user home,
- metadata changes without file content changes,
- content changes while timestamps are preserved,
- directories, files, and symlinks replace each other,
- large bursts happen.

Excluded paths are exactly what the user config says. There are no hidden hard exclusions. If the user chooses dangerous config, the user owns the consequences.

### Performance behavior

Persistence must not do unbounded startup scans or periodic full-root bursts.

Normal behavior:

- live watcher events are the fastest path,
- rolling audit independently covers the full included live tree over time,
- dirty watcher work preempts audit work,
- all expensive work goes through one token-budgeted scheduler,
- if backlog grows, lag grows; do not spike to catch up,
- health reports backlog/degraded state, but backlog is not readiness failure.

A constant moderate load is acceptable. Spikes like 110-180% CPU are not.

### Restore behavior

Entrypoint always runs restore before Supervisor starts services:

```sh
/opt/agentbox/bin/persistd restore
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
```

If restore succeeds, boot normally.

If restore fails:

- write a clear error report under `/data/persistence/restore-error.log`,
- write a runtime marker under `/run/agentbox/persistd.restore-failed`,
- log a clear critical message,
- boot the fresh image anyway so the user can debug,
- `persistd watch` must refuse to persist and report disabled/degraded status until restart after the issue is fixed.

Do not attempt best-effort partial restore. Do not quarantine. Do not silently fall back to defaults after a config file exists.

## Process model

Supervisor owns `persistd` directly.

```ini
[program:persistd]
command=/opt/agentbox/bin/persistd watch
user=root
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

Do not name the supervisor program `persistence` if the process is `persistd`.

Commands:

```sh
persistd restore
persistd watch
persistd status
persistd check
```

`status` is for current state/health. `check` is for deeper consistency checks. Do not use `verify` for this project vocabulary.

## Repository/package layout

Use standard Go layout:

```text
packages/
  persistd/
    go.mod
    go.sum
    cmd/
      persistd/
        main.go
    internal/
      audit/
      config/
      db/
      heartbeat/
      metadata/
      objectstore/
      restore/
      scheduler/
      watch/
```

Use `cmd/persistd` because it is the conventional Go binary entrypoint layout. Use `internal/` for implementation packages so they cannot be imported outside the module.

Docker builds the Go binary in a build stage and copies only the binary into the runtime image:

```text
/opt/agentbox/bin/persistd
```

No Go runtime/toolchain should remain in the final image.

Once Go parity lands, delete the old TypeScript persistence implementation under `rootfs/opt/agentbox/persistence/*.ts`. Do not leave dead compatibility wrappers.

## Durable storage layout

All persistence storage lives under `/data/persistence`.

```text
/data/persistence/
  config.json
  db.sqlite
  objects/
    blake3/
      ab/
        cd/
          <full-hex-blake3-hash>
  restore-error.log
```

`/data/persistence` is internal but user-backup-worthy. Users may git or back up `/data`; they should not manually edit persistence internals except `config.json`.

There is no `/data/rootfs`, no `/data/rootfs/files`, and no `/data/rootfs/removed-files` in the new design.

### Object store

Regular file contents are stored as immutable BLAKE3-addressed objects.

- Hash algorithm is fixed to BLAKE3.
- Do not expose hash algorithm as user config.
- Include the `blake3` directory component because object identity depends on the algorithm and future migrations must be explicit.
- Use fanout directories to avoid huge single directories.
- Objects are regular files only.
- Old objects are garbage-collected by the background scheduler after DB references are removed.

Do not implement SQLite-only blob storage. Do not invent custom chunk/blob storage unless a later measured requirement forces it.

## SQLite role

SQLite is durable truth for metadata, path state, tombstones, object references, audit state, and restore state.

Use proper normalized current-state tables. Do not build append-only event sourcing.

SQLite should use a simple durable mode suitable for one writer. Prefer rollback-journal mode initially unless research proves WAL is needed. Full persistence matters more than write concurrency.

Suggested table groups:

```text
schema_info
paths
objects
xattrs
acls
audit_roots
audit_cursors
directory_audit_epochs
work_queue
runtime_state
```

Approximate `paths` shape:

```text
path_id INTEGER PRIMARY KEY
path TEXT UNIQUE NOT NULL              -- normalized absolute path under root
parent_path_id INTEGER NULL
basename TEXT NOT NULL
state TEXT NOT NULL                    -- present | removed
kind TEXT NOT NULL                     -- file | dir | symlink | fifo | device | other
mode INTEGER
uid INTEGER
gid INTEGER
atime_ns INTEGER
mtime_ns INTEGER
ctime_seen_ns INTEGER
size INTEGER
object_algorithm TEXT NULL             -- blake3 for regular files
object_hash TEXT NULL
symlink_target TEXT NULL
special_major INTEGER NULL
special_minor INTEGER NULL
hardlink_group_id TEXT NULL
content_hash_verified_at_ns INTEGER NULL
last_audited_at_ns INTEGER NULL
metadata_version INTEGER NOT NULL
```

`objects` stores at least:

```text
algorithm TEXT NOT NULL
hash TEXT NOT NULL
size INTEGER NOT NULL
ref_count INTEGER NOT NULL
created_at_ns INTEGER NOT NULL
gc_state TEXT NOT NULL                 -- live | unreferenced | deleting
PRIMARY KEY (algorithm, hash)
```

Tombstones are `paths.state = removed`. There is no marker-file tree.

SQLite corruption or malformed required tables is a persistence failure. During restore, that means safe fresh boot + persistence disabled. During watch, that means `persistd` exits non-zero and Supervisor restarts it.

## Config

Config is user-editable and authoritative:

```text
/data/persistence/config.json
```

On first boot, if the file is missing, `persistd` writes a default config.

After the file exists:

- parse it strictly,
- validate syntax/types,
- do not silently fall back to built-in defaults,
- do not add hidden hard exclusions,
- warn about dangerous choices if useful,
- invalid config disables persistence.

There are no hard exclusions. If the user removes `/data`, `/proc`, `/sys`, `/run`, or anything else from exclusions, that is allowed. The user owns the consequences.

Config uses `Ms` for milliseconds, not `Millis`.

Example default config shape:

```json
{
	"exclude": {
		"rootRelative": [
			"/.dockerenv",
			"/data",
			"/dev",
			"/proc",
			"/run",
			"/sys",
			"/tmp",
			"/home/user/.cache",
			"/home/user/.local/share/Trash",
			"/opt/agentbox",
			"/opt/code-server",
			"/etc/supervisor",
			"/usr/share/applications/agentbox.desktop",
			"/var/cache/apt/archives",
			"/var/lib/apt/lists/lock",
			"/var/lib/dpkg/lock",
			"/var/lib/dpkg/lock-frontend",
			"/var/lib/dpkg/triggers/Lock",
			"/var/run"
		]
	},
	"audit": {
		"maxWorkMsPerTick": 10,
		"maxFilesystemOpsPerSecond": 2000,
		"maxHashBytesPerSecond": 20000000,
		"directoryBatchSize": 256
	}
}
```

Runtime path configuration comes from env/defaults, not duplicated into config unless needed:

```text
AGENTBOX_VOLUME_PATH=/data
AGENTBOX_PERSISTENCE_CONFIG_PATH=/data/persistence/config.json
AGENTBOX_PERSISTENCE_DB_PATH=/data/persistence/db.sqlite
AGENTBOX_PERSISTENCE_OBJECTS_PATH=/data/persistence/objects
AGENTBOX_PERSISTENCE_HEARTBEAT_PATH=/run/agentbox/persistd.ready
```

Path env vars must end in `_PATH`.

## Heartbeat/status

`/run/agentbox/persistd.ready` is a runtime heartbeat/status file.

`/run` is runtime-only. The file is not persisted.

Gateway reads this file to determine whether `persistd` is alive and recently updated.

Suggested heartbeat JSON:

```json
{
	"updatedAt": "2026-05-13T00:00:00.000Z",
	"status": "ok",
	"mode": "watch",
	"watcherCount": 123,
	"degradedReasons": [],
	"dirtyBacklog": 0,
	"auditCursorCount": 12,
	"lastError": null
}
```

Readiness should not fail because audit backlog exists. Backlog/audit lag is health/status diagnostics only.

Readiness should fail only when the persistence service is not functioning at all, such as stale/missing heartbeat, disabled restore failure, DB unavailable, or daemon crash.

## Watcher design

Use raw Linux inotify through Go, not Node `fs.watch` and not a watcher abstraction that hides needed details.

Dependencies are allowed when they improve correctness and maintainability. Use `golang.org/x/sys/unix` for raw Linux syscalls. Do not use `fsnotify` if it hides overflow/cookies/masks needed by the design.

The watcher must:

- recursively watch included directories,
- skip excluded directories according to config,
- maintain watch descriptor to path mapping,
- detect `IN_Q_OVERFLOW`,
- handle create/delete/modify/attrib/move events,
- emit exact dirty path candidates into the scheduler,
- add watches for newly created directories,
- degrade gracefully if watch limits are hit.

If watch limits are hit:

- continue with best-effort watching,
- mark degraded with unwatched paths/counts,
- rolling audit still guarantees eventual persistence.

If overflow is detected:

- mark degraded with `overflow_seen`,
- start a full included-tree audit cycle through the normal budget,
- do not exceed budget,
- clear degraded after that audit cycle completes.

## Scheduler design

Use one scheduler for all persistence work.

Priority order:

1. restore failure disabled state check,
2. watcher dirty paths,
3. explicit check/status work if applicable,
4. live filesystem rolling audit,
5. DB-known path verification,
6. object garbage collection.

Use token buckets, not full bursts.

Budgets:

- filesystem operation tokens,
- hash/copy byte tokens,
- DB write batch limits,
- max continuous work duration per tick,
- hard yield boundaries.

If backlog exceeds budget, preserve the budget and let lag grow. Do not catch up by spiking CPU.

## Rolling audit design

The audit must independently discover every included live path eventually. DB-known paths alone are not enough because files can be created while `persistd` is down.

Use a fair, work-conserving multi-cursor audit.

- Start with included top-level roots under `/`.
- Use round-robin across cursors.
- If a cursor enters a huge subtree, split child cursors dynamically.
- Exclusions are checked before descending.
- Watcher dirty paths can create high-priority temporary cursors.
- Cursors persist in SQLite as rebuildable progress state.
- If cursor state is invalid, discard and rebuild from live top-level roots.

Use batched directory enumeration with per-directory audit epochs.

Directory audit flow:

```text
begin audit epoch for directory
read next batch of child names
for each included child:
  upsert child path row with seen_epoch
  enqueue/process child work
  maybe create child cursor
when directory enumeration finishes:
  rows previously known under this parent but not seen in epoch are removed/tombstoned
finish directory epoch
```

This detects deletions without full snapshots and without huge memory loads.

## File processing

Use standard file handling. No custom blob chunks.

For regular files:

1. `lstat` before copy.
2. Stream file once.
3. Compute BLAKE3 while streaming.
4. Write object temp file if object does not already exist.
5. `lstat` after copy.
6. If file changed during copy, requeue the path.
7. Commit DB path/object/metadata changes in a transaction.
8. Rename temp object into object store when safe.

Final artifacts are normal files under `objects/blake3/...`.

Large files are read/written in normal stream chunks. Do not add resumable custom blob state unless profiling proves it is required. If the daemon restarts mid-copy, temp object files are discarded and the path is requeued.

## Metadata contract

Target v5 supports full rootfs-grade metadata where the container/runtime permits it:

- regular files,
- directories,
- symlinks,
- hardlinks,
- uid/gid,
- mode,
- atime/mtime,
- xattrs,
- POSIX ACLs,
- Linux capabilities,
- sparse files where practical,
- FIFOs,
- device nodes where permitted.

Do not persist sockets. Unix sockets are runtime IPC endpoints. Restoring the socket path does not restore the process listening on it and creates stale runtime state.

Metadata implementation may land in vertical slices, but the architecture and DB schema must not assume a low-fidelity subset.

## Restore design

`persistd restore`:

1. Load config.
2. Open DB.
3. Validate schema.
4. Remove stale temp object files if safe.
5. Iterate current-state `paths` rows.
6. For present directories, create directories and apply metadata.
7. For present regular files, restore objects to live paths and apply metadata.
8. For hardlink groups, restore by linking peers where possible.
9. For symlinks, recreate link targets exactly.
10. For FIFOs/devices, recreate where allowed.
11. Apply xattrs/ACLs/capabilities.
12. Apply tombstones by removing live paths with `state = removed`.
13. Fail the restore command if durable state cannot be applied correctly.

Restore does not use audit cursors or watcher state. It uses durable SQLite current state and object files.

If restore fails, use the safe fresh boot behavior described above.

## `persistd watch` startup design

`persistd watch`:

1. If `/run/agentbox/persistd.restore-failed` exists, write disabled heartbeat and refuse to persist.
2. Load config.
3. Open DB.
4. Start heartbeat.
5. Start watcher best-effort.
6. Start scheduler.
7. Resume or rebuild audit cursors.
8. Continue until SIGTERM.

Do not run a blocking full audit before heartbeat.

## `persistd status`

Print human-readable and optionally JSON status:

- status: ok/degraded/disabled,
- watcher count,
- degraded reasons,
- dirty backlog,
- audit cursor count,
- approximate audit progress if available,
- object GC backlog,
- last error.

## `persistd check`

Deep consistency command for debugging/support.

Possible checks:

- DB schema validity,
- object files referenced by DB exist,
- object file hash matches path,
- objects directory has unreferenced files,
- path rows have valid parent relationships,
- config is valid,
- optional live-vs-DB check under budget or explicit command.

`check` may be heavier than runtime watch. It is user-invoked, not background behavior.

## Implementation slices

Each slice should be vertical: code + tests + validation. Do not create large unused scaffolding.

### Slice 1 - package skeleton and Docker wiring

Goal:

- create `packages/persistd`,
- build `persistd`,
- copy binary into image,
- add `persistd status` stub,
- no behavior change yet.

Files likely touched:

- `Dockerfile`,
- `rootfs/etc/supervisor/conf.d/agentbox.conf`, later slices,
- `packages/persistd/**`,
- CI/check scripts if needed.

Validation:

```sh
go test ./...
pnpm exec tsc --noEmit
pnpm exec vitest run
```

Ask user only if Docker build tooling requires adding a new repo-level Go workflow or package manager convention.

### Slice 2 - config and storage initialization

Goal:

- implement `/data/persistence/config.json` creation on first boot,
- strict config parsing,
- env path overrides with `_PATH`,
- initialize `/data/persistence/db.sqlite`,
- initialize `/data/persistence/objects/blake3`.

Tests:

- missing config creates default,
- malformed config disables/fails,
- env path overrides work,
- user exclusions are authoritative,
- no hard exclusions are injected.

Use `research` skill for Go JSON/config and SQLite driver choice.

### Slice 3 - SQLite schema

Goal:

- create normalized durable schema,
- implement migrations/schema version,
- implement path/object CRUD behind small internal packages.

Tests:

- schema initializes,
- transactions are atomic,
- current state updates replace older state,
- tombstones are represented as `state = removed`,
- object ref counts update correctly.

Do not add event sourcing.

### Slice 4 - object store and BLAKE3 file capture

Goal:

- stream regular files,
- compute BLAKE3 while reading,
- write temp object,
- rename into `/data/persistence/objects/blake3/...`,
- requeue/report changed-during-copy.

Tests:

- identical content dedupes to one object,
- changed same-size/timestamp-preserved content gets a new object,
- temp files are cleaned/retried,
- large file does not require loading into memory.

Use `break` skill for adversarial file-content probes.

### Slice 5 - restore core

Goal:

- implement `persistd restore` for directories, regular files, symlinks, tombstones, basic metadata,
- entrypoint uses `persistd restore`,
- restore failure writes error marker and allows fresh boot.

Tests:

- restore creates files/dirs/symlinks,
- restore applies tombstones,
- restore failure disables watch,
- corrupt/missing object fails restore safely,
- SQLite cache/audit tables do not affect restore semantics.

### Slice 6 - Supervisor switch and TypeScript deletion preparation

Goal:

- Supervisor runs `[program:persistd]`,
- gateway reads `/run/agentbox/persistd.ready`,
- old TypeScript watch path is no longer started,
- keep only code still needed until Go feature parity.

Tests:

- container boots,
- gateway readiness sees persistd heartbeat,
- restore happens before code-server starts.

Do not leave duplicate persistence daemons running.

### Slice 7 - raw inotify watcher

Goal:

- recursive raw inotify watcher,
- exact event candidates,
- overflow detection,
- watch limit degradation,
- exclusion-aware watch pruning.

Tests:

- create/update/delete events enqueue paths,
- new directories get watched,
- excluded dirs are not watched,
- watch limit errors degrade rather than crash,
- overflow marks degraded and requests audit cycle.

Use `research` skill for inotify details. Do not use abstractions that hide overflow/cookies/masks.

### Slice 8 - scheduler and dirty queue

Goal:

- token bucket scheduler,
- watcher dirty queue,
- max work ms per tick,
- fs op tokens,
- hash/copy byte tokens,
- DB batch limits,
- no catch-up spikes.

Tests:

- dirty queue preempts audit,
- backlog grows rather than exceeding budget,
- scheduler yields between work slices,
- status reports backlog.

Use `break` skill for performance/stress probes.

### Slice 9 - fair rolling audit

Goal:

- live filesystem audit of all included paths,
- top-level cursors,
- dynamic child cursors,
- persisted rebuildable cursors,
- batched directory enumeration,
- per-directory epochs for deletion detection.

Tests:

- brand-new file created while watch disabled is discovered,
- arbitrary included top-level paths are discovered,
- exclusions prune subtrees,
- huge subtree does not starve siblings,
- deleting a child is tombstoned by audit,
- cursor state resumes after restart or rebuilds if invalid.

### Slice 10 - full metadata

Goal:

- hardlinks,
- xattrs,
- ACLs,
- capabilities,
- sparse files where practical,
- FIFOs/devices where allowed,
- Linux-only integration tests.

Tests:

- hardlink topology restored,
- xattrs round-trip,
- ACLs round-trip,
- capabilities round-trip where permitted,
- sparse file remains sparse where practical,
- FIFO/device behavior is correct or clearly skipped when runtime disallows.

Ask user only if a metadata feature is blocked by PaaS/container permissions and requires changing the product contract.

### Slice 11 - object GC

Goal:

- unreferenced objects are marked in DB,
- background GC removes them under scheduler budget,
- `check` can find orphan objects.

Tests:

- replaced file leaves old object unreferenced,
- GC deletes unreferenced object later,
- referenced objects are never deleted,
- GC respects budget.

### Slice 12 - status/check commands

Goal:

- useful `persistd status`,
- useful `persistd check`,
- JSON output option if helpful.

Tests:

- status reports ok/degraded/disabled,
- check catches missing objects,
- check catches bad config/schema,
- check exits non-zero on real inconsistency.

### Slice 13 - remove old TypeScript persistence

Goal:

- delete obsolete `rootfs/opt/agentbox/persistence/*.ts`,
- remove obsolete tests or rewrite them against Go/integration behavior,
- remove obsolete constants/defaults/exports,
- update docs/architecture.

Validation:

```sh
pnpm check
docker compose up --build
```

Use `refactor` skill to ensure no dead code, no duplicate concepts, and no drift in names.

## Quality gates

Every implementation slice must run the relevant subset of:

```sh
go test ./...
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec eslint .
node scripts/format.mjs --check
docker compose up --build
```

If a full check is too expensive during a slice, say why and run the strongest targeted substitute. Before merging the full rewrite, run `pnpm check` and a Docker smoke test.

## Adversarial/performance testing

Use `.agents/skills/break/SKILL.md` during and after major slices.

Temporary tests should attack:

- preserved timestamp content changes,
- rapid create/delete/recreate,
- directory/file/symlink replacement,
- watcher overflow,
- watch limit exhaustion,
- malformed config,
- DB/object mismatch,
- huge directory fanout,
- deep trees,
- large files,
- metadata round trips,
- restart during copy,
- restore failure,
- object GC races,
- excluded path changes,
- user removing recommended exclusions.

Keep only compact permanent regressions. Delete temporary brute-force files.

## Questions agents should ask during implementation

Ask the user only for product-contract decisions, not implementation trivia.

Ask if:

- a Linux metadata feature cannot work in the target container/PaaS environment,
- preserving a special file type requires privileges the image will not have,
- a config choice could cause data loss and needs product wording,
- a storage format migration becomes necessary after the clean break,
- Go dependency choice materially changes build/security/performance posture.

Do not ask if:

- a choice is internal and clearly follows this plan,
- a name can be derived from existing vocabulary,
- a test can answer the question,
- research can answer the dependency behavior.

## Non-goals

- No privileged overlayfs/FUSE requirement.
- No Lsyncd/Syncthing/Mutagen dependency.
- No Node/TypeScript hot path for persistence after parity.
- No periodic unbounded full-root scan.
- No hidden hard exclusions.
- No version history or rollback feature.
- No SQLite-only blob store.
- No append-only event-sourcing architecture.
- No persisting Unix sockets.
