export const SAMPLE_CONFIG = `# Sample OpenTelemetry Collector configuration
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  host_metrics:
    collection_interval: 30s
    scrapers:
      cpu:
      memory:
  file_log:
    include:
      - /var/log/app/*.log
    start_at: end

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
  batch:
    timeout: 200ms
    send_batch_size: 8192

exporters:
  otlp_http/sluicio:
    endpoint: https://ingest.sluicio.com
    headers:
      Authorization: Bearer \${env:SLUICIO_TOKEN}
    compression: gzip
  debug:
    verbosity: basic

connectors:
  span_metrics:
    metrics_flush_interval: 60s

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  pprof:

service:
  extensions: [health_check, pprof]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/sluicio, span_metrics]
    metrics:
      receivers: [otlp, host_metrics, span_metrics]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/sluicio]
    logs:
      receivers: [otlp, file_log]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/sluicio, debug]
`
