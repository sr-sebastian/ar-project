import type { Vec2 } from '../core/math';
import type { Viewport } from '../core/Viewport';
import type { HandState } from '../perception/types';

const CLICKABLE = 'button, [data-ar-click], a[href], input[type="checkbox"], select';

/**
 * Cursor controlado con la mano: la punta del índice mueve el cursor, un pellizco hace
 * click y quedarse quieto sobre un botón ("dwell") también hace click. Mantener la palma
 * abierta y quieta dispara "volver".
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
  private hovered: Element | null = null;
  private hoverStart = 0;
  private wasPinching = false;
  private palmStart = 0;
  private cooldownUntil = 0;

  constructor(
    private viewport: Viewport,
    private dwellMs = 1500,
    private palmBackMs = 1500,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hand-cursor';
    this.el.innerHTML = `<svg viewBox="0 0 40 40"><circle class="track" cx="20" cy="20" r="16"/><circle class="progress" cx="20" cy="20" r="16"/></svg>`;
    this.ring = this.el.querySelector('.progress')!;
    document.body.appendChild(this.el);
  }

  /** Elige la mano que controla el cursor: preferentemente la derecha. */
  private pickHand(hands: HandState[]) {
    return hands.find((h) => h.handedness === 'Right') ?? hands[0] ?? null;
  }

  update(hands: HandState[], now: number) {
    const hand = this.pickHand(hands);
    if (!hand) {
      this.position = null;
      this.el.style.opacity = '0';
      this.setHovered(null, now);
      this.wasPinching = false;
      this.palmStart = 0;
      return;
    }

    // Mientras pellizca, el índice se acerca al pulgar: usamos el punto medio para que el cursor no salte.
    const tip = hand.pinching
      ? { x: (hand.landmarks[4].x + hand.landmarks[8].x) / 2, y: (hand.landmarks[4].y + hand.landmarks[8].y) / 2 }
      : hand.indexTip;
    const p = this.viewport.toScreen(tip);
    this.position = p;
    this.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    this.el.classList.toggle('pinching', hand.pinching);

    const target = this.visible ? (document.elementFromPoint(p.x, p.y)?.closest(CLICKABLE) ?? null) : null;
    this.setHovered(target, now);

    let progress = 0;
    if (this.hovered && now > this.cooldownUntil) {
      progress = (now - this.hoverStart) / this.dwellMs;
      if (progress >= 1) this.click(now);
    }
    if (hand.pinching && !this.wasPinching && this.hovered && now > this.cooldownUntil) this.click(now);
    this.wasPinching = hand.pinching;

    // Palma abierta y quieta → volver.
    if (this.backEnabled && hand.gesture === 'open_palm' && hand.speed < 0.4) {
      this.palmStart ||= now;
      const back = (now - this.palmStart) / this.palmBackMs;
      if (!this.hovered) progress = back;
      this.el.classList.toggle('back', back > 0.15);
      if (back >= 1 && now > this.cooldownUntil) {
        this.cooldownUntil = now + 1000;
        this.palmStart = 0;
        this.onBack();
      }
    } else {
      this.palmStart = 0;
      this.el.classList.remove('back');
    }
    this.ring.style.strokeDashoffset = String(100.5 * (1 - Math.min(1, progress)));
    // Oculto, sólo aparece para mostrar el progreso del gesto de volver.
    this.el.style.opacity = this.visible || this.palmStart ? '1' : '0';
  }

  private setHovered(el: Element | null, now: number) {
    if (el === this.hovered) return;
    this.hovered?.classList.remove('ar-hover');
    this.hovered = el;
    this.hoverStart = now;
    el?.classList.add('ar-hover');
  }

  private click(now: number) {
    const el = this.hovered as HTMLElement | null;
    if (!el) return;
    this.cooldownUntil = now + 700;
    this.hoverStart = now + 700;
    el.classList.add('ar-pressed');
    setTimeout(() => el.classList.remove('ar-pressed'), 200);
    el.click();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.el.style.opacity = '0';
  }
}
