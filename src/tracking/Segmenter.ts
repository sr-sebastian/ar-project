import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

const MODEL = 'selfie_multiclass_256x256.tflite';
const REMOTE = `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/${MODEL}`;

/** Máscara de personas en espacio de pantalla (espejada igual que la vista). 1 = persona. */
export interface PersonMask {
  width: number;
  height: number;
  data: Float32Array;
  /** Timestamp (s) de la máscara. */
  t: number;
}

/**
 * Siluetas de personas con MediaPipe Image Segmenter (modelo multiclase: fondo, pelo,
 * piel, ropa…; persona = todo lo que no es fondo). Corre sobre una copia reducida del
 * video (~10 fps) para que sea liviano; la máscara resultante sirve para dibujar las
 * siluetas y para que el cuerpo entero tape a los objetos virtuales.
 */
export class PersonSegmenter {
  latest: PersonMask | null = null;
  status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private segmenter: ImageSegmenter | null = null;
  private canvas = document.createElement('canvas');
  private lastRun = 0;
  private lastTs = 0;

  constructor(
    private width = 320,
    private intervalMs = 90,
  ) {}

  private async load() {
    this.status = 'loading';
    try {
      const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe-wasm`);
      let modelAssetPath = REMOTE;
      try {
        const local = `${import.meta.env.BASE_URL}models/${MODEL}`;
        const head = await fetch(local, { method: 'HEAD' });
        if (head.ok && !(head.headers.get('content-type') ?? '').includes('text/html')) modelAssetPath = local;
      } catch {
        /* sin modelo local */
      }
      const create = (delegate: 'GPU' | 'CPU') =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      this.segmenter = await create('GPU').catch(() => create('CPU'));
      this.status = 'ready';
    } catch (err) {
      console.warn('[segmenter]', err);
      this.status = 'error';
    }
  }

  update(video: HTMLVideoElement, mirrored: boolean) {
    if (this.status === 'idle') void this.load();
    if (!this.segmenter || video.videoWidth === 0) return;
    const now = performance.now();
    if (now - this.lastRun < this.intervalMs) return;
    this.lastRun = now;

    const w = this.width;
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.save();
    if (mirrored) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();

    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    const t0 = performance.now();
    const res = this.segmenter.segmentForVideo(this.canvas, ts);
    const background = res.confidenceMasks?.[0];
    if (background) {
      const bg = background.getAsFloat32Array();
      const data = new Float32Array(bg.length);
      for (let i = 0; i < bg.length; i++) data[i] = 1 - bg[i];
      this.latest = { width: background.width, height: background.height, data, t: ts / 1000 };
    }
    res.close();
    // Frecuencia adaptativa: en equipos sin GPU la segmentación es lenta; nunca más de ~1/4
    // del tiempo en ella.
    const cost = performance.now() - t0;
    this.intervalMs = Math.min(1000, Math.max(90, cost * 4));
  }

  dispose() {
    this.segmenter?.close();
    this.segmenter = null;
    this.status = 'idle';
    this.latest = null;
  }
}
