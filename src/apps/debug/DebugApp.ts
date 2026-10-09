import * as THREE from 'three';
import { SceneManager } from '../../core/SceneManager';
import { HAND_CONNECTIONS, POSE_CONNECTIONS } from '../../perception/landmarks';
import { depthToPoints } from '../../perception/space/surface';
import { icon } from '../../ui/icons';
import type { PerceptionFrame } from '../../perception/types';
import { makeSurfaceGrid, SurfaceAnchor } from '../shared/SurfaceAnchor';
import type { AppContext, AppDefinition, AppInstance } from '../types';

const GESTURE_LABEL: Record<string, string> = {
  none: '—',
  pinch: 'pinch',
  fist: 'puño',
  open_palm: 'palma',
  point: 'apuntar',
  victory: 'victoria',
  thumbs_up: 'pulgar arriba',
  thumbs_down: 'pulgar abajo',
  rock: 'rock',
};
const SOURCE_LABEL = { full: '', crop: ' (lejos)', pose: ' (aprox.)' } as const;

/** Visor de todo lo que detecta el sistema: esqueleto, manos, cara, expresiones y espacio. */
class DebugApp implements AppInstance {
  private ctx!: AppContext;
  private panel!: HTMLDivElement;
  private depthCanvas!: HTMLCanvasElement;
  private anchor!: SurfaceAnchor;
  private cloud: THREE.Points | null = null;
  private showCloud = false;
  private occlusion = false;
  private silhouettes = true;
  private maskCanvas = document.createElement('canvas');
  private lastMaskT = -1;
  private depthStats = '';
  private lastDepth: unknown = null;
  private logLines: string[] = [];
  private offEvents: (() => void)[] = [];

  mount(ctx: AppContext) {
    this.ctx = ctx;
    ctx.ui.innerHTML = `
      <div class="debug-panel">
        <div class="debug-actions">
          <button data-act="depth">${icon('layers', 16)} Profundidad: <b>${ctx.depthEnabled ? 'ON' : 'OFF'}</b></button>
          <button data-act="cloud">${icon('sparkles', 16)} Nube</button>
          <button data-act="occ">${icon('hand', 16)} Oclusión</button>
          <button data-act="sil" class="active">${icon('body', 16)} Siluetas</button>
        </div>
        <div class="debug-calib">
          <span>${icon('recalibrate', 16)} Distancia real</span>
          <input type="number" step="0.1" min="0.5" max="8" value="2.5" data-k="dist"/> m
          <button data-act="dist">Calibrar</button>
        </div>
        <small class="debug-calib-msg"></small>
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
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="occ"]')!.onclick = (e) => {
      this.occlusion = !this.occlusion;
      ctx.setOcclusion({ hands: this.occlusion, body: this.occlusion });
      (e.currentTarget as HTMLElement).classList.toggle('active', this.occlusion);
    };
    ctx.setSegmentation(true);
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="sil"]')!.onclick = (e) => {
      this.silhouettes = !this.silhouettes;
      ctx.setSegmentation(this.silhouettes);
      (e.currentTarget as HTMLElement).classList.toggle('active', this.silhouettes);
    };
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="dist"]')!.onclick = () => {
      const m = Number(ctx.ui.querySelector<HTMLInputElement>('[data-k="dist"]')!.value);
      ctx.ui.querySelector('.debug-calib-msg')!.textContent = ctx.calibrateDistance(m);
    };
    ctx.ui.querySelector<HTMLButtonElement>('[data-act="cloud"]')!.onclick = () => {
      this.showCloud = !this.showCloud;
      if (this.cloud) this.cloud.visible = this.showCloud;
    };

    const size = ctx.mode.surface === 'floor' ? 2 : 0.4;
    this.anchor = new SurfaceAnchor(ctx.scene, size);
    this.anchor.group.add(makeSurfaceGrid(size, 10));
    // Ejes de la superficie (X rojo, Y verde = normal, Z azul = hacia la cámara).
    const axes = new THREE.AxesHelper(size * 0.25);
    axes.position.y = 0.002;
    this.anchor.group.add(axes);

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
    if (frame?.personMask && this.silhouettes) this.drawSilhouettes(frame);
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

    // Otras personas (no son el jugador).
    for (const other of frame.others) {
      o.skeleton(other, POSE_CONNECTIONS, 'rgba(200,200,220,0.55)', 3, (i) => other[i].visibility ?? 1);
      const nose = other[0];
      if ((nose.visibility ?? 0) > 0.5) o.text({ x: nose.x, y: nose.y - 0.06 }, 'otra persona', { size: 13, color: '#ccd' });
    }

    for (const h of frame.hands) {
      const color = h.handedness === 'Left' ? '#ffb347' : '#7dff8a';
      o.skeleton(h.landmarks, HAND_CONNECTIONS, color, 3);
      for (const p of h.landmarks) o.circle(p, 3, '#fff');
      o.text({ x: h.landmarks[0].x, y: h.landmarks[0].y + 0.05 }, `${h.handedness === 'Left' ? 'Izq' : 'Der'}${SOURCE_LABEL[h.source]} · ${GESTURE_LABEL[h.gesture]}${h.palm3 ? ` · ${h.palm3.z.toFixed(2)} m` : ''}`, { color });
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

    // Miniatura del mapa de profundidad: en metros si hay escala (el cuerpo da la escala),
    // si no, disparidad relativa con normalización robusta por percentiles.
    const c = this.depthCanvas;
    c.width = depth.width;
    c.height = depth.height;
    const g = c.getContext('2d')!;
    const img = g.createImageData(depth.width, depth.height);
    const scale = space.depthScale;
    const sorted = Float32Array.from(depth.data).sort();
    const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const lo = pct(0.02);
    const hi = pct(0.98);
    for (let i = 0; i < depth.data.length; i++) {
      const d = depth.data[i];
      // t: 0 = lejos, 1 = cerca.
      let t: number;
      if (scale) {
        const z = Math.min(12, Math.max(0.3, scale / Math.max(d, 1e-3)));
        t = 1 - Math.log(z / 0.3) / Math.log(12 / 0.3);
      } else t = (d - lo) / (hi - lo || 1);
      const [r, gg, b] = turbo(Math.min(1, Math.max(0, t)));
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = gg;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.depthStats = scale
      ? `cerca ${(scale / Math.max(pct(0.98), 1e-3)).toFixed(1)} m · fondo ${(scale / Math.max(pct(0.05), 1e-3)).toFixed(1)} m`
      : 'relativa (falta el cuerpo para dar metros)';

    // Nube de puntos en la escena 3D (coordenadas de cámara → Three).
    const k = space.intrinsics;
    const kd = { ...k, fx: (k.fx * depth.width) / k.width, fy: (k.fy * depth.height) / k.height, cx: depth.width / 2, cy: depth.height / 2, width: depth.width, height: depth.height };
    const pts = depthToPoints(depth, kd, 3).map((p) => (scale ? { x: p.x * scale, y: p.y * scale, z: p.z * scale } : p));
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
    const perf = this.ctx.perf();
    rows.push(`<div class="kv"><span>Cuadro</span><b>${Object.entries(perf).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' · ')} ms</b></div>`);

    if (frame.body) {
      const m = frame.body.metrics;
      rows.push(`<h4>Cuerpo</h4>`);
      const cam = frame.body.camera;
      if (cam) rows.push(kv('Distancia', `${((cam[23].z + cam[24].z) / 2).toFixed(2)} m`));
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
        rows.push(kv(`${h.handedness === 'Left' ? 'Izquierda' : 'Derecha'}${SOURCE_LABEL[h.source]}`, `${GESTURE_LABEL[h.gesture]} · ${h.palm3 ? `${h.palm3.z.toFixed(2)} m` : '—'}`));
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
    const SRC = { marker: 'marcador', body: 'cuerpo', hand: 'mano apoyada', depth: 'profundidad IA', assumed: 'supuesta' } as const;
    rows.push(kv('Fuente', SRC[s.surfaceSource]));
    rows.push(kv('Profundidad IA', s.depthStatus));
    if (s.depth) rows.push(kv('Mapa', this.depthStats));
    rows.push(kv('Personas', String((frame.body ? 1 : 0) + frame.others.length)));
    rows.push(kv('Cámara sobre superficie', `${s.surface.d.toFixed(2)} m`));
    const n = s.surface.normal;
    rows.push(kv('Normal', `${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}`));
    if (s.up) rows.push(kv('Gravedad (celular)', `${s.up.x.toFixed(2)}, ${s.up.y.toFixed(2)}, ${s.up.z.toFixed(2)}`));
    this.panel.innerHTML = rows.join('');
  }

  /** Siluetas de personas (máscara de segmentación) teñidas sobre el video. */
  private drawSilhouettes(frame: PerceptionFrame) {
    const mask = frame.personMask!;
    const c = this.maskCanvas;
    if (mask.t !== this.lastMaskT) {
      this.lastMaskT = mask.t;
      c.width = mask.width;
      c.height = mask.height;
      const g = c.getContext('2d')!;
      const img = g.createImageData(mask.width, mask.height);
      for (let i = 0; i < mask.data.length; i++) {
        const a = mask.data[i];
        img.data[i * 4] = 60;
        img.data[i * 4 + 1] = 200;
        img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = a > 0.5 ? 90 : 0;
      }
      g.putImageData(img, 0, 0);
    }
    const vp = this.ctx.scene.viewport;
    this.ctx.overlay.ctx.drawImage(c, vp.offsetX, vp.offsetY, vp.displayWidth, vp.displayHeight);
  }

  unmount() {
    this.offEvents.forEach((off) => off());
    this.anchor.dispose();
    if (this.cloud) SceneManager.disposeObject(this.cloud);
  }
}

/** Mapa de color "turbo" (aproximación polinómica de Mikhailov, Google): 0 azul oscuro → 1 rojo. */
function turbo(t: number): [number, number, number] {
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  const c = (x: number) => Math.max(0, Math.min(255, x * 255));
  return [c(r), c(g), c(b)];
}

const kv = (k: string, v: string) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
const bar = (v: number) => `<i class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></i></i>`;

export const debugApp: AppDefinition = {
  id: 'debug',
  title: 'Visor de tracking',
  icon: 'microscope',
  accent: '#f59e0b',
  usesSurface: true,
  description: 'Muestra esqueleto, manos, cara, expresiones, gestos y la superficie detectada.',
  kind: 'utility',
  modes: ['fullbody', 'table'],
  create: () => new DebugApp(),
};
