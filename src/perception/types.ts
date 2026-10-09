import type { Vec2, Vec3 } from '../core/math';
import type { Handedness, Landmark, RawHand, TrackingFrame } from '../tracking/types';
import type { BodyMetrics } from './body';
import type { Expressions, ExpressionName, HeadPose } from './expressions';
import type { FingerState, GestureName, SwipeDirection } from './gestures';
import type { DepthStatus } from './space/DepthEstimator';
import type { MarkerPose } from './space/marker';
import type { DepthMap, Intrinsics, Plane, SurfaceKind } from './space/surface';

export interface HandState {
  handedness: Handedness;
  /** Origen de la detección (frame completo, recorte ampliado o aproximación desde la pose). */
  source: RawHand['source'];
  landmarks: Landmark[];
  world: Landmark[];
  gesture: GestureName;
  mpGesture: { name: string; score: number } | null;
  fingers: FingerState;
  pinching: boolean;
  /** La palma (no el dorso) mira hacia la cámara. */
  palmFacing: boolean;
  /** Distancia pulgar-índice / tamaño de palma. */
  pinchDistance: number;
  indexTip: Vec2;
  prevIndexTip: Vec2;
  palmCenter: Vec2;
  prevPalmCenter: Vec2;
  /**
   * Velocidad del centro de la palma y de la punta del índice, en "alturas de pantalla
   * por segundo" (x corregido por aspecto para que sea isotrópica).
   */
  velocity: Vec2;
  tipVelocity: Vec2;
  speed: number;
  swipe: SwipeDirection | null;
  // ── Espacio métrico (metros, coordenadas de cámara: x der, y abajo, z adelante) ──
  /** 21 puntos en metros, o null si no se pudo resolver. */
  camera: Vec3[] | null;
  palm3: Vec3 | null;
  /** Normal del plano de la mano orientada hacia la cámara. */
  normal3: Vec3 | null;
  /** Velocidad de la palma en m/s. */
  velocity3: Vec3;
}

export interface FaceState {
  landmarks: Landmark[];
  blendshapes: Record<string, number>;
  expressions: Expressions;
  headPose: HeadPose | null;
  /** Centro aproximado de la cara (punta de la nariz) en pantalla. */
  center: Vec2;
}

export interface BodyState {
  landmarks: Landmark[];
  world: Landmark[];
  metrics: BodyMetrics;
  crouching: boolean;
  jumping: boolean;
  /** 33 puntos en metros (cámara), o null si no se pudo resolver. */
  camera: Vec3[] | null;
}

export type SurfaceSource = 'marker' | 'body' | 'hand' | 'depth' | 'assumed';

export interface SpaceState {
  kind: SurfaceKind;
  /** Intrínsecos del video (píxeles del frame). */
  intrinsics: Intrinsics;
  depthStatus: DepthStatus;
  depth: DepthMap | null;
  /** Plano de la superficie de juego (piso o mesa), en metros. Siempre definido. */
  surface: Plane;
  surfaceSource: SurfaceSource;
  /** Centro sugerido de la zona de juego sobre la superficie (m). */
  center: Vec3;
  /** Radio aproximado de la zona útil (m). */
  extent: number;
  /** Eje "derecha" de la zona de juego sobre la superficie (del marcador si hay). */
  axis: Vec3 | null;
  /** Marcador visible en este frame (esquinas en pantalla), para dibujar el contorno. */
  marker: MarkerPose | null;
  /** Progreso (0..1) de la calibración de mesa con la mano apoyada. */
  calibrationProgress: number;
  /** Vertical real (gravedad) en coordenadas de cámara, si la cámara es un celular con sensores. */
  up: Vec3 | null;
}

export interface PerceptionFrame {
  t: number;
  dt: number;
  aspect: number;
  mirrored: boolean;
  hands: HandState[];
  face: FaceState | null;
  body: BodyState | null;
  space: SpaceState;
  timings: TrackingFrame['timings'];
}

export interface PerceptionEvents {
  gesture: { hand: Handedness; gesture: GestureName; previous: GestureName };
  swipe: { hand: Handedness; direction: SwipeDirection };
  pinch: { hand: Handedness; down: boolean; at: Vec2 };
  expression: { name: ExpressionName; active: boolean };
  surface: { kind: SurfaceKind; source: SurfaceSource };
}
