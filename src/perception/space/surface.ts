import { cross3, dot3, len3, normalize3, sub3, type Vec3 } from '../../core/math';

/**
 * Mapa de disparidad relativa (Depth Anything): `data[v * width + u]` en [0,1], donde
 * 1 = más cerca. Está en espacio de pantalla (espejado igual que la vista).
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

/**
 * Plano n·p + d = 0 con n unitario, en coordenadas métricas de cámara (metros; x derecha,
 * y abajo, z adelante). Convención: n apunta "hacia arriba" de la superficie (del lado
 * donde está la cámara), así que d > 0 y n·p + d es la altura de p sobre la superficie.
 */
export interface Plane {
  normal: Vec3;
  d: number;
}

export type SurfaceKind = 'floor' | 'table';

/** Intrínsecos aproximados a partir del FOV horizontal de la cámara (las webcams rondan 60–78°). */
export function intrinsicsFromFov(width: number, height: number, hfovDeg: number): Intrinsics {
  const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

export function backProject(u: number, v: number, z: number, k: Intrinsics): Vec3 {
  return { x: ((u - k.cx) / k.fx) * z, y: ((v - k.cy) / k.fy) * z, z };
}

/** Altura (con signo) de un punto sobre el plano. */
export const planeHeight = (p: Plane, x: Vec3) => dot3(p.normal, x) + p.d;
export const planeDistance = (p: Plane, x: Vec3) => Math.abs(planeHeight(p, x));

/** Proyecta un punto sobre el plano. */
export function projectOnPlane(p: Plane, x: Vec3): Vec3 {
  const h = planeHeight(p, x);
  return { x: x.x - p.normal.x * h, y: x.y - p.normal.y * h, z: x.z - p.normal.z * h };
}

/** Plano con normal `n` que pasa por `point`, orientado hacia la cámara (d > 0). */
export function planeThrough(n: Vec3, point: Vec3): Plane {
  let normal = normalize3(n);
  let d = -dot3(normal, point);
  if (d < 0) {
    normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    d = -d;
  }
  return { normal, d };
}

export function planeFrom3(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const n = cross3(sub3(b, a), sub3(c, a));
  if (len3(n) < 1e-9) return null;
  return planeThrough(n, a);
}

/** Intersección del rayo que pasa por el punto de pantalla (u, v normalizados) con un plano. */
export function rayPlane(plane: Plane, k: Intrinsics, uNorm: number, vNorm: number): Vec3 | null {
  const dir = { x: (uNorm * k.width - k.cx) / k.fx, y: (vNorm * k.height - k.cy) / k.fy, z: 1 };
  const denom = dot3(plane.normal, dir);
  if (Math.abs(denom) < 1e-6) return null;
  const t = -plane.d / denom;
  return t > 0 ? { x: dir.x * t, y: dir.y * t, z: dir.z * t } : null;
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

/**
 * Superficie supuesta cuando todavía no hay ninguna medición (en metros):
 * - piso: cámara nivelada a 1.1 m de altura.
 * - mesa: cámara inclinada `tiltDeg` hacia abajo, con la mesa cruzando el punto (0.5, 0.65)
 *   de la imagen a 0.6 m.
 */
export function defaultSurface(kind: SurfaceKind, k: Intrinsics, tiltDeg = 40): Plane {
  if (kind === 'floor') return { normal: { x: 0, y: -1, z: 0 }, d: 1.1 };
  const a = (tiltDeg * Math.PI) / 180;
  const normal = { x: 0, y: -Math.cos(a), z: -Math.sin(a) };
  const anchor = backProject(k.width * 0.5, k.height * 0.65, 0.6, k);
  return planeThrough(normal, anchor);
}

// ───────────────────── Planos en el mapa de disparidad ─────────────────────

/**
 * Ajuste lineal de la disparidad: d(u, v) = a·u + b·v + c, con (u, v) en píxeles del mapa.
 *
 * Por qué funciona: para un plano real n·X = s, la inversa de la profundidad es
 *   1/Z = (n_x·x' + n_y·y' + n_z) / s,  con x' = (u - cx)/fx, y' = (v - cy)/fy,
 * o sea LINEAL en (u, v). Depth Anything da disparidad relativa (afín, escala desconocida),
 * y una transformación afín de algo lineal sigue siendo lineal: los planos de la escena se
 * ven como regiones donde la disparidad es un plano en (u, v), sin importar la escala.
 */
export interface DisparityPlaneFit {
  a: number;
  b: number;
  c: number;
  /** Índices (v * width + u) de los píxeles muestreados que encajan. */
  inliers: number[];
  inlierRatio: number;
}

export interface DisparityFitOptions {
  /** Franja vertical normalizada donde buscar. */
  region?: [number, number];
  step?: number;
  iterations?: number;
  /** Tolerancia en unidades de disparidad (0..1). */
  threshold?: number;
  random?: () => number;
  /** Descarta planos cuya normal no cumpla esta condición. */
  accept?: (fit: { a: number; b: number; c: number }) => boolean;
}

export function fitDisparityPlane(map: DepthMap, opts: DisparityFitOptions = {}): DisparityPlaneFit | null {
  const { region = [0, 1], step = 3, iterations = 200, threshold = 0.012, random = Math.random, accept } = opts;
  const samples: { u: number; v: number; d: number; i: number }[] = [];
  const v0 = Math.floor(region[0] * map.height);
  const v1 = Math.min(map.height, Math.ceil(region[1] * map.height));
  for (let v = v0; v < v1; v += step) {
    for (let u = 0; u < map.width; u += step) {
      const i = v * map.width + u;
      const d = map.data[i];
      // El fondo muy lejano (d≈0) no aporta información de planos cercanos.
      if (d > 0.02) samples.push({ u, v, d, i });
    }
  }
  if (samples.length < 30) return null;

  let best: { a: number; b: number; c: number } | null = null;
  let bestCount = 0;
  for (let it = 0; it < iterations; it++) {
    const p = samples[Math.floor(random() * samples.length)];
    const q = samples[Math.floor(random() * samples.length)];
    const r = samples[Math.floor(random() * samples.length)];
    // Resolver d = a·u + b·v + c para 3 puntos.
    const det = p.u * (q.v - r.v) - p.v * (q.u - r.u) + (q.u * r.v - r.u * q.v);
    if (Math.abs(det) < 1e-6) continue;
    const a = (p.d * (q.v - r.v) - p.v * (q.d - r.d) + (q.d * r.v - r.d * q.v)) / det;
    const b = (p.u * (q.d - r.d) - p.d * (q.u - r.u) + (q.u * r.d - r.u * q.d)) / det;
    const c = p.d - a * p.u - b * p.v;
    if (accept && !accept({ a, b, c })) continue;
    let count = 0;
    for (const s of samples) if (Math.abs(a * s.u + b * s.v + c - s.d) < threshold) count++;
    if (count > bestCount) {
      bestCount = count;
      best = { a, b, c };
    }
  }
  if (!best) return null;

  // Refinamiento por mínimos cuadrados sobre los inliers.
  const inl = samples.filter((s) => Math.abs(best!.a * s.u + best!.b * s.v + best!.c - s.d) < threshold);
  let suu = 0, suv = 0, su = 0, svv = 0, sv = 0, n = 0, sud = 0, svd = 0, sd = 0;
  for (const s of inl) {
    suu += s.u * s.u; suv += s.u * s.v; su += s.u; svv += s.v * s.v; sv += s.v; n++;
    sud += s.u * s.d; svd += s.v * s.d; sd += s.d;
  }
  const refined = solveSym3([suu, suv, su, suv, svv, sv, su, sv, n], [sud, svd, sd]);
  const fit = refined ? { a: refined[0], b: refined[1], c: refined[2] } : best;
  return { ...fit, inliers: inl.map((s) => s.i), inlierRatio: inl.length / samples.length };
}

function solveSym3(m: number[], b: number[]): [number, number, number] | null {
  const det3 = (x: number[]) =>
    x[0] * (x[4] * x[8] - x[5] * x[7]) - x[1] * (x[3] * x[8] - x[5] * x[6]) + x[2] * (x[3] * x[7] - x[4] * x[6]);
  const det = det3(m);
  if (Math.abs(det) < 1e-9) return null;
  const col = (c: number) => m.map((v, i) => (i % 3 === c ? b[Math.floor(i / 3)] : v));
  return [det3(col(0)) / det, det3(col(1)) / det, det3(col(2)) / det];
}

/**
 * Normal del plano real (en cámara) a partir del ajuste de disparidad, suponiendo que la
 * disparidad 0 corresponde al infinito (Depth Anything normalizado con mínimo en 0).
 * Devuelve la normal orientada hacia la cámara ("arriba" de la superficie).
 */
export function normalFromDisparityFit(fit: { a: number; b: number; c: number }, k: Intrinsics): Vec3 {
  // De 1/Z = (n·(x', y', 1))/s: a = n_x/(fx·s), b = n_y/(fy·s), c = (n_z - n_x·cx/fx - n_y·cy/fy)/s.
  const n = normalize3({ x: fit.a * k.fx, y: fit.b * k.fy, z: fit.c + fit.a * k.cx + fit.b * k.cy });
  // Con s > 0 la normal n apunta lejos de la cámara: la invertimos.
  return { x: -n.x, y: -n.y, z: -n.z };
}

/** Centro (en píxeles normalizados) y extensión de la región de inliers de un ajuste. */
export function regionOf(fit: DisparityPlaneFit, map: DepthMap): { u: number; v: number; spreadU: number; spreadV: number } | null {
  if (fit.inliers.length === 0) return null;
  let su = 0, sv = 0, suu = 0, svv = 0;
  for (const i of fit.inliers) {
    const u = (i % map.width) / map.width;
    const v = Math.floor(i / map.width) / map.height;
    su += u; sv += v; suu += u * u; svv += v * v;
  }
  const n = fit.inliers.length;
  const u = su / n;
  const v = sv / n;
  return { u, v, spreadU: Math.sqrt(Math.max(0, suu / n - u * u)), spreadV: Math.sqrt(Math.max(0, svv / n - v * v)) };
}

/** Nube de puntos para visualizar (profundidad sólo relativa: Z = 1/disparidad). */
export function depthToPoints(map: DepthMap, k: Intrinsics, step = 4): Vec3[] {
  const pts: Vec3[] = [];
  for (let v = 0; v < map.height; v += step) {
    for (let u = 0; u < map.width; u += step) {
      const d = map.data[v * map.width + u];
      if (d > 0.02) pts.push(backProject(u, v, 1 / d, k));
    }
  }
  return pts;
}
