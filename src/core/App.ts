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
import { MARKER_IDS, MarkerTracker } from '../perception/space/marker';
import { intrinsicsFromFov } from '../perception/space/surface';
import type { PerceptionFrame, SurfaceSource } from '../perception/types';
import { Tracker } from '../tracking/Tracker';
import type { TrackingModule } from '../tracking/types';
import { icon } from '../ui/icons';
import { MODES, type ModeId } from './modes';
import { Occluders } from './occlusion';
import { Overlay2D } from './Overlay2D';
import { SceneManager } from './SceneManager';
import { calibrationFor, loadSettings, saveSettings, type CameraCalibration } from './settings';

const MODULE_LABEL: Record<TrackingModule, string> = { pose: 'cuerpo', hands: 'manos', face: 'cara' };
const SURFACE_LABEL: Record<SurfaceSource, string> = {
  marker: 'marcador',
  body: 'por tu cuerpo',
  hand: 'por tu mano',
  depth: 'estimada',
  assumed: 'sin detectar',
};

/** Shell de la aplicación: cámara, tracking, menú por modos y ciclo de vida de las apps. */
export class App {
  private settings = loadSettings();
  private video: HTMLVideoElement;
  private scene: SceneManager;
  private overlay: Overlay2D;
  private tracker: Tracker;
  private depth = new DepthEstimator();
  private markers = new MarkerTracker();
  private perception: Perception;
  private occluders: Occluders;
  private cursor: HandCursor;
  private source: CameraSource | null = null;
  private calibration: CameraCalibration = calibrationFor(this.settings, '');
  private current: { def: AppDefinition; instance: AppInstance; ui: HTMLElement } | null = null;
  private frame: PerceptionFrame | null = null;
  private lastTime = 0;
  private fps = 0;
  private guideDismissed = false;
  private moduleStatus = new Map<TrackingModule, string>();
  private el: Record<'menu' | 'appLayer' | 'panel' | 'status' | 'surface' | 'toasts' | 'title' | 'fps' | 'back' | 'guide' | 'recal', HTMLElement>;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="stage">
        <video class="camera" autoplay playsinline muted></video>
        <canvas class="three"></canvas>
        <canvas class="overlay"></canvas>
        <div class="app-layer"></div>
      </div>
      <header class="topbar">
        <button class="icon-btn back" hidden title="Volver al menú">${icon('back')}<span>Menú</span></button>
        <div class="title"></div>
        <div class="status"></div>
        <div class="surface-chip" hidden></div>
        <div class="fps"></div>
        <button class="icon-btn recal" title="Volver a detectar la superficie" hidden>${icon('recalibrate')}</button>
        <button class="icon-btn" data-act="settings" title="Cámara y ajustes">${icon('settings')}</button>
      </header>
      <main class="menu"></main>
      <aside class="panel" hidden></aside>
      <div class="guide" hidden></div>
      <div class="toasts"></div>`;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.video = q('video.camera');
    this.scene = new SceneManager(q('canvas.three'));
    this.scene.setVideo(this.video);
    this.overlay = new Overlay2D(q('canvas.overlay'), this.scene.viewport);
    this.occluders = new Occluders(this.scene);
    this.occluders.setDebug(this.settings.debugOcclusion);
    this.el = {
      menu: q('.menu'),
      appLayer: q('.app-layer'),
      panel: q('.panel'),
      status: q('.status'),
      surface: q('.surface-chip'),
      toasts: q('.toasts'),
      title: q('.title'),
      fps: q('.fps'),
      back: q('.back'),
      guide: q('.guide'),
      recal: q('.recal'),
    };
    this.el.back.onclick = () => this.goHome();
    this.el.recal.onclick = () => this.recalibrate();
    q<HTMLButtonElement>('[data-act="settings"]').onclick = () => this.togglePanel();

    this.tracker = new Tracker({ poseModel: this.settings.poseModel, maxHands: 2, smoothing: this.settings.smoothing });
    this.tracker.onStatus = (m, status, detail) => {
      if (status === 'ready') this.moduleStatus.delete(m);
      else this.moduleStatus.set(m, status === 'loading' ? `Cargando ${MODULE_LABEL[m]}…` : `Error en ${MODULE_LABEL[m]}: ${detail}`);
      this.renderStatus();
    };
    this.perception = new Perception(this.spaceConfig(), this.depth);
    this.perception.events.on('surface', (e) => {
      if (e.source === 'marker') this.toast('Superficie fijada con el marcador');
      else if (e.source === 'hand') this.toast('Mesa calibrada con tu mano');
    });
    this.cursor = new HandCursor(this.scene.viewport);
    this.cursor.onBack = () => this.goHome();

    window.addEventListener('resize', () => this.resize());
    this.video.addEventListener('loadedmetadata', () => this.resize());
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.el.panel.hidden) this.togglePanel(false);
      else if (this.current) this.goHome();
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
      this.toast('Se perdió la cámara. Elegí otra en ajustes.', 5000);
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
    this.scene.setMirrored(this.calibration.mirror);
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

  private recalibrate() {
    this.perception.recalibrate();
    this.guideDismissed = false;
    this.toast('Buscando la superficie de nuevo…');
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.scene.resize(w, h, this.video.videoWidth, this.video.videoHeight);
    this.overlay.resize(w, h);
  }

  // ───────────────────────────── Navegación ─────────────────────────────

  private setMode(mode: ModeId) {
    if (mode === this.settings.mode) return;
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
    this.occluders.options = { hands: false, body: false };
    this.el.menu.hidden = false;
    this.el.back.hidden = true;
    this.el.recal.hidden = true;
    this.el.title.innerHTML = `<span class="brand">${icon('scan', 22)}<b>AR</b> Proyect</span>`;
    this.renderMenu();
  }

  private renderMenu() {
    const mode = MODES[this.settings.mode];
    const apps = appsForMode(mode.id);
    this.el.menu.innerHTML = `
      <section class="home">
        <div class="mode-switch" role="tablist">
          ${Object.values(MODES)
            .map(
              (m) => `<button class="mode-card ${m.id === mode.id ? 'active' : ''}" data-mode="${m.id}" role="tab" aria-selected="${m.id === mode.id}">
                <span class="mode-icon">${icon(m.icon, 34, 1.8)}</span>
                <span class="mode-text"><b>${m.title}</b><small>${m.description}</small></span>
                ${m.id === mode.id ? `<span class="mode-check">${icon('check', 18, 3)}</span>` : ''}
              </button>`,
            )
            .join('')}
        </div>
        <p class="setup-hint">${icon('camera', 18)}<span>${mode.setupHint}</span></p>
        <div class="app-grid">
          ${apps
            .map(
              (a) => `<button class="app-card" data-app="${a.id}" style="--accent:${a.accent}">
                <span class="app-icon">${icon(a.icon, 30, 1.8)}</span>
                <span class="app-text"><b>${a.title}</b><small>${a.description}</small></span>
                <span class="app-tag">${a.kind === 'game' ? 'Juego' : 'Utilidad'}</span>
              </button>`,
            )
            .join('')}
        </div>
        <footer class="how-to">
          <span>${icon('hand', 18)} Apuntá con el índice</span>
          <span>${icon('sparkles', 18)} Pellizcá y <b>mantené</b> para elegir</span>
          <span>${icon('back', 18)} Palma abierta en alto 2 s = volver</span>
          <a href="marcador.html" target="_blank" rel="noopener">${icon('printer', 18)} Imprimir marcadores</a>
        </footer>
      </section>`;
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
    this.el.recal.hidden = !def.usesSurface;
    this.el.title.innerHTML = `<span class="app-title" style="--accent:${def.accent}">${icon(def.icon, 20)}${def.title}</span>`;
    this.togglePanel(false);
    this.guideDismissed = false;

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
      setOcclusion: (opts) => (this.occluders.options = { ...this.occluders.options, ...opts }),
      recalibrate: () => this.recalibrate(),
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
    this.occluders.options = { hands: false, body: false };
    this.el.guide.hidden = true;
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

  // ───────────────────────────── Guía de superficie ─────────────────────────────

  private renderSurfaceStatus() {
    const s = this.frame?.space;
    const show = !!this.current?.def.usesSurface && !!s;
    this.el.surface.hidden = !show;
    if (!show || !s) {
      this.el.guide.hidden = true;
      return;
    }
    const good = s.surfaceSource === 'marker' || s.surfaceSource === 'hand' || s.surfaceSource === 'body';
    const label = `${s.kind === 'floor' ? 'Piso' : 'Mesa'}: ${SURFACE_LABEL[s.surfaceSource]}`;
    const html = `${icon('scan', 16)}<span>${label}</span>`;
    if (this.el.surface.innerHTML !== html) this.el.surface.innerHTML = html;
    this.el.surface.dataset.quality = good ? 'good' : s.surfaceSource === 'depth' ? 'ok' : 'bad';

    const needGuide = !good && !this.guideDismissed;
    this.el.guide.hidden = !needGuide;
    if (!needGuide) return;
    const table = s.kind === 'table';
    const progress = Math.round(s.calibrationProgress * 100);
    const key = `${s.kind}:${this.settings.depthEnabled}`;
    if (this.el.guide.dataset.key !== key) {
      this.el.guide.dataset.key = key;
      this.el.guide.innerHTML = `
        <div class="guide-card">
          <h3>${icon('scan', 20)} ${table ? 'Ubiquemos la mesa' : 'Ubiquemos el piso'}</h3>
          <ol>
            <li>${icon('printer', 18)}<span><b>Marcador impreso</b> (lo más preciso): apoyalo ${table ? 'sobre la mesa' : 'en el piso, frente a vos'}. <a href="marcador.html" target="_blank" rel="noopener">Imprimir</a></span></li>
            ${
              table
                ? `<li>${icon('hand', 18)}<span><b>Mano abierta</b> apoyada plana sobre la mesa, quieta 1 segundo.</span><i class="guide-progress"><i style="width:${progress}%"></i></i></li>`
                : `<li>${icon('body', 18)}<span><b>Tu cuerpo</b>: alejate hasta que se vean tus pies.</span></li>`
            }
            ${this.settings.depthEnabled ? '' : `<li>${icon('layers', 18)}<span><b>Profundidad</b> estimada por IA (aproximada). <button class="link-btn" data-act="depth">Activar</button></span></li>`}
          </ol>
          <button class="btn-secondary" data-act="dismiss">Seguir así</button>
        </div>`;
      this.el.guide.querySelector<HTMLButtonElement>('[data-act="dismiss"]')!.onclick = () => {
        this.guideDismissed = true;
        this.el.guide.hidden = true;
      };
      const depthBtn = this.el.guide.querySelector<HTMLButtonElement>('[data-act="depth"]');
      if (depthBtn) depthBtn.onclick = () => this.setDepth(true);
    } else if (table) {
      const bar = this.el.guide.querySelector<HTMLElement>('.guide-progress > i');
      if (bar) bar.style.width = `${progress}%`;
    }
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
    const ms = this.settings.markerSizes;
    this.el.panel.innerHTML = `
      <div class="panel-head"><h2>${icon('settings', 20)} Ajustes</h2><button class="icon-btn" data-k="close" title="Cerrar">${icon('close')}</button></div>
      <section>
        <h3>${icon('camera', 18)} Cámara</h3>
        <label>Dispositivo
          <select data-k="camera">
            ${cams.map((d) => `<option value="${d.deviceId}" ${d.deviceId === currentId ? 'selected' : ''}>${d.label}</option>`).join('')}
            ${isPhone ? '<option selected>Celular (WebRTC)</option>' : ''}
          </select>
        </label>
        <p class="small">¿El celular como cámara? Con una app de cámara virtual (DroidCam, Iriun, Camo, Continuity) aparece arriba. Sin instalar nada:</p>
        <button class="btn-secondary" data-k="phone">${icon('phone', 18)} Conectar celular por QR</button>
        <div class="qr"></div>
      </section>
      <section>
        <h3>${icon('recalibrate', 18)} Calibración <small>${this.source?.label ?? ''}</small></h3>
        <label class="row"><input type="checkbox" data-k="mirror" ${c.mirror ? 'checked' : ''}/> Espejar imagen</label>
        <label>Campo de visión: <b data-v="hfov">${c.hfov}°</b><input type="range" min="40" max="110" value="${c.hfov}" data-k="hfov"/></label>
        <label>Inclinación de la cámara (mesa sin calibrar): <b data-v="tableTilt">${c.tableTilt}°</b><input type="range" min="10" max="85" value="${c.tableTilt}" data-k="tableTilt"/></label>
      </section>
      <section>
        <h3>${icon('printer', 18)} Marcadores</h3>
        <p class="small">Medí el cuadrado negro impreso y ajustá si no coincide. <a href="marcador.html" target="_blank" rel="noopener">Abrir página para imprimir</a></p>
        <label>Mesa (cm)<input type="number" step="0.1" min="2" max="50" value="${(ms.table * 100).toFixed(1)}" data-k="mTable"/></label>
        <label>Piso (cm)<input type="number" step="0.1" min="5" max="60" value="${(ms.floor * 100).toFixed(1)}" data-k="mFloor"/></label>
      </section>
      <section>
        <h3>${icon('activity', 18)} Percepción</h3>
        <label class="row"><input type="checkbox" data-k="depth" ${this.settings.depthEnabled ? 'checked' : ''}/> Profundidad por IA <small>${this.depth.status !== 'idle' ? `· ${this.depth.status}${this.depth.device ? ` (${this.depth.device})` : ''}` : ''}</small></label>
        <label class="row"><input type="checkbox" data-k="smoothing" ${this.settings.smoothing ? 'checked' : ''}/> Suavizado de movimientos</label>
        <label class="row"><input type="checkbox" data-k="occ" ${this.settings.debugOcclusion ? 'checked' : ''}/> Ver oclusores (depuración)</label>
        <label>Modelo de cuerpo
          <select data-k="poseModel">
            <option value="lite" ${this.settings.poseModel === 'lite' ? 'selected' : ''}>Lite (más rápido)</option>
            <option value="full" ${this.settings.poseModel === 'full' ? 'selected' : ''}>Full (equilibrado)</option>
            <option value="heavy" ${this.settings.poseModel === 'heavy' ? 'selected' : ''}>Heavy (mejor de lejos)</option>
          </select>
        </label>
      </section>`;

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
    for (const [k, key] of [['mTable', 'table'], ['mFloor', 'floor']] as const) {
      get<HTMLInputElement>(k).onchange = (e) => {
        const cm = Number((e.target as HTMLInputElement).value);
        if (cm > 0) {
          this.settings.markerSizes[key] = cm / 100;
          saveSettings(this.settings);
          this.perception.recalibrate();
        }
      };
    }
    get<HTMLInputElement>('depth').onchange = (e) => this.setDepth((e.target as HTMLInputElement).checked);
    get<HTMLInputElement>('smoothing').onchange = (e) => {
      this.settings.smoothing = (e.target as HTMLInputElement).checked;
      saveSettings(this.settings);
      this.toast('Se aplica al recargar la página.');
    };
    get<HTMLInputElement>('occ').onchange = (e) => {
      this.settings.debugOcclusion = (e.target as HTMLInputElement).checked;
      saveSettings(this.settings);
      this.occluders.setDebug(this.settings.debugOcclusion);
    };
    get<HTMLSelectElement>('poseModel').onchange = (e) => {
      this.settings.poseModel = (e.target as HTMLSelectElement).value as 'lite' | 'full' | 'heavy';
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
      connected: 'Conectado',
      disconnected: 'Celular desconectado',
      error: 'Error de señalización',
    };
    const source = new PhoneWebRTCSource(room);
    source.onStatus = (s) => (statusEl.textContent = labels[s]);
    source.onUp = (up) => (this.perception.up = up);
    source.onStream = (stream) => this.attachStream(stream);
    try {
      await this.useSource(source);
      this.toast('Celular conectado');
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
      // Marcadores: sólo con una app que use la superficie (es análisis por CPU).
      if (this.current?.def.usesSurface && this.video.videoWidth) {
        const k = intrinsicsFromFov(this.video.videoWidth, this.video.videoHeight, this.calibration.hfov);
        const sizes = { [MARKER_IDS.table]: this.settings.markerSizes.table, [MARKER_IDS.floor]: this.settings.markerSizes.floor };
        this.perception.setMarkers(this.markers.update(this.video, this.calibration.mirror, k, sizes));
      }
      if (raw) this.frame = this.perception.update(raw);
      if (this.depth.running) this.depth.update(this.video, this.calibration.mirror);
      this.scene.estimateLighting(this.video);
      this.occluders.update(this.frame);
      this.cursor.backEnabled = !!this.current && this.current.instance.allowPalmBack !== false;
      this.cursor.update(this.frame?.hands ?? [], nowMs);

      if (this.current) {
        this.current.instance.update(this.frame, dt);
        this.drawMarker();
      } else this.drawMenuHands();
      this.renderSurfaceStatus();
    } catch (err) {
      console.error(err);
    }
    this.scene.render();
    this.el.fps.textContent = `${Math.round(this.fps)} fps`;
    requestAnimationFrame((t) => this.tick(t));
  }

  /** Contorno del marcador detectado (en el visor, o mientras se guía la calibración). */
  private drawMarker() {
    const m = this.frame?.space.marker;
    if (!m || (this.current?.def.id !== 'debug' && this.el.guide.hidden)) return;
    this.overlay.polyline([...m.corners, m.corners[0]], 'rgba(54,214,160,0.9)', 3);
  }

  /** En el menú se dibujan las manos para dar feedback de que el tracking anda. */
  private drawMenuHands() {
    for (const h of this.frame?.hands ?? []) {
      if (h.source !== 'pose') this.overlay.skeleton(h.landmarks, HAND_CONNECTIONS, 'rgba(255,255,255,0.45)', 2);
    }
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
