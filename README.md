# OTelFlow

A visual designer for OpenTelemetry Collector configurations, by
[Sluicio](https://sluicio.com). Similar in spirit to Dash0's
[OTelBin](https://github.com/dash0hq/otelbin), with version-aware validation
and a click-to-configure component catalog.

## Purpose

Collector configurations describe your infrastructure: endpoints, service
names, pipeline topology, sometimes credentials. A tool for editing them
should not require you to hand any of that to anyone. OTelFlow is built
around that idea:

- **No accounts, no coupling.** There is no login, no IAM/IdP integration,
  and no connection to any product — including Sluicio's. The server is a
  single stateless binary; configurations live in your browser's local
  storage and share links carry the configuration inside the URL fragment,
  which never reaches a server.
- **Self-hosting is the point.** A public instance runs at
  <https://otelflow.sluicio.com> (the URL may change) and is free to use.
  But the reason this project exists in the open is so that nobody has to
  spread OTel configurations around the internet unnecessarily. One command
  and you are hosting it on your premises — the data is yours and yours only:

  ```sh
  podman run -d --name otelflow --pull=newer -p 7317:7317 ghcr.io/sluicio/otelflow:latest
  # docker works identically
  ```

  Validation itself runs entirely inside your browser — the Go validation
  engine is compiled to WebAssembly and ships with the frontend — so the
  configuration never leaves the page, not even to the server that hosts
  the app.
- **Independent by design.** Parts of OTelFlow will be integrated into
  [Sluicio](https://sluicio.com) itself
  ([sluicio-app](https://github.com/sluicio/sluicio-app)), but OTelFlow
  stays a standalone, Apache-2.0 licensed tool that works the same for
  everyone, Sluicio customer or not.

Paste an OpenTelemetry Collector configuration, see the pipeline flow as a live
diagram, get real-time version-aware validation, and add or edit components
(receivers, processors, exporters, extensions, connectors) through a graphical
interface that writes clean YAML back into the editor.

No login, no persistence beyond the browser's local storage.

## How OTelFlow compares to OTelBin

[OTelBin](https://github.com/dash0hq/otelbin) by Dash0 is the established
tool in this space, and a good one. The short version: **OTelBin visualizes
and validates YAML you write; OTelFlow is a designer that also writes the
YAML for you.**

|  | OTelFlow | OTelBin |
| --- | --- | --- |
| Editing | YAML editor plus a GUI that writes YAML: click-to-add components with schema-driven forms, a guided pipeline wizard, click-to-edit and remove — comment-preserving | YAML editor; the diagram is a read-only visualization |
| Validation | In your browser (WebAssembly) against a registry generated from the collector repositories — per-version component presence, signals, core/contrib distribution checks — plus curated schemas and fix hints | On OTelBin's backend against real collector distributions (core, contrib, ADOT, Splunk) — authoritative per distribution |
| Privacy | The configuration never leaves the page; share links carry the data in the URL fragment | Visualization is client-side; distribution validation sends the configuration to the backend |
| Self-hosting | One ~15 MB container, or any static file host | Self-hostable; the validation backend is a separate deployment |
| Sharing | Share links plus an embeddable read-only canvas (iframe) with a link back to the configuration | Share links |

The honest gap: validating against real collector binaries catches config
mistakes a metadata-derived registry cannot (deep struct fields, factory
defaults), and OTelBin covers the ADOT and Splunk distributions. Both are
candidates for later; the catalog itself is already derived from the
collector repositories, not curated by hand.

## Features

- **Live flow visualization** — pipelines rendered as lanes (traces / metrics /
  logs) with receivers → processors → exporters, connector edges routed across
  pipelines, and an extensions rail (dimmed when defined but not enabled).
- **Real-time validation** with line-precise diagnostics in the editor gutter
  and a problems panel: YAML syntax, unknown component types (with "did you
  mean" suggestions), undefined pipeline references, signal compatibility
  (e.g. `filelog` cannot feed a traces pipeline), connector role rules
  (must be used as both exporter and receiver), required/typed config fields,
  auth references (`auth.authenticator` must point to a defined and enabled
  extension), and unused components.
- **Version- and distribution-aware** — pick the collector version and
  distribution (core or contrib) in the header. Components added later
  (e.g. `filestats` in v0.77.0), removed earlier (e.g. the `jaeger`
  exporter in v0.86.0), or missing from the selected distribution are
  flagged with actionable hints; the catalog offers only what your
  selection actually ships. Deprecations (e.g. `logging` → `debug`)
  surface as warnings. The full contrib catalog (250+ components) is
  generated from the collector repositories themselves.
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
cmd/server/           Go HTTP server (serves web/dist; REST API for tooling)
cmd/wasm/             WebAssembly build of the validator — runs in the browser
internal/registry/    Curated, version-aware component catalog (embedded JSON)
internal/validate/    Semantic validation engine (yaml.v3 AST, line numbers)
internal/api/         REST endpoints (same engine, for programmatic use)
web/                  React + TypeScript + Vite frontend
  src/lib/parse.ts      tolerant config → graph model
  src/lib/mutate.ts     comment-preserving YAML edits (yaml Document API)
  src/components/       Editor (CodeMirror), FlowGraph (SVG), catalog, forms
```

The app validates in the browser via the WASM build; it makes no API calls.
The REST endpoints remain for scripts and CI tooling. Because the frontend
is self-contained, `web/dist` can also be served by any static file host.

### API

| Endpoint | Description |
| --- | --- |
| `GET /api/meta` | Supported collector versions + default |
| `GET /api/components?version=` | Component catalog with availability for that version |
| `POST /api/validate` | `{config, version}` → structured diagnostics |

## Sharing and embedding

The Share button produces two things, and both work without any server-side
storage — the entire configuration travels inside the URL fragment, which
browsers never send to the server.

**Share links** open the configuration in the full editor:

```
https://otelflow.sluicio.com/#share=1.rVNNb9swDP0rhLfTkNlxsq2dbju...
```

The fragment format is `#share=<kind>.<data>` where `kind` `1` means the
data is a deflate-raw compressed, base64url-encoded JSON object
`{"v": "<collector version>", "c": "<yaml>"}` (`0` is the uncompressed
fallback). Links are immutable snapshots: editing the configuration
afterwards does not change what a previously shared link shows.

**Embeds** render a read-only view for other pages — same payload,
`#embed=` instead of `#share=` — with the collector version, live
validation status, and a link back to the full configuration. An optional
`&view=` suffix picks what the embed shows: the pipeline canvas (default),
the configuration (`&view=config`), or both stacked — canvas on top,
configuration below (`&view=both`). `&theme=light` or `&theme=dark` pins the
embed's theme (default: the reader's device preference), and the bar offers
a copy-config button. The Share dialog computes the iframe height to fit
this exact configuration — embeds are immutable snapshots, so the computed
height stays correct:

```html
<iframe
  src="https://otelflow.sluicio.com/#embed=1.rVNNb9swDP0rhLfTkNlxsq2dbju..."
  width="100%"
  height="480"
  style="border: 1px solid #e5e7eb; border-radius: 12px"
  loading="lazy"
  title="OTelFlow — OpenTelemetry Collector pipeline"
></iframe>
```

Because the format is stable and documented, links can also be generated
programmatically — for example from a repository's collector config in CI,
so a docs page always links to the current pipeline:

```js
// examples/make-share-link.mjs
import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const yaml = readFileSync('otelcol.yaml', 'utf8')
const payload = deflateRawSync(
  Buffer.from(JSON.stringify({ v: '0.127.0', c: yaml })),
).toString('base64url')

console.log(`https://otelflow.sluicio.com/#share=1.${payload}`)
```

Run it directly: `node examples/make-share-link.mjs my-config.yaml 0.127.0`.
Point the base URL at your own instance to keep everything on your premises.

## Development

Requires Go 1.24+ and Node 22+. One terminal:

```sh
cd web && npm install && npm run dev   # builds the WASM validator, serves on :5173
```

`go run ./cmd/server` is only needed when working on the REST API.

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

- The component registry is two files merged at load time:
  `internal/registry/data/generated.json` is derived from the collector
  repositories by `cmd/registry-gen` (component presence per version,
  signals, stability, core/contrib membership) and
  `internal/registry/data/components.json` is the hand-curated overlay
  contributing config schemas, descriptions and deprecation guidance for
  the popular components. Regenerate with
  `GITHUB_TOKEN=$(gh auth token) go run ./cmd/registry-gen`.
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
