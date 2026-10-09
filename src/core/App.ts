import QRCode from 'qrcode';
import { appsForMode, APPS } from '../apps/registry';
import type { AppContext, AppDefinition, AppInstance } from '../apps/types';
import { DeviceCameraSource, listCameras, type CameraSource } from '../camera/CameraSource';
import { PhoneWebRTCSource, phoneUrl, type PhoneStatus } from '../camera/PhoneWebRTCSource';
import { randomRoom } from '../camera/signaling';
import { HandCursor } from '../input/HandCursor';
import { HAND_CONNECTIONS } from '../perception/landmarks';
import { Perception } from '../perception/Perception';
import { DepthEstimator } from '../perception/space/DepthEstimator';
import type { PerceptionFrame } from '../perception/types';
import { Tracker } from '../tracking/Tracker';
import type { TrackingModule } from '../tracking/types';
import { MODES, type ModeId } from './modes';
import { Overlay2D } from './Overlay2D';
import { SceneManager } from './SceneManager';
import { calibrationFor, loadSettings, saveSettings, type CameraCalibration } from './settings';

const MODULE_LABEL: Record<TrackingModule, string> = { pose: 'cuerpo', hands: 'manos', face: 'cara' };

/** Shell de la aplicación: cámara, tracking, menú por modos y ciclo de vida de las apps. */
export class App {
  private settings = loadSettings();
  private video: HTMLVideoElement;
  private scene: SceneManager;
  private overlay: Overlay2D;
  private tracker: Tracker;
  private depth = new DepthEstimator();
  private perception: Perception;
  private cursor: HandCursor;
  private source: CameraSource | null = null;
  private calibration: CameraCalibration = calibrationFor(this.settings, '');
  private current: { def: AppDefinition; instance: AppInstance; ui: HTMLElement } | null = null;
  private frame: PerceptionFrame | null = null;
  private lastTime = 0;
  private fps = 0;
  private moduleStatus = new Map<TrackingModule, string>();
  private el: Record<'menu' | 'appLayer' | 'topbar' | 'panel' | 'status' | 'toasts' | 'title' | 'fps' | 'back', HTMLElement>;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="stage">
        <video class="camera" autoplay playsinline muted></video>
        <canvas class="three"></canvas>
        <canvas class="overlay"></canvas>
        <div class="app-layer"></div>
      </div>
      <header class="topbar">
        <button class="btn-ghost back" hidden>← Menú</button>
        <div class="title"></div>
        <div class="status"></div>
        <div class="fps"></div>
        <button class="btn-ghost" data-act="settings" title="Cámara y ajustes">⚙️</button>
      </header>
      <main class="menu"></main>
      <aside class="panel" hidden></aside>
      <div class="toasts"></div>`;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.video = q('video.camera');
    this.scene = new SceneManager(q('canvas.three'));
    this.overlay = new Overlay2D(q('canvas.overlay'), this.scene.viewport);
    this.el = {
      menu: q('.menu'),
      appLayer: q('.app-layer'),
      topbar: q('.topbar'),
      panel: q('.panel'),
      status: q('.status'),
      toasts: q('.toasts'),
      title: q('.title'),
      fps: q('.fps'),
      back: q('.back'),
    };
    this.el.back.onclick = () => this.goHome();
    q<HTMLButtonElement>('[data-act="settings"]').onclick = () => this.togglePanel();

    this.tracker = new Tracker({ poseModel: this.settings.poseModel, maxHands: 2, smoothing: this.settings.smoothing });
    this.tracker.onStatus = (m, status, detail) => {
      if (status === 'ready') this.moduleStatus.delete(m);
      else this.moduleStatus.set(m, status === 'loading' ? `Cargando ${MODULE_LABEL[m]}…` : `Error en ${MODULE_LABEL[m]}: ${detail}`);
      this.renderStatus();
    };
    this.perception = new Perception(this.spaceConfig(), this.depth);
    this.cursor = new HandCursor(this.scene.viewport);
    this.cursor.onBack = () => this.goHome();

    window.addEventListener('resize', () => this.resize());
    this.video.addEventListener('loadedmetadata', () => this.resize());
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.current) this.goHome();
      else this.togglePanel(false);
    });

    if (this.settings.depthEnabled) this.depth.start();
    this.goHome();
    this.resize();
    void this.startInitialCamera();
    requestAnimationFrame((t) => this.tick(t));
  }

  // ───────────────────────────── Cámara ─────────────────────────────

  private async startInitialCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.toast('Este navegador no permite usar la cámara (¿falta HTTPS?).', 6000);
      this.togglePanel(true);
      return;
    }
    try {
      await this.useSource(new DeviceCameraSource(this.settings.cameraId));
    } catch {
      // El dispositivo guardado puede no existir más: probamos el predeterminado.
      try {
        await this.useSource(new DeviceCameraSource(''));
      } catch (err) {
        this.toast(`No se pudo abrir la cámara: ${err instanceof Error ? err.message : err}`, 6000);
        this.togglePanel(true);
      }
    }
  }

  private async useSource(source: CameraSource) {
    this.source?.stop();
    this.source = source;
    const stream = await source.start();
    if (this.source !== source) return;
    this.attachStream(stream);
    source.onEnded = () => {
      if (this.source !== source) return;
      this.toast('Se perdió la cámara. Elegí otra en ⚙️', 5000);
      this.togglePanel(true);
    };
    this.calibration = calibrationFor(this.settings, source.key);
    this.applyCalibration();
    if (source instanceof DeviceCameraSource) {
      const id = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (id) {
        this.settings.cameraId = id;
        saveSettings(this.settings);
      }
    }
    if (!this.el.panel.hidden) void this.renderPanel();
  }

  private attachStream(stream: MediaStream) {
    this.video.srcObject = stream;
    void this.video.play().catch(() => {});
  }

  private applyCalibration() {
    this.video.classList.toggle('mirrored', this.calibration.mirror);
    this.scene.setFov(this.calibration.hfov);
    this.perception.setSpaceConfig(this.spaceConfig());
    this.resize();
  }

  private saveCalibration() {
    if (!this.source) return;
    this.settings.calibrations[this.source.key] = this.calibration;
    saveSettings(this.settings);
    this.applyCalibration();
  }

  private spaceConfig() {
    return { kind: MODES[this.settings.mode].surface, hfov: this.calibration.hfov, tableTilt: this.calibration.tableTilt };
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.scene.resize(w, h, this.video.videoWidth, this.video.videoHeight);
    this.overlay.resize(w, h);
  }

  // ───────────────────────────── Navegación ─────────────────────────────

  private setMode(mode: ModeId) {
    this.settings.mode = mode;
    saveSettings(this.settings);
    this.perception.setSpaceConfig(this.spaceConfig());
    // Precarga los modelos del modo mientras el usuario elige.
    MODES[mode].modules.forEach((m) => void this.tracker.ensureLoaded(m).catch(() => {}));
    this.renderMenu();
  }

  private goHome() {
    this.stopApp();
    this.tracker.setModules(['hands']);
    this.el.menu.hidden = false;
    this.el.back.hidden = true;
    this.el.title.textContent = 'AR Proyect';
    this.renderMenu();
  }

  private renderMenu() {
    const mode = MODES[this.settings.mode];
    const apps = appsForMode(mode.id);
    this.el.menu.innerHTML = `
      <section class="modes">
        ${Object.values(MODES)
          .map(
            (m) => `<button class="mode-card ${m.id === mode.id ? 'active' : ''}" data-mode="${m.id}">
              <span class="icon">${m.icon}</span><b>${m.title}</b><small>${m.description}</small></button>`,
          )
          .join('')}
      </section>
      <p class="hint">📷 ${mode.setupHint}</p>
      <section class="apps">
        ${apps
          .map(
            (a) => `<button class="app-card ${a.kind}" data-app="${a.id}">
              <span class="icon">${a.icon}</span><b>${a.title}</b><small>${a.description}</small>
              <em>${a.kind === 'game' ? 'Minijuego' : 'Utilidad'}</em></button>`,
          )
          .join('')}
      </section>
      <p class="hint small">Controlá todo con la mano: apuntá con el índice y <b>pellizcá</b> (o quedate quieto) para elegir · 🖐 palma abierta quieta = volver · Esc también vuelve.</p>`;
    this.el.menu.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode as ModeId)));
    this.el.menu.querySelectorAll<HTMLButtonElement>('[data-app]').forEach((b) => (b.onclick = () => this.launch(b.dataset.app!)));
  }

  private launch(id: string) {
    const def = APPS.find((a) => a.id === id);
    if (!def) return;
    this.stopApp();
    const mode = MODES[this.settings.mode];
    this.tracker.setModules(def.modules ?? mode.modules);
    this.el.menu.hidden = true;
    this.el.back.hidden = false;
    this.el.title.textContent = `${def.icon} ${def.title}`;
    this.togglePanel(false);

    const ui = document.createElement('div');
    ui.className = `app-ui app-${def.id}`;
    this.el.appLayer.appendChild(ui);
    const settings = this.settings;
    const ctx: AppContext = {
      scene: this.scene,
      overlay: this.overlay,
      ui,
      events: this.perception.events,
      cursor: this.cursor,
      mode,
      setModules: (mods) => this.tracker.setModules(mods),
      setDepth: (on) => this.setDepth(on),
      get depthEnabled() {
        return settings.depthEnabled;
      },
      exit: () => this.goHome(),
      toast: (m, ms) => this.toast(m, ms),
    };
    const instance = def.create();
    this.current = { def, instance, ui };
    instance.mount(ctx);
  }

  private stopApp() {
    if (!this.current) return;
    this.current.instance.unmount();
    this.current.ui.remove();
    this.current = null;
    this.cursor.setVisible(true);
  }

  private setDepth(on: boolean) {
    this.settings.depthEnabled = on;
    saveSettings(this.settings);
    if (on) {
      this.depth.start();
      this.toast('Cargando modelo de profundidad (la primera vez descarga ~25–100 MB)…', 4000);
    } else this.depth.stop();
    if (!this.el.panel.hidden) void this.renderPanel();
  }

  // ───────────────────────────── Panel de cámara/ajustes ─────────────────────────────

  private togglePanel(force?: boolean) {
    const show = force ?? this.el.panel.hidden;
    this.el.panel.hidden = !show;
    if (show) void this.renderPanel();
  }

  private async renderPanel() {
    const cams = await listCameras();
    const c = this.calibration;
    const isPhone = this.source instanceof PhoneWebRTCSource;
    const currentId = this.source instanceof DeviceCameraSource ? this.settings.cameraId : '';
    this.el.panel.innerHTML = `
      <h3>📷 Cámara</h3>
      <label>Dispositivo
        <select data-k="camera">
          ${cams.map((d) => `<option value="${d.deviceId}" ${d.deviceId === currentId ? 'selected' : ''}>${d.label}</option>`).join('')}
          ${isPhone ? '<option selected>Celular (WebRTC)</option>' : ''}
        </select>
      </label>
      <p class="small">¿Tu celular como cámara? Opción A: una app de cámara virtual (DroidCam, Iriun, Camo, Continuity) y elegila arriba. Opción B, sin instalar nada:</p>
      <button data-k="phone">📱 Conectar celular por QR</button>
      <div class="qr"></div>
      <h3>🎯 Calibración <small>(${this.source?.label ?? '—'})</small></h3>
      <label class="row"><input type="checkbox" data-k="mirror" ${c.mirror ? 'checked' : ''}/> Espejar imagen</label>
      <label>Campo de visión: <b data-v="hfov">${c.hfov}°</b><input type="range" min="40" max="110" value="${c.hfov}" data-k="hfov"/></label>
      <label>Inclinación de la cámara (mesa, sin profundidad): <b data-v="tableTilt">${c.tableTilt}°</b><input type="range" min="10" max="85" value="${c.tableTilt}" data-k="tableTilt"/></label>
      <h3>🧠 Percepción</h3>
      <label class="row"><input type="checkbox" data-k="depth" ${this.settings.depthEnabled ? 'checked' : ''}/> Espacio 3D (profundidad monocular) <small>${this.depth.status !== 'idle' ? `· ${this.depth.status}${this.depth.device ? ` (${this.depth.device})` : ''}` : ''}</small></label>
      <label class="row"><input type="checkbox" data-k="smoothing" ${this.settings.smoothing ? 'checked' : ''}/> Suavizado de landmarks</label>
      <label>Modelo de cuerpo
        <select data-k="poseModel">
          <option value="lite" ${this.settings.poseModel === 'lite' ? 'selected' : ''}>Lite (más rápido)</option>
          <option value="full" ${this.settings.poseModel === 'full' ? 'selected' : ''}>Full (más preciso)</option>
        </select>
      </label>
      <button data-k="close" class="btn-primary">Listo</button>`;

    const p = this.el.panel;
    const get = <T extends HTMLElement>(k: string) => p.querySelector(`[data-k="${k}"]`) as T;
    get<HTMLSelectElement>('camera').onchange = (e) => {
      const id = (e.target as HTMLSelectElement).value;
      const label = cams.find((d) => d.deviceId === id)?.label;
      void this.useSource(new DeviceCameraSource(id, label)).catch((err) => this.toast(`Error: ${err.message ?? err}`));
    };
    get<HTMLButtonElement>('phone').onclick = () => void this.connectPhone(p.querySelector('.qr')!);
    get<HTMLInputElement>('mirror').onchange = (e) => {
      this.calibration.mirror = (e.target as HTMLInputElement).checked;
      this.saveCalibration();
    };
    for (const k of ['hfov', 'tableTilt'] as const) {
      get<HTMLInputElement>(k).oninput = (e) => {
        this.calibration[k] = Number((e.target as HTMLInputElement).value);
        p.querySelector(`[data-v="${k}"]`)!.textContent = `${this.calibration[k]}°`;
        this.saveCalibration();
      };
    }
    get<HTMLInputElement>('depth').onchange = (e) => this.setDepth((e.target as HTMLInputElement).checked);
    get<HTMLInputElement>('smoothing').onchange = (e) => {
      this.settings.smoothing = (e.target as HTMLInputElement).checked;
      saveSettings(this.settings);
      this.toast('Se aplica al recargar la página.');
    };
    get<HTMLSelectElement>('poseModel').onchange = (e) => {
      this.settings.poseModel = (e.target as HTMLSelectElement).value as 'lite' | 'full';
      saveSettings(this.settings);
      this.toast('Se aplica al recargar la página.');
    };
    get<HTMLButtonElement>('close').onclick = () => this.togglePanel(false);
  }

  private async connectPhone(qrBox: HTMLElement) {
    const room = randomRoom();
    const url = await phoneUrl(room);
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
    qrBox.innerHTML = `<img src="${dataUrl}" alt="QR"/><p class="small">Escaneá con el celular (misma red Wi-Fi). Si avisa de certificado, aceptalo.<br><code>${url}</code></p><p class="phone-status small">Esperando al celular…</p>`;
    const statusEl = qrBox.querySelector('.phone-status')!;
    const labels: Record<PhoneStatus, string> = {
      waiting: 'Esperando al celular…',
      connecting: 'Conectando…',
      connected: '✅ Conectado',
      disconnected: 'Celular desconectado',
      error: 'Error de señalización',
    };
    const source = new PhoneWebRTCSource(room);
    source.onStatus = (s) => (statusEl.textContent = labels[s]);
    source.onUp = (up) => (this.perception.up = up);
    source.onStream = (stream) => this.attachStream(stream);
    try {
      await this.useSource(source);
      this.toast('📱 Celular conectado');
    } catch (err) {
      this.toast(`No se pudo conectar el celular: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ───────────────────────────── Loop ─────────────────────────────

  private tick(nowMs: number) {
    const dt = this.lastTime ? Math.min(0.1, (nowMs - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = nowMs;
    this.fps = this.fps * 0.95 + (1 / dt) * 0.05;

    this.overlay.clear();
    try {
      const raw = this.tracker.process(this.video, this.calibration.mirror);
      if (raw) this.frame = this.perception.update(raw);
      if (this.depth.running) this.depth.update(this.video, this.calibration.mirror);
      this.cursor.backEnabled = !!this.current && this.current.instance.allowPalmBack !== false;
      this.cursor.update(this.frame?.hands ?? [], nowMs);

      if (this.current) this.current.instance.update(this.frame, dt);
      else this.drawMenuHands();
    } catch (err) {
      console.error(err);
    }
    this.scene.render();
    this.el.fps.textContent = `${Math.round(this.fps)} fps`;
    requestAnimationFrame((t) => this.tick(t));
  }

  /** En el menú se dibujan las manos para dar feedback de que el tracking anda. */
  private drawMenuHands() {
    for (const h of this.frame?.hands ?? []) this.overlay.skeleton(h.landmarks, HAND_CONNECTIONS, 'rgba(255,255,255,0.5)', 2);
  }

  private renderStatus() {
    this.el.status.innerHTML = [...this.moduleStatus.values()].map((s) => `<span class="chip">${s}</span>`).join('');
  }

  toast(message: string, ms = 2500) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    this.el.toasts.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
}
