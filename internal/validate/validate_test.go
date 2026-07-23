package validate

import (
	"strings"
	"testing"

	"github.com/sluicio/otelflow/internal/registry"
)

const validConfig = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  batch:
    timeout: 200ms
exporters:
  otlphttp:
    endpoint: https://backend.example.com:4318
extensions:
  health_check:
service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp]
`

func mustRegistry(t *testing.T) *registry.Registry {
	t.Helper()
	reg, err := registry.Load()
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

func messages(r Result) string {
	var sb strings.Builder
	for _, d := range r.Diagnostics {
		sb.WriteString(string(d.Severity) + ": " + d.Message)
		if d.Hint != "" {
			sb.WriteString(" (" + d.Hint + ")")
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

func TestValidConfig(t *testing.T) {
	r := Validate(mustRegistry(t), validConfig, "0.127.0", "contrib")
	if !r.Valid {
		t.Fatalf("expected valid, got diagnostics:\n%s", messages(r))
	}
}

func TestScenarios(t *testing.T) {
	reg := mustRegistry(t)
	cases := []struct {
		name    string
		config  string
		version string
		valid   bool
		want    string // substring expected in some diagnostic message
	}{
		{
			name:    "filestats too old",
			version: "0.70.0",
			valid:   false,
			want:    "not available in v0.70.0 (added in v0.77.0)",
			config: `
receivers:
  filestats:
    include: /var/log/*.log
exporters:
  debug:
service:
  pipelines:
    metrics:
      receivers: [filestats]
      exporters: [debug]
`,
		},
		{
			name:    "jaeger exporter removed",
			version: "0.90.1",
			valid:   false,
			want:    "removed in v0.86.0",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  jaeger:
    endpoint: jaeger:14250
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [jaeger]
`,
		},
		{
			name:    "logging exporter deprecated",
			version: "0.96.0",
			valid:   true,
			want:    "deprecated since v0.86.0",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  logging:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [logging]
`,
		},
		{
			name:    "signal mismatch filelog in traces",
			version: "0.127.0",
			valid:   false,
			want:    "does not support traces",
			config: `
receivers:
  filelog:
    include: [/var/log/app.log]
exporters:
  debug:
service:
  pipelines:
    traces:
      receivers: [filelog]
      exporters: [debug]
`,
		},
		{
			name:    "undefined exporter reference",
			version: "0.127.0",
			valid:   false,
			want:    "used in pipeline 'traces' but not defined",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp]
`,
		},
		{
			name:    "connector one-sided",
			version: "0.127.0",
			valid:   false,
			want:    "used as an exporter but never as a receiver",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  debug:
connectors:
  spanmetrics:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [spanmetrics, debug]
`,
		},
		{
			name:    "connector both roles ok",
			version: "0.127.0",
			valid:   true,
			want:    "",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  debug:
connectors:
  spanmetrics:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [spanmetrics]
    metrics:
      receivers: [spanmetrics]
      exporters: [debug]
`,
		},
		{
			name:    "connectors section too old",
			version: "0.70.0",
			valid:   false,
			want:    "'connectors' section is not supported",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  otlp:
    endpoint: x:4317
connectors:
  forward:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp]
`,
		},
		{
			name:    "missing required field",
			version: "0.127.0",
			valid:   false,
			want:    "Missing required field 'include'",
			config: `
receivers:
  filestats:
    collection_interval: 30s
exporters:
  debug:
service:
  pipelines:
    metrics:
      receivers: [filestats]
      exporters: [debug]
`,
		},
		{
			name:    "enum violation",
			version: "0.127.0",
			valid:   false,
			want:    "must be one of: basic, normal, detailed",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  debug:
    verbosity: loud
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`,
		},
		{
			name:    "typo suggestion",
			version: "0.127.0",
			valid:   false,
			want:    "Did you mean 'batch'",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
processors:
  bacth:
exporters:
  debug:
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [bacth]
      exporters: [debug]
`,
		},
		{
			name:    "sluicio is not a real exporter type",
			version: "0.127.0",
			valid:   false,
			want:    "use an 'otlphttp' exporter with an 'Authorization: Bearer <token>' header",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  sluicio:
    endpoint: https://ingest.sluicio.com
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [sluicio]
`,
		},
		{
			name:    "otlphttp sluicio preset output is valid",
			version: "0.70.0",
			valid:   true,
			want:    "",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
exporters:
  otlphttp/sluicio:
    endpoint: https://ingest.sluicio.com
    headers:
      Authorization: Bearer ${env:SLUICIO_TOKEN}
    compression: gzip
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/sluicio]
`,
		},
		{
			name:    "exporter auth via extension is recognized",
			version: "0.127.0",
			valid:   true,
			want:    "",
			config: `
receivers:
  otlp:
    protocols: {http: {}}
exporters:
  otlphttp/grafana:
    endpoint: https://otlp.grafana.net/otlp
    auth:
      authenticator: basicauth/grafana_cloud
extensions:
  basicauth/grafana_cloud:
    client_auth:
      username: ${env:ID}
      password: ${env:KEY}
service:
  extensions: [basicauth/grafana_cloud]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/grafana]
`,
		},
		{
			name:    "metadata-corrected type is not gated (zipkin existed before its metadata fix)",
			version: "0.70.0",
			valid:   true,
			want:    "",
			config: `
receivers:
  zipkin:
exporters:
  otlp:
    endpoint: x:4317
service:
  pipelines:
    traces:
      receivers: [zipkin]
      exporters: [otlp]
`,
		},
		{
			name:    "renamed type flagged at new versions",
			version: "0.157.0",
			valid:   false,
			want:    "It was renamed to 'otlp_http' in v0.146.0",
			config: `
receivers:
  otlp:
    protocols: {http: {}}
exporters:
  otlphttp/x:
    endpoint: https://x
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/x]
`,
		},
		{
			name:    "old type valid before rename",
			version: "0.140.0",
			valid:   true,
			want:    "",
			config: `
receivers:
  otlp:
    protocols: {http: {}}
exporters:
  otlphttp/x:
    endpoint: https://x
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/x]
`,
		},
		{
			name:    "new type valid after rename, gated before",
			version: "0.140.0",
			valid:   false,
			want:    "not available in v0.140.0 (added in v0.146.0)",
			config: `
receivers:
  otlp:
    protocols: {http: {}}
exporters:
  otlp_http/x:
    endpoint: https://x
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_http/x]
`,
		},
		{
			name:    "authenticator not defined",
			version: "0.127.0",
			valid:   false,
			want:    "authenticator 'basicauth/grafana' used by exporters.otlphttp/g is not defined",
			config: `
receivers:
  otlp:
    protocols: {http: {}}
exporters:
  otlphttp/g:
    endpoint: https://x
    auth:
      authenticator: basicauth/grafana
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/g]
`,
		},
		{
			name:    "authenticator defined but not enabled",
			version: "0.127.0",
			valid:   false,
			want:    "defined but not enabled. (Add 'basicauth/grafana' to service.extensions",
			config: `
receivers:
  otlp:
    protocols: {http: {}}
exporters:
  otlphttp/g:
    endpoint: https://x
    auth:
      authenticator: basicauth/grafana
extensions:
  basicauth/grafana:
    client_auth: {username: u, password: p}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/g]
`,
		},
		{
			name:    "nested receiver protocol auth reference checked",
			version: "0.127.0",
			valid:   false,
			want:    "authenticator 'bearertokenauth/x' used by receivers.otlp is not defined",
			config: `
receivers:
  otlp:
    protocols:
      grpc:
        auth:
          authenticator: bearertokenauth/x
exporters:
  debug:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`,
		},
		{
			name:    "yaml syntax error",
			version: "0.127.0",
			valid:   false,
			want:    "YAML syntax error",
			config:  "receivers:\n  otlp:\n |bad",
		},
		{
			name:    "unused receiver warning stays valid",
			version: "0.127.0",
			valid:   true,
			want:    "defined but not used",
			config: `
receivers:
  otlp:
    protocols: {grpc: {}}
  zipkin:
exporters:
  debug:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := Validate(reg, tc.config, tc.version, "contrib")
			if r.Valid != tc.valid {
				t.Errorf("valid = %v, want %v; diagnostics:\n%s", r.Valid, tc.valid, messages(r))
			}
			if tc.want != "" && !strings.Contains(messages(r), tc.want) {
				t.Errorf("expected a diagnostic containing %q, got:\n%s", tc.want, messages(r))
			}
		})
	}
}

func TestDistributionChecks(t *testing.T) {
	reg := mustRegistry(t)
	cfg := `
receivers:
  filestats:
    include: /var/log/*.log
exporters:
  debug:
service:
  pipelines:
    metrics:
      receivers: [filestats]
      exporters: [debug]
`
	if r := Validate(reg, cfg, "0.127.0", "contrib"); !r.Valid {
		t.Errorf("expected valid under contrib, got:\n%s", messages(r))
	}
	r := Validate(reg, cfg, "0.127.0", "core")
	if r.Valid {
		t.Fatal("expected invalid under core")
	}
	if !strings.Contains(messages(r), "not part of the core distribution") {
		t.Errorf("expected distribution diagnostic, got:\n%s", messages(r))
	}
}

func TestDiagnosticsCarryLines(t *testing.T) {
	r := Validate(mustRegistry(t), `receivers:
  bogus_receiver:
exporters:
  debug:
service:
  pipelines:
    traces:
      receivers: [bogus_receiver]
      exporters: [debug]
`, "0.127.0", "contrib")
	found := false
	for _, d := range r.Diagnostics {
		if strings.Contains(d.Message, "Unknown receiver type") {
			found = true
			if d.Line != 2 {
				t.Errorf("expected line 2, got %d", d.Line)
			}
		}
	}
	if !found {
		t.Fatalf("missing unknown-type diagnostic:\n%s", messages(r))
	}
}
