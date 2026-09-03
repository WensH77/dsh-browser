import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/** Options page: React application (html entry). */
export default defineConfig({
  plugins: [react(), ...sharedPlugins],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'options/index.html'),
      output: {
        entryFileNames: 'options/assets/[name].js',
        chunkFileNames: 'options/assets/[name]-[hash].js',
        assetFileNames: 'options/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
