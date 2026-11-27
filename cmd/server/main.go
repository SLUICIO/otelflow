// Sluicio OpenTelemetry Collector Designer — backend server.
//
// Serves the component registry and validation API, plus the built frontend
// from web/dist when present (production mode). During development the Vite
// dev server proxies /api requests here.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"html"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/sluicio/otelflow/internal/api"
	"github.com/sluicio/otelflow/internal/registry"
)

func main() {
	addr := flag.String("addr", defaultAddr(), "listen address")
	staticDir := flag.String("static", "web/dist", "directory with the built frontend (optional)")
	prefix := flag.String("prefix", os.Getenv("OTELFLOW_PREFIX"), "serve everything under this path, e.g. /otelflow (default: the root; env OTELFLOW_PREFIX)")
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

	handler, err := mount(*prefix, mux)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("Sluicio OTel Collector Designer API listening on %s%s", *addr, strings.TrimSuffix(*prefix, "/"))
	if err := http.ListenAndServe(*addr, api.CORS(handler)); err != nil {
		log.Fatal(err)
	}
}

// mount serves h under prefix, for a host that puts the designer at a path
// of its own site (https://example.com/otelflow/) through a proxy that
// passes the path on unchanged. The frontend's asset URLs are relative, so
// only the server needs to know. The bare prefix redirects to prefix + "/",
// because relative URLs resolve against the directory. An empty prefix
// serves at the root, as before.
func mount(prefix string, h http.Handler) (http.Handler, error) {
	prefix = strings.TrimSuffix(prefix, "/")
	if prefix == "" {
		return h, nil
	}
	if !strings.HasPrefix(prefix, "/") || strings.ContainsAny(prefix, "?#") {
		return nil, fmt.Errorf("prefix %q must be a path starting with /", prefix)
	}
	root := http.NewServeMux()
	root.Handle(prefix+"/", http.StripPrefix(prefix, h))
	root.Handle(prefix, http.RedirectHandler(prefix+"/", http.StatusMovedPermanently))
	return root, nil
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
// routes. When the PLAUSIBLE_SCRIPT_URL environment variable is set, a
// cookieless Plausible analytics snippet is injected into the served
// index.html — an opt-in for the instance operator; the default is no
// analytics at all.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	index, err := os.ReadFile(filepath.Join(dir, "index.html"))
	if err != nil {
		index = nil
	} else if src := os.Getenv("PLAUSIBLE_SCRIPT_URL"); src != "" {
		index = injectAnalytics(index, src)
		log.Printf("analytics enabled via PLAUSIBLE_SCRIPT_URL: %s", src)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p != "/" {
			if _, err := os.Stat(dir + p); err != nil {
				p = "/"
			}
		}
		if p == "/" && index != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(index)
			return
		}
		fs.ServeHTTP(w, r)
	})
}

// injectAnalytics places the Plausible snippet just before </head>.
func injectAnalytics(index []byte, src string) []byte {
	snippet := fmt.Sprintf(`<!-- Privacy-friendly analytics by Plausible -->
    <script async src="%s"></script>
    <script>
      window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
      plausible.init()
    </script>
  </head>`, html.EscapeString(src))
	return bytes.Replace(index, []byte("</head>"), []byte(snippet), 1)
}
