import { add3, cross3, normalize3, sub3, type Vec3 } from '../core/math';
import type { Landmark } from '../tracking/types';
import type { Intrinsics } from './space/surface';

/**
 * Espacio métrico de cámara (metros; x derecha, y abajo, z hacia adelante).
 *
 * MediaPipe entrega, además de los landmarks en la imagen, "world landmarks" en metros con
 * la misma orientación que la cámara pero centrados en el cuerpo (caderas) o en la mano.
 * Falta sólo la traslación T hasta la cámara. Como la proyección es
 *   u' = (X + Tx) / (Z + Tz),   v' = (Y + Ty) / (Z + Tz)
 * con u' = (u - cx) / fx, cada landmark da dos ecuaciones LINEALES en T:
 *   Tx - u'·Tz = u'·Z - X
 *   Ty - v'·Tz = v'·Z - Y
 * y se resuelve por mínimos cuadrados (3 incógnitas). Es un PnP sólo de traslación.
 */
export function solveTranslation(
  image: Landmark[],
  world: Landmark[],
  k: Intrinsics,
  minVisibility = 0.5,
): Vec3 | null {
  // Normales A^T A (3x3) y A^T b.
  let a00 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  let used = 0;
  const n = Math.min(image.length, world.length);
  for (let i = 0; i < n; i++) {
    const img = image[i];
    const w = world[i];
    if ((img.visibility ?? 1) < minVisibility) continue;
    const u = (img.x * k.width - k.cx) / k.fx;
    const v = (img.y * k.height - k.cy) / k.fy;
    // Fila 1: [1, 0, -u] · T = u·Z - X
    const r1 = u * w.z - w.x;
    a00 += 1; a02 += -u; a22 += u * u;
    b0 += r1; b2 += -u * r1;
    // Fila 2: [0, 1, -v] · T = v·Z - Y
    const r2 = v * w.z - w.y;
    a11 += 1; a12 += -v; a22 += v * v;
    b1 += r2; b2 += -v * r2;
    used++;
  }
  if (used < 4) return null;
  const t = solve3([a00, 0, a02, 0, a11, a12, a02, a12, a22], [b0, b1, b2]);
  if (!t || !(t.z > 0.05) || !Number.isFinite(t.x + t.y + t.z)) return null;
  return t;
}

/** Resuelve M·x = b para una matriz 3x3 (fila mayor) por Cramer. */
export function solve3(m: number[], b: number[]): Vec3 | null {
  const det3 = (a: number[]) =>
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const det = det3(m);
  if (Math.abs(det) < 1e-12) return null;
  const col = (c: number) => m.map((v, i) => (i % 3 === c ? b[Math.floor(i / 3)] : v));
  return { x: det3(col(0)) / det, y: det3(col(1)) / det, z: det3(col(2)) / det };
}

/** Desplaza los world landmarks a coordenadas de cámara. */
export function toCamera(world: Landmark[], t: Vec3): Vec3[] {
  return world.map((w) => add3(w, t));
}

/**
 * Normal del plano de la mano (muñeca, base del índice y base del meñique), orientada
 * hacia la cámara. Con la mano apoyada plana sobre una mesa es la normal "arriba" de la
 * mesa, que siempre mira hacia la cámara que la está viendo.
 */
export function handPlaneNormal(cam: Vec3[]): Vec3 {
  const wrist = cam[0];
  const n = normalize3(cross3(sub3(cam[5], wrist), sub3(cam[17], wrist)));
  const c = palmCenter(cam);
  // La cámara está en el origen: la normal debe apuntar hacia -c.
  return n.x * -c.x + n.y * -c.y + n.z * -c.z >= 0 ? n : { x: -n.x, y: -n.y, z: -n.z };
}

/** Centro de la palma (promedio de muñeca y bases de los dedos). */
export function palmCenter(cam: Vec3[]): Vec3 {
  const ids = [0, 5, 9, 13, 17];
  const s = ids.reduce((acc, i) => add3(acc, cam[i]), { x: 0, y: 0, z: 0 });
  return { x: s.x / ids.length, y: s.y / ids.length, z: s.z / ids.length };
}
