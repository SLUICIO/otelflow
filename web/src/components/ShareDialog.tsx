import { useEffect, useState } from 'react'
import { encodeShare } from '../lib/share'

interface Props {
  yaml: string
  version: string
  onClose: () => void
}

/**
 * Generates a share link and an embeddable iframe snippet. The configuration
 * travels inside the URL fragment — nothing is stored on any server.
 */
export function ShareDialog({ yaml, version, onClose }: Props) {
  const [link, setLink] = useState('')

  useEffect(() => {
    encodeShare({ yaml, version }).then((payload) => {
      setLink(`${window.location.origin}${window.location.pathname}#share=${payload}`)
    })
  }, [yaml, version])

  const embedSrc = link.replace('#share=', '#embed=')
  const iframeCode = link
    ? `<iframe src="${embedSrc}" width="100%" height="480" style="border:1px solid #E5E7EB;border-radius:12px" title="OTelFlow — OpenTelemetry Collector pipeline"></iframe>`
    : ''

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Share configuration</h2>
          <div style={{ flex: 1 }} />
          <button className="btn btn--link" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p className="dialog-desc">
            The entire configuration is encoded in the link itself — nothing is stored on a server.
            Check the YAML for secrets before sharing: tokens travel with the link.
          </p>

          <CopyRow
            label="Link"
            hint="Opens the configuration in the full editor."
            value={link}
          />
          <CopyRow
            label="Embed"
            hint="Read-only pipeline canvas for other pages, with a link back to this configuration."
            value={iframeCode}
            multiline
          />
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function CopyRow({
  label,
  hint,
  value,
  multiline,
}: {
  label: string
  hint: string
  value: string
  multiline?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div className="form-field">
      <label className="form-label">
        <span>{label}</span>
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {multiline ? (
          <textarea className="yaml-textarea" style={{ minHeight: 64 }} readOnly value={value} onFocus={(e) => e.target.select()} />
        ) : (
          <input className="text-input mono" readOnly value={value} onFocus={(e) => e.target.select()} />
        )}
        <button className="btn btn--primary" style={{ flexShrink: 0 }} disabled={!value} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="form-desc">{hint}</div>
    </div>
  )
}
