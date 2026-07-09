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

export async function fetchMeta(): Promise<Meta> {
  await initValidator()
  return JSON.parse(window.otelflowMeta())
}

export async function fetchComponents(version: string): Promise<Component[]> {
  await initValidator()
  return JSON.parse(window.otelflowComponents(version)).components
}

export async function validateConfig(config: string, version: string): Promise<ValidationResult> {
  await initValidator()
  return JSON.parse(window.otelflowValidate(config, version))
}
