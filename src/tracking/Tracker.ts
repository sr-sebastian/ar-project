import {
  FaceLandmarker,
  FilesetResolver,
  GestureRecognizer,
  PoseLandmarker,
  type Category,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import { LandmarkSmoother } from './OneEuroFilter';
import type { Handedness, Landmark, RawFace, RawHand, RawPose, TrackingFrame, TrackingModule } from './types';

const REMOTE_MODELS: Record<string, string> = {
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
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
  poseModel: 'lite' | 'full';
  maxHands: number;
  smoothing: boolean;
}

/**
 * Ejecuta MediaPipe (pose, manos + gestos, cara) sobre el video.
 *
 * Corre en el hilo principal con el delegate GPU: los modelos de MediaPipe usan WebGL
 * y en un worker perderían la GPU en la mayoría de navegadores. Cada módulo se carga
 * de forma perezosa la primera vez que alguna app lo pide.
 */
export class Tracker {
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private pose: PoseLandmarker | null = null;
  private hands: GestureRecognizer | null = null;
  private face: FaceLandmarker | null = null;
  private loading = new Map<TrackingModule, Promise<void>>();
  private enabled = new Set<TrackingModule>();
  private lastVideoTime = -1;
  private lastTimestamp = 0;
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
    for (const m of this.enabled) void this.ensureLoaded(m);
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
        }),
      );
    } else if (module === 'hands') {
      const modelAssetPath = await resolveModel('gesture_recognizer.task');
      this.hands = await withDelegate((delegate) =>
        GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          numHands: this.config.maxHands,
        }),
      );
    } else {
      const modelAssetPath = await resolveModel('face_landmarker.task');
      this.face = await withDelegate((delegate) =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        }),
      );
    }
    this.onStatus(module, 'ready');
  }

  /**
   * Procesa el frame actual del video. Devuelve `null` si el video no avanzó desde la
   * última llamada (evita procesar dos veces el mismo frame cuando el render va a más fps).
   */
  process(video: HTMLVideoElement, mirrored: boolean): TrackingFrame | null {
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    // MediaPipe exige timestamps estrictamente crecientes por tarea.
    const now = performance.now();
    const ts = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const t = ts / 1000;

    const mx = (x: number) => (mirrored ? 1 - x : x);
    const toScreen = (l: NormalizedLandmark): Landmark => ({ x: mx(l.x), y: l.y, z: l.z, visibility: l.visibility });
    const toWorld = (l: NormalizedLandmark): Landmark => ({ x: mirrored ? -l.x : l.x, y: l.y, z: l.z, visibility: l.visibility });
    const timings: TrackingFrame['timings'] = {};
    const doSmooth = this.config.smoothing;

    let pose: RawPose | null = null;
    if (this.pose && this.enabled.has('pose')) {
      const start = performance.now();
      const res = this.pose.detectForVideo(video, ts);
      timings.pose = performance.now() - start;
      if (res.landmarks[0]) {
        const lms = res.landmarks[0].map(toScreen);
        pose = {
          landmarks: doSmooth ? this.poseSmoother.smooth(lms, t) : lms,
          world: (res.worldLandmarks[0] ?? []).map(toWorld),
        };
      } else this.poseSmoother.reset();
    }

    const hands: RawHand[] = [];
    if (this.hands && this.enabled.has('hands')) {
      const start = performance.now();
      const res = this.hands.recognizeForVideo(video, ts);
      timings.hands = performance.now() - start;
      const seen = new Set<Handedness>();
      res.landmarks.forEach((lms, i) => {
        const cat: Category | undefined = res.handedness[i]?.[0];
        // MediaPipe etiqueta la mano asumiendo una imagen ya espejada (selfie). El stream de
        // una cámara viene sin espejar, así que la etiqueta real es la opuesta.
        let handedness: Handedness = cat?.categoryName === 'Left' ? 'Right' : 'Left';
        if (seen.has(handedness)) handedness = handedness === 'Left' ? 'Right' : 'Left';
        seen.add(handedness);
        const screen = lms.map(toScreen);
        const gesture = res.gestures[i]?.[0];
        hands.push({
          landmarks: doSmooth ? this.handSmoothers[handedness].smooth(screen, t) : screen,
          world: (res.worldLandmarks[i] ?? []).map(toWorld),
          handedness,
          score: cat?.score ?? 0,
          mpGesture: gesture && gesture.categoryName !== 'None' ? { name: gesture.categoryName, score: gesture.score } : null,
        });
      });
      for (const h of ['Left', 'Right'] as const) if (!seen.has(h)) this.handSmoothers[h].reset();
    }

    let face: RawFace | null = null;
    if (this.face && this.enabled.has('face')) {
      const start = performance.now();
      const res = this.face.detectForVideo(video, ts);
      timings.face = performance.now() - start;
      if (res.faceLandmarks[0]) {
        const blendshapes: Record<string, number> = {};
        for (const c of res.faceBlendshapes[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
        const lms = res.faceLandmarks[0].map(toScreen);
        face = {
          landmarks: doSmooth ? this.faceSmoother.smooth(lms, t) : lms,
          blendshapes,
          matrix: res.facialTransformationMatrixes[0]?.data ?? null,
        };
      } else this.faceSmoother.reset();
    }

    return { t, videoWidth: video.videoWidth, videoHeight: video.videoHeight, mirrored, hands, face, pose, timings };
  }

  dispose() {
    this.pose?.close();
    this.hands?.close();
    this.face?.close();
  }
}
