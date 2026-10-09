import type { Vec2, Vec3 } from '../../core/math';
import { OneEuroFilter } from '../../tracking/OneEuroFilter';
import { HAND, POSE } from '../../perception/landmarks';
import type { HandState, PerceptionFrame } from '../../perception/types';
import type { Handedness } from '../../tracking/types';

/**
 * Estado estable de una mano para interactuar con objetos virtuales.
 *
 * Por qué existe: la posición de la mano EN PANTALLA es precisa (píxeles), pero su
 * profundidad en metros (estimada por el tamaño de la mano) tiembla ±10 cm o más. Por eso
 * las interacciones se deciden en pantalla, y la profundidad se usa muy suavizada (y, si
 * hay esqueleto, la de la muñeca del cuerpo, que es más estable).
 */
export interface RigHand {
  handedness: Handedness;
  /** Posición suavizada de la palma en pantalla (coordenadas normalizadas del video). */
  screen: Vec2;
  /** Ángulo de la mano en la imagen (radianes, de la base del meñique a la del índice). */
  angle: number;
  /** Profundidad suavizada (m). */
  depth: number;
  /** Punto 3D (m, cámara) sobre el rayo exacto de la palma, a la profundidad suavizada. */
  point: Vec3;
  /** Velocidad en pantalla (alturas de pantalla / s, x corregida por aspecto). */
  velocity: Vec2;
  speed: number;
  /** Máxima velocidad en los últimos ~0.25 s (para detectar golpes). */
  recentPeak: number;
  /** Mano cerrada (puño o pellizco), con histéresis. */
  closed: boolean;
  /** La mano original de la percepción. */
  hand: HandState;
}

interface Track {
  x: OneEuroFilter;
  y: OneEuroFilter;
  z: OneEuroFilter;
  angleX: OneEuroFilter;
  angleY: OneEuroFilter;
  prev: Vec2 | null;
  history: { t: number; speed: number }[];
  closed: boolean;
  velocity: Vec2;
}

const newTrack = (): Track => ({
  x: new OneEuroFilter(2, 0.6),
  y: new OneEuroFilter(2, 0.6),
  z: new OneEuroFilter(0.4, 0.05),
  angleX: new OneEuroFilter(1.5, 0.3),
  angleY: new OneEuroFilter(1.5, 0.3),
  prev: null,
  history: [],
  closed: false,
  velocity: { x: 0, y: 0 },
});

/** Cuenta dedos doblados (índice a meñique) como respaldo del clasificador de gestos. */
function curledFingers(h: HandState) {
  return [h.fingers.index, h.fingers.middle, h.fingers.ring, h.fingers.pinky].filter((f) => !f).length;
}

export class HandRig {
  private tracks: Record<Handedness, Track> = { Left: newTrack(), Right: newTrack() };
  hands: RigHand[] = [];

  update(frame: PerceptionFrame | null, toCamera: (p: Vec2, depth: number) => Vec3, defaultDepth: number) {
    this.hands = [];
    if (!frame) return;
    const t = frame.t;
    for (const side of ['Left', 'Right'] as const) {
      const h = frame.hands.find((x) => x.handedness === side);
      const tr = this.tracks[side];
      if (!h) {
        this.tracks[side] = newTrack();
        continue;
      }
      const sx = tr.x.filter(h.palmCenter.x, t);
      const sy = tr.y.filter(h.palmCenter.y, t);
      // Profundidad: muñeca del esqueleto si hay; si no, la de la mano; si no, la por defecto.
      const body = frame.body?.camera;
      const wrist = body?.[side === 'Left' ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
      const rawZ = wrist && (frame.body!.landmarks[side === 'Left' ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST].visibility ?? 0) > 0.5 ? wrist.z : (h.palm3?.z ?? defaultDepth);
      const z = tr.z.filter(Math.min(8, Math.max(0.15, rawZ)), t);

      const lm = h.landmarks;
      const ax = lm[HAND.INDEX_MCP].x - lm[HAND.PINKY_MCP].x;
      const ay = lm[HAND.INDEX_MCP].y - lm[HAND.PINKY_MCP].y;
      const len = Math.hypot(ax * frame.aspect, ay) || 1;
      const angle = Math.atan2(tr.angleY.filter(ay / len, t), tr.angleX.filter((ax * frame.aspect) / len, t));

      const pos = { x: sx, y: sy };
      if (tr.prev) {
        const v = { x: ((pos.x - tr.prev.x) * frame.aspect) / frame.dt, y: (pos.y - tr.prev.y) / frame.dt };
        tr.velocity = { x: tr.velocity.x * 0.5 + v.x * 0.5, y: tr.velocity.y * 0.5 + v.y * 0.5 };
      }
      tr.prev = pos;
      const speed = Math.hypot(tr.velocity.x, tr.velocity.y);
      tr.history.push({ t, speed });
      while (tr.history.length && t - tr.history[0].t > 0.25) tr.history.shift();

      // Cerrada: puño/pellizco del clasificador o ≥3 dedos doblados; con histéresis.
      const closedNow = h.source !== 'pose' && (h.gesture === 'fist' || h.pinching || h.mpGesture?.name === 'Closed_Fist' || curledFingers(h) >= 3);
      const openNow = h.source !== 'pose' && (h.gesture === 'open_palm' || curledFingers(h) <= 1);
      tr.closed = tr.closed ? !openNow : closedNow;

      this.hands.push({
        handedness: side,
        screen: pos,
        angle,
        depth: z,
        point: toCamera(pos, z),
        velocity: tr.velocity,
        speed,
        recentPeak: Math.max(0, ...tr.history.map((e) => e.speed)),
        closed: tr.closed,
        hand: h,
      });
    }
  }

  get(side: Handedness) {
    return this.hands.find((h) => h.handedness === side) ?? null;
  }

  /** Mano preferida para sostener herramientas: la derecha si está. */
  primary() {
    return this.get('Right') ?? this.hands[0] ?? null;
  }
}

/** ¿El punto `p` (pantalla) está dentro del polígono convexo/cualquiera `poly`? */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Caja envolvente en pantalla de un conjunto de puntos, agrandada `margin` (alturas). */
export function screenBox(points: Vec2[], margin = 0, aspect = 16 / 9) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const mx = margin / aspect;
  return { x0: Math.min(...xs) - mx, x1: Math.max(...xs) + mx, y0: Math.min(...ys) - margin, y1: Math.max(...ys) + margin };
}

export const inBox = (p: Vec2, b: { x0: number; x1: number; y0: number; y1: number }) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
