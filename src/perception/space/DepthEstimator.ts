import type { DepthMap } from './surface';
import type { DepthWorkerRequest, DepthWorkerResponse } from './depth.worker';

export type DepthStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Cliente del worker de profundidad. Se encarga de mandar frames reducidos a una tasa
 * baja (por defecto ~5 fps) y de quedarse siempre con el último mapa.
 */
export class DepthEstimator {
  status: DepthStatus = 'idle';
  device = '';
  error = '';
  progress = 0;
  latest: DepthMap | null = null;
  lastMs = 0;

  private worker: Worker | null = null;
  private busy = false;
  private nextId = 0;
  private lastSent = 0;
  private canvas = document.createElement('canvas');

  constructor(
    private model = 'onnx-community/depth-anything-v2-small',
    private inputWidth = 256,
    private intervalMs = 200,
  ) {}

  start() {
    if (this.worker) return;
    this.status = 'loading';
    this.worker = new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<DepthWorkerResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      this.status = 'error';
      this.error = e.message;
    };
    this.send({ type: 'init', model: this.model });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.status = 'idle';
    this.latest = null;
  }

  get running() {
    return !!this.worker;
  }

  private send(msg: DepthWorkerRequest, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }

  private onMessage(msg: DepthWorkerResponse) {
    switch (msg.type) {
      case 'ready':
        this.status = 'ready';
        this.device = msg.device;
        break;
      case 'progress':
        this.progress = msg.progress;
        break;
      case 'error':
        this.status = 'error';
        this.error = msg.message;
        this.busy = false;
        console.warn('[depth]', msg.message);
        break;
      case 'result':
        this.busy = false;
        this.lastMs = msg.ms;
        this.latest = { width: msg.width, height: msg.height, data: msg.data };
        break;
    }
  }

  /** Llamar cada frame; sólo envía cuando el worker está libre y pasó el intervalo. */
  update(video: HTMLVideoElement, mirrored: boolean) {
    if (this.status !== 'ready' || this.busy || video.videoWidth === 0) return;
    const now = performance.now();
    if (now - this.lastSent < this.intervalMs) return;
    this.lastSent = now;
    this.busy = true;

    const w = this.inputWidth;
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d')!;
    ctx.save();
    if (mirrored) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    void createImageBitmap(this.canvas).then((bitmap) => this.send({ type: 'infer', id: this.nextId++, bitmap }, [bitmap]));
  }
}
