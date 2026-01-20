import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(),  wasm(),
    topLevelAwait()],
  define: {
    global: 'globalThis',
    'process.env': '{}',
    'process.browser': 'true',
    'process.version': '"v16.0.0"',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      process: 'process/browser',
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      '@lucid-evolution/lucid': path.resolve(__dirname, './src/stubs/lucid-stub.ts'),
    },
  },
  optimizeDeps: {
    include: [
      '@meshsdk/core', 
      '@meshsdk/react',
      'buffer', 
    ],
    exclude: ['@lucid-evolution/lucid'],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    }
  }
})
