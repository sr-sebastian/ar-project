import type { Vec2, Vec3 } from '../core/math';
import type { Handedness, Landmark, TrackingFrame } from '../tracking/types';
import type { BodyMetrics } from './body';
import type { Expressions, ExpressionName, HeadPose } from './expressions';
import type { FingerState, GestureName, SwipeDirection } from './gestures';
import type { DepthStatus } from './space/DepthEstimator';
import type { DepthMap, Intrinsics, Plane, SurfaceKind } from './space/surface';

export interface HandState {
  handedness: Handedness;
  landmarks: Landmark[];
  world: Landmark[];
  gesture: GestureName;
  mpGesture: { name: string; score: number } | null;
  fingers: FingerState;
  pinching: boolean;
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
}

export interface SpaceState {
  kind: SurfaceKind;
  depthStatus: DepthStatus;
  depth: DepthMap | null;
  /** Plano de la superficie de juego (piso o mesa) en coordenadas de cámara. */
  surface: Plane;
  /** `depth` si salió del mapa de profundidad; `assumed` si es el plano por defecto. */
  surfaceSource: 'depth' | 'assumed';
  surfaceConfidence: number;
  intrinsics: Intrinsics;
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
}
