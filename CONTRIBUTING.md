# Contributing to OTelFlow

Thanks for wanting to help. This document covers the local setup, the shape
of the codebase, and what a good pull request looks like.

## Development setup

You need Go 1.24+ and Node 22+ (Go is needed even for frontend work — the
validation engine is compiled to WebAssembly and runs in the browser).

```sh
cd web
npm install
npm run dev   # auto-builds the WASM validator, serves on :5173
```

`go run ./cmd/server` is only needed when working on the REST API.

Before opening a PR, make sure both of these pass — CI runs the same:

```sh
go build ./... && go vet ./... && go test ./...
cd web && npm run build
```

## Project layout

```
cmd/server/           Go HTTP server (API + serves web/dist in production)
internal/registry/    Version-aware component catalog (embedded JSON)
internal/validate/    Semantic validation engine (yaml.v3 AST, line numbers)
internal/api/         REST endpoints
web/src/lib/          Config parsing (graph model) and comment-preserving YAML edits
web/src/components/   Editor, flow graph, dialogs, schema-driven forms
```

## Common contributions

**The component catalog** is generated, not hand-written: `cmd/registry-gen`
derives component presence per version, signals, stability and core/contrib
membership from the collector repositories
(`GITHUB_TOKEN=$(gh auth token) go run ./cmd/registry-gen`). Don't edit
`generated.json` by hand — re-run the generator (e.g. when adding a new
supported collector version to its version list).

**Adding or improving a component schema** — edit the curated overlay,
`internal/registry/data/components.json`. Overlay entries contribute the
config schema (drives both validation and the GUI form), the description
and deprecation guidance; availability and distribution data come from the
generated file. Rebuild the WASM validator to see changes in the app
(`npm run build:wasm` in `web/`).

**Adding a validation rule** — extend `internal/validate/validate.go` and add
a table-driven case to `validate_test.go`. Every diagnostic needs a clear
message, and a hint when there is an obvious fix. Errors mean the collector
would reject the config; warnings mean it starts but something is off.

**UI changes** — follow the Sluicio design guidelines: colors come from the
tokens in `web/src/styles.css` (never hex in components), soft/ink pairs
travel together, red only ever means broken, sentence case everywhere except
pills. Every interactive element must show the focus ring on
`:focus-visible`.

## Pull requests

- Keep PRs focused; separate refactors from behavior changes.
- New behavior comes with tests (Go) or a note on how it was verified (UI).
- CI must be green: Go build/vet/test and the frontend type-check/build.
- Write messages and UI copy in the project voice: calm, precise, honest —
  say what things do, and state consequences in destructive confirmations.

## License

By contributing you agree that your contributions are licensed under the
Apache License 2.0, the same license as the project.
