import { useMemo, useState } from 'react'
import type { Component, ConfigModel, Kind, Signal } from '../types'
import { SchemaForm } from './SchemaForm'

const KINDS: Kind[] = ['receiver', 'processor', 'exporter', 'connector', 'extension']

/**
 * Presets are shortcuts, not component types: picking one opens the real
 * underlying component's form pre-filled, and writes plain collector YAML.
 */
interface Preset {
  label: string
  kind: Kind
  type: string // real component type this resolves to
  suffix: string // instance name, e.g. otlphttp/sluicio
  signals: string[]
  description: string
  config: Record<string, unknown>
}

const PRESETS: Preset[] = [
  {
    label: 'sluicio',
    kind: 'exporter',
    type: 'otlphttp',
    suffix: 'sluicio',
    signals: ['traces', 'metrics', 'logs'],
    description:
      'Send telemetry to Sluicio: an otlphttp exporter pre-configured with the Sluicio ingest endpoint and bearer-token authentication.',
    config: {
      endpoint: 'https://ingest.sluicio.com',
      headers: { Authorization: 'Bearer ${env:SLUICIO_TOKEN}' },
      compression: 'gzip',
    },
  },
]

interface AddOpts {
  pipelines: string[]
  recvPipelines?: string[]
  enableExtension?: boolean
}

interface Props {
  initialKind: Kind
  initialPipeline?: string
  version: string
  components: Component[]
  model: ConfigModel
  onAdd: (kind: Kind, id: string, config: unknown, opts: AddOpts) => void
  onClose: () => void
}

export function AddComponentDialog({ initialKind, initialPipeline, version, components, model, onAdd, onClose }: Props) {
  const [kind, setKind] = useState<Kind>(initialKind)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Component | null>(null)
  const [suffix, setSuffix] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [pipelines, setPipelines] = useState<string[]>(initialPipeline ? [initialPipeline] : [])
  const [recvPipelines, setRecvPipelines] = useState<string[]>([])
  const [enableExt, setEnableExt] = useState(true)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return components
      .filter((c) => c.kind === kind)
      .filter((c) => !q || c.type.includes(q) || c.description.toLowerCase().includes(q))
      .sort((a, b) => Number(b.available) - Number(a.available) || a.type.localeCompare(b.type))
  }, [components, kind, query])

  const pickPreset = (p: Preset) => {
    const base = components.find((c) => c.kind === p.kind && c.type === p.type && c.available)
    if (!base) return
    pick(base)
    setSuffix(p.suffix)
    setConfig(p.config)
  }

  const pick = (c: Component) => {
    if (!c.available) return
    setPicked(c)
    setConfig({})
    setSuffix('')
    if (c.kind === 'receiver' || c.kind === 'exporter' || c.kind === 'processor') {
      const compatible = compatiblePipelines(c, model)
      setPipelines(initialPipeline && compatible.includes(initialPipeline) ? [initialPipeline] : compatible.slice(0, 1))
    } else if (c.kind === 'connector') {
      const from = connectorPipelines(c, model, 'from')
      const to = connectorPipelines(c, model, 'to')
      setPipelines(initialPipeline && from.includes(initialPipeline) ? [initialPipeline] : from.slice(0, 1))
      setRecvPipelines(to.slice(0, 1))
    }
  }

  const id = picked ? picked.type + (suffix.trim() ? '/' + suffix.trim() : '') : ''
  const idTaken = picked ? model.sections[sectionOf(picked.kind)].includes(id) : false

  const submit = () => {
    if (!picked || idTaken) return
    if (picked.kind === 'connector') {
      onAdd('connector', id, config, { pipelines, recvPipelines })
    } else {
      onAdd(picked.kind, id, config, { pipelines, enableExtension: picked.kind === 'extension' && enableExt })
    }
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{picked ? `Configure ${picked.type}` : 'Add component'}</h2>
          <span className="muted small mono">collector v{version}</span>
          <div className="header-spacer" style={{ flex: 1 }} />
          <button className="btn btn--link" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!picked ? (
          <div className="modal-body">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div className="tabs">
                {KINDS.map((k) => (
                  <button key={k} className={`tab ${k === kind ? 'active' : ''}`} onClick={() => setKind(k)}>
                    {k}s
                  </button>
                ))}
              </div>
              <input
                className="search-input"
                style={{ maxWidth: 260, marginLeft: 'auto' }}
                placeholder={`Search ${kind}s…`}
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="catalog-grid">
              {PRESETS.filter(
                (p) =>
                  p.kind === kind &&
                  (!query.trim() ||
                    p.label.includes(query.trim().toLowerCase()) ||
                    p.description.toLowerCase().includes(query.trim().toLowerCase())),
              ).map((p) => (
                <div key={`preset-${p.label}`} className="catalog-card catalog-card--preset" onClick={() => pickPreset(p)}>
                  <div className="catalog-card-head">
                    <span className="catalog-card-name">{p.label}</span>
                    <span className="pill pill--primary">preset</span>
                  </div>
                  <div className="catalog-card-desc">{p.description}</div>
                  <div className="catalog-card-meta">
                    {p.signals.map((s) => (
                      <span key={s} className={`pill pill--${s}`}>{s}</span>
                    ))}
                    <span className="pill pill--outline">{p.type}/{p.suffix}</span>
                  </div>
                </div>
              ))}
              {list.map((c) => (
                <div
                  key={c.kind + c.type}
                  className={`catalog-card ${c.available ? '' : 'unavailable'}`}
                  onClick={() => pick(c)}
                  title={c.available ? '' : availabilityNote(c, version)}
                >
                  <div className="catalog-card-head">
                    <span className="catalog-card-name">{c.type}</span>
                  </div>
                  <div className="catalog-card-desc">{c.description}</div>
                  <div className="catalog-card-meta">
                    {c.kind === 'connector'
                      ? (c.connects ?? []).map((cn, i) => (
                          <span key={i} className="pill pill--info">{cn.from} → {cn.to}</span>
                        ))
                      : (c.signals ?? []).map((s) => (
                          <span key={s} className={`pill pill--${s}`}>{s}</span>
                        ))}
                    <span className="pill pill--outline">since v{c.added}</span>
                    {c.isDeprecated && <span className="pill pill--warn">deprecated</span>}
                    {!c.available && <span className="pill pill--err">{availabilityNote(c, version)}</span>}
                    {c.docsUrl && (
                      <a
                        className="docs-link"
                        href={c.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        docs ↗
                      </a>
                    )}
                  </div>
                </div>
              ))}
              {list.length === 0 && <p className="muted">No {kind}s match “{query}”.</p>}
            </div>
          </div>
        ) : (
          <div className="modal-body">
            <p className="dialog-desc" style={{ marginBottom: 14 }}>
              {picked.description}{' '}
              {picked.docsUrl && (
                <a className="docs-link" href={picked.docsUrl} target="_blank" rel="noreferrer">
                  Documentation ↗
                </a>
              )}
            </p>

            <div className="form-field" style={{ marginBottom: 14 }}>
              <label className="form-label">
                <span>Instance name</span>
                <span className="muted small">optional — lets you define the same type twice</span>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono muted">{picked.type}/</span>
                <input
                  className="text-input mono"
                  style={{ maxWidth: 200 }}
                  value={suffix}
                  placeholder="e.g. internal"
                  onChange={(e) => setSuffix(e.target.value)}
                />
              </div>
              {idTaken && (
                <div className="form-desc" style={{ color: 'var(--err)' }}>
                  '{id}' is already defined — pick a different instance name.
                </div>
              )}
            </div>

            {picked.kind !== 'extension' && picked.kind !== 'connector' && (
              <PipelinePicker
                label={`Attach to pipelines (as ${picked.kind})`}
                options={compatiblePipelines(picked, model)}
                selected={pipelines}
                onChange={setPipelines}
              />
            )}
            {picked.kind === 'connector' && (
              <>
                <PipelinePicker
                  label="Consumes from pipelines (listed as exporter)"
                  options={connectorPipelines(picked, model, 'from')}
                  selected={pipelines}
                  onChange={setPipelines}
                />
                <PipelinePicker
                  label="Emits into pipelines (listed as receiver)"
                  options={connectorPipelines(picked, model, 'to')}
                  selected={recvPipelines}
                  onChange={setRecvPipelines}
                />
              </>
            )}
            {picked.kind === 'extension' && (
              <div className="checkbox-row" style={{ marginBottom: 14 }}>
                <input type="checkbox" checked={enableExt} onChange={(e) => setEnableExt(e.target.checked)} />
                <span>Enable in service.extensions</span>
              </div>
            )}

            <fieldset className="form-fieldset">
              <legend>Configuration</legend>
              <SchemaForm schema={picked.schema ?? {}} value={config} onChange={setConfig} />
            </fieldset>
          </div>
        )}

        <div className="modal-footer">
          {picked && (
            <button className="btn" onClick={() => setPicked(null)} style={{ marginRight: 'auto' }}>
              ← Back to catalog
            </button>
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
          {picked && (
            <button className="btn btn--primary" onClick={submit} disabled={idTaken}>
              Add {id}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PipelinePicker({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (v: string[]) => void
}) {
  return (
    <div className="form-field" style={{ marginBottom: 14 }}>
      <label className="form-label">{label}</label>
      {options.length === 0 ? (
        <div className="form-desc">No compatible pipelines in this config.</div>
      ) : (
        <div className="pipeline-pick">
          {options.map((p) => (
            <label key={p}>
              <input
                type="checkbox"
                checked={selected.includes(p)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, p] : selected.filter((x) => x !== p))
                }
              />
              {p}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function compatiblePipelines(c: Component, model: ConfigModel): string[] {
  return model.pipelines.filter((p) => p.signal !== 'unknown' && c.signals?.includes(p.signal as Signal)).map((p) => p.id)
}

function connectorPipelines(c: Component, model: ConfigModel, dir: 'from' | 'to'): string[] {
  return model.pipelines
    .filter((p) => p.signal !== 'unknown' && (c.connects ?? []).some((cn) => cn[dir] === p.signal))
    .map((p) => p.id)
}

function sectionOf(kind: Kind) {
  return (kind + 's') as keyof ConfigModel['sections']
}

function availabilityNote(c: Component, version: string): string {
  if (c.removed && cmp(version, c.removed) >= 0) return `removed in v${c.removed}`
  return `added in v${c.added}`
}

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

