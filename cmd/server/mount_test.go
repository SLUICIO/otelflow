package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMount(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.URL.Path)
	})

	h, err := mount("/otelflow/", inner)
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		"/otelflow/":              "/",
		"/otelflow/validate.wasm": "/validate.wasm",
		"/otelflow/api/meta":      "/api/meta",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != http.StatusOK || rec.Body.String() != want {
			t.Errorf("GET %s: %d %q, want 200 %q", path, rec.Code, rec.Body.String(), want)
		}
	}

	// The bare prefix redirects, so relative asset URLs resolve under it.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/otelflow", nil))
	if rec.Code != http.StatusMovedPermanently || rec.Header().Get("Location") != "/otelflow/" {
		t.Errorf("GET /otelflow: %d %q", rec.Code, rec.Header().Get("Location"))
	}

	// Outside the prefix there is nothing.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/validate.wasm", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /validate.wasm outside the prefix: %d", rec.Code)
	}

	// No prefix: unchanged.
	if h, _ := mount("", inner); h == nil {
		t.Fatal("empty prefix")
	}
	for _, bad := range []string{"otelflow", "/a?b"} {
		if _, err := mount(bad, inner); err == nil {
			t.Errorf("mount(%q) accepted", bad)
		}
	}
}
