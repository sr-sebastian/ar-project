import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export const MEDIAPIPE_WASM_PATH = 'mediapipe-wasm';

/**
 * Sirve los binarios WASM de `@mediapipe/tasks-vision` desde node_modules (dev) y los copia
 * al build. Así la versión del WASM siempre coincide con la del paquete JS y no depende de
 * un CDN externo.
 */
export function mediapipeAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const wasmDir = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
  const prefix = `/${MEDIAPIPE_WASM_PATH}/`;

  return {
    name: 'ar-mediapipe-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        const file = req.url.slice(prefix.length).split('?')[0];
        if (!readdirSync(wasmDir).includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        createReadStream(join(wasmDir, file)).pipe(res);
      });
    },
    generateBundle() {
      for (const file of readdirSync(wasmDir)) {
        this.emitFile({ type: 'asset', fileName: `${MEDIAPIPE_WASM_PATH}/${file}`, source: readFileSync(join(wasmDir, file)) });
      }
    },
  };
}
