/**
 * Database-less sharing: the whole configuration (plus collector version) is
 * deflate-compressed and base64url-encoded into the URL fragment. Fragments
 * are never sent to the server, so nothing is stored or logged anywhere —
 * the link IS the data.
 *
 * Payload format: "<kind>.<base64url>" where kind 1 = deflate-raw
 * compressed, 0 = plain UTF-8 (fallback for browsers without
 * CompressionStream).
 */

export interface SharedConfig {
  yaml: string
  version: string
}

export type EmbedView = 'canvas' | 'config' | 'both'

export function parseShareHash(): { mode: 'share' | 'embed'; payload: string; view: EmbedView } | null {
  const m = window.location.hash.match(/^#(share|embed)=([^&]+)(?:&view=(canvas|config|both))?$/)
  if (!m) return null
  return {
    mode: m[1] as 'share' | 'embed',
    payload: m[2],
    view: (m[3] as EmbedView) ?? 'canvas',
  }
}

export async function encodeShare(cfg: SharedConfig): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify({ v: cfg.version, c: cfg.yaml }))
  if (typeof CompressionStream !== 'undefined') {
    const deflated = await pipe(raw, new CompressionStream('deflate-raw'))
    return '1.' + toB64Url(deflated)
  }
  return '0.' + toB64Url(raw)
}

export async function decodeShare(payload: string): Promise<SharedConfig | null> {
  try {
    const dot = payload.indexOf('.')
    if (dot < 0) return null
    const kind = payload.slice(0, dot)
    const bytes = fromB64Url(payload.slice(dot + 1))
    const raw =
      kind === '1' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes
    const obj = JSON.parse(new TextDecoder().decode(raw)) as { v?: unknown; c?: unknown }
    if (typeof obj?.c !== 'string') return null
    return { yaml: obj.c, version: typeof obj.v === 'string' ? obj.v : '' }
  } catch {
    return null
  }
}

async function pipe(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toB64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
