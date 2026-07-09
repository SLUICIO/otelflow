import { useEffect, useMemo, useRef, useState } from 'react'
import { copyText } from '../lib/clipboard'
import { encodeShare, type EmbedTheme, type EmbedView } from '../lib/share'
import { parseConfigModel } from '../lib/parse'
import { computeLayout } from './FlowGraph'

const EMBED_BAR_H = 40
const CM_LINE_H = 19 // read-only config viewer line height, approximately

/**
 * Embeds are immutable snapshots, so the iframe height can be computed
 * exactly for this configuration and stays correct forever.
 */
function embedHeight(view: EmbedView, yaml: string): number {
  const canvasH = computeLayout(parseConfigModel(yaml), true).totalH
  const configH = Math.min(Math.max(yaml.split('\n').length * CM_LINE_H + 12, 140), 700)
  const content =
    view === 'canvas' ? canvasH : view === 'config' ? configH : canvasH + Math.min(configH, 380)
  return Math.ceil((content + EMBED_BAR_H + 2) / 10) * 10
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
const EMBED_VIEWS: { value: EmbedView; label: string }[] = [
  { value: 'canvas', label: 'Visual' },
  { value: 'config', label: 'Configuration' },
  { value: 'both', label: 'Visual + configuration' },
]

export function ShareDialog({ yaml, version, onClose }: Props) {
  const [link, setLink] = useState('')
  const [embedView, setEmbedView] = useState<EmbedView>('canvas')
  const [embedTheme, setEmbedTheme] = useState<EmbedTheme | 'auto'>('auto')

  useEffect(() => {
    encodeShare({ yaml, version }).then((payload) => {
      setLink(`${window.location.origin}${window.location.pathname}#share=${payload}`)
    })
  }, [yaml, version])

  const height = useMemo(() => embedHeight(embedView, yaml), [embedView, yaml])
  const embedSrc =
    link.replace('#share=', '#embed=') +
    (embedView === 'canvas' ? '' : `&view=${embedView}`) +
    (embedTheme === 'auto' ? '' : `&theme=${embedTheme}`)
  const iframeCode = link
    ? `<iframe src="${embedSrc}" width="100%" height="${height}" style="border:1px solid #E5E7EB;border-radius:12px" title="OTelFlow — OpenTelemetry Collector pipeline"></iframe>`
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
          <div className="form-field">
            <label className="form-label">
              <span>Embed shows</span>
            </label>
            <div className="pipeline-pick">
              {EMBED_VIEWS.map((v) => (
                <label key={v.value}>
                  <input
                    type="radio"
                    name="embed-view"
                    checked={embedView === v.value}
                    onChange={() => setEmbedView(v.value)}
                  />
                  {v.label}
                </label>
              ))}
            </div>
          </div>
          <div className="form-field">
            <label className="form-label">
              <span>Embed theme</span>
              <span className="muted small">auto follows the reader's device</span>
            </label>
            <div className="pipeline-pick">
              {(['auto', 'light', 'dark'] as const).map((t) => (
                <label key={t}>
                  <input
                    type="radio"
                    name="embed-theme"
                    checked={embedTheme === t}
                    onChange={() => setEmbedTheme(t)}
                  />
                  {t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
                </label>
              ))}
            </div>
          </div>
          <CopyRow
            label="Embed"
            hint={
              embedView === 'both'
                ? 'Read-only view for other pages: the pipeline canvas on top, the configuration below, and a link back here.'
                : embedView === 'config'
                  ? 'Read-only configuration for other pages, with a link back to this page.'
                  : 'Read-only pipeline canvas for other pages, with a link back to this configuration.'
            }
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
