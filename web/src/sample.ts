export const SAMPLE_CONFIG = `# Sample OpenTelemetry Collector configuration
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  hostmetrics:
    collection_interval: 30s
    scrapers:
      cpu:
      memory:
  filelog:
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
  otlphttp/sluicio:
    endpoint: https://ingest.sluicio.com
    headers:
      Authorization: Bearer \${env:SLUICIO_TOKEN}
    compression: gzip
  debug:
    verbosity: basic

connectors:
  spanmetrics:
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
      exporters: [otlphttp/sluicio, spanmetrics]
    metrics:
      receivers: [otlp, hostmetrics, spanmetrics]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/sluicio]
    logs:
      receivers: [otlp, filelog]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/sluicio, debug]
`
