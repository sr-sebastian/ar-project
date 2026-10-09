import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { mediapipeAssetsPlugin } from './server/mediapipeAssets';
import { signalingPlugin } from './server/signaling';

// HTTPS es obligatorio para que el celular pueda usar getUserMedia por la LAN.
// Con AR_NO_HTTPS=1 se sirve por HTTP (útil para tests automatizados en localhost).
const useHttps = process.env.AR_NO_HTTPS !== '1';

export default defineConfig({
  plugins: [...(useHttps ? [basicSsl()] : []), signalingPlugin(), mediapipeAssetsPlugin()],
  server: { port: 5173 },
  preview: { port: 4173 },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        phone: resolve(import.meta.dirname, 'phone.html'),
        marcador: resolve(import.meta.dirname, 'marcador.html'),
      },
    },
  },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
