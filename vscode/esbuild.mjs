import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
}

// The extension entry point; 'vscode' is provided by the host.
await build({
  ...common,
  entryPoints: ['src/extension.ts'],
  external: ['vscode'],
  outfile: 'dist/extension.cjs',
})

// The validator host as a standalone module so the smoke test can exercise
// it in plain Node, without a VS Code instance.
await build({
  ...common,
  entryPoints: ['src/validator.ts'],
  outfile: 'dist/validator.cjs',
})

// The preview webview: bundles the web app's FlowGraph + parser + styles.
// react/react-dom/yaml are aliased to THIS package's copies so the bundle
// holds exactly one React and builds without web/node_modules installed.
await build({
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: true,
  outfile: 'dist/webview/main.js',
  alias: {
    react: dirname(require.resolve('react/package.json')),
    'react-dom': dirname(require.resolve('react-dom/package.json')),
    yaml: dirname(require.resolve('yaml/package.json')),
  },
  define: { 'process.env.NODE_ENV': '"production"' },
})
