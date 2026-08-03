import { build } from 'esbuild'

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
