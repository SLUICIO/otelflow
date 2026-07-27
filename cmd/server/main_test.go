package main

import (
	"strings"
	"testing"
)

func TestInjectAnalytics(t *testing.T) {
	index := []byte("<html><head><title>x</title></head><body></body></html>")
	out := string(injectAnalytics(index, "https://webanalytics.example.com/js/pa-abc.js"))
	if !strings.Contains(out, `src="https://webanalytics.example.com/js/pa-abc.js"`) {
		t.Errorf("script src missing:\n%s", out)
	}
	if !strings.Contains(out, "plausible.init()") {
		t.Error("init snippet missing")
	}
	if strings.Index(out, "plausible") > strings.Index(out, "</head>") {
		t.Error("snippet not injected before </head>")
	}
	// Attribute context stays intact for URLs with special characters.
	escaped := string(injectAnalytics(index, `https://x/js/a.js"onload="alert(1)`))
	if strings.Contains(escaped, `"onload=`) {
		t.Error("script URL not escaped for attribute context")
	}
}
