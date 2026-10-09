import type { Vec2 } from '../core/math';
import type { Viewport } from '../core/Viewport';
import type { HandState } from '../perception/types';

const CLICKABLE = 'button:not([disabled]), [data-ar-click], a[href], input[type="checkbox"], select';

/**
 * Cursor controlado con la mano, pensado para que NADA se active sin querer:
 *
 * - El cursor sigue el CENTRO DE LA PALMA (estable con cualquier postura de la mano), así
 *   se puede mover con la mano relajada, cerrada o como sea: moverse no hace nada.
 * - Para ELEGIR: sobre el botón, ABRIR la palma mirando a la cámara y sostenerla ~0.6 s
 *   (se llena el anillo). Tiene que ser una apertura: si se llega con la palma ya abierta,
 *   hay que cerrarla y volver a abrirla. Con el dorso hacia la cámara no elige.
 * - Puño, pellizco y cualquier otro gesto no hacen nada en el menú.
 * - Al abrir la mano el cursor se congela (abrir los dedos desplaza el centro de la palma).
 * - El objetivo es "pegajoso" (histéresis de unos píxeles) para no titilar entre botones.
 * - Para VOLVER: cruzar los brazos en X ~1 s (lo detecta el shell y llama a `onBack`).
 */
export class HandCursor {
  /** Si es false, el cursor no se muestra ni elige (volver con la X sigue activo). */
  visible = true;
  /** Si el gesto de volver (brazos en X) está disponible ahora. */
  backEnabled = false;
  /** Posición en píxeles de pantalla, o null si no hay mano. */
  position: Vec2 | null = null;
  onBack: () => void = () => {};

  private el: HTMLDivElement;
  private ring: SVGCircleElement;
  private label: HTMLDivElement;
  private hovered: HTMLElement | null = null;
  private smoothed: Vec2 | null = null;
  private frozenAt: Vec2 | null = null;
  /** La palma estaba abierta hacia la cámara en el frame anterior. */
  private wasOpen = true;
  /** Momento en que se abrió la palma sobre el objetivo actual (0 = no armado). */
  private openSince = 0;
  private consumed = false;
  private crossSince = 0;
  private cooldownUntil = 0;
  private stableFrames = 0;
  private openFrames = 0;

  constructor(
    private viewport: Viewport,
    private holdMs = 600,
    private crossMs = 1000,
    private stickyPx = 32,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hand-cursor';
    this.el.innerHTML = `<svg viewBox="0 0 48 48"><circle class="dot" cx="24" cy="24" r="7"/><circle class="track" cx="24" cy="24" r="19"/><circle class="progress" cx="24" cy="24" r="19"/></svg><div class="hand-cursor-label"></div>`;
    this.ring = this.el.querySelector('.progress')!;
    this.label = this.el.querySelector('.hand-cursor-label')!;
    document.body.appendChild(this.el);
  }

  /** Elige la mano que controla el cursor: preferentemente la derecha, con dedos confiables. */
  private pickHand(hands: HandState[]) {
    const usable = hands.filter((h) => h.source !== 'pose');
    return usable.find((h) => h.handedness === 'Right') ?? usable[0] ?? null;
  }

  /**
   * @param armsCrossed brazos en X en este frame (gesto de volver).
   */
  update(hands: HandState[], armsCrossed: boolean, now: number) {
    // Volver: brazos en X sostenidos.
    let back = 0;
    if (this.backEnabled && armsCrossed && now > this.cooldownUntil) {
      this.crossSince ||= now;
      back = (now - this.crossSince) / this.crossMs;
      if (back >= 1) {
        this.crossSince = 0;
        this.cooldownUntil = now + 1500;
        this.onBack();
      }
    } else this.crossSince = 0;

    const hand = this.pickHand(hands);
    this.stableFrames = hand ? this.stableFrames + 1 : 0;
    if (!hand || this.stableFrames < 4) {
      this.position = null;
      this.smoothed = null;
      this.frozenAt = null;
      this.openSince = 0;
      this.wasOpen = true; // al reaparecer hay que abrir la mano de nuevo
      this.setHovered(null);
      this.render(back, back > 0.05);
      return;
    }

    // Palma abierta hacia la cámara, estable unos frames (filtra parpadeos del clasificador).
    const openNow = hand.gesture === 'open_palm' && hand.palmFacing;
    this.openFrames = openNow ? this.openFrames + 1 : 0;
    const open = this.openFrames >= 2;

    // Posición: centro de la palma, suavizado con zona muerta.
    const raw = this.viewport.toScreen(hand.palmCenter);
    if (!this.smoothed) this.smoothed = raw;
    else {
      const d = Math.hypot(raw.x - this.smoothed.x, raw.y - this.smoothed.y);
      if (d > 2) {
        const a = Math.min(0.75, 0.2 + d / 200);
        this.smoothed = { x: this.smoothed.x + (raw.x - this.smoothed.x) * a, y: this.smoothed.y + (raw.y - this.smoothed.y) * a };
      }
    }

    // Selección por apertura de palma.
    let progress = 0;
    if (open && !this.wasOpen) {
      // Flanco: la mano se acaba de abrir → congelar cursor y armar la selección.
      this.frozenAt = this.smoothed;
      this.openSince = now;
      this.consumed = false;
    }
    if (!open) {
      this.openSince = 0;
      this.frozenAt = null;
    }
    this.wasOpen = open;

    const p = this.frozenAt ?? this.smoothed;
    this.position = p;
    if (this.visible && !this.openSince) this.setHovered(this.findTarget(p));
    if (!this.visible) this.setHovered(null);

    if (this.visible && this.openSince && this.hovered && !this.consumed && now > this.cooldownUntil) {
      progress = (now - this.openSince) / this.holdMs;
      if (progress >= 1) {
        this.consumed = true;
        this.activate(now);
      }
    }

    this.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    this.el.classList.toggle('selecting', !!this.openSince && !!this.hovered && !this.consumed);
    this.el.classList.toggle('back', back > 0.05);
    this.label.textContent = back > 0.05 ? 'Volver' : this.openSince && this.hovered && !this.consumed ? 'Mantené la palma…' : '';
    this.render(back > 0.05 ? back : progress, this.visible || back > 0.05);
  }

  /** Busca el elemento clickeable bajo el cursor, manteniendo el actual si sigue cerca. */
  private findTarget(p: Vec2): HTMLElement | null {
    if (this.hovered && this.hovered.isConnected) {
      const r = this.hovered.getBoundingClientRect();
      const s = this.stickyPx;
      if (p.x >= r.left - s && p.x <= r.right + s && p.y >= r.top - s && p.y <= r.bottom + s) return this.hovered;
    }
    this.el.style.display = 'none';
    const el = document.elementFromPoint(p.x, p.y)?.closest(CLICKABLE) as HTMLElement | null;
    this.el.style.display = '';
    return el;
  }

  private setHovered(el: HTMLElement | null) {
    if (el === this.hovered) return;
    this.hovered?.classList.remove('ar-hover');
    this.hovered = el;
    el?.classList.add('ar-hover');
  }

  private activate(now: number) {
    const el = this.hovered;
    if (!el) return;
    this.cooldownUntil = now + 700;
    el.classList.add('ar-pressed');
    setTimeout(() => el.classList.remove('ar-pressed'), 220);
    el.click();
  }

  private render(progress: number, show: boolean) {
    this.ring.style.strokeDashoffset = String(119.4 * (1 - Math.min(1, Math.max(0, progress))));
    this.el.style.opacity = show && (this.position || progress > 0) ? '1' : '0';
    if (!this.position && progress > 0) this.el.style.transform = `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`;
    this.el.classList.toggle('over-target', !!this.hovered);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.setHovered(null);
  }
}
