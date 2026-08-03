// Runs the real webview bundle inside jsdom and verifies the designer:
// canvas rendering, click-to-open details, scoped removal with the confirm
// round-trip, chained YAML mutations, and the add-component catalog.
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'

const dom = new JSDOM(`<!DOCTYPE html><html><body class="vscode-dark"><div id="root"></div></body></html>`, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
})
const { window } = dom

const messages = []
window.acquireVsCodeApi = () => ({
  postMessage: (m) => messages.push(m),
  getState: () => undefined,
  setState: () => {},
})

window.eval(readFileSync(new URL('../dist/webview/main.js', import.meta.url), 'utf8'))

const doc = window.document
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what) {
  const deadline = Date.now() + 5000
  while (!fn() && Date.now() < deadline) await settle()
  assert.ok(fn(), what)
}
const byText = (selector, text) =>
  [...doc.querySelectorAll(selector)].find((el) => el.textContent?.includes(text))
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const ofType = (type) => messages.filter((m) => m.type === type)

const yaml = [
  'receivers:', '  otlp:', '  filestats:',
  'processors:', '  batch:',
  'exporters:', '  debug:',
  'extensions:', '  health_check:',
  'service:',
  '  extensions: [health_check]',
  '  pipelines:',
  '    metrics:',
  '      receivers: [otlp, filestats]',
  '      processors: [batch]',
  '      exporters: [debug]',
].join('\n')

window.postMessage({
  type: 'update',
  fileName: 'otelcol.yaml',
  yaml,
  version: '0.157.0',
  distribution: 'contrib',
  valid: false,
  diagnostics: [
    {
      severity: 'error',
      message: "The receiver 'filestats' is not available",
      path: 'receivers.filestats',
      line: 3,
      column: 3,
      hint: "It was renamed to 'file_stats' in v0.152.0",
    },
  ],
}, '*')
window.postMessage({
  type: 'components',
  version: '0.157.0',
  components: [
    { kind: 'receiver', type: 'file_stats', signals: ['metrics'], available: true, isDeprecated: false, distributions: ['contrib'] },
    { kind: 'receiver', type: 'otlp', signals: ['traces', 'metrics', 'logs'], available: true, isDeprecated: false },
    { kind: 'processor', type: 'batch', signals: ['traces', 'metrics', 'logs'], available: true, isDeprecated: false },
    { kind: 'exporter', type: 'debug', signals: ['traces', 'metrics', 'logs'], available: true, isDeprecated: false },
    { kind: 'extension', type: 'health_check', signals: [], available: true, isDeprecated: false },
  ],
}, '*')

// ── Rendering ──
await until(() => doc.querySelector('svg'), 'canvas rendered')
assert.equal(doc.documentElement.dataset.theme, 'dark', 'theme synced from vscode-dark body class')
const nodeTitles = [...doc.querySelectorAll('.flow-node .node-title')].map((n) => n.textContent)
for (const expected of ['otlp', 'filestats', 'batch', 'debug', 'health_check']) {
  assert.ok(nodeTitles.some((t) => t?.includes(expected)), `node rendered: ${expected}`)
}
const errNodes = [...doc.querySelectorAll('.flow-node.has-error .node-title')].map((n) => n.textContent)
assert.ok(errNodes.some((t) => t?.includes('filestats')), 'filestats flagged as error from diagnostics path')
const bar = doc.querySelector('.embed-bar')
assert.ok(bar?.textContent?.includes('otelcol.yaml'), 'file name in bar')
assert.ok(bar?.textContent?.includes('1 error'), 'error count in bar')

// ── Click a node: details dialog opens, editor reveal posted ──
const target = [...doc.querySelectorAll('.flow-node')].find((n) =>
  n.querySelector('.node-title')?.textContent?.includes('filestats'),
)
click(target)
await until(() => doc.querySelector('.modal-backdrop'), 'details dialog opened')
assert.equal(ofType('reveal').length, 1, 'reveal posted on select')
assert.equal(JSON.stringify(ofType('reveal')[0].selection), JSON.stringify({ kind: 'receiver', id: 'filestats' }))

// ── Scoped removal: applyYaml, then confirm round-trip, then chained removal ──
const removeBtn = byText('.modal-backdrop button', 'Remove from metrics')
assert.ok(removeBtn, 'scoped remove button present')
click(removeBtn)
await until(() => ofType('applyYaml').length >= 1, 'scoped removal applied')
const afterScoped = ofType('applyYaml')[0].yaml
assert.ok(/receivers: \[\s*otlp\s*\]/.test(afterScoped), 'filestats removed from pipeline receivers only')
assert.ok(afterScoped.includes('filestats:'), 'definition still present after scoped removal')
await until(() => ofType('confirm').length === 1, 'confirm requested for last usage')
const confirmMsg = ofType('confirm')[0]
assert.ok(confirmMsg.message.includes("'filestats' is no longer used"), 'confirm message names the component')

window.postMessage({ type: 'confirmResult', token: confirmMsg.token, ok: true }, '*')
await until(() => ofType('applyYaml').length >= 2, 'definition removal applied after confirm')
const afterFull = ofType('applyYaml')[1].yaml
assert.ok(!afterFull.includes('filestats'), 'definition gone after confirmed removal')
assert.ok(afterFull.includes('otlp:'), 'other components untouched')

// ── Add zones: catalog dialog opens with distro-filtered components ──
await until(() => !doc.querySelector('.modal-backdrop'), 'details dialog closed after removal')
const addZone = [...doc.querySelectorAll('.add-zone')].find((z) => z.textContent?.includes('Receiver'))
assert.ok(addZone, 'add-receiver zone rendered (canvas is editable)')
click(addZone)
await until(() => byText('.modal h2', 'Add component'), 'add-component dialog opened')
assert.ok(byText('.modal', 'file_stats'), 'catalog lists file_stats')

console.log(
  'designer test passed:',
  nodeTitles.length,
  'nodes; applyYaml chain:',
  ofType('applyYaml').length,
  'edits; confirm round-trip ok',
)
