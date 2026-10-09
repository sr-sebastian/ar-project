import type { Vec2 } from './math';
import type { Viewport } from './Viewport';

/** Canvas 2D sobre el video para dibujar en coordenadas normalizadas del video. */
export class Overlay2D {
  readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private viewport: Viewport,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(width: number, height: number) {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  px(p: Vec2): Vec2 {
    return this.viewport.toScreen(p);
  }

  /** Longitud en alturas de video → píxeles. */
  len(l: number) {
    return this.viewport.lengthToPx(l);
  }

  circle(p: Vec2, radiusPx: number, fill?: string, stroke?: string, lineWidth = 2) {
    const s = this.px(p);
    const c = this.ctx;
    c.beginPath();
    c.arc(s.x, s.y, radiusPx, 0, Math.PI * 2);
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lineWidth;
      c.stroke();
    }
  }

  line(a: Vec2, b: Vec2, color: string, width = 3) {
    const sa = this.px(a);
    const sb = this.px(b);
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(sa.x, sa.y);
    c.lineTo(sb.x, sb.y);
    c.stroke();
  }

  polyline(points: Vec2[], color: string, width = 3) {
    if (points.length < 2) return;
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    points.forEach((p, i) => {
      const s = this.px(p);
      if (i === 0) c.moveTo(s.x, s.y);
      else c.lineTo(s.x, s.y);
    });
    c.stroke();
  }

  skeleton(points: Vec2[], connections: [number, number][], color: string, width = 3, visibility?: (i: number) => number) {
    for (const [a, b] of connections) {
      if (!points[a] || !points[b]) continue;
      if (visibility && (visibility(a) < 0.5 || visibility(b) < 0.5)) continue;
      this.line(points[a], points[b], color, width);
    }
  }

  text(p: Vec2 | { px: number; py: number }, text: string, opts: { color?: string; size?: number; align?: CanvasTextAlign; font?: string } = {}) {
    const s = 'px' in p ? { x: p.px, y: p.py } : this.px(p);
    const c = this.ctx;
    c.font = `${opts.font ?? '600'} ${opts.size ?? 16}px system-ui, sans-serif`;
    c.textAlign = opts.align ?? 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 4;
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.strokeText(text, s.x, s.y);
    c.fillStyle = opts.color ?? '#fff';
    c.fillText(text, s.x, s.y);
  }
}
