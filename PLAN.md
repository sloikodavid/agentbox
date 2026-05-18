# persistd Rust Rewrite Plan

## 0. Purpose

This document is the handoff plan for rewriting `persistd` from first principles in Rust.

It is written for a junior engineer or a new agent with no prior context.

The plan captures decisions that were explicitly settled in discussion.

Do not treat the current Go implementation as the design to port.

The goal is not "Go rewritten in Rust."

The goal is a clean, open, image-delta persistence system for Agentbox.

## 0.1 Required Context To Read First

Before coding, read these files in this order:

1. `PLAN.md`.
2. `C:\Users\sloik\Documents\Projects\agentbox\.agents\skills\grill\SKILL.md`.
3. `C:\Users\sloik\Documents\Projects\agentbox\.agents\skills\research\SKILL.md`.
4. `C:\Users\sloik\Documents\Projects\agentbox\.agents\skills\refactor\SKILL.md`.
5. `C:\Users\sloik\Documents\Projects\agentbox\.agents\skills\list\SKILL.md`.
6. `C:\Users\sloik\Documents\Projects\deployery\packages\docker\linux\opt\deployery\core\src\persistence.ts`.
7. `C:\Users\sloik\Documents\Projects\deployery\packages\docker\linux\opt\deployery\core\src\persistence-paths.ts`.
8. `C:\Users\sloik\Documents\Projects\agentbox\packages\persistd\internal\restore\restore_test.go`.
9. `C:\Users\sloik\Documents\Projects\agentbox\packages\persistd\internal\watch\watcher_linux.go`.

The Deployery files are reference material only.

Do not clone Deployery's implementation.

Use Deployery to understand the previous open-mirror idea and its shortcomings.

The old Go persistd files are behavioral and edge-case references only.

Do not port the Go module structure.

Do not let old Go internals pollute the new design.

## 0.2 What Is Strict Versus Advisory

Strict decisions:

- public layout.
- `/opt/persistd/baseline.sqlite`.
- `/run/persistd/ready`.
- `/data/persistd/config.json`.
- `/data/persistd/changed`.
- `/data/persistd/removed`.
- `/data/persistd/metadata.jsonl`.
- `/data/persistd/.internal/state.sqlite`.
- `/data/persistd/.internal/lock`.
- `/data/persistd/.internal/control.sock`.
- command set: `apply`, `daemon`, `status`, `doctor`, `prune`.
- boot apply and live daemon are separate operational phases.
- only `persistd apply` and `persistd daemon` mutate filesystem or persistence state.
- `persistd apply` is one-shot and must finish before the daemon starts.
- `status`, `doctor`, and `prune` talk to the daemon and fail if it is not running.
- baseline comparison before writing to `changed`.
- watcher plus rolling audit.
- public truth wins over `.internal/state.sqlite`.
- `metadata.jsonl` is fallback-only current state, not a journal.
- Rust-native apply, no `rsync`.

Advisory decisions:

- exact Rust module/file structure.
- exact dependency set.
- exact SQLite schema.
- exact `metadata.jsonl` schema.
- exact control socket protocol.
- exact scheduling implementation.
- exact ACL/capability crate choice.

When an advisory decision becomes load-bearing, stop and invoke the grill skill.

Do not silently turn advisory text into a permanent architecture if it feels wrong during implementation.

## 0.3 Required Skill Behavior

Use the `research` skill before finalizing any dependency, crate feature, Rust toolchain version, Docker base image, Linux filesystem API, SQLite mode, ACL implementation, xattr implementation, or inotify behavior.

Use the `refactor` skill when choosing module boundaries.

Use the `grill` skill whenever product semantics are unclear.

Use the `list` skill when unsure where to look in this repository.

Ask the user one decision question at a time when using grill.

For every grill question, give a recommended answer.

Do not implement through unresolved load-bearing uncertainty.

Be proactive about asking.

If a decision is not explicitly settled in this plan and affects product semantics, storage format, recovery behavior, security, compatibility, or operational UX, stop and ask.

Do not wait until a vague area becomes a bug.

Use the grill skill for these questions.

Ask one question at a time.

Include your recommended answer.

## 1. Product Contract

Agentbox should feel like a mutable Linux system.

The user should be able to change files anywhere in the container root filesystem, except excluded runtime paths.

Those changes should survive restarts and redeploys using exactly one mounted persistent volume.

The Docker image is the lower layer.

The volume stores the user delta from the image.

Persisted user changes win over the image.

If the image updates and the user changed `/foo`, the user version of `/foo` remains.

If the image updates and the user never changed `/foo`, the new image version of `/foo` is used.

If the user deletes an image file, the deletion persists.

If the user creates a new file, it persists.

Existing user data and backwards compatibility do not matter yet.

There are no users relying on the current Go storage format.

The rewrite may strip features and change the storage layout.

## 2. Non-Goals

Do not preserve process state.

Do not preserve kernel state.

Do not preserve file locks.

Do not preserve live sockets as live sockets.

Do not preserve bind mounts.

Do not persist `/proc`, `/sys`, `/run`, or other runtime virtual filesystems.

Do not require OverlayFS mount privileges.

Do not require `CAP_SYS_ADMIN`.

Do not require special PaaS privileges beyond realistic root-in-container behavior.

Do not make SQLite the public persistence truth.

Do not make `persistd` depend on users editing internal daemon files.

## 3. Hard Requirements

The implementation must work without kernel OverlayFS.

The implementation must run as root.

The implementation must work on typical PaaS/container environments with one persistent volume.

Target environments include:

- DigitalOcean Droplets and volumes.
- Railway volumes.
- Render persistent disks.
- Similar Linux container hosts.

The implementation should preserve all realistic Linux filesystem state:

- regular files.
- directories.
- symlinks.
- hardlinks when supported.
- mode bits.
- uid and gid.
- mtimes.
- xattrs.
- ACLs.
- Linux file capabilities where possible.
- FIFOs.
- device node records, with apply only when permitted.
- sparse file correctness, and sparseness where possible.

If a feature cannot be stored natively on the volume, persist fallback metadata in `metadata.jsonl`.

If a feature cannot be applied due to missing runtime permission, fail clearly or record a diagnostic.

Do not silently discard user data.

If unsure, fail not-ready rather than guessing.

## 4. Settled Directory Layout

Image-shipped baseline data:

```text
/opt/persistd/
  baseline.sqlite
```

Ephemeral runtime readiness:

```text
/run/persistd/
  ready
```

Persistent user delta and daemon internals:

```text
/data/persistd/
  config.json
  changed/
  removed/
  metadata.jsonl
  .internal/
    state.sqlite
    lock
    control.sock
    apply-error.log
    watch-error.log
```

The path `/opt/persistd` is image data.

The path `/run/persistd` is runtime data.

The path `/data/persistd` is persistent volume data.

## 5. Public Truth

The public persistence truth is exactly:

```text
/data/persistd/changed/
/data/persistd/removed/
/data/persistd/metadata.jsonl
```

These are user-facing and human-editable.

The internal SQLite database is not public truth.

The internal SQLite database is machine oil.

If `.internal/state.sqlite` disagrees with public truth, public truth wins.

If `.internal/state.sqlite` is missing, stale, or corrupt, rebuild it from public truth.

## 6. Internal State

Internal daemon state lives under:

```text
/data/persistd/.internal/
```

Use:

```text
/data/persistd/.internal/state.sqlite
```

Do not use `persistd.sqlite`.

Do not use `db.sqlite` unless `state.sqlite` becomes clearly wrong.

The preferred name is `state.sqlite`.

Internal SQLite may store:

- event journal.
- dirty path queue.
- audit cursors.
- debounce batches.
- cached indexes of `changed/`, `removed/`, and `metadata.jsonl`.
- capability probe results.
- last apply status.
- last daemon status.
- watcher status.
- audit status.
- prune status.
- doctor status.
- diagnostics.
- checkpoint state.
- crash recovery state.

Internal SQLite must not be required to understand or manually repair user data.

## 7. Commands

The command surface is settled:

```bash
persistd apply
persistd daemon
persistd status
persistd doctor
persistd prune
```

Avoid hidden flag mazes.

Only add `--json` where genuinely useful for automation.

Do not keep public `run`.

Do not keep public `restore`.

Do not keep public `watch`.

Do not keep public `check`.

## 8. Command Semantics

### `persistd apply`

This is the one-shot boot apply phase.

It is run by the container entrypoint before Supervisor starts.

It applies persisted public truth to the live root filesystem.

It does:

1. remove stale readiness.
2. create layout.
3. acquire lock.
4. open or recover `.internal/state.sqlite`.
5. load config.
6. load `/opt/persistd/baseline.sqlite`.
7. probe volume capabilities.
8. validate and normalize public truth.
9. compact `metadata.jsonl`.
10. rebuild internal indexes.
11. apply `removed/`.
12. apply `changed/`.
13. apply fallback metadata.
14. record apply success in `.internal/state.sqlite`.
15. exit zero.

If apply fails, it must exit non-zero.

If apply fails, it must not write `/run/persistd/ready`.

If apply fails, Supervisor should not start.

Record apply failure details in `.internal/state.sqlite` and `/data/persistd/.internal/apply-error.log` where possible.

Do not make apply failure coordination depend on marker files such as the old `/run/persistd/restore-failed`.

### `persistd daemon`

This is the long-running live persistence daemon.

It is run by Supervisor and may be autorestarted.

It must not replay boot apply on daemon restart.

It does:

1. remove stale readiness.
2. create layout if needed.
3. acquire lock.
4. open or recover `.internal/state.sqlite`.
5. load config.
6. load `/opt/persistd/baseline.sqlite`.
7. probe volume capabilities.
8. initialize watcher.
9. initialize rolling audit.
10. create control socket.
11. write `/run/persistd/ready`.
12. continue processing watcher and audit candidates through `update`.

The normal guarantee that apply already succeeded comes from entrypoint ordering: Supervisor starts only after `persistd apply` exits zero.

`persistd daemon` may report the last apply status from `.internal/state.sqlite`, but it must not invent a second runtime apply-success marker.

If watcher or audit initialization fails fatally, `daemon` must not write `/run/persistd/ready`.

If watcher or audit degrades but rolling audit can still protect correctness, record diagnostics and continue only if that degraded mode is explicitly accepted by the implementation.

### `persistd status`

Fast operational status.

It talks to the daemon over the control socket.

If the daemon is not running, it fails clearly.

It does not mutate state.

It should not deeply walk public truth.

It should report:

- ready or not ready.
- current lifecycle phase.
- last apply status.
- last watch status.
- last error summary.
- capability probe summary.
- dirty queue size.
- audit progress summary.
- public path counts from cached state.

### `persistd doctor`

Validation and safe repair.

It talks to the daemon over the control socket.

If the daemon is not running, it fails clearly.

It may perform safe normalization only.

Examples of safe normalization:

- compact `metadata.jsonl`.
- rebuild `.internal/state.sqlite` indexes.
- clean abandoned internal work.
- validate baseline availability.
- validate path mapping.
- validate `changed/`, `removed/`, and `metadata.jsonl` consistency.

It must not destructively remove user data.

### `persistd prune`

Intentional destructive cleanup.

It talks to the daemon over the control socket.

If the daemon is not running, it fails clearly.

It may remove stale or dormant public persistence data.

It must report exactly what it removed.

It should remove only things that are safe under current config and baseline rules.

Prune can remove:

- dormant persisted data under current exclusions.
- baseline-equal `changed/` entries.
- stale tombstones.
- stale metadata.
- empty directories left by pruning.

## 9. Single Writer Rule

Only `persistd apply` and `persistd daemon` mutate filesystem or persistence state.

They must never run concurrently.

`persistd apply` runs before Supervisor starts and exits.

`persistd daemon` is the only long-running writer.

`status`, `doctor`, and `prune` do not directly mutate the filesystem.

They talk to `persistd daemon`.

There is no fallback path where commands take the lock and mutate directly.

If the daemon is not running, commands fail clearly.

This avoids split-brain behavior.

## 10. Locking

`persistd apply` and `persistd daemon` use:

```text
/data/persistd/.internal/lock
```

`persistd apply` holds the lock for the duration of apply.

`persistd daemon` holds the lock for the whole daemon lifetime.

The lock prevents apply and daemon from writing at once.

Use an advisory lock appropriate for Linux.

If the lock cannot be acquired, the command exits or reports already-running clearly.

## 11. Control Socket

Use one command/control socket:

```text
/data/persistd/.internal/control.sock
```

Do not add a second command path.

Do not place the control socket under `/run`.

The control socket belongs with lock and internal state.

`/run/persistd/ready` is only for readiness integration.

The socket protocol is not yet settled.

Invoke the grill skill before finalizing the socket protocol if it is not obvious.

## 12. Readiness

Readiness marker:

```text
/run/persistd/ready
```

This is the only runtime readiness marker.

Do not create:

```text
/run/persistd/restore-failed
/run/persistd/watch-failed
```

Failure details live in:

```text
/data/persistd/.internal/state.sqlite
/data/persistd/.internal/apply-error.log
/data/persistd/.internal/watch-error.log
```

Write `/run/persistd/ready` only after:

- public truth was updated.
- apply completed.
- watcher initialized.
- rolling audit initialized.
- daemon is actively protecting the filesystem.

Remove stale ready at daemon start.

Remove stale ready at apply start.

## 13. Config

Runtime config lives in:

```text
/data/persistd/config.json
```

There is only one active runtime config.

Do not put runtime config in `/opt/persistd`.

`/opt/persistd` is image baseline data only.

Do not put config templates in `/opt/persistd`.

Do not read runtime policy from `/opt`.

If `/data/persistd/config.json` is absent, `persistd` writes built-in defaults from the binary.

After first boot, `/data/persistd/config.json` is the only active config.

If config is absent, create a default config.

Config includes:

- exclusions.
- scheduler/audit budgets.
- maybe logging verbosity.
- maybe feature policy for fallback metadata.

Keep config small.

## 14. Exclusions

Config exclusions are runtime policy.

Baseline still stores all image facts.

Excluded paths are outside the persistence universe at runtime.

For excluded paths:

- do not apply from `changed/`.
- do not apply `removed/`.
- do not apply `metadata.jsonl`.
- do not watch.
- do not audit.
- do not compare to baseline.

Existing persisted data under excluded paths is ignored, not pruned.

Prune may later remove dormant excluded data intentionally.

Default exclusions in the config file must include at least:

- `/data`.
- `/run`.
- `/proc`.
- `/sys`.
- `/dev`.
- `/tmp`.
- `/var/run`.
- `/opt/persistd`.
- `/opt/agentbox`.
- runtime files such as `/etc/hostname`, `/etc/hosts`, `/etc/resolv.conf`.

Review current Go defaults before deciding final default exclusions.

User should be able to remove any exclusion/break their system, etc.

If unsure about an exclusion or anything mentioned in the plan, or any contradictions, invoke the grill skill.

## 15. Baseline

Baseline lives in:

```text
/opt/persistd/baseline.sqlite
```

It is generated at Docker image build time.

It describes the image lower layer.

It is not user state.

It is not runtime policy.

It should contain all real image paths.

It should skip technical runtime/self-reference paths:

- `/proc`.
- `/sys`.
- `/dev`.
- `/run`.
- `/data`.
- `/opt/persistd/baseline.sqlite`.

Baseline must include content hashes for all included regular files.

Baseline must be available before `persistd apply` can apply public truth and before `persistd daemon` can protect the live system.

If baseline is missing or corrupt, fail not-ready.

## 16. Baseline Record Fields

Baseline records should include enough data to decide whether a live path equals the image.

Minimum fields:

- path bytes.
- normalized display path.
- kind.
- mode.
- uid.
- gid.
- size.
- mtime_ns.
- content hash for regular files.
- symlink target for symlinks.
- device major/minor for device nodes if present.
- xattr facts if image xattrs matter.
- ACL facts if image ACLs matter.
- capability facts if image capabilities matter.

Do not finalize exact baseline schema without reviewing filesystem fidelity needs.

If schema uncertainty blocks implementation, invoke the grill skill.

## 17. Definition Of Change

A live path is changed if it differs from the current image baseline under current config.

Do not define change as "an event happened."

Do not copy a path into `changed/` merely because it was touched.

Always compare before writing to `changed/`.

This prevents touched-but-unchanged large files from ballooning the volume.

## 18. Compare-First Update Pipeline

Every watcher event and every audit discovery feeds the same pipeline:

1. normalize path.
2. reject or ignore excluded path.
3. inspect live path with `lstat`.
4. find baseline record.
5. compare cheap facts first.
6. hash only when needed.
7. decide public truth mutation.
8. write atomically if a mutation is needed.
9. update internal state.

No mirror-first-then-prune.

No separate semantics for watcher and audit.

## 19. Gated Comparison

Use gates in this order:

1. path exists or missing.
2. kind.
3. size for regular files.
4. mode.
5. uid/gid.
6. symlink target.
7. device major/minor.
8. mtime where meaningful.
9. xattr/ACL/capability facts where required.
10. content hash for regular files when cheap facts do not prove difference.

If cheap facts prove difference, persist delta without hashing only when content equality cannot change the decision.

If cheap facts are equal but content could differ, hash and compare.

The final decision must be correct in edge cases.

## 20. Delta Decisions

If live path equals baseline:

- remove corresponding `changed/` entry.
- remove corresponding `removed/` entry.
- drop fallback metadata for that path if no longer needed.

If live path differs from baseline:

- write or update corresponding `changed/` entry.
- clear exact `removed/` marker when appropriate.
- write fallback metadata only for unsupported fields.

If live path is missing and baseline had it:

- create corresponding `removed/` marker.
- remove corresponding `changed/` entry.
- drop fallback metadata unless marker needs it.

If live path is missing and baseline did not have it:

- remove corresponding `changed/` entry.
- remove corresponding `removed/` marker.
- drop fallback metadata.

## 21. `changed/`

`changed/` is the native upper layer.

It stores actual filesystem entries where possible.

Examples:

```text
/data/persistd/changed/etc/foo
/data/persistd/changed/home/user/new.txt
/data/persistd/changed/home/user/link
```

Regular files are stored as regular files.

Directories are stored as directories.

Symlinks are stored as symlinks.

Hardlinks should be stored as hardlinks if the volume supports them.

Mode, ownership, mtime, xattrs, and ACLs should live directly on `changed/` entries when supported.

If a path has only metadata changes, still create a `changed/` entry so native metadata can live there.

This means metadata-only changes to huge files can duplicate content.

That tradeoff was explicitly accepted.

## 22. `removed/`

`removed/` is public deletion truth.

It uses empty marker files mirroring deleted paths.

Example:

```text
/data/persistd/removed/usr/bin/tool
```

This means:

```text
/usr/bin/tool is removed from the image lower layer
```

To bring back the image version, delete the marker.

`removed/` stays even if `metadata.jsonl` also references the path.

`removed/` is not replaced by metadata-only removals.

## 23. Removed And Changed Conflict

Both may exist:

```text
/data/persistd/removed/etc/foo
/data/persistd/changed/etc/foo
```

This is valid.

`removed/` clears the image lower layer.

`changed/` then restores the user upper layer.

Therefore `changed/` wins.

This handles replacing an image directory with user-created content at the same path.

Apply order must preserve this rule.

## 24. Apply Order

Apply order is settled:

1. validate and normalize public truth.
2. compact `metadata.jsonl`.
3. rebuild/update `.internal/state.sqlite`.
4. apply `removed/`.
5. apply `changed/`.
6. apply fallback metadata from `metadata.jsonl`.
7. initialize watch/audit.
8. write ready.

Applying `removed/` before `changed/` is required.

Apply must be idempotent.

If the container crashes mid-apply, the next `persistd apply` starts over safely.

## 25. `metadata.jsonl`

Path:

```text
/data/persistd/metadata.jsonl
```

It is public truth.

It is human-editable.

It is fallback-only metadata.

It is not a journal.

It is a compact current-state file.

It contains one current record per path.

Stable ordering is preferred, probably lexical by path.

No duplicate/latest-wins public semantics.

Internal journaling belongs in `.internal/state.sqlite`.

## 26. What Goes In `metadata.jsonl`

Only data that cannot be represented natively in `changed/` or `removed/`.

Examples:

- fallback xattrs.
- fallback ACLs.
- security capability fallback.
- hardlink group records when hardlinks cannot be stored natively.
- FIFO records when FIFOs cannot be stored in `changed/`.
- device node records.
- sparse file fallback facts if needed.

Do not duplicate normal metadata in JSONL if the volume supports it natively.

Do not store every path in JSONL just for indexing.

Indexes belong in `.internal/state.sqlite`.

## 27. Metadata Update

`metadata.jsonl` is compacted and normalized on `persistd apply` startup and by `doctor`.

If the user deletes from `changed/` but metadata remains, drop stale metadata when appropriate.

If the user edits metadata for an existing `changed/` path, honor the edit.

If the user deletes a metadata record, that fallback metadata is gone.

If metadata references a missing normal path, prune it.

If metadata represents fallback-only state, it may stand alone.

Fallback-only state includes device node records and other entries that cannot exist under `changed/`.

## 28. Capability Probes

On startup, probe the volume under `/data/persistd`.

Store probe results in `.internal/state.sqlite`.

Probe at least:

- chmod.
- chown.
- mtime preservation.
- symlink creation.
- hardlink creation.
- `user.*` xattrs.
- `security.capability` xattrs.
- ACL preservation.
- FIFO creation.
- device node creation.
- sparse file behavior if practical.

Probe results decide whether data is stored natively or in `metadata.jsonl`.

If a capability is unsupported, do not silently lose data.

Store fallback metadata.

If no faithful fallback exists, fail clearly.

## 29. Watcher And Audit

Use both filesystem events and rolling audit.

Watcher is the low-latency path.

Rolling audit is the correctness path.

Both feed the compare-first update pipeline.

The rolling audit scans the whole non-excluded live filesystem forever, budgeted.

The audit must eventually catch:

- missed events.
- daemon restarts.
- watcher overflow.
- changes before watcher started.
- race windows.

Do not rely only on events.

## 30. Event Loss And Overflow

Watcher overflow must degrade into audit recovery, not data loss.

If overflow is detected:

- record diagnostic.
- increase audit priority or enqueue affected roots.
- keep daemon alive if possible.
- do not mark ready false unless correctness is actively compromised.

If unsure about overflow policy, invoke the grill skill.

## 31. Crash Safety

Every public truth mutation must be atomic or recoverable.

Use same-filesystem temporary writes under `.internal` as needed.

Do not expose half-written files in `changed/`.

Do not expose half-written `metadata.jsonl`.

SQLite transactions can track internal work.

After crash:

- public truth wins.
- abandoned internal work is cleaned or completed.
- metadata is compacted.
- internal indexes are rebuilt.
- apply is re-run idempotently.

## 32. Path Handling

Linux paths are byte sequences.

Do not assume UTF-8.

In Rust, use byte-aware Unix path handling.

Use `std::os::unix::ffi::OsStrExt` and `OsStringExt` where needed.

NUL is impossible in Linux path components.

Slash is the separator.

Reject root `/` as a persisted path.

Normalize paths without following symlinks.

Do not allow `..` escape behavior.

Do not use string-only path logic for correctness-critical behavior.

If path encoding for control files becomes necessary, invoke the grill skill before inventing a scheme.

## 33. Symlink Safety

Apply must not follow symlink ancestors when applying writes into `/`.

Avoid writing through a symlink to escape intended paths.

Use `lstat` semantics.

For file apply, validate ancestors.

For deletion apply, validate ancestors.

The current Go implementation already guards against symlink ancestor apply escapes; the Rust rewrite must keep that safety property.

## 34. Hardlinks

Preserve hardlinks when realistic.

If the volume supports hardlinks, store hardlinked entries in `changed/` as hardlinks.

If the volume does not support hardlinks, record fallback hardlink group data in `metadata.jsonl`.

On apply, recreate hardlinks when possible.

If hardlink apply fails due to cross-device or permissions, fall back only if content correctness is maintained and diagnostic is recorded.

If hardlink semantics are unclear, invoke the grill skill.

## 35. Sparse Files

The plan requires content correctness.

Preserving sparseness is desirable.

Probe and implement sparse-aware copy if practical.

If sparseness cannot be preserved on a platform, record this in status/doctor.

Do not let a touched sparse baseline file balloon the volume if it compares equal to baseline.

Compare first prevents many sparse-file balloon cases.

## 36. Special Files

FIFOs should be stored natively if possible.

If not possible, store FIFO fallback record in `metadata.jsonl`.

Device nodes should be recorded in `metadata.jsonl`.

Apply device nodes only if permitted.

Sockets are not persisted as live sockets.

Mounts are not persisted.

Runtime virtual filesystem state is excluded.

## 37. Baseline Equality

Baseline equality includes all relevant filesystem state:

- kind.
- file content hash.
- symlink target.
- mode.
- uid/gid.
- mtime if preserved.
- hardlink identity/group when meaningful.
- xattrs/ACLs when preserved.
- device major/minor for device records.

If a path returns to baseline, prune its persisted delta.

This is required to keep the volume a true image delta.

## 38. Build Integration

Replace the Go builder stage with a Rust builder stage.

Use the official Rust Docker image:

```text
rust:1.95.0-trixie
```

Current research snapshot:

- Rust stable: 1.95.0, released 2026-04-16.
- Docker official tag exists: `rust:1.95.0-trixie`.
- Rust 2024 edition is stable since Rust 1.85.

Use Rust edition 2024.

Set `rust-version = "1.95"` unless the team intentionally chooses a lower MSRV.

Compile the binary to:

```text
/opt/agentbox/bin/persistd
```

Generate baseline during image build and install:

```text
/opt/persistd/baseline.sqlite
```

## 39. Repo Structure

The initial Rust module shape is settled:

```text
packages/persistd/
  Cargo.toml
  Cargo.lock
  src/
    main.rs
    cli.rs
    config.rs
    paths.rs
    baseline.rs
    public.rs
    internal.rs
    rootfs.rs
    apply.rs
    daemon.rs
    watch.rs
    audit.rs
    update.rs
    status.rs
    doctor.rs
    prune.rs
  tests/
```

`main.rs` is the tiny Rust binary entrypoint.

`cli.rs` parses `persistd apply`, `persistd daemon`, `persistd status`, `persistd doctor`, and `persistd prune`.

`config.rs` owns `/data/persistd/config.json`, built-in defaults, exclusions, and tunables.

`paths.rs` owns resolved path constants for `/opt/persistd`, `/data/persistd`, and `/run/persistd`.

`baseline.rs` owns `/opt/persistd/baseline.sqlite`, image lower-layer facts, baseline loading, baseline generation, and baseline lookup.

`public.rs` owns public truth under `/data/persistd`: `changed/`, `removed/`, and `metadata.jsonl`.

`internal.rs` owns daemon machinery under `/data/persistd/.internal`: `state.sqlite`, `lock`, `control.sock`, cached indexes, journals, queues, checkpoints, capability cache, and diagnostics.

`rootfs.rs` owns live root filesystem operations: `lstat`, readlink, hashing, copying, applying files, chmod/chown/mtime, xattrs, ACLs, capabilities, symlinks, hardlinks, special files, capability probes, and symlink ancestor safety.

`apply.rs` applies public truth to rootfs: `removed/` first, `changed/` second, fallback metadata last.

`daemon.rs` owns the long-running `persistd daemon` process: layout checks, lock, internal DB, watcher/audit startup, readiness, control socket, and single-writer command routing for status/doctor/prune.

`watch.rs` owns raw inotify only: watch registration, low-level event decoding, overflow/degraded signals, and emitting dirty path candidates.

`audit.rs` owns rolling audit only: budgeted scans, cursors/epochs, missed-change discovery, deletion discovery, and emitting dirty path candidates.

`update.rs` owns the compare-first update decision: config plus baseline plus rootfs state plus public truth plus capability info becomes persist, tombstone, prune, fallback metadata, or ignore.

`status.rs` owns status request/response behavior.

`doctor.rs` owns validation and safe repair behavior.

`prune.rs` owns intentional cleanup behavior.

`daemon.rs` wires these modules together.

Do not collapse watch, audit, update, apply, status, doctor, or prune behavior into `daemon.rs`.

`daemon.rs` should read like lifecycle and wiring, not filesystem comparison logic.

First useful vertical slice:

1. create layout.
2. generate/load a minimal baseline.
3. compare one regular file.
4. write `changed/` or `removed/`.
5. apply that one path.
6. test it end to end.

Then expand to metadata, watcher, audit, and control.

Do not collapse everything into `main.rs`.

When module boundaries become load-bearing, use the `refactor` skill.

## 40. Dependency Recommendation

The dependency set was not settled in conversation.

This plan recommends a conservative set based on current crates.io versions checked on 2026-05-18.

If changing the dependency strategy, invoke the grill skill first.

Before committing `Cargo.toml`, rerun the `research` skill and verify:

- current crate versions.
- required crate features.
- current Rust stable version.
- Docker base image availability.
- whether a lower MSRV is desirable.

Use researched versions as defaults, not as sacred pins.

Prefer a small direct dependency set.

Add dependencies only when the implementation needs them.

Do not add optional crates from this section preemptively.

Recommended direct dependencies:

```toml
[dependencies]
anyhow = "1.0.102"
base64 = "0.22.1"
blake3 = "1.8.5"
clap = { version = "4.6.1", features = ["derive"] }
crossbeam-channel = "0.5.15"
filetime = "0.2.29"
hex = "0.4.3"
inotify = "0.11.1"
libc = "0.2.186"
nix = { version = "0.31.3", features = ["fs", "user", "signal", "process"] }
rusqlite = { version = "0.39.0", features = ["bundled"] }
serde = { version = "1.0.228", features = ["derive"] }
serde_json = "1.0.149"
thiserror = "2.0.18"
tracing = "0.1.44"
tracing-subscriber = "0.3.23"
walkdir = "2.5.0"
xattr = "1.6.1"
```

Optional dependencies to evaluate:

```toml
exacl = "0.13.0"
fs2 = "0.4.3"
percent-encoding = "2.3.2"
rustix = "1.1.4"
tempfile = "3.27.0"
```

Notes:

- Prefer `inotify` over high-level `notify` if raw overflow/watch details are needed.
- Use `rusqlite` with `bundled` to avoid runtime dependency surprises.
- Use `blake3` for baseline and live content hashes.
- Use `libc`/`nix` for low-level Linux operations not covered cleanly elsewhere.
- Evaluate ACL support carefully before finalizing `exacl` or another ACL crate.
- Use `thiserror` for domain/library errors.
- Use `anyhow` only at CLI/top-level command boundaries.
- Be cautious with `crossbeam-channel`; use it only if the watcher/audit/runtime design needs it.
- Be cautious with broad `nix` feature flags; enable the smallest useful set.
- Do not choose an ACL/capability crate without research and grill.

## 41. CI And Package Scripts

Update `package.json`.

Remove Go checks.

Add Rust checks.

The current CI workflow is:

```text
.github/workflows/ci.yml
```

It currently:

- checks out the repo.
- installs pnpm.
- sets up Node 26.1.0.
- sets up Go 1.24.
- runs `pnpm install --frozen-lockfile`.
- runs `pnpm check`.

Replace Go setup with Rust setup.

Add Cargo caching.

Keep Node/pnpm behavior unchanged unless separately required.

The current smoke workflow is:

```text
.github/workflows/smoke.yml
```

It builds Docker images for:

- linux/amd64 on ubuntu-24.04.
- linux/arm64 on ubuntu-24.04-arm.

Then it runs:

```text
.github/scripts/smoke.sh
```

The rewrite must update smoke expectations to the new persistd layout.

The current release workflow is:

```text
.github/workflows/release.yml
```

It calls the smoke workflow before publishing.

Therefore Docker smoke must pass before release can pass.

The nightly smoke workflow is:

```text
.github/workflows/smoke-nightly.yml
```

It calls the same smoke workflow with `no_cache: true`.

Do not update only CI and forget smoke/release/nightly.

Target script shape:

```json
"check": "tsc --noEmit && vitest run --coverage && eslint . && cargo fmt --manifest-path packages/persistd/Cargo.toml --check && cargo clippy --manifest-path packages/persistd/Cargo.toml --all-targets --all-features -- -D warnings && cargo test --manifest-path packages/persistd/Cargo.toml --all-targets --all-features && node scripts/format.mjs --check && pnpm dlx --package renovate renovate-config-validator renovate.json"
```

Use actual final command syntax after testing.

Update GitHub Actions:

- remove `actions/setup-go`.
- add Rust toolchain setup.
- cache Cargo registry and target directories.
- pin versions consistently.
- include `cargo fmt --check`.
- include `cargo clippy --all-targets --all-features -- -D warnings`.
- include `cargo test --all-targets --all-features`.
- keep checks running on Ubuntu because Linux filesystem behavior matters.

Recommended workflow shape:

```yaml
- uses: dtolnay/rust-toolchain@stable.
  with:
    toolchain: "1.95.0"
    components: rustfmt, clippy

- uses: Swatinem/rust-cache@...
  with:
    workspaces: packages/persistd
```

Research current recommended action versions before editing CI.

If the team does not want third-party Rust setup/cache actions, use official `rustup` installation and `actions/cache`.

Do not guess; use the `research` skill.

## 42. Dockerfile Changes

Remove:

```text
FROM golang:1.24-trixie AS persistd-builder
```

Add:

```text
FROM rust:1.95.0-trixie AS persistd-builder
```

Build binary:

```bash
cargo build --release --locked --manifest-path packages/persistd/Cargo.toml
```

Copy binary:

```text
COPY --from=persistd-builder /out/persistd /opt/agentbox/bin/persistd
```

Generate baseline after rootfs and runtime files are assembled.

Important:

- baseline must describe final image contents.
- baseline must exclude itself.
- baseline must exclude runtime/mount paths.
- baseline must be generated before final runtime starts.

If Docker layering makes baseline generation awkward, stop and invoke grill.

## 43. Supervisor And Entrypoint

Entrypoint should prepare runtime dirs, run one-shot apply, prepare workspace, and start Supervisor.

Entrypoint should run:

```bash
/opt/agentbox/bin/persistd apply
```

If apply exits non-zero, entrypoint should stop before Supervisor starts.

Do not have Supervisor autorestart `persistd apply`.

Supervisor should run:

```ini
[program:persistd]
command=/opt/agentbox/bin/persistd daemon
user=root
autorestart=true
priority=1
```

code-server can start under Supervisor too.

code-server remains gated by `/run/persistd/ready`.

`persistd daemon` must not replay apply when Supervisor restarts it.

## 44. code-server Readiness Patch

Update readiness patch expectations:

Keep:

```text
/run/persistd/ready
```

Remove reliance on:

```text
/run/persistd/restore-failed
/run/persistd/watch-failed
```

Daemon readiness failure details should come from a simple status surface.

If boot apply fails before Supervisor starts, failure details live in `.internal/state.sqlite` and `/data/persistd/.internal/apply-error.log` where possible.

Options:

- keep page generic: "persistd is not ready"
- have code-server execute `persistd status --json`.
- have persistd write a small read-only status summary file.

This was not fully settled.

Invoke the grill skill before changing the readiness UX if uncertain.

## 45. Testing Strategy

Tests must be clean and comprehensive.

Do not rely only on happy-path smoke tests.

Use unit tests for pure path and metadata logic.

Use integration tests for Linux filesystem behavior.

Use Docker smoke tests for real image startup.

Rust testing rules:

- Put pure logic unit tests beside the module with `#[cfg(test)]`.
- Put cross-module behavior tests in `packages/persistd/tests/`.
- Use `tempfile` or a controlled temp directory for filesystem tests.
- Prefer real filesystem operations over mocks.
- Prefer real SQLite temp databases over mocking SQLite.
- Keep tests Linux-focused; persistd is a Linux daemon.
- Use `std::os::unix` APIs in tests where path bytes and metadata matter.
- Test behavior through module interfaces, not private helpers.
- Avoid snapshot tests for filesystem state unless the snapshot is genuinely clearer than explicit assertions.
- Avoid asserting exact internal DB rows unless the schema itself is the behavior under test.
- Use table tests for path normalization, exclusions, and baseline comparison.
- Use property/fuzz-style tests later for path byte encoding if a custom encoding is introduced.
- Use serial execution for tests that require root-only features or global filesystem assumptions.
- Mark permission-dependent tests clearly and skip only when the kernel/container genuinely cannot perform the operation.
- Every skipped test must explain what capability was missing.

Recommended test crates to evaluate with `research`:

- `tempfile` for temp dirs/files.
- `assert_cmd` if CLI process tests become useful.
- `predicates` if CLI output assertions need it.
- `proptest` if path encoding or metadata parser fuzzing becomes important.
- `serial_test` only if unavoidable for global-state tests.

Do not add these test crates preemptively.

Add them when a real test needs them.

Testing should follow vertical TDD:

1. write one behavior test.
2. make it pass.
3. refactor if needed.
4. move to the next behavior.

Do not write a giant suite against imagined module shapes before the first vertical slice works.

## 46. Required Test Areas

Path tests:

- normal absolute paths.
- spaces.
- percent signs.
- newlines.
- Unicode.
- non-UTF-8 bytes on Linux.
- long path components.
- duplicate slash normalization.
- `..` handling.
- root path rejection.
- symlink ancestor safety.

Baseline tests:

- baseline generation excludes itself.
- baseline contains all image paths.
- file hash stored.
- symlink target stored.
- mode/uid/gid stored.
- compare equal path prunes delta.
- compare changed path writes delta.
- touched-but-equal large file does not persist.

Changed tests:

- regular file create/update.
- directory create/update metadata.
- symlink create/update.
- hardlink preserve or fallback.
- metadata-only change creates `changed/`.
- file changing during copy is retried/requeued.

Removed tests:

- delete image file creates marker.
- delete image directory creates marker.
- delete new file prunes state without marker.
- remove marker undeletes image file.
- `removed/` plus `changed/` means changed wins.

Metadata tests:

- fallback xattr record applies.
- stale metadata pruned.
- user-edited metadata honored.
- duplicate metadata rejected or compacted.
- missing normal path metadata dropped.
- fallback-only special record allowed.

Internal DB tests:

- DB rebuilds from public truth.
- DB never overrides public truth.
- corrupt DB is rebuilt or fails clearly.
- lock prevents second daemon.
- command socket uses single writer.

Daemon tests:

- status talks to daemon.
- doctor talks to daemon.
- prune talks to daemon.
- commands fail when daemon not running.
- ready written only after watcher/audit initialized.
- ready removed at startup.

Crash tests:

- crash during changed write.
- crash during metadata rewrite.
- crash during apply.
- crash before ready.
- crash after ready with pending queue.

Platform capability tests:

- fake/probed support matrix.
- xattr native vs fallback.
- ACL native vs fallback.
- hardlink native vs fallback.
- FIFO native vs fallback.
- device node denied path.

## 47. Smoke Tests

Existing smoke tests must be updated.

They currently reference old or mismatched persistence paths in places.

New expected paths:

```text
/data/persistd/changed
/data/persistd/removed
/data/persistd/metadata.jsonl
/data/persistd/.internal/state.sqlite
/opt/persistd/baseline.sqlite
/run/persistd/ready
```

Smoke should verify:

- fresh boot reaches readiness.
- file modification persists across restart.
- file deletion persists across restart.
- deleting marker from `removed/` restores image file.
- returning file to baseline prunes changed entry.
- large touched-but-equal file does not balloon volume.
- custom config exclusions are ignored, not pruned.

## 48. Research Snapshot

Research date: 2026-05-18.

Official/current versions observed:

- Rust stable 1.95.0.
- Rust Docker official image includes `rust:1.95.0-trixie`.
- `rusqlite` 0.39.0.
- `blake3` 1.8.5.
- `nix` 0.31.3.
- `libc` 0.2.186.
- `serde` 1.0.228.
- `serde_json` 1.0.149.
- `clap` 4.6.1.
- `tracing` 0.1.44.
- `tracing-subscriber` 0.3.23.
- `inotify` 0.11.1.
- `xattr` 1.6.1.
- `walkdir` 2.5.0.
- `filetime` 0.2.29.
- `crossbeam-channel` 0.5.15.
- `thiserror` 2.0.18.
- `anyhow` 1.0.102.

Before implementation, verify versions again if meaningful time has passed.

## 49. Implementation Slices

### Slice 1: Rust Scaffold

Create Rust package under `packages/persistd`.

Add `Cargo.toml`.

Add `Cargo.lock`.

Add CLI with commands:

```bash
persistd apply
persistd daemon
persistd status
persistd doctor
persistd prune
```

Implement command stubs.

Wire logging.

Wire tests.

Update CI to compile and run tests.

### Slice 2: Public Layout

Implement layout creation.

Create:

```text
/data/persistd/config.json
/data/persistd/changed/
/data/persistd/removed/
/data/persistd/metadata.jsonl
/data/persistd/.internal/
```

Do not create obsolete Go layout.

Add layout tests.

### Slice 3: Internal DB And Lock

Implement `.internal/state.sqlite`.

Implement schema migrations.

Implement lock.

Implement corrupt/stale DB handling.

Prove public truth wins.

### Slice 4: Baseline Generator

Implement build-time baseline generation.

Output:

```text
/opt/persistd/baseline.sqlite
```

Hash regular files with BLAKE3.

Capture all required metadata.

Exclude runtime/self paths.

Add baseline tests.

### Slice 5: Baseline Compare

Implement compare-first update pipeline.

Implement cheap gates.

Implement hash fallback.

Implement prune-on-equal.

Add tests for large touched-but-equal file.

### Slice 6: Capture Into Public Truth

Implement writes to `changed/`.

Implement writes to `removed/`.

Implement `metadata.jsonl` fallback writes.

Implement atomic writes.

Implement crash recovery.

### Slice 7: Apply Public Truth

Implement Rust-native apply.

Apply `removed/`.

Apply `changed/`.

Apply fallback metadata.

Ensure changed wins over removed.

Ensure symlink ancestor safety.

Ensure idempotence.

### Slice 8: Watcher

Implement raw inotify watcher.

Detect overflow.

Feed compare-first update pipeline.

Do not write before comparing.

Add event tests.

### Slice 9: Rolling Audit

Implement continuous budgeted audit.

Scan whole non-excluded live filesystem.

Feed compare-first update pipeline.

Recover missed events.

### Slice 10: Daemon Lifecycle

Implement full `persistd daemon`.

Open internal state and report the last apply status if useful.

Initialize watcher/audit.

Write ready.

Serve control socket.

Stay running.

### Slice 11: Status, Doctor, Prune

Implement control socket protocol.

Implement `status`.

Implement `doctor`.

Implement `prune`.

Ensure commands fail if daemon is not running.

### Slice 12: Docker And Readiness

Update Dockerfile.

Generate baseline in image build.

Update Supervisor.

Update entrypoint.

Update code-server readiness patch.

Run smoke tests.

### Slice 13: Remove Go

Delete Go sources only after Rust path passes tests.

Remove Go module files.

Remove Go CI.

Remove Go builder.

Update docs and TODOs.

## 50. Grill Triggers

Stop and invoke the grill skill if any of these become unclear:

- exact baseline schema.
- exact `metadata.jsonl` schema.
- command socket protocol.
- readiness failure UX.
- default exclusions.
- ACL crate choice.
- hardlink fallback semantics.
- sparse file policy.
- non-UTF-8 path representation in JSONL.
- whether to fail or degrade when device apply lacks permission.
- whether `doctor` repair crosses into destructive behavior.
- whether `prune` should remove a class of public data.
- Docker build order for baseline generation.

Do not invent a policy silently.

Ask one question at a time.

For each question, provide a recommended answer.

## 51. Acceptance Criteria

The rewrite is acceptable when:

- Go `persistd` is gone.
- Rust `persistd` builds in Docker.
- `/opt/persistd/baseline.sqlite` exists in the image.
- `/data/persistd` uses the new layout.
- `persistd apply` is one-shot and exits before Supervisor starts.
- `persistd daemon` is the only long-running writer.
- Supervisor runs `persistd daemon`, not apply.
- `persistd status`, `doctor`, and `prune` talk to the daemon.
- readiness is based only on `/run/persistd/ready`.
- `persistd daemon` does not replay apply when autorestarted.
- changed files persist across restart.
- deleted files persist across restart.
- image updates flow through for untouched files.
- user changes win over image updates.
- baseline-equal files are pruned from `changed/`.
- touched-but-equal large files do not balloon the volume.
- `metadata.jsonl` is compact current state.
- `.internal/state.sqlite` can be rebuilt from public truth.
- tests cover the edge cases listed above.

## 52. Final Warning

Do not port the Go design.

Do not recreate a hidden database-backed backup daemon.

Do not let internal state become public truth.

Do not skip baseline comparison.

Do not silently lose Linux metadata.

Do not add clever command fallbacks.

Keep the model simple:

```text
image baseline + public user delta + internal daemon oil
```
