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

type ArucoMarker = { id: number; corners: { x: number; y: number }[] };
type ArucoDetector = { detect(image: ImageData): ArucoMarker[] };

/**
 * Detecta marcadores en el video a baja resolución y baja frecuencia (es CPU puro).
 * Carga js-aruco2 de forma perezosa la primera vez.
 */
export class MarkerTracker {
  latest: MarkerPose | null = null;
  private detector: ArucoDetector | null = null;
  private loading = false;
  private canvas = document.createElement('canvas');
  private lastRun = 0;

  constructor(
    private maxWidth = 960,
    private intervalMs = 120,
  ) {}

  private async load() {
    this.loading = true;
    const { AR } = await import('js-aruco2');
    this.detector = new AR.Detector({ dictionaryName: 'ARUCO' });
  }

  /** Devuelve los marcadores vistos en este frame (o null si no tocaba correr). */
  update(video: HTMLVideoElement, mirrored: boolean, k: Intrinsics, sizes: Record<number, number>): MarkerPose[] | null {
    if (!this.detector) {
      if (!this.loading) void this.load();
      return null;
    }
    const now = performance.now();
    if (now - this.lastRun < this.intervalMs || video.videoWidth === 0) return null;
    this.lastRun = now;

    const scale = Math.min(1, this.maxWidth / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, w, h);
    const found = this.detector.detect(ctx.getImageData(0, 0, w, h));

    const poses: MarkerPose[] = [];
    for (const m of found) {
      const size = sizes[m.id];
      if (!size) continue;
      const corners = m.corners.map((c) => ({ x: mirrored ? 1 - c.x / w : c.x / w, y: c.y / h }));
      const pose = poseFromSquare(corners, size, k);
      if (pose) poses.push({ id: m.id, corners, ...pose });
    }
    return poses;
  }
}
