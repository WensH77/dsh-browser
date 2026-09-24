import { targetBuild } from './vite.shared.ts'

/**
 * Background: an ES-module service worker (`"type": "module"` in the
 * manifest), which is the format this bundle is emitted in.
 */
export default targetBuild('src/background/index.ts', 'es', 'background.js', true)
