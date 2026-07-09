//go:build js && wasm

// OTelFlow validation compiled to WebAssembly. Exposes the registry and the
// validation engine as JavaScript globals so the frontend can validate
// configurations entirely inside the browser — nothing leaves the page.
package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/sluicio/otelflow/internal/registry"
	"github.com/sluicio/otelflow/internal/validate"
)

// componentView mirrors the REST API's shape so the frontend types are
// identical for both transports.
type componentView struct {
	registry.Component
	Available    bool `json:"available"`
	IsDeprecated bool `json:"isDeprecated"`
}

func main() {
	reg, err := registry.Load()
	if err != nil {
		panic(err)
	}

	js.Global().Set("otelflowMeta", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		return marshal(map[string]any{
			"versions":       reg.Versions,
			"defaultVersion": reg.DefaultVersion,
		})
	}))

	js.Global().Set("otelflowComponents", js.FuncOf(func(_ js.Value, args []js.Value) any {
		version := reg.DefaultVersion
		if len(args) > 0 && args[0].String() != "" && reg.ValidVersion(args[0].String()) {
			version = args[0].String()
		}
		views := make([]componentView, 0, len(reg.Components))
		for _, c := range reg.Components {
			views = append(views, componentView{
				Component:    c,
				Available:    c.AvailableIn(version),
				IsDeprecated: c.DeprecatedIn(version),
			})
		}
		return marshal(map[string]any{"version": version, "components": views})
	}))

	js.Global().Set("otelflowValidate", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 2 {
			return marshal(map[string]any{"error": "expected (config, version)"})
		}
		version := args[1].String()
		if version == "" || !reg.ValidVersion(version) {
			version = reg.DefaultVersion
		}
		return marshal(validate.Validate(reg, args[0].String(), version))
	}))

	// Keep the Go runtime alive; the registered functions are the program.
	select {}
}

func marshal(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `{"error":"marshal failed"}`
	}
	return string(b)
}
