import * as vscode from 'vscode'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { components, type ValidationResult } from './validator'

export interface RevealRequest {
  kind: string
  id: string
}

/**
 * The pipeline-flow preview: a single webview panel beside the editor that
 * renders the same read-only canvas as otelflow.sluicio.com's embed view.
 * The extension pushes document text + validation results in; the webview
 * posts click-to-reveal requests back.
 */
export class PreviewPanel {
  private panel: vscode.WebviewPanel | null = null
  private sentComponentsFor: string | null = null

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly assetDir: string,
    private readonly onReveal: (req: RevealRequest) => void,
  ) {}

  get isOpen(): boolean {
    return this.panel !== null
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true)
      return
    }
    this.panel = vscode.window.createWebviewPanel(
      'otelflowPreview',
      'OTelFlow pipeline preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.assetDir, 'webview'))],
      },
    )
    this.panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'icon.png'))
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.webview.onDidReceiveMessage((m: { type?: string; selection?: RevealRequest }) => {
      if (m?.type === 'reveal' && m.selection) this.onReveal(m.selection)
    })
    this.panel.onDidDispose(() => {
      this.panel = null
      this.sentComponentsFor = null
    })
  }

  async update(
    doc: vscode.TextDocument,
    version: string,
    distribution: string,
    result: ValidationResult,
  ): Promise<void> {
    if (!this.panel) return
    // The catalog is a few hundred KB; send it only when the version changes.
    if (this.sentComponentsFor !== version) {
      const comps = await components(this.assetDir, version)
      if (!this.panel) return
      this.sentComponentsFor = version
      void this.panel.webview.postMessage({ type: 'components', version, components: comps })
    }
    void this.panel.webview.postMessage({
      type: 'update',
      fileName: path.basename(doc.fileName),
      yaml: doc.getText(),
      version,
      distribution,
      valid: result.valid,
      diagnostics: result.diagnostics,
    })
  }

  private html(webview: vscode.Webview): string {
    const uri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.assetDir, 'webview', file)))
    const nonce = crypto.randomBytes(16).toString('base64')
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri('main.css')}">
  <title>OTelFlow pipeline preview</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`
  }
}
