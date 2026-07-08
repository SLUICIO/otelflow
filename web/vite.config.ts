import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
