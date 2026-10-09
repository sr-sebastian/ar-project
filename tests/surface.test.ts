import { describe, expect, it } from 'vitest';
import { dot3, normalize3, seededRandom, type Vec3 } from '../src/core/math';
import { FloorFromBody, TableFromPalm } from '../src/perception/space/calibration';
import {
  defaultSurface,
  fitDisparityPlane,
  intrinsicsFromFov,
  normalFromDisparityFit,
  planeHeight,
  planeThrough,
  rayPlane,
  regionOf,
  type DepthMap,
} from '../src/perception/space/surface';

/** Mapa de disparidad (afín: escala y desplazamiento arbitrarios) de una cámara viendo un plano. */
function renderPlane(normal: Vec3, d: number, scale = 0.7, width = 64, height = 48, hfov = 65): DepthMap {
  const k = intrinsicsFromFov(width, height, hfov);
  const data = new Float32Array(width * height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const p = rayPlane({ normal, d }, k, u / width, v / height);
      data[v * width + u] = p && p.z < 20 ? scale / p.z : 0;
    }
  }
  // Igual que el worker: dividir por el máximo.
  const max = data.reduce((m, x) => Math.max(m, x), 0);
  for (let i = 0; i < data.length; i++) data[i] /= max;
  return { width, height, data };
}

describe('fitDisparityPlane + normalFromDisparityFit', () => {
  it('recupera la normal de una mesa vista en diagonal, sin conocer la escala', () => {
    const tilt = (50 * Math.PI) / 180;
    const normal = normalize3({ x: 0.1, y: -Math.cos(tilt), z: -Math.sin(tilt) });
    for (const scale of [0.3, 0.7]) {
      const map = renderPlane(normal, 0.5, scale);
      const k = intrinsicsFromFov(map.width, map.height, 65);
      const fit = fitDisparityPlane(map, { random: seededRandom(3) })!;
      expect(fit.inlierRatio).toBeGreaterThan(0.9);
      expect(dot3(normalFromDisparityFit(fit, k), normal)).toBeGreaterThan(0.995);
    }
  });

  it('separa la mesa de un objeto encima', () => {
    const tilt = (45 * Math.PI) / 180;
    const normal = normalize3({ x: 0, y: -Math.cos(tilt), z: -Math.sin(tilt) });
    const map = renderPlane(normal, 0.5);
    // Una "caja" más cerca en el centro de la imagen.
    for (let v = 18; v < 30; v++) for (let u = 26; u < 38; u++) map.data[v * map.width + u] = 0.95;
    const k = intrinsicsFromFov(map.width, map.height, 65);
    const fit = fitDisparityPlane(map, { random: seededRandom(1) })!;
    expect(dot3(normalFromDisparityFit(fit, k), normal)).toBeGreaterThan(0.99);
    const r = regionOf(fit, map)!;
    expect(r.u).toBeGreaterThan(0.3);
    expect(r.u).toBeLessThan(0.7);
  });
});

describe('FloorFromBody', () => {
  it('pone el piso bajo los pies con la vertical del cuerpo', () => {
    // Cuerpo de pie a 2.5 m, cámara 1 m por encima de las caderas (y abajo).
    const cam: Vec3[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 2.5 }));
    const vis = new Array(33).fill(0);
    const set = (i: number, p: Vec3) => {
      cam[i] = p;
      vis[i] = 1;
    };
    set(11, { x: -0.2, y: 0.4, z: 2.5 });
    set(12, { x: 0.2, y: 0.4, z: 2.5 });
    set(27, { x: -0.1, y: 1.9, z: 2.5 });
    set(28, { x: 0.1, y: 1.9, z: 2.5 });
    set(29, { x: -0.1, y: 1.95, z: 2.45 });
    set(30, { x: 0.1, y: 1.95, z: 2.45 });
    const floor = new FloorFromBody();
    for (let i = 0; i < 30; i++) floor.update(cam, vis, null);
    const p = floor.plane!;
    expect(p.normal.y).toBeLessThan(-0.99);
    expect(planeHeight(p, { x: 0, y: 1.95, z: 2.5 })).toBeCloseTo(0, 2);
    // La cámara (origen) queda 1.95 m sobre el piso.
    expect(p.d).toBeCloseTo(1.95, 1);
  });
});

describe('TableFromPalm', () => {
  const n = normalize3({ x: 0, y: -0.7, z: -0.7 });
  const center = { x: 0, y: 0.25, z: 0.55 };

  it('calibra tras sostener la mano quieta 1 s', () => {
    const cal = new TableFromPalm(1, 0.02);
    let done = false;
    for (let i = 0; i <= 35 && !done; i++) done = cal.update({ center, normal: n, speed: 0.01, flat: true }, i / 30);
    expect(done).toBe(true);
    const p = cal.plane!;
    expect(dot3(p.normal, n)).toBeGreaterThan(0.999);
    // La palma queda 2 cm por encima de la mesa.
    expect(planeHeight(p, center)).toBeCloseTo(0.02, 3);
  });

  it('se reinicia si la mano se mueve', () => {
    const cal = new TableFromPalm(1);
    for (let i = 0; i < 20; i++) cal.update({ center, normal: n, speed: 0.01, flat: true }, i / 30);
    cal.update({ center, normal: n, speed: 0.5, flat: true }, 0.7);
    expect(cal.progress).toBe(0);
    expect(cal.plane).toBeNull();
  });
});

describe('superficies supuestas', () => {
  const k = intrinsicsFromFov(640, 480, 65);
  it('el piso queda 1.1 m bajo la cámara', () => {
    const p = defaultSurface('floor', k);
    expect(planeHeight(p, { x: 0, y: 0, z: 0 })).toBeCloseTo(1.1);
  });

  it('la mesa cruza el anclaje de pantalla a 0.6 m', () => {
    const p = defaultSurface('table', k, 40);
    expect(rayPlane(p, k, 0.5, 0.65)!.z).toBeCloseTo(0.6);
    expect(p.d).toBeGreaterThan(0);
  });

  it('planeThrough orienta la normal hacia la cámara', () => {
    const p = planeThrough({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 2 });
    expect(p.normal.y).toBe(-1);
    expect(p.d).toBe(1);
  });
});
