import { useEffect, useRef, useState } from 'react'
import { encodeShare } from '../lib/share'

/**
 * Copies text to the clipboard, falling back to the legacy execCommand path
 * when the async Clipboard API is unavailable (non-secure contexts) or
 * rejects. Returns whether the copy actually succeeded.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

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
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  const copy = async () => {
    const ok = await copyText(value)
    setState(ok ? 'copied' : 'failed')
    if (!ok) {
      // Honest fallback: select the text so a manual copy is one keystroke.
      fieldRef.current?.focus()
      fieldRef.current?.select()
    }
    setTimeout(() => setState('idle'), 2200)
  }

  return (
    <div className="form-field">
      <label className="form-label">
        <span>{label}</span>
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {multiline ? (
          <textarea
            ref={fieldRef as React.RefObject<HTMLTextAreaElement>}
            className="yaml-textarea"
            style={{ minHeight: 64 }}
            readOnly
            value={value}
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <input
            ref={fieldRef as React.RefObject<HTMLInputElement>}
            className="text-input mono"
            readOnly
            value={value}
            onFocus={(e) => e.target.select()}
          />
        )}
        <button className="btn btn--primary" style={{ flexShrink: 0 }} disabled={!value} onClick={copy}>
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      <div className="form-desc">
        {state === 'failed' ? 'Copying was blocked by the browser — the text is selected, copy it manually.' : hint}
      </div>
    </div>
  )
}
