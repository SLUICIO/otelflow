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
	Type        string          `json:"type"`
	Kind        Kind            `json:"kind"`
	Signals     []string        `json:"signals,omitempty"`
	Connects    []Connection    `json:"connects,omitempty"`
	Added       string          `json:"added"`
	Deprecated  string          `json:"deprecated,omitempty"`
	Removed     string          `json:"removed,omitempty"`
	Stability   string          `json:"stability"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema,omitempty"`
}

type Registry struct {
	Versions       []string    `json:"versions"`
	DefaultVersion string      `json:"defaultVersion"`
	Components     []Component `json:"components"`
}

var reg *Registry

func Load() (*Registry, error) {
	if reg != nil {
		return reg, nil
	}
	var r Registry
	if err := json.Unmarshal(rawData, &r); err != nil {
		return nil, fmt.Errorf("parsing embedded component registry: %w", err)
	}
	reg = &r
	return reg, nil
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
