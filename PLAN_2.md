# PLAN_2.md - Persistd Rust Rewrite Repair Plan

## 0. Purpose

This document is the second handoff plan for the Rust `persistd` rewrite.

It exists because the current implementation has a useful Rust vertical slice, but it drifts from the full `PLAN.md` product contract in several correctness-critical areas.

Give this file plus `PLAN.md` to a fresh agent or junior engineer with no context. They should be able to continue the rewrite without rediscovering the current drift.

This file does not replace `PLAN.md`.

`PLAN.md` remains the product contract.

`PLAN_2.md` is the repair and completion plan for bringing the current implementation back into alignment with that contract.

## 0.1 Required Reading Order

Read these files in this order before changing code:

1. [`PLAN.md`](PLAN.md)
2. [`PLAN_2.md`](PLAN_2.md)
3. [`.agents/skills/grill/SKILL.md`](.agents/skills/grill/SKILL.md)
4. [`.agents/skills/research/SKILL.md`](.agents/skills/research/SKILL.md)
5. [`.agents/skills/refactor/SKILL.md`](.agents/skills/refactor/SKILL.md)
6. [`.agents/skills/list/SKILL.md`](.agents/skills/list/SKILL.md)
7. [`packages/persistd/src/cli.rs`](packages/persistd/src/cli.rs)
8. [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)
9. [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
10. [`packages/persistd/src/apply.rs`](packages/persistd/src/apply.rs)
11. [`packages/persistd/src/baseline.rs`](packages/persistd/src/baseline.rs)
12. [`packages/persistd/src/metadata.rs`](packages/persistd/src/metadata.rs)
13. [`packages/persistd/src/watch.rs`](packages/persistd/src/watch.rs)
14. [`packages/persistd/src/audit.rs`](packages/persistd/src/audit.rs)
15. [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)
16. [`Dockerfile`](Dockerfile)
17. [`rootfs/opt/agentbox/entrypoint.sh`](rootfs/opt/agentbox/entrypoint.sh)
18. [`rootfs/etc/supervisor/conf.d/agentbox.conf`](rootfs/etc/supervisor/conf.d/agentbox.conf)
19. [`vendor/code-server/patches/0001-gate-code-server-on-persistd-readiness.patch`](vendor/code-server/patches/0001-gate-code-server-on-persistd-readiness.patch)
20. [`.github/scripts/smoke.sh`](.github/scripts/smoke.sh)

## 0.2 Skills To Use

Use these skills exactly as `PLAN.md` requires:

- `list`: use when unsure where to look.
- `research`: use before finalizing dependency versions, crate features, Linux filesystem APIs, SQLite modes, Docker images, ACL/xattr/capability crates, inotify behavior, sparse file strategy, or CI actions.
- `refactor`: use before changing module boundaries, daemon ownership, command routing, or update/apply interfaces.
- `grill`: use whenever product semantics are unclear. Ask one decision question at a time and include a recommended answer.

Relevant skill files:

- [`.agents/skills/list/SKILL.md`](.agents/skills/list/SKILL.md)
- [`.agents/skills/research/SKILL.md`](.agents/skills/research/SKILL.md)
- [`.agents/skills/refactor/SKILL.md`](.agents/skills/refactor/SKILL.md)
- [`.agents/skills/grill/SKILL.md`](.agents/skills/grill/SKILL.md)

## 0.3 Current Implementation Snapshot

The current implementation already has valuable pieces:

- Rust crate exists under [`packages/persistd`](packages/persistd).
- Old Go sources appear to be gone.
- Commands exist: `apply`, `daemon`, `status`, `doctor`, `prune`.
- Public layout constants mostly match `PLAN.md`.
- Docker builds Rust binaries.
- Docker generates `/opt/persistd/baseline.sqlite`.
- Entrypoint runs `persistd apply`.
- Supervisor runs `persistd daemon`.
- code-server gates readiness on `/run/persistd/ready`.
- A baseline generator exists.
- Update/apply/watch/audit modules exist.
- Basic compare-first behavior exists for regular files.
- Some unit tests exist.

Treat this as a good vertical slice, not as finished behavior.

## 0.4 Highest-Risk Current Drift

The most important current drift from `PLAN.md`:

1. `persistd apply` does not require or validate `/opt/persistd/baseline.sqlite`.
2. `persistd apply` does not probe capabilities, normalize public truth, rebuild indexes after apply, or write failure diagnostics.
3. The daemon writes ready while status is mostly hardcoded.
4. Watcher, auditor, doctor, and prune can mutate state without a single serialized writer pipeline.
5. `metadata.jsonl` is used for ordinary metadata on every changed path, despite `PLAN.md` saying fallback-only current state.
6. xattrs, ACLs, file capabilities, hardlinks, sparse files, FIFOs, and device records are not implemented.
7. Non-UTF-8 Linux path bytes are lost via `to_string_lossy`.
8. Baseline `mtime_ns` stores only nanoseconds within the second, not full nanoseconds since epoch.
9. Crash safety is too weak for the product contract.
10. `doctor` and `prune` are placeholders.
11. Smoke tests do not cover enough acceptance criteria.

## 0.5 Non-Negotiables From PLAN.md

Do not weaken these:

- Public truth is `/data/persistd/changed`, `/data/persistd/removed`, and `/data/persistd/metadata.jsonl`.
- `.internal/state.sqlite` is not public truth.
- Public truth wins over internal state.
- `apply` and `daemon` are the only commands allowed to mutate persistence or filesystem state.
- `status`, `doctor`, and `prune` must talk to the daemon and fail clearly if daemon is not running.
- Boot apply and live daemon are separate phases.
- `daemon` must not replay boot apply on restart.
- Baseline comparison must happen before writing to `changed`.
- Watcher and rolling audit feed the same update decision.
- `metadata.jsonl` is fallback-only current state.
- Rust-native apply only.
- No old Go command surface.
- No hidden database-backed backup daemon.

## 0.6 Development Environment Note

This daemon is Linux-specific.

Running `cargo test --manifest-path packages/persistd/Cargo.toml --all-targets --all-features` on Windows currently fails while compiling Linux inotify dependencies.

Do not spend time making Linux-only daemon code compile natively on Windows unless the project explicitly decides to support that.

Run Rust tests in one of these environments:

- GitHub Actions Ubuntu.
- A local Linux machine.
- WSL2.
- A Docker build/test image.

Add a Linux test command to the handoff notes for every completed slice.

## 1. Desired End State

The rewrite is back in alignment with `PLAN.md` when:

- Docker image contains `/opt/persistd/baseline.sqlite`.
- `/data/persistd` uses only the new public layout.
- `persistd apply` validates baseline and public truth before applying.
- `persistd apply` records failures in `.internal/state.sqlite` and `apply-error.log` where possible.
- `persistd daemon` starts watcher, audit, control socket, and only then writes `/run/persistd/ready`.
- `persistd daemon` owns all live mutation after startup.
- `status`, `doctor`, and `prune` are routed through the daemon.
- `status` reports real lifecycle, watcher, audit, capability, error, and count data.
- `doctor` safely validates and repairs only non-destructive state.
- `prune` intentionally removes only explicitly safe stale public data and reports all removals.
- Regular file changes persist across restart.
- Deleted image paths persist across restart.
- New files persist across restart.
- Untouched image updates flow through.
- User changes win over image updates.
- Baseline-equal changed entries are pruned.
- Touched-but-equal large files do not balloon the volume.
- Metadata-only changes are preserved.
- Fallback-only metadata is compact current state.
- Non-UTF-8 paths have a lossless representation.
- Unsupported Linux filesystem features fail clearly or are represented in fallback metadata.
- Smoke tests prove the core acceptance criteria.

## 2. Compatibility Stance

Follow `PLAN.md`: there are no users relying on the old Go storage format.

Therefore:

- No Go storage compatibility.
- No old command compatibility for `run`, `restore`, `watch`, or `check`.
- No compatibility with old internal DB shape.
- Public config compatibility starts now because `/data/persistd/config.json` is user-editable.
- Public truth compatibility starts now because `changed`, `removed`, and `metadata.jsonl` are user-facing.

Once a public truth encoding is improved in this plan, document its versioning and migration rules.

If the current public truth encoding is found to be unable to represent non-UTF-8 paths or special file metadata safely, use `grill` before locking in the replacement.

Recommended answer: introduce a versioned, lossless path representation in `metadata.jsonl` and internal APIs while preserving normal UTF-8 display paths for human ergonomics.

## 3. Architectural Repair Direction

The current file names mostly match `PLAN.md`, but several modules are too shallow or have leaky responsibility.

Use the `refactor` skill before significant changes.

Target deeper module shape:

- `paths.rs`: only path constants and resolved locations.
- `config.rs`: config loading, defaults, validation, exclusion matching.
- `baseline.rs`: baseline schema, generation, loading, lookup, comparison facts.
- `public.rs` or expanded `metadata.rs`: all public truth IO, path encoding, atomic writes, compaction, validation.
- `rootfs.rs`: live filesystem inspection, hashing, copy/apply primitives, fsync, xattrs, ACLs, capabilities, hardlinks, sparse files, special files, symlink ancestor safety.
- `capabilities.rs`: volume and runtime capability probe results.
- `update.rs`: pure-ish compare-first decision pipeline plus effectful public truth mutation through public/rootfs modules.
- `apply.rs`: apply public truth to live rootfs, no baseline comparison.
- `watch.rs`: raw inotify only; emits dirty candidates.
- `audit.rs`: rolling audit only; emits dirty candidates.
- `daemon.rs`: lifecycle, single writer queue, control socket, status, readiness.
- `status.rs`: report construction from daemon state.
- `doctor.rs`: safe validation/repair commands executed by daemon writer.
- `prune.rs`: destructive cleanup commands executed by daemon writer.
- `internal.rs`: state DB, lock, diagnostics, cached indexes, command status.

Important: do not create ports or adapters unless there are real variations.

For filesystem and SQLite tests, use real temp directories and real SQLite.

## 4. Vertical Slice Rules

Each slice below must be done vertically:

1. Add or update one behavior test.
2. Confirm it fails for the expected reason.
3. Implement the smallest useful change.
4. Run the relevant tests.
5. Refactor only after green.
6. Update smoke or integration coverage when the slice changes image behavior.

Do not write a giant imagined test suite before implementation.

Do not do broad refactors while tests are red.

Do not silently decide unclear product semantics. Use `grill`.

## 5. Slice 0 - Linux Test Harness And Baseline Audit

### Goal

Make it easy for future agents to run the Rust test suite in a Linux environment and to see current behavior.

### Files

- [`package.json`](package.json)
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
- [`Dockerfile`](Dockerfile)
- Optional new script under [`scripts/`](scripts)

### Work

1. Add a documented local Linux test command.
2. If useful, add a Docker-based test target that runs:
   - `cargo fmt --manifest-path packages/persistd/Cargo.toml --check`.
   - `cargo clippy --manifest-path packages/persistd/Cargo.toml --all-targets --all-features -- -D warnings`.
   - `cargo test --manifest-path packages/persistd/Cargo.toml --all-targets --all-features`.
3. Do not try to make `inotify` compile on native Windows unless requested.
4. Verify CI still runs Rust checks on Ubuntu.

### Tests

No new product tests required in this slice.

### Acceptance

- Fresh agent can run tests in Linux without guessing.
- CI remains the source of truth for Linux daemon tests.

## 6. Slice 1 - Apply Must Require Baseline And Record Failures

### PLAN.md References

- `PLAN.md` section 8: `persistd apply`.
- `PLAN.md` section 15: Baseline.
- `PLAN.md` section 51: Acceptance Criteria.

### Current Drift

`persistd apply` currently creates layout, locks, opens state DB, loads config, applies public truth, and records success.

It does not:

- open `/opt/persistd/baseline.sqlite`;
- fail not-ready if baseline is missing or corrupt;
- probe capabilities;
- validate public truth;
- compact metadata before apply;
- rebuild internal indexes after apply;
- record apply errors in `.internal/state.sqlite`;
- write `/data/persistd/.internal/apply-error.log`.

### Files

- [`packages/persistd/src/cli.rs`](packages/persistd/src/cli.rs)
- [`packages/persistd/src/baseline.rs`](packages/persistd/src/baseline.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)
- [`packages/persistd/src/layout.rs`](packages/persistd/src/layout.rs)
- [`packages/persistd/src/metadata.rs`](packages/persistd/src/metadata.rs)
- New or expanded public truth module.

### Tests First

Add integration tests, preferably under `packages/persistd/tests/`, for:

1. `apply` fails when baseline is missing.
2. `apply` fails when baseline is corrupt.
3. `apply` removes stale ready before doing work.
4. `apply` does not write ready on failure.
5. `apply` writes `apply-error.log` on failure where possible.
6. `apply` records last apply error in state DB where possible.
7. `apply` compacts metadata before applying.
8. `apply` rebuilds public indexes after applying.

### Implementation Steps

1. Extract `run_apply` from `cli.rs` into `apply.rs` or a new `boot.rs` lifecycle function.
2. Open `BaselineDb::open(&paths.baseline_db)` before applying public truth.
3. Treat missing/corrupt baseline as fatal.
4. Add `StateDb::record_phase_failure(phase, error_summary)`.
5. Add `StateDb::record_diagnostic(key, value)` or similar for structured status.
6. Add `internal::write_error_log(path, error)` for `apply-error.log`.
7. Ensure errors are recorded before returning non-zero.
8. Ensure stale ready is removed before all work.
9. Compact and validate metadata before apply.
10. Rebuild public indexes after apply, not only when DB opens.

### Acceptance

- Missing baseline prevents startup.
- Corrupt baseline prevents startup.
- Failure details are visible without old marker files.
- `apply` still never writes `/run/persistd/ready`.
- `apply` success updates state DB.

## 7. Slice 2 - Public Truth Module And Lossless Path Encoding

### PLAN.md References

- `PLAN.md` section 5: Public Truth.
- `PLAN.md` section 22: Public Path Mapping.
- `PLAN.md` section 46: Path tests.
- `PLAN.md` section 50: Grill Triggers.

### Current Drift

Public truth path handling is duplicated in `apply.rs`, `update.rs`, `audit.rs`, `watch.rs`, `internal.rs`, and `baseline.rs`.

Several places use `to_string_lossy()`, which destroys non-UTF-8 Linux path bytes.

This violates the plan's requirement to handle non-UTF-8 paths.

### Files

- New [`packages/persistd/src/public.rs`](packages/persistd/src/public.rs)
- [`packages/persistd/src/lib.rs`](packages/persistd/src/lib.rs)
- [`packages/persistd/src/metadata.rs`](packages/persistd/src/metadata.rs)
- [`packages/persistd/src/apply.rs`](packages/persistd/src/apply.rs)
- [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
- [`packages/persistd/src/audit.rs`](packages/persistd/src/audit.rs)
- [`packages/persistd/src/watch.rs`](packages/persistd/src/watch.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)
- [`packages/persistd/src/baseline.rs`](packages/persistd/src/baseline.rs)

### Decision Required

Use `grill` before finalizing non-UTF-8 JSONL representation.

Recommended answer:

- Use a path value type internally that stores bytes.
- For normal UTF-8 absolute paths, keep readable `"/etc/hosts"` display.
- For metadata and baseline schemas, store both:
  - `path_display` for humans;
  - `path_bytes_b64` or equivalent lossless encoding for exact identity.
- In filesystem directory layouts under `changed/` and `removed/`, paths are already byte paths on disk. Do not force them through UTF-8 strings.

### Tests First

Add path tests for:

1. Normal absolute path.
2. Spaces.
3. Percent signs.
4. Newlines.
5. Unicode.
6. Non-UTF-8 bytes.
7. Duplicate slash normalization.
8. `.` handling.
9. `..` rejection.
10. Root path rejection.
11. Symlink ancestor safety remains intact.

### Implementation Steps

1. Introduce a `PublicPath` type.
2. Move normalization and exclusion matching to one module.
3. Make `PublicPath` impossible to construct for `/`, relative paths, or paths containing `..`.
4. Make conversion from root-relative `Path` preserve bytes on Unix.
5. Replace duplicated `is_excluded` helpers.
6. Replace duplicated `format_public_path` helpers.
7. Update metadata schema to support lossless path representation.
8. Update baseline schema if needed, using a migration strategy since baseline is image-generated.
9. Update tests to use behavior through public interfaces, not private helpers.

### Acceptance

- No `to_string_lossy()` is used for identity decisions.
- Non-UTF-8 paths can be persisted, applied, audited, and watched.
- Human-readable paths remain available for status and diagnostics.

## 8. Slice 3 - Baseline Schema Correctness

### PLAN.md References

- `PLAN.md` section 15: Baseline.
- `PLAN.md` section 16: Baseline Record Fields.
- `PLAN.md` section 19: Gated Comparison.

### Current Drift

Baseline currently:

- stores regular file hashes;
- stores kind, mode, uid, gid, size;
- stores symlink target;
- has xattr/ACL/capability columns but writes `None`;
- stores only `mtime_nsec`, not full timestamp;
- uses lossy path strings;
- does not capture hardlink identity;
- does not capture sparse file facts;
- does not capture xattrs, ACLs, or capabilities.

### Files

- [`packages/persistd/src/baseline.rs`](packages/persistd/src/baseline.rs)
- New [`packages/persistd/src/rootfs.rs`](packages/persistd/src/rootfs.rs)
- New [`packages/persistd/src/public.rs`](packages/persistd/src/public.rs)

### Research Required

Use `research` before finalizing:

- xattr crate/API.
- ACL crate/API.
- Linux file capability representation.
- hardlink identity representation.
- sparse file strategy.
- SQLite schema shape if adding BLOB path columns.

### Tests First

Add baseline generation tests for:

1. Full mtime nanoseconds since epoch.
2. Non-UTF-8 path identity.
3. Symlink target bytes if possible.
4. Device major/minor.
5. FIFO record.
6. Hardlink identity for two paths pointing at one inode.
7. xattr facts where supported.
8. ACL facts where supported.
9. File capability facts where supported.
10. Baseline excludes itself and runtime roots.

Each permission-dependent test must skip only when the kernel/container lacks the capability, and the skip message must say why.

### Implementation Steps

1. Fix mtime storage to full nanoseconds.
2. Add schema versioning to baseline DB.
3. Add lossless path identity.
4. Move filesystem fact collection into `rootfs.rs`.
5. Collect xattrs.
6. Collect ACLs if supported.
7. Collect capabilities if supported.
8. Collect hardlink identity using device/inode/nlink.
9. Collect sparse file facts if useful for compare/apply.
10. Keep baseline generation deterministic.

### Acceptance

- Baseline records enough facts to decide image equality.
- Missing/corrupt/unsupported facts fail clearly or are represented explicitly.
- Baseline comparison can be correct without guessing.

## 9. Slice 4 - Capability Probing

### PLAN.md References

- `PLAN.md` section 3: Hard Requirements.
- `PLAN.md` section 8: Apply and daemon steps.
- `PLAN.md` section 28: Platform Capability Policy.

### Current Drift

No capability probe exists.

Status does not report real capabilities.

Unsupported filesystem features are either ignored or fail late.

### Files

- New [`packages/persistd/src/capabilities.rs`](packages/persistd/src/capabilities.rs)
- [`packages/persistd/src/status.rs`](packages/persistd/src/status.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)
- [`packages/persistd/src/cli.rs`](packages/persistd/src/cli.rs)
- [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)

### Research Required

Use `research` for Linux APIs and crates for:

- xattr support.
- ACL support.
- file capabilities.
- hardlinks.
- FIFOs.
- device node creation.
- sparse file copy.
- fsync behavior for directories and files.

### Tests First

Add tests for:

1. Probe result can be serialized into state DB/status.
2. Probe detects basic support for hardlinks and symlinks in temp volume.
3. Probe records unsupported permission-dependent operations without panicking.
4. Apply/daemon fail not-ready only for required capabilities.
5. Optional/degraded capability is visible in status/doctor.

### Implementation Steps

1. Define a capability report type.
2. Probe on `/data/persistd` volume, not only rootfs.
3. Probe runtime apply capabilities on a safe temp area.
4. Store latest report in state DB.
5. Expose report in status.
6. Use capability report to decide native storage vs fallback metadata.
7. Use `grill` if deciding fail-vs-degrade for a feature changes product semantics.

### Acceptance

- `apply` and `daemon` know whether needed persistence operations are supported before claiming readiness.
- Status/doctor can explain missing support.

## 10. Slice 5 - Metadata Must Be Fallback-Only

### PLAN.md References

- `PLAN.md` section 5: Public Truth.
- `PLAN.md` section 23: Metadata.
- `PLAN.md` section 51: Acceptance Criteria.

### Current Drift

`update.rs` writes a metadata record for every changed file, directory, or symlink.

`PLAN.md` says `metadata.jsonl` is fallback-only current state, not a journal and not ordinary metadata duplication.

### Files

- [`packages/persistd/src/metadata.rs`](packages/persistd/src/metadata.rs)
- [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
- [`packages/persistd/src/apply.rs`](packages/persistd/src/apply.rs)
- New or expanded `public.rs`.
- New `rootfs.rs`.

### Decision Required

Use `grill` before finalizing exact metadata schema.

Recommended answer:

- Native filesystem facts stored directly in `changed/` should not be duplicated in metadata.
- Metadata records should exist only for facts that cannot be represented natively or need fallback:
  - xattrs not supported by volume;
  - ACLs not supported by volume;
  - file capabilities not supported by volume;
  - special file records when native storage is impossible;
  - hardlink topology if native changed storage cannot preserve it;
  - sparse file policy diagnostics if needed.

### Tests First

Add tests for:

1. Regular changed file does not create metadata if all facts are natively represented.
2. Metadata-only chmod/chown/mtime change creates the minimal needed public truth.
3. Fallback xattr record is written only when xattr cannot be stored natively.
4. Stale metadata is pruned when path equals baseline.
5. Duplicate metadata compacts to current state.
6. Missing normal path metadata is dropped.
7. Fallback-only special record is allowed.

### Implementation Steps

1. Define what native facts are represented by `changed/` on the current volume.
2. Change `metadata_record` creation to be conditional.
3. Make compaction validate records.
4. Add schema/version fields if needed.
5. Ensure apply uses fallback metadata after changed/removed.
6. Ensure doctor can compact and validate safely.

### Acceptance

- `metadata.jsonl` remains small and meaningful.
- It does not become a second shadow database.

## 11. Slice 6 - Rootfs Module And Filesystem Fidelity

### PLAN.md References

- `PLAN.md` section 3: Hard Requirements.
- `PLAN.md` section 20: Delta Decisions.
- `PLAN.md` section 25: Apply Rules.
- `PLAN.md` section 29: Special File Policy.
- `PLAN.md` section 30: Sparse Files.

### Current Drift

Filesystem operations are scattered between `baseline.rs`, `update.rs`, and `apply.rs`.

Unsupported file types bail.

Sparse files, hardlinks, xattrs, ACLs, capabilities, and special files are not implemented.

### Files

- New [`packages/persistd/src/rootfs.rs`](packages/persistd/src/rootfs.rs)
- [`packages/persistd/src/baseline.rs`](packages/persistd/src/baseline.rs)
- [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
- [`packages/persistd/src/apply.rs`](packages/persistd/src/apply.rs)

### Research Required

Use `research` before finalizing implementations for:

- sparse file copy and detection;
- hardlink preservation;
- xattrs;
- ACLs;
- capabilities;
- `mknod`;
- FIFOs;
- fsync.

### Tests First

Add rootfs behavior tests for:

1. Regular file copy preserves bytes.
2. Directory metadata apply.
3. Symlink apply.
4. Hardlinks preserve or create fallback metadata.
5. FIFO native or fallback.
6. Device node record and denied apply diagnostic.
7. Sparse file remains logically correct and sparse when possible.
8. xattr native or fallback.
9. ACL native or fallback.
10. Capability native or fallback.
11. File changing during copy is retried or requeued.

### Implementation Steps

1. Move low-level filesystem inspection into `rootfs.rs`.
2. Define `RootfsEntry` or similar fact type.
3. Define `CapturedDelta` or similar for native changed storage plus fallback metadata.
4. Implement robust copy with source stability check.
5. Add fsync for temp file and parent dir around atomic writes.
6. Add native special file support where possible.
7. Add fallback records when native support is unavailable.
8. Keep symlink ancestor safety centralized in `rootfs.rs`.

### Acceptance

- Update/apply no longer contain low-level scattered filesystem policy.
- Unsupported user data is not silently discarded.
- Failure modes are explicit and diagnosable.

## 12. Slice 7 - Correct Compare Gates

### PLAN.md References

- `PLAN.md` section 17: Definition Of Change.
- `PLAN.md` section 18: Compare-First Update Pipeline.
- `PLAN.md` section 19: Gated Comparison.

### Current Drift

The update pipeline compares kind, mode, uid/gid, size, hash, symlink target, and device numbers.

It does not compare:

- full mtime where meaningful;
- xattrs;
- ACLs;
- capabilities;
- hardlink topology;
- sparse facts where policy requires them.

It hashes regular files whenever size/mode/uid/gid match, which is correct but may need budget control.

### Files

- [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
- [`packages/persistd/src/baseline.rs`](packages/persistd/src/baseline.rs)
- New `rootfs.rs`.
- New `capabilities.rs`.

### Tests First

Add compare tests for:

1. Equal file with changed mtime only, depending on final mtime policy.
2. Metadata-only change persists.
3. xattr change persists.
4. ACL change persists.
5. Capability change persists.
6. Symlink target change persists.
7. Device major/minor change persists or records diagnostic.
8. Baseline-equal file removes changed and removed entries.
9. Touched-but-equal large file does not persist.

### Implementation Steps

1. Define a single compare function that takes baseline facts, live facts, config, and capabilities.
2. Return an explicit decision:
   - ignore excluded;
   - prune equal;
   - persist changed;
   - persist removed;
   - fail diagnostic.
3. Keep hashing gated by cheap facts and budget policy.
4. Ensure content equality is always correct in edge cases.
5. Store or expose diagnostics when comparison cannot be safely completed.

### Acceptance

- A live path is changed exactly when it differs from baseline under current config.
- Events alone never create persisted data.

## 13. Slice 8 - Single Writer Runtime

### PLAN.md References

- `PLAN.md` section 9: Single Writer Rule.
- `PLAN.md` section 10: Locking.
- `PLAN.md` section 18: Compare-First Update Pipeline.
- `PLAN.md` section 39: Module Boundaries.

### Current Drift

The process holds a writer lock, but inside the process watcher and auditor threads can both mutate public truth.

Doctor compacts metadata and rebuilds indexes in the control request path.

Prune rebuilds indexes in the control request path.

This can race with watcher/audit metadata writes and public index changes.

### Files

- [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)
- [`packages/persistd/src/watch.rs`](packages/persistd/src/watch.rs)
- [`packages/persistd/src/audit.rs`](packages/persistd/src/audit.rs)
- [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
- [`packages/persistd/src/doctor.rs`](packages/persistd/src/doctor.rs)
- [`packages/persistd/src/prune.rs`](packages/persistd/src/prune.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)

### Refactor Required

Use `refactor` before implementing this slice.

Recommended module shape:

- `watch.rs` emits dirty path candidates only.
- `audit.rs` emits dirty path candidates only.
- `daemon.rs` owns a single writer loop.
- `update.rs`, `doctor.rs`, and `prune.rs` run inside that writer loop.
- Control requests are converted to commands sent to the writer loop.
- Status reads from daemon state snapshots or DB-backed cached state.

### Tests First

Add daemon tests for:

1. Watch candidate and audit candidate for the same path serialize through one update pipeline.
2. Doctor cannot compact metadata while update is writing metadata.
3. Prune cannot remove data while update is writing the same path.
4. Status can be served while writer is busy.
5. Daemon shutdown stops worker threads cleanly in tests.

### Implementation Steps

1. Define internal daemon command enum:
   - dirty path update;
   - doctor request;
   - prune request;
   - status request if needed;
   - shutdown for tests.
2. Make watcher send candidates.
3. Make auditor send candidates.
4. Move `BaselineDb`, `Config`, `CapabilityReport`, and public truth writers into the daemon writer context.
5. Ensure all public truth mutation happens through the writer.
6. Make status use an atomic/synchronized snapshot updated by writer.
7. Keep process-level lock for apply-vs-daemon exclusion.

### Acceptance

- Only one in-process writer mutates public truth at a time.
- The single writer rule is true in practice, not just at process level.

## 14. Slice 9 - Watcher And Audit Lifecycle Status

### PLAN.md References

- `PLAN.md` section 8: Daemon.
- `PLAN.md` section 12: Readiness.
- `PLAN.md` section 26: Watcher.
- `PLAN.md` section 27: Rolling Audit.

### Current Drift

Watcher readiness is acknowledged after setup, but auditor readiness is not similarly synchronized.

Status hardcodes watcher and audit as running.

Watcher overflow only logs a warning.

There is no durable watch-error log.

### Files

- [`packages/persistd/src/watch.rs`](packages/persistd/src/watch.rs)
- [`packages/persistd/src/audit.rs`](packages/persistd/src/audit.rs)
- [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)
- [`packages/persistd/src/status.rs`](packages/persistd/src/status.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)

### Tests First

Add tests for:

1. Daemon does not write ready if watcher initialization fails.
2. Daemon does not write ready if audit initialization fails.
3. Status reports watcher initializing/running/degraded/stopped.
4. Status reports audit initializing/running/degraded/stopped.
5. Overflow records degraded state and audit recovery requirement.
6. Watch errors are recorded in state DB and `watch-error.log`.

### Implementation Steps

1. Add lifecycle state types.
2. Make watcher and audit report ready/failure through channels.
3. Make daemon wait for both before writing ready.
4. Record overflow and errors in daemon state.
5. Expose status from real daemon state.
6. Decide with `grill` whether overflow should degrade or fail readiness.

### Acceptance

- Ready means watcher and audit are actually initialized.
- Status is not fiction.

## 15. Slice 10 - Readiness Semantics And code-server UX

### PLAN.md References

- `PLAN.md` section 12: Readiness.
- `PLAN.md` section 44: code-server Readiness Patch.

### Current Drift

Readiness uses `/run/persistd/ready`, which is good.

The ready file is JSON, not just a marker. That is acceptable if treated as implementation detail.

code-server reads the ready file and returns generic starting messages.

The readiness UX options in `PLAN.md` were not fully settled.

### Files

- [`packages/persistd/src/readiness.rs`](packages/persistd/src/readiness.rs)
- [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)
- [`vendor/code-server/patches/0001-gate-code-server-on-persistd-readiness.patch`](vendor/code-server/patches/0001-gate-code-server-on-persistd-readiness.patch)

### Decision Required

Use `grill` before changing readiness UX beyond generic messages.

Recommended answer:

- Keep code-server UX generic for now.
- Do not make code-server execute `persistd status --json` yet.
- Keep detailed failure state in persistd status/logs.
- Revisit richer UX only after status is real.

### Tests First

Add tests/smoke checks for:

1. No `/run/persistd/restore-failed`.
2. No `/run/persistd/watch-failed`.
3. code-server health returns 503 before ready.
4. code-server health returns 200 after ready.
5. WebSocket requests are gated until ready.

### Acceptance

- Readiness remains based only on `/run/persistd/ready`.
- Failure diagnostics do not require old marker files.

## 16. Slice 11 - Doctor Real Safe Repair

### PLAN.md References

- `PLAN.md` section 8: `persistd doctor`.
- `PLAN.md` section 23: Metadata.
- `PLAN.md` section 46: Required Test Areas.

### Current Drift

Doctor compacts metadata and rebuilds public index.

It does not validate most public truth consistency.

It does not validate baseline schema deeply.

It may race until single writer is fixed.

### Files

- [`packages/persistd/src/doctor.rs`](packages/persistd/src/doctor.rs)
- [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)
- New/expanded `public.rs`.
- New `capabilities.rs`.

### Tests First

Add doctor tests for:

1. Fails clearly when daemon is not running.
2. Runs through control socket.
3. Compacts metadata.
4. Rebuilds state DB indexes.
5. Validates baseline exists and schema version is supported.
6. Detects invalid public paths.
7. Detects changed/removed conflicts.
8. Detects stale metadata.
9. Does not destructively remove user data unless operation is safe normalization.

### Implementation Steps

1. Move doctor execution inside daemon writer.
2. Define safe normalization classes.
3. Implement public truth validation report.
4. Implement metadata compaction with validation.
5. Implement state DB rebuild.
6. Implement baseline validation.
7. Return structured findings and repairs.

### Acceptance

- Doctor is useful and safe.
- Doctor never acts like prune.

## 17. Slice 12 - Prune Real Intentional Cleanup

### PLAN.md References

- `PLAN.md` section 8: `persistd prune`.
- `PLAN.md` section 20: Delta Decisions.
- `PLAN.md` section 50: Grill Triggers.

### Current Drift

Prune is a no-op.

### Files

- [`packages/persistd/src/prune.rs`](packages/persistd/src/prune.rs)
- [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)
- [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
- New/expanded `public.rs`.

### Decision Required

Use `grill` before enabling each destructive prune class.

Recommended first prune classes:

1. Remove baseline-equal `changed/` entries.
2. Remove tombstones for paths no longer present in baseline and with no changed entry.
3. Remove stale metadata for missing normal paths.
4. Remove empty directories left by prune.

Do not prune excluded dormant data until product confirms the behavior.

### Tests First

Add prune tests for:

1. Fails clearly when daemon is not running.
2. Runs through control socket.
3. Removes baseline-equal changed file.
4. Removes stale tombstone.
5. Removes stale metadata.
6. Reports exact removals.
7. Leaves excluded dormant data untouched until explicitly enabled.
8. Leaves user data alone when uncertain.

### Implementation Steps

1. Move prune execution inside daemon writer.
2. Implement one prune class at a time.
3. Return exact removed/skipped lists.
4. Rebuild indexes after prune.
5. Add dry-run only if it becomes necessary. Do not add flag mazes.

### Acceptance

- Prune is intentionally destructive, transparent, and bounded.

## 18. Slice 13 - Apply Public Truth Fully

### PLAN.md References

- `PLAN.md` section 25: Apply Rules.
- `PLAN.md` section 29: Special File Policy.
- `PLAN.md` section 30: Sparse Files.

### Current Drift

Apply supports directories, regular files, and symlinks.

It applies mode, uid/gid, and mtime from metadata.

It does not apply xattrs, ACLs, capabilities, hardlinks, FIFOs, devices, sparse files, or fallback special records.

### Files

- [`packages/persistd/src/apply.rs`](packages/persistd/src/apply.rs)
- New `rootfs.rs`.
- [`packages/persistd/src/metadata.rs`](packages/persistd/src/metadata.rs)
- New/expanded `public.rs`.

### Tests First

Add apply tests for:

1. Removed first, changed second, metadata last.
2. Changed wins over removed.
3. Excluded paths are ignored.
4. Symlink ancestor escape is refused.
5. Hardlink topology applies or falls back.
6. FIFO applies or records diagnostic.
7. Device denied path records diagnostic or fails as decided.
8. xattrs apply.
9. ACLs apply.
10. Capabilities apply.
11. Sparse file logical correctness.
12. Idempotence.

### Implementation Steps

1. Use `public.rs` to enumerate public truth losslessly.
2. Use `rootfs.rs` for all apply operations.
3. Add metadata fallback apply.
4. Add robust error reporting.
5. Keep apply one-shot and no readiness write.

### Acceptance

- Apply can reconstruct all supported persisted state.
- Unsupported apply does not silently discard user data.

## 19. Slice 14 - Status Must Be Real

### PLAN.md References

- `PLAN.md` section 8: `persistd status`.
- `PLAN.md` section 12: Readiness.

### Current Drift

Status currently reports:

- ready from ready file existence;
- phase from ready file existence;
- watch status hardcoded `running`;
- audit status hardcoded `running`;
- no last error;
- dirty queue size hardcoded `0`;
- baseline present by file existence only.

### Files

- [`packages/persistd/src/status.rs`](packages/persistd/src/status.rs)
- [`packages/persistd/src/daemon.rs`](packages/persistd/src/daemon.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)
- New `capabilities.rs`.

### Tests First

Add status tests for:

1. Fails clearly when daemon not running.
2. Reports lifecycle phase.
3. Reports last apply success/failure.
4. Reports watcher status.
5. Reports audit status.
6. Reports capability summary.
7. Reports dirty queue size.
8. Reports public path counts from cached state.
9. Reports last error summary.

### Implementation Steps

1. Define daemon status snapshot.
2. Update snapshot on lifecycle transitions.
3. Update dirty queue size as writer receives candidates.
4. Read capability report from state/snapshot.
5. Validate baseline schema, not just file existence.
6. Print useful human output.
7. Keep `--json` stable enough for automation.

### Acceptance

- Status reflects reality.
- code-server or operators can use status to diagnose readiness failures later.

## 20. Slice 15 - Crash Safety And Atomicity

### PLAN.md References

- `PLAN.md` section 21: Atomicity.
- `PLAN.md` section 46: Crash tests.

### Current Drift

Some writes use temp files and rename.

Missing or incomplete:

- fsync file before rename;
- fsync parent directory after rename;
- stable source copy checks;
- crash recovery for temp files;
- metadata rewrite crash recovery;
- apply crash state;
- dirty path requeue after copy instability.

### Files

- New `rootfs.rs`.
- New/expanded `public.rs`.
- [`packages/persistd/src/metadata.rs`](packages/persistd/src/metadata.rs)
- [`packages/persistd/src/update.rs`](packages/persistd/src/update.rs)
- [`packages/persistd/src/apply.rs`](packages/persistd/src/apply.rs)
- [`packages/persistd/src/internal.rs`](packages/persistd/src/internal.rs)

### Tests First

Add tests for:

1. Crash-like leftover temp in `changed/` is ignored or cleaned safely.
2. Crash-like leftover metadata temp is ignored or recovered.
3. File changes during copy trigger retry/requeue.
4. Apply failure records phase failure.
5. Daemon crash before ready leaves no ready marker.
6. Daemon restart after ready continues protecting without replaying apply.

### Implementation Steps

1. Centralize atomic write helper.
2. fsync temp file.
3. rename.
4. fsync parent directory.
5. Add temp file naming that is ignored by public truth enumeration.
6. Add startup cleanup for abandoned internal work.
7. Add source stability checks for regular file capture.
8. Requeue dirty paths when copy instability is detected.

### Acceptance

- Public truth is either old-good or new-good after crash.
- Temporary files do not become public truth.

## 21. Slice 16 - Smoke Tests To Acceptance Criteria

### PLAN.md References

- `PLAN.md` section 47: Smoke Tests.
- `PLAN.md` section 51: Acceptance Criteria.

### Current Drift

Smoke tests cover:

- fresh boot reaches web app;
- simple file creation persists;
- simple deletion persists;
- same volume recreated applies changes.

Smoke tests do not yet cover several required behaviors.

### Files

- [`.github/scripts/smoke.sh`](.github/scripts/smoke.sh)
- [`.github/workflows/smoke.yml`](.github/workflows/smoke.yml)
- [`.github/workflows/release.yml`](.github/workflows/release.yml)
- [`.github/workflows/smoke-nightly.yml`](.github/workflows/smoke-nightly.yml)

### Tests To Add

Add smoke coverage for:

1. `/opt/persistd/baseline.sqlite` exists.
2. `/data/persistd/.internal/state.sqlite` exists.
3. `/run/persistd/ready` exists after startup.
4. No old readiness failure markers exist.
5. Changed file persists across restart.
6. Deleted image file persists across restart.
7. Removing tombstone from `removed/` restores image file after restart.
8. Returning file to baseline prunes `changed/`.
9. Large touched-but-equal file does not balloon `/data`.
10. Custom config exclusions are ignored, not pruned.
11. `persistd status --json` talks to daemon.
12. `persistd doctor --json` talks to daemon.
13. `persistd prune --json` talks to daemon.

### Acceptance

- Release workflow remains blocked on smoke.
- Nightly smoke exercises the same script.
- Smoke failures print enough container logs and persistd status to debug.

## 22. Slice 17 - Docker And Runtime Cleanup

### PLAN.md References

- `PLAN.md` section 42: Dockerfile Changes.
- `PLAN.md` section 43: Supervisor And Entrypoint.

### Current Drift

Docker mostly aligns.

Potential drift:

- Runtime image still installs `rsync`, even though `persistd` should be Rust-native and not require `rsync`.
- Docker build should be checked carefully to ensure baseline describes final image contents after all runtime files are assembled and before baseline generator is removed.

### Files

- [`Dockerfile`](Dockerfile)
- [`rootfs/opt/agentbox/entrypoint.sh`](rootfs/opt/agentbox/entrypoint.sh)
- [`rootfs/etc/supervisor/conf.d/agentbox.conf`](rootfs/etc/supervisor/conf.d/agentbox.conf)

### Research Required

Use `research` before changing Docker base image versions or action versions.

### Tests First

Docker smoke tests are the main test for this slice.

Also add checks for:

1. `persistd-baseline` is not present in final image if intentionally removed.
2. `persistd` binary exists at `/opt/persistd/bin/persistd`.
3. Baseline does not include `/opt/persistd/baseline.sqlite`.
4. Baseline does not include `/opt/persistd/bin/persistd-baseline` if removed.

### Implementation Steps

1. Decide whether `rsync` is still needed for non-persistd reasons.
2. If not needed, remove it from runtime packages.
3. Verify baseline generation order.
4. Verify entrypoint stops on apply failure.
5. Verify Supervisor does not run apply.

### Acceptance

- Docker runtime matches `PLAN.md` and no obsolete Go/rsync persistence assumptions remain.

## 23. Slice 18 - Test Coverage Matrix

### Goal

Ensure the project has tests for the `PLAN.md` edge cases without creating brittle tests that freeze internal structure.

### Files

- Unit tests beside modules.
- Integration tests under `packages/persistd/tests/`.
- Smoke tests under `.github/scripts/smoke.sh`.

### Required Test Areas

Path tests:

- absolute paths;
- spaces;
- percent signs;
- newlines;
- Unicode;
- non-UTF-8 bytes;
- long components;
- duplicate slashes;
- `..` rejection;
- root path rejection;
- symlink ancestor safety.

Baseline tests:

- self exclusion;
- runtime root exclusion;
- file hash;
- symlink target;
- mode/uid/gid;
- full mtime;
- xattr facts;
- ACL facts;
- capabilities;
- device records;
- hardlink facts.

Update tests:

- regular file create/update;
- directory create/update;
- symlink create/update;
- hardlink preserve/fallback;
- metadata-only change;
- source changes during copy;
- baseline-equal prune;
- touched-but-equal large file.

Removed tests:

- delete image file marker;
- delete image directory marker;
- delete new file prunes without marker;
- removing marker undeletes image file;
- changed wins over removed.

Metadata tests:

- fallback xattr applies;
- stale metadata pruned;
- user-edited metadata honored if valid;
- duplicate metadata compacted;
- missing normal path metadata dropped;
- fallback-only special record allowed.

Internal DB tests:

- rebuild from public truth;
- public truth wins;
- corrupt DB rebuilt or fails clearly;
- lock prevents second daemon;
- control socket uses single writer.

Daemon tests:

- status/doctor/prune talk to daemon;
- commands fail if daemon not running;
- ready only after watcher/audit initialized;
- ready removed at startup;
- no replay apply on daemon restart.

Crash tests:

- crash during changed write;
- crash during metadata rewrite;
- crash during apply;
- crash before ready;
- crash after ready with pending queue.

Capability tests:

- xattr native/fallback;
- ACL native/fallback;
- hardlink native/fallback;
- FIFO native/fallback;
- device node denied path;
- sparse file policy.

## 24. Open Decisions That Must Not Be Invented Silently

Use `grill` for each if implementation reaches it:

1. Exact lossless path representation in `metadata.jsonl`.
2. Exact baseline schema version and path encoding.
3. Exact metadata fallback schema.
4. Exact hardlink fallback semantics.
5. Sparse file preservation policy.
6. Fail vs degrade when device node apply lacks permission.
7. Watch overflow readiness behavior.
8. Whether `doctor` can remove a specific malformed public truth class.
9. Whether `prune` should remove dormant excluded data.
10. Whether code-server should show detailed persistd status.

Recommended defaults:

- Prefer fail-not-ready over silent data loss.
- Prefer fallback metadata over dropping unsupported facts.
- Prefer generic code-server startup page until status is real.
- Prefer no prune of excluded dormant data until explicitly approved.
- Prefer lossless machine encoding plus readable display path.

## 25. Execution Order

Do the slices in this order:

1. Slice 0: Linux test harness.
2. Slice 1: Apply requires baseline and records failures.
3. Slice 2: Public truth module and lossless paths.
4. Slice 3: Baseline schema correctness.
5. Slice 4: Capability probing.
6. Slice 5: Metadata fallback-only.
7. Slice 6: Rootfs module and filesystem fidelity.
8. Slice 7: Correct compare gates.
9. Slice 8: Single writer runtime.
10. Slice 9: Watcher/audit lifecycle status.
11. Slice 10: Readiness semantics and code-server UX.
12. Slice 11: Doctor safe repair.
13. Slice 12: Prune intentional cleanup.
14. Slice 13: Apply public truth fully.
15. Slice 14: Status must be real.
16. Slice 15: Crash safety and atomicity.
17. Slice 16: Smoke tests to acceptance criteria.
18. Slice 17: Docker/runtime cleanup.
19. Slice 18: Test coverage matrix closure.

If a later slice becomes much easier earlier because you are already touching the same deep module, you may pull it forward only if tests stay vertical and the scope remains controlled.

Do not skip Slice 2 for convenience. Lossless public path representation affects nearly everything.

## 26. Definition Of Done For This Plan

`PLAN_2.md` is complete when:

- All slices above are done or explicitly superseded by a documented decision.
- `PLAN.md` acceptance criteria are satisfied.
- Rust tests pass on Linux.
- Docker smoke passes on amd64 and arm64.
- Release workflow remains gated by smoke.
- No old Go persistence commands or storage layouts remain.
- No known drift from `PLAN.md` remains undocumented.

## 27. Final Warning

The current implementation is a good start.

Do not throw it away.

But also do not mistake the scaffold for the product contract.

The project is not trying to build a backup daemon.

The project is trying to build:

```text
image baseline + public user delta + internal daemon oil
```

Keep every slice pointed at that model.
