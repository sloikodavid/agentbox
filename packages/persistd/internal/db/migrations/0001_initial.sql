CREATE TABLE schema_info (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ns INTEGER NOT NULL
);

CREATE TABLE paths (
    path_id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    parent_path_id INTEGER NULL REFERENCES paths(path_id),
    basename TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('present','removed')),
    kind TEXT NOT NULL CHECK (kind IN ('file','dir','symlink','fifo','device','other')),
    mode INTEGER,
    uid INTEGER,
    gid INTEGER,
    atime_ns INTEGER,
    mtime_ns INTEGER,
    ctime_seen_ns INTEGER,
    size INTEGER,
    object_algorithm TEXT NULL,
    object_hash TEXT NULL,
    symlink_target TEXT NULL,
    special_major INTEGER NULL,
    special_minor INTEGER NULL,
    hardlink_group_id TEXT NULL,
    content_hash_verified_at_ns INTEGER NULL,
    last_audited_at_ns INTEGER NULL,
    metadata_version INTEGER NOT NULL,
    FOREIGN KEY (object_algorithm, object_hash) REFERENCES objects(algorithm, hash)
);

CREATE INDEX paths_parent_idx ON paths(parent_path_id);
CREATE INDEX paths_state_idx ON paths(state);
CREATE INDEX paths_object_idx ON paths(object_algorithm, object_hash);

CREATE TABLE objects (
    algorithm TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    ref_count INTEGER NOT NULL,
    created_at_ns INTEGER NOT NULL,
    gc_state TEXT NOT NULL CHECK (gc_state IN ('live','unreferenced','deleting')),
    PRIMARY KEY (algorithm, hash)
);

CREATE INDEX objects_gc_idx ON objects(gc_state);

CREATE TABLE xattrs (
    path_id INTEGER NOT NULL REFERENCES paths(path_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (path_id, name)
);

CREATE TABLE acls (
    path_id INTEGER NOT NULL REFERENCES paths(path_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access','default')),
    entries TEXT NOT NULL,
    PRIMARY KEY (path_id, kind)
);

CREATE TABLE audit_roots (
    root_id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    created_at_ns INTEGER NOT NULL
);

CREATE TABLE audit_cursors (
    cursor_id INTEGER PRIMARY KEY,
    root_id INTEGER NOT NULL REFERENCES audit_roots(root_id) ON DELETE CASCADE,
    parent_cursor_id INTEGER NULL REFERENCES audit_cursors(cursor_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    state TEXT NOT NULL,
    last_progress_at_ns INTEGER NOT NULL
);

CREATE INDEX audit_cursors_root_idx ON audit_cursors(root_id);

CREATE TABLE directory_audit_epochs (
    path_id INTEGER PRIMARY KEY REFERENCES paths(path_id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    started_at_ns INTEGER NOT NULL,
    finished_at_ns INTEGER NULL
);

CREATE TABLE work_queue (
    work_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    priority INTEGER NOT NULL,
    enqueued_at_ns INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX work_queue_priority_idx ON work_queue(priority, enqueued_at_ns);

CREATE TABLE runtime_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at_ns INTEGER NOT NULL
);
