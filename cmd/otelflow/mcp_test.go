package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/sluicio/otelflow/internal/registry"
)

// Connects a real MCP client to the server over in-memory transports and
// exercises every tool.
func TestMCPServer(t *testing.T) {
	reg, err := registry.Load()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	ct, st := mcp.NewInMemoryTransports()
	serverSession, err := buildMCPServer(reg).Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	session, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 5 {
		t.Fatalf("expected 5 tools, got %d", len(tools.Tools))
	}

	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if res.IsError {
			t.Fatalf("%s returned tool error: %v", name, res.Content)
		}
		b, _ := json.Marshal(res.StructuredContent)
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return out
	}

	// validate_config: the rename hint must surface.
	out := call("validate_config", map[string]any{
		"config": "receivers:\n  filestats:\nexporters:\n  debug:\nservice:\n  pipelines:\n    metrics:\n      receivers: [filestats]\n      exporters: [debug]\n",
	})
	if out["valid"] != false {
		t.Error("filestats config should be invalid at the default version")
	}
	diags, _ := json.Marshal(out["diagnostics"])
	if !strings.Contains(string(diags), "file_stats") {
		t.Errorf("rename hint missing: %s", diags)
	}

	// search_components: filtered, and empty results are [] not null.
	out = call("search_components", map[string]any{"query": "file_", "kind": "receiver"})
	if out["total"].(float64) < 2 {
		t.Errorf("expected file_log and file_stats, got %v", out["total"])
	}
	out = call("search_components", map[string]any{"query": "zzz-no-such-component"})
	if comps, ok := out["components"].([]any); !ok || comps == nil {
		t.Errorf("empty search must return an array, got %v", out["components"])
	}

	// get_component_schema: exists and errors are informative.
	out = call("get_component_schema", map[string]any{"kind": "exporter", "type": "otlp_http"})
	if out["available"] != true {
		t.Errorf("otlp_http exporter should be available: %v", out)
	}
	res, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "get_component_schema", Arguments: map[string]any{"kind": "exporter", "type": "nope"},
	})
	if err != nil || !res.IsError {
		t.Error("unknown component should produce a tool error")
	}

	// list_versions
	out = call("list_versions", nil)
	if out["defaultVersion"] == "" {
		t.Error("defaultVersion missing")
	}

	// make_share_link
	out = call("make_share_link", map[string]any{"config": "receivers:\n  otlp:\n"})
	url, _ := out["url"].(string)
	if !strings.HasPrefix(url, "https://otelflow.sluicio.com/#share=1.") {
		t.Errorf("unexpected share url: %s", url)
	}
}
