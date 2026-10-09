import { describe, expect, it } from 'vitest';
import { palmFacesCamera } from '../src/perception/gestures';
import { armsCrossed, segmentsIntersect } from '../src/perception/navigation';
import type { HandState, PerceptionFrame } from '../src/perception/types';
import { makeHand, rotate } from './helpers';

describe('palmFacesCamera', () => {
  // La mano sintética tiene el índice a la izquierda del meñique con los dedos hacia arriba.
  // En la imagen cruda eso es: mano izquierda mostrando la palma, o derecha mostrando el dorso.
  const hand = makeHand({ thumb: 'out', index: true, middle: true, ring: true, pinky: true });

  it('distingue palma de dorso según la mano', () => {
    expect(palmFacesCamera(hand, 'Left', false)).toBe(true);
    expect(palmFacesCamera(hand, 'Right', false)).toBe(false);
  });

  it('el espejado invierte la lectura', () => {
    expect(palmFacesCamera(hand, 'Right', true)).toBe(true);
    expect(palmFacesCamera(hand, 'Left', true)).toBe(false);
  });

  it('no depende de la rotación de la mano', () => {
    for (const deg of [30, 90, 160, -70]) expect(palmFacesCamera(rotate(hand, deg), 'Left', false)).toBe(true);
  });
});

describe('segmentsIntersect', () => {
  it('detecta cruces y descarta paralelos', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(false);
  });
});

/** Frame mínimo con esqueleto: brazos cruzados (X) o abiertos. */
function bodyFrame(crossed: boolean): PerceptionFrame {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  lm[0] = { x: 0.5, y: 0.2, z: 0, visibility: 1 }; // nariz
  lm[23] = { x: 0.45, y: 0.7, z: 0, visibility: 1 };
  lm[24] = { x: 0.55, y: 0.7, z: 0, visibility: 1 };
  if (crossed) {
    lm[13] = { x: 0.4, y: 0.55, z: 0, visibility: 1 }; // codo izq
    lm[15] = { x: 0.6, y: 0.35, z: 0, visibility: 1 }; // muñeca izq
    lm[14] = { x: 0.6, y: 0.55, z: 0, visibility: 1 };
    lm[16] = { x: 0.4, y: 0.35, z: 0, visibility: 1 };
  } else {
    lm[13] = { x: 0.35, y: 0.55, z: 0, visibility: 1 };
    lm[15] = { x: 0.3, y: 0.7, z: 0, visibility: 1 };
    lm[14] = { x: 0.65, y: 0.55, z: 0, visibility: 1 };
    lm[16] = { x: 0.7, y: 0.7, z: 0, visibility: 1 };
  }
  return { hands: [], body: { landmarks: lm }, mirrored: true, aspect: 16 / 9 } as unknown as PerceptionFrame;
}

const handAt = (handedness: 'Left' | 'Right', x: number): HandState =>
  ({ handedness, source: 'full', palmCenter: { x, y: 0.5 }, landmarks: [{ x, y: 0.55, z: 0 }] }) as unknown as HandState;

describe('armsCrossed', () => {
  it('con esqueleto: antebrazos cruzados delante del torso', () => {
    expect(armsCrossed(bodyFrame(true))).toBe(true);
    expect(armsCrossed(bodyFrame(false))).toBe(false);
  });

  it('sólo con manos: cada mano del lado contrario y cerca', () => {
    const frame = (l: number, r: number, mirrored = true) =>
      ({ hands: [handAt('Left', l), handAt('Right', r)], body: null, mirrored, aspect: 16 / 9 }) as unknown as PerceptionFrame;
    expect(armsCrossed(frame(0.55, 0.45))).toBe(true); // espejado: izquierda quedó a la derecha
    expect(armsCrossed(frame(0.35, 0.65))).toBe(false); // manos normales
    expect(armsCrossed(frame(0.45, 0.55, false))).toBe(true); // sin espejar es al revés
    expect(armsCrossed(frame(0.9, 0.1))).toBe(false); // cruzadas pero lejos
  });
});
