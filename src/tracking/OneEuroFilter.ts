/**
 * Filtro One-Euro (Casiez et al. 2012): suaviza mucho cuando la señal está quieta
 * (menos jitter) y poco cuando se mueve rápido (menos latencia). Ideal para landmarks.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param t tiempo en segundos */
  filter(x: number, t: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(t - this.tPrev, 1e-3);
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Aplica un One-Euro independiente a cada coordenada de una lista de puntos 3D. */
export class LandmarkSmoother {
  private filters: OneEuroFilter[] = [];

  constructor(
    private minCutoff = 1.2,
    private beta = 0.03,
  ) {}

  smooth<T extends Point3>(points: T[], t: number): T[] {
    if (this.filters.length !== points.length * 3) {
      this.filters = Array.from({ length: points.length * 3 }, () => new OneEuroFilter(this.minCutoff, this.beta));
    }
    return points.map((p, i) => ({
      ...p,
      x: this.filters[i * 3].filter(p.x, t),
      y: this.filters[i * 3 + 1].filter(p.y, t),
      z: this.filters[i * 3 + 2].filter(p.z, t),
    }));
  }

  reset() {
    this.filters = [];
  }
}
