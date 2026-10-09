import type { Vec2 } from '../core/math';
import type { Viewport } from '../core/Viewport';
import type { HandState } from '../perception/types';

const CLICKABLE = 'button:not([disabled]), [data-ar-click], a[href], input[type="checkbox"], select';

/**
 * Cursor controlado con la mano, diseñado para NO producir selecciones accidentales:
 *
 * - Nada se activa por quedarse quieto (no hay "dwell"): para elegir hay que pellizcar y
 *   SOSTENER el pellizco ~0.45 s. Soltar antes cancela.
 * - Mientras se pellizca, el cursor queda congelado donde empezó el pellizco (el gesto
 *   mueve los dedos y desplazaría el cursor fuera del botón).
 * - El objetivo es "pegajoso": una vez sobre un botón, se mantiene aunque el cursor se
 *   salga unos píxeles del borde (histéresis), así no titila entre tarjetas vecinas.
 * - El cursor sólo aparece con una mano estable (detectada varios frames seguidos y con
 *   dedos confiables), y se suaviza para eliminar el temblor.
 * - Mantener la palma abierta, quieta y LEVANTADA (tercio superior de la imagen) 2 s
 *   dispara "volver" (sólo donde se permite). Así no se dispara con las manos en reposo.
 */
export class HandCursor {
  /** Si es false, el cursor no se muestra ni hace clicks (el gesto de volver sigue activo). */
  visible = true;
  /** Si el gesto de palma abierta para volver está disponible ahora. */
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
  private pinchStart = 0;
  private pinchConsumed = false;
  private palmStart = 0;
  private cooldownUntil = 0;
  private stableFrames = 0;

  constructor(
    private viewport: Viewport,
    private holdMs = 450,
    private palmBackMs = 2000,
    private stickyPx = 28,
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

  update(hands: HandState[], now: number) {
    const hand = this.pickHand(hands);
    this.stableFrames = hand ? this.stableFrames + 1 : 0;
    if (!hand || this.stableFrames < 4) {
      this.position = null;
      this.smoothed = null;
      this.frozenAt = null;
      this.pinchStart = 0;
      this.palmStart = 0;
      this.setHovered(null);
      this.render(0, false);
      return;
    }

    // Punto de control: punta del índice (o punto medio índice-pulgar al pellizcar).
    const lm = hand.landmarks;
    const raw = this.viewport.toScreen(hand.pinching ? { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 } : hand.indexTip);
    if (!this.smoothed) this.smoothed = raw;
    else {
      const d = Math.hypot(raw.x - this.smoothed.x, raw.y - this.smoothed.y);
      // Zona muerta pequeña + suavizado adaptativo (rápido si el movimiento es grande).
      if (d > 2) {
        const a = Math.min(0.75, 0.2 + d / 200);
        this.smoothed = { x: this.smoothed.x + (raw.x - this.smoothed.x) * a, y: this.smoothed.y + (raw.y - this.smoothed.y) * a };
      }
    }

    // Pellizco: congela el cursor y cuenta el tiempo sostenido.
    let progress = 0;
    if (hand.pinching) {
      if (!this.pinchStart) {
        this.pinchStart = now;
        this.frozenAt = this.smoothed;
        this.pinchConsumed = false;
      }
      if (this.hovered && !this.pinchConsumed && now > this.cooldownUntil) {
        progress = (now - this.pinchStart) / this.holdMs;
        if (progress >= 1) {
          this.pinchConsumed = true;
          this.activate(now);
        }
      }
    } else {
      this.pinchStart = 0;
      this.frozenAt = null;
    }
    const p = this.frozenAt ?? this.smoothed;
    this.position = p;
    if (!hand.pinching && this.visible) this.setHovered(this.findTarget(p));
    if (!this.visible) this.setHovered(null);

    // Palma abierta y quieta → volver.
    let back = 0;
    if (this.backEnabled && hand.gesture === 'open_palm' && hand.speed < 0.35 && !hand.pinching && hand.palmCenter.y < 0.4) {
      this.palmStart ||= now;
      back = (now - this.palmStart) / this.palmBackMs;
      if (back >= 1 && now > this.cooldownUntil) {
        this.cooldownUntil = now + 1200;
        this.palmStart = 0;
        this.onBack();
      }
    } else this.palmStart = 0;

    this.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    this.el.classList.toggle('pinching', hand.pinching);
    this.el.classList.toggle('back', back > 0.1);
    this.label.textContent = back > 0.1 ? 'Volver' : this.hovered && hand.pinching && !this.pinchConsumed ? 'Mantené…' : '';
    this.render(back > 0.1 ? back : progress, this.visible || back > 0.1);
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
    this.cooldownUntil = now + 600;
    el.classList.add('ar-pressed');
    setTimeout(() => el.classList.remove('ar-pressed'), 220);
    el.click();
  }

  private render(progress: number, show: boolean) {
    this.ring.style.strokeDashoffset = String(119.4 * (1 - Math.min(1, Math.max(0, progress))));
    this.el.style.opacity = show && this.position ? '1' : '0';
    this.el.classList.toggle('over-target', !!this.hovered);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.setHovered(null);
  }
}
