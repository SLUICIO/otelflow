/**
 * The preview webview: renders the OTelFlow pipeline canvas (the same
 * components the web app's embed view uses) from state pushed in by the
 * extension. Clicking a node posts a reveal request back to the editor.
 */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FlowGraph, type Selection } from '../../../web/src/components/FlowGraph'
import { parseConfigModel } from '../../../web/src/lib/parse'
import type { Component, Diagnostic } from '../../../web/src/types'
import '../../../web/src/styles.css'
import './webview.css'

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void
  getState(): PreviewState | undefined
  setState(state: PreviewState): void
}
const vscode = acquireVsCodeApi()

interface PreviewState {
  fileName: string
  yaml: string
  version: string
  distribution: string
  valid: boolean | null
  diagnostics: Diagnostic[]
}

/**
 * Messages can arrive before React has mounted and run its effects — the
 * extension posts the first update as soon as validation completes. A
 * module-level listener buffers anything that arrives early so nothing is
 * lost in the gap.
 */
const pendingMessages: unknown[] = []
let deliverMessage: ((msg: unknown) => void) | null = null
window.addEventListener('message', (e: MessageEvent) => {
  if (deliverMessage) deliverMessage(e.data)
  else pendingMessages.push(e.data)
})

/** VS Code stamps the theme as a body class; mirror it onto data-theme. */
function syncTheme(): void {
  const dark =
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast')
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

function BlockS({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M 48 17 H 16 V 32 H 48 V 47 H 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  )
}

function App() {
  const [state, setState] = useState<PreviewState | null>(vscode.getState() ?? null)
  const [components, setComponents] = useState<Component[]>([])

  useEffect(() => {
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    const onMessage = (msg: any) => {
      if (msg?.type === 'update') {
        const next: PreviewState = {
          fileName: msg.fileName,
          yaml: msg.yaml,
          version: msg.version,
          distribution: msg.distribution,
          valid: msg.valid,
          diagnostics: msg.diagnostics ?? [],
        }
        setState(next)
        vscode.setState(next)
      } else if (msg?.type === 'components') {
        setComponents(msg.components ?? [])
      }
    }
    deliverMessage = onMessage
    for (const msg of pendingMessages.splice(0)) onMessage(msg)
    return () => {
      observer.disconnect()
      deliverMessage = null
    }
  }, [])

  const model = useMemo(() => parseConfigModel(state?.yaml ?? ''), [state?.yaml])
  const componentIndex = useMemo(() => {
    const m = new Map<string, Component>()
    for (const c of components) m.set(`${c.kind}:${c.type}`, c)
    return m
  }, [components])

  if (!state) {
    return <div className="preview-empty">Open an OpenTelemetry Collector configuration to see its pipelines.</div>
  }

  const errors = state.diagnostics.filter((d) => d.severity === 'error').length
  return (
    <div className="app embed">
      <div className="graph-scroll" style={{ flex: '1 1 0' }}>
        <FlowGraph
          model={model}
          componentIndex={componentIndex}
          diagnostics={state.diagnostics}
          selected={null}
          onSelect={(sel: Selection | null) => {
            if (sel) vscode.postMessage({ type: 'reveal', selection: { kind: sel.kind, id: sel.id } })
          }}
          onAdd={() => {}}
          onAddPipeline={() => {}}
          readOnly
        />
      </div>
      <div className="embed-bar">
        <span className="brand" style={{ gap: 7 }}>
          <BlockS size={16} />
          <span className="brand-name" style={{ fontSize: 13 }}>OTelFlow</span>
        </span>
        <span className="preview-file" title={state.fileName}>{state.fileName}</span>
        {state.version && <span className="pill pill--outline">collector v{state.version}</span>}
        <span className="pill pill--outline">{state.distribution}</span>
        {state.valid === null ? (
          <span className="pill pill--outline"><span className="dot" />Validating</span>
        ) : state.valid ? (
          <span className="pill pill--ok"><span className="dot" />Valid</span>
        ) : (
          <span className="pill pill--err"><span className="dot" />{errors} error{errors === 1 ? '' : 's'}</span>
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
