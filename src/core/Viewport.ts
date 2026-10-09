import type { Vec2 } from './math';

/**
 * El video se muestra con `object-fit: cover` (llena la pantalla recortando bordes).
 * Esta clase convierte entre coordenadas normalizadas del video [0,1] y píxeles de pantalla.
 */
export class Viewport {
  width = 1;
  height = 1;
  videoWidth = 16;
  videoHeight = 9;
  /** Tamaño y desplazamiento del video escalado en pantalla. */
  displayWidth = 1;
  displayHeight = 1;
  offsetX = 0;
  offsetY = 0;

  update(width: number, height: number, videoWidth: number, videoHeight: number) {
    this.width = width;
    this.height = height;
    if (videoWidth > 0 && videoHeight > 0) {
      this.videoWidth = videoWidth;
      this.videoHeight = videoHeight;
    }
    const scale = Math.max(width / this.videoWidth, height / this.videoHeight);
    this.displayWidth = this.videoWidth * scale;
    this.displayHeight = this.videoHeight * scale;
    this.offsetX = (width - this.displayWidth) / 2;
    this.offsetY = (height - this.displayHeight) / 2;
  }

  get videoAspect() {
    return this.videoWidth / this.videoHeight;
  }

  toScreen(p: Vec2): Vec2 {
    return { x: p.x * this.displayWidth + this.offsetX, y: p.y * this.displayHeight + this.offsetY };
  }

  toNorm(px: Vec2): Vec2 {
    return { x: (px.x - this.offsetX) / this.displayWidth, y: (px.y - this.offsetY) / this.displayHeight };
  }

  /** Convierte una longitud en "alturas de video" a píxeles. */
  lengthToPx(l: number) {
    return l * this.displayHeight;
  }

  /** Rango normalizado visible (por el recorte de cover). */
  visibleBounds() {
    const a = this.toNorm({ x: 0, y: 0 });
    const b = this.toNorm({ x: this.width, y: this.height });
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }
}
