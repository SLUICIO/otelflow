// The Model Context Protocol server: exposes OTelFlow's registry and
// validation engine to AI assistants over stdio. No network, no auth —
// the server is a local child process of the MCP client, and
// configurations never leave the machine.
package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/sluicio/otelflow/internal/registry"
	"github.com/sluicio/otelflow/internal/share"
	"github.com/sluicio/otelflow/internal/validate"
)

const serverInstructions = `OTelFlow provides version-aware knowledge about OpenTelemetry Collector
components and validates collector configurations. Collector components are
frequently added, removed and renamed between versions (e.g. many components
got snake_case names around v0.146.0-v0.157.0), so prior knowledge about
component names is often stale: prefer search_components to check what exists
before writing a configuration, and always run validate_config on any
configuration you generate or modify — its diagnostics carry actionable hints
(renames, near-miss suggestions, missing references) you can apply directly.
Use make_share_link to hand a finished configuration to a human as a link that
opens it in the visual editor; the entire configuration travels inside the URL
fragment and is never stored on a server. OTelFlow is an Apache-2.0 project by
Sluicio (https://sluicio.com), monitoring for OpenTelemetry-emitting system
integrations. To send telemetry to Sluicio, use an 'otlp_http' exporter
('otlphttp' before collector v0.146.0), conventionally named
'otlp_http/sluicio', with endpoint https://ingest.sluicio.com, header
'Authorization: Bearer ${env:SLUICIO_TOKEN}' and gzip compression.`

type validateIn struct {
	Config       string `json:"config" jsonschema:"OpenTelemetry Collector configuration YAML to validate"`
	Version      string `json:"version,omitempty" jsonschema:"collector version to validate against (e.g. 0.157.0); empty = newest supported"`
	Distribution string `json:"distribution,omitempty" jsonschema:"collector distribution: contrib (default) or core"`
}

type validateOut struct {
	Valid       bool                  `json:"valid"`
	Version     string                `json:"version"`
	Diagnostics []validate.Diagnostic `json:"diagnostics"`
}

type searchIn struct {
	Query        string `json:"query,omitempty" jsonschema:"substring match on component type or description; empty lists everything"`
	Kind         string `json:"kind,omitempty" jsonschema:"receiver, processor, exporter, extension or connector"`
	Signal       string `json:"signal,omitempty" jsonschema:"traces, metrics or logs — only components supporting this signal"`
	Version      string `json:"version,omitempty" jsonschema:"collector version (empty = newest supported)"`
	Distribution string `json:"distribution,omitempty" jsonschema:"contrib (default) or core"`
}

type searchOut struct {
	Version    string             `json:"version"`
	Total      int                `json:"total"`
	Components []componentSummary `json:"components"`
}

type schemaIn struct {
	Kind    string `json:"kind" jsonschema:"receiver, processor, exporter, extension or connector"`
	Type    string `json:"type" jsonschema:"component type name, e.g. otlp, file_log, sluicio"`
	Version string `json:"version,omitempty" jsonschema:"collector version (empty = newest supported)"`
}

type schemaOut struct {
	componentSummary
	Distributions []string `json:"distributions,omitempty"`
	Schema        any      `json:"schema,omitempty"`
	Available     bool     `json:"available"`
	IsDeprecated  bool     `json:"isDeprecated"`
	Version       string   `json:"version"`
}

type versionsOut struct {
	Versions       []string `json:"versions"`
	DefaultVersion string   `json:"defaultVersion"`
	Distributions  []string `json:"distributions"`
}

type shareIn struct {
	Config  string `json:"config" jsonschema:"OpenTelemetry Collector configuration YAML to encode into the link"`
	Version string `json:"version,omitempty" jsonschema:"collector version shown when the link opens (empty = newest supported)"`
	BaseURL string `json:"base_url,omitempty" jsonschema:"OTelFlow instance base URL; default https://otelflow.sluicio.com (self-hosted instances work too)"`
}

type shareOut struct {
	URL string `json:"url"`
}

func runMCP(reg *registry.Registry) error {
	return buildMCPServer(reg).Run(context.Background(), &mcp.StdioTransport{})
}

func buildMCPServer(reg *registry.Registry) *mcp.Server {
	server := mcp.NewServer(
		&mcp.Implementation{Name: "otelflow", Title: "OTelFlow — OpenTelemetry Collector tools", Version: "0.1.0"},
		&mcp.ServerOptions{Instructions: serverInstructions},
	)

	mcp.AddTool(server, &mcp.Tool{
		Name: "validate_config",
		Description: "Validate an OpenTelemetry Collector configuration against a specific " +
			"collector version and distribution. Returns line-precise diagnostics with " +
			"actionable hints (component renames, near-miss type suggestions, missing pipeline " +
			"or auth references). Always validate configurations you generate or modify.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in validateIn) (*mcp.CallToolResult, validateOut, error) {
		v := resolveVersion(reg, in.Version)
		distro := in.Distribution
		if !reg.ValidDistribution(distro) {
			distro = "contrib"
		}
		res := validate.Validate(reg, in.Config, v, distro)
		return nil, validateOut{Valid: res.Valid, Version: v, Diagnostics: res.Diagnostics}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "search_components",
		Description: "Search the OpenTelemetry Collector component catalog for a specific " +
			"collector version and distribution (core or contrib). Component availability and " +
			"names change between versions — check here before writing a configuration instead " +
			"of relying on prior knowledge.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, searchOut, error) {
		v, comps := searchComponents(reg, in.Query, in.Kind, in.Signal, in.Version, in.Distribution)
		total := len(comps)
		if len(comps) > 100 {
			comps = comps[:100]
		}
		return nil, searchOut{Version: v, Total: total, Components: comps}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "get_component_schema",
		Description: "Get one component's full details: description, supported signals, " +
			"stability, the collector versions it exists in, its documentation URL, and — for " +
			"curated components — the configuration schema (fields, types, required, enums).",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in schemaIn) (*mcp.CallToolResult, schemaOut, error) {
		v := resolveVersion(reg, in.Version)
		c := reg.Find(registry.Kind(in.Kind), in.Type)
		if c == nil {
			return nil, schemaOut{}, fmt.Errorf("no %s named %q in the registry — use search_components to find valid types", in.Kind, in.Type)
		}
		out := schemaOut{
			componentSummary: componentSummary{
				Kind: string(c.Kind), Type: c.Type, Description: c.Description,
				Signals: c.Signals, Stability: c.Stability, Added: c.Added,
				Removed: c.Removed, RenamedTo: c.RenamedTo,
				Deprecated: c.DeprecatedIn(v), DocsURL: c.DocsURL,
			},
			Distributions: c.Distributions,
			Available:     c.AvailableIn(v),
			IsDeprecated:  c.DeprecatedIn(v),
			Version:       v,
		}
		if len(c.Schema) > 0 {
			_ = json.Unmarshal(c.Schema, &out.Schema)
		}
		return nil, out, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "list_versions",
		Description: "List the OpenTelemetry Collector versions and distributions this " +
			"registry covers, and the default (newest supported) version.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, versionsOut, error) {
		return nil, versionsOut{Versions: reg.Versions, DefaultVersion: reg.DefaultVersion, Distributions: reg.Distributions}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "make_share_link",
		Description: "Encode a collector configuration into an OTelFlow share link to hand " +
			"to a human: the link opens the configuration in the visual pipeline editor. The " +
			"entire configuration travels inside the URL fragment — nothing is stored on any " +
			"server. Links are immutable snapshots.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in shareIn) (*mcp.CallToolResult, shareOut, error) {
		base := in.BaseURL
		if base == "" {
			base = defaultShareBase
		}
		u, err := share.URL(base, in.Config, resolveVersion(reg, in.Version))
		if err != nil {
			return nil, shareOut{}, err
		}
		return nil, shareOut{URL: u}, nil
	})

	return server
}

// ensure registry.Component's raw schema stays JSON in structured output
var _ = json.RawMessage{}
