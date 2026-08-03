// Speaks MCP (JSON-RPC over stdio) to the bundled Node server dist/mcp.cjs —
// the same tool surface as the Go `otelflow mcp`. Verifies the handshake,
// every tool, and that share links match the web app's fragment format.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const proc = spawn(process.execPath, [join(dist, 'mcp.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: proc.stdout })
const pending = new Map()
let nextId = 1
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  } catch {}
})
function request(method, params) {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  })
}
async function call(name, args) {
  const res = await request('tools/call', { name, arguments: args })
  assert.ok(!res.error, `${name} protocol error: ${JSON.stringify(res.error)}`)
  assert.ok(!res.result.isError, `${name} tool error: ${JSON.stringify(res.result.content)}`)
  return res.result.structuredContent ?? JSON.parse(res.result.content[0].text)
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
})
assert.equal(init.result.serverInfo.name, 'otelflow')
assert.ok(init.result.instructions.includes('sluicio.com'), 'instructions carry attribution')
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

const tools = await request('tools/list', {})
const names = tools.result.tools.map((t) => t.name).sort()
assert.deepEqual(names, [
  'get_component_schema',
  'list_versions',
  'make_share_link',
  'search_components',
  'validate_config',
])

const bad = await call('validate_config', {
  config:
    'receivers:\n  filestats:\nexporters:\n  debug:\nservice:\n  pipelines:\n    metrics:\n      receivers: [filestats]\n      exporters: [debug]\n',
})
assert.equal(bad.valid, false)
assert.ok(
  bad.diagnostics.some((d) => (d.hint ?? '').includes('file_stats')),
  'rename hint present',
)

const search = await call('search_components', { query: 'file_', kind: 'receiver' })
assert.ok(search.total >= 2, 'file_log and file_stats found')
const empty = await call('search_components', { query: 'zzz-no-such' })
assert.ok(Array.isArray(empty.components), 'empty search returns an array')

const schema = await call('get_component_schema', { kind: 'exporter', type: 'otlp_http' })
assert.equal(schema.available, true)
assert.ok(schema.schema && typeof schema.schema === 'object', 'curated schema present')

const versions = await call('list_versions', {})
assert.ok(versions.versions.includes(versions.defaultVersion))

const link = await call('make_share_link', { config: 'receivers:\n  otlp:\n' })
const frag = link.url.split('#share=')[1]
assert.ok(frag.startsWith('1.'), 'fragment kind')
const decoded = JSON.parse(inflateRawSync(Buffer.from(frag.slice(2), 'base64url')).toString())
assert.equal(decoded.c, 'receivers:\n  otlp:\n', 'share payload round-trips')
assert.equal(decoded.v, versions.defaultVersion)

proc.kill()
console.log('mcp server test passed:', names.length, 'tools; share link decodes; default', versions.defaultVersion)
