import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { seededRandom, type Vec2, type Vec3 } from '../../core/math';
import { storage } from '../../core/settings';
import { BLOCK_COLORS, createToyBlock, createWoodBlock } from '../../models/props';
import { planeHeight, rayPlane } from '../../perception/space/surface';
import type { PerceptionFrame, SpaceState } from '../../perception/types';
import type { Handedness } from '../../tracking/types';
import { icon } from '../../ui/icons';
import { HandRig } from '../shared/HandRig';
import { SurfaceAnchor } from '../shared/SurfaceAnchor';
import type { AppContext, AppDefinition, AppInstance } from '../types';
import { screenHover, screenTwoHandGrab, throwVelocity, type ScreenBox } from './grab';

type Rapier = typeof RAPIER_NS;

interface Block {
  id: number;
  body: RAPIER_NS.RigidBody;
  mesh: THREE.Mesh;
  half: THREE.Vector3;
}

type Hold =
  | { kind: 'one'; hand: Handedness; block: number; height: number; handH0: number; angle0: number; rot: THREE.Quaternion; openSince: number }
  | { kind: 'two'; block: number; height: number; handH0: number; spread0: number; angle0: number; rot: THREE.Quaternion };

const GLYPHS = 'ARPROYECT0123456789';
const rnd = seededRandom(4);

/**
 * Bloques con física (ambos modos). Bloques de juguete sobre la superficie real:
 * - Una mano: puño o pellizco sobre un bloque lo agarra; abrir la mano lo suelta (y lo
 *   lanza con la velocidad de la mano).
 * - Dos manos / dos brazos: rodear el bloque desde lados opuestos lo levanta; separar
 *   las manos lo suelta. Ideal para los bloques grandes del modo cuerpo completo.
 * - Las manos también empujan y voltean bloques (colisionadores cinemáticos).
 * - Modo Torre: apilá lo más alto posible; la altura se mide sobre la superficie.
 */
class BlocksApp implements AppInstance {
  private ctx!: AppContext;
  private R: Rapier | null = null;
  private world: RAPIER_NS.World | null = null;
  private anchor!: SurfaceAnchor;
  private blocks: Block[] = [];
  private nextId = 1;
  private hands = new Map<string, RAPIER_NS.RigidBody>();
  private hold: Hold | null = null;
  private rig = new HandRig();
  private hovered: number | null = null;
  private holdVel = new THREE.Vector3();
  private lastTarget: THREE.Vector3 | null = null;
  private accumulator = 0;
  private placed = false;
  private placeTimer = 0;
  private spawnCooldown = 0;
  private tower = 0;
  private best = storage.get<Record<string, number>>('blocks:best', {});
  private hud!: { height: HTMLElement; best: HTMLElement; hint: HTMLElement };
  private offEvents: (() => void)[] = [];
  /** Escala según el modo: bloques de 30–45 cm en el piso, de 4–7 cm en la mesa. */
  private scale = 1;

  mount(ctx: AppContext) {
    this.ctx = ctx;
    const floor = ctx.mode.surface === 'floor';
    this.scale = floor ? 1 : 0.16;
    ctx.setOcclusion({ hands: true, body: floor });
    this.anchor = new SurfaceAnchor(ctx.scene, floor ? 4 : 0.8);
    ctx.ui.innerHTML = `
      <div class="game-hud">
        <div class="hud-row" data-h="height">${icon('gauge', 22)} 0 cm</div>
        <div class="hud-row" data-h="best"></div>
        <small data-h="hint">Cargando física…</small>
      </div>
      <div class="game-toolbar">
        <button class="btn-secondary" data-act="spawn">${icon('blocks', 18)} Nuevo bloque</button>
        <button class="btn-secondary" data-act="reset">${icon('reset', 18)} Reiniciar</button>
        <button class="btn-secondary" data-act="recal">${icon('recalibrate', 18)} Reubicar</button>
      </div>`;
    this.hud = {
      height: ctx.ui.querySelector('[data-h="height"]')!,
      best: ctx.ui.querySelector('[data-h="best"]')!,
      hint: ctx.ui.querySelector('[data-h="hint"]')!,
    };
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="spawn"]')!.onclick = () => this.spawn();
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="reset"]')!.onclick = () => this.reset();
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="recal"]')!.onclick = () => {
      this.placed = false;
      this.placeTimer = 0;
      ctx.recalibrate();
    };
    this.renderBest();
    this.offEvents.push(
      ctx.events.on('gesture', (e) => {
        if (e.gesture === 'victory' && this.spawnCooldown <= 0) this.spawn();
      }),
    );
    void this.initPhysics();
  }

  private async initPhysics() {
    const mod = await import('@dimforge/rapier3d-compat');
    const R = (mod.default ?? mod) as Rapier;
    await R.init();
    this.R = R;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    // Suelo: la superficie real (piso o mesa) es el plano y=0 local.
    const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(R.ColliderDesc.cuboid(20, 0.5, 20).setFriction(0.9), ground);
    this.hud.hint.textContent =
      this.ctx.mode.surface === 'floor'
        ? 'Rodeá un bloque con los dos brazos para levantarlo · puño para agarrar con una mano · victoria = nuevo bloque'
        : 'Puño o pellizco sobre un bloque para agarrarlo · las dos manos a los lados para bloques grandes · victoria = nuevo bloque';
  }

  private reset() {
    for (const b of this.blocks) {
      this.world?.removeRigidBody(b.body);
      b.mesh.removeFromParent();
      b.mesh.geometry.dispose();
    }
    this.blocks = [];
    this.hold = null;
    this.placeInitial();
  }

  private placeInitial() {
    const s = this.scale;
    // Una fila de bloques de distintos tamaños delante del centro.
    const layout = [
      [-0.8, 0.35, 0.35, 0.35],
      [-0.35, 0.3, 0.3, 0.3],
      [0.1, 0.45, 0.25, 0.3],
      [0.55, 0.35, 0.35, 0.35],
      [0.95, 0.6, 0.15, 0.25],
      [-0.2, 0.3, 0.3, 0.3, 0.4],
    ];
    for (const [x, w, h, d, z = 0] of layout) this.addBlock(new THREE.Vector3(x * s, (h * s) / 2 + 0.002, z * s), new THREE.Vector3(w * s, h * s, d * s));
  }

  private spawn() {
    if (!this.world) return;
    this.spawnCooldown = 1;
    const s = this.scale;
    const size = new THREE.Vector3((0.25 + rnd() * 0.2) * s, (0.25 + rnd() * 0.2) * s, (0.25 + rnd() * 0.2) * s);
    this.addBlock(new THREE.Vector3((rnd() - 0.5) * 0.6 * s, 1.0 * s, (rnd() - 0.5) * 0.4 * s), size);
  }

  private addBlock(pos: THREE.Vector3, size: THREE.Vector3) {
    if (!this.world || !this.R) return;
    const R = this.R;
    const id = this.nextId++;
    const mesh = id % 4 === 0 ? createWoodBlock(size) : createToyBlock(size, BLOCK_COLORS[id % BLOCK_COLORS.length], GLYPHS[id % GLYPHS.length]);
    this.anchor.group.add(mesh);
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setCcdEnabled(true));
    const density = this.scale < 1 ? 600 : 250; // juguetes livianos
    this.world.createCollider(R.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setFriction(0.8).setRestitution(0.05).setDensity(density), body);
    this.blocks.push({ id, body, mesh, half: size.clone().multiplyScalar(0.5) });
  }

  /** Caja en pantalla de cada bloque (proyección de sus 8 esquinas) y su profundidad. */
  private screenBoxes(): ScreenBox[] {
    return this.blocks.map((b) => {
      const pts = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const local = new THREE.Vector3(sx * b.half.x, sy * b.half.y, sz * b.half.z).applyQuaternion(b.mesh.quaternion).add(b.mesh.position);
        pts.push(this.anchor.localToNorm(local));
      }
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const world = this.anchor.localToWorld(b.mesh.position.clone());
      return { id: b.id, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), depth: -world.z };
    });
  }

  /** Punto local sobre el rayo de un punto de pantalla, a la altura `h` sobre la superficie. */
  private rayAtHeight(screen: Vec2, h: number, space: SpaceState): THREE.Vector3 | null {
    const plane = { normal: space.surface.normal, d: space.surface.d - h };
    const hit = rayPlane(plane, space.intrinsics, screen.x, screen.y);
    return hit ? this.anchor.camToLocal(hit) : null;
  }

  update(frame: PerceptionFrame | null, dt: number) {
    this.spawnCooldown -= dt;
    if (!frame) return;

    // Ubicación: esperamos una superficie medida (o 2 s) y fijamos el centro.
    if (!this.placed) {
      this.placeTimer += dt;
      if (frame.space.surfaceSource !== 'assumed' || this.placeTimer > 2) {
        this.anchor.setPoint(frame.space.center);
        this.placed = true;
        if (this.world && this.blocks.length === 0) this.placeInitial();
      }
    }
    this.anchor.update(frame.space);
    if (!this.world || !this.R) return;
    if (this.blocks.length === 0 && this.placed) this.placeInitial();

    this.rig.update(frame, (p, z) => this.ctx.scene.worldToCam(this.ctx.scene.normToWorld(p, z)), frame.space.center.z);
    this.updateHands();
    this.updateGrab(frame);

    // Paso de física fijo a 60 Hz.
    this.accumulator += Math.min(dt, 0.1);
    while (this.accumulator >= 1 / 60) {
      this.world.step();
      this.accumulator -= 1 / 60;
    }

    // Sincronizar mallas y medir la torre.
    let tower = 0;
    const m = new THREE.Matrix4();
    for (const b of this.blocks) {
      const t = b.body.translation();
      const r = b.body.rotation();
      b.mesh.position.set(t.x, t.y, t.z);
      b.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      // Altura del punto más alto del bloque (sólo bloques quietos y no sostenidos).
      const v = b.body.linvel();
      const held = this.hold?.block === b.id;
      if (!held && Math.hypot(v.x, v.y, v.z) < 0.05 && t.y < 5 * this.scale) {
        m.makeRotationFromQuaternion(b.mesh.quaternion);
        const e = m.elements;
        const halfH = Math.abs(e[1]) * b.half.x + Math.abs(e[5]) * b.half.y + Math.abs(e[9]) * b.half.z;
        tower = Math.max(tower, t.y + halfH);
      }
      // Bloques caídos lejos: volver a ponerlos.
      if (t.y < -2 * this.scale - 0.5) {
        b.body.setTranslation({ x: 0, y: this.scale, z: 0 }, true);
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
    this.tower = this.tower * 0.8 + tower * 0.2;
    this.hud.height.innerHTML = `${icon('gauge', 22)} Torre: ${(this.tower * 100).toFixed(0)} cm`;
    const key = this.ctx.mode.surface;
    if (this.tower > (this.best[key] ?? 0) + 0.005 && this.tower > 0.02) {
      this.best[key] = this.tower;
      storage.set('blocks:best', this.best);
      this.renderBest();
    }
  }

  private renderBest() {
    const b = this.best[this.ctx.mode.surface];
    this.hud.best.innerHTML = b ? `${icon('trophy', 20)} Récord: ${(b * 100).toFixed(0)} cm` : '';
  }

  /** Colisionadores cinemáticos (esferas) en las palmas: permiten empujar y voltear. */
  private updateHands() {
    const R = this.R!;
    const world = this.world!;
    const seen = new Set<string>();
    for (const h of this.rig.hands) {
      if (this.hold && (this.hold.kind === 'two' || this.hold.hand === h.handedness)) continue;
      const p = this.anchor.camToLocal(h.point);
      const r = (h.hand.source === 'pose' ? 0.07 : 0.035) * Math.max(0.4, this.scale);
      seen.add(h.handedness);
      let body = this.hands.get(h.handedness);
      if (!body) {
        body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z));
        world.createCollider(R.ColliderDesc.ball(r).setFriction(1), body);
        this.hands.set(h.handedness, body);
      }
      body.setNextKinematicTranslation({ x: p.x, y: Math.max(p.y, r), z: p.z });
    }
    for (const [key, body] of this.hands) {
      if (seen.has(key)) continue;
      world.removeRigidBody(body);
      this.hands.delete(key);
    }
  }

  /**
   * Agarre decidido EN PANTALLA (donde la detección es precisa). Mientras se sostiene,
   * el bloque se mueve sobre el rayo exacto de la mano, a una altura que sigue la
   * altura (muy suavizada) de la mano: preciso al desplazar, estable al levantar.
   */
  private updateGrab(frame: PerceptionFrame) {
    const space = frame.space;
    const boxes = this.screenBoxes();
    const table = this.scale < 1;
    const margin = table ? 0.015 : 0.03;
    const depthTol = table ? 0.3 : 1.2;
    const byId = (id: number) => this.blocks.find((b) => b.id === id);
    const handH = (p: Vec3) => planeHeight(space.surface, p);

    // Resaltado del bloque apuntado (sin agarrar).
    this.hovered = null;
    if (!this.hold) {
      for (const h of this.rig.hands) {
        const id = screenHover({ ...h.screen, depth: h.depth }, boxes, margin, depthTol);
        if (id !== null) this.hovered = id;
      }
    }
    for (const b of this.blocks) {
      const mat = b.mesh.material as THREE.MeshStandardMaterial;
      const lit = this.hovered === b.id || this.hold?.block === b.id;
      mat.emissive?.setHex(lit ? (this.hold?.block === b.id ? 0x2244aa : 0x334455) : 0x000000);
    }

    if (!this.hold) {
      const [l, r] = [this.rig.get('Left'), this.rig.get('Right')];
      if (l && r) {
        const id = screenTwoHandGrab({ ...l.screen, depth: l.depth }, { ...r.screen, depth: r.depth }, boxes, table ? 0.04 : 0.08, depthTol);
        if (id !== null) return this.startHold(byId(id)!, { kind: 'two' }, frame);
      }
      for (const h of this.rig.hands) {
        if (!h.closed) continue;
        const id = screenHover({ ...h.screen, depth: h.depth }, boxes, margin, depthTol);
        if (id !== null) return this.startHold(byId(id)!, { kind: 'one', hand: h.handedness }, frame);
      }
      return;
    }

    const b = byId(this.hold.block);
    if (!b) {
      this.hold = null;
      return;
    }
    let target: THREE.Vector3 | null;
    let yaw: number;
    if (this.hold.kind === 'one') {
      const hand = this.rig.get(this.hold.hand);
      if (!hand) return this.release(b);
      if (!hand.closed) {
        this.hold.openSince ||= frame.t;
        if (frame.t - this.hold.openSince > 0.12) return this.release(b);
      } else this.hold.openSince = 0;
      const lift = THREE.MathUtils.clamp(handH(hand.point) - this.hold.handH0, -this.hold.height, table ? 0.3 : 1.5);
      target = this.rayAtHeight(hand.screen, Math.max(b.half.y, this.hold.height + lift), space);
      yaw = -(hand.angle - this.hold.angle0);
    } else {
      const [l, r] = [this.rig.get('Left'), this.rig.get('Right')];
      if (!l || !r) return this.release(b);
      const spread = Math.hypot(l.screen.x - r.screen.x, l.screen.y - r.screen.y);
      if (spread > this.hold.spread0 * 1.45 + 0.02) return this.release(b);
      const mid = { x: (l.screen.x + r.screen.x) / 2, y: (l.screen.y + r.screen.y) / 2 };
      const midH = (handH(l.point) + handH(r.point)) / 2;
      const lift = THREE.MathUtils.clamp(midH - this.hold.handH0, -this.hold.height, table ? 0.3 : 1.5);
      target = this.rayAtHeight(mid, Math.max(b.half.y, this.hold.height + lift), space);
      yaw = -(Math.atan2(r.screen.y - l.screen.y, r.screen.x - l.screen.x) - this.hold.angle0);
    }
    if (!target) return;
    // Velocidad (para lanzar) a partir del movimiento del objetivo.
    if (this.lastTarget) this.holdVel.lerp(target.clone().sub(this.lastTarget).divideScalar(Math.max(frame.dt, 1e-3)), 0.35);
    this.lastTarget = target.clone();
    b.body.setNextKinematicTranslation(target);
    b.body.setNextKinematicRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(this.hold.rot));
  }

  private startHold(b: Block, how: { kind: 'one'; hand: Handedness } | { kind: 'two' }, frame: PerceptionFrame) {
    b.body.setBodyType(this.R!.RigidBodyType.KinematicPositionBased, true);
    const r = b.body.rotation();
    const rot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const height = b.body.translation().y;
    const handH = (p: Vec3) => planeHeight(frame.space.surface, p);
    this.lastTarget = null;
    this.holdVel.set(0, 0, 0);
    if (how.kind === 'one') {
      const h = this.rig.get(how.hand)!;
      this.hold = { kind: 'one', hand: how.hand, block: b.id, height, handH0: handH(h.point), angle0: h.angle, rot, openSince: 0 };
    } else {
      const l = this.rig.get('Left')!;
      const rr = this.rig.get('Right')!;
      this.hold = {
        kind: 'two',
        block: b.id,
        height,
        handH0: (handH(l.point) + handH(rr.point)) / 2,
        spread0: Math.hypot(l.screen.x - rr.screen.x, l.screen.y - rr.screen.y),
        angle0: Math.atan2(rr.screen.y - l.screen.y, rr.screen.x - l.screen.x),
        rot,
      };
    }
  }

  private release(b: Block) {
    b.body.setBodyType(this.R!.RigidBodyType.Dynamic, true);
    b.body.setLinvel(throwVelocity(this.holdVel, this.scale < 1 ? 2 : 5), true);
    this.hold = null;
    this.lastTarget = null;
  }

  unmount() {
    this.offEvents.forEach((off) => off());
    this.anchor.dispose();
    this.world?.free();
    this.world = null;
  }
}

export const blocksApp: AppDefinition = {
  id: 'blocks',
  title: 'Bloques',
  icon: 'blocks',
  accent: '#8b5cf6',
  description: 'Agarrá bloques con una mano o con los dos brazos, apilalos y probá la física.',
  kind: 'game',
  modes: ['fullbody', 'table'],
  usesSurface: true,
  create: () => new BlocksApp(),
};
