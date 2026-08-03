/**
 * The designer webview: the OTelFlow canvas plus the click-to-configure
 * dialogs from the web app, driven by state pushed in by the extension.
 * Mutations run here (comment-preserving YAML edits via the yaml Document
 * API) and the result is posted back for the extension to apply to the
 * text document — VS Code's editor stays the source of truth.
 */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FlowGraph, type Selection } from '../../../web/src/components/FlowGraph'
import { AddComponentDialog } from '../../../web/src/components/AddComponentDialog'
import { AddPipelineDialog } from '../../../web/src/components/AddPipelineDialog'
import { DetailsDialog } from '../../../web/src/components/DetailsDialog'
import { parseConfigModel } from '../../../web/src/lib/parse'
import {
  addComponent,
  addPipeline,
  getComponentConfig,
  removeComponent,
  removeFromPipeline,
  setComponentConfig,
} from '../../../web/src/lib/mutate'
import type { Component, ConfigModel, Diagnostic, Kind } from '../../../web/src/types'
import { KIND_TO_SECTION } from '../../../web/src/types'
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

/** Round-trip confirmation through a native VS Code modal dialog. */
let confirmToken = 0
const confirmWaiters = new Map<number, (ok: boolean) => void>()
function confirmModal(message: string, confirmLabel: string): Promise<boolean> {
  const token = ++confirmToken
  vscode.postMessage({ type: 'confirm', token, message, confirmLabel })
  return new Promise((resolve) => confirmWaiters.set(token, resolve))
}

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

function countUsages(model: ConfigModel, id: string): number {
  let n = 0
  for (const p of model.pipelines) {
    for (const role of ['receivers', 'processors', 'exporters'] as const) {
      n += p[role].filter((x) => x === id).length
    }
  }
  n += model.serviceExtensions.filter((x) => x === id).length
  return n
}

function App() {
  const [state, setState] = useState<PreviewState | null>(vscode.getState() ?? null)
  const [components, setComponents] = useState<Component[]>([])
  const [selected, setSelected] = useState<Selection | null>(null)
  const [addDialog, setAddDialog] = useState<{ kind: Kind; pipeline?: string } | null>(null)
  const [pipelineDialog, setPipelineDialog] = useState(false)

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
      } else if (msg?.type === 'confirmResult') {
        confirmWaiters.get(msg.token)?.(msg.ok === true)
        confirmWaiters.delete(msg.token)
      }
    }
    deliverMessage = onMessage
    for (const msg of pendingMessages.splice(0)) onMessage(msg)
    return () => {
      observer.disconnect()
      deliverMessage = null
    }
  }, [])

  const yaml = state?.yaml ?? ''
  const model = useMemo(() => parseConfigModel(yaml), [yaml])
  const componentIndex = useMemo(() => {
    const m = new Map<string, Component>()
    for (const c of components) m.set(`${c.kind}:${c.type}`, c)
    return m
  }, [components])
  const catalogComponents = useMemo(
    () =>
      components.filter(
        (c) => !c.distributions || c.distributions.includes(state?.distribution ?? 'contrib'),
      ),
    [components, state?.distribution],
  )

  // Drop selection if the component disappeared from the config.
  useEffect(() => {
    if (!selected) return
    const section = KIND_TO_SECTION[selected.kind]
    const present =
      model.sections[section].includes(selected.id) ||
      (selected.kind !== 'connector' && model.sections.connectors.includes(selected.id))
    if (!present) setSelected(null)
  }, [model, selected])

  function apply(newYaml: string): void {
    vscode.postMessage({ type: 'applyYaml', yaml: newYaml })
  }

  // A node drawn as receiver/exporter may actually be a connector — resolve
  // the true section for edits.
  function resolveSection(sel: Selection) {
    if (model.sections.connectors.includes(sel.id)) return 'connectors' as const
    return KIND_TO_SECTION[sel.kind]
  }

  const selectedComponent = useMemo(() => {
    if (!selected) return undefined
    const section = resolveSection(selected)
    const kind = section === 'connectors' ? 'connector' : selected.kind
    const type = selected.id.includes('/') ? selected.id.slice(0, selected.id.indexOf('/')) : selected.id
    return componentIndex.get(`${kind}:${type}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, componentIndex, model])

  if (!state) {
    return (
      <div className="preview-empty">
        Open an OpenTelemetry Collector configuration to design its pipelines.
      </div>
    )
  }

  const errors = state.diagnostics.filter((d) => d.severity === 'error').length
  return (
    <div className="app embed">
      <div className="graph-scroll" style={{ flex: '1 1 0' }}>
        <FlowGraph
          model={model}
          componentIndex={componentIndex}
          diagnostics={state.diagnostics}
          selected={selected}
          onSelect={(sel: Selection | null) => {
            setSelected(sel)
            // Scroll the text editor along without stealing focus.
            if (sel) vscode.postMessage({ type: 'reveal', selection: { kind: sel.kind, id: sel.id } })
          }}
          onAdd={(kind: Kind, pipelineId?: string) => setAddDialog({ kind, pipeline: pipelineId })}
          onAddPipeline={() => setPipelineDialog(true)}
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

      {selected && (
        <DetailsDialog
          key={`${selected.kind}:${selected.id}:${selected.pipeline ?? ''}`}
          kind={model.sections.connectors.includes(selected.id) ? 'connector' : selected.kind}
          id={selected.id}
          pipeline={selected.pipeline}
          component={selectedComponent}
          initialConfig={getComponentConfig(yaml, resolveSection(selected), selected.id)}
          onApply={(config) => apply(setComponentConfig(yaml, resolveSection(selected), selected.id, config))}
          onRemove={() => {
            const sel = selected
            const section = resolveSection(sel)
            setSelected(null)
            if (sel.pipeline && sel.role) {
              // Scoped removal: only this pipeline's reference goes. Chain
              // the optional definition removal on the already-mutated text.
              const usagesLeft = countUsages(model, sel.id) - 1
              const afterScoped = removeFromPipeline(yaml, sel.pipeline, sel.role, sel.id)
              apply(afterScoped)
              if (usagesLeft <= 0) {
                void confirmModal(
                  `'${sel.id}' is no longer used by any pipeline. Also remove its definition from the ${section} section? Its configuration will be deleted.`,
                  'Remove definition',
                ).then((ok) => {
                  if (ok) apply(removeComponent(afterScoped, section, sel.id))
                })
              }
            } else {
              apply(removeComponent(yaml, section, sel.id))
            }
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {pipelineDialog && (
        <AddPipelineDialog
          model={model}
          componentIndex={componentIndex}
          onCreate={(id, lists) => apply(addPipeline(yaml, id, lists))}
          onClose={() => setPipelineDialog(false)}
        />
      )}

      {addDialog && state.version && (
        <AddComponentDialog
          initialKind={addDialog.kind}
          initialPipeline={addDialog.pipeline}
          version={state.version}
          distro={state.distribution}
          components={catalogComponents}
          model={model}
          onAdd={(kind, id, config, opts) => apply(addComponent(yaml, kind, id, config, opts))}
          onClose={() => setAddDialog(null)}
        />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
