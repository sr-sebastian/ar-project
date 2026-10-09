import * as THREE from 'three';
import { seededRandom, type Vec2 } from '../../core/math';
import { SceneManager } from '../../core/SceneManager';
import { storage } from '../../core/settings';
import { createFruit, createFruitHalf, FRUIT_KINDS, fruitJuiceColor, type FruitKind } from '../../models/fruits';
import { preloadModel } from '../../models/library';
import { createBomb } from '../../models/props';
import { POSE } from '../../perception/landmarks';
import type { PerceptionFrame } from '../../perception/types';
import { icon } from '../../ui/icons';
import { SurfaceAnchor } from '../shared/SurfaceAnchor';
import type { AppContext, AppDefinition, AppInstance } from '../types';
import { KatanaController } from './katana';
import { FruitSlicerGame, type Fruit, type GameEvent, type Sweep } from './logic';

interface Splash {
  at: Vec2;
  color: string;
  born: number;
  r: number;
  drops: { dx: number; dy: number; s: number }[];
}

interface Score {
  score: number;
  date: string;
}

const rnd = seededRandom(99);

/**
 * Fruit Slicer AR (modo cuerpo completo).
 * - Cortás frutas moviendo rápido las manos, o agarrando la katana clavada a tu lado.
 * - Las bombas no se cortan y hay que esquivarlas con la cabeza o el torso.
 * - Para empezar: los dos brazos arriba, pulgar arriba o el botón.
 * - Boca abierta: cámara lenta (una vez). Al terminar, sonreír guarda el puntaje.
 *
 * Las frutas vuelan en un plano a ~0.5 m delante del jugador (en metros reales), así
 * las manos las tapan cuando corresponde y proyectan sombra sobre el piso.
 */
class FruitSlicerApp implements AppInstance {
  get allowPalmBack() {
    return this.game?.state !== 'playing';
  }
  private ctx!: AppContext;
  private game!: FruitSlicerGame;
  private meshes = new Map<number, THREE.Object3D>();
  private halves: { obj: THREE.Object3D; v: THREE.Vector3; spin: THREE.Vector3; life: number }[] = [];
  private root = new THREE.Group();
  private floor!: SurfaceAnchor;
  private katana!: KatanaController;
  private splashes: Splash[] = [];
  private trails: Record<string, Vec2[]> = { Left: [], Right: [] };
  private katanaTrail: { base: Vec2; tip: Vec2; t: number }[] = [];
  private hud!: { score: HTMLElement; lives: HTMLElement; msg: HTMLElement; slow: HTMLElement; best: HTMLElement; katana: HTMLElement };
  private armsUpSince = 0;
  private saved = false;
  private best = storage.get<Score[]>('fruit-slicer:scores', []);
  private offEvents: (() => void)[] = [];
  private aspect = 16 / 9;
  private now = 0;
  /** Profundidad (m) del plano de juego. */
  private depth = 2;

  mount(ctx: AppContext) {
    this.ctx = ctx;
    void preloadModel('katana');
    ctx.scene.scene.add(this.root);
    ctx.setOcclusion({ hands: true, body: true });
    ctx.cursor.setVisible(true);
    this.floor = new SurfaceAnchor(ctx.scene, 3);
    this.katana = new KatanaController(ctx.scene);
    ctx.ui.innerHTML = `
      <div class="game-hud">
        <div class="hud-score">0</div>
        <div class="hud-row hud-lives"></div>
        <span class="hud-badge" data-badge="slow" hidden>${icon('slow', 16)} Cámara lenta</span>
        <span class="hud-badge" data-badge="katana" hidden>${icon('katana', 16)} Katana</span>
      </div>
      <div class="game-msg"></div>
      <div class="game-best"></div>`;
    this.hud = {
      score: ctx.ui.querySelector('.hud-score')!,
      lives: ctx.ui.querySelector('.hud-lives')!,
      msg: ctx.ui.querySelector('.game-msg')!,
      slow: ctx.ui.querySelector('[data-badge="slow"]')!,
      katana: ctx.ui.querySelector('[data-badge="katana"]')!,
      best: ctx.ui.querySelector('.game-best')!,
    };
    this.game = new FruitSlicerGame({ minX: 0, maxX: this.aspect, minY: 0, maxY: 1 });
    this.renderBest();
    this.showMessage(
      `${icon('katana', 26)} Fruit Slicer`,
      'Cortá frutas con las manos o agarrá la <b>katana</b> clavada a tu lado (cerrá el puño sobre el mango). Esquivá las bombas.',
      'Para empezar: levantá los dos brazos, hacé pulgar arriba o usá el botón · Boca abierta = cámara lenta',
      [{ label: `${icon('play', 18)} Empezar`, action: () => this.start(), primary: true }],
    );

    this.offEvents.push(
      ctx.events.on('expression', (e) => {
        if (!e.active) return;
        if (e.name === 'mouthOpen' && this.game.triggerSlowMo()) ctx.toast('Cámara lenta');
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
    this.hud.msg.hidden = true;
    this.ctx.cursor.setVisible(false);
  }

  private saveScore() {
    this.saved = true;
    this.best = [...this.best, { score: this.game.score, date: new Date().toLocaleDateString() }].sort((a, b) => b.score - a.score).slice(0, 5);
    storage.set('fruit-slicer:scores', this.best);
    this.renderBest();
    this.ctx.toast('Puntaje guardado');
  }

  private renderBest() {
    this.hud.best.innerHTML = this.best.length
      ? `<b>${icon('trophy', 16)} Mejores</b>${this.best.map((s, i) => `<div>${i + 1}. ${s.score} <small>${s.date}</small></div>`).join('')}`
      : '';
  }

  private showMessage(title: string, body: string, hint: string, actions: { label: string; action: () => void; primary?: boolean }[]) {
    this.hud.msg.hidden = false;
    this.hud.msg.innerHTML = `<h2>${title}</h2><div>${body}</div><small>${hint}</small><div class="actions"></div>`;
    const box = this.hud.msg.querySelector('.actions')!;
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = a.primary ? 'btn-primary' : 'btn-secondary';
      b.innerHTML = a.label;
      b.onclick = a.action;
      box.appendChild(b);
    }
    this.ctx.cursor.setVisible(true);
  }

  update(frame: PerceptionFrame | null, dt: number) {
    this.now += dt;
    if (frame) {
      this.aspect = frame.aspect;
      this.floor.update(frame.space);
      // El plano de juego se ubica medio metro delante del jugador.
      const body = frame.body?.camera;
      if (body) {
        const z = (body[POSE.LEFT_HIP].z + body[POSE.RIGHT_HIP].z) / 2 - 0.5;
        this.depth += (Math.min(4, Math.max(0.8, z)) - this.depth) * 0.05;
      }
    }
    const vb = this.ctx.scene.viewport.visibleBounds();
    this.game.bounds = { minX: vb.minX * this.aspect, maxX: vb.maxX * this.aspect, minY: vb.minY, maxY: vb.maxY };

    // Inicio con los dos brazos arriba sostenidos medio segundo.
    const m = frame?.body?.metrics;
    if (this.game.state !== 'playing' && m?.leftArmUp && m.rightArmUp) {
      this.armsUpSince ||= this.now;
      if (this.now - this.armsUpSince > 0.5) this.start();
    } else this.armsUpSince = 0;

    const sweep = this.katana.update(frame, dt, this.aspect);
    this.hud.katana.hidden = !this.katana.held;
    const sweeps: Sweep[] = sweep ? [sweep] : [];
    if (sweep) {
      this.katanaTrail.push({ base: sweep.base, tip: sweep.tip, t: this.now });
    }

    const blades = (frame?.hands ?? [])
      .filter((h) => h.handedness !== this.katana.holder)
      .map((h) => ({
        from: { x: h.prevIndexTip.x * this.aspect, y: h.prevIndexTip.y },
        to: { x: h.indexTip.x * this.aspect, y: h.indexTip.y },
        speed: Math.hypot(h.tipVelocity.x, h.tipVelocity.y),
      }));
    const headLm = frame?.face?.center ?? frame?.body?.landmarks[0] ?? null;
    const head = headLm ? { x: headLm.x * this.aspect, y: headLm.y } : null;

    for (const e of this.game.update(dt, { blades, head, sweeps })) this.onEvent(e);

    this.syncMeshes(dt);
    this.drawOverlay(frame);
    this.updateHud();
  }

  private kindOf(f: Fruit): FruitKind {
    return FRUIT_KINDS[f.variant % FRUIT_KINDS.length];
  }

  private onEvent(e: GameEvent) {
    switch (e.type) {
      case 'slice': {
        this.splitFruit(e.fruit);
        this.addSplash(e.fruit, fruitJuiceColor(this.kindOf(e.fruit)), 1);
        if (e.combo >= 3) this.ctx.toast(`Combo x${e.combo}`, 900);
        break;
      }
      case 'bomb':
        this.addSplash(e.fruit, '#ffffff', 3);
        this.removeMesh(e.fruit.id);
        this.flash();
        break;
      case 'gameover':
        this.showMessage(
          `${icon('bomb', 26)} Fin del juego`,
          `<b>${e.score}</b> puntos`,
          'Pulgar arriba para reintentar · sonreí para guardar el puntaje · palma abierta para salir',
          [
            { label: `${icon('reset', 18)} Reintentar`, action: () => this.start(), primary: true },
            { label: `${icon('trophy', 18)} Guardar`, action: () => !this.saved && this.saveScore() },
          ],
        );
        break;
    }
  }

  private addSplash(f: Fruit, color: string, scale: number) {
    const drops = Array.from({ length: 10 }, () => ({ dx: (rnd() - 0.5) * 2, dy: (rnd() - 0.5) * 2, s: 0.2 + rnd() * 0.5 }));
    this.splashes.push({ at: { x: f.x / this.aspect, y: f.y }, color, born: this.now, r: f.r * scale, drops });
  }

  private toWorld(f: { x: number; y: number }, target?: THREE.Vector3) {
    return this.ctx.scene.normToWorld({ x: f.x / this.aspect, y: f.y }, this.depth, target);
  }

  /** Tamaño en metros de 1 "altura de pantalla" a la profundidad de juego. */
  private get metersPerHeight() {
    return 2 * this.depth * Math.tan((this.ctx.scene.camera.fov * Math.PI) / 360);
  }

  private makeMesh(f: Fruit): THREE.Object3D {
    const obj = f.kind === 'bomb' ? createBomb() : createFruit(this.kindOf(f));
    obj.scale.setScalar(f.r * this.metersPerHeight);
    obj.rotation.set(rnd() * 6, rnd() * 6, 0);
    return obj;
  }

  private splitFruit(f: Fruit) {
    const obj = this.meshes.get(f.id);
    if (!obj) return;
    this.removeMesh(f.id);
    const r = f.r * this.metersPerHeight;
    for (const side of [1, -1] as const) {
      const half = createFruitHalf(this.kindOf(f), side);
      half.scale.multiplyScalar(r);
      half.position.copy(obj.position);
      // Las caras cortadas miran hacia los costados.
      half.rotation.set(0, side > 0 ? Math.PI / 2 : -Math.PI / 2, (rnd() - 0.5) * 0.6);
      this.root.add(half);
      this.halves.push({
        obj: half,
        v: new THREE.Vector3(side * (0.8 + rnd() * 0.5), 0.6 + rnd() * 0.6, (rnd() - 0.5) * 0.4).multiplyScalar(this.depth / 2),
        spin: new THREE.Vector3(rnd() * 4, side * 5, rnd() * 3),
        life: 1.4,
      });
    }
  }

  private removeMesh(id: number) {
    const obj = this.meshes.get(id);
    if (!obj) return;
    this.meshes.delete(id);
    SceneManager.disposeObject(obj);
  }

  private syncMeshes(dt: number) {
    const alive = new Set<number>();
    for (const f of this.game.fruits) {
      if (f.sliced) continue;
      alive.add(f.id);
      let obj = this.meshes.get(f.id);
      if (!obj) {
        obj = this.makeMesh(f);
        this.meshes.set(f.id, obj);
        this.root.add(obj);
      }
      this.toWorld(f, obj.position);
      obj.rotation.z += f.spin * dt;
      obj.rotation.x += f.spin * 0.5 * dt;
      const spark = obj.getObjectByName('spark');
      if (spark) spark.scale.setScalar(0.6 + Math.random() * 0.8);
    }
    for (const id of [...this.meshes.keys()]) if (!alive.has(id)) this.removeMesh(id);

    const g = 9.8 * 0.35;
    for (const h of this.halves) {
      h.v.y -= g * dt;
      h.obj.position.addScaledVector(h.v, dt);
      h.obj.rotation.x += h.spin.x * dt;
      h.obj.rotation.y += h.spin.y * dt;
      h.obj.rotation.z += h.spin.z * dt;
      h.life -= dt;
    }
    for (const h of this.halves.filter((x) => x.life <= 0)) SceneManager.disposeObject(h.obj);
    this.halves = this.halves.filter((h) => h.life > 0);
  }

  private drawOverlay(frame: PerceptionFrame | null) {
    const o = this.ctx.overlay;
    const c = o.ctx;

    // Jugo: gotas que se expanden y desvanecen.
    this.splashes = this.splashes.filter((s) => this.now - s.born < 0.9);
    for (const s of this.splashes) {
      const t = (this.now - s.born) / 0.9;
      c.globalAlpha = (1 - t) * 0.9;
      for (const d of s.drops) {
        const p = { x: s.at.x + (d.dx * s.r * (0.5 + t * 2.5)) / this.aspect, y: s.at.y + d.dy * s.r * (0.5 + t * 2.5) + t * t * 0.05 };
        o.circle(p, o.len(s.r * d.s * (1 - t * 0.5)), s.color);
      }
      c.globalAlpha = 1;
    }

    // Estela de las manos (sin katana).
    for (const side of ['Left', 'Right'] as const) {
      const hand = frame?.hands.find((h) => h.handedness === side && side !== this.katana.holder);
      const trail = this.trails[side];
      if (hand) trail.push(hand.indexTip);
      else trail.length = 0;
      while (trail.length > 8) trail.shift();
      const fast = hand && Math.hypot(hand.tipVelocity.x, hand.tipVelocity.y) > 1.1;
      o.polyline(trail, fast ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.25)', fast ? 7 : 3);
    }

    // Estela de la katana: abanico translúcido del barrido reciente.
    this.katanaTrail = this.katanaTrail.filter((k) => this.now - k.t < 0.15);
    if (this.katanaTrail.length > 1) {
      c.beginPath();
      const pts = this.katanaTrail;
      const toPx = (p: Vec2) => o.px({ x: p.x / this.aspect, y: p.y });
      pts.forEach((k, i) => {
        const p = toPx(k.tip);
        if (i === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      });
      for (let i = pts.length - 1; i >= 0; i--) {
        const p = toPx(pts[i].base);
        c.lineTo(p.x, p.y);
      }
      c.closePath();
      c.fillStyle = 'rgba(200,230,255,0.25)';
      c.fill();
    }

    if (this.katana.hovering && !this.katana.held) o.text({ x: 0.5, y: 0.14 }, 'Cerrá el puño para agarrar la katana', { size: 22 });
    if (this.game.state !== 'playing' && this.armsUpSince) o.text({ x: 0.5, y: 0.2 }, '¡Arriba!', { size: 32 });
  }

  private updateHud() {
    this.hud.score.textContent = String(this.game.score);
    const lives = Math.max(0, this.game.lives);
    const html = Array.from({ length: 3 }, (_, i) => (i < lives ? icon('heart', 26) : icon('heart', 26).replace('class="', 'class="lost '))).join('');
    if (this.hud.lives.innerHTML !== html) this.hud.lives.innerHTML = html;
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
    for (const h of this.halves) SceneManager.disposeObject(h.obj);
    SceneManager.disposeObject(this.root);
    this.katana.dispose();
    this.floor.dispose();
    this.ctx.cursor.setVisible(true);
  }
}

export const fruitSlicerApp: AppDefinition = {
  id: 'fruit-slicer',
  title: 'Fruit Slicer',
  icon: 'katana',
  accent: '#ef4444',
  description: 'Cortá frutas con las manos o con una katana. Esquivá las bombas con el cuerpo.',
  kind: 'game',
  modes: ['fullbody'],
  modules: ['pose', 'hands', 'face'],
  usesSurface: true,
  create: () => new FruitSlicerApp(),
};
