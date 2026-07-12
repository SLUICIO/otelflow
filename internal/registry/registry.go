// Package registry holds the curated, version-aware catalog of OpenTelemetry
// Collector components (receivers, processors, exporters, extensions,
// connectors) together with simplified config schemas used to drive the
// designer's forms and validation.
package registry

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

//go:embed data/components.json
var rawData []byte

//go:embed data/generated.json
var rawGenerated []byte

type Kind string

const (
	KindReceiver  Kind = "receiver"
	KindProcessor Kind = "processor"
	KindExporter  Kind = "exporter"
	KindExtension Kind = "extension"
	KindConnector Kind = "connector"
)

// Connection describes a signal mapping supported by a connector,
// e.g. spanmetrics connects traces -> metrics.
type Connection struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Component struct {
	Type          string          `json:"type"`
	Kind          Kind            `json:"kind"`
	Signals       []string        `json:"signals,omitempty"`
	Connects      []Connection    `json:"connects,omitempty"`
	Added         string          `json:"added"`
	Deprecated    string          `json:"deprecated,omitempty"`
	Removed       string          `json:"removed,omitempty"`
	Stability     string          `json:"stability"`
	Distributions []string        `json:"distributions,omitempty"`
	DocsURL       string          `json:"docsUrl,omitempty"`
	Description   string          `json:"description"`
	Schema        json.RawMessage `json:"schema,omitempty"`
}

type Registry struct {
	Versions       []string    `json:"versions"`
	DefaultVersion string      `json:"defaultVersion"`
	Distributions  []string    `json:"distributions"`
	Components     []Component `json:"components"`
}

var reg *Registry

// Load merges the generated catalog (derived from the collector repositories:
// presence per version, signals, stability, distribution membership) with the
// hand-curated overlay (config schemas, descriptions, deprecation guidance).
func Load() (*Registry, error) {
	if reg != nil {
		return reg, nil
	}
	var curated Registry
	if err := json.Unmarshal(rawData, &curated); err != nil {
		return nil, fmt.Errorf("parsing curated component registry: %w", err)
	}
	var generated struct {
		Components []Component `json:"components"`
	}
	if err := json.Unmarshal(rawGenerated, &generated); err != nil {
		return nil, fmt.Errorf("parsing generated component registry: %w", err)
	}

	curatedIdx := map[string]*Component{}
	for i := range curated.Components {
		c := &curated.Components[i]
		curatedIdx[string(c.Kind)+":"+c.Type] = c
	}

	merged := make([]Component, 0, len(generated.Components))
	seen := map[string]bool{}
	for _, g := range generated.Components {
		key := string(Kind(g.Kind)) + ":" + g.Type
		seen[key] = true
		// The contrib distribution includes every core component.
		if hasString(g.Distributions, "core") && !hasString(g.Distributions, "contrib") {
			g.Distributions = append(g.Distributions, "contrib")
		}
		if c, ok := curatedIdx[key]; ok {
			// Generated data wins for empirically derived facts; the overlay
			// contributes everything humans wrote.
			g.Description = c.Description
			g.Schema = c.Schema
			g.Deprecated = c.Deprecated
			if c.Stability == "deprecated" {
				g.Stability = "deprecated"
			}
			if len(g.Signals) == 0 {
				g.Signals = c.Signals
			}
			if len(g.Connects) == 0 {
				g.Connects = c.Connects
			}
		} else {
			g.Description = fallbackDescription(g)
		}
		merged = append(merged, g)
	}
	// Curated-only components (not found in any repo tree) are kept as-is.
	for _, c := range curated.Components {
		if !seen[string(c.Kind)+":"+c.Type] {
			if len(c.Distributions) == 0 {
				c.Distributions = []string{"contrib"}
			}
			merged = append(merged, c)
		}
	}

	reg = &Registry{
		Versions:       curated.Versions,
		DefaultVersion: curated.DefaultVersion,
		Distributions:  []string{"core", "contrib"},
		Components:     merged,
	}
	return reg, nil
}

func fallbackDescription(c Component) string {
	dist := "contrib"
	for _, d := range c.Distributions {
		if d == "core" {
			dist = "core"
		}
	}
	return fmt.Sprintf("The %s %s from the OpenTelemetry Collector %s distribution.", c.Type, c.Kind, dist)
}

// InDistribution reports whether the component ships in the given
// distribution. Components without distribution data pass every check.
func (c *Component) InDistribution(dist string) bool {
	if dist == "" || len(c.Distributions) == 0 {
		return true
	}
	for _, d := range c.Distributions {
		if d == dist {
			return true
		}
	}
	return false
}

// ValidDistribution reports whether the name is a known distribution.
func (r *Registry) ValidDistribution(d string) bool {
	return hasString(r.Distributions, d)
}

func hasString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// AvailableIn reports whether the component exists (added and not removed)
// in the given collector version.
func (c *Component) AvailableIn(version string) bool {
	if c.Added != "" && CompareVersions(version, c.Added) < 0 {
		return false
	}
	if c.Removed != "" && CompareVersions(version, c.Removed) >= 0 {
		return false
	}
	return true
}

// DeprecatedIn reports whether the component is deprecated (but still
// present) in the given collector version.
func (c *Component) DeprecatedIn(version string) bool {
	return c.Deprecated != "" && CompareVersions(version, c.Deprecated) >= 0 && c.AvailableIn(version)
}

// Find returns the component with the given kind and type name regardless of
// version availability, or nil.
func (r *Registry) Find(kind Kind, typeName string) *Component {
	for i := range r.Components {
		c := &r.Components[i]
		if c.Kind == kind && c.Type == typeName {
			return c
		}
	}
	return nil
}

// ForVersion returns all components available in the given version.
func (r *Registry) ForVersion(version string) []Component {
	out := make([]Component, 0, len(r.Components))
	for _, c := range r.Components {
		if c.AvailableIn(version) {
			out = append(out, c)
		}
	}
	return out
}

// ValidVersion reports whether v looks like a supported version string.
func (r *Registry) ValidVersion(v string) bool {
	_, ok := parseVersion(v)
	return ok
}

// CompareVersions compares two collector versions like "0.109.0".
// Returns -1, 0 or 1. Unparseable versions compare as equal to everything,
// so callers degrade gracefully.
func CompareVersions(a, b string) int {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return 0
	}
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.Split(v, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
