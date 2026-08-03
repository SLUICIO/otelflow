// Runs the real webview bundle inside jsdom and verifies the rendered canvas.
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'

const dom = new JSDOM(`<!DOCTYPE html><html><body class="vscode-dark"><div id="root"></div></body></html>`, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
})
const { window } = dom

const reveals = []
window.acquireVsCodeApi = () => ({
  postMessage: (m) => reveals.push(m),
  getState: () => undefined,
  setState: () => {},
})

window.eval(readFileSync(new URL('../dist/webview/main.js', import.meta.url), 'utf8'))

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

await new Promise((r) => setTimeout(r, 100))

const doc = window.document
assert.equal(doc.documentElement.dataset.theme, 'dark', 'theme synced from vscode-dark body class')
const svg = doc.querySelector('svg')
assert.ok(svg, 'canvas rendered')

const nodeTitles = [...doc.querySelectorAll('.flow-node .node-title')].map((n) => n.textContent)
for (const expected of ['otlp', 'filestats', 'batch', 'debug', 'health_check']) {
  assert.ok(nodeTitles.some((t) => t?.includes(expected)), `node rendered: ${expected}`)
}

const errNodes = [...doc.querySelectorAll('.flow-node.has-error .node-title')].map((n) => n.textContent)
assert.ok(errNodes.some((t) => t?.includes('filestats')), 'filestats flagged as error from diagnostics path')
assert.ok(!errNodes.some((t) => t?.includes('otlp')), 'otlp not flagged')

const bar = doc.querySelector('.embed-bar')
assert.ok(bar?.textContent?.includes('otelcol.yaml'), 'file name in bar')
assert.ok(bar?.textContent?.includes('collector v0.157.0'), 'version pill in bar')
assert.ok(bar?.textContent?.includes('1 error'), 'error count in bar')

// Click a node: readOnly canvas must still post a reveal request.
const target = [...doc.querySelectorAll('.flow-node')].find((n) =>
  n.querySelector('.node-title')?.textContent?.includes('filestats'),
)
target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 50))
assert.equal(reveals.length, 1, 'one reveal message posted')
assert.equal(
  JSON.stringify(reveals[0]),
  JSON.stringify({ type: 'reveal', selection: { kind: 'receiver', id: 'filestats' } }),
)

console.log('webview render test passed:', nodeTitles.length, 'nodes, reveal =', JSON.stringify(reveals[0].selection))
