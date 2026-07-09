# OTelFlow

A visual designer for OpenTelemetry Collector configurations, by
[Sluicio](https://sluicio.com). Similar in spirit to Dash0's
[OTelBin](https://github.com/dash0hq/otelbin), with version-aware validation
and a click-to-configure component catalog.

Paste an OpenTelemetry Collector configuration, see the pipeline flow as a live
diagram, get real-time version-aware validation, and add or edit components
(receivers, processors, exporters, extensions, connectors) through a graphical
interface that writes clean YAML back into the editor.

No login, no persistence beyond the browser's local storage.

## Features

- **Live flow visualization** — pipelines rendered as lanes (traces / metrics /
  logs) with receivers → processors → exporters, connector edges routed across
  pipelines, and an extensions rail (dimmed when defined but not enabled).
- **Real-time validation** with line-precise diagnostics in the editor gutter
  and a problems panel: YAML syntax, unknown component types (with "did you
  mean" suggestions), undefined pipeline references, signal compatibility
  (e.g. `filelog` cannot feed a traces pipeline), connector role rules
  (must be used as both exporter and receiver), required/typed config fields,
  and unused components.
- **Version-aware** — pick the collector version in the header; components
  added later (e.g. `filestats` in v0.77.0) or removed earlier (e.g. the
  `jaeger` exporter in v0.86.0) are flagged with actionable hints, and the
  catalog grays them out. Deprecations (e.g. `logging` → `debug`) surface as
  warnings.
- **Click-to-add GUI** — "+" zones in each pipeline open a searchable catalog;
  picking a component generates a schema-driven form (required fields, enums,
  durations, secrets, YAML fallback for free-form blocks) and writes the
  component plus its pipeline references into the YAML, preserving comments.
- **Click-to-edit** — select any node to inspect its docs/stability/signals,
  edit its config in a form, or remove it (references are cleaned up too).
- **Share without a database** — the Share button encodes the whole
  configuration (compressed) into the URL fragment: `#share=` links open the
  editor, `#embed=` renders a read-only pipeline canvas for iframes, with a
  link back to the full configuration. Fragments never reach the server, so
  nothing is stored anywhere.

## Architecture

```
cmd/server/           Go HTTP server (API + serves web/dist in production)
internal/registry/    Curated, version-aware component catalog (embedded JSON)
internal/validate/    Semantic validation engine (yaml.v3 AST, line numbers)
internal/api/         REST endpoints
web/                  React + TypeScript + Vite frontend
  src/lib/parse.ts      tolerant config → graph model
  src/lib/mutate.ts     comment-preserving YAML edits (yaml Document API)
  src/components/       Editor (CodeMirror), FlowGraph (SVG), catalog, forms
```

### API

| Endpoint | Description |
| --- | --- |
| `GET /api/meta` | Supported collector versions + default |
| `GET /api/components?version=` | Component catalog with availability for that version |
| `POST /api/validate` | `{config, version}` → structured diagnostics |

## Development

```sh
# Terminal 1 — API on :7317
go run ./cmd/server

# Terminal 2 — frontend on :5173 (proxies /api)
cd web && npm install && npm run dev
```

## Production build

```sh
cd web && npm run build     # emits web/dist
go run ./cmd/server         # serves API + web/dist on :7317
```

## Deployment

CI publishes a multi-arch image to `ghcr.io/sluicio/otelflow:latest` on every
push to main. The container is stateless — user configs live in the browser.

```sh
docker compose up -d                  # app on http://localhost:7317
docker compose --profile proxy up -d  # + Caddy on :80/:443 with automatic TLS
                                      #   (set your domain in deploy/Caddyfile)
```

The server honors the `PORT` environment variable, so the same image runs
unmodified on container platforms like Scaleway Serverless Containers or
Cloud Run. `-addr` and `-static` flags override the defaults.

## Notes

- The component registry (`internal/registry/data/components.json`) is a
  curated snapshot: the most common components with hand-written simplified
  schemas and availability versions. Exact added/deprecated/removed versions
  are approximations for some components. Extend or regenerate it there —
  the backend and frontend both consume it as-is.
- Custom/vendor components not in the registry are flagged as unknown but
  the rest of the config still validates.
- Styling follows the Sluicio design guidelines (v2 — sluice azure): the two
  theme token blocks in `web/src/styles.css` are copied from the guidelines
  and are the only place literal colors live. Light is the default theme;
  dark is applied via `data-theme="dark"` on `<html>` (per-device setting,
  auto follows the OS).

## License

Apache-2.0 — see [LICENSE](LICENSE). Third-party dependency licenses are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
