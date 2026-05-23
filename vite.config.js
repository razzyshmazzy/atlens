import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  base: '/atlens/',
  plugins: [react()],
  resolve: {
    alias: {
      // Allow @/ imports (shadcn convention) to resolve to src/
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Transformers.js ships onnxruntime-web (WASM); excluding it from dep
  // pre-bundling avoids esbuild choking on its dynamic worker/wasm imports.
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
})
