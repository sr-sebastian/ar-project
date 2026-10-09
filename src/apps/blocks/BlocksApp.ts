import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { seededRandom, type Vec3 } from '../../core/math';
import { storage } from '../../core/settings';
import { BLOCK_COLORS, createToyBlock, createWoodBlock } from '../../models/props';
import { HAND } from '../../perception/landmarks';
import type { HandState, PerceptionFrame } from '../../perception/types';
import type { Handedness } from '../../tracking/types';
import { icon } from '../../ui/icons';
import { SurfaceAnchor } from '../shared/SurfaceAnchor';
import type { AppContext, AppDefinition, AppInstance } from '../types';
import { findOneHandGrab, findTwoHandGrab, throwVelocity, twoHandReleased, type GrabBlock } from './grab';

type Rapier = typeof RAPIER_NS;

interface Block {
  id: number;
  body: RAPIER_NS.RigidBody;
  mesh: THREE.Mesh;
  half: THREE.Vector3;
}

type Hold =
  | { kind: 'one'; hand: Handedness; block: number; offset: THREE.Vector3; rot: THREE.Quaternion; handRot: THREE.Quaternion }
  | { kind: 'two'; block: number; width: number; rot: THREE.Quaternion; yaw0: number };

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
  private handVel: Record<Handedness, THREE.Vector3> = { Left: new THREE.Vector3(), Right: new THREE.Vector3() };
  private prevHand: Record<Handedness, THREE.Vector3 | null> = { Left: null, Right: null };
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

  /** Posición local de la mano (palma; o muñeca de la pose si está lejos). */
  private handPos(h: HandState): THREE.Vector3 | null {
    const p = h.palm3 ?? null;
    return p ? this.anchor.camToLocal(p) : null;
  }

  private closed(h: HandState) {
    return h.source !== 'pose' && (h.gesture === 'fist' || h.pinching || h.mpGesture?.name === 'Closed_Fist');
  }

  private grabBlocks(): GrabBlock[] {
    return this.blocks.map((b) => {
      const t = b.body.translation();
      return { id: b.id, center: { x: t.x, y: t.y, z: t.z }, radius: b.half.length(), inner: Math.min(b.half.x, b.half.y, b.half.z) };
    });
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

    this.updateHands(frame, dt);
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

  /** Colisionadores cinemáticos que siguen a las manos (empujan bloques). */
  private updateHands(frame: PerceptionFrame, dt: number) {
    const R = this.R!;
    const world = this.world!;
    const seen = new Set<string>();
    for (const h of frame.hands) {
      const pos = this.handPos(h);
      if (!pos) continue;
      const prev = this.prevHand[h.handedness];
      if (prev) this.handVel[h.handedness].lerp(pos.clone().sub(prev).divideScalar(Math.max(dt, 1e-3)), 0.4);
      this.prevHand[h.handedness] = pos.clone();
      // Puntos de contacto: palma (+ yemas si hay dedos), salvo la mano que sostiene.
      if (this.hold && (this.hold.kind === 'two' || this.hold.hand === h.handedness)) continue;
      const pts: [string, Vec3, number][] = [[`${h.handedness}:palm`, pos, (h.source === 'pose' ? 0.07 : 0.035) * Math.max(0.4, this.scale)]];
      if (h.camera && h.source !== 'pose') {
        for (const i of [HAND.THUMB_TIP, HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.RING_TIP, HAND.PINKY_TIP]) pts.push([`${h.handedness}:${i}`, this.anchor.camToLocal(h.camera[i]), 0.01]);
      }
      for (const [key, p, r] of pts) {
        seen.add(key);
        let body = this.hands.get(key);
        if (!body) {
          body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z));
          world.createCollider(R.ColliderDesc.ball(r).setFriction(1), body);
          this.hands.set(key, body);
        }
        body.setNextKinematicTranslation({ x: p.x, y: Math.max(p.y, r), z: p.z });
      }
    }
    for (const [key, body] of this.hands) {
      if (seen.has(key)) continue;
      world.removeRigidBody(body);
      this.hands.delete(key);
    }
    for (const side of ['Left', 'Right'] as const) if (!frame.hands.some((h) => h.handedness === side)) this.prevHand[side] = null;
  }

  private updateGrab(frame: PerceptionFrame) {
    const R = this.R!;
    const hands = frame.hands.map((h) => ({ h, pos: this.handPos(h) })).filter((x): x is { h: HandState; pos: THREE.Vector3 } => !!x.pos);
    const byId = (id: number) => this.blocks.find((b) => b.id === id)!;
    const margin = this.scale < 1 ? 0.03 : 0.15;
    const left = hands.find((x) => x.h.handedness === 'Left');
    const right = hands.find((x) => x.h.handedness === 'Right');

    if (!this.hold) {
      const blocks = this.grabBlocks();
      // Primero el abrazo/apretón con dos manos.
      if (left && right) {
        const id = findTwoHandGrab({ id: 'Left', pos: left.pos, closed: false }, { id: 'Right', pos: right.pos, closed: false }, blocks, margin);
        if (id !== null) {
          const b = byId(id);
          b.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
          const r = b.body.rotation();
          this.hold = { kind: 'two', block: id, width: left.pos.distanceTo(right.pos), rot: new THREE.Quaternion(r.x, r.y, r.z, r.w), yaw0: Math.atan2(right.pos.z - left.pos.z, right.pos.x - left.pos.x) };
          return;
        }
      }
      for (const { h, pos } of hands) {
        const id = findOneHandGrab({ id: h.handedness, pos, closed: this.closed(h) }, blocks, margin);
        if (id === null) continue;
        const b = byId(id);
        b.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
        const t = b.body.translation();
        const r = b.body.rotation();
        this.hold = {
          kind: 'one',
          hand: h.handedness,
          block: id,
          offset: new THREE.Vector3(t.x, t.y, t.z).sub(pos),
          rot: new THREE.Quaternion(r.x, r.y, r.z, r.w),
          handRot: this.handQuat(h),
        };
        return;
      }
      return;
    }

    const b = byId(this.hold.block);
    if (!b) {
      this.hold = null;
      return;
    }
    if (this.hold.kind === 'one') {
      const held = hands.find((x) => x.h.handedness === (this.hold as { hand: Handedness }).hand);
      if (!held || !this.closed(held.h)) return this.release(b, held ? this.handVel[held.h.handedness] : null);
      // Sigue a la mano conservando el desfase y girando con la mano.
      const dq = this.handQuat(held.h).multiply(this.hold.handRot.clone().invert());
      const target = held.pos.clone().add(this.hold.offset.clone().applyQuaternion(dq));
      target.y = Math.max(target.y, b.half.y * 0.5);
      b.body.setNextKinematicTranslation(target);
      b.body.setNextKinematicRotation(dq.clone().multiply(this.hold.rot));
    } else {
      if (!left || !right || twoHandReleased(left.pos, right.pos, this.hold.width)) {
        const v = left && right ? this.handVel.Left.clone().add(this.handVel.Right).multiplyScalar(0.5) : null;
        return this.release(b, v);
      }
      const mid = left.pos.clone().add(right.pos).multiplyScalar(0.5);
      mid.y = Math.max(mid.y, b.half.y * 0.5);
      const yaw = Math.atan2(right.pos.z - left.pos.z, right.pos.x - left.pos.x);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(yaw - this.hold.yaw0)).multiply(this.hold.rot);
      b.body.setNextKinematicTranslation(mid);
      b.body.setNextKinematicRotation(q);
    }
  }

  /** Orientación de la mano (local): base con la normal de la palma y la dirección de los dedos. */
  private handQuat(h: HandState): THREE.Quaternion {
    const c = h.camera;
    if (!c || h.source === 'pose' || !h.normal3) return new THREE.Quaternion();
    const n = this.anchor.camDirToLocal(h.normal3).normalize();
    const f = this.anchor.camToLocal(c[HAND.MIDDLE_MCP]).sub(this.anchor.camToLocal(c[HAND.WRIST])).normalize();
    const x = new THREE.Vector3().crossVectors(f, n).normalize();
    const z = new THREE.Vector3().crossVectors(x, f).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, f, z));
  }

  private release(b: Block, v: THREE.Vector3 | null) {
    b.body.setBodyType(this.R!.RigidBodyType.Dynamic, true);
    const tv = throwVelocity(v ?? { x: 0, y: 0, z: 0 }, this.scale < 1 ? 2 : 5);
    b.body.setLinvel(tv, true);
    this.hold = null;
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
