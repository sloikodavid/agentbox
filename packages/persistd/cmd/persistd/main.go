package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/sloikodavid/agentbox/packages/persistd/internal/config"
	"github.com/sloikodavid/agentbox/packages/persistd/internal/storage"
)

const usage = `usage: persistd <command>

commands:
  restore   apply durable persistence state to the live filesystem
  watch     run the persistence daemon
  status    print current daemon status
  check     run deep consistency checks
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "restore", "watch", "check":
		fmt.Printf("persistd %s: not implemented yet\n", os.Args[1])
	case "status":
		if err := runStatus(); err != nil {
			fmt.Fprintf(os.Stderr, "persistd status: %v\n", err)
			os.Exit(1)
		}
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "persistd: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
}

func runStatus() error {
	paths := config.ResolvePaths(os.Getenv)
	if err := storage.Init(paths); err != nil {
		return err
	}
	cfg, created, err := config.LoadOrCreate(paths.Config)
	if err != nil {
		return err
	}
	report := map[string]any{
		"status":         "stub",
		"paths":          paths,
		"configCreated":  created,
		"excludeCount":   len(cfg.Exclude.RootRelative),
		"auditTickMs":    cfg.Audit.MaxWorkMsPerTick,
		"objectAlgo":     storage.ObjectAlgorithm,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}
