import * as vscode from 'vscode'
import * as path from 'node:path'
import { meta, validate, type Meta, type ValidationResult } from './validator'

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
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
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
