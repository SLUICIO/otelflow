// Smoke test for the WASM validator host, in plain Node — no VS Code needed.
// Run after `npm run build`: node test/smoke.mjs
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const { meta, validate } = require(join(distDir, 'validator.cjs'))

const m = await meta(distDir)
assert.ok(m.versions.includes('0.157.0'), 'registry knows 0.157.0')
assert.ok(m.defaultVersion, 'registry has a default version')
assert.deepEqual(m.distributions, ['core', 'contrib'])

const valid = await validate(
  distDir,
  `receivers:
  otlp:
    protocols:
      grpc:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
exporters:
  debug:
`,
  '0.157.0',
  'contrib',
)
assert.equal(valid.valid, true, `expected valid, got: ${JSON.stringify(valid.diagnostics)}`)

const unknown = await validate(
  distDir,
  `receivers:
  doesnotexist:
service:
  pipelines:
    traces:
      receivers: [doesnotexist]
      exporters: [debug]
exporters:
  debug:
`,
  '0.157.0',
  'contrib',
)
assert.equal(unknown.valid, false)
const diag = unknown.diagnostics.find((d) => d.message.includes('doesnotexist'))
assert.ok(diag, 'unknown receiver reported')
assert.ok(diag.line > 0, 'diagnostic carries a line number')

// The rename campaign: filestats became file_stats in 0.152.0.
const renamed = await validate(
  distDir,
  `receivers:
  filestats:
    include: [/tmp/*]
service:
  pipelines:
    metrics:
      receivers: [filestats]
      exporters: [debug]
exporters:
  debug:
`,
  '0.157.0',
  'contrib',
)
assert.equal(renamed.valid, false)
assert.ok(
  renamed.diagnostics.some((d) => (d.hint ?? '').includes('file_stats')),
  'rename hint points to file_stats',
)

// A secret written in plain text is a warning with its path and line; a
// reference is not.
const secrets = await validate(
  distDir,
  `receivers:
  otlp:
    protocols:
      grpc:
exporters:
  otlp_http:
    endpoint: https://example.test
    headers:
      authorization: Bearer abc123
      x-tenant: \${env:TENANT}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_http]
`,
  '0.157.0',
  'contrib',
)
const plain = secrets.diagnostics.filter((d) => d.severity === 'warning' && (d.path ?? '').startsWith('exporters.otlp_http.headers'))
assert.equal(plain.length, 1, `one plain-text secret, got: ${JSON.stringify(secrets.diagnostics)}`)
assert.equal(plain[0].path, 'exporters.otlp_http.headers.authorization')
assert.ok(plain[0].line > 0, 'the warning carries a line number')
assert.equal(secrets.valid, true, 'a plain-text secret is a warning, not an error')

console.log('smoke test passed:', m.versions.length, 'versions, default', m.defaultVersion)
