/// <reference types="vite/client" />

// Injected at build time via vite.config.ts `define`.
declare const __APP_VERSION__: string
declare const __GIT_SHA__: string

// Provided by wasm_exec.js (Go's WebAssembly support script).
declare class Go {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
}

// Registered by the validator WASM module (cmd/wasm).
interface Window {
  otelflowMeta: () => string
  otelflowComponents: (version: string) => string
  otelflowValidate: (config: string, version: string, distribution?: string) => string
}
