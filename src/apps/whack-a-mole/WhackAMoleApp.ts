import * as THREE from 'three';
import { dist2, type Vec2 } from '../../core/math';
import { storage } from '../../core/settings';
import type { HandState, PerceptionFrame } from '../../perception/types';
import { makeSurfaceGrid, SurfaceAnchor } from '../shared/SurfaceAnchor';
import type { AppContext, AppDefinition, AppInstance } from '../types';
import { WhackAMoleGame, type WhackEvent } from './logic';

const COLS = 3;
const ROWS = 3;
/** Separación entre agujeros en unidades locales (fracción de la distancia a la mesa). */
const SPACING = 0.13;
const HOLE_R = 0.045;
/** Velocidad hacia abajo en pantalla (alturas/s) que cuenta como "golpe". */
const SLAM_SPEED = 0.5;

interface Pow {
  at: Vec2;
  text: string;
  born: number;
  color: string;
}

/**
 * Aplastá al Topo (modo mesa). Los topos salen de agujeros apoyados sobre la mesa
 * detectada; se aplastan bajando la mano rápido sobre ellos o cerrando el puño encima.
 * Levantar las cejas congela a los topos (una vez por partida).
 */
class WhackAMoleApp implements AppInstance {
  private ctx!: AppContext;
  private game = new WhackAMoleGame(COLS * ROWS);
  private anchor!: SurfaceAnchor;
  private moleMeshes: THREE.Object3D[] = [];
  private holeCenters: THREE.Vector3[] = [];
  private pows: Pow[] = [];
  private prevGesture: Record<string, string> = {};
  private hud!: { score: HTMLElement; time: HTMLElement; msg: HTMLElement; freeze: HTMLElement };
  private best = storage.get<number>('whack-a-mole:best', 0);
  private offEvents: (() => void)[] = [];
  private now = 0;

  get allowPalmBack() {
    // Apoyar la mano abierta sobre la mesa es parte del juego: sólo sale fuera de la partida.
    return this.game.state !== 'playing';
  }

  mount(ctx: AppContext) {
    this.ctx = ctx;
    ctx.ui.innerHTML = `
      <div class="game-hud">
        <div class="hud-score">0</div>
        <div class="hud-time"></div>
        <div class="hud-slow" hidden>🧊 ¡CONGELADOS!</div>
      </div>
      <div class="game-msg"></div>`;
    this.hud = {
      score: ctx.ui.querySelector('.hud-score')!,
      time: ctx.ui.querySelector('.hud-time')!,
      msg: ctx.ui.querySelector('.game-msg')!,
      freeze: ctx.ui.querySelector('.hud-slow')!,
    };
    this.showIdleMessage('Poné las manos sobre la mesa y aplastá a los topos 🐹');

    this.anchor = new SurfaceAnchor(ctx.scene, { x: 0.5, y: 0.62 });
    this.buildBoard();

    this.offEvents.push(
      ctx.events.on('gesture', (e) => {
        if (e.gesture === 'thumbs_up' && this.game.state !== 'playing') this.start();
      }),
      ctx.events.on('expression', (e) => {
        if (e.active && e.name === 'browsUp' && this.game.triggerFreeze()) ctx.toast('🧊 ¡Topos congelados!');
      }),
    );
  }

  private showIdleMessage(title: string) {
    this.hud.msg.hidden = false;
    this.hud.msg.innerHTML = `${title}<br><small>Bajá la mano rápido o cerrá el puño sobre el topo · 🤨 cejas arriba = congelar · Récord: ${this.best}</small>
      <div><button class="btn-primary" data-act="start">▶ Empezar</button></div>`;
    this.hud.msg.querySelector<HTMLButtonElement>('[data-act="start"]')!.onclick = () => this.start();
    this.ctx.cursor.setVisible(true);
  }

  private start() {
    this.game.start();
    this.hud.msg.hidden = true;
    this.ctx.cursor.setVisible(false);
  }

  private buildBoard() {
    const g = this.anchor.group;
    const width = SPACING * (COLS - 1) + HOLE_R * 4;
    const depth = SPACING * (ROWS - 1) + HOLE_R * 4;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x5aa83a, transparent: true, opacity: 0.55, roughness: 0.9 }),
    );
    g.add(board);
    const grid = makeSurfaceGrid(width, 8, 0x9be37a);
    grid.position.y = 0.0005;
    g.add(grid);

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const center = new THREE.Vector3((col - (COLS - 1) / 2) * SPACING, 0, (row - (ROWS - 1) / 2) * SPACING);
        this.holeCenters.push(center);
        const hole = new THREE.Mesh(new THREE.CircleGeometry(HOLE_R, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1b1208 }));
        hole.position.copy(center).setY(0.001);
        g.add(hole);

        const mole = new THREE.Group();
        const body = new THREE.Mesh(
          new THREE.CapsuleGeometry(HOLE_R * 0.7, HOLE_R * 0.9, 6, 16),
          new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8 }),
        );
        body.name = 'body';
        body.position.y = HOLE_R * 1.1;
        const eyeGeo = new THREE.SphereGeometry(HOLE_R * 0.12, 8, 8);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
        for (const side of [-1, 1]) {
          const eye = new THREE.Mesh(eyeGeo, eyeMat);
          eye.position.set(side * HOLE_R * 0.28, HOLE_R * 1.75, HOLE_R * 0.62);
          mole.add(eye);
        }
        const nose = new THREE.Mesh(new THREE.SphereGeometry(HOLE_R * 0.16, 8, 8), new THREE.MeshStandardMaterial({ color: 0xff8fa3 }));
        nose.position.set(0, HOLE_R * 1.5, HOLE_R * 0.72);
        mole.add(body, nose);
        mole.position.copy(center);
        mole.visible = false;
        // Recorte: el topo "sale" del agujero escalando en Y desde la superficie.
        g.add(mole);
        this.moleMeshes.push(mole);
      }
    }
  }

  /** Agujeros proyectados a pantalla: centro y radio (normalizados al alto del video). */
  private projectHoles(aspect: number) {
    return this.holeCenters.map((c) => {
      const center = this.anchor.localToNorm(c);
      const edge = this.anchor.localToNorm(c.clone().add(new THREE.Vector3(HOLE_R * 1.6, 0, 0)));
      const top = this.anchor.localToNorm(c.clone().add(new THREE.Vector3(0, HOLE_R * 2.5, 0)));
      const r = Math.max(dist2({ x: center.x * aspect, y: center.y }, { x: edge.x * aspect, y: edge.y }), 0.02);
      return { center, top, r };
    });
  }

  private detectSmashes(hands: HandState[], aspect: number): number[] {
    const holes = this.projectHoles(aspect);
    const smashed = new Set<number>();
    for (const h of hands) {
      const becameFist = h.gesture === 'fist' && this.prevGesture[h.handedness] !== 'fist';
      this.prevGesture[h.handedness] = h.gesture;
      const slamming = h.velocity.y > SLAM_SPEED;
      if (!slamming && !becameFist) continue;
      // Puntos de contacto: palma y yemas.
      const contacts = [h.palmCenter, h.indexTip, h.landmarks[12], h.landmarks[16]];
      holes.forEach((hole, i) => {
        // El topo ocupa desde el agujero hasta su cabeza: chequeamos ambos puntos.
        const hit = contacts.some((p) =>
          [hole.center, hole.top].some((q) => Math.hypot((p.x - q.x) * aspect, p.y - q.y) < hole.r * 1.3),
        );
        if (hit) smashed.add(i);
      });
    }
    return [...smashed];
  }

  update(frame: PerceptionFrame | null, dt: number) {
    this.now += dt;
    const aspect = frame?.aspect ?? this.ctx.scene.viewport.videoAspect;
    if (frame) this.anchor.update(frame.space);

    const smashes = frame && this.game.state === 'playing' ? this.detectSmashes(frame.hands, aspect) : [];
    for (const e of this.game.update(dt, smashes)) this.onEvent(e, aspect);

    this.game.moles.forEach((m, i) => {
      const mesh = this.moleMeshes[i];
      mesh.visible = m.height > 0.01;
      mesh.scale.set(1, Math.max(0.01, m.height), 1);
      const body = mesh.getObjectByName('body') as THREE.Mesh;
      (body.material as THREE.MeshStandardMaterial).color.setHex(m.phase === 'hit' ? 0xff4444 : m.golden ? 0xffc83d : 0x8b5a2b);
    });

    this.drawOverlay(frame);
    this.hud.score.textContent = String(this.game.score);
    this.hud.time.textContent = this.game.state === 'playing' ? `⏱ ${Math.ceil(this.game.timeLeft)}s` : '';
    this.hud.freeze.hidden = !this.game.frozen;
  }

  private onEvent(e: WhackEvent, aspect: number) {
    if (e.type === 'hit') {
      const hole = this.projectHoles(aspect)[e.hole];
      this.pows.push({ at: hole.top, text: e.golden ? `+${e.points} ⭐` : `+${e.points}`, born: this.now, color: e.golden ? '#ffd43b' : '#fff' });
    } else if (e.type === 'gameover') {
      const record = e.score > this.best;
      if (record) {
        this.best = e.score;
        storage.set('whack-a-mole:best', e.score);
      }
      const accuracy = e.hits + e.misses ? Math.round((e.hits / (e.hits + e.misses)) * 100) : 0;
      this.showIdleMessage(`${record ? '🏆 ¡Nuevo récord!' : '⏰ ¡Tiempo!'} <b>${e.score}</b> puntos · ${e.hits} topos · ${accuracy}% de puntería<br>👍 o el botón para jugar otra vez`);
    }
  }

  private drawOverlay(frame: PerceptionFrame | null) {
    const o = this.ctx.overlay;
    for (const h of frame?.hands ?? []) {
      const slamming = h.velocity.y > SLAM_SPEED || h.gesture === 'fist';
      o.circle(h.palmCenter, slamming ? 26 : 18, slamming ? 'rgba(255,90,90,0.35)' : 'rgba(255,255,255,0.2)', '#fff', 2);
    }
    this.pows = this.pows.filter((p) => this.now - p.born < 0.7);
    for (const p of this.pows) {
      const t = (this.now - p.born) / 0.7;
      o.ctx.globalAlpha = 1 - t;
      o.text({ x: p.at.x, y: p.at.y - t * 0.08 }, p.text, { size: 30, color: p.color, font: '800' });
      o.ctx.globalAlpha = 1;
    }
    if (frame?.space.surfaceSource === 'assumed' && this.game.state !== 'playing') {
      o.text({ px: o.canvas.clientWidth / 2, py: 24 }, 'Superficie supuesta · activá "Espacio 3D" en ⚙️ para detectar la mesa', { size: 14, color: '#ffe08a' });
    }
  }

  unmount() {
    this.offEvents.forEach((off) => off());
    this.anchor.dispose();
    this.ctx.cursor.setVisible(true);
  }
}

export const whackAMoleApp: AppDefinition = {
  id: 'whack-a-mole',
  title: 'Aplastá al Topo',
  icon: '🐹',
  description: 'Los topos salen de la mesa: aplastalos con la mano. Levantá las cejas para congelarlos.',
  kind: 'game',
  modes: ['table'],
  modules: ['hands', 'face'],
  create: () => new WhackAMoleApp(),
};
