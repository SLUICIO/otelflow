import { useState } from 'react'
import type { Component, Kind } from '../types'
import { SchemaForm } from './SchemaForm'

interface Props {
  kind: Kind
  id: string
  component: Component | undefined
  initialConfig: unknown
  onApply: (config: unknown) => void
  onRemove: () => void
  onClose: () => void
}

/**
 * Detail/edit dialog for an existing component. Same modal presentation as
 * the add-component dialog so both node interactions behave alike.
 */
export function DetailsDialog({ kind, id, component, initialConfig, onApply, onRemove, onClose }: Props) {
  const [config, setConfig] = useState<Record<string, unknown>>(
    initialConfig && typeof initialConfig === 'object' && !Array.isArray(initialConfig)
      ? (initialConfig as Record<string, unknown>)
      : {},
  )
  const [dirty, setDirty] = useState(false)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="mono">{id}</h2>
          <span className="pill pill--outline">{kind}</span>
          <div style={{ flex: 1 }} />
          <button className="btn btn--link" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {component ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p className="dialog-desc">{component.description}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {kind === 'connector'
                  ? (component.connects ?? []).map((cn, i) => (
                      <span key={i} className="pill pill--info">{cn.from} → {cn.to}</span>
                    ))
                  : (component.signals ?? []).map((s) => (
                      <span key={s} className={`pill pill--${s}`}>{s}</span>
                    ))}
                <span className="pill pill--outline">since v{component.added}</span>
                <span className="pill pill--outline">{component.stability}</span>
                {component.isDeprecated && (
                  <span className="pill pill--warn">deprecated since v{component.deprecated}</span>
                )}
                {!component.available && (
                  <span className="pill pill--err">
                    {component.removed ? `removed in v${component.removed}` : `added in v${component.added}`}
                  </span>
                )}
              </div>
              <fieldset className="form-fieldset">
                <legend>Configuration</legend>
                <SchemaForm
                  schema={component.schema ?? {}}
                  value={config}
                  onChange={(v) => {
                    setConfig(v)
                    setDirty(true)
                  }}
                />
              </fieldset>
            </div>
          ) : (
            <p className="dialog-desc">
              Unknown component type — not in the curated registry for this collector version. You can
              still edit its configuration directly in the YAML editor.
            </p>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button className="btn btn--danger" onClick={onRemove}>Remove</button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            {component && (
              <button
                className="btn btn--primary"
                disabled={!dirty}
                onClick={() => {
                  onApply(config)
                  onClose()
                }}
              >
                Apply changes
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
