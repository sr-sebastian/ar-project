export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Mapea `v` de [a, b] a [0, 1] con saturación. */
export const remap01 = (v: number, a: number, b: number) => clamp((v - a) / (b - a));

export const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const mid2 = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const mid3 = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len3 = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
export const normalize3 = (a: Vec3): Vec3 => {
  const l = len3(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** Ángulo (grados) en el vértice `b` formado por los segmentos b→a y b→c. */
export function angleAt(a: Vec3, b: Vec3, c: Vec3): number {
  const u = sub3(a, b);
  const v = sub3(c, b);
  const cos = dot3(u, v) / ((len3(u) * len3(v)) || 1);
  return (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI;
}

/**
 * Distancia mínima entre el segmento p0→p1 y el punto c. Se usa para detectar
 * "cortes": la trayectoria de la mano entre dos frames contra un objeto.
 */
export function segmentPointDistance(p0: Vec2, p1: Vec2, c: Vec2): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : clamp(((c.x - p0.x) * dx + (c.y - p0.y) * dy) / lenSq);
  return Math.hypot(p0.x + t * dx - c.x, p0.y + t * dy - c.y);
}

/** Generador pseudoaleatorio determinista (mulberry32), útil para tests y repeticiones. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
