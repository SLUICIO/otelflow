package validate

import (
	"fmt"
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

func TestExporterHelperFields(t *testing.T) {
	// sending_queue / retry_on_failure / timeout come from the collector's
	// exporter helper and must be accepted on network exporters.
	r := Validate(mustRegistry(t), `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  otlp_http:
    endpoint: https://backend.example.com:4318
    sending_queue:
      enabled: true
      queue_size: 5000
      storage: file_storage
    retry_on_failure:
      max_elapsed_time: 600s
    timeout: 10s
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_http]
`, "0.158.0", "contrib")
	if !r.Valid {
		t.Errorf("exporter helper fields should validate, got:\n%s", messages(r))
	}

	// Typos inside the helper blocks still get flagged.
	r = Validate(mustRegistry(t), `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  otlp_http:
    endpoint: https://x:4318
    sending_queue:
      queue_sized: 10
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_http]
`, "0.158.0", "contrib")
	if !strings.Contains(messages(r), "queue_sized") {
		t.Errorf("expected unrecognized-field warning for queue_sized, got:\n%s", messages(r))
	}
}

func TestScraperAndComponentSpecificHelpers(t *testing.T) {
	// Scraper helper on polling receivers; PRW's own queue; ES's own retry.
	r := Validate(mustRegistry(t), `receivers:
  host_metrics:
    collection_interval: 30s
    initial_delay: 5s
    timeout: 10s
    scrapers:
      cpu:
exporters:
  prometheus_remote_write:
    endpoint: https://prw.example.com/api/v1/write
    remote_write_queue:
      queue_size: 20000
    retry_on_failure:
      max_elapsed_time: 120s
    wal:
      directory: /var/lib/otelcol/wal
    max_batch_size_bytes: 1000000
  elasticsearch:
    endpoints: [https://es.example.com:9200]
    num_workers: 4
    flush:
      interval: 10s
    retry:
      max_retries: 5
      retry_on_status: [429, 503]
    mapping:
      mode: otel
service:
  pipelines:
    metrics:
      receivers: [host_metrics]
      exporters: [prometheus_remote_write]
    logs/es:
      receivers: [host_metrics]
      exporters: [elasticsearch]
`, "0.158.0", "contrib")
	// logs/es pipeline: host_metrics is metrics-only, so expect exactly that
	// signal error and nothing about the helper fields.
	for _, d := range r.Diagnostics {
		if strings.Contains(d.Message, "Unrecognized field") {
			t.Errorf("helper field flagged: %s", d.Message)
		}
	}

	// PRW must NOT accept the common sending_queue — it has its own.
	r = Validate(mustRegistry(t), `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  prometheus_remote_write:
    endpoint: https://prw.example.com/api/v1/write
    sending_queue:
      enabled: true
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus_remote_write]
`, "0.158.0", "contrib")
	if !strings.Contains(messages(r), "sending_queue") {
		t.Errorf("expected sending_queue to be flagged on prometheus_remote_write:\n%s", messages(r))
	}
}

func TestAuditedSchemaAdditions(t *testing.T) {
	// Fields added by the v0.158.0 upstream audit across several components.
	r := Validate(mustRegistry(t), `receivers:
  kafka:
    brokers: [localhost:9092]
    tls:
      insecure: false
    header_extraction:
      extract_headers: true
    logs:
      topic: otlp_logs
processors:
  batch:
    metadata_keys: [tenant_id]
    metadata_cardinality_limit: 500
  tail_sampling:
    decision_wait: 10s
    policies: []
    decision_cache:
      sampled_cache_size: 1000
exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
    add_metric_suffixes: false
    metric_expiration: 10m
  splunk_hec:
    token: x
    endpoint: https://splunk:8088
    heartbeat:
      interval: 30s
service:
  pipelines:
    traces:
      receivers: [kafka]
      processors: [tail_sampling]
      exporters: [splunk_hec]
    metrics:
      receivers: [kafka]
      processors: [batch]
      exporters: [prometheus]
`, "0.158.0", "contrib")
	for _, d := range r.Diagnostics {
		if strings.Contains(d.Message, "Unrecognized field") {
			t.Errorf("audited field flagged: %s", d.Message)
		}
	}
}

func TestRenameFixPayload(t *testing.T) {
	r := Validate(mustRegistry(t), `receivers:
  filestats/disk:
exporters:
  debug:
service:
  pipelines:
    metrics:
      receivers: [filestats/disk]
      exporters: [debug]
`, "0.158.0", "contrib")
	var fix *Fix
	for _, d := range r.Diagnostics {
		if d.Fix != nil {
			fix = d.Fix
		}
	}
	if fix == nil {
		t.Fatalf("expected a rename fix, got:\n%s", messages(r))
	}
	if fix.Type != "rename" || fix.Section != "receivers" || fix.From != "filestats/disk" || fix.To != "file_stats/disk" {
		t.Errorf("unexpected fix payload: %+v", fix)
	}
}

func TestFilterLegacyMatchAndOTLPHTTPServerFields(t *testing.T) {
	// User-reported gaps: filter's legacy include/exclude match syntax and
	// confighttp server fields on the otlp receiver (verified against the
	// v0.158.0 config structs).
	r := Validate(mustRegistry(t), `receivers:
  otlp:
    protocols:
      http:
        max_request_body_size: 20971520
        cors:
          allowed_origins: [https://*.example.com]
        tls:
          cert_file: /certs/server.crt
          key_file: /certs/server.key
      grpc:
        max_recv_msg_size_mib: 16
        keepalive:
          server_parameters:
            max_connection_idle: 11s
processors:
  filter:
    spans:
      exclude:
        match_type: strict
        services: [healthcheck]
    metrics:
      exclude:
        match_type: strict
        metric_names: [system.cpu.time]
    log_conditions:
      - log.severity_number < SEVERITY_NUMBER_WARN
exporters:
  debug:
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [filter]
      exporters: [debug]
`, "0.158.0", "contrib")
	for _, d := range r.Diagnostics {
		if strings.Contains(d.Message, "Unrecognized field") {
			t.Errorf("field flagged: %s", d.Message)
		}
	}
}

func TestServiceTelemetrySchema(t *testing.T) {
	base := `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  debug:
service:
  telemetry:
%s
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`
	valid := Validate(mustRegistry(t), fmt.Sprintf(base, `    logs:
      level: debug
      encoding: json
      sampling:
        initial: 10
    metrics:
      level: detailed
      readers:
        - periodic:
            exporter:
              otlp:
                endpoint: https://x:4318
    traces:
      propagators: [tracecontext, b3]`), "0.158.0", "contrib")
	for _, d := range valid.Diagnostics {
		if strings.Contains(d.Path, "service.telemetry") {
			t.Errorf("valid telemetry flagged: %s", d.Message)
		}
	}

	invalid := Validate(mustRegistry(t), fmt.Sprintf(base, `    metrics:
      levl: detailed
    logs:
      encoding: yaml`), "0.158.0", "contrib")
	msgs := messages(invalid)
	if !strings.Contains(msgs, "levl") {
		t.Errorf("telemetry typo not flagged:\n%s", msgs)
	}
	if !strings.Contains(msgs, "must be one of: console, json") {
		t.Errorf("bad encoding enum not flagged:\n%s", msgs)
	}
}
