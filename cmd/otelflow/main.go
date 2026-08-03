// The otelflow CLI: validate OpenTelemetry Collector configurations, search
// the component catalog, and generate share links — from the terminal, from
// scripts, or (via the `mcp` subcommand) from AI assistants over the Model
// Context Protocol. Everything runs locally; configurations never leave the
// machine.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/sluicio/otelflow/internal/registry"
	"github.com/sluicio/otelflow/internal/share"
	"github.com/sluicio/otelflow/internal/validate"
)

const defaultShareBase = "https://otelflow.sluicio.com"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	reg, err := registry.Load()
	if err != nil {
		fatal(err)
	}
	switch os.Args[1] {
	case "validate":
		cmdValidate(reg, os.Args[2:])
	case "components":
		cmdComponents(reg, os.Args[2:])
	case "versions":
		cmdVersions(reg)
	case "share":
		cmdShare(reg, os.Args[2:])
	case "mcp":
		if err := runMCP(reg); err != nil {
			fatal(err)
		}
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `otelflow — OpenTelemetry Collector configuration tools, offline

Usage:
  otelflow validate <config.yaml|-> [-version X.Y.Z] [-distro contrib|core] [-json]
  otelflow components [-query q] [-kind receiver|processor|exporter|extension|connector]
                      [-signal traces|metrics|logs] [-version X.Y.Z] [-distro contrib|core] [-json]
  otelflow versions
  otelflow share <config.yaml|-> [-version X.Y.Z] [-base https://otelflow.sluicio.com]
  otelflow mcp        run as a Model Context Protocol server over stdio

By Sluicio (https://sluicio.com) — Apache-2.0, github.com/SLUICIO/otelflow
`)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "otelflow:", err)
	os.Exit(1)
}

func readInput(path string) string {
	if path == "-" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			fatal(err)
		}
		return string(b)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		fatal(err)
	}
	return string(b)
}

func resolveVersion(reg *registry.Registry, v string) string {
	if v == "" || !reg.ValidVersion(v) {
		return reg.DefaultVersion
	}
	return v
}

func cmdValidate(reg *registry.Registry, args []string) {
	fs := flag.NewFlagSet("validate", flag.ExitOnError)
	version := fs.String("version", "", "collector version (default: newest supported)")
	distro := fs.String("distro", "contrib", "collector distribution: contrib or core")
	asJSON := fs.Bool("json", false, "machine-readable JSON output")
	_ = fs.Parse(args)
	if fs.NArg() != 1 {
		fatal(fmt.Errorf("expected a config file path (or - for stdin)"))
	}
	cfg := readInput(fs.Arg(0))
	v := resolveVersion(reg, *version)
	result := validate.Validate(reg, cfg, v, *distro)

	if *asJSON {
		out, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(out))
	} else {
		for _, d := range result.Diagnostics {
			loc := ""
			if d.Line > 0 {
				loc = fmt.Sprintf("%d:%d ", d.Line, d.Column)
			}
			fmt.Printf("%s%s: %s", loc, d.Severity, d.Message)
			if d.Hint != "" {
				fmt.Printf(" (%s)", d.Hint)
			}
			fmt.Println()
		}
		if result.Valid {
			fmt.Printf("valid — collector %s v%s\n", *distro, v)
		}
	}
	if !result.Valid {
		os.Exit(1)
	}
}

// componentSummary is the schema-free catalog view used by search results.
type componentSummary struct {
	Kind        string   `json:"kind"`
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Signals     []string `json:"signals,omitempty"`
	Stability   string   `json:"stability,omitempty"`
	Added       string   `json:"added,omitempty"`
	Removed     string   `json:"removed,omitempty"`
	RenamedTo   string   `json:"renamedTo,omitempty"`
	Deprecated  bool     `json:"deprecated,omitempty"`
	DocsURL     string   `json:"docsUrl,omitempty"`
}

func searchComponents(reg *registry.Registry, query, kind, signal, version, distro string) (string, []componentSummary) {
	v := resolveVersion(reg, version)
	if !reg.ValidDistribution(distro) {
		distro = "contrib"
	}
	q := strings.ToLower(query)
	out := []componentSummary{}
	for i := range reg.Components {
		c := &reg.Components[i]
		if kind != "" && string(c.Kind) != kind {
			continue
		}
		if !c.AvailableIn(v) || !c.InDistribution(distro) {
			continue
		}
		if signal != "" && !contains(c.Signals, signal) {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(c.Type), q) &&
			!strings.Contains(strings.ToLower(c.Description), q) {
			continue
		}
		out = append(out, componentSummary{
			Kind:        string(c.Kind),
			Type:        c.Type,
			Description: c.Description,
			Signals:     c.Signals,
			Stability:   c.Stability,
			Added:       c.Added,
			Removed:     c.Removed,
			RenamedTo:   c.RenamedTo,
			Deprecated:  c.DeprecatedIn(v),
			DocsURL:     c.DocsURL,
		})
	}
	return v, out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func cmdComponents(reg *registry.Registry, args []string) {
	fs := flag.NewFlagSet("components", flag.ExitOnError)
	query := fs.String("query", "", "substring match on type or description")
	kind := fs.String("kind", "", "receiver, processor, exporter, extension or connector")
	signal := fs.String("signal", "", "traces, metrics or logs")
	version := fs.String("version", "", "collector version (default: newest supported)")
	distro := fs.String("distro", "contrib", "collector distribution")
	asJSON := fs.Bool("json", false, "machine-readable JSON output")
	_ = fs.Parse(args)
	v, comps := searchComponents(reg, *query, *kind, *signal, *version, *distro)
	if *asJSON {
		out, _ := json.MarshalIndent(map[string]any{"version": v, "components": comps}, "", "  ")
		fmt.Println(string(out))
		return
	}
	for _, c := range comps {
		extra := ""
		if c.Deprecated {
			extra = " (deprecated)"
		}
		fmt.Printf("%-10s %-28s %s%s\n", c.Kind, c.Type, strings.Join(c.Signals, ","), extra)
	}
	fmt.Fprintf(os.Stderr, "%d components — collector %s v%s\n", len(comps), *distro, v)
}

func cmdVersions(reg *registry.Registry) {
	for _, v := range reg.Versions {
		marker := ""
		if v == reg.DefaultVersion {
			marker = " (default)"
		}
		fmt.Printf("%s%s\n", v, marker)
	}
}

func cmdShare(reg *registry.Registry, args []string) {
	fs := flag.NewFlagSet("share", flag.ExitOnError)
	version := fs.String("version", "", "collector version embedded in the link")
	base := fs.String("base", defaultShareBase, "OTelFlow instance base URL")
	_ = fs.Parse(args)
	if fs.NArg() != 1 {
		fatal(fmt.Errorf("expected a config file path (or - for stdin)"))
	}
	cfg := readInput(fs.Arg(0))
	u, err := share.URL(*base, cfg, resolveVersion(reg, *version))
	if err != nil {
		fatal(err)
	}
	fmt.Println(u)
}
