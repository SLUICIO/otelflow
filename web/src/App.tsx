import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchComponents, fetchMeta, validateConfig } from './api'
import { parseConfigModel } from './lib/parse'
import {
  addComponent,
  addPipeline,
  getComponentConfig,
  removeComponent,
  removeFromPipeline,
  setComponentConfig,
} from './lib/mutate'
import { AddPipelineDialog } from './components/AddPipelineDialog'
import { ConfigViewer, Editor } from './components/Editor'
import { FlowGraph, computeLayout, type Selection } from './components/FlowGraph'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { AddComponentDialog } from './components/AddComponentDialog'
import { DetailsDialog } from './components/DetailsDialog'
import { ShareDialog } from './components/ShareDialog'
import { copyText } from './lib/clipboard'
import { decodeShare, parseShareHash } from './lib/share'
import { SAMPLE_CONFIG } from './sample'
import type { Component, Diagnostic, Kind, Meta } from './types'
import { KIND_TO_SECTION, componentType } from './types'

// Parsed once at module load, before any state initializes: a #share= or
// #embed= fragment carries a full configuration in the URL itself.
const shareHash = parseShareHash()

const LS_YAML = 'sluicio.otelcol.yaml'
const LS_VERSION = 'sluicio.otelcol.version'
const LS_DISTRO = 'sluicio.otelcol.distro'
const LS_THEME = 'sluicio.theme'
const LS_EDITOR_WIDTH = 'sluicio.editorWidth'
const LS_EDITOR_HIDDEN = 'sluicio.editorHidden'

const EDITOR_MIN_W = 300
const GRAPH_MIN_W = 460

type ValState = 'pending' | 'valid' | 'invalid' | 'offline'
type ThemePref = 'auto' | 'light' | 'dark'

function useTheme(forced?: 'light' | 'dark'): [ThemePref, (t: ThemePref) => void, boolean] {
  const [pref, setPref] = useState<ThemePref>(
    () => (localStorage.getItem(LS_THEME) as ThemePref) || 'auto',
  )
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  useEffect(() => {
    // Embeds may pin a theme via the URL; no persistence, no OS tracking.
    if (forced) {
      document.documentElement.dataset.theme = forced
      setDark(forced === 'dark')
      return
    }
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
  }, [pref, forced])
  return [pref, setPref, dark]
}

export default function App() {
  const embed = shareHash?.mode === 'embed'
  const [meta, setMeta] = useState<Meta | null>(null)
  const [version, setVersion] = useState<string>('')
  // Distribution is a local view setting; embeds validate against contrib
  // (the superset) since the share payload carries no distribution.
  const [distro, setDistro] = useState<string>(() =>
    embed ? 'contrib' : (localStorage.getItem(LS_DISTRO) ?? 'contrib'),
  )
  const [components, setComponents] = useState<Component[]>([])
  const [yamlText, setYamlText] = useState<string>(() =>
    shareHash ? '' : (localStorage.getItem(LS_YAML) ?? SAMPLE_CONFIG),
  )
  const [shareOpen, setShareOpen] = useState(false)
  const sharedVersionRef = useRef<string>('')
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [valState, setValState] = useState<ValState>('pending')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [dialog, setDialog] = useState<{ kind: Kind; pipeline?: string } | null>(null)
  const [pipelineDialog, setPipelineDialog] = useState(false)
  const [jumpLine, setJumpLine] = useState<number | null>(null)
  const [themePref, setThemePref, isDark] = useTheme(embed ? shareHash?.theme : undefined)

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

  // Load a shared configuration from the URL fragment, if present.
  useEffect(() => {
    if (!shareHash) return
    decodeShare(shareHash.payload).then((cfg) => {
      if (!cfg) {
        setYamlText(localStorage.getItem(LS_YAML) ?? SAMPLE_CONFIG)
        return
      }
      sharedVersionRef.current = cfg.version
      setYamlText(cfg.yaml)
      if (cfg.version) setVersion(cfg.version)
      // Clear the fragment in the full app so later edits don't sit under a
      // stale share URL. The embed keeps it — it is the whole page state.
      if (shareHash.mode === 'share') {
        history.replaceState(null, '', window.location.pathname)
      }
    })
  }, [])

  // A share link opened in an already-running tab only changes the hash —
  // the browser does not reload. Apply the new fragment live.
  useEffect(() => {
    const onHashChange = () => {
      const h = parseShareHash()
      if (!h) return
      // Switching between app and embed presentation — or between embed
      // views — needs a full reinit.
      if ((h.mode === 'embed') !== embed || embed) {
        window.location.reload()
        return
      }
      decodeShare(h.payload).then((cfg) => {
        if (!cfg) return
        setYamlText(cfg.yaml)
        if (cfg.version) setVersion(cfg.version)
        if (h.mode === 'share') {
          history.replaceState(null, '', window.location.pathname)
        }
      })
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [embed])

  // Bootstrap: versions + default
  useEffect(() => {
    fetchMeta()
      .then((m) => {
        setMeta(m)
        const shared = sharedVersionRef.current
        const saved = shareHash ? '' : localStorage.getItem(LS_VERSION)
        setVersion(
          shared && m.versions.includes(shared)
            ? shared
            : saved && m.versions.includes(saved)
              ? saved
              : m.defaultVersion,
        )
      })
      .catch(() => setValState('offline'))
  }, [])

  // Component catalog per version
  useEffect(() => {
    if (!version) return
    if (!embed) localStorage.setItem(LS_VERSION, version)
    fetchComponents(version).then(setComponents).catch(() => setValState('offline'))
  }, [version, embed])

  useEffect(() => {
    if (!embed) localStorage.setItem(LS_DISTRO, distro)
  }, [distro, embed])

  // Debounced real-time validation
  const validateSeq = useRef(0)
  useEffect(() => {
    if (!version) return
    if (!embed) localStorage.setItem(LS_YAML, yamlText)
    setValState('pending')
    const seq = ++validateSeq.current
    const t = setTimeout(() => {
      validateConfig(yamlText, version, distro)
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
  }, [yamlText, version, distro])

  const model = useMemo(() => parseConfigModel(yamlText), [yamlText])

  const componentIndex = useMemo(() => {
    const m = new Map<string, Component>()
    for (const c of components) m.set(`${c.kind}:${c.type}`, c)
    return m
  }, [components])

  // The catalog offers only components of the selected distribution; the
  // graph and wizard keep the full index so existing config entries are
  // still recognized (the validator flags distribution mismatches).
  const catalogComponents = useMemo(
    () => components.filter((c) => !c.distributions || c.distributions.includes(distro)),
    [components, distro],
  )

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

  // Natural canvas height for the embed "both" view: the canvas keeps its
  // content size and the configuration takes the remaining space.
  const embedCanvasH = useMemo(
    () => (embed ? computeLayout(model, true).totalH : 0),
    [embed, model],
  )

  // Embed mode: just the read-only canvas plus a slim bar linking back to
  // the full, editable configuration.
  if (embed) {
    const openUrl = `${window.location.origin}${window.location.pathname}#share=${shareHash!.payload}`
    const view = shareHash!.view
    return (
      <div className="app embed">
        {view !== 'config' && (
          <div
            className="graph-scroll"
            style={view === 'both' ? { flex: `0 1 ${embedCanvasH}px` } : { flex: '1 1 0' }}
          >
            <FlowGraph
              model={model}
              componentIndex={componentIndex}
              diagnostics={diagnostics}
              selected={null}
              onSelect={() => {}}
              onAdd={() => {}}
              onAddPipeline={() => {}}
              readOnly
            />
          </div>
        )}
        {view !== 'canvas' && (
          <div className="embed-config" style={{ flex: view === 'both' ? '1 1 120px' : '1 1 0' }}>
            <ConfigViewer value={yamlText} dark={isDark} />
          </div>
        )}
        <div className="embed-bar">
          <span className="brand" style={{ gap: 7 }}>
            <BlockS size={16} />
            <span className="brand-name" style={{ fontSize: 13 }}>OTelFlow</span>
          </span>
          {version && <span className="pill pill--outline">collector v{version}</span>}
          <StatusBadge state={valState} errors={errors} />
          <VersionLink />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <CopyConfigButton text={yamlText} />
            <a className="btn btn--link" href={openUrl} target="_blank" rel="noreferrer">
              Open configuration →
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <BlockS size={24} />
          <span className="brand-name">OTelFlow</span>
          <a className="brand-sub" href="https://sluicio.com" target="_blank" rel="noreferrer">
            by Sluicio
          </a>
        </div>
        <VersionLink />
        <div className="header-spacer" />
        <button className="btn btn--link" onClick={() => setShareOpen(true)}>
          Share
        </button>
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
          <select
            value={distro}
            onChange={(e) => setDistro(e.target.value)}
            disabled={!meta}
            aria-label="Distribution"
          >
            {(meta?.distributions ?? [distro]).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!meta} aria-label="Version">
            {(meta?.versions ?? [version]).map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>
        <StatusBadge state={valState} errors={errors} />
        <a
          className="btn btn--link btn--icon"
          href="https://github.com/SLUICIO/otelflow"
          target="_blank"
          rel="noreferrer"
          aria-label="OTelFlow on GitHub"
          title="OTelFlow on GitHub"
        >
          <GitHubMark />
        </a>
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
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setPipelineDialog(true)}>
                + Add pipeline
              </button>
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
              onAddPipeline={() => setPipelineDialog(true)}
            />
          </div>
        </section>
      </main>

      {selected && (
        <DetailsDialog
          key={`${selected.kind}:${selected.id}:${selected.pipeline ?? ''}`}
          kind={model.sections.connectors.includes(selected.id) ? 'connector' : selected.kind}
          id={selected.id}
          pipeline={selected.pipeline}
          component={selectedComponent}
          initialConfig={getComponentConfig(yamlText, resolveSection(selected), selected.id)}
          onApply={(config) => setYamlText((prev) => setComponentConfig(prev, resolveSection(selected), selected.id, config))}
          onRemove={() => {
            const sel = selected
            const section = resolveSection(sel)
            if (sel.pipeline && sel.role) {
              // Scoped removal: only this pipeline's reference goes.
              const usagesLeft = countUsages(model, sel.id) - 1
              setYamlText((prev) => removeFromPipeline(prev, sel.pipeline!, sel.role!, sel.id))
              if (
                usagesLeft <= 0 &&
                window.confirm(
                  `'${sel.id}' is no longer used by any pipeline. Also remove its definition from the ${section} section? Its configuration will be deleted.`,
                )
              ) {
                setYamlText((prev) => removeComponent(prev, section, sel.id))
              }
            } else {
              // Extensions (and anything without pipeline context):
              // remove the definition and every reference.
              setYamlText((prev) => removeComponent(prev, section, sel.id))
            }
            setSelected(null)
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {shareOpen && (
        <ShareDialog yaml={yamlText} version={version} onClose={() => setShareOpen(false)} />
      )}

      {pipelineDialog && (
        <AddPipelineDialog
          model={model}
          componentIndex={componentIndex}
          onCreate={(id, lists) => setYamlText((prev) => addPipeline(prev, id, lists))}
          onClose={() => setPipelineDialog(false)}
        />
      )}

      {dialog && version && (
        <AddComponentDialog
          initialKind={dialog.kind}
          initialPipeline={dialog.pipeline}
          version={version}
          distro={distro}
          components={catalogComponents}
          model={model}
          onAdd={handleAdd}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

/** How many times a component ID is referenced across all pipelines and
 * service.extensions. */
function countUsages(model: ReturnType<typeof parseConfigModel>, id: string): number {
  let n = 0
  for (const p of model.pipelines) {
    for (const role of ['receivers', 'processors', 'exporters'] as const) {
      n += p[role].filter((x) => x === id).length
    }
  }
  n += model.serviceExtensions.filter((x) => x === id).length
  return n
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
          Validator unavailable
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

/** Copies the embedded configuration; honest about failure. */
function CopyConfigButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <button
      className="btn btn--link"
      onClick={async () => {
        const ok = await copyText(text)
        setState(ok ? 'copied' : 'failed')
        setTimeout(() => setState('idle'), 2000)
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy config'}
    </button>
  )
}

/** The GitHub mark, drawn in currentColor. */
function GitHubMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** App version, injected at build time; links to the GitHub releases. */
function VersionLink() {
  return (
    <a
      className="app-version mono"
      href="https://github.com/SLUICIO/otelflow/releases"
      target="_blank"
      rel="noreferrer"
      title={`OTelFlow v${__APP_VERSION__} · ${__GIT_SHA__}`}
    >
      v{__APP_VERSION__}
    </a>
  )
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
