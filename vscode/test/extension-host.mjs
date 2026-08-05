// Drives the compiled extension (dist/extension.cjs) against a mocked
// 'vscode' module, verifying the editor→webview update pipe: opening the
// designer, typing into the document, and designer-initiated YAML edits
// must each produce an update message to the webview.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── vscode API stub ──
const handlers = { openDoc: [], changeDoc: [], closeDoc: [], activeEditor: [], config: [] }
const commands = new Map()
const posted = [] // messages posted to the webview
let webviewMessageHandler = null
let panelCreated = false
let codeActionProvider = null
let lastDiagnostics = []

class Position {
  constructor(line, character) { this.line = line; this.character = character }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d) }
    else { this.start = a; this.end = b }
  }
}
class WorkspaceEdit {
  constructor() { this.edits = [] }
  replace(uri, range, text) { this.edits.push({ uri, range, text }) }
}

function makeDoc(fileName, text) {
  const doc = {
    languageId: 'yaml',
    fileName,
    uri: { toString: () => `file://${fileName}`, fsPath: fileName },
    getText: () => doc._text,
    _text: text,
    get lineCount() { return doc._text.split('\n').length },
    lineAt(i) {
      const line = doc._text.split('\n')[i]
      return { range: new Range(i, 0, i, line.length) }
    },
    positionAt(offset) {
      const before = doc._text.slice(0, offset).split('\n')
      return new Position(before.length - 1, before[before.length - 1].length)
    },
    offsetAt(pos) {
      const lines = doc._text.split('\n')
      return lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.character
    },
  }
  return doc
}

const doc = makeDoc('/tmp/otelcol.yaml', [
  'receivers:', '  otlp:',
  'exporters:', '  debug:',
  'service:',
  '  pipelines:',
  '    traces:',
  '      receivers: [otlp]',
  '      exporters: [debug]',
].join('\n'))

class CodeAction {
  constructor(title, kind) { this.title = title; this.kind = kind }
}
const vscodeStub = {
  Position, Range, WorkspaceEdit,
  CodeAction,
  CodeActionKind: { QuickFix: 'quickfix' },
  Uri: { file: (p) => ({ toString: () => `file://${p}`, fsPath: p }) },
  ViewColumn: { One: 1, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity } },
  languages: {
    createDiagnosticCollection: () => ({
      set: (_uri, diags) => { lastDiagnostics = diags ?? [] },
      delete: () => {},
      dispose: () => {},
    }),
    registerCodeActionsProvider: (_sel, provider) => ((codeActionProvider = provider), { dispose: () => {} }),
  },
  window: {
    activeTextEditor: { document: doc, viewColumn: 1 },
    visibleTextEditors: [{ document: doc, viewColumn: 1 }],
    createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
    onDidChangeActiveTextEditor: (fn) => (handlers.activeEditor.push(fn), { dispose: () => {} }),
    showTextDocument: async () => {},
    showQuickPick: async () => undefined,
    showWarningMessage: async () => undefined,
    createWebviewPanel: () => {
      panelCreated = true
      return {
        webview: {
          set html(_) {},
          cspSource: 'stub:',
          asWebviewUri: (u) => u,
          postMessage: (m) => (posted.push(m), Promise.resolve(true)),
          onDidReceiveMessage: (fn) => (webviewMessageHandler = fn, { dispose: () => {} }),
        },
        iconPath: null,
        reveal: () => {},
        onDidDispose: () => ({ dispose: () => {} }),
        dispose: () => {},
      }
    },
  },
  workspace: {
    textDocuments: [doc],
    workspaceFolders: [{}],
    getConfiguration: () => ({ get: (_k, def) => def, update: async () => {} }),
    onDidOpenTextDocument: (fn) => (handlers.openDoc.push(fn), { dispose: () => {} }),
    onDidChangeTextDocument: (fn) => (handlers.changeDoc.push(fn), { dispose: () => {} }),
    onDidCloseTextDocument: (fn) => (handlers.closeDoc.push(fn), { dispose: () => {} }),
    onDidChangeConfiguration: (fn) => (handlers.config.push(fn), { dispose: () => {} }),
    applyEdit: async (edit) => {
      for (const e of edit.edits) {
        const start = doc.offsetAt(e.range.start)
        const end = doc.offsetAt(e.range.end)
        doc._text = doc._text.slice(0, start) + e.text + doc._text.slice(end)
      }
      for (const fn of handlers.changeDoc) fn({ document: doc })
      return true
    },
  },
  commands: {
    registerCommand: (id, fn) => (commands.set(id, fn), { dispose: () => {} }),
  },
}

// Intercept require('vscode') inside the bundle.
const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub
  return origLoad.call(this, request, ...rest)
}

const ext = require(join(root, 'dist', 'extension.cjs'))
ext.activate({ extensionPath: root, subscriptions: [] })

const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const updates = () => posted.filter((m) => m.type === 'update')

// ── 1. Open the designer: initial update must arrive ──
await settle(600) // activation debounce
commands.get('otelflow.openPreview')()
await settle(800)
assert.ok(panelCreated, 'panel created')
assert.equal(updates().length >= 1, true, 'initial update posted on open')
assert.ok(updates().at(-1).yaml.includes('debug'), 'initial yaml delivered')

// ── 2. Type into the document: the webview must get the new text ──
const before = updates().length
doc._text = doc._text.replace('  debug:', '  debug:\n  otlphttp:').replace('[debug]', '[debug, otlphttp]')
for (const fn of handlers.changeDoc) fn({ document: doc })
await settle(800) // debounce + validate
assert.ok(updates().length > before, `typing produced an update (got ${updates().length - before})`)
assert.ok(updates().at(-1).yaml.includes('otlphttp'), 'typed exporter reached the webview')

// ── 3. Designer edit: applyYaml round-trips back as an update ──
const before2 = updates().length
const newYaml = doc._text.replace('  otlp:', '  otlp:\n  zipkin:').replace('[otlp]', '[otlp, zipkin]')
await webviewMessageHandler({ type: 'applyYaml', yaml: newYaml })
await settle(800)
assert.ok(doc._text.includes('zipkin'), 'applyYaml edited the document')
assert.ok(updates().length > before2, 'designer edit round-tripped as an update')
assert.ok(updates().at(-1).yaml.includes('zipkin'), 'mutated yaml reached the webview')

// ── 4. Rename quick fix: diagnostic -> code action -> full-document rename ──
doc._text = [
  'receivers:', '  filestats/disk:', '  otlp:', '    protocols:', '      grpc:',
  'exporters:', '  debug:',
  'service:',
  '  pipelines:',
  '    metrics:',
  '      receivers: [filestats/disk, otlp]',
  '      exporters: [debug]',
].join('\n')
for (const fn of handlers.changeDoc) fn({ document: doc })
await settle(800)
assert.ok(codeActionProvider, 'code action provider registered')
assert.ok(lastDiagnostics.length > 0, 'diagnostics published for filestats config')
const actions = codeActionProvider.provideCodeActions(doc, null, { diagnostics: lastDiagnostics })
const rename = actions.find((a) => a.title.includes('file_stats/disk'))
assert.ok(rename, `rename quick fix offered (got: ${actions.map((a) => a.title).join(' | ')})`)
await vscodeStub.workspace.applyEdit(rename.edit)
assert.ok(doc._text.includes('file_stats/disk:'), 'definition renamed')
assert.ok(/\[\s*file_stats\/disk,\s*otlp\s*\]/.test(doc._text), 'pipeline reference renamed')
assert.ok(!doc._text.includes('filestats/disk'), 'old name gone everywhere')

console.log('extension-host test passed:', updates().length, 'updates delivered; rename quick fix applied')
