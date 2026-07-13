package validate

import (
	"fmt"
	"strings"
	"testing"
)

const rabbitCfg = `receivers:
  rabbitmq:
    endpoint: http://localhost:15672
    username: otel_monitor
    password: ${env:RABBITMQ_MONITORING_PASSWORD}
    collection_interval: 60s
  prometheus/internal:
    config:
      scrape_configs:
        - job_name: otelcol
          scrape_interval: 30s
          static_configs:
            - targets: ["127.0.0.1:8888"]

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 400
    spike_limit_mib: 80
  batch:
    send_batch_size: 8192
    timeout: 5s

exporters:
  otlphttp/sluicio:
    endpoint: your-tenant-ingest.sluicio.com:4318
    headers:
      authorization: "Bearer ${env:SLUICIO_INGEST_TOKEN}"

service:
  telemetry:
    metrics:
      level: normal
  pipelines:
    metrics:
      receivers: [rabbitmq]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/sluicio]
    metrics/self:
      receivers: [prometheus/internal]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/sluicio]
`

// Brute-force panic hunt: validate every prefix-truncation, every
// single-line deletion, and every progressive character deletion within
// each line of the reported config. A panic in any intermediate editing
// state would kill the WASM runtime in the browser.
func TestNoPanicOnIntermediateEdits(t *testing.T) {
	reg := mustRegistry(t)
	lines := strings.Split(rabbitCfg, "\n")

	check := func(name, cfg string) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("PANIC on %s: %v\nconfig:\n%s", name, r, cfg)
			}
		}()
		Validate(reg, cfg, "0.127.0", "contrib")
	}

	// every prefix of the document (simulates paste-in-progress)
	for i := 0; i <= len(rabbitCfg); i += 7 {
		check(fmt.Sprintf("prefix[:%d]", i), rabbitCfg[:i])
	}
	// every single line removed
	for i := range lines {
		mod := append(append([]string{}, lines[:i]...), lines[i+1:]...)
		check(fmt.Sprintf("without line %d", i+1), strings.Join(mod, "\n"))
	}
	// progressive character deletion from the end of each line
	for i, line := range lines {
		for cut := 1; cut <= len(line); cut++ {
			mod := append([]string{}, lines...)
			mod[i] = line[:len(line)-cut]
			check(fmt.Sprintf("line %d cut %d", i+1, cut), strings.Join(mod, "\n"))
		}
	}
	// the user's specific sequence: batch definition gone, then refs gone
	noDef := strings.Replace(rabbitCfg, "  batch:\n    send_batch_size: 8192\n    timeout: 5s\n", "", 1)
	check("no batch definition", noDef)
	oneRef := strings.Replace(noDef, "processors: [memory_limiter, batch]", "processors: [memory_limiter]", 1)
	check("one ref removed", oneRef)
	noRefs := strings.Replace(oneRef, "processors: [memory_limiter, batch]", "processors: [memory_limiter]", 1)
	check("both refs removed", noRefs)

	r := Validate(reg, noRefs, "0.127.0", "contrib")
	for _, d := range r.Diagnostics {
		if strings.Contains(d.Message, "'batch'") {
			t.Errorf("stale-looking diagnostic from clean engine: %s", d.Message)
		}
	}
}
