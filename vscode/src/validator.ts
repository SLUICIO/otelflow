/**
 * Node host for the OTelFlow validation engine (cmd/wasm). The same WASM
 * binary the web app ships runs in the extension host process, so validation
 * is fully offline and identical to otelflow.sluicio.com.
 *
 * This module must not import 'vscode' — the smoke test runs it in plain Node.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vm from 'node:vm'

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
  path?: string
  line?: number
  column?: number
  hint?: string
}

export interface ValidationResult {
  valid: boolean
  diagnostics: Diagnostic[]
}

export interface Meta {
  versions: string[]
  defaultVersion: string
  distributions: string[]
}

type WasmGlobals = {
  Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> }
  otelflowValidate?: (config: string, version: string, distribution: string) => string
  otelflowMeta?: () => string
}

let ready: Promise<void> | null = null

function init(assetDir: string): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const g = globalThis as unknown as WasmGlobals
      if (typeof g.Go !== 'function') {
        // wasm_exec.js is a plain script that attaches Go to globalThis.
        vm.runInThisContext(readFileSync(join(assetDir, 'wasm_exec.js'), 'utf8'), {
          filename: 'wasm_exec.js',
        })
      }
      const go = new g.Go()
      const { instance } = await WebAssembly.instantiate(
        readFileSync(join(assetDir, 'validate.wasm')),
        go.importObject,
      )
      void go.run(instance) // resolves only if the program exits; it shouldn't
      if (typeof g.otelflowValidate !== 'function') {
        throw new Error('validator did not initialize')
      }
    })()
    ready.catch(() => {
      ready = null // allow a retry on the next call
    })
  }
  return ready
}

/**
 * Runs a validator call; if the Go runtime has died (a call throwing is the
 * symptom), re-instantiates the module once and retries — mirrors web/src/api.ts.
 */
async function call<T>(assetDir: string, fn: () => string): Promise<T> {
  await init(assetDir)
  try {
    return JSON.parse(fn())
  } catch {
    ready = null
    await init(assetDir)
    return JSON.parse(fn())
  }
}

export function meta(assetDir: string): Promise<Meta> {
  return call(assetDir, () => (globalThis as unknown as WasmGlobals).otelflowMeta!())
}

export function validate(
  assetDir: string,
  config: string,
  version: string,
  distribution: string,
): Promise<ValidationResult> {
  return call(assetDir, () =>
    (globalThis as unknown as WasmGlobals).otelflowValidate!(config, version, distribution),
  )
}
