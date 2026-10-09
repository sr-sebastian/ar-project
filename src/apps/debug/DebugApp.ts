import * as THREE from 'three';
import { SceneManager } from '../../core/SceneManager';
import { HAND_CONNECTIONS, POSE_CONNECTIONS } from '../../perception/landmarks';
import { depthToPoints } from '../../perception/space/surface';
import type { PerceptionFrame } from '../../perception/types';
import { makeSurfaceGrid, SurfaceAnchor } from '../shared/SurfaceAnchor';
import type { AppContext, AppDefinition, AppInstance } from '../types';

const GESTURE_LABEL: Record<string, string> = {
  none: '—',
  pinch: '🤏 pinch',
  fist: '✊ puño',
  open_palm: '🖐 palma',
  point: '☝️ apuntar',
  victory: '✌️ victoria',
  thumbs_up: '👍',
  thumbs_down: '👎',
  rock: '🤘',
};

/** Visor de todo lo que detecta el sistema: esqueleto, manos, cara, expresiones y espacio. */
class DebugApp implements AppInstance {
  private ctx!: AppContext;
  private panel!: HTMLDivElement;
  private depthCanvas!: HTMLCanvasElement;
  private anchor!: SurfaceAnchor;
  private cloud: THREE.Points | null = null;
  private showCloud = false;
  private lastDepth: unknown = null;
  private logLines: string[] = [];
  private offEvents: (() => void)[] = [];

  mount(ctx: AppContext) {
    this.ctx = ctx;
    ctx.ui.innerHTML = `
      <div class="debug-panel">
        <div class="debug-actions">
          <button data-act="depth">Espacio 3D: <b>${ctx.depthEnabled ? 'ON' : 'OFF'}</b></button>
          <button data-act="cloud">Nube de puntos</button>
        </div>
        <div class="debug-body"></div>
        <canvas class="depth-thumb" hidden></canvas>
        <div class="debug-log"></div>
      </div>`;
    this.panel = ctx.ui.querySelector('.debug-body')!;
    this.depthCanvas = ctx.ui.querySelector('.depth-thumb')!;
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="depth"]')!.onclick = (e) => {
      ctx.setDepth(!ctx.depthEnabled);
      (e.currentTarget as HTMLElement).querySelector('b')!.textContent = ctx.depthEnabled ? 'ON' : 'OFF';
    };
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="cloud"]')!.onclick = () => {
      this.showCloud = !this.showCloud;
      if (this.cloud) this.cloud.visible = this.showCloud;
    };

    this.anchor = new SurfaceAnchor(ctx.scene, ctx.mode.surface === 'floor' ? { x: 0.5, y: 0.85 } : { x: 0.5, y: 0.65 });
    this.anchor.group.add(makeSurfaceGrid(1, 10));

    const log = (s: string) => {
      this.logLines = [s, ...this.logLines].slice(0, 6);
      ctx.ui.querySelector('.debug-log')!.innerHTML = this.logLines.map((l) => `<div>${l}</div>`).join('');
    };
    this.offEvents.push(
      ctx.events.on('gesture', (e) => e.gesture !== 'none' && log(`${e.hand === 'Left' ? 'Izq' : 'Der'}: ${GESTURE_LABEL[e.gesture]}`)),
      ctx.events.on('swipe', (e) => log(`swipe ${e.direction} (${e.hand})`)),
      ctx.events.on('expression', (e) => e.active && log(`cara: ${e.name}`)),
    );
  }

  update(frame: PerceptionFrame | null) {
    const o = this.ctx.overlay;
    if (!frame) {
      this.panel.innerHTML = '<p>Esperando tracking…</p>';
      return;
    }

    if (frame.body) {
      const lm = frame.body.landmarks;
      o.skeleton(lm, POSE_CONNECTIONS, 'rgba(80,220,255,0.9)', 4, (i) => lm[i].visibility ?? 1);
      for (const p of lm) if ((p.visibility ?? 1) > 0.5) o.circle(p, 4, '#fff');
      const m = frame.body.metrics;
      if (m.floorY !== null) o.line({ x: 0, y: m.floorY }, { x: 1, y: m.floorY }, 'rgba(255,200,80,0.6)', 2);
    }

    for (const h of frame.hands) {
      const color = h.handedness === 'Left' ? '#ffb347' : '#7dff8a';
      o.skeleton(h.landmarks, HAND_CONNECTIONS, color, 3);
      for (const p of h.landmarks) o.circle(p, 3, '#fff');
      o.text({ x: h.landmarks[0].x, y: h.landmarks[0].y + 0.05 }, `${h.handedness === 'Left' ? 'Izq' : 'Der'} · ${GESTURE_LABEL[h.gesture]}`, { color });
    }

    if (frame.face) {
      const lm = frame.face.landmarks;
      for (let i = 0; i < lm.length; i += 3) o.circle(lm[i], 1.2, 'rgba(255,255,255,0.7)');
    }

    this.updateSpace(frame);
    this.renderPanel(frame);
  }

  private updateSpace(frame: PerceptionFrame) {
    const space = frame.space;
    this.anchor.update(space);
    const depth = space.depth;
    this.depthCanvas.hidden = !depth;
    if (!depth || depth === this.lastDepth) return;
    this.lastDepth = depth;

    // Miniatura del mapa de profundidad.
    const c = this.depthCanvas;
    c.width = depth.width;
    c.height = depth.height;
    const g = c.getContext('2d')!;
    const img = g.createImageData(depth.width, depth.height);
    for (let i = 0; i < depth.data.length; i++) {
      const v = depth.data[i] * 255;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v * 0.6;
      img.data[i * 4 + 2] = 255 - v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);

    // Nube de puntos en la escena 3D (coordenadas de cámara → Three).
    const pts = depthToPoints(depth, space.intrinsics, 3);
    const positions = new Float32Array(pts.length * 3);
    const colors = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => {
      positions.set([p.x, -p.y, -p.z], i * 3);
      const t = Math.min(1, 1 / p.z);
      colors.set([t, 0.6 * t, 1 - t], i * 3);
    });
    if (!this.cloud) {
      this.cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.02, vertexColors: true }));
      this.ctx.scene.scene.add(this.cloud);
    }
    this.cloud.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.cloud.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.cloud.visible = this.showCloud;
  }

  private renderPanel(frame: PerceptionFrame) {
    const rows: string[] = [];
    const t = frame.timings;
    rows.push(`<div class="kv"><span>Inferencia</span><b>${['pose', 'hands', 'face'].map((k) => `${k}: ${t[k as keyof typeof t]?.toFixed(0) ?? '–'}ms`).join(' · ')}</b></div>`);

    if (frame.body) {
      const m = frame.body.metrics;
      rows.push(`<h4>Cuerpo</h4>`);
      rows.push(kv('Visibilidad', `${Math.round(m.visibility * 100)}%`));
      rows.push(kv('Brazos arriba', `${m.leftArmUp ? 'izq ' : ''}${m.rightArmUp ? 'der' : ''}` || '—'));
      rows.push(kv('Inclinación', bar((m.lean + 1) / 2)));
      rows.push(kv('Postura', frame.body.jumping ? 'saltando' : frame.body.crouching ? 'agachado' : 'de pie'));
      rows.push(kv('Codos', `${m.angles.leftElbow.toFixed(0)}° / ${m.angles.rightElbow.toFixed(0)}°`));
      rows.push(kv('Rodillas', `${m.angles.leftKnee.toFixed(0)}° / ${m.angles.rightKnee.toFixed(0)}°`));
    }

    if (frame.hands.length) {
      rows.push(`<h4>Manos</h4>`);
      for (const h of frame.hands) {
        rows.push(kv(h.handedness === 'Left' ? 'Izquierda' : 'Derecha', `${GESTURE_LABEL[h.gesture]} · MP: ${h.mpGesture?.name ?? '—'} · v=${h.speed.toFixed(1)}`));
      }
    }

    if (frame.face) {
      const e = frame.face.expressions;
      const hp = frame.face.headPose;
      rows.push(`<h4>Cara</h4>`);
      rows.push(kv('Sonrisa', bar(e.smile)));
      rows.push(kv('Boca abierta', bar(e.mouthOpen)));
      rows.push(kv('Cejas arriba', bar(e.browsUp)));
      rows.push(kv('Sorpresa', bar(e.surprise)));
      rows.push(kv('Beso', bar(e.kiss)));
      rows.push(kv('Guiño', e.wink ?? (e.blink ? 'parpadeo' : '—')));
      if (hp) rows.push(kv('Cabeza', `yaw ${hp.yaw.toFixed(0)}° · pitch ${hp.pitch.toFixed(0)}° · roll ${hp.roll.toFixed(0)}°`));
    }

    const s = frame.space;
    rows.push(`<h4>Espacio (${s.kind === 'floor' ? 'piso' : 'mesa'})</h4>`);
    rows.push(kv('Profundidad', s.depthStatus));
    rows.push(kv('Superficie', s.surfaceSource === 'depth' ? `detectada (${Math.round(s.surfaceConfidence * 100)}%)` : 'supuesta'));
    const n = s.surface.normal;
    rows.push(kv('Normal', `${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}`));
    if (s.up) rows.push(kv('Gravedad (celular)', `${s.up.x.toFixed(2)}, ${s.up.y.toFixed(2)}, ${s.up.z.toFixed(2)}`));
    this.panel.innerHTML = rows.join('');
  }

  unmount() {
    this.offEvents.forEach((off) => off());
    this.anchor.dispose();
    if (this.cloud) SceneManager.disposeObject(this.cloud);
  }
}

const kv = (k: string, v: string) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
const bar = (v: number) => `<i class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></i></i>`;

export const debugApp: AppDefinition = {
  id: 'debug',
  title: 'Visor de tracking',
  icon: '🔬',
  description: 'Muestra esqueleto, manos, cara, expresiones, gestos y la superficie detectada.',
  kind: 'utility',
  modes: ['fullbody', 'table'],
  create: () => new DebugApp(),
};
