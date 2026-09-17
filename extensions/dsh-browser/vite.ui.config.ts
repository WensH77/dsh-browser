import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/**
 * Both React pages — the side panel (which doubles as the floating status
 * window) and the options page — in ONE build with two HTML inputs.
 *
 * They were two builds, and each bundled its own copy of React: together about
 * 285 KB of the extension's 566 KB, for two pages whose own code is a few
 * kilobytes each. One build with two inputs lets Rollup hoist the shared
 * dependencies into a common chunk both pages load.
 *
 * Shared code goes to `assets/`, and each page keeps its own directory for the
 * chunks only it uses. The panels' HTML files reference whatever this emits, so
 * nothing else has to track the names.
 */
export default defineConfig({
  plugins: [react(), ...sharedPlugins],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        panel: resolve(import.meta.dirname, 'panel/index.html'),
        options: resolve(import.meta.dirname, 'options/index.html'),
      },
      output: {
        // `[name]` is the entry key, so each page keeps its own file name and
        // the directories the manifest already points at.
        entryFileNames: '[name]/assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: '[name]/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
