import { describe, expect, it } from 'vitest';
import { angleAt, seededRandom, segmentPointDistance } from '../src/core/math';
import { OneEuroFilter } from '../src/tracking/OneEuroFilter';
import { deviceUpToCamera } from '../src/phone/motion';

describe('OneEuroFilter', () => {
  it('reduce el jitter de una señal quieta', () => {
    const f = new OneEuroFilter(1, 0.01);
    const rnd = seededRandom(1);
    let rawVar = 0;
    let filtVar = 0;
    for (let i = 0; i < 300; i++) {
      const noise = (rnd() - 0.5) * 0.02;
      const y = f.filter(0.5 + noise, i / 30);
      if (i > 30) {
        rawVar += noise ** 2;
        filtVar += (y - 0.5) ** 2;
      }
    }
    expect(filtVar).toBeLessThan(rawVar * 0.5);
  });

  it('sigue un salto grande con poca latencia', () => {
    const f = new OneEuroFilter(1, 0.5);
    f.filter(0, 0);
    let y = 0;
    for (let i = 1; i <= 10; i++) y = f.filter(1, i / 30);
    expect(y).toBeGreaterThan(0.9);
  });
});

describe('geometría', () => {
  it('segmentPointDistance', () => {
    expect(segmentPointDistance({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(1);
    expect(segmentPointDistance({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 })).toBeCloseTo(1);
    expect(segmentPointDistance({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 })).toBeCloseTo(1);
  });

  it('angleAt', () => {
    expect(angleAt({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(90);
    expect(angleAt({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })).toBeCloseTo(180);
  });
});

describe('deviceUpToCamera', () => {
  it('celular vertical, cámara trasera: arriba = -y de la cámara', () => {
    const up = deviceUpToCamera({ x: 0, y: 9.8, z: 0 }, 0, 'environment');
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(-1);
    expect(up.z).toBeCloseTo(0);
  });

  it('celular apoyado mirando hacia abajo: arriba = -z de la cámara', () => {
    // Pantalla hacia arriba: el acelerómetro mide +z; la cámara trasera mira al piso.
    const up = deviceUpToCamera({ x: 0, y: 0, z: 9.8 }, 0, 'environment');
    expect(up.z).toBeCloseTo(-1);
  });

  it('apaisado (90°): la vertical pasa a venir del eje x del dispositivo', () => {
    const up = deviceUpToCamera({ x: 9.8, y: 0, z: 0 }, 90, 'environment');
    expect(up.y).toBeCloseTo(-1);
  });
});
