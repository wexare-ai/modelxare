import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadClientConfig } from './client-config.ts';

// Cross-origin isolation enables multithreaded WASM inference (SharedArrayBuffer).
// Cross-origin fetches (gateways, mirrors) are CORS requests and are unaffected.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Emit sw.js caching every built asset (JS, CSS, WASM, workers) so the app
 * shell and runtime reload offline. It only ever handles same-origin GETs.
 */
function offlineShell(): Plugin {
  return {
    name: 'wexare-offline-shell',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const publicFiles = readdirSync(join(import.meta.dirname, 'public'));
      const assets = [...Object.keys(bundle), ...publicFiles].filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      const version = createHash('sha256').update(assets.sort().join('\n')).digest('hex').slice(0, 16);
      const template = readFileSync(join(import.meta.dirname, 'src/sw-template.js'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replace('__VERSION__', version).replace('__ASSETS__', JSON.stringify(['./', ...assets.map((a) => `./${a}`)])),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineShell()],
  define: { __CLIENT_CONFIG__: JSON.stringify(loadClientConfig()) },
  server: { port: 5173, strictPort: true, headers: isolation },
  preview: { port: 4173, strictPort: true, headers: isolation },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', '@wllama/wllama'] },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
});
