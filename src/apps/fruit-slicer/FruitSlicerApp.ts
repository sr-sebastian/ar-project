import * as THREE from 'three';
import type { Vec2 } from '../../core/math';
import { SceneManager } from '../../core/SceneManager';
import { storage } from '../../core/settings';
import { floorScreenY, sampleDepth } from '../../perception/space/surface';
import type { PerceptionFrame } from '../../perception/types';
import type { AppContext, AppDefinition, AppInstance } from '../types';
import { FruitSlicerGame, type Fruit, type GameEvent } from './logic';

const FRUIT_COLORS = [0xe8322f, 0xff9a1f, 0x8fd13f, 0xffd93b, 0x9b4dff];
const JUICE_COLORS = ['#ff4d4d', '#ffae42', '#a8e05f', '#ffe066', '#b47cff'];
const DEPTH = 2.5;

interface Splash {
  at: Vec2;
  color: string;
  born: number;
  r: number;
}

interface Score {
  score: number;
  date: string;
}

/**
 * Fruit Slicer AR (modo cuerpo completo).
 * - Cortás frutas moviendo rápido las manos.
 * - Las bombas no se cortan y hay que esquivarlas con la cabeza/torso.
 * - Levantá los dos brazos (o 👍) para empezar; abrí la boca para cámara lenta (1 vez).
 * - Game over: 👍 reintentar, 😊 sonreír guarda el puntaje en el ranking.
 */
class FruitSlicerApp implements AppInstance {
  allowPalmBack = true;
  private ctx!: AppContext;
  private game!: FruitSlicerGame;
  private meshes = new Map<number, THREE.Object3D>();
  private halves: { obj: THREE.Object3D; v: THREE.Vector3; spin: number; life: number }[] = [];
  private root = new THREE.Group();
  private splashes: Splash[] = [];
  private trails: Record<string, Vec2[]> = { Left: [], Right: [] };
  private hud!: { score: HTMLElement; lives: HTMLElement; msg: HTMLElement; slow: HTMLElement; best: HTMLElement };
  private armsUpSince = 0;
  private saved = false;
  private best = storage.get<Score[]>('fruit-slicer:scores', []);
  private offEvents: (() => void)[] = [];
  private aspect = 16 / 9;
  private now = 0;

  mount(ctx: AppContext) {
    this.ctx = ctx;
    ctx.scene.scene.add(this.root);
    ctx.cursor.setVisible(false);
    ctx.ui.innerHTML = `
      <div class="game-hud">
        <div class="hud-score">0</div>
        <div class="hud-lives"></div>
        <div class="hud-slow" hidden>🐢 CÁMARA LENTA</div>
      </div>
      <div class="game-msg"></div>
      <div class="game-best"></div>`;
    this.hud = {
      score: ctx.ui.querySelector('.hud-score')!,
      lives: ctx.ui.querySelector('.hud-lives')!,
      msg: ctx.ui.querySelector('.game-msg')!,
      slow: ctx.ui.querySelector('.hud-slow')!,
      best: ctx.ui.querySelector('.game-best')!,
    };
    this.game = new FruitSlicerGame({ minX: 0, maxX: this.aspect, minY: 0, maxY: 1 });
    this.renderBest();
    this.setMessage('Levantá los <b>dos brazos</b> o hacé 👍 para empezar<br><small>Cortá frutas con las manos · esquivá las bombas 💣 · abrí la boca para cámara lenta</small>');

    this.offEvents.push(
      ctx.events.on('expression', (e) => {
        if (!e.active) return;
        if (e.name === 'mouthOpen' && this.game.triggerSlowMo()) ctx.toast('🐢 ¡Cámara lenta!');
        if (e.name === 'smile' && this.game.state === 'over' && !this.saved) this.saveScore();
      }),
      ctx.events.on('gesture', (e) => {
        if (e.gesture === 'thumbs_up' && this.game.state !== 'playing') this.start();
      }),
    );
  }

  private start() {
    for (const obj of this.meshes.values()) SceneManager.disposeObject(obj);
    this.meshes.clear();
    this.game.start();
    this.saved = false;
    this.setMessage('');
  }

  private saveScore() {
    this.saved = true;
    this.best = [...this.best, { score: this.game.score, date: new Date().toLocaleDateString() }]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    storage.set('fruit-slicer:scores', this.best);
    this.renderBest();
    this.ctx.toast('😊 ¡Puntaje guardado!');
  }

  private renderBest() {
    this.hud.best.innerHTML = this.best.length
      ? `<b>🏆 Mejores</b>${this.best.map((s, i) => `<div>${i + 1}. ${s.score} <small>${s.date}</small></div>`).join('')}`
      : '';
  }

  private setMessage(html: string) {
    this.hud.msg.innerHTML = html;
    this.hud.msg.hidden = !html;
  }

  update(frame: PerceptionFrame | null, dt: number) {
    this.now += dt;
    if (frame) this.aspect = frame.aspect;
    const vb = this.ctx.scene.viewport.visibleBounds();
    this.game.bounds = { minX: vb.minX * this.aspect, maxX: vb.maxX * this.aspect, minY: vb.minY, maxY: vb.maxY };

    // Inicio con los dos brazos arriba sostenidos medio segundo.
    const m = frame?.body?.metrics;
    if (this.game.state !== 'playing' && m?.leftArmUp && m.rightArmUp) {
      this.armsUpSince ||= this.now;
      if (this.now - this.armsUpSince > 0.5) this.start();
    } else this.armsUpSince = 0;

    const blades = (frame?.hands ?? []).map((h) => ({
      from: { x: h.prevIndexTip.x * this.aspect, y: h.prevIndexTip.y },
      to: { x: h.indexTip.x * this.aspect, y: h.indexTip.y },
      speed: Math.hypot(h.tipVelocity.x, h.tipVelocity.y),
    }));
    // Sin manos detectadas, las muñecas del esqueleto también cortan.
    if (frame?.body && blades.length === 0) {
      for (const i of [15, 16]) {
        const w = frame.body.landmarks[i];
        if ((w.visibility ?? 0) > 0.6) blades.push({ from: { x: w.x * this.aspect, y: w.y }, to: { x: w.x * this.aspect, y: w.y }, speed: 0 });
      }
    }
    const headLm = frame?.face?.center ?? frame?.body?.landmarks[0] ?? null;
    const head = headLm ? { x: headLm.x * this.aspect, y: headLm.y } : null;

    const events = this.game.update(dt, { blades, head });
    for (const e of events) this.onEvent(e);

    this.syncMeshes(dt);
    this.drawOverlay(frame);
    this.updateHud();
  }

  private onEvent(e: GameEvent) {
    switch (e.type) {
      case 'slice': {
        this.splitFruit(e.fruit);
        this.splashes.push({ at: this.toNorm(e.fruit), color: JUICE_COLORS[e.fruit.variant], born: this.now, r: e.fruit.r });
        if (e.combo >= 3) this.ctx.toast(`🔥 Combo x${e.combo}!`, 900);
        break;
      }
      case 'bomb':
        this.splashes.push({ at: this.toNorm(e.fruit), color: '#ffffff', born: this.now, r: e.fruit.r * 3 });
        this.removeMesh(e.fruit.id);
        this.flash();
        break;
      case 'gameover':
        this.setMessage(`💥 <b>Fin del juego</b> · ${e.score} puntos<br><small>👍 para reintentar · 😊 sonreí para guardar el puntaje · 🖐 palma para salir</small>`);
        break;
    }
  }

  private toNorm(f: Fruit): Vec2 {
    return { x: f.x / this.aspect, y: f.y };
  }

  private toWorld(f: { x: number; y: number }, target?: THREE.Vector3) {
    return this.ctx.scene.normToWorld({ x: f.x / this.aspect, y: f.y }, DEPTH, target);
  }

  /** Tamaño en mundo de 1 "altura de pantalla" a la profundidad de juego. */
  private get unitsPerHeight() {
    const cam = this.ctx.scene.camera;
    return 2 * DEPTH * Math.tan((cam.fov * Math.PI) / 360);
  }

  private makeFruitMesh(f: Fruit): THREE.Object3D {
    const r = f.r * this.unitsPerHeight;
    const group = new THREE.Group();
    if (f.kind === 'bomb') {
      const body = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.4, roughness: 0.4 }));
      const fuse = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.08, r * 0.08, r * 0.5), new THREE.MeshStandardMaterial({ color: 0x8b5a2b }));
      fuse.position.y = r * 1.1;
      const spark = new THREE.Mesh(new THREE.SphereGeometry(r * 0.18, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff5522 }));
      spark.position.y = r * 1.4;
      spark.name = 'spark';
      group.add(body, fuse, spark);
    } else {
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 16),
        new THREE.MeshStandardMaterial({ color: FRUIT_COLORS[f.variant], roughness: 0.45 }),
      );
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(r * 0.25, r * 0.5, 6), new THREE.MeshStandardMaterial({ color: 0x2f9e44 }));
      leaf.position.y = r * 1.05;
      leaf.rotation.z = 0.5;
      group.add(body, leaf);
    }
    return group;
  }

  private splitFruit(f: Fruit) {
    const obj = this.meshes.get(f.id);
    if (!obj) return;
    this.removeMesh(f.id, false);
    const r = f.r * this.unitsPerHeight;
    for (const side of [-1, 1]) {
      const half = new THREE.Mesh(
        new THREE.SphereGeometry(r, 20, 12, side > 0 ? 0 : Math.PI, Math.PI),
        new THREE.MeshStandardMaterial({ color: FRUIT_COLORS[f.variant], side: THREE.DoubleSide }),
      );
      half.position.copy(obj.position);
      half.rotation.copy(obj.rotation);
      this.root.add(half);
      this.halves.push({ obj: half, v: new THREE.Vector3(side * 1.2, 0.6, 0), spin: side * 6, life: 1.2 });
    }
    SceneManager.disposeObject(obj);
  }

  private removeMesh(id: number, dispose = true) {
    const obj = this.meshes.get(id);
    if (!obj) return;
    this.meshes.delete(id);
    if (dispose) SceneManager.disposeObject(obj);
  }

  private syncMeshes(dt: number) {
    const alive = new Set<number>();
    for (const f of this.game.fruits) {
      if (f.sliced) continue;
      alive.add(f.id);
      let obj = this.meshes.get(f.id);
      if (!obj) {
        obj = this.makeFruitMesh(f);
        this.meshes.set(f.id, obj);
        this.root.add(obj);
      }
      this.toWorld(f, obj.position);
      obj.rotation.z += f.spin * dt;
      obj.rotation.x += f.spin * 0.5 * dt;
      const spark = obj.getObjectByName('spark');
      if (spark) spark.scale.setScalar(0.7 + Math.random() * 0.6);
    }
    for (const id of [...this.meshes.keys()]) if (!alive.has(id)) this.removeMesh(id);

    for (const h of this.halves) {
      h.v.y -= 3 * dt;
      h.obj.position.addScaledVector(h.v, dt);
      h.obj.rotation.z += h.spin * dt;
      h.life -= dt;
    }
    for (const h of this.halves.filter((x) => x.life <= 0)) SceneManager.disposeObject(h.obj);
    this.halves = this.halves.filter((h) => h.life > 0);
  }

  /** Altura de pantalla del piso en la columna `u`, si se puede saber. */
  private floorAt(frame: PerceptionFrame | null, u: number): number | null {
    if (!frame) return null;
    const feet = frame.body?.metrics.floorY;
    if (feet != null) return feet;
    const s = frame.space;
    if (s.surfaceSource !== 'depth' || !s.depth || !frame.body) return null;
    const torso = frame.body.metrics.torsoCenter;
    const z = sampleDepth(s.depth, torso.x, torso.y);
    const y = floorScreenY(s.surface, s.intrinsics, u, z);
    return y !== null && y > 0 && y < 1.2 ? y : null;
  }

  private drawOverlay(frame: PerceptionFrame | null) {
    const o = this.ctx.overlay;
    const c = o.ctx;

    // Sombras sobre el piso.
    for (const f of this.game.fruits) {
      if (f.sliced) continue;
      const u = f.x / this.aspect;
      const floorY = this.floorAt(frame, u);
      if (floorY === null) break;
      const height = Math.max(0, floorY - f.y);
      const s = o.px({ x: u, y: floorY });
      const rx = o.len(f.r) * (1.2 - Math.min(0.8, height));
      c.fillStyle = `rgba(0,0,0,${0.35 * (1 - Math.min(0.9, height))})`;
      c.beginPath();
      c.ellipse(s.x, s.y, rx, rx * 0.3, 0, 0, Math.PI * 2);
      c.fill();
    }

    // Jugo de las frutas cortadas.
    this.splashes = this.splashes.filter((s) => this.now - s.born < 0.8);
    for (const s of this.splashes) {
      const t = (this.now - s.born) / 0.8;
      c.globalAlpha = 1 - t;
      o.circle(s.at, o.len(s.r) * (1 + t * 2), s.color);
      c.globalAlpha = 1;
    }

    // Estela de cada mano.
    for (const side of ['Left', 'Right'] as const) {
      const hand = frame?.hands.find((h) => h.handedness === side);
      const trail = this.trails[side];
      if (hand) trail.push(hand.indexTip);
      else trail.length = 0;
      while (trail.length > 8) trail.shift();
      const fast = hand && Math.hypot(hand.tipVelocity.x, hand.tipVelocity.y) > 1.1;
      o.polyline(trail, fast ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)', fast ? 8 : 4);
    }

    if (this.game.state !== 'playing' && this.armsUpSince) o.text({ x: 0.5, y: 0.2 }, '¡Arriba! 🙌', { size: 32 });
  }

  private updateHud() {
    this.hud.score.textContent = String(this.game.score);
    this.hud.lives.textContent = '❤️'.repeat(Math.max(0, this.game.lives)) + '🖤'.repeat(Math.max(0, 3 - this.game.lives));
    this.hud.slow.hidden = !this.game.slowMoActive;
  }

  private flash() {
    const el = document.createElement('div');
    el.className = 'flash';
    this.ctx.ui.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }

  unmount() {
    this.offEvents.forEach((off) => off());
    SceneManager.disposeObject(this.root);
    this.ctx.cursor.setVisible(true);
  }
}

export const fruitSlicerApp: AppDefinition = {
  id: 'fruit-slicer',
  title: 'Fruit Slicer',
  icon: '🍉',
  description: 'Cortá frutas con las manos, esquivá bombas con el cuerpo y usá la cara para la cámara lenta.',
  kind: 'game',
  modes: ['fullbody'],
  modules: ['pose', 'hands', 'face'],
  create: () => new FruitSlicerApp(),
};
