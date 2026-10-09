import * as THREE from 'three';
import type { Vec2 } from '../../core/math';
import { storage } from '../../core/settings';
import { customModel, preloadModel } from '../../models/library';
import { SceneManager } from '../../core/SceneManager';
import { createHammer, createMole, createMoleBoard } from '../../models/props';
import type { PerceptionFrame } from '../../perception/types';
import { icon } from '../../ui/icons';
import { HandRig, screenBox } from '../shared/HandRig';
import { SurfaceAnchor } from '../shared/SurfaceAnchor';
import type { AppContext, AppDefinition, AppInstance } from '../types';
import { swingHit, WhackAMoleGame, type WhackEvent } from './logic';

const COLS = 3;
const ROWS = 3;
/** Medidas reales del tablero (m). */
const SPACING = 0.13;
const HOLE_R = 0.042;
const MOLE_H = 0.1;
const BOARD = SPACING * (COLS - 1) + HOLE_R * 5;
const BOARD_TOP = 0.02;

interface Pow {
  at: Vec2;
  text: string;
  born: number;
  color: string;
}

/**
 * Aplastá al Topo (modo mesa). El tablero mide ~45 cm y se apoya sobre la mesa real
 * (marcador impreso, mano apoyada o profundidad). Los topos salen de adentro de los
 * agujeros (un plano de recorte en la superficie los oculta por debajo), las manos los
 * tapan cuando están delante y se golpean en 3D: la palma tiene que bajar rápido hasta la
 * altura del topo, encima de su agujero.
 */
class WhackAMoleApp implements AppInstance {
  private ctx!: AppContext;
  private game = new WhackAMoleGame(COLS * ROWS);
  private anchor!: SurfaceAnchor;
  private moles: THREE.Object3D[] = [];
  private moleBodies: THREE.MeshStandardMaterial[] = [];
  private holes: THREE.Vector3[] = [];
  private clip = new THREE.Plane();
  private pows: Pow[] = [];
  private hud!: { score: HTMLElement; time: HTMLElement; msg: HTMLElement; freeze: HTMLElement };
  private best = storage.get<number>('whack-a-mole:best', 0);
  private offEvents: (() => void)[] = [];
  private now = 0;
  private rig = new HandRig();
  private hammer = createHammer(0.24);
  private lastHead: Vec2 | null = null;

  mount(ctx: AppContext) {
    this.ctx = ctx;
    void preloadModel('mole');
    ctx.setOcclusion({ hands: true, body: false });
    ctx.ui.innerHTML = `
      <div class="game-hud">
        <div class="hud-score">0</div>
        <div class="hud-row hud-time"></div>
        <span class="hud-badge" hidden>${icon('freeze', 16)} Congelados</span>
      </div>
      <div class="game-msg"></div>`;
    this.hud = {
      score: ctx.ui.querySelector('.hud-score')!,
      time: ctx.ui.querySelector('.hud-time')!,
      msg: ctx.ui.querySelector('.game-msg')!,
      freeze: ctx.ui.querySelector('.hud-badge')!,
    };
    this.anchor = new SurfaceAnchor(ctx.scene, BOARD * 1.6);
    this.buildBoard();
    this.hammer.group.visible = false;
    ctx.scene.scene.add(this.hammer.group);
    this.showIdle(`${icon('hammer', 26)} Aplastá al Topo`, `El martillo aparece en tu mano: dale un martillazo rápido a cada topo que asome. Levantá las cejas para congelarlos (una vez). Récord: <b>${this.best}</b>`);

    this.offEvents.push(
      ctx.events.on('gesture', (e) => {
        if (e.gesture === 'thumbs_up' && this.game.state !== 'playing') this.start();
      }),
      ctx.events.on('expression', (e) => {
        if (e.active && e.name === 'browsUp' && this.game.triggerFreeze()) ctx.toast('Topos congelados');
      }),
    );
  }

  private showIdle(title: string, body: string) {
    this.hud.msg.hidden = false;
    this.hud.msg.innerHTML = `<h2>${title}</h2><div>${body}</div>
      <small>Pulgar arriba o el botón para empezar</small>
      <div class="actions"><button class="btn-primary" data-act="start">${icon('play', 18)} Empezar</button>
      <button class="btn-secondary" data-act="recal">${icon('recalibrate', 18)} Ubicar mesa</button></div>`;
    this.hud.msg.querySelector<HTMLButtonElement>('[data-act="start"]')!.onclick = () => this.start();
    this.hud.msg.querySelector<HTMLButtonElement>('[data-act="recal"]')!.onclick = () => this.ctx.recalibrate();
    this.ctx.cursor.setVisible(true);
  }

  private start() {
    this.game.start();
    this.hud.msg.hidden = true;
    this.ctx.cursor.setVisible(false);
  }

  private buildBoard() {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        this.holes.push(new THREE.Vector3((col - (COLS - 1) / 2) * SPACING, 0, (row - (ROWS - 1) / 2) * SPACING));
      }
    }
    this.anchor.group.add(createMoleBoard(BOARD, BOARD, this.holes, HOLE_R));
    for (const h of this.holes) {
      const mole = customModel('mole') ?? createMole();
      mole.scale.setScalar(MOLE_H);
      mole.position.set(h.x, BOARD_TOP - MOLE_H, h.z);
      mole.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Material propio por topo (para teñirlo) y recorte en la superficie del tablero.
        mesh.material = (mesh.material as THREE.Material).clone();
        (mesh.material as THREE.Material).clippingPlanes = [this.clip];
        if (mesh.name === 'body') this.moleBodies.push(mesh.material as THREE.MeshStandardMaterial);
      });
      this.anchor.group.add(mole);
      this.moles.push(mole);
    }
  }

  /** Zona en pantalla que ocupa cada topo (de la base del agujero a la cabeza). */
  private moleRegions(aspect: number) {
    return this.holes.map((hole, i) => {
      const h = BOARD_TOP + MOLE_H * Math.max(0.3, this.game.moles[i].height);
      const pts: Vec2[] = [];
      for (const y of [BOARD_TOP, h]) {
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          pts.push(this.anchor.localToNorm(new THREE.Vector3(hole.x + dx * HOLE_R * 1.2, y, hole.z + dz * HOLE_R * 1.2)));
        }
      }
      // Margen generoso: el golpe se decide en pantalla, donde la detección es precisa.
      return screenBox(pts, 0.02, aspect);
    });
  }

  /** Coloca el martillo en la mano (o lo oculta) y devuelve la cabeza en pantalla. */
  private updateHammer(): { head: Vec2; peak: number } | null {
    const hand = this.rig.primary();
    if (!hand || hand.hand.source === 'pose') {
      this.hammer.group.visible = false;
      return null;
    }
    this.hammer.group.visible = true;
    // Mango en el plano de la imagen, según el ángulo de la mano (estable), apenas inclinado.
    const dir = this.ctx.scene.camDirToWorld({ x: Math.cos(hand.angle), y: Math.sin(hand.angle), z: 0.15 }).normalize();
    const pos = this.ctx.scene.camToWorld(hand.point);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
    this.hammer.group.position.lerp(pos, 0.6);
    this.hammer.group.quaternion.slerp(q, 0.4);
    this.hammer.group.updateMatrixWorld(true);
    const headWorld = this.hammer.head.clone().applyMatrix4(this.hammer.group.matrixWorld);
    const n = this.ctx.scene.worldToNorm(headWorld);
    return { head: { x: n.x, y: n.y }, peak: hand.recentPeak };
  }

  private detectSmashes(aspect: number): number[] {
    const hammer = this.updateHammer();
    if (!hammer) return [];
    this.lastHead = hammer.head;
    const regions = this.moleRegions(aspect);
    const smashed: number[] = [];
    regions.forEach((r, i) => {
      if (swingHit(hammer.head, hammer.peak, r)) smashed.push(i);
    });
    return smashed;
  }

  update(frame: PerceptionFrame | null, dt: number) {
    this.now += dt;
    if (frame) this.anchor.update(frame.space);
    this.rig.update(frame, (p, z) => this.ctx.scene.worldToCam(this.ctx.scene.normToWorld(p, z)), 0.6);
    const aspect = frame?.aspect ?? this.ctx.scene.viewport.videoAspect;
    // Plano de recorte = superficie del tablero, normal hacia arriba (mundo).
    const up = new THREE.Vector3(0, 1, 0).transformDirection(this.anchor.group.matrixWorld);
    this.clip.setFromNormalAndCoplanarPoint(up, this.anchor.localToWorld(new THREE.Vector3(0, BOARD_TOP, 0)));

    const smashes = this.detectSmashes(aspect).filter(() => this.game.state === 'playing');
    for (const e of this.game.update(dt, smashes)) this.onEvent(e);

    this.game.moles.forEach((m, i) => {
      const mole = this.moles[i];
      mole.position.y = BOARD_TOP - MOLE_H + MOLE_H * 1.05 * m.height;
      mole.visible = m.height > 0.01;
      // Aplastado: se achata.
      mole.scale.set(MOLE_H, MOLE_H * (m.phase === 'hit' ? 0.55 : 1), MOLE_H);
      const mat = this.moleBodies[i];
      if (mat) mat.color.setHex(m.phase === 'hit' ? 0xff8888 : m.golden ? 0xffd54f : 0xffffff);
    });

    this.drawOverlay(frame);
    this.hud.score.textContent = String(this.game.score);
    this.hud.time.innerHTML = this.game.state === 'playing' ? `${icon('timer', 22)} ${Math.ceil(this.game.timeLeft)} s` : '';
    this.hud.freeze.hidden = !this.game.frozen;
  }

  private onEvent(e: WhackEvent) {
    if (e.type === 'hit') {
      const top = this.anchor.localToNorm(this.holes[e.hole].clone().setY(BOARD_TOP + MOLE_H));
      this.pows.push({ at: top, text: `+${e.points}`, born: this.now, color: e.golden ? '#ffd43b' : '#fff' });
    } else if (e.type === 'gameover') {
      const record = e.score > this.best;
      if (record) {
        this.best = e.score;
        storage.set('whack-a-mole:best', e.score);
      }
      const accuracy = e.hits + e.misses ? Math.round((e.hits / (e.hits + e.misses)) * 100) : 0;
      this.showIdle(
        `${icon(record ? 'trophy' : 'timer', 26)} ${record ? '¡Nuevo récord!' : '¡Tiempo!'}`,
        `<b>${e.score}</b> puntos · ${e.hits} topos · ${accuracy}% de puntería`,
      );
    }
  }

  private drawOverlay(frame: PerceptionFrame | null) {
    const o = this.ctx.overlay;
    this.pows = this.pows.filter((p) => this.now - p.born < 0.7);
    for (const p of this.pows) {
      const t = (this.now - p.born) / 0.7;
      o.ctx.globalAlpha = 1 - t;
      o.text({ x: p.at.x, y: p.at.y - t * 0.08 }, p.text, { size: 32, color: p.color, font: '800' });
      o.ctx.globalAlpha = 1;
    }
    // Sombra/objetivo de la cabeza del martillo sobre el tablero.
    if (this.lastHead && this.hammer.group.visible && frame) {
      const fast = (this.rig.primary()?.recentPeak ?? 0) > 0.9;
      o.circle(this.lastHead, fast ? 20 : 14, fast ? 'rgba(255,90,90,0.3)' : 'rgba(255,255,255,0.12)', fast ? '#ff6b6b' : 'rgba(255,255,255,0.6)', 2);
    }
  }

  unmount() {
    this.offEvents.forEach((off) => off());
    this.anchor.dispose();
    SceneManager.disposeObject(this.hammer.group);
    this.ctx.cursor.setVisible(true);
  }
}

export const whackAMoleApp: AppDefinition = {
  id: 'whack-a-mole',
  title: 'Aplastá al Topo',
  icon: 'hammer',
  accent: '#22c55e',
  description: 'Los topos salen de un tablero sobre tu mesa real. Aplastalos con la mano.',
  kind: 'game',
  modes: ['table'],
  modules: ['hands', 'face'],
  usesSurface: true,
  create: () => new WhackAMoleApp(),
};
