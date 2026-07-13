import type { Component, Meta, ValidationResult } from './types'

/**
 * Validation runs entirely in the browser: the Go validation engine and the
 * component registry are compiled to WebAssembly (cmd/wasm) and loaded once,
 * lazily. Configurations never leave the page.
 */

let wasmReady: Promise<void> | null = null

function initValidator(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const go = new Go()
      const resp = await fetch('/validate.wasm')
      if (!resp.ok) throw new Error(`fetching validator: ${resp.status}`)
      const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject)
      void go.run(instance) // resolves only if the program exits; it shouldn't
      // The registered globals are available synchronously after run() starts.
      if (typeof window.otelflowValidate !== 'function') {
        throw new Error('validator did not initialize')
      }
    })()
    wasmReady.catch(() => {
      wasmReady = null // allow a retry on the next call
    })
  }
  return wasmReady
}

/**
 * Runs a validator call, and if the runtime has died (a call throwing is
 * the symptom — e.g. "Go program has already exited"), re-instantiates the
 * module once and retries. Without this, a single runtime death would
 * freeze the last diagnostics on screen forever.
 */
async function call<T>(fn: () => string): Promise<T> {
  await initValidator()
  try {
    return JSON.parse(fn())
  } catch {
    wasmReady = null
    await initValidator()
    return JSON.parse(fn())
  }
}

export function fetchMeta(): Promise<Meta> {
  return call(() => window.otelflowMeta())
}

export async function fetchComponents(version: string): Promise<Component[]> {
  const res = await call<{ components: Component[] }>(() => window.otelflowComponents(version))
  return res.components
}

export function validateConfig(
  config: string,
  version: string,
  distribution: string,
): Promise<ValidationResult> {
  return call(() => window.otelflowValidate(config, version, distribution))
}
