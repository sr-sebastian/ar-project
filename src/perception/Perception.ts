import { EventBus } from '../core/EventBus';
import { add3, dot3, mid2, scale3, sub3, type Vec2, type Vec3 } from '../core/math';
import { OneEuroFilter } from '../tracking/OneEuroFilter';
import type { Handedness, Landmark, TrackingFrame } from '../tracking/types';
import { computeBodyMetrics, PostureTracker } from './body';
import { computeExpressions, expressionLevels, headPoseFromMatrix, type ExpressionName } from './expressions';
import { classifyGesture, fingerStates, GestureStabilizer, palmFacesCamera, PinchDetector, pinchDistance, SwipeDetector } from './gestures';
import { HAND, POSE } from './landmarks';
import { handPlaneNormal, palmCenter, solveTranslation, toCamera } from './metric';
import { FloorFromBody, TableFromPalm } from './space/calibration';
import type { DepthEstimator } from './space/DepthEstimator';
import { MARKER_IDS, type MarkerPose } from './space/marker';
import {
  defaultSurface,
  disparityAt,
  fitDisparityPlane,
  intrinsicsFromFov,
  normalFromDisparityFit,
  planeThrough,
  projectOnPlane,
  rayPlane,
  regionOf,
  type DepthMap,
  type Intrinsics,
  type Plane,
  type SurfaceKind,
} from './space/surface';
import type { PersonMask } from '../tracking/Segmenter';
import type { HandState, PerceptionEvents, PerceptionFrame, SpaceState, SurfaceSource } from './types';

/** Filtro One-Euro para un vector 3D (traslaciones métricas). */
class Vec3Filter {
  private f = [new OneEuroFilter(1.2, 0.3), new OneEuroFilter(1.2, 0.3), new OneEuroFilter(0.8, 0.2)];
  filter(v: Vec3, t: number): Vec3 {
    return { x: this.f[0].filter(v.x, t), y: this.f[1].filter(v.y, t), z: this.f[2].filter(v.z, t) };
  }
  reset() {
    this.f.forEach((f) => f.reset());
  }
}

interface HandMemory {
  pinch: PinchDetector;
  stabilizer: GestureStabilizer;
  swipe: SwipeDetector;
  prevTip: Vec2 | null;
  prevPalm: Vec2 | null;
  velocity: Vec2;
  tipVelocity: Vec2;
  translation: Vec3Filter;
  prevPalm3: Vec3 | null;
  velocity3: Vec3;
}

const newHandMemory = (): HandMemory => ({
  pinch: new PinchDetector(),
  stabilizer: new GestureStabilizer(3),
  swipe: new SwipeDetector(),
  prevTip: null,
  prevPalm: null,
  velocity: { x: 0, y: 0 },
  tipVelocity: { x: 0, y: 0 },
  translation: new Vec3Filter(),
  prevPalm3: null,
  velocity3: { x: 0, y: 0, z: 0 },
});

export interface SpaceConfig {
  kind: SurfaceKind;
  hfov: number;
  tableTilt: number;
}

/**
 * Convierte frames crudos del tracker en un estado semántico (gestos, expresiones,
 * postura, posiciones métricas, superficie) y emite eventos de flanco ("empezó un pinch",
 * "sonrió", "se calibró la mesa"…).
 */
export class Perception {
  readonly events = new EventBus<PerceptionEvents>();
  private hands: Record<Handedness, HandMemory> = { Left: newHandMemory(), Right: newHandMemory() };
  private posture = new PostureTracker();
  private bodyTranslation = new Vec3Filter();
  private expressionActive = new Map<ExpressionName, boolean>();
  private lastT = 0;
  // Superficies
  private floor = new FloorFromBody();
  private table = new TableFromPalm();
  private lastDepth: DepthMap | null = null;
  private depthNormal: Vec3 | null = null;
  private depthRegion: { u: number; v: number; spread: number } | null = null;
  private announced: SurfaceSource = 'assumed';
  /** Último marcador visto para el modo actual (queda fijo aunque se tape). */
  private marker: MarkerPose | null = null;
  private markerVisible: MarkerPose | null = null;
  private markerPending: MarkerPose[] = [];
  /** Vertical (opuesta a la gravedad) en coordenadas de cámara enviada por el celular. */
  up: Vec3 | null = null;
  /** Última silueta de personas (la provee el shell si la segmentación está activa). */
  personMask: PersonMask | null = null;
  private depthScale: number | null = null;

  constructor(
    public space: SpaceConfig,
    private depth: DepthEstimator,
  ) {}

  setSpaceConfig(cfg: SpaceConfig) {
    const changed = cfg.kind !== this.space.kind || cfg.hfov !== this.space.hfov;
    this.space = cfg;
    if (changed) this.recalibrate();
  }

  /** Olvida la superficie medida (por ejemplo, si se movió la cámara). */
  recalibrate() {
    this.floor.reset();
    this.table.reset();
    this.depthNormal = null;
    this.depthRegion = null;
    this.lastDepth = null;
    this.announced = 'assumed';
    this.marker = null;
  }

  /**
   * Marcadores detectados en el último análisis (null = no se analizó este frame).
   *
   * Robustez cuando se tapa o se pisa: si el marcador no se ve, la superficie queda fija
   * en la última pose buena. Una vez fijado, una lectura muy distinta (> 5 cm o > 10°)
   * se ignora salvo que se repita de forma consistente varias veces (eso sí indica que se
   * movió el marcador o la cámara); así un pie o una mano que tapa una esquina no lo mueve.
   */
  setMarkers(poses: MarkerPose[] | null) {
    if (!poses) return;
    const wanted = MARKER_IDS[this.space.kind];
    const m = poses.find((p) => p.id === wanted) ?? null;
    this.markerVisible = m;
    if (!m) return;
    const close = (a: MarkerPose, b: MarkerPose) =>
      Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z) < 0.05 && dot3(a.normal, b.normal) > Math.cos((10 * Math.PI) / 180);
    if (!this.marker) {
      this.marker = m;
      this.markerPending = [];
      return;
    }
    if (close(this.marker, m)) {
      this.markerPending = [];
      const b = (a: Vec3, c: Vec3, t: number) => add3(scale3(a, 1 - t), scale3(c, t));
      this.marker = { ...m, center: b(this.marker.center, m.center, 0.25), normal: blend(this.marker.normal, m.normal, 0.25), xAxis: blend(this.marker.xAxis, m.xAxis, 0.25) };
      return;
    }
    // Lectura distinta: sólo se acepta si se repite consistentemente.
    if (this.markerPending.length && !close(this.markerPending[this.markerPending.length - 1], m)) this.markerPending = [];
    this.markerPending.push(m);
    if (this.markerPending.length >= 5) {
      this.marker = m;
      this.markerPending = [];
    }
  }

  get tableCalibrated() {
    return !!this.table.plane;
  }

  update(frame: TrackingFrame): PerceptionFrame {
    const t = frame.t;
    const dt = this.lastT ? Math.min(0.1, Math.max(1e-3, t - this.lastT)) : 1 / 30;
    this.lastT = t;
    const aspect = frame.videoWidth / frame.videoHeight;
    const k = intrinsicsFromFov(frame.videoWidth, frame.videoHeight, this.space.hfov);

    let body: PerceptionFrame['body'] = null;
    if (frame.pose) {
      const posture = this.posture.update(frame.pose.landmarks, t);
      const T = solveTranslation(frame.pose.landmarks, frame.pose.world, k, 0.6);
      body = {
        landmarks: frame.pose.landmarks,
        world: frame.pose.world,
        metrics: computeBodyMetrics(frame.pose.landmarks, frame.pose.world),
        crouching: posture.crouching,
        jumping: posture.jumping,
        camera: T ? toCamera(frame.pose.world, this.bodyTranslation.filter(T, t)) : null,
      };
    } else {
      this.posture.reset();
      this.bodyTranslation.reset();
    }

    const hands = frame.hands.map((h) => this.updateHand(h, t, dt, aspect, k, body?.camera ?? null, frame.mirrored));
    for (const side of ['Left', 'Right'] as const) {
      if (!frame.hands.some((h) => h.handedness === side)) this.releaseHand(side);
    }

    let face: PerceptionFrame['face'] = null;
    if (frame.face) {
      const expressions = computeExpressions(frame.face.blendshapes);
      const levels = expressionLevels(expressions);
      for (const [name, level] of Object.entries(levels) as [ExpressionName, number][]) {
        const was = this.expressionActive.get(name) ?? false;
        const is = was ? level > 0.4 : level > 0.6;
        if (is !== was) {
          this.expressionActive.set(name, is);
          this.events.emit('expression', { name, active: is });
        }
      }
      face = {
        landmarks: frame.face.landmarks,
        blendshapes: frame.face.blendshapes,
        expressions,
        headPose: frame.face.matrix ? headPoseFromMatrix(frame.face.matrix, frame.mirrored) : null,
        center: { x: frame.face.landmarks[1].x, y: frame.face.landmarks[1].y },
      };
    }

    return {
      t,
      dt,
      aspect,
      mirrored: frame.mirrored,
      hands,
      face,
      body,
      space: this.updateSpace(k, body, hands, t),
      others: frame.otherPoses,
      personMask: this.personMask,
      timings: frame.timings,
    };
  }

  private updateHand(h: TrackingFrame['hands'][number], t: number, dt: number, aspect: number, k: Intrinsics, bodyCam: Vec3[] | null, mirrored: boolean): HandState {
    const mem = this.hands[h.handedness];
    const lm = h.landmarks;
    const wasPinching = mem.pinch.active;
    // La mano aproximada desde la pose no tiene dedos confiables: sin pinch ni gestos finos.
    const fromPose = h.source === 'pose';
    const pinching = fromPose ? false : mem.pinch.update(lm);
    const raw = fromPose ? 'none' : classifyGesture(lm, pinching);
    const previous = mem.stabilizer.current;
    const gesture = mem.stabilizer.update(raw);

    const tip = { x: lm[HAND.INDEX_TIP].x, y: lm[HAND.INDEX_TIP].y };
    const palm = mid2(lm[HAND.WRIST], lm[HAND.MIDDLE_MCP]);
    const prevTip = mem.prevTip ?? tip;
    const prevPalm = mem.prevPalm ?? palm;
    const s = 0.5; // suavizado exponencial de la velocidad
    mem.velocity = {
      x: mem.velocity.x * (1 - s) + (((palm.x - prevPalm.x) * aspect) / dt) * s,
      y: mem.velocity.y * (1 - s) + ((palm.y - prevPalm.y) / dt) * s,
    };
    mem.tipVelocity = {
      x: mem.tipVelocity.x * (1 - s) + (((tip.x - prevTip.x) * aspect) / dt) * s,
      y: mem.tipVelocity.y * (1 - s) + ((tip.y - prevTip.y) / dt) * s,
    };
    mem.prevTip = tip;
    mem.prevPalm = palm;
    const swipe = mem.swipe.update(mem.velocity.x, mem.velocity.y, t);

    // Posición métrica: traslación de los world landmarks de la mano hasta la cámara.
    let camera: Vec3[] | null = null;
    if (h.world.length === lm.length) {
      const T = solveTranslation(lm, h.world, k, 0);
      if (T) camera = toCamera(h.world, mem.translation.filter(T, t));
    }
    // De lejos, la distancia por el tamaño de la mano es ruidosa: si hay esqueleto, anclamos
    // la muñeca de la mano a la muñeca del cuerpo (más estable y coherente con el resto).
    const bodyWrist = bodyCam?.[h.handedness === 'Left' ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
    if (camera && bodyWrist && (h.source !== 'full' || camera[0].z > 1.5)) {
      const off = sub3(bodyWrist, camera[0]);
      camera = camera.map((p) => add3(p, off));
    }
    const palm3 = camera ? palmCenter(camera) : null;
    if (palm3) {
      const v = mem.prevPalm3 ? scale3(sub3(palm3, mem.prevPalm3), 1 / dt) : { x: 0, y: 0, z: 0 };
      mem.velocity3 = add3(scale3(mem.velocity3, 0.6), scale3(v, 0.4));
      mem.prevPalm3 = palm3;
    } else {
      mem.prevPalm3 = null;
    }

    if (gesture !== previous) this.events.emit('gesture', { hand: h.handedness, gesture, previous });
    if (pinching !== wasPinching) this.events.emit('pinch', { hand: h.handedness, down: pinching, at: mid2(lm[HAND.THUMB_TIP], lm[HAND.INDEX_TIP]) });
    if (swipe) this.events.emit('swipe', { hand: h.handedness, direction: swipe });

    return {
      handedness: h.handedness,
      source: h.source,
      landmarks: lm,
      world: h.world,
      gesture,
      mpGesture: h.mpGesture,
      fingers: fingerStates(lm),
      pinching,
      palmFacing: !fromPose && palmFacesCamera(lm, h.handedness, mirrored),
      pinchDistance: pinchDistance(lm),
      indexTip: tip,
      prevIndexTip: prevTip,
      palmCenter: palm,
      prevPalmCenter: prevPalm,
      velocity: mem.velocity,
      tipVelocity: mem.tipVelocity,
      speed: Math.hypot(mem.velocity.x, mem.velocity.y),
      swipe,
      camera,
      palm3,
      normal3: camera && !fromPose ? handPlaneNormal(camera) : null,
      velocity3: mem.velocity3,
    };
  }

  private releaseHand(side: Handedness) {
    const mem = this.hands[side];
    if (mem.pinch.active) this.events.emit('pinch', { hand: side, down: false, at: mem.prevTip ?? { x: 0, y: 0 } });
    if (mem.stabilizer.current !== 'none') this.events.emit('gesture', { hand: side, gesture: 'none', previous: mem.stabilizer.current });
    this.hands[side] = newHandMemory();
  }

  private updateSpace(k: Intrinsics, body: PerceptionFrame['body'], hands: HandState[], t: number): SpaceState {
    const kind = this.space.kind;
    let surface: Plane | null = null;
    let source: SurfaceSource = 'assumed';

    // Mapa de profundidad nuevo → plano dominante en disparidad (orientación + región).
    const map = this.depth.latest;
    if (map && map !== this.lastDepth) {
      this.lastDepth = map;
      this.fitDepth(map);
      this.updateDepthScale(map, body);
    }
    if (!this.depth.running) {
      this.depthNormal = null;
      this.depthRegion = null;
      this.depthScale = null;
    }

    if (this.marker) {
      surface = planeThrough(this.marker.normal, this.marker.center);
      source = 'marker';
    } else if (kind === 'floor') {
      if (body?.camera) {
        const vis = body.landmarks.map((l: Landmark) => l.visibility ?? 0);
        this.floor.update(body.camera, vis, this.up);
      }
      if (this.floor.plane) {
        surface = this.floor.plane;
        source = 'body';
      }
    } else {
      // Mesa: mano abierta, plana y quieta → calibración.
      if (!this.table.plane) {
        const hand = hands.find((h) => h.source !== 'pose' && h.gesture === 'open_palm' && h.palm3 && h.normal3);
        const sample = hand
          ? { center: hand.palm3!, normal: hand.normal3!, speed: Math.hypot(hand.velocity3.x, hand.velocity3.y, hand.velocity3.z), flat: true }
          : null;
        this.table.update(sample, t);
      }
      if (this.table.plane) {
        surface = this.table.plane;
        source = 'hand';
      } else if (this.depthNormal) {
        // Sin escala métrica: anclamos el plano a 0.6 m sobre el centro de la región.
        const r = this.depthRegion ?? { u: 0.5, v: 0.65, spread: 0.2 };
        const dir = { x: (r.u * k.width - k.cx) / k.fx, y: (r.v * k.height - k.cy) / k.fy, z: 1 };
        surface = planeThrough(this.depthNormal, scale3(dir, 0.6));
        source = 'depth';
      }
    }

    const plane = surface ?? defaultSurface(kind, k, this.space.tableTilt);
    if (source !== this.announced) {
      this.announced = source;
      this.events.emit('surface', { kind, source });
    }

    // Centro de la zona de juego.
    let center: Vec3 | null = null;
    let extent = kind === 'floor' ? 1.2 : 0.3;
    if (this.marker) {
      center = this.marker.center;
    } else if (kind === 'floor' && body?.camera) {
      const hips = body.camera[POSE.LEFT_HIP] && body.camera[POSE.RIGHT_HIP] ? scale3(add3(body.camera[POSE.LEFT_HIP], body.camera[POSE.RIGHT_HIP]), 0.5) : null;
      if (hips) center = projectOnPlane(plane, hips);
    } else if (kind === 'table') {
      if (this.depthRegion) {
        center = rayPlane(plane, k, this.depthRegion.u, this.depthRegion.v);
        if (center) extent = Math.max(0.15, Math.min(0.6, this.depthRegion.spread * 2 * center.z));
      }
    }
    center ??= rayPlane(plane, k, 0.5, kind === 'floor' ? 0.85 : 0.65) ?? projectOnPlane(plane, { x: 0, y: 0, z: kind === 'floor' ? 2.5 : 0.6 });

    return {
      kind,
      intrinsics: k,
      depthStatus: this.depth.status,
      depth: map,
      surface: plane,
      surfaceSource: source,
      center,
      extent,
      depthScale: this.depthScale,
      calibrationProgress: this.table.progress,
      axis: this.marker?.xAxis ?? null,
      marker: this.markerVisible,
      up: this.up,
    };
  }

  /**
   * Escala métrica del mapa: la disparidad del torso del jugador (mediana de hombros y
   * caderas) por su distancia en metros. Con eso, metros = escala / disparidad en toda la
   * imagen (paredes, muebles, otras personas).
   */
  private updateDepthScale(map: DepthMap, body: PerceptionFrame['body']) {
    if (!body?.camera) return;
    const ids = [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.LEFT_HIP, POSE.RIGHT_HIP].filter((i) => (body.landmarks[i].visibility ?? 0) > 0.6);
    if (ids.length < 2) return;
    const disp = ids.map((i) => disparityAt(map, body.landmarks[i].x, body.landmarks[i].y)).sort((a, b) => a - b);
    const d = disp[Math.floor(disp.length / 2)];
    const z = ids.reduce((s, i) => s + body.camera![i].z, 0) / ids.length;
    if (d < 0.02 || !(z > 0.2)) return;
    const a = d * z;
    this.depthScale = this.depthScale ? this.depthScale * 0.8 + a * 0.2 : a;
  }

  private fitDepth(map: DepthMap) {
    const kd = intrinsicsFromFov(map.width, map.height, this.space.hfov);
    const table = this.space.kind === 'table';
    const fit = fitDisparityPlane(map, {
      region: table ? [0.3, 1] : [0.55, 1],
      accept: (f) => {
        const n = normalFromDisparityFit(f, kd);
        // Superficies "horizontales" (miran hacia arriba en la imagen), no paredes.
        return table ? n.y < -0.25 : n.y < -0.6;
      },
    });
    if (!fit || fit.inlierRatio < 0.25) return;
    const n = normalFromDisparityFit(fit, kd);
    this.depthNormal = this.depthNormal && dot3(this.depthNormal, n) > 0.8 ? blend(this.depthNormal, n, 0.3) : n;
    const r = regionOf(fit, map);
    if (r) this.depthRegion = { u: r.u, v: r.v, spread: Math.max(r.spreadU, r.spreadV) };
  }
}

function blend(a: Vec3, b: Vec3, t: number): Vec3 {
  const v = add3(scale3(a, 1 - t), scale3(b, t));
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
