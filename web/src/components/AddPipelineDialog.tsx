import { useMemo, useState } from 'react'
import type { Component, ConfigModel, Signal } from '../types'
import { componentType } from '../types'

/**
 * Guided pipeline creation: pick the telemetry signal, then step through the
 * components already defined in the config — the wizard shows which of them
 * can speak that signal, and why the rest cannot. The result is written into
 * service.pipelines.
 */

const SIGNALS: { signal: Signal; title: string; blurb: string }[] = [
  { signal: 'traces', title: 'Traces', blurb: 'Spans describing requests as they travel through services.' },
  { signal: 'metrics', title: 'Metrics', blurb: 'Numeric measurements over time: counters, gauges, histograms.' },
  { signal: 'logs', title: 'Logs', blurb: 'Log records collected from files, agents or the OTLP protocol.' },
]

const STEPS = ['Signal', 'Receivers', 'Processors', 'Exporters'] as const

interface Candidate {
  id: string
  status: 'ok' | 'incompatible' | 'unknown'
  isConnector: boolean
  supports: string[] // signals (or connector routes) it does support, for the reason text
}

interface Props {
  model: ConfigModel
  componentIndex: Map<string, Component>
  onCreate: (id: string, lists: { receivers: string[]; processors: string[]; exporters: string[] }) => void
  onClose: () => void
}

export function AddPipelineDialog({ model, componentIndex, onCreate, onClose }: Props) {
  const [step, setStep] = useState(0)
  const [signal, setSignal] = useState<Signal | null>(null)
  const [suffix, setSuffix] = useState('')
  const [receivers, setReceivers] = useState<string[]>([])
  const [processors, setProcessors] = useState<string[]>([])
  const [exporters, setExporters] = useState<string[]>([])

  const id = signal ? signal + (suffix.trim() ? '/' + suffix.trim() : '') : ''
  const idTaken = model.pipelines.some((p) => p.id === id)

  const candidates = useMemo(() => {
    if (!signal) return { receivers: [], processors: [], exporters: [] }
    const classify = (
      ids: string[],
      kind: 'receiver' | 'processor' | 'exporter',
    ): Candidate[] =>
      ids.map((cid) => {
        const comp = componentIndex.get(`${kind}:${componentType(cid)}`)
        if (!comp) return { id: cid, status: 'unknown', isConnector: false, supports: [] }
        const ok = comp.signals?.includes(signal) ?? false
        return { id: cid, status: ok ? 'ok' : 'incompatible', isConnector: false, supports: comp.signals ?? [] }
      })
    const connectors = (dir: 'from' | 'to'): Candidate[] =>
      model.sections.connectors.map((cid) => {
        const comp = componentIndex.get(`connector:${componentType(cid)}`)
        if (!comp) return { id: cid, status: 'unknown', isConnector: true, supports: [] }
        const routes = comp.connects ?? []
        const ok = routes.some((r) => r[dir] === signal)
        return {
          id: cid,
          status: ok ? 'ok' : 'incompatible',
          isConnector: true,
          supports: routes.map((r) => `${r.from} → ${r.to}`),
        }
      })
    return {
      // Connectors can feed a pipeline (their output side) …
      receivers: [...classify(model.sections.receivers, 'receiver'), ...connectors('to')],
      processors: classify(model.sections.processors, 'processor'),
      // … or consume from one (their input side).
      exporters: [...classify(model.sections.exporters, 'exporter'), ...connectors('from')],
    }
  }, [signal, model, componentIndex])

  const toggle = (list: string[], set: (v: string[]) => void, cid: string) =>
    set(list.includes(cid) ? list.filter((x) => x !== cid) : [...list, cid])

  const create = () => {
    if (!signal || idTaken) return
    onCreate(id, { receivers, processors, exporters })
    onClose()
  }

  const nextDisabled = step === 0 && (!signal || idTaken)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add pipeline</h2>
          {id && <span className="pill pill--outline">{id}</span>}
          <div style={{ flex: 1 }} />
          <button className="btn btn--link" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="stepper">
          {STEPS.map((s, i) => (
            <span key={s} className={`step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
              <span className="step-num">{i + 1}</span> {s}
            </span>
          ))}
        </div>

        <div className="modal-body">
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p className="dialog-desc">What kind of telemetry should this pipeline carry?</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {SIGNALS.map((s) => (
                  <div
                    key={s.signal}
                    className={`catalog-card signal-card ${s.signal} ${signal === s.signal ? 'selected' : ''}`}
                    onClick={() => setSignal(s.signal)}
                  >
                    <span className={`pill pill--${s.signal}`}>{s.title}</span>
                    <div className="catalog-card-desc">{s.blurb}</div>
                  </div>
                ))}
              </div>
              <div className="form-field">
                <label className="form-label">
                  <span>Pipeline name</span>
                  <span className="muted small">optional — allows several pipelines per signal</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="mono muted">{signal ?? '<signal>'}/</span>
                  <input
                    className="text-input mono"
                    style={{ maxWidth: 220 }}
                    value={suffix}
                    placeholder="e.g. backend"
                    onChange={(e) => setSuffix(e.target.value)}
                  />
                </div>
                {idTaken && (
                  <div className="form-desc" style={{ color: 'var(--err)' }}>
                    Pipeline '{id}' already exists — pick a different name.
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 1 && signal && (
            <PickStep
              intro={`Which of these should feed ${signal} into the pipeline? Connectors bridge data over from another pipeline.`}
              signal={signal}
              candidates={candidates.receivers}
              selected={receivers}
              onToggle={(cid) => toggle(receivers, setReceivers, cid)}
              emptyNote="No receivers are defined yet. You can create the pipeline anyway and add one via the + Receiver zone, or close this and use + Add component first."
              noneSelectedNote="No receivers selected — the pipeline will show an error until one is added."
            />
          )}

          {step === 2 && signal && (
            <PickStep
              intro={`Processors transform ${signal} on the way through, in the order you select them. memory_limiter first and batch last is the usual pattern.`}
              signal={signal}
              candidates={candidates.processors}
              selected={processors}
              onToggle={(cid) => toggle(processors, setProcessors, cid)}
              emptyNote="No processors are defined. That's fine — pipelines work without them."
              orderPreview
            />
          )}

          {step === 3 && signal && (
            <PickStep
              intro={`Where should the ${signal} go? Connectors hand the data on to another pipeline.`}
              signal={signal}
              candidates={candidates.exporters}
              selected={exporters}
              onToggle={(cid) => toggle(exporters, setExporters, cid)}
              emptyNote="No exporters are defined yet. You can create the pipeline anyway and add one via the + Exporter zone."
              noneSelectedNote="No exporters selected — the pipeline will show an error until one is added."
            />
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div>
            {step > 0 && (
              <button className="btn" onClick={() => setStep(step - 1)}>← Back</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            {step < STEPS.length - 1 ? (
              <button className="btn btn--primary" disabled={nextDisabled} onClick={() => setStep(step + 1)}>
                Next
              </button>
            ) : (
              <button className="btn btn--primary" onClick={create}>
                Create {id}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PickStep({
  intro,
  signal,
  candidates,
  selected,
  onToggle,
  emptyNote,
  noneSelectedNote,
  orderPreview,
}: {
  intro: string
  signal: Signal
  candidates: Candidate[]
  selected: string[]
  onToggle: (id: string) => void
  emptyNote: string
  noneSelectedNote?: string
  orderPreview?: boolean
}) {
  const ok = candidates.filter((c) => c.status === 'ok')
  const unknown = candidates.filter((c) => c.status === 'unknown')
  const incompatible = candidates.filter((c) => c.status === 'incompatible')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="dialog-desc">{intro}</p>

      {candidates.length === 0 && <p className="dialog-desc">{emptyNote}</p>}

      {ok.map((c) => (
        <PickRow key={c.id} c={c} checked={selected.includes(c.id)} onToggle={() => onToggle(c.id)} />
      ))}
      {unknown.map((c) => (
        <PickRow
          key={c.id}
          c={c}
          checked={selected.includes(c.id)}
          onToggle={() => onToggle(c.id)}
          note="unknown type — compatibility can't be checked"
        />
      ))}

      {incompatible.length > 0 && (
        <>
          <div className="pane-title" style={{ marginTop: 4 }}>Not compatible with {signal}</div>
          {incompatible.map((c) => (
            <PickRow
              key={c.id}
              c={c}
              checked={false}
              disabled
              note={c.supports.length ? `speaks ${c.supports.join(', ')}` : 'supports no known signals'}
            />
          ))}
        </>
      )}

      {orderPreview && selected.length > 0 && (
        <div className="dialog-desc">
          Order: {selected.map((s, i) => `${i + 1}. ${s}`).join('  →  ')}
        </div>
      )}
      {noneSelectedNote && candidates.some((c) => c.status !== 'incompatible') && selected.length === 0 && (
        <div className="form-desc" style={{ color: 'var(--warn-ink)' }}>{noneSelectedNote}</div>
      )}
    </div>
  )
}

function PickRow({
  c,
  checked,
  onToggle,
  disabled,
  note,
}: {
  c: Candidate
  checked: boolean
  onToggle?: () => void
  disabled?: boolean
  note?: string
}) {
  return (
    <label className={`pick-row ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="mono">{c.id}</span>
      {c.isConnector && <span className="pill pill--primary">connector</span>}
      {note && <span className="muted small" style={{ marginLeft: 'auto' }}>{note}</span>}
    </label>
  )
}
