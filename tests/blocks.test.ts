import { describe, expect, it } from 'vitest';
import { findOneHandGrab, findTwoHandGrab, throwVelocity, twoHandReleased, type GrabBlock } from '../src/apps/blocks/grab';

const block = (id: number, x: number, size = 0.3): GrabBlock => ({ id, center: { x, y: size / 2, z: 0 }, radius: (size * Math.sqrt(3)) / 2, inner: size / 2 });

describe('agarre con una mano', () => {
  const blocks = [block(1, 0), block(2, 1)];
  it('agarra el bloque más cercano sólo con la mano cerrada', () => {
    expect(findOneHandGrab({ id: 'Right', pos: { x: 0.1, y: 0.2, z: 0 }, closed: true }, blocks, 0.05)).toBe(1);
    expect(findOneHandGrab({ id: 'Right', pos: { x: 0.1, y: 0.2, z: 0 }, closed: false }, blocks, 0.05)).toBeNull();
  });
  it('no agarra si la mano está lejos', () => {
    expect(findOneHandGrab({ id: 'Right', pos: { x: 0.5, y: 1, z: 0 }, closed: true }, blocks, 0.05)).toBeNull();
  });
});

describe('agarre con dos manos / abrazo', () => {
  const blocks = [block(7, 0, 0.4)];
  it('agarra con las manos a lados opuestos', () => {
    const l = { id: 'Left' as const, pos: { x: -0.22, y: 0.2, z: 0 }, closed: false };
    const r = { id: 'Right' as const, pos: { x: 0.22, y: 0.2, z: 0 }, closed: false };
    expect(findTwoHandGrab(l, r, blocks, 0.1)).toBe(7);
  });
  it('no agarra con las dos manos del mismo lado', () => {
    const l = { id: 'Left' as const, pos: { x: 0.2, y: 0.25, z: 0 }, closed: false };
    const r = { id: 'Right' as const, pos: { x: 0.22, y: 0.15, z: 0.05 }, closed: false };
    expect(findTwoHandGrab(l, r, blocks, 0.1)).toBeNull();
  });
  it('suelta al separar las manos', () => {
    expect(twoHandReleased({ x: -0.2, y: 0, z: 0 }, { x: 0.2, y: 0, z: 0 }, 0.4)).toBe(false);
    expect(twoHandReleased({ x: -0.4, y: 0, z: 0 }, { x: 0.4, y: 0, z: 0 }, 0.4)).toBe(true);
  });
});

describe('throwVelocity', () => {
  it('ignora el ruido y limita la velocidad', () => {
    expect(throwVelocity({ x: 0.05, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    const v = throwVelocity({ x: 30, y: 0, z: 40 }, 5);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(5);
  });
});
