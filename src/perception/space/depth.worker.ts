/// <reference lib="webworker" />
import { env, pipeline, RawImage, type DepthEstimationPipeline } from '@huggingface/transformers';

/**
 * Worker de profundidad monocular (Depth Anything V2 small). Corre fuera del hilo
 * principal para no frenar el render ni MediaPipe. Usa WebGPU si existe, si no WASM.
 */
export type DepthWorkerRequest =
  | { type: 'init'; model: string }
  | { type: 'infer'; id: number; bitmap: ImageBitmap };

export type DepthWorkerResponse =
  | { type: 'ready'; device: string }
  | { type: 'progress'; progress: number; file?: string }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; width: number; height: number; data: Float32Array; ms: number };

declare const self: DedicatedWorkerGlobalScope;

env.allowLocalModels = false;

let estimator: DepthEstimationPipeline | null = null;
let canvas: OffscreenCanvas | null = null;

const post = (msg: DepthWorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function init(model: string) {
  const progress_callback = (p: { status: string; progress?: number; file?: string }) => {
    if (p.status === 'progress' && typeof p.progress === 'number') post({ type: 'progress', progress: p.progress, file: p.file });
  };
  const hasWebGPU = 'gpu' in navigator && !!(await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  const attempts: { device: 'webgpu' | 'wasm'; dtype: 'fp32' | 'q8' }[] = hasWebGPU
    ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
    : [{ device: 'wasm', dtype: 'q8' }];
  let lastError: unknown;
  for (const opts of attempts) {
    try {
      estimator = (await pipeline('depth-estimation', model, { ...opts, progress_callback })) as DepthEstimationPipeline;
      post({ type: 'ready', device: opts.device });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  post({ type: 'error', message: lastError instanceof Error ? lastError.message : String(lastError) });
}

async function infer(id: number, bitmap: ImageBitmap) {
  if (!estimator) return;
  const start = performance.now();
  canvas ??= new OffscreenCanvas(bitmap.width, bitmap.height);
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = RawImage.fromCanvas(canvas);
  const out = await estimator(image);
  const tensor = out.predicted_depth;
  const dims = tensor.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  const raw = tensor.data as Float32Array;
  // Sólo se divide por el máximo (sin restar el mínimo): así la disparidad 0 sigue
  // significando "infinito", que es lo que asume la estimación de planos en disparidad.
  let max = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] > max) max = raw[i];
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = Math.max(0, raw[i]) / (max || 1);
  post({ type: 'result', id, width, height, data, ms: performance.now() - start }, [data.buffer]);
}

self.onmessage = (e: MessageEvent<DepthWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') void init(msg.model);
  else if (msg.type === 'infer') void infer(msg.id, msg.bitmap).catch((err) => post({ type: 'error', message: String(err) }));
};
