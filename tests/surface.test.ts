import { describe, expect, it } from 'vitest';
import { dot3, normalize3, seededRandom, type Vec3 } from '../src/core/math';
import {
  defaultSurface,
  depthFromDisparity,
  estimateSurface,
  fitPlaneRansac,
  floorScreenY,
  intrinsicsFromFov,
  rayPlane,
  type DepthMap,
} from '../src/perception/space/surface';

describe('fitPlaneRansac', () => {
  it('recupera un plano con 30% de outliers', () => {
    const rnd = seededRandom(42);
    const pts: Vec3[] = [];
    for (let i = 0; i < 400; i++) {
      // Piso y = 1 (cámara: y hacia abajo) con algo de ruido.
      pts.push({ x: rnd() * 4 - 2, y: 1 + (rnd() - 0.5) * 0.01, z: 1 + rnd() * 4 });
    }
    for (let i = 0; i < 170; i++) pts.push({ x: rnd() * 4 - 2, y: rnd() * 2 - 1, z: 1 + rnd() * 4 });
    const res = fitPlaneRansac(pts, { threshold: 0.03, up: { x: 0, y: -1, z: 0 }, random: rnd })!;
    expect(res).not.toBeNull();
    expect(res.plane.normal.y).toBeLessThan(-0.99);
    // n·p + d = 0 con n ≈ (0,-1,0) y p.y = 1 → d ≈ 1
    expect(res.plane.d).toBeCloseTo(1, 1);
  });

  it('rechaza planos que no son horizontales', () => {
    const pts: Vec3[] = [];
    for (let i = 0; i < 100; i++) pts.push({ x: 1, y: Math.sin(i), z: 1 + (i % 10) });
    expect(fitPlaneRansac(pts, { up: { x: 0, y: -1, z: 0 }, maxAngleDeg: 30, random: seededRandom(1) })).toBeNull();
  });
});

/** Genera el mapa de disparidad que vería una cámara mirando un plano. */
function renderPlane(normal: Vec3, d: number, width = 64, height = 48, hfov = 65): DepthMap {
  const k = intrinsicsFromFov(width, height, hfov);
  const data = new Float32Array(width * height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const p = rayPlane({ normal, d }, k, u / width, v / height);
      // Invertimos depthFromDisparity: disp = 1/z - 0.08 (cielo/lejos = 0).
      data[v * width + u] = p && p.z < 12 ? Math.max(0, 1 / p.z - 0.08) : 0;
    }
  }
  return { width, height, data };
}

describe('estimateSurface', () => {
  it('detecta una mesa vista en diagonal', () => {
    const tilt = (45 * Math.PI) / 180;
    const normal = normalize3({ x: 0, y: -Math.cos(tilt), z: -Math.sin(tilt) });
    const map = renderPlane(normal, 1);
    const k = intrinsicsFromFov(map.width, map.height, 65);
    const est = estimateSurface(map, k, 'table', undefined, seededRandom(3))!;
    expect(est).not.toBeNull();
    expect(dot3(est.plane.normal, normal)).toBeGreaterThan(0.98);
    expect(est.inlierRatio).toBeGreaterThan(0.8);
  });

  it('el piso supuesto queda debajo de la cámara', () => {
    const k = intrinsicsFromFov(640, 480, 65);
    const p = defaultSurface('floor', k);
    // Punto del piso a 3 unidades: debe estar en la mitad inferior de la imagen.
    const y = floorScreenY(p, k, 0.5, 3)!;
    expect(y).toBeGreaterThan(0.5);
  });

  it('la mesa supuesta cruza el anclaje en pantalla', () => {
    const k = intrinsicsFromFov(640, 480, 65);
    const p = defaultSurface('table', k, 40);
    const hit = rayPlane(p, k, 0.5, 0.65)!;
    expect(hit.z).toBeCloseTo(1.5);
    expect(depthFromDisparity(0)).toBeCloseTo(12.5);
  });
});
