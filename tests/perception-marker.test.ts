import { describe, expect, it } from 'vitest';
import { normalize3 } from '../src/core/math';
import { Perception } from '../src/perception/Perception';
import type { DepthEstimator } from '../src/perception/space/DepthEstimator';
import type { MarkerPose } from '../src/perception/space/marker';
import type { TrackingFrame } from '../src/tracking/types';

const depthStub = { latest: null, running: false, status: 'idle' } as unknown as DepthEstimator;
const frame = (t: number): TrackingFrame => ({ t, videoWidth: 1280, videoHeight: 720, mirrored: true, hands: [], face: null, pose: null, otherPoses: [], timings: {} });
const marker = (x: number, tiltDeg = 50): MarkerPose => {
  const a = (tiltDeg * Math.PI) / 180;
  return { id: 107, center: { x, y: 0.2, z: 0.6 }, normal: normalize3({ x: 0, y: -Math.cos(a), z: -Math.sin(a) }), xAxis: { x: 1, y: 0, z: 0 }, corners: [] };
};

describe('marcador tapado o pisado', () => {
  it('mantiene la superficie cuando el marcador deja de verse', () => {
    const p = new Perception({ kind: 'table', hfov: 65, tableTilt: 40 }, depthStub);
    p.setMarkers([marker(0)]);
    p.setMarkers([]); // tapado
    const s = p.update(frame(1)).space;
    expect(s.surfaceSource).toBe('marker');
    expect(s.center.x).toBeCloseTo(0, 3);
  });

  it('ignora una lectura aislada muy distinta (esquina tapada)', () => {
    const p = new Perception({ kind: 'table', hfov: 65, tableTilt: 40 }, depthStub);
    p.setMarkers([marker(0)]);
    p.setMarkers([marker(0.3, 20)]);
    expect(p.update(frame(1)).space.center.x).toBeCloseTo(0, 3);
  });

  it('acepta un cambio que se repite (se movió el marcador)', () => {
    const p = new Perception({ kind: 'table', hfov: 65, tableTilt: 40 }, depthStub);
    p.setMarkers([marker(0)]);
    for (let i = 0; i < 5; i++) p.setMarkers([marker(0.3)]);
    expect(p.update(frame(1)).space.center.x).toBeCloseTo(0.3, 3);
  });
});
