// Package api exposes the designer's REST endpoints.
package api

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/sluicio/otelflow/internal/registry"
	"github.com/sluicio/otelflow/internal/validate"
)

type Server struct {
	reg *registry.Registry
}

func NewServer(reg *registry.Registry) *Server {
	return &Server{reg: reg}
}

func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/meta", s.handleMeta)
	mux.HandleFunc("GET /api/components", s.handleComponents)
	mux.HandleFunc("POST /api/validate", s.handleValidate)
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"versions":       s.reg.Versions,
		"defaultVersion": s.reg.DefaultVersion,
		"distributions":  s.reg.Distributions,
	})
}

// componentView is a registry component enriched with availability
// information for the requested collector version.
type componentView struct {
	registry.Component
	Available    bool `json:"available"`
	IsDeprecated bool `json:"isDeprecated"`
}

func (s *Server) handleComponents(w http.ResponseWriter, r *http.Request) {
	version := r.URL.Query().Get("version")
	if version == "" {
		version = s.reg.DefaultVersion
	}
	if !s.reg.ValidVersion(version) {
		writeError(w, http.StatusBadRequest, "invalid version: "+version)
		return
	}
	views := make([]componentView, 0, len(s.reg.Components))
	for _, c := range s.reg.Components {
		views = append(views, componentView{
			Component:    c,
			Available:    c.AvailableIn(version),
			IsDeprecated: c.DeprecatedIn(version),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version":    version,
		"components": views,
	})
}

type validateRequest struct {
	Config       string `json:"config"`
	Version      string `json:"version"`
	Distribution string `json:"distribution"`
}

func (s *Server) handleValidate(w http.ResponseWriter, r *http.Request) {
	var req validateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if req.Version == "" {
		req.Version = s.reg.DefaultVersion
	}
	if !s.reg.ValidVersion(req.Version) {
		writeError(w, http.StatusBadRequest, "invalid version: "+req.Version)
		return
	}
	if req.Distribution == "" {
		req.Distribution = "contrib"
	}
	if !s.reg.ValidDistribution(req.Distribution) {
		writeError(w, http.StatusBadRequest, "invalid distribution: "+req.Distribution)
		return
	}
	writeJSON(w, http.StatusOK, validate.Validate(s.reg, req.Config, req.Version, req.Distribution))
}

// CORS wraps a handler with permissive CORS for local development, where the
// Vite dev server runs on a different port.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writing response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
