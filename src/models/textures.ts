import * as THREE from 'three';
import { seededRandom } from '../core/math';

/**
 * Texturas procedurales dibujadas en canvas (sin archivos externos). Se cachean por clave
 * porque generarlas cuesta y se reutilizan en muchas instancias.
 */
const cache = new Map<string, THREE.Texture>();

function canvasTexture(key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true) {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Ruido de valor suavizado (para manchas, vetas, pelaje). */
function noiseField(w: number, h: number, cell: number, seed: number) {
  const rnd = seededRandom(seed);
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = Array.from({ length: gw * gh }, () => rnd());
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = smooth(gx - x0);
    const ty = smooth(gy - y0);
    const g = (i: number, j: number) => grid[((j % gh) + gh) % gh * gw + (((i % gw) + gw) % gw)];
    const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx;
    const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}

/** Rayas de sandía (mapa equirectangular: u = longitud, v = latitud). */
export function watermelonTexture() {
  return canvasTexture('watermelon', 512, 256, (c, w, h) => {
    c.fillStyle = '#2f7d32';
    c.fillRect(0, 0, w, h);
    const n = noiseField(w, h, 18, 7);
    const stripes = 14;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const wobble = (n(x, y) - 0.5) * 18;
        const s = Math.sin(((x + wobble) / w) * Math.PI * 2 * stripes);
        if (s > 0.35) {
          c.fillStyle = `rgba(16,60,20,${0.55 + 0.4 * (s - 0.35)})`;
          c.fillRect(x, y, 1, 1);
        }
      }
    }
    // Brillo leve en las zonas claras.
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.05)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** Piel moteada genérica (manzana, naranja, limón). */
export function speckledTexture(key: string, base: string, speck: string, gradientTop?: string) {
  return canvasTexture(`speckle:${key}`, 256, 256, (c, w, h) => {
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);
    if (gradientTop) {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, gradientTop);
      g.addColorStop(0.6, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
    const rnd = seededRandom(key.length * 97);
    c.fillStyle = speck;
    for (let i = 0; i < 700; i++) {
      c.globalAlpha = 0.15 + rnd() * 0.35;
      c.beginPath();
      c.arc(rnd() * w, rnd() * h, 0.6 + rnd() * 1.4, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  });
}

/** Mapa de relieve con hoyuelos (cáscara de cítricos). */
export function dimpleBump() {
  return canvasTexture(
    'dimples',
    256,
    256,
    (c, w, h) => {
      c.fillStyle = '#808080';
      c.fillRect(0, 0, w, h);
      const rnd = seededRandom(3);
      for (let i = 0; i < 1600; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const r = 1 + rnd() * 2;
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(40,40,40,0.8)');
        g.addColorStop(1, 'rgba(128,128,128,0)');
        c.fillStyle = g;
        c.fillRect(x - r, y - r, r * 2, r * 2);
      }
    },
    false,
  );
}

/** Interior de fruta cortada: pulpa con semillas o gajos. */
export function fleshTexture(kind: 'watermelon' | 'citrus' | 'apple', flesh: string, rind: string) {
  return canvasTexture(`flesh:${kind}:${flesh}`, 256, 256, (c, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2;
    c.fillStyle = rind;
    c.fillRect(0, 0, w, h);
    c.fillStyle = kind === 'watermelon' ? '#f1f8e9' : '#fffde7';
    c.beginPath();
    c.arc(cx, cy, r * 0.96, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = flesh;
    c.beginPath();
    c.arc(cx, cy, r * (kind === 'watermelon' ? 0.86 : 0.9), 0, Math.PI * 2);
    c.fill();
    const rnd = seededRandom(kind.length);
    if (kind === 'watermelon') {
      c.fillStyle = '#1b1b1b';
      for (let i = 0; i < 26; i++) {
        const a = rnd() * Math.PI * 2;
        const d = r * (0.25 + rnd() * 0.45);
        c.save();
        c.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
        c.rotate(a);
        c.beginPath();
        c.ellipse(0, 0, 5, 2.6, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
    } else if (kind === 'citrus') {
      c.strokeStyle = 'rgba(255,255,240,0.8)';
      c.lineWidth = 3;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
        c.stroke();
      }
    } else {
      c.fillStyle = '#5d4037';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        c.beginPath();
        c.ellipse(cx + Math.cos(a) * r * 0.18, cy + Math.sin(a) * r * 0.18, 5, 9, a, 0, Math.PI * 2);
        c.fill();
      }
    }
  });
}

/** Madera con vetas (bloques, tablero). */
export function woodTexture(tint = '#c8955a') {
  return canvasTexture(`wood:${tint}`, 512, 512, (c, w, h) => {
    c.fillStyle = tint;
    c.fillRect(0, 0, w, h);
    const n = noiseField(w, h, 64, 11);
    const img = c.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.sin((y / h) * 40 + n(x, y) * 9) * 0.5 + 0.5;
        const k = 0.82 + v * 0.18 + (n(x * 4, y * 0.5) - 0.5) * 0.1;
        const i = (y * w + x) * 4;
        img.data[i] *= k;
        img.data[i + 1] *= k;
        img.data[i + 2] *= k;
      }
    }
    c.putImageData(img, 0, 0);
  });
}

/** Cara de bloque de juguete con una letra o número en relieve pintado. */
export function blockFaceTexture(color: string, glyph: string) {
  return canvasTexture(`block:${color}:${glyph}`, 256, 256, (c, w, h) => {
    c.fillStyle = color;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 10;
    c.strokeRect(18, 18, w - 36, h - 36);
    c.font = `900 ${h * 0.55}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillText(glyph, w / 2 + 5, h / 2 + 9);
    c.fillStyle = '#ffffff';
    c.fillText(glyph, w / 2, h / 2 + 4);
  });
}

/** Encordado en rombos del mango de la katana (tsuka-ito). */
export function handleWrapTexture() {
  return canvasTexture('tsuka', 128, 512, (c, w, h) => {
    c.fillStyle = '#f2efe6'; // samegawa (piel clara de fondo)
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#141414';
    const step = 64;
    for (let y = -step; y < h + step; y += step) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w / 2, y + step / 2);
      c.lineTo(w, y);
      c.lineTo(w, y + 18);
      c.lineTo(w / 2, y + step / 2 + 18);
      c.lineTo(0, y + 18);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(0, y + step / 2);
      c.lineTo(w / 2, y);
      c.lineTo(w, y + step / 2);
      c.lineTo(w, y + step / 2 + 18);
      c.lineTo(w / 2, y + 18);
      c.lineTo(0, y + step / 2 + 18);
      c.closePath();
      c.fill();
    }
  });
}

/** Hamon (línea de temple) de la hoja: zona del filo más clara y ondulada. */
export function bladeTexture() {
  return canvasTexture('blade', 64, 512, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#9aa3ab');
    g.addColorStop(1, '#c9d0d6');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#eef3f6';
    c.beginPath();
    c.moveTo(w, 0);
    for (let y = 0; y <= h; y += 8) c.lineTo(w * (0.62 + 0.08 * Math.sin(y / 14)), y);
    c.lineTo(w, h);
    c.closePath();
    c.fill();
  });
}

/** Pelaje: ruido fino para color + relieve. */
export function furTexture(base: string) {
  return canvasTexture(`fur:${base}`, 256, 256, (c, w, h) => {
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);
    const rnd = seededRandom(17);
    for (let i = 0; i < 5000; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const l = 2 + rnd() * 5;
      c.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + (rnd() - 0.5) * 2, y + l);
      c.stroke();
    }
  });
}

/** Pasto estilizado para el tablero de los topos. */
export function grassTexture() {
  return canvasTexture('grass', 256, 256, (c, w, h) => {
    c.fillStyle = '#4caf50';
    c.fillRect(0, 0, w, h);
    const rnd = seededRandom(23);
    for (let i = 0; i < 3000; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      c.strokeStyle = `hsl(${100 + rnd() * 30}, ${45 + rnd() * 25}%, ${28 + rnd() * 22}%)`;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + (rnd() - 0.5) * 3, y - 3 - rnd() * 5);
      c.stroke();
    }
  });
}
