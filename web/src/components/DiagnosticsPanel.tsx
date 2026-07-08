import { useState } from 'react'
import type { Diagnostic } from '../types'

interface Props {
  diagnostics: Diagnostic[]
  onJump: (line: number) => void
}

const ICON = { error: '●', warning: '▲', info: 'ℹ' } as const

export function DiagnosticsPanel({ diagnostics, onJump }: Props) {
  const [open, setOpen] = useState(true)
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length

  return (
    <div className="diagnostics">
      <div className="diagnostics-header" onClick={() => setOpen(!open)}>
        <span className="pane-title">Problems</span>
        <span className={`diag-count errors ${errors ? '' : 'zero'}`}>● {errors}</span>
        <span className={`diag-count warnings ${warnings ? '' : 'zero'}`}>▲ {warnings}</span>
        <span style={{ marginLeft: 'auto' }} className="muted small">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="diagnostics-list">
          {diagnostics.length === 0 && (
            <div className="diag-row diag-info">
              <span className="diag-icon" style={{ color: 'var(--ok)' }}>✓</span>
              <span className="diag-msg muted">No problems — the configuration is valid.</span>
            </div>
          )}
          {diagnostics.map((d, i) => (
            <div key={i} className={`diag-row diag-${d.severity}`} onClick={() => d.line && onJump(d.line)}>
              <span className="diag-icon">{ICON[d.severity]}</span>
              <span className="diag-line">{d.line ? `:${d.line}` : ''}</span>
              <span className="diag-msg">
                {d.message}
                {d.hint ? <span className="diag-hint"> {d.hint}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
