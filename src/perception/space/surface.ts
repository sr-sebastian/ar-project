import { cross3, dot3, len3, normalize3, sub3, type Vec3 } from '../../core/math';

/**
 * Mapa de profundidad relativo (Depth Anything): `data[v * width + u]` en [0,1],
 * donde 1 = más cerca. Está en espacio de pantalla (espejado igual que la vista).
 */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** Plano n·p + d = 0 con n unitario. Coordenadas de cámara: x derecha, y abajo, z hacia adelante. */
export interface Plane {
  normal: Vec3;
  d: number;
}

export interface SurfaceEstimate {
  plane: Plane;
  /** Fracción de puntos candidatos que caen en el plano. */
  inlierRatio: number;
  /** 0..1, combina inliers y alineación con la vertical. */
  confidence: number;
}

/** Intrínsecos aproximados a partir del FOV horizontal de la cámara (las webcams rondan 60–78°). */
export function intrinsicsFromFov(width: number, height: number, hfovDeg: number): Intrinsics {
  const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

/**
 * Depth Anything devuelve disparidad relativa (afín). Esta conversión da una profundidad
 * "pseudo-métrica" monótona, suficiente para orientar planos y ordenar objetos.
 */
export const depthFromDisparity = (disp: number) => 1 / (0.08 + disp);

export function backProject(u: number, v: number, z: number, k: Intrinsics): Vec3 {
  return { x: ((u - k.cx) / k.fx) * z, y: ((v - k.cy) / k.fy) * z, z };
}

/** Nube de puntos submuestreada del mapa de profundidad. `region` limita a una franja vertical [v0, v1] normalizada. */
export function depthToPoints(map: DepthMap, k: Intrinsics, step = 4, region: [number, number] = [0, 1]): Vec3[] {
  const pts: Vec3[] = [];
  const v0 = Math.floor(region[0] * map.height);
  const v1 = Math.ceil(region[1] * map.height);
  for (let v = v0; v < v1; v += step) {
    for (let u = 0; u < map.width; u += step) {
      const disp = map.data[v * map.width + u];
      pts.push(backProject(u, v, depthFromDisparity(disp), k));
    }
  }
  return pts;
}

export function planeFrom3(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const n = cross3(sub3(b, a), sub3(c, a));
  if (len3(n) < 1e-9) return null;
  const normal = normalize3(n);
  return { normal, d: -dot3(normal, a) };
}

export const planeDistance = (p: Plane, x: Vec3) => Math.abs(dot3(p.normal, x) + p.d);

export interface RansacOptions {
  iterations?: number;
  /** Umbral de distancia para contar un inlier (en unidades de la nube). */
  threshold?: number;
  /** Si se da, el plano debe tener la normal a menos de `maxAngleDeg` de este vector. */
  up?: Vec3;
  maxAngleDeg?: number;
  random?: () => number;
}

/** Ajuste robusto de un plano con RANSAC + refinamiento por mínimos cuadrados de los inliers. */
export function fitPlaneRansac(points: Vec3[], opts: RansacOptions = {}): { plane: Plane; inliers: number } | null {
  const { iterations = 150, threshold = 0.05, up, maxAngleDeg = 30, random = Math.random } = opts;
  if (points.length < 3) return null;
  const minCos = Math.cos((maxAngleDeg * Math.PI) / 180);
  let best: Plane | null = null;
  let bestCount = 0;

  for (let i = 0; i < iterations; i++) {
    const a = points[Math.floor(random() * points.length)];
    const b = points[Math.floor(random() * points.length)];
    const c = points[Math.floor(random() * points.length)];
    let plane = planeFrom3(a, b, c);
    if (!plane) continue;
    if (up) {
      const cos = dot3(plane.normal, up);
      if (Math.abs(cos) < minCos) continue;
      // Orientamos la normal hacia "arriba" para que sea consistente.
      if (cos < 0) plane = { normal: { x: -plane.normal.x, y: -plane.normal.y, z: -plane.normal.z }, d: -plane.d };
    }
    let count = 0;
    for (const p of points) if (planeDistance(plane, p) < threshold) count++;
    if (count > bestCount) {
      bestCount = count;
      best = plane;
    }
  }
  if (!best) return null;
  const refined = refinePlane(points.filter((p) => planeDistance(best!, p) < threshold), best);
  return { plane: refined, inliers: bestCount };
}

/** Mínimos cuadrados (componente principal de menor varianza) sobre los inliers. */
function refinePlane(points: Vec3[], fallback: Plane): Plane {
  if (points.length < 3) return fallback;
  const c = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
  c.x /= points.length;
  c.y /= points.length;
  c.z /= points.length;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const r = sub3(p, c);
    xx += r.x * r.x; xy += r.x * r.y; xz += r.x * r.z;
    yy += r.y * r.y; yz += r.y * r.z; zz += r.z * r.z;
  }
  // La normal es el vector propio de menor valor propio; lo buscamos como el eje de
  // mayor determinante del menor 2x2 (método clásico, robusto para nubes casi planas).
  const detX = yy * zz - yz * yz;
  const detY = xx * zz - xz * xz;
  const detZ = xx * yy - xy * xy;
  const max = Math.max(detX, detY, detZ);
  if (max <= 0) return fallback;
  let n: Vec3;
  if (max === detX) n = { x: detX, y: xz * yz - xy * zz, z: xy * yz - xz * yy };
  else if (max === detY) n = { x: xz * yz - xy * zz, y: detY, z: xy * xz - yz * xx };
  else n = { x: xy * yz - xz * yy, y: xy * xz - yz * xx, z: detZ };
  let normal = normalize3(n);
  if (dot3(normal, fallback.normal) < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
  return { normal, d: -dot3(normal, c) };
}

export type SurfaceKind = 'floor' | 'table';

/**
 * Estima la superficie de juego proyectando a 3D una franja de la imagen y buscando el
 * plano dominante cuya normal apunte "hacia arriba".
 * - `floor` (modo cuerpo completo): mitad inferior de la imagen, plano casi horizontal
 *   respecto a una cámara nivelada.
 * - `table` (modo mesa): la cámara mira la mesa en diagonal o desde arriba, así que la
 *   mesa ocupa gran parte de la imagen y su normal puede estar muy inclinada.
 * `up` es la vertical en coordenadas de cámara; con el celular se usa la gravedad real.
 */
export function estimateSurface(
  map: DepthMap,
  k: Intrinsics,
  kind: SurfaceKind,
  up: Vec3 = { x: 0, y: -1, z: 0 },
  random?: () => number,
): SurfaceEstimate | null {
  const region: [number, number] = kind === 'floor' ? [0.55, 1] : [0.3, 1];
  const pts = depthToPoints(map, k, 4, region);
  if (pts.length < 30) return null;
  const zs = pts.map((p) => p.z).sort((a, b) => a - b);
  const medianZ = zs[Math.floor(zs.length / 2)];
  const res = fitPlaneRansac(pts, {
    threshold: medianZ * 0.03,
    up: normalize3(up),
    maxAngleDeg: kind === 'floor' ? 40 : 75,
    random,
  });
  if (!res) return null;
  const inlierRatio = res.inliers / pts.length;
  const alignment = kind === 'floor' ? Math.abs(dot3(res.plane.normal, normalize3(up))) : 1;
  return { plane: res.plane, inlierRatio, confidence: Math.min(1, inlierRatio * 2) * alignment };
}

/** Intersección del rayo que pasa por el punto de pantalla (u, v normalizados) con un plano. */
export function rayPlane(plane: Plane, k: Intrinsics, uNorm: number, vNorm: number): Vec3 | null {
  const dir = { x: (uNorm * k.width - k.cx) / k.fx, y: (vNorm * k.height - k.cy) / k.fy, z: 1 };
  const denom = dot3(plane.normal, dir);
  if (Math.abs(denom) < 1e-6) return null;
  const t = -plane.d / denom;
  return t > 0 ? { x: dir.x * t, y: dir.y * t, z: dir.z * t } : null;
}

/**
 * Altura de pantalla (0..1) donde el piso está a la profundidad `z` en la columna `uNorm`.
 * Sirve para "apoyar" objetos virtuales a la distancia del jugador.
 */
export function floorScreenY(floor: Plane, k: Intrinsics, uNorm: number, z: number): number | null {
  const n = floor.normal;
  if (Math.abs(n.y) < 1e-3) return null;
  const x = ((uNorm * k.width - k.cx) / k.fx) * z;
  const y = -(floor.d + n.x * x + n.z * z) / n.y;
  const v = (y / z) * k.fy + k.cy;
  return v / k.height;
}

/** Profundidad pseudo-métrica en un punto de pantalla normalizado. */
export function sampleDepth(map: DepthMap, uNorm: number, vNorm: number): number {
  const u = Math.min(map.width - 1, Math.max(0, Math.round(uNorm * (map.width - 1))));
  const v = Math.min(map.height - 1, Math.max(0, Math.round(vNorm * (map.height - 1))));
  return depthFromDisparity(map.data[v * map.width + u]);
}

/**
 * Plano supuesto cuando todavía no hay mapa de profundidad (o está desactivado):
 * - piso: cámara nivelada, piso ~1.2 unidades por debajo de la cámara.
 * - mesa: cámara inclinada `tiltDeg` hacia abajo, mesa cruzando el centro inferior de la imagen.
 * Usa las mismas unidades pseudo-métricas que `depthFromDisparity`.
 */
export function defaultSurface(kind: SurfaceKind, k: Intrinsics, tiltDeg = 40): Plane {
  if (kind === 'floor') return { normal: { x: 0, y: -1, z: 0 }, d: 1.2 };
  const a = (tiltDeg * Math.PI) / 180;
  const normal = { x: 0, y: -Math.cos(a), z: -Math.sin(a) };
  // Punto de anclaje: rayo por (0.5, 0.65) a profundidad 1.5.
  const z = 1.5;
  const anchor = backProject(k.width * 0.5, k.height * 0.65, z, k);
  return { normal, d: -dot3(normal, anchor) };
}

/** Interpola dos planos (suavizado temporal de la estimación). */
export function blendPlanes(a: Plane, b: Plane, t: number): Plane {
  const n = normalize3({
    x: a.normal.x + (b.normal.x - a.normal.x) * t,
    y: a.normal.y + (b.normal.y - a.normal.y) * t,
    z: a.normal.z + (b.normal.z - a.normal.z) * t,
  });
  return { normal: n, d: a.d + (b.d - a.d) * t };
}
