import { clamp, remap01 } from '../core/math';

export interface Expressions {
  /** 0..1 */
  smile: number;
  mouthOpen: number;
  browsUp: number;
  browsDown: number;
  /** Ojo cerrado (0..1), según las blendshapes de MediaPipe. */
  eyeClosedLeft: number;
  eyeClosedRight: number;
  /** Guiño: un ojo cerrado y el otro abierto. */
  wink: 'left' | 'right' | null;
  blink: boolean;
  surprise: number;
  kiss: number;
  /** Mejillas infladas. */
  puff: number;
}

export type ExpressionName = 'smile' | 'mouthOpen' | 'browsUp' | 'surprise' | 'kiss' | 'blink' | 'winkLeft' | 'winkRight';

const b = (bs: Record<string, number>, k: string) => bs[k] ?? 0;

/**
 * Convierte blendshapes de MediaPipe en expresiones de alto nivel.
 * Los umbrales están calibrados empíricamente para una webcam a ~1 m.
 */
export function computeExpressions(bs: Record<string, number>): Expressions {
  const smile = remap01((b(bs, 'mouthSmileLeft') + b(bs, 'mouthSmileRight')) / 2, 0.15, 0.7);
  const mouthOpen = remap01(b(bs, 'jawOpen'), 0.1, 0.55);
  const browsUp = remap01(b(bs, 'browInnerUp') * 0.6 + (b(bs, 'browOuterUpLeft') + b(bs, 'browOuterUpRight')) * 0.2, 0.15, 0.6);
  const browsDown = remap01((b(bs, 'browDownLeft') + b(bs, 'browDownRight')) / 2, 0.15, 0.6);
  const eyeClosedLeft = b(bs, 'eyeBlinkLeft');
  const eyeClosedRight = b(bs, 'eyeBlinkRight');
  const eyeWide = (b(bs, 'eyeWideLeft') + b(bs, 'eyeWideRight')) / 2;

  let wink: Expressions['wink'] = null;
  if (eyeClosedLeft > 0.55 && eyeClosedRight < 0.3) wink = 'left';
  else if (eyeClosedRight > 0.55 && eyeClosedLeft < 0.3) wink = 'right';

  return {
    smile,
    mouthOpen,
    browsUp,
    browsDown,
    eyeClosedLeft,
    eyeClosedRight,
    wink,
    blink: eyeClosedLeft > 0.5 && eyeClosedRight > 0.5,
    surprise: clamp(browsUp * 0.45 + mouthOpen * 0.35 + remap01(eyeWide, 0.05, 0.4) * 0.2),
    kiss: remap01(b(bs, 'mouthPucker'), 0.3, 0.8),
    puff: remap01(b(bs, 'cheekPuff'), 0.1, 0.5),
  };
}

/** Valores de activación de cada expresión (0..1) para detectar "flancos" con histéresis. */
export function expressionLevels(e: Expressions): Record<ExpressionName, number> {
  return {
    smile: e.smile,
    mouthOpen: e.mouthOpen,
    browsUp: e.browsUp,
    surprise: e.surprise,
    kiss: e.kiss,
    blink: e.blink ? 1 : 0,
    winkLeft: e.wink === 'left' ? 1 : 0,
    winkRight: e.wink === 'right' ? 1 : 0,
  };
}

export interface HeadPose {
  /** Grados. yaw > 0 = gira hacia la derecha de la pantalla; pitch > 0 = mira hacia arriba; roll > 0 = inclina a la derecha. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Traslación de la cabeza en cm respecto a la cámara. */
  position: { x: number; y: number; z: number };
}

/** Extrae yaw/pitch/roll de la matriz 4x4 column-major de MediaPipe. */
export function headPoseFromMatrix(m: number[], mirrored: boolean): HeadPose {
  // Elementos de la rotación (fila r, columna c) = m[c * 4 + r]
  const r = (row: number, col: number) => m[col * 4 + row];
  const toDeg = 180 / Math.PI;
  const pitch = Math.asin(clamp(-r(1, 2), -1, 1)) * toDeg;
  const yaw = Math.atan2(r(0, 2), r(2, 2)) * toDeg;
  const roll = Math.atan2(r(1, 0), r(1, 1)) * toDeg;
  const sign = mirrored ? -1 : 1;
  return {
    yaw: yaw * sign,
    pitch,
    roll: -roll * sign,
    position: { x: m[12] * sign, y: m[13], z: m[14] },
  };
}
