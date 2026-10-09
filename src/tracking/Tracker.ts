import {
  FaceLandmarker,
  FilesetResolver,
  GestureRecognizer,
  PoseLandmarker,
  type Category,
  type FaceLandmarkerResult,
  type GestureRecognizerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import { LandmarkSmoother } from './OneEuroFilter';
import type { Handedness, Landmark, RawFace, RawHand, RawPose, TrackingFrame, TrackingModule } from './types';

const REMOTE_MODELS: Record<string, string> = {
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  'pose_landmarker_heavy.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
  'gesture_recognizer.task':
    'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task',
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
};

/** Usa el modelo de `public/models` si se descargó (`npm run models:download`); si no, el remoto. */
async function resolveModel(name: string): Promise<string> {
  const local = `${import.meta.env.BASE_URL}models/${name}`;
  try {
    const res = await fetch(local, { method: 'HEAD' });
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && !type.includes('text/html')) return local;
  } catch {
    /* sin modelo local */
  }
  return REMOTE_MODELS[name];
}

type Delegate = 'GPU' | 'CPU';

/** Crea una tarea probando primero GPU y cayendo a CPU si el navegador no la soporta. */
async function withDelegate<T>(create: (delegate: Delegate) => Promise<T>): Promise<T> {
  try {
    return await create('GPU');
  } catch (err) {
    console.warn('[tracker] GPU no disponible, usando CPU', err);
    return create('CPU');
  }
}

export interface TrackerConfig {
  poseModel: 'lite' | 'full' | 'heavy';
  maxHands: number;
  smoothing: boolean;
}

/** Región cuadrada del video (en píxeles del frame crudo, sin espejar). */
interface Roi {
  x: number;
  y: number;
  size: number;
}

const CROP_SIZE = 256;
// Índices de la pose usados para guiar los crops.
const POSE_HAND = {
  Left: { wrist: 15, elbow: 13, pinky: 17, index: 19, thumb: 21 },
  Right: { wrist: 16, elbow: 14, pinky: 18, index: 20, thumb: 22 },
} as const;

/**
 * Ejecuta MediaPipe (pose, manos + gestos, cara) sobre el video.
 *
 * Corre en el hilo principal con el delegate GPU: los modelos de MediaPipe usan WebGL
 * y en un worker perderían la GPU en la mayoría de navegadores. Cada módulo se carga
 * de forma perezosa la primera vez que alguna app lo pide.
 *
 * Detección a distancia: a 2–3 m las manos y la cara ocupan pocos píxeles y el detector
 * del frame completo las pierde. Si la pose ve una muñeca (o la cabeza) pero la mano (o
 * la cara) no apareció, se recorta esa zona del video, se amplía a 256×256 y se vuelve a
 * buscar ahí. Si aun así no aparece, se arma una mano "gruesa" con los puntos de la pose.
 */
export class Tracker {
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private pose: PoseLandmarker | null = null;
  private hands: GestureRecognizer | null = null;
  private handsCrop: GestureRecognizer | null = null;
  private face: FaceLandmarker | null = null;
  private faceCrop: FaceLandmarker | null = null;
  private loading = new Map<TrackingModule, Promise<void>>();
  private enabled = new Set<TrackingModule>();
  private lastVideoTime = -1;
  private lastTimestamp = 0;
  private frameIndex = 0;
  /** Frames seguidos en que el crop de cada mano no encontró nada (para espaciar reintentos). */
  private cropMisses: Record<Handedness | 'face', number> = { Left: 0, Right: 0, face: 0 };
  private cropCanvas = Object.assign(document.createElement('canvas'), { width: CROP_SIZE, height: CROP_SIZE });
  private cropCtx = this.cropCanvas.getContext('2d')!;
  private poseSmoother = new LandmarkSmoother(1.0, 0.05);
  private handSmoothers: Record<Handedness, LandmarkSmoother> = {
    Left: new LandmarkSmoother(1.5, 0.08),
    Right: new LandmarkSmoother(1.5, 0.08),
  };
  private faceSmoother = new LandmarkSmoother(1.5, 0.05);

  /** Notifica cambios de estado de carga ("cargando cara…", errores). */
  onStatus: (module: TrackingModule, status: 'loading' | 'ready' | 'error', detail?: string) => void = () => {};

  constructor(private config: TrackerConfig) {}

  isEnabled(module: TrackingModule) {
    return this.enabled.has(module);
  }

  isReady(module: TrackingModule) {
    return module === 'pose' ? !!this.pose : module === 'hands' ? !!this.hands : !!this.face;
  }

  /** Activa/desactiva módulos. Los desactivados no consumen CPU/GPU. */
  setModules(modules: Iterable<TrackingModule>) {
    this.enabled = new Set(modules);
    for (const m of this.enabled) void this.ensureLoaded(m).catch(() => {});
  }

  private async getFileset() {
    this.fileset ??= await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe-wasm`);
    return this.fileset;
  }

  ensureLoaded(module: TrackingModule): Promise<void> {
    const existing = this.loading.get(module);
    if (existing) return existing;
    const promise = this.load(module).catch((err: unknown) => {
      this.loading.delete(module);
      this.onStatus(module, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    });
    this.loading.set(module, promise);
    return promise;
  }

  private async load(module: TrackingModule) {
    this.onStatus(module, 'loading');
    const fileset = await this.getFileset();
    if (module === 'pose') {
      const modelAssetPath = await resolveModel(`pose_landmarker_${this.config.poseModel}.task`);
      this.pose = await withDelegate((delegate) =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.35,
          minPosePresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        }),
      );
    } else if (module === 'hands') {
      const modelAssetPath = await resolveModel('gesture_recognizer.task');
      const common = { minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4 };
      this.hands = await withDelegate((delegate) =>
        GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          numHands: this.config.maxHands,
          ...common,
        }),
      );
      // Segunda instancia para los recortes (cada crop es una imagen independiente).
      this.handsCrop = await withDelegate((delegate) =>
        GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'IMAGE',
          numHands: 1,
          ...common,
        }),
      );
    } else {
      const modelAssetPath = await resolveModel('face_landmarker.task');
      const opts = { numFaces: 1, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.35, minFacePresenceConfidence: 0.4 };
      this.face = await withDelegate((delegate) =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          outputFacialTransformationMatrixes: true,
          ...opts,
        }),
      );
      this.faceCrop = await withDelegate((delegate) =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'IMAGE',
          ...opts,
        }),
      );
    }
    this.onStatus(module, 'ready');
  }

  /** Recorta una región del video al canvas de crops (los bordes fuera del frame quedan negros). */
  private drawCrop(video: HTMLVideoElement, roi: Roi) {
    const c = this.cropCtx;
    c.fillStyle = '#000';
    c.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sx = Math.max(0, roi.x);
    const sy = Math.max(0, roi.y);
    const ex = Math.min(vw, roi.x + roi.size);
    const ey = Math.min(vh, roi.y + roi.size);
    if (ex <= sx || ey <= sy) return false;
    const k = CROP_SIZE / roi.size;
    c.drawImage(video, sx, sy, ex - sx, ey - sy, (sx - roi.x) * k, (sy - roi.y) * k, (ex - sx) * k, (ey - sy) * k);
    return true;
  }

  /** Pasa landmarks del crop a coordenadas normalizadas del frame completo (sin espejar). */
  private uncrop(l: NormalizedLandmark, roi: Roi, vw: number, vh: number): NormalizedLandmark {
    return {
      x: (roi.x + l.x * roi.size) / vw,
      y: (roi.y + l.y * roi.size) / vh,
      z: (l.z * roi.size) / vw,
      visibility: l.visibility,
    };
  }

  /** Región donde debería estar la mano según el antebrazo de la pose (coordenadas crudas). */
  private handRoi(raw: NormalizedLandmark[], side: Handedness, vw: number, vh: number): Roi | null {
    const ids = POSE_HAND[side];
    const w = raw[ids.wrist];
    const e = raw[ids.elbow];
    if ((w.visibility ?? 0) < 0.5) return null;
    const wx = w.x * vw;
    const wy = w.y * vh;
    const dx = wx - e.x * vw;
    const dy = wy - e.y * vh;
    const forearm = Math.hypot(dx, dy);
    if (forearm < 4) return null;
    // La mano se extiende ~40% del antebrazo más allá de la muñeca.
    const cx = wx + dx * 0.4;
    const cy = wy + dy * 0.4;
    const size = Math.max(48, forearm * 1.5);
    return { x: cx - size / 2, y: cy - size / 2, size };
  }

  private faceRoi(raw: NormalizedLandmark[], vw: number, vh: number): Roi | null {
    const nose = raw[0];
    if ((nose.visibility ?? 0) < 0.5) return null;
    const ears = Math.hypot((raw[7].x - raw[8].x) * vw, (raw[7].y - raw[8].y) * vh);
    const shoulders = Math.hypot((raw[11].x - raw[12].x) * vw, (raw[11].y - raw[12].y) * vh);
    const size = Math.max(64, ears * 2.4, shoulders * 0.9);
    return { x: nose.x * vw - size / 2, y: nose.y * vh - size / 2, size };
  }

  /** Mano aproximada a partir de los puntos de mano de la pose (muñeca, meñique, índice, pulgar). */
  private handFromPose(raw: NormalizedLandmark[], world: NormalizedLandmark[], side: Handedness): { image: NormalizedLandmark[]; world: NormalizedLandmark[] } | null {
    const ids = POSE_HAND[side];
    if ((raw[ids.wrist].visibility ?? 0) < 0.6) return null;
    const build = (pts: NormalizedLandmark[]) => {
      const W = pts[ids.wrist];
      const I = pts[ids.index];
      const P = pts[ids.pinky];
      const T = pts[ids.thumb];
      const lerp = (a: NormalizedLandmark, b: NormalizedLandmark, t: number): NormalizedLandmark => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        visibility: 1,
      });
      // Puntas de los dedos medio y anular interpoladas entre índice y meñique.
      const tips = [I, lerp(I, P, 0.33), lerp(I, P, 0.66), P];
      const out: NormalizedLandmark[] = [W];
      for (const t of [0.3, 0.55, 0.8, 1]) out.push(lerp(W, T, t));
      for (const tip of tips) for (const t of [0.6, 0.75, 0.88, 1]) out.push(lerp(W, tip, t));
      return out;
    };
    return { image: build(raw), world: world.length === 33 ? build(world) : [] };
  }

  /**
   * Procesa el frame actual del video. Devuelve `null` si el video no avanzó desde la
   * última llamada (evita procesar dos veces el mismo frame cuando el render va a más fps).
   */
  process(video: HTMLVideoElement, mirrored: boolean): TrackingFrame | null {
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    this.frameIndex++;

    // MediaPipe exige timestamps estrictamente crecientes por tarea.
    const now = performance.now();
    const ts = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const t = ts / 1000;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const mx = (x: number) => (mirrored ? 1 - x : x);
    const toScreen = (l: NormalizedLandmark): Landmark => ({ x: mx(l.x), y: l.y, z: l.z, visibility: l.visibility });
    const toWorld = (l: NormalizedLandmark): Landmark => ({ x: mirrored ? -l.x : l.x, y: l.y, z: l.z, visibility: l.visibility });
    const timings: TrackingFrame['timings'] = {};
    const doSmooth = this.config.smoothing;

    let pose: RawPose | null = null;
    let rawPose: NormalizedLandmark[] | null = null;
    let rawPoseWorld: NormalizedLandmark[] = [];
    if (this.pose && this.enabled.has('pose')) {
      const start = performance.now();
      const res = this.pose.detectForVideo(video, ts);
      timings.pose = performance.now() - start;
      if (res.landmarks[0]) {
        rawPose = res.landmarks[0];
        rawPoseWorld = res.worldLandmarks[0] ?? [];
        const lms = rawPose.map(toScreen);
        pose = {
          landmarks: doSmooth ? this.poseSmoother.smooth(lms, t) : lms,
          world: rawPoseWorld.map(toWorld),
        };
      } else this.poseSmoother.reset();
    }

    const hands: RawHand[] = [];
    if (this.hands && this.enabled.has('hands')) {
      const start = performance.now();
      const res = this.hands.recognizeForVideo(video, ts);
      const seen = new Set<Handedness>();
      const push = (lms: NormalizedLandmark[], world: NormalizedLandmark[], handedness: Handedness, score: number, gesture: Category | undefined, source: RawHand['source']) => {
        seen.add(handedness);
        const screen = lms.map(toScreen);
        hands.push({
          landmarks: doSmooth ? this.handSmoothers[handedness].smooth(screen, t) : screen,
          world: world.map(toWorld),
          handedness,
          score,
          mpGesture: gesture && gesture.categoryName !== 'None' ? { name: gesture.categoryName, score: gesture.score } : null,
          source,
        });
      };

      res.landmarks.forEach((lms, i) => {
        const cat: Category | undefined = res.handedness[i]?.[0];
        // MediaPipe etiqueta la mano asumiendo una imagen ya espejada (selfie). El stream de
        // una cámara viene sin espejar, así que la etiqueta real es la opuesta.
        let handedness: Handedness = cat?.categoryName === 'Left' ? 'Right' : 'Left';
        // Con la pose disponible, la muñeca más cercana decide (más confiable que la etiqueta).
        if (rawPose) {
          const d = (side: Handedness) => Math.hypot(lms[0].x - rawPose![POSE_HAND[side].wrist].x, lms[0].y - rawPose![POSE_HAND[side].wrist].y);
          handedness = d('Left') < d('Right') ? 'Left' : 'Right';
        }
        if (seen.has(handedness)) handedness = handedness === 'Left' ? 'Right' : 'Left';
        push(lms, res.worldLandmarks[i] ?? [], handedness, cat?.score ?? 0, res.gestures[i]?.[0], 'full');
      });

      // Manos que la pose ve pero el detector del frame completo no: buscarlas en un crop.
      if (rawPose && this.handsCrop) {
        for (const side of ['Left', 'Right'] as const) {
          if (seen.has(side)) {
            this.cropMisses[side] = 0;
            continue;
          }
          const roi = this.handRoi(rawPose, side, vw, vh);
          const misses = this.cropMisses[side];
          // Tras varios fallos seguidos, reintenta cada 3 frames para no gastar GPU.
          if (roi && (misses < 5 || this.frameIndex % 3 === 0) && this.drawCrop(video, roi)) {
            const cr: GestureRecognizerResult = this.handsCrop.recognize(this.cropCanvas);
            if (cr.landmarks[0]) {
              this.cropMisses[side] = 0;
              push(cr.landmarks[0].map((l) => this.uncrop(l, roi, vw, vh)), cr.worldLandmarks[0] ?? [], side, cr.handedness[0]?.[0]?.score ?? 0, cr.gestures[0]?.[0], 'crop');
              continue;
            }
            this.cropMisses[side]++;
          }
          const fallback = this.handFromPose(rawPose, rawPoseWorld, side);
          if (fallback) push(fallback.image, fallback.world, side, 0.3, undefined, 'pose');
        }
      }
      timings.hands = performance.now() - start;
      for (const h of ['Left', 'Right'] as const) if (!seen.has(h)) this.handSmoothers[h].reset();
    }

    let face: RawFace | null = null;
    if (this.face && this.enabled.has('face')) {
      const start = performance.now();
      const res = this.face.detectForVideo(video, ts);
      let result: FaceLandmarkerResult | null = res.faceLandmarks[0] ? res : null;
      let roi: Roi | null = null;
      if (!result && rawPose && this.faceCrop) {
        roi = this.faceRoi(rawPose, vw, vh);
        if (roi && (this.cropMisses.face < 5 || this.frameIndex % 3 === 0) && this.drawCrop(video, roi)) {
          const cr = this.faceCrop.detect(this.cropCanvas);
          if (cr.faceLandmarks[0]) result = cr;
          else this.cropMisses.face++;
        }
      }
      if (result) {
        this.cropMisses.face = 0;
        const blendshapes: Record<string, number> = {};
        for (const c of result.faceBlendshapes[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
        const raw = roi && result !== res ? result.faceLandmarks[0].map((l) => this.uncrop(l, roi!, vw, vh)) : result.faceLandmarks[0];
        const lms = raw.map(toScreen);
        face = {
          landmarks: doSmooth ? this.faceSmoother.smooth(lms, t) : lms,
          blendshapes,
          // La matriz de un crop no corresponde a la cámara real: se descarta.
          matrix: result === res ? (res.facialTransformationMatrixes[0]?.data ?? null) : null,
        };
      } else this.faceSmoother.reset();
      timings.face = performance.now() - start;
    }

    return { t, videoWidth: vw, videoHeight: vh, mirrored, hands, face, pose, timings };
  }

  dispose() {
    this.pose?.close();
    this.hands?.close();
    this.handsCrop?.close();
    this.face?.close();
    this.faceCrop?.close();
  }
}
