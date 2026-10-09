import { describe, expect, it } from 'vitest';
import { screenHover, screenTwoHandGrab, throwVelocity } from '../src/apps/blocks/grab';

describe('throwVelocity', () => {
  it('ignora el ruido y limita la velocidad', () => {
    expect(throwVelocity({ x: 0.05, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    const v = throwVelocity({ x: 30, y: 0, z: 40 }, 5);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(5);
  });
});

describe('agarre en pantalla', () => {
  const boxes = [
    { id: 1, x0: 0.3, x1: 0.4, y0: 0.5, y1: 0.6, depth: 0.6 },
    { id: 2, x0: 0.6, x1: 0.7, y0: 0.5, y1: 0.6, depth: 0.6 },
  ];
  it('elige el bloque bajo la mano, tolerando ruido de profundidad', () => {
    expect(screenHover({ x: 0.35, y: 0.55, depth: 0.75 }, boxes, 0.01, 0.25)).toBe(1);
    expect(screenHover({ x: 0.5, y: 0.55, depth: 0.6 }, boxes, 0.01, 0.25)).toBeNull();
  });
  it('descarta manos muy delante del bloque', () => {
    expect(screenHover({ x: 0.35, y: 0.55, depth: 0.2 }, boxes, 0.01, 0.25)).toBeNull();
  });
  it('agarre con dos manos a los costados', () => {
    expect(screenTwoHandGrab({ x: 0.59, y: 0.55, depth: 0.6 }, { x: 0.71, y: 0.56, depth: 0.6 }, boxes, 0.03, 0.3)).toBe(2);
    expect(screenTwoHandGrab({ x: 0.66, y: 0.55, depth: 0.6 }, { x: 0.69, y: 0.56, depth: 0.6 }, boxes, 0.03, 0.3)).toBeNull();
  });
});
