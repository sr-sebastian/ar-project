import { EventBus } from '../core/EventBus';
import { mid2, type Vec2, type Vec3 } from '../core/math';
import type { Handedness, TrackingFrame } from '../tracking/types';
import { computeBodyMetrics, PostureTracker } from './body';
import { computeExpressions, expressionLevels, headPoseFromMatrix, type ExpressionName } from './expressions';
import { classifyGesture, fingerStates, GestureStabilizer, PinchDetector, pinchDistance, SwipeDetector } from './gestures';
import { HAND } from './landmarks';
import type { DepthEstimator } from './space/DepthEstimator';
import {
  blendPlanes,
  defaultSurface,
  estimateSurface,
  intrinsicsFromFov,
  type DepthMap,
  type Plane,
  type SurfaceKind,
} from './space/surface';
import type { HandState, PerceptionEvents, PerceptionFrame, SpaceState } from './types';

interface HandMemory {
  pinch: PinchDetector;
  stabilizer: GestureStabilizer;
  swipe: SwipeDetector;
  prevTip: Vec2 | null;
  prevPalm: Vec2 | null;
  velocity: Vec2;
  tipVelocity: Vec2;
}

const newHandMemory = (): HandMemory => ({
  pinch: new PinchDetector(),
  stabilizer: new GestureStabilizer(3),
  swipe: new SwipeDetector(),
  prevTip: null,
  prevPalm: null,
  velocity: { x: 0, y: 0 },
  tipVelocity: { x: 0, y: 0 },
});

export interface SpaceConfig {
  kind: SurfaceKind;
  hfov: number;
  tableTilt: number;
}

/**
 * Convierte frames crudos del tracker en un estado semántico (gestos, expresiones,
 * postura, superficie) y emite eventos de flanco ("empezó un pinch", "sonrió", …).
 */
export class Perception {
  readonly events = new EventBus<PerceptionEvents>();
  private hands: Record<Handedness, HandMemory> = { Left: newHandMemory(), Right: newHandMemory() };
  private posture = new PostureTracker();
  private expressionActive = new Map<ExpressionName, boolean>();
  private lastT = 0;
  private lastDepth: DepthMap | null = null;
  private surface: Plane | null = null;
  private surfaceConfidence = 0;
  private surfaceFromDepth = false;
  /** Gravedad en coordenadas de cámara enviada por el celular (si aplica). */
  up: Vec3 | null = null;

  constructor(
    public space: SpaceConfig,
    private depth: DepthEstimator,
  ) {}

  setSpaceConfig(cfg: SpaceConfig) {
    const kindChanged = cfg.kind !== this.space.kind;
    this.space = cfg;
    if (kindChanged) this.resetSurface();
  }

  resetSurface() {
    this.surface = null;
    this.surfaceFromDepth = false;
    this.surfaceConfidence = 0;
    this.lastDepth = null;
  }

  update(frame: TrackingFrame): PerceptionFrame {
    const t = frame.t;
    const dt = this.lastT ? Math.min(0.1, Math.max(1e-3, t - this.lastT)) : 1 / 30;
    this.lastT = t;
    const aspect = frame.videoWidth / frame.videoHeight;

    const hands = frame.hands.map((h) => this.updateHand(h, t, dt, aspect));
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

    let body: PerceptionFrame['body'] = null;
    if (frame.pose) {
      const posture = this.posture.update(frame.pose.landmarks, t);
      body = {
        landmarks: frame.pose.landmarks,
        world: frame.pose.world,
        metrics: computeBodyMetrics(frame.pose.landmarks, frame.pose.world),
        crouching: posture.crouching,
        jumping: posture.jumping,
      };
    } else this.posture.reset();

    return {
      t,
      dt,
      aspect,
      mirrored: frame.mirrored,
      hands,
      face,
      body,
      space: this.updateSpace(frame),
      timings: frame.timings,
    };
  }

  private updateHand(h: TrackingFrame['hands'][number], t: number, dt: number, aspect: number): HandState {
    const mem = this.hands[h.handedness];
    const lm = h.landmarks;
    const wasPinching = mem.pinch.active;
    const pinching = mem.pinch.update(lm);
    const raw = classifyGesture(lm, pinching);
    const previous = mem.stabilizer.current;
    const gesture = mem.stabilizer.update(raw);

    const tip = { x: lm[HAND.INDEX_TIP].x, y: lm[HAND.INDEX_TIP].y };
    const palm = mid2(lm[HAND.WRIST], lm[HAND.MIDDLE_MCP]);
    const prevTip = mem.prevTip ?? tip;
    const prevPalm = mem.prevPalm ?? palm;
    const k = 0.5; // suavizado exponencial de la velocidad
    mem.velocity = {
      x: mem.velocity.x * (1 - k) + (((palm.x - prevPalm.x) * aspect) / dt) * k,
      y: mem.velocity.y * (1 - k) + ((palm.y - prevPalm.y) / dt) * k,
    };
    mem.tipVelocity = {
      x: mem.tipVelocity.x * (1 - k) + (((tip.x - prevTip.x) * aspect) / dt) * k,
      y: mem.tipVelocity.y * (1 - k) + ((tip.y - prevTip.y) / dt) * k,
    };
    mem.prevTip = tip;
    mem.prevPalm = palm;
    const swipe = mem.swipe.update(mem.velocity.x, mem.velocity.y, t);

    if (gesture !== previous) this.events.emit('gesture', { hand: h.handedness, gesture, previous });
    if (pinching !== wasPinching) this.events.emit('pinch', { hand: h.handedness, down: pinching, at: mid2(lm[HAND.THUMB_TIP], lm[HAND.INDEX_TIP]) });
    if (swipe) this.events.emit('swipe', { hand: h.handedness, direction: swipe });

    return {
      handedness: h.handedness,
      landmarks: lm,
      world: h.world,
      gesture,
      mpGesture: h.mpGesture,
      fingers: fingerStates(lm),
      pinching,
      pinchDistance: pinchDistance(lm),
      indexTip: tip,
      prevIndexTip: prevTip,
      palmCenter: palm,
      prevPalmCenter: prevPalm,
      velocity: mem.velocity,
      tipVelocity: mem.tipVelocity,
      speed: Math.hypot(mem.velocity.x, mem.velocity.y),
      swipe,
    };
  }

  private releaseHand(side: Handedness) {
    const mem = this.hands[side];
    if (mem.pinch.active) this.events.emit('pinch', { hand: side, down: false, at: mem.prevTip ?? { x: 0, y: 0 } });
    if (mem.stabilizer.current !== 'none') this.events.emit('gesture', { hand: side, gesture: 'none', previous: mem.stabilizer.current });
    this.hands[side] = newHandMemory();
  }

  private updateSpace(frame: TrackingFrame): SpaceState {
    const map = this.depth.latest;
    const w = map?.width ?? frame.videoWidth;
    const h = map?.height ?? frame.videoHeight;
    const intrinsics = intrinsicsFromFov(w, h, this.space.hfov);

    if (map && map !== this.lastDepth) {
      this.lastDepth = map;
      const est = estimateSurface(map, intrinsics, this.space.kind, this.up ?? undefined);
      if (est && est.confidence > 0.25) {
        // Suavizado temporal: los mapas de profundidad relativos fluctúan entre frames.
        this.surface = this.surface && this.surfaceFromDepth ? blendPlanes(this.surface, est.plane, 0.3) : est.plane;
        this.surfaceFromDepth = true;
        this.surfaceConfidence = this.surfaceConfidence * 0.7 + est.confidence * 0.3;
      }
    }
    if (!this.depth.running && this.surfaceFromDepth) this.resetSurface();

    const assumed = defaultSurface(this.space.kind, intrinsics, this.space.tableTilt);
    return {
      kind: this.space.kind,
      depthStatus: this.depth.status,
      depth: map,
      surface: this.surfaceFromDepth && this.surface ? this.surface : assumed,
      surfaceSource: this.surfaceFromDepth ? 'depth' : 'assumed',
      surfaceConfidence: this.surfaceFromDepth ? this.surfaceConfidence : 0,
      intrinsics,
      up: this.up,
    };
  }
}
