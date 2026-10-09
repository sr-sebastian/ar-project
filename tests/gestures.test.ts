import { describe, expect, it } from 'vitest';
import { classifyGesture, GestureStabilizer, PinchDetector, SwipeDetector } from '../src/perception/gestures';
import { makeHand, rotate } from './helpers';

const all = { index: true, middle: true, ring: true, pinky: true };

describe('classifyGesture', () => {
  it.each([
    ['open_palm', makeHand({ thumb: 'out', ...all })],
    ['fist', makeHand({ thumb: 'in' })],
    ['point', makeHand({ index: true })],
    ['victory', makeHand({ index: true, middle: true })],
    ['rock', makeHand({ index: true, pinky: true })],
    ['thumbs_up', makeHand({ thumb: 'up' })],
    ['thumbs_down', makeHand({ thumb: 'down' })],
  ] as const)('reconoce %s', (expected, lm) => {
    expect(classifyGesture(lm, new PinchDetector().update(lm))).toBe(expected);
  });

  it('reconoce pinch (gesto OK)', () => {
    const lm = makeHand({ thumb: 'pinch', index: true, middle: true, ring: true, pinky: true });
    const pinching = new PinchDetector().update(lm);
    expect(pinching).toBe(true);
    expect(classifyGesture(lm, pinching)).toBe('pinch');
  });

  it('es invariante a la rotación de la mano', () => {
    for (const deg of [45, 90, 180, -60]) {
      expect(classifyGesture(rotate(makeHand({ thumb: 'out', ...all }), deg), false)).toBe('open_palm');
      expect(classifyGesture(rotate(makeHand({ index: true, middle: true }), deg), false)).toBe('victory');
    }
  });
});

describe('PinchDetector', () => {
  it('tiene histéresis', () => {
    const d = new PinchDetector(0.3, 0.45);
    const closed = makeHand({ thumb: 'pinch', index: true });
    const open = makeHand({ thumb: 'out', index: true });
    expect(d.update(closed)).toBe(true);
    expect(d.update(open)).toBe(false);
  });
});

describe('GestureStabilizer', () => {
  it('ignora gestos de un solo frame', () => {
    const s = new GestureStabilizer(3);
    expect(s.update('fist')).toBe('none');
    expect(s.update('fist')).toBe('none');
    expect(s.update('open_palm')).toBe('none');
    s.update('fist');
    s.update('fist');
    expect(s.update('fist')).toBe('fist');
  });
});

describe('SwipeDetector', () => {
  it('detecta dirección y respeta el cooldown', () => {
    const s = new SwipeDetector(2, 0.5);
    expect(s.update(0.5, 0, 0)).toBeNull();
    expect(s.update(3, 0.2, 1)).toBe('right');
    expect(s.update(-3, 0, 1.2)).toBeNull();
    expect(s.update(0, -3, 2)).toBe('up');
  });
});
