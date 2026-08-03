# OTelFlow for VS Code

Version-aware validation for OpenTelemetry Collector configurations, right in
the editor — powered by the same registry and validation engine as
[otelflow.sluicio.com](https://otelflow.sluicio.com), compiled to WebAssembly
and running entirely inside the extension host. Nothing leaves your machine.

## What it does

Open a collector configuration (any YAML file with a top-level `service:`
section plus component sections) and diagnostics appear in the editor and the
Problems panel:

- Unknown component types, with "did you mean" suggestions and rename hints
  (e.g. `filestats` → `file_stats` in v0.152.0).
- Components that don't exist yet, were removed, or aren't in your
  distribution — per collector version, for core and contrib.
- Undefined pipeline references, signal compatibility, connector role rules,
  auth extension references, required and typed config fields, deprecations.

The status bar shows which collector version and distribution the file is
validated against; click it to change them.

**Pipeline preview**: run "OTelFlow: Open pipeline preview" (or click the
graph icon in the editor title bar) to see the configuration as a live flow
diagram beside the editor — the same signal-colored canvas as
[otelflow.sluicio.com](https://otelflow.sluicio.com), with pipelines as lanes,
connector edges routed across them, and invalid components flagged red. It
follows the active editor and updates as you type; clicking a node jumps to
its definition in the YAML.

## Settings

| Setting | Description |
| --- | --- |
| `otelflow.collectorVersion` | Version to validate against (empty = newest supported). |
| `otelflow.distribution` | `contrib` (default) or `core`. |

A per-file override wins over both — useful when one repository holds
collectors on different versions:

```yaml
# otelflow: version=0.152.0 distro=core
```

## Roadmap

Diagnostics and the pipeline preview are phases one and two of bringing
[OTelFlow](https://github.com/SLUICIO/otelflow) to VS Code. Planned next: the
full click-to-configure designer writing YAML back into your editor.

## Development

```sh
npm install
npm run build     # bundles the extension and compiles the Go validator to WASM
npm test          # smoke-tests the validator host in plain Node
npm run package   # produces the .vsix
```

Requires Go 1.24+ and Node 20+. Launch the extension with F5 from VS Code
(the repository ships no launch config yet; "Run Extension" with
`--extensionDevelopmentPath=vscode` works).

## License

Apache-2.0, same as OTelFlow itself.
