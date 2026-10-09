import { describe, expect, it } from 'vitest';
import { computeExpressions, headPoseFromMatrix } from '../src/perception/expressions';

describe('computeExpressions', () => {
  it('cara neutra ≈ 0', () => {
    const e = computeExpressions({});
    expect(e.smile).toBe(0);
    expect(e.mouthOpen).toBe(0);
    expect(e.wink).toBeNull();
  });

  it('detecta sonrisa, boca abierta y guiño', () => {
    const e = computeExpressions({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.6, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.05 });
    expect(e.smile).toBe(1);
    expect(e.mouthOpen).toBe(1);
    expect(e.wink).toBe('left');
    expect(e.blink).toBe(false);
  });

  it('detecta parpadeo con ambos ojos', () => {
    expect(computeExpressions({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }).blink).toBe(true);
  });
});

describe('headPoseFromMatrix', () => {
  it('matriz identidad = cabeza al frente', () => {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1];
    const p = headPoseFromMatrix(id, false);
    expect(p.yaw).toBeCloseTo(0);
    expect(p.pitch).toBeCloseTo(0);
    expect(p.roll).toBeCloseTo(0);
    expect(p.position.z).toBe(-50);
  });

  it('el espejado invierte el yaw', () => {
    const a = (30 * Math.PI) / 180;
    // Rotación alrededor de Y (column-major).
    const m = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
    const p = headPoseFromMatrix(m, false);
    const q = headPoseFromMatrix(m, true);
    expect(Math.abs(p.yaw)).toBeCloseTo(30);
    expect(q.yaw).toBeCloseTo(-p.yaw);
  });
});
