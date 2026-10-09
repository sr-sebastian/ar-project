import { dist3, type Vec3 } from '../core/math';
import { HAND } from './landmarks';

export type GestureName =
  | 'none'
  | 'pinch'
  | 'fist'
  | 'open_palm'
  | 'point'
  | 'victory'
  | 'thumbs_up'
  | 'thumbs_down'
  | 'rock';

export interface FingerState {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
}

/** Tamaño de referencia de la mano (muñeca → base del dedo medio). Hace todo invariante a la distancia. */
export function palmSize(lm: Vec3[]): number {
  return dist3(lm[HAND.WRIST], lm[HAND.MIDDLE_MCP]) || 1e-6;
}

/**
 * Un dedo está extendido si su punta está claramente más lejos de la muñeca que su
 * articulación media. Comparar distancias (y no coordenadas y) lo hace invariante a la
 * rotación de la mano.
 */
export function fingerStates(lm: Vec3[]): FingerState {
  const wrist = lm[HAND.WRIST];
  const ext = (tip: number, pip: number) => dist3(lm[tip], wrist) > dist3(lm[pip], wrist) * 1.15;
  const size = palmSize(lm);
  // Pulgar: extendido si la punta se aleja del nudillo del índice y de la palma.
  const thumb =
    dist3(lm[HAND.THUMB_TIP], lm[HAND.INDEX_MCP]) / size > 0.65 &&
    dist3(lm[HAND.THUMB_TIP], lm[HAND.PINKY_MCP]) > dist3(lm[HAND.THUMB_IP], lm[HAND.PINKY_MCP]);
  return {
    thumb,
    index: ext(HAND.INDEX_TIP, HAND.INDEX_PIP),
    middle: ext(HAND.MIDDLE_TIP, HAND.MIDDLE_PIP),
    ring: ext(HAND.RING_TIP, HAND.RING_PIP),
    pinky: ext(HAND.PINKY_TIP, HAND.PINKY_PIP),
  };
}

/** Distancia pulgar–índice normalizada por el tamaño de la palma (≈0 = pellizco cerrado). */
export function pinchDistance(lm: Vec3[]): number {
  return dist3(lm[HAND.THUMB_TIP], lm[HAND.INDEX_TIP]) / palmSize(lm);
}

/**
 * Clasifica el gesto estático de una mano a partir de sus 21 landmarks normalizados
 * (y hacia abajo, como en la imagen).
 */
export function classifyGesture(lm: Vec3[], pinching: boolean): GestureName {
  if (lm.length < 21) return 'none';
  const f = fingerStates(lm);
  const others = [f.middle, f.ring, f.pinky];
  const nOthers = others.filter(Boolean).length;

  if (pinching && nOthers >= 1) return 'pinch';

  if (f.thumb && !f.index && nOthers === 0) {
    const dy = (lm[HAND.THUMB_TIP].y - lm[HAND.THUMB_MCP].y) / palmSize(lm);
    if (dy < -0.5) return 'thumbs_up';
    if (dy > 0.5) return 'thumbs_down';
  }
  if (!f.index && nOthers === 0) return 'fist';
  if (f.index && f.middle && f.ring && f.pinky) return 'open_palm';
  if (f.index && f.pinky && !f.middle && !f.ring) return 'rock';
  if (f.index && f.middle && !f.ring && !f.pinky) return 'victory';
  if (f.index && nOthers === 0) return 'point';
  if (pinching) return 'pinch';
  return 'none';
}

/** Pellizco con histéresis: entra por debajo de `on` y sale por encima de `off` para evitar parpadeos. */
export class PinchDetector {
  active = false;
  constructor(
    private on = 0.3,
    private off = 0.45,
  ) {}

  update(lm: Vec3[]): boolean {
    const d = pinchDistance(lm);
    this.active = this.active ? d < this.off : d < this.on;
    return this.active;
  }
}

/**
 * Estabiliza un gesto: sólo cambia el gesto reportado cuando el nuevo se mantiene
 * `minFrames` frames seguidos.
 */
export class GestureStabilizer {
  current: GestureName = 'none';
  private candidate: GestureName = 'none';
  private count = 0;

  constructor(private minFrames = 3) {}

  update(g: GestureName): GestureName {
    if (g === this.current) {
      this.count = 0;
      return this.current;
    }
    if (g === this.candidate) this.count++;
    else {
      this.candidate = g;
      this.count = 1;
    }
    if (this.count >= this.minFrames) {
      this.current = g;
      this.count = 0;
    }
    return this.current;
  }
}

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/** Detecta swipes a partir de la velocidad (unidades de pantalla normalizadas por segundo). */
export class SwipeDetector {
  private cooldownUntil = 0;

  constructor(
    private minSpeed = 2.2,
    private cooldown = 0.5,
  ) {}

  update(vx: number, vy: number, t: number): SwipeDirection | null {
    if (t < this.cooldownUntil) return null;
    const speed = Math.hypot(vx, vy);
    if (speed < this.minSpeed) return null;
    this.cooldownUntil = t + this.cooldown;
    if (Math.abs(vx) > Math.abs(vy)) return vx > 0 ? 'right' : 'left';
    return vy > 0 ? 'down' : 'up';
  }
}

/**
 * ¿La palma mira hacia la cámara (y no el dorso)?
 *
 * Se mira el orden en pantalla de la base del índice y la del meñique respecto de la
 * muñeca (producto cruz 2D). Ese orden se invierte al dar vuelta la mano, al cambiar de
 * mano (izquierda/derecha son espejos) y al espejar la imagen; con la mano real conocida y
 * el espejado, el signo dice de qué lado está la palma. No depende de la rotación de la
 * mano en el plano de la imagen.
 */
export function palmFacesCamera(lm: Vec3[], handedness: 'Left' | 'Right', mirrored: boolean): boolean {
  const w = lm[HAND.WRIST];
  const a = { x: lm[HAND.INDEX_MCP].x - w.x, y: lm[HAND.INDEX_MCP].y - w.y };
  const b = { x: lm[HAND.PINKY_MCP].x - w.x, y: lm[HAND.PINKY_MCP].y - w.y };
  const cross = a.x * b.y - a.y * b.x;
  // Imagen cruda, mano derecha con la palma hacia la cámara → cruz negativa.
  let sign = handedness === 'Right' ? -1 : 1;
  if (mirrored) sign = -sign;
  return cross * sign > 0;
}
