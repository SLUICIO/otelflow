import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchComponents, fetchMeta, validateConfig } from './api'
import { parseConfigModel } from './lib/parse'
import { addComponent, getComponentConfig, removeComponent, setComponentConfig } from './lib/mutate'
import { Editor } from './components/Editor'
import { FlowGraph, type Selection } from './components/FlowGraph'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { AddComponentDialog } from './components/AddComponentDialog'
import { DetailsDialog } from './components/DetailsDialog'
import { SAMPLE_CONFIG } from './sample'
import type { Component, Diagnostic, Kind, Meta } from './types'
import { KIND_TO_SECTION, componentType } from './types'

const LS_YAML = 'sluicio.otelcol.yaml'
const LS_VERSION = 'sluicio.otelcol.version'
const LS_THEME = 'sluicio.theme'
const LS_EDITOR_WIDTH = 'sluicio.editorWidth'
const LS_EDITOR_HIDDEN = 'sluicio.editorHidden'

const EDITOR_MIN_W = 300
const GRAPH_MIN_W = 460

type ValState = 'pending' | 'valid' | 'invalid' | 'offline'
type ThemePref = 'auto' | 'light' | 'dark'

function useTheme(): [ThemePref, (t: ThemePref) => void, boolean] {
  const [pref, setPref] = useState<ThemePref>(
    () => (localStorage.getItem(LS_THEME) as ThemePref) || 'auto',
  )
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  useEffect(() => {
    localStorage.setItem(LS_THEME, pref)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const isDark = pref === 'dark' || (pref === 'auto' && mq.matches)
      document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
      setDark(isDark)
    }
    apply()
    if (pref === 'auto') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [pref])
  return [pref, setPref, dark]
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [version, setVersion] = useState<string>('')
  const [components, setComponents] = useState<Component[]>([])
  const [yamlText, setYamlText] = useState<string>(() => localStorage.getItem(LS_YAML) ?? SAMPLE_CONFIG)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [valState, setValState] = useState<ValState>('pending')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [dialog, setDialog] = useState<{ kind: Kind; pipeline?: string } | null>(null)
  const [jumpLine, setJumpLine] = useState<number | null>(null)
  const [themePref, setThemePref, isDark] = useTheme()

  // Split layout: draggable divider + hideable configuration panel.
  const [editorWidth, setEditorWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LS_EDITOR_WIDTH))
    return saved > 0 ? saved : Math.round(window.innerWidth * 0.42)
  })
  const [editorHidden, setEditorHidden] = useState<boolean>(
    () => localStorage.getItem(LS_EDITOR_HIDDEN) === '1',
  )
  useEffect(() => {
    localStorage.setItem(LS_EDITOR_WIDTH, String(editorWidth))
  }, [editorWidth])
  useEffect(() => {
    localStorage.setItem(LS_EDITOR_HIDDEN, editorHidden ? '1' : '0')
  }, [editorHidden])

  const clampWidth = useCallback(
    (w: number) => Math.min(Math.max(w, EDITOR_MIN_W), Math.max(EDITOR_MIN_W, window.innerWidth - GRAPH_MIN_W)),
    [],
  )

  const startSplitterDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = editorWidth
      const move = (ev: PointerEvent) => setEditorWidth(clampWidth(startW + ev.clientX - startX))
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.removeProperty('cursor')
        document.body.style.removeProperty('user-select')
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [editorWidth, clampWidth],
  )

  // Bootstrap: versions + default
  useEffect(() => {
    fetchMeta()
      .then((m) => {
        setMeta(m)
        const saved = localStorage.getItem(LS_VERSION)
        setVersion(saved && m.versions.includes(saved) ? saved : m.defaultVersion)
      })
      .catch(() => setValState('offline'))
  }, [])

  // Component catalog per version
  useEffect(() => {
    if (!version) return
    localStorage.setItem(LS_VERSION, version)
    fetchComponents(version).then(setComponents).catch(() => setValState('offline'))
  }, [version])

  // Debounced real-time validation
  const validateSeq = useRef(0)
  useEffect(() => {
    if (!version) return
    localStorage.setItem(LS_YAML, yamlText)
    setValState('pending')
    const seq = ++validateSeq.current
    const t = setTimeout(() => {
      validateConfig(yamlText, version)
        .then((r) => {
          if (validateSeq.current !== seq) return
          setDiagnostics(r.diagnostics)
          setValState(r.valid ? 'valid' : 'invalid')
        })
        .catch(() => {
          if (validateSeq.current === seq) setValState('offline')
        })
    }, 350)
    return () => clearTimeout(t)
  }, [yamlText, version])

  const model = useMemo(() => parseConfigModel(yamlText), [yamlText])

  const componentIndex = useMemo(() => {
    const m = new Map<string, Component>()
    for (const c of components) m.set(`${c.kind}:${c.type}`, c)
    return m
  }, [components])

  // Drop selection if the component disappeared from the config
  useEffect(() => {
    if (!selected) return
    const section = KIND_TO_SECTION[selected.kind]
    const present =
      model.sections[section].includes(selected.id) ||
      (selected.kind !== 'connector' && model.sections.connectors.includes(selected.id))
    if (!present) setSelected(null)
  }, [model, selected])

  const handleAdd = useCallback(
    (kind: Kind, id: string, config: unknown, opts: { pipelines: string[]; recvPipelines?: string[]; enableExtension?: boolean }) => {
      setYamlText((prev) =>
        addComponent(prev, kind, id, config, {
          pipelines: opts.pipelines,
          recvPipelines: opts.recvPipelines,
          enableExtension: opts.enableExtension,
        }),
      )
    },
    [],
  )

  // A node drawn as receiver/exporter may actually be a connector — resolve
  // the true section for edits.
  const resolveSection = useCallback(
    (sel: Selection) => {
      if (model.sections.connectors.includes(sel.id)) return 'connectors' as const
      return KIND_TO_SECTION[sel.kind]
    },
    [model],
  )

  const selectedComponent = useMemo(() => {
    if (!selected) return undefined
    const section = resolveSection(selected)
    const kind = section === 'connectors' ? 'connector' : selected.kind
    return componentIndex.get(`${kind}:${componentType(selected.id)}`)
  }, [selected, componentIndex, resolveSection])

  const errors = diagnostics.filter((d) => d.severity === 'error').length

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <BlockS size={24} />
          <span className="brand-name">Sluicio</span>
          <span className="brand-sub">OTelFlow</span>
        </div>
        <div className="header-spacer" />
        <button className="btn btn--link" onClick={() => setYamlText(SAMPLE_CONFIG)}>
          Load sample
        </button>
        <button className="btn btn--link" onClick={() => setYamlText('')}>
          Clear
        </button>
        <div className="version-select">
          <span>Theme</span>
          <select
            value={themePref}
            onChange={(e) => setThemePref(e.target.value as ThemePref)}
            aria-label="Theme"
          >
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div className="version-select">
          <span>Collector</span>
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!meta}>
            {(meta?.versions ?? [version]).map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>
        <StatusBadge state={valState} errors={errors} />
      </header>

      <main
        className="app-main"
        style={{ gridTemplateColumns: editorHidden ? '1fr' : `${editorWidth}px 6px 1fr` }}
      >
        {!editorHidden && (
          <section className="editor-pane">
            <div className="pane-toolbar">
              <span className="pane-title">Configuration</span>
              <span className="muted small mono">YAML</span>
              <button
                className="btn btn--link"
                style={{ marginLeft: 'auto' }}
                onClick={() => setEditorHidden(true)}
                aria-label="Hide configuration panel"
                title="Hide configuration panel"
              >
                «
              </button>
            </div>
            <Editor
              value={yamlText}
              onChange={setYamlText}
              diagnostics={diagnostics}
              jumpToLine={jumpLine}
              onJumped={() => setJumpLine(null)}
              dark={isDark}
            />
            <DiagnosticsPanel diagnostics={diagnostics} onJump={setJumpLine} />
          </section>
        )}

        {!editorHidden && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize configuration panel"
            tabIndex={0}
            onPointerDown={startSplitterDrag}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setEditorWidth((w) => clampWidth(w - 24))
              if (e.key === 'ArrowRight') setEditorWidth((w) => clampWidth(w + 24))
            }}
          />
        )}

        <section className="graph-pane" style={{ position: 'relative' }}>
          <div className="pane-toolbar">
            {editorHidden && (
              <button className="btn btn--link" onClick={() => setEditorHidden(false)}>
                » Show configuration
              </button>
            )}
            <span className="pane-title">Pipeline flow</span>
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn--primary" onClick={() => setDialog({ kind: 'receiver' })}>
                + Add component
              </button>
            </div>
          </div>
          <div className="graph-scroll" onClick={() => setSelected(null)}>
            <FlowGraph
              model={model}
              componentIndex={componentIndex}
              diagnostics={diagnostics}
              selected={selected}
              onSelect={setSelected}
              onAdd={(kind, pipeline) => setDialog({ kind, pipeline })}
            />
          </div>
        </section>
      </main>

      {selected && (
        <DetailsDialog
          key={`${selected.kind}:${selected.id}`}
          kind={model.sections.connectors.includes(selected.id) ? 'connector' : selected.kind}
          id={selected.id}
          component={selectedComponent}
          initialConfig={getComponentConfig(yamlText, resolveSection(selected), selected.id)}
          onApply={(config) => setYamlText((prev) => setComponentConfig(prev, resolveSection(selected), selected.id, config))}
          onRemove={() => {
            setYamlText((prev) => removeComponent(prev, resolveSection(selected), selected.id))
            setSelected(null)
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {dialog && version && (
        <AddComponentDialog
          initialKind={dialog.kind}
          initialPipeline={dialog.pipeline}
          version={version}
          components={components}
          model={model}
          onAdd={handleAdd}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

function StatusBadge({ state, errors }: { state: ValState; errors: number }) {
  switch (state) {
    case 'valid':
      return (
        <span className="pill pill--ok">
          <span className="dot" />
          Valid
        </span>
      )
    case 'invalid':
      return (
        <span className="pill pill--err">
          <span className="dot" />
          {errors} error{errors === 1 ? '' : 's'}
        </span>
      )
    case 'offline':
      return (
        <span className="pill pill--warn">
          <span className="dot" />
          API offline
        </span>
      )
    default:
      return (
        <span className="pill pill--outline">
          <span className="dot" />
          Validating
        </span>
      )
  }
}

/**
 * The Block-S mark. Construction is exact per the design guidelines:
 * 64×64 viewBox, one open stroke path, stroke-width 9, miter joins,
 * square caps, currentColor.
 */
function BlockS({ size = 24 }: { size?: number }) {
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
