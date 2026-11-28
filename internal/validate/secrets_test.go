package validate

import (
	"strings"
	"testing"
)

func secretWarnings(t *testing.T, cfg string) []string {
	t.Helper()
	res := Validate(mustRegistry(t), cfg, "0.166.0", "contrib")
	var out []string
	for _, d := range res.Diagnostics {
		if strings.Contains(d.Message, "plain text") {
			if d.Severity != SevWarning || d.Line == 0 || !strings.Contains(d.Hint, "${env:NAME}") {
				t.Fatalf("diagnostic shape: %+v", d)
			}
			out = append(out, d.Path)
		}
	}
	return out
}

func TestPlainSecrets(t *testing.T) {
	cfg := `
extensions:
  basicauth/out:
    client_auth:
      username: collector
      password: hunter2
  bearertokenauth:
    token: ${env:TOKEN}
  oauth2client:
    client_id: agent
    client_secret: s3cr3t
    client_secret_file: /run/secret
    token_url: https://idp.example.com/token
receivers:
  otlp:
    protocols:
      grpc:
        tls:
          key_file: /tls/key.pem
          key: |
            -----BEGIN PRIVATE KEY-----
            abc
            -----END PRIVATE KEY-----
processors:
  resource:
    attributes:
      - key: service.name
        value: checkout
        action: insert
exporters:
  otlphttp/secrets:
    endpoint: https://user:pw@backend.example.com
    headers:
      Authorization: Bearer ${env:TOKEN}
      x-api-key: abc123
      x-redacted: "[REDACTED]"
      x-masked: "********"
    auth:
      authenticator: basicauth/out
  kafka:
    brokers: [kafka:9092]
    auth:
      sasl:
        mechanism: PLAIN
        username: u
        password: ${env:KAFKA_PASSWORD}
  prometheusremotewrite:
    endpoint: https://prom.example.com/write?api_key=k1
service:
  extensions: [basicauth/out, bearertokenauth, oauth2client]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resource]
      exporters: [otlphttp/secrets]
`
	got := strings.Join(secretWarnings(t, cfg), "\n")
	want := strings.Join([]string{
		"extensions.basicauth/out.client_auth.password",
		"extensions.oauth2client.client_secret",
		"receivers.otlp.protocols.grpc.tls.key",
		"exporters.otlphttp/secrets.endpoint",
		"exporters.otlphttp/secrets.headers.x-api-key",
		"exporters.prometheusremotewrite.endpoint",
	}, "\n")
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestPlainSecretsNone(t *testing.T) {
	if got := secretWarnings(t, validConfig); len(got) != 0 {
		t.Fatalf("a config without secrets warned: %v", got)
	}
	// A header pair whose name says it is secret.
	pairs := strings.Replace(validConfig, "    endpoint: https://backend.example.com:4318", "    endpoint: https://backend.example.com:4318\n    headers:\n      x-tenant: acme", 1)
	if got := secretWarnings(t, pairs); len(got) != 0 {
		t.Fatalf("a plain header warned: %v", got)
	}
}
