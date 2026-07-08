# Contributing to OTelFlow

Thanks for wanting to help. This document covers the local setup, the shape
of the codebase, and what a good pull request looks like.

## Development setup

You need Go 1.24+ and Node 22+.

```sh
# Terminal 1 — API on :7317
go run ./cmd/server

# Terminal 2 — frontend on :5173, proxies /api to the Go server
cd web
npm install
npm run dev
```

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

**Adding or correcting a component** — edit
`internal/registry/data/components.json`. Each entry carries the component's
kind, supported signals, availability versions (`added` / `deprecated` /
`removed`), and a simplified schema that drives both validation and the GUI
form. Version data should be verifiable against the
opentelemetry-collector(-contrib) changelogs. Restart the Go server to pick
up changes (the JSON is embedded at build time).

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
