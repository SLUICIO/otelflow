package share

import (
	"bytes"
	"compress/flate"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestEncodeRoundTrip(t *testing.T) {
	config := "receivers:\n  otlp:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n"
	frag, err := Encode(config, "0.157.0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frag, "1.") {
		t.Fatalf("fragment kind prefix missing: %q", frag)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(frag, "1."))
	if err != nil {
		t.Fatalf("not base64url: %v", err)
	}
	inflated, err := io.ReadAll(flate.NewReader(bytes.NewReader(raw)))
	if err != nil {
		t.Fatalf("not raw deflate: %v", err)
	}
	var got struct{ V, C string }
	if err := json.Unmarshal(inflated, &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	if got.V != "0.157.0" || got.C != config {
		t.Errorf("round trip mismatch: %+v", got)
	}
}

func TestURL(t *testing.T) {
	u, err := URL("https://otelflow.sluicio.com/", "receivers:", "0.157.0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u, "https://otelflow.sluicio.com/#share=1.") {
		t.Errorf("unexpected URL shape: %s", u)
	}
}
