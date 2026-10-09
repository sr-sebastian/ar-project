import { describe, expect, it } from 'vitest';
import { add3, dot3, normalize3, scale3, type Vec3 } from '../src/core/math';
import { focalFromSquare, hfovFromFocal, homography, poseFromSquare } from '../src/perception/space/marker';
import { intrinsicsFromFov } from '../src/perception/space/surface';

const k = intrinsicsFromFov(1280, 720, 65);
const project = (p: Vec3) => ({ x: (k.fx * (p.x / p.z) + k.cx) / k.width, y: (k.fy * (p.y / p.z) + k.cy) / k.height });

describe('homography', () => {
  it('mapea exactamente los 4 puntos', () => {
    const src = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const dst = [{ x: 10, y: 5 }, { x: 30, y: 8 }, { x: 28, y: 40 }, { x: 9, y: 35 }];
    const H = homography(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i];
      const w = H[6] * x + H[7] * y + H[8];
      expect((H[0] * x + H[1] * y + H[2]) / w).toBeCloseTo(dst[i].x, 6);
      expect((H[3] * x + H[4] * y + H[5]) / w).toBeCloseTo(dst[i].y, 6);
    }
  });
});

describe('poseFromSquare', () => {
  it('recupera centro, normal y eje de un marcador de 10 cm sobre una mesa inclinada', () => {
    const tilt = (55 * Math.PI) / 180;
    const normal = normalize3({ x: 0, y: -Math.cos(tilt), z: -Math.sin(tilt) }); // hacia la cámara
    const xAxis = { x: 1, y: 0, z: 0 };
    // yAxis tal que (x, y, n) sea consistente con el orden de esquinas del detector.
    const yAxis = { x: 0, y: Math.sin(tilt), z: -Math.cos(tilt) };
    const center = { x: 0.05, y: 0.2, z: 0.6 };
    const h = 0.05;
    const corner = (sx: number, sy: number) => add3(center, add3(scale3(xAxis, sx * h), scale3(yAxis, sy * h)));
    const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map(project);
    const pose = poseFromSquare(corners, 0.1, k)!;
    expect(pose.center.x).toBeCloseTo(center.x, 3);
    expect(pose.center.y).toBeCloseTo(center.y, 3);
    expect(pose.center.z).toBeCloseTo(center.z, 3);
    expect(dot3(pose.normal, normal)).toBeGreaterThan(0.999);
    expect(dot3(pose.xAxis, xAxis)).toBeGreaterThan(0.999);
  });
});

describe('focalFromSquare (autocalibración del FOV)', () => {
  it('recupera la distancia focal de un marcador inclinado', () => {
    for (const hfov of [60, 78, 90]) {
      const kk = intrinsicsFromFov(1920, 1080, hfov);
      const tilt = (50 * Math.PI) / 180;
      const xAxis = normalize3({ x: 0.97, y: 0, z: 0.24 });
      const y0 = { x: 0, y: Math.sin(tilt), z: -Math.cos(tilt) };
      // Ortogonalizar: el marcador es un cuadrado de verdad.
      const yAxis = normalize3(add3(y0, scale3(xAxis, -dot3(y0, xAxis))));
      const center = { x: -0.1, y: 0.3, z: 1.4 };
      const corner = (sx: number, sy: number) => add3(center, add3(scale3(xAxis, sx * 0.05), scale3(yAxis, sy * 0.05)));
      const px = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map((p) => ({ x: kk.fx * (p.x / p.z) + kk.cx, y: kk.fy * (p.y / p.z) + kk.cy }));
      const f = focalFromSquare(px, kk.cx, kk.cy)!;
      expect(Math.abs(f - kk.fx) / kk.fx).toBeLessThan(0.01);
      expect(hfovFromFocal(f, 1920)).toBeCloseTo(hfov, 0);
    }
  });

  it('no inventa un valor con el marcador de frente', () => {
    const px = [{ x: 900, y: 500 }, { x: 1020, y: 500 }, { x: 1020, y: 620 }, { x: 900, y: 620 }];
    expect(focalFromSquare(px, 960, 540)).toBeNull();
  });
});
