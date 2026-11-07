import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadClientConfig } from '../web/client-config.ts';

// The simple app runs the same engine as apps/web (catalog worker, verified
// downloads, wllama), so it needs the same endpoints, isolation headers and
// dependency handling.

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** Same offline shell as apps/web: sw.js precaches every built asset. */
function offlineShell(): Plugin {
  return {
    name: 'wexare-offline-shell',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const publicFiles = readdirSync(join(import.meta.dirname, 'public'));
      const assets = [...Object.keys(bundle), ...publicFiles].filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      const version = createHash('sha256').update(assets.sort().join('\n')).digest('hex').slice(0, 16);
      const template = readFileSync(join(import.meta.dirname, '../web/src/sw-template.js'), 'utf8');
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
  server: { port: 5174, strictPort: true, headers: isolation },
  preview: { port: 4174, strictPort: true, headers: isolation },
  // Pre-bundling these breaks the paths they use to load their .wasm files.
  // @wexare/laya-web is still pre-bundled and imports onnxruntime-web by name,
  // so onnxruntime-web is a direct dependency: with pnpm, only packages that
  // declare it can resolve it.
  // The workers' imports aren't found by Vite's start-up scan, so list them:
  // otherwise Vite reloads the page the first time each worker starts.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm', '@wllama/wllama', 'onnxruntime-web'],
    include: ['@wexare/laya-web/worker', '@wexare/web > @wexare/catalog > fflate'],
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
});
