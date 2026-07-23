// Sluicio OpenTelemetry Collector Designer — backend server.
//
// Serves the component registry and validation API, plus the built frontend
// from web/dist when present (production mode). During development the Vite
// dev server proxies /api requests here.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/sluicio/otelflow/internal/api"
	"github.com/sluicio/otelflow/internal/registry"
)

func main() {
	addr := flag.String("addr", defaultAddr(), "listen address")
	staticDir := flag.String("static", "web/dist", "directory with the built frontend (optional)")
	flag.Parse()

	reg, err := registry.Load()
	if err != nil {
		log.Fatalf("loading component registry: %v", err)
	}
	log.Printf("registry loaded: %d components, %d collector versions", len(reg.Components), len(reg.Versions))

	mux := http.NewServeMux()
	api.NewServer(reg).Routes(mux)

	if st, err := os.Stat(*staticDir); err == nil && st.IsDir() {
		log.Printf("serving frontend from %s", *staticDir)
		mux.Handle("/", withCachePolicy(spaHandler(*staticDir)))
	}

	log.Printf("Sluicio OTel Collector Designer API listening on %s", *addr)
	if err := http.ListenAndServe(*addr, api.CORS(mux)); err != nil {
		log.Fatal(err)
	}
}

// defaultAddr honors the PORT environment variable that container platforms
// inject, falling back to the designer's own port.
func defaultAddr() string {
	if p := os.Getenv("PORT"); p != "" {
		return ":" + p
	}
	return ":7317"
}

// withCachePolicy sets explicit caching: content-hashed assets are immutable,
// everything else (index.html, validate.wasm, wasm_exec.js) must revalidate.
// Without this, browsers cache the validator heuristically and keep using an
// outdated registry after upgrades.
func withCachePolicy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}

// spaHandler serves static files, falling back to index.html for client-side
// routes.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			if _, err := os.Stat(dir + r.URL.Path); err != nil {
				r.URL.Path = "/"
			}
		}
		fs.ServeHTTP(w, r)
	})
}
