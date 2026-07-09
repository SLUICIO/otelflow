import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Git SHA for provenance: taken from the GIT_SHA env var in CI/Docker builds
// (no .git in the build context there), from git locally, 'dev' otherwise.
const gitSha = (
  process.env.GIT_SHA ??
  (() => {
    try {
      return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    } catch {
      return 'dev'
    }
  })()
).trim().slice(0, 7)

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': 'http://localhost:7317',
    },
  },
  build: {
    outDir: 'dist',
  },
})
