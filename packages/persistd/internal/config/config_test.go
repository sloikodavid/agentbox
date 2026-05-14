package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreate_WritesDefaultWhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	cfg, created, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if !created {
		t.Fatal("expected created=true on first call")
	}
	if cfg.Audit.MaxWorkMsPerTick != 10 {
		t.Errorf("default MaxWorkMsPerTick = %d, want 10", cfg.Audit.MaxWorkMsPerTick)
	}
	if len(cfg.Exclude.RootRelative) == 0 {
		t.Error("default exclusions should be non-empty")
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("default config file not written: %v", err)
	}

	cfg2, created2, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("second LoadOrCreate: %v", err)
	}
	if created2 {
		t.Error("expected created=false on second call")
	}
	if cfg2.Audit.MaxWorkMsPerTick != cfg.Audit.MaxWorkMsPerTick {
		t.Error("config did not round-trip")
	}
}

func TestParse_RejectsUnknownFields(t *testing.T) {
	_, err := Parse([]byte(`{"unknown":1}`))
	if err == nil {
		t.Fatal("expected error for unknown field")
	}
}

func TestParse_RejectsMalformed(t *testing.T) {
	_, err := Parse([]byte(`{`))
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestParse_RejectsTrailingData(t *testing.T) {
	_, err := Parse([]byte(`{"exclude":{"rootRelative":[]},"audit":{"maxWorkMsPerTick":1,"maxFilesystemOpsPerSecond":1,"maxHashBytesPerSecond":1,"directoryBatchSize":1}}{}`))
	if err == nil {
		t.Fatal("expected error for trailing data")
	}
}

func TestParse_RejectsNonAbsoluteExclude(t *testing.T) {
	_, err := Parse([]byte(`{"exclude":{"rootRelative":["tmp"]},"audit":{"maxWorkMsPerTick":1,"maxFilesystemOpsPerSecond":1,"maxHashBytesPerSecond":1,"directoryBatchSize":1}}`))
	if err == nil {
		t.Fatal("expected error for non-absolute exclude")
	}
}

func TestParse_AcceptsEmptyExclusions(t *testing.T) {
	cfg, err := Parse([]byte(`{"exclude":{"rootRelative":[]},"audit":{"maxWorkMsPerTick":0,"maxFilesystemOpsPerSecond":0,"maxHashBytesPerSecond":0,"directoryBatchSize":0}}`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(cfg.Exclude.RootRelative) != 0 {
		t.Error("user-empty exclusions must remain empty (no hidden hard exclusions)")
	}
}

func TestResolvePaths_Defaults(t *testing.T) {
	p := ResolvePaths(func(string) string { return "" })
	if p.Volume != "/data" {
		t.Errorf("Volume = %q, want /data", p.Volume)
	}
	if p.Config != "/data/persistence/config.json" {
		t.Errorf("Config = %q", p.Config)
	}
	if p.DB != "/data/persistence/db.sqlite" {
		t.Errorf("DB = %q", p.DB)
	}
	if p.Objects != "/data/persistence/objects" {
		t.Errorf("Objects = %q", p.Objects)
	}
	if p.Heartbeat != "/run/agentbox/persistd.ready" {
		t.Errorf("Heartbeat = %q", p.Heartbeat)
	}
}

func TestResolvePaths_VolumeOverride(t *testing.T) {
	env := map[string]string{"AGENTBOX_VOLUME_PATH": "/mnt/persist"}
	p := ResolvePaths(func(k string) string { return env[k] })
	if p.Config != "/mnt/persist/persistence/config.json" {
		t.Errorf("Config = %q", p.Config)
	}
	if p.DB != "/mnt/persist/persistence/db.sqlite" {
		t.Errorf("DB = %q", p.DB)
	}
}

func TestResolvePaths_IndividualOverridesWin(t *testing.T) {
	env := map[string]string{
		"AGENTBOX_VOLUME_PATH":              "/data",
		"AGENTBOX_PERSISTENCE_DB_PATH":      "/elsewhere/db.sqlite",
		"AGENTBOX_PERSISTENCE_OBJECTS_PATH": "/elsewhere/objects",
	}
	p := ResolvePaths(func(k string) string { return env[k] })
	if p.DB != "/elsewhere/db.sqlite" {
		t.Errorf("DB override not applied: %q", p.DB)
	}
	if p.Objects != "/elsewhere/objects" {
		t.Errorf("Objects override not applied: %q", p.Objects)
	}
	if p.Config != "/data/persistence/config.json" {
		t.Errorf("Config should keep derived default: %q", p.Config)
	}
}
