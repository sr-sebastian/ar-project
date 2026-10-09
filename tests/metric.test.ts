import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/core/math';
import { handPlaneNormal, solveTranslation, toCamera } from '../src/perception/metric';
import { intrinsicsFromFov } from '../src/perception/space/surface';
import type { Landmark } from '../src/tracking/types';

const k = intrinsicsFromFov(1280, 720, 65);

/** Proyecta puntos métricos de cámara a coordenadas normalizadas de imagen. */
const project = (p: { x: number; y: number; z: number }): Landmark => ({
  x: (k.fx * (p.x / p.z) + k.cx) / k.width,
  y: (k.fy * (p.y / p.z) + k.cy) / k.height,
  z: 0,
  visibility: 1,
});

describe('solveTranslation', () => {
  it('recupera la posición de un cuerpo a 2.5 m', () => {
    const rnd = seededRandom(5);
    // "Cuerpo" de 33 puntos en ±0.9 m alrededor de las caderas.
    const world = Array.from({ length: 33 }, () => ({ x: rnd() * 0.8 - 0.4, y: rnd() * 1.8 - 0.9, z: rnd() * 0.3 - 0.15 }));
    const T = { x: 0.3, y: 0.2, z: 2.5 };
    const image = toCamera(world, T).map(project);
    const t = solveTranslation(image, world, k)!;
    expect(t.x).toBeCloseTo(T.x, 3);
    expect(t.y).toBeCloseTo(T.y, 3);
    expect(t.z).toBeCloseTo(T.z, 3);
  });

  it('tolera ruido de píxeles en una mano a 50 cm', () => {
    const rnd = seededRandom(9);
    const world = Array.from({ length: 21 }, () => ({ x: rnd() * 0.16 - 0.08, y: rnd() * 0.18 - 0.09, z: rnd() * 0.04 - 0.02 }));
    const T = { x: -0.1, y: 0.05, z: 0.5 };
    const image = toCamera(world, T).map(project).map((l) => ({ ...l, x: l.x + (rnd() - 0.5) / 1280, y: l.y + (rnd() - 0.5) / 720 }));
    const t = solveTranslation(image, world, k)!;
    expect(Math.abs(t.z - T.z) / T.z).toBeLessThan(0.05);
  });

  it('ignora landmarks poco visibles y falla con muy pocos', () => {
    const world = Array.from({ length: 3 }, (_, i) => ({ x: i * 0.1, y: 0, z: 0 }));
    expect(solveTranslation(world.map(() => ({ x: 0.5, y: 0.5, z: 0 })), world, k)).toBeNull();
  });
});

describe('handPlaneNormal', () => {
  it('apunta hacia la cámara', () => {
    // Mano plana horizontal (normal ±y) delante y debajo de la cámara.
    const cam = Array.from({ length: 21 }, () => ({ x: 0, y: 0.3, z: 0.6 }));
    cam[0] = { x: 0, y: 0.3, z: 0.6 };
    cam[5] = { x: -0.04, y: 0.3, z: 0.69 };
    cam[17] = { x: 0.04, y: 0.3, z: 0.68 };
    const n = handPlaneNormal(cam);
    expect(Math.abs(n.y)).toBeGreaterThan(0.99);
    expect(n.y).toBeLessThan(0); // hacia arriba (y de cámara apunta abajo)
  });
});
