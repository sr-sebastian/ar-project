import { cross3, dot3, normalize3, scale3, type Vec2, type Vec3 } from '../../core/math';
import type { Intrinsics } from './surface';

/**
 * Marcadores impresos (ArUco, diccionario "ARUCO" 5×5) para fijar superficies con
 * precisión métrica. Se imprimen desde `marcador.html`:
 *   id 107 → mesa (cuadrado negro de 10 cm)
 *   id 185 → piso (cuadrado negro de 18 cm, entra en una hoja A4)
 */
export const MARKER_IDS = { table: 107, floor: 185 } as const;
export const DEFAULT_MARKER_SIZES = { table: 0.1, floor: 0.18 };

export interface MarkerPose {
  id: number;
  /** Centro del marcador (m, cámara). */
  center: Vec3;
  /** Normal del marcador orientada hacia la cámara. */
  normal: Vec3;
  /** Eje "derecha" del marcador impreso (para orientar tableros). */
  xAxis: Vec3;
  /** Esquinas en coordenadas normalizadas de pantalla (para dibujar). */
  corners: Vec2[];
}

/** Resuelve A·x = b (n×n) por eliminación gaussiana con pivoteo parcial. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Homografía 3×3 (fila mayor, h33 = 1) que lleva `src[i]` a `dst[i]` (4 puntos, DLT).
 */
export function homography(src: Vec2[], dst: Vec2[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return h ? [...h, 1] : null;
}

/**
 * Pose de un cuadrado de lado `size` (m) a partir de sus 4 esquinas en pantalla
 * (normalizadas, en el orden del detector: sup-izq, sup-der, inf-der, inf-izq del marcador).
 *
 * Con coordenadas normalizadas de cámara, la homografía plano→imagen es H = λ[r1 r2 t]:
 * las dos primeras columnas son los ejes del marcador y la tercera, su centro.
 */
export function poseFromSquare(corners: Vec2[], size: number, k: Intrinsics): Omit<MarkerPose, 'id' | 'corners'> | null {
  const h = size / 2;
  const model: Vec2[] = [
    { x: -h, y: -h },
    { x: h, y: -h },
    { x: h, y: h },
    { x: -h, y: h },
  ];
  const image = corners.map((c) => ({ x: (c.x * k.width - k.cx) / k.fx, y: (c.y * k.height - k.cy) / k.fy }));
  const H = homography(model, image);
  if (!H) return null;
  const h1 = { x: H[0], y: H[3], z: H[6] };
  const h2 = { x: H[1], y: H[4], z: H[7] };
  const h3 = { x: H[2], y: H[5], z: H[8] };
  const n1 = Math.hypot(h1.x, h1.y, h1.z);
  const n2 = Math.hypot(h2.x, h2.y, h2.z);
  let lambda = 2 / (n1 + n2);
  // El centro debe quedar delante de la cámara.
  if (h3.z * lambda < 0) lambda = -lambda;
  const r1 = normalize3(scale3(h1, lambda));
  const r2 = normalize3(scale3(h2, lambda));
  const center = scale3(h3, lambda);
  let normal = normalize3(cross3(r1, r2));
  if (dot3(normal, center) > 0) normal = scale3(normal, -1);
  if (!(center.z > 0.05)) return null;
  return { center, normal, xAxis: r1 };
}

/**
 * Distancia focal (en píxeles) a partir de un cuadrado visto en perspectiva.
 *
 * Con esquinas en píxeles centrados (u - cx, v - cy) la homografía es H = λ·K·[r1 r2 t],
 * K = diag(f, f, 1). Como r1 ⟂ r2 y |r1| = |r2|, para h1 y h2 (columnas de H):
 *   (h1x·h2x + h1y·h2y)/f² + h1z·h2z = 0
 *   (h1x² + h1y² − h2x² − h2y²)/f² = h2z² − h1z²
 * Cada ecuación da f² cuando el marcador está inclinado (si está de frente, la
 * perspectiva desaparece y f queda indeterminada → null).
 */
export function focalFromSquare(cornersPx: Vec2[], cx: number, cy: number): number | null {
  const model: Vec2[] = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  const H = homography(
    model,
    cornersPx.map((c) => ({ x: c.x - cx, y: c.y - cy })),
  );
  if (!H) return null;
  const [h1x, h2x, , h1y, h2y, , h1z, h2z] = H;
  const estimates: { f2: number; w: number }[] = [];
  const d1 = h1z * h2z;
  if (Math.abs(d1) > 1e-9) {
    const f2 = -(h1x * h2x + h1y * h2y) / d1;
    estimates.push({ f2, w: Math.abs(d1) });
  }
  const d2 = h2z * h2z - h1z * h1z;
  if (Math.abs(d2) > 1e-9) {
    const f2 = (h1x * h1x + h1y * h1y - h2x * h2x - h2y * h2y) / d2;
    estimates.push({ f2, w: Math.abs(d2) });
  }
  const valid = estimates.filter((e) => e.f2 > 0 && Number.isFinite(e.f2));
  if (valid.length === 0) return null;
  // Promedio ponderado por lo bien condicionada que está cada ecuación.
  const wsum = valid.reduce((s, e) => s + e.w, 0);
  const f = Math.sqrt(valid.reduce((s, e) => s + e.f2 * e.w, 0) / wsum);
  // Sin perspectiva suficiente, las ecuaciones son casi 0/0: descartamos.
  const tilt = Math.max(Math.abs(h1z), Math.abs(h2z)) * f;
  if (tilt < 0.25) return null;
  return f;
}

/** FOV horizontal (grados) a partir de la distancia focal en píxeles y el ancho de la imagen. */
export const hfovFromFocal = (f: number, width: number) => (2 * Math.atan(width / 2 / f) * 180) / Math.PI;

type ArucoMarker = { id: number; corners: { x: number; y: number }[] };
type ArucoDetector = { detect(image: ImageData): ArucoMarker[] };

export interface MarkerDetection {
  poses: MarkerPose[];
  /** Estimaciones de la distancia focal (px del video) con los marcadores inclinados. */
  focals: number[];
}

/**
 * Detecta marcadores en el video. Busca en toda la imagen (reducida a ≤1280 px) cada
 * ~250 ms; cuando ya encontró uno, lo sigue con un recorte a RESOLUCIÓN COMPLETA alrededor
 * de su última posición (esquinas mucho más precisas, sobre todo de lejos y en ángulo).
 * Carga js-aruco2 de forma perezosa la primera vez.
 */
export class MarkerTracker {
  private detector: ArucoDetector | null = null;
  private loading = false;
  private canvas = document.createElement('canvas');
  private lastRun = 0;
  private lastGlobal = 0;
  /** Última caja del marcador en píxeles del video crudo (sin espejar). */
  private box: { x0: number; y0: number; x1: number; y1: number; t: number } | null = null;

  constructor(
    private maxWidth = 1280,
    private intervalMs = 90,
    private globalIntervalMs = 250,
  ) {}

  private async load() {
    this.loading = true;
    const { AR } = await import('js-aruco2');
    this.detector = new AR.Detector({ dictionaryName: 'ARUCO' });
  }

  private detectIn(video: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number, scale: number) {
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    // Esquinas → píxeles del video crudo.
    return this.detector!.detect(ctx.getImageData(0, 0, w, h)).map((m) => ({
      id: m.id,
      corners: m.corners.map((c) => ({ x: sx + c.x / scale, y: sy + c.y / scale })),
    }));
  }

  /** Devuelve los marcadores vistos (o null si no tocaba analizar este frame). */
  update(video: HTMLVideoElement, mirrored: boolean, k: Intrinsics, sizes: Record<number, number>): MarkerDetection | null {
    if (!this.detector) {
      if (!this.loading) void this.load();
      return null;
    }
    const now = performance.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (now - this.lastRun < this.intervalMs || vw === 0) return null;
    this.lastRun = now;

    let found: ArucoMarker[] = [];
    const box = this.box && now - this.box.t < 1500 ? this.box : null;
    if (box) {
      // Seguimiento: recorte a resolución completa (hasta ~900 px de lado).
      const bw = box.x1 - box.x0;
      const bh = box.y1 - box.y0;
      const pad = Math.max(bw, bh) * 1.2 + 40;
      const sx = Math.max(0, box.x0 - pad);
      const sy = Math.max(0, box.y0 - pad);
      const sw = Math.min(vw, box.x1 + pad) - sx;
      const sh = Math.min(vh, box.y1 + pad) - sy;
      const scale = Math.min(1.5, 900 / Math.max(sw, sh));
      found = this.detectIn(video, sx, sy, sw, sh, scale).filter((m) => sizes[m.id]);
    }
    if (found.length === 0 && (now - this.lastGlobal > this.globalIntervalMs || !box)) {
      this.lastGlobal = now;
      found = this.detectIn(video, 0, 0, vw, vh, Math.min(1, this.maxWidth / vw)).filter((m) => sizes[m.id]);
    }

    const poses: MarkerPose[] = [];
    const focals: number[] = [];
    for (const m of found) {
      const size = sizes[m.id];
      const xs = m.corners.map((c) => c.x);
      const ys = m.corners.map((c) => c.y);
      this.box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), t: now };
      // El espejado es una reflexión: también hay que invertir el orden de las esquinas
      // para que sigan siendo sup-izq, sup-der, inf-der, inf-izq del marcador.
      const px = m.corners.map((c) => ({ x: mirrored ? vw - c.x : c.x, y: c.y }));
      const ordered = mirrored ? [px[1], px[0], px[3], px[2]] : px;
      const corners = ordered.map((c) => ({ x: c.x / vw, y: c.y / vh }));
      const pose = poseFromSquare(corners, size, k);
      if (pose) poses.push({ id: m.id, corners, ...pose });
      const f = focalFromSquare(ordered, vw / 2, vh / 2);
      if (f) focals.push(f);
    }
    return { poses, focals };
  }
}
