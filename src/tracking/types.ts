/**
 * Datos crudos que salen del tracker, ya convertidos a "espacio de pantalla":
 * coordenadas normalizadas [0,1] del frame de video, con el espejado aplicado
 * si la vista está espejada. Así todo lo que viene después (percepción, apps)
 * trabaja en el mismo sistema que ve el usuario.
 */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export type Handedness = 'Left' | 'Right';

export interface RawHand {
  /** 21 puntos normalizados (x, y en [0,1]; z relativo a la muñeca). */
  landmarks: Landmark[];
  /** 21 puntos en metros, origen en el centro de la mano. */
  world: Landmark[];
  /** Mano real del usuario (ya corregida respecto a la convención de MediaPipe). */
  handedness: Handedness;
  score: number;
  /** Gesto del clasificador de MediaPipe (Closed_Fist, Open_Palm, Pointing_Up, Thumb_Up, Victory, ILoveYou…). */
  mpGesture: { name: string; score: number } | null;
  /**
   * De dónde salió: detector del frame completo, recorte ampliado guiado por la pose (manos
   * lejanas) o aproximación con los puntos de mano de la pose (sin dedos confiables).
   */
  source: 'full' | 'crop' | 'pose';
}

export interface RawFace {
  /** 478 puntos de la malla facial. */
  landmarks: Landmark[];
  /** 52 blendshapes ARKit-like: jawOpen, mouthSmileLeft, eyeBlinkRight… */
  blendshapes: Record<string, number>;
  /** Matriz 4x4 (column-major) de transformación facial, en cm. */
  matrix: number[] | null;
}

export interface RawPose {
  /** 33 puntos normalizados con visibilidad. */
  landmarks: Landmark[];
  /** 33 puntos en metros, origen entre las caderas. */
  world: Landmark[];
}

export interface TrackingFrame {
  /** Timestamp en segundos (performance.now). */
  t: number;
  videoWidth: number;
  videoHeight: number;
  mirrored: boolean;
  hands: RawHand[];
  face: RawFace | null;
  pose: RawPose | null;
  /** Milisegundos de inferencia por módulo (para el panel de rendimiento). */
  timings: Partial<Record<TrackingModule, number>>;
}

export type TrackingModule = 'pose' | 'hands' | 'face';
