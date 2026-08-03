import * as vscode from 'vscode'
import * as path from 'node:path'
import { meta, validate, type Meta, type ValidationResult } from './validator'
import { PreviewPanel, type RevealRequest } from './preview'

/**
 * A YAML document is treated as a collector configuration when it has a
 * top-level `service:` section plus at least one component section. This
 * keeps the extension silent on unrelated YAML (CI workflows, k8s manifests).
 */
function looksLikeCollectorConfig(text: string): boolean {
  return (
    /^service:/m.test(text) &&
    /^(receivers|processors|exporters|connectors|extensions):/m.test(text)
  )
}

/**
 * Per-file override, e.g. `# otelflow: version=0.157.0 distro=core`
 * anywhere in the document — handy for repositories with several collectors
 * on different versions.
 */
function magicComment(text: string): { version?: string; distro?: string } {
  const m = /^#\s*otelflow:\s*(.+)$/m.exec(text)
  if (!m) return {}
  return {
    version: /version=(\S+)/.exec(m[1])?.[1],
    distro: /distro=(\S+)/.exec(m[1])?.[1],
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const assetDir = path.join(context.extensionPath, 'dist')
  const diagnostics = vscode.languages.createDiagnosticCollection('otelflow')
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  status.command = 'otelflow.selectTarget'
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const results = new Map<string, ValidationResult>()
  let registryMeta: Meta | undefined
  let previewDoc: vscode.TextDocument | null = null
  const preview = new PreviewPanel(context, assetDir, revealComponent, applyYaml)

  /**
   * A designer mutation: replace the document's text with the webview's
   * result, as a minimal single-range edit so the editor keeps its scroll
   * position and undo works naturally.
   */
  async function applyYaml(newYaml: string): Promise<void> {
    const doc = previewDoc
    if (!doc) return
    const old = doc.getText()
    if (old === newYaml) return
    let start = 0
    while (start < old.length && start < newYaml.length && old[start] === newYaml[start]) start++
    let endOld = old.length
    let endNew = newYaml.length
    while (endOld > start && endNew > start && old[endOld - 1] === newYaml[endNew - 1]) {
      endOld--
      endNew--
    }
    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(start), doc.positionAt(endOld)),
      newYaml.slice(start, endNew),
    )
    await vscode.workspace.applyEdit(edit)
  }

  /** Click-to-reveal from the preview: jump to the component's definition. */
  function revealComponent(req: RevealRequest): void {
    const doc = previewDoc
    if (!doc) return
    const section = `${req.kind}s:`
    const lines = doc.getText().split('\n')
    const start = lines.findIndex((l) => l === section || l.startsWith(section))
    if (start === -1) return
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() !== '' && !/^[\s#]/.test(line)) break // next top-level section
      const m = /^(\s+)(\S+):/.exec(line)
      if (m && m[2] === req.id) {
        const range = new vscode.Range(i, m[1].length, i, m[1].length + req.id.length)
        const visible = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === doc.uri.toString(),
        )
        void vscode.window.showTextDocument(doc, {
          viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
          selection: range,
          preserveFocus: true,
        })
        return
      }
    }
  }
  void meta(assetDir).then((m) => {
    registryMeta = m
    updateStatus()
  })

  function target(doc: vscode.TextDocument): { version: string; distro: string } {
    const cfg = vscode.workspace.getConfiguration('otelflow', doc.uri)
    const override = magicComment(doc.getText())
    return {
      version: override.version ?? cfg.get<string>('collectorVersion', ''),
      distro: override.distro ?? cfg.get<string>('distribution', 'contrib'),
    }
  }

  function toRange(doc: vscode.TextDocument, line?: number, column?: number): vscode.Range {
    if (!line || line < 1 || line > doc.lineCount) return new vscode.Range(0, 0, 0, 0)
    const textLine = doc.lineAt(line - 1)
    const start = Math.min(Math.max((column ?? 1) - 1, 0), textLine.range.end.character)
    return new vscode.Range(line - 1, start, line - 1, textLine.range.end.character)
  }

  const SEVERITIES: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  }

  async function check(doc: vscode.TextDocument): Promise<void> {
    if (doc.languageId !== 'yaml' || !looksLikeCollectorConfig(doc.getText())) {
      diagnostics.delete(doc.uri)
      results.delete(doc.uri.toString())
      updateStatus()
      return
    }
    const { version, distro } = target(doc)
    const result = await validate(assetDir, doc.getText(), version, distro)
    results.set(doc.uri.toString(), result)
    // The preview follows whichever collector config was validated last while
    // active; keep pushing updates for the shown doc even when it's not.
    if (
      preview.isOpen &&
      (doc === vscode.window.activeTextEditor?.document || doc === previewDoc || !previewDoc)
    ) {
      previewDoc = doc
      const shown = version || registryMeta?.defaultVersion || ''
      void preview.update(doc, shown, distro, result)
    }
    diagnostics.set(
      doc.uri,
      result.diagnostics.map((d) => {
        const diag = new vscode.Diagnostic(
          toRange(doc, d.line, d.column),
          d.hint ? `${d.message}\n${d.hint}` : d.message,
          SEVERITIES[d.severity] ?? vscode.DiagnosticSeverity.Error,
        )
        diag.source = 'otelflow'
        return diag
      }),
    )
    updateStatus()
  }

  function schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString()
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        void check(doc)
      }, 300),
    )
  }

  function updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document
    if (!doc || doc.languageId !== 'yaml' || !looksLikeCollectorConfig(doc.getText())) {
      status.hide()
      return
    }
    const { version, distro } = target(doc)
    const shown = version || registryMeta?.defaultVersion || 'default'
    const result = results.get(doc.uri.toString())
    const icon = !result ? '$(sync~spin)' : result.valid ? '$(check)' : '$(error)'
    status.text = `${icon} OTel ${distro} v${shown}`
    status.tooltip =
      'OTelFlow: collector version and distribution used for validation — click to change'
    status.show()
  }

  context.subscriptions.push(
    diagnostics,
    status,
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri)
      results.delete(doc.uri.toString())
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateStatus()
      // Retarget the preview when the user switches to another collector config.
      if (preview.isOpen && editor && editor.document.languageId === 'yaml') {
        schedule(editor.document)
      }
    }),
    vscode.commands.registerCommand('otelflow.openPreview', () => {
      preview.show()
      const doc = vscode.window.activeTextEditor?.document ?? previewDoc
      if (doc) void check(doc)
    }),
    // Offer the bundled MCP server (dist/mcp.cjs — same tools as `otelflow
    // mcp`) to the editor's AI features. Guarded: older hosts lack the API.
    ...(vscode.lm?.registerMcpServerDefinitionProvider
      ? [
          vscode.lm.registerMcpServerDefinitionProvider('otelflow.mcp', {
            provideMcpServerDefinitions: () => [
              new vscode.McpStdioServerDefinition(
                'OTelFlow',
                process.execPath,
                [path.join(context.extensionPath, 'dist', 'mcp.cjs')],
                { ELECTRON_RUN_AS_NODE: '1' },
              ),
            ],
          }),
        ]
      : []),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('otelflow')) {
        for (const doc of vscode.workspace.textDocuments) schedule(doc)
      }
    }),
    vscode.commands.registerCommand('otelflow.selectTarget', async () => {
      const m = registryMeta ?? (registryMeta = await meta(assetDir))
      const version = await vscode.window.showQuickPick(
        [
          { label: `Registry default (v${m.defaultVersion})`, value: '' },
          ...[...m.versions].reverse().map((v) => ({ label: `v${v}`, value: v })),
        ],
        { title: 'Collector version to validate against' },
      )
      if (!version) return
      const distro = await vscode.window.showQuickPick(
        m.distributions.map((d) => ({ label: d })),
        { title: 'Collector distribution' },
      )
      if (!distro) return
      const scope = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
      const cfg = vscode.workspace.getConfiguration('otelflow')
      await cfg.update('collectorVersion', version.value, scope)
      await cfg.update('distribution', distro.label, scope)
    }),
  )

  for (const doc of vscode.workspace.textDocuments) schedule(doc)
}

export function deactivate(): void {}
