import { add3, dot3, len3, mid3, normalize3, scale3, sub3, type Vec3 } from '../../core/math';
import { POSE } from '../landmarks';
import { blendPlanes, planeThrough, type Plane } from './surface';

/**
 * Piso a partir del cuerpo (modo cuerpo completo), sin modelo de profundidad:
 * - "arriba" = gravedad del celular si existe; si no, la vertical del cuerpo de pie
 *   (tobillos → hombros), promediada en el tiempo.
 * - el plano pasa por el punto más bajo de los pies (talones y puntas).
 * Recuerda la última estimación cuando los pies salen de cuadro.
 */
export class FloorFromBody {
  plane: Plane | null = null;
  confidence = 0;
  private up: Vec3 | null = null;

  /**
   * @param cam 33 landmarks del cuerpo en metros (cámara).
   * @param visibility visibilidad de cada landmark.
   * @param gravityUp vertical medida por el celular, si existe.
   */
  update(cam: Vec3[], visibility: number[], gravityUp: Vec3 | null): Plane | null {
    const vis = (i: number) => visibility[i] ?? 0;
    const feetIds = [POSE.LEFT_HEEL, POSE.RIGHT_HEEL, POSE.LEFT_FOOT, POSE.RIGHT_FOOT, POSE.LEFT_ANKLE, POSE.RIGHT_ANKLE];
    const feet = feetIds.filter((i) => vis(i) > 0.5).map((i) => cam[i]);

    // Vertical: gravedad o cuerpo erguido.
    let up = gravityUp ? normalize3(gravityUp) : null;
    if (!up && vis(POSE.LEFT_ANKLE) > 0.5 && vis(POSE.RIGHT_ANKLE) > 0.5 && vis(POSE.LEFT_SHOULDER) > 0.5 && vis(POSE.RIGHT_SHOULDER) > 0.5) {
      const body = sub3(mid3(cam[POSE.LEFT_SHOULDER], cam[POSE.RIGHT_SHOULDER]), mid3(cam[POSE.LEFT_ANKLE], cam[POSE.RIGHT_ANKLE]));
      // Sólo si está de pie (hombros a > 0.9 m de los tobillos).
      if (len3(body) > 0.9) up = normalize3(body);
    }
    if (up) this.up = this.up ? normalize3(add3(scale3(this.up, 0.9), scale3(up, 0.1))) : up;
    // Sin vertical medida todavía: suponemos la cámara nivelada (lo usual en una webcam).
    if (!this.up && feet.length >= 2) this.up = { x: 0, y: -1, z: 0 };
    if (!this.up || feet.length < 2) return this.plane;

    // El punto de los pies más "abajo" según la vertical.
    const lowest = feet.reduce((a, b) => (dot3(b, this.up!) < dot3(a, this.up!) ? b : a));
    const measured = planeThrough(this.up, lowest);
    this.plane = this.plane ? blendPlanes(this.plane, measured, 0.15) : measured;
    this.confidence = Math.min(1, this.confidence + 0.05);
    return this.plane;
  }

  reset() {
    this.plane = null;
    this.up = null;
    this.confidence = 0;
  }
}

export interface PalmSample {
  /** Centro de la palma (m). */
  center: Vec3;
  /** Normal del plano de la mano orientada hacia la cámara. */
  normal: Vec3;
  /** Velocidad de la palma (m/s). */
  speed: number;
  /** Mano abierta y plana. */
  flat: boolean;
}

/**
 * Mesa a partir de la mano apoyada (modo mesa): con la mano abierta, plana y quieta
 * durante `holdSeconds`, el centro de la palma da un punto de la mesa y la normal de la
 * mano da su orientación. Promedia todas las muestras del intervalo.
 */
export class TableFromPalm {
  plane: Plane | null = null;
  /** 0..1 durante la recolección. */
  progress = 0;
  private samples: PalmSample[] = [];
  private since = 0;

  constructor(
    private holdSeconds = 1,
    /** Grosor de la mano: la mesa está este tanto por debajo del centro de la palma. */
    private handThickness = 0.02,
  ) {}

  /** Devuelve true en el frame en que se completa una calibración. */
  update(sample: PalmSample | null, t: number): boolean {
    const still = sample && sample.flat && sample.speed < 0.06;
    // Además, la orientación debe mantenerse estable respecto a la primera muestra.
    const consistent = still && (this.samples.length === 0 || dot3(this.samples[0].normal, sample.normal) > 0.9);
    if (!sample || !consistent) {
      this.samples = [];
      this.progress = 0;
      return false;
    }
    if (this.samples.length === 0) this.since = t;
    this.samples.push(sample);
    this.progress = Math.min(1, (t - this.since) / this.holdSeconds);
    if (this.progress < 1) return false;

    const n = this.samples.length;
    const center = scale3(this.samples.reduce((a, s) => add3(a, s.center), { x: 0, y: 0, z: 0 }), 1 / n);
    const normal = normalize3(this.samples.reduce((a, s) => add3(a, s.normal), { x: 0, y: 0, z: 0 }));
    // Bajamos el punto el grosor de la mano, en contra de la normal.
    this.plane = planeThrough(normal, sub3(center, scale3(normal, this.handThickness)));
    this.samples = [];
    this.progress = 0;
    return true;
  }

  reset() {
    this.plane = null;
    this.samples = [];
    this.progress = 0;
  }
}
