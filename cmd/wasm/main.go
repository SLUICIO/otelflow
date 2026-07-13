//go:build js && wasm

// OTelFlow validation compiled to WebAssembly. Exposes the registry and the
// validation engine as JavaScript globals so the frontend can validate
// configurations entirely inside the browser — nothing leaves the page.
package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	"github.com/sluicio/otelflow/internal/registry"
	"github.com/sluicio/otelflow/internal/validate"
)

// safe wraps an exported function so a panic returns an error result
// instead of killing the Go runtime — a dead runtime would freeze the last
// diagnostics on screen forever.
func safe(fn func(args []js.Value) any) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) (out any) {
		defer func() {
			if r := recover(); r != nil {
				out = marshal(map[string]any{
					"valid": false,
					"diagnostics": []map[string]any{{
						"severity": "error",
						"message":  fmt.Sprintf("The validator hit an internal error: %v", r),
						"hint":     "Please report this at github.com/SLUICIO/otelflow/issues together with the configuration that triggered it.",
					}},
				})
			}
		}()
		return fn(args)
	})
}

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

	js.Global().Set("otelflowMeta", safe(func(_ []js.Value) any {
		return marshal(map[string]any{
			"versions":       reg.Versions,
			"defaultVersion": reg.DefaultVersion,
			"distributions":  reg.Distributions,
		})
	}))

	js.Global().Set("otelflowComponents", safe(func(args []js.Value) any {
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

	js.Global().Set("otelflowValidate", safe(func(args []js.Value) any {
		if len(args) < 2 {
			return marshal(map[string]any{"error": "expected (config, version, distribution?)"})
		}
		version := args[1].String()
		if version == "" || !reg.ValidVersion(version) {
			version = reg.DefaultVersion
		}
		distro := "contrib"
		if len(args) > 2 && reg.ValidDistribution(args[2].String()) {
			distro = args[2].String()
		}
		return marshal(validate.Validate(reg, args[0].String(), version, distro))
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
