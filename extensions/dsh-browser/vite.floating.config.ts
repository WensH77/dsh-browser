import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/** Floating status window: React application (html entry). */
export default defineConfig({
  plugins: [react(), ...sharedPlugins],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'floating/index.html'),
      output: {
        entryFileNames: 'floating/assets/[name].js',
        chunkFileNames: 'floating/assets/[name]-[hash].js',
        assetFileNames: 'floating/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
