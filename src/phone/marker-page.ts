import { AR } from 'js-aruco2';
import { DEFAULT_MARKER_SIZES, MARKER_IDS } from '../perception/space/marker';

/** Genera los marcadores a escala real (mm) para imprimir. */
const dict = new AR.Dictionary('ARUCO');
const sheets = document.querySelector('#sheets')!;

for (const kind of ['table', 'floor'] as const) {
  const id = MARKER_IDS[kind];
  const blackMm = DEFAULT_MARKER_SIZES[kind] * 1000;
  // El SVG mide 9 celdas (1 de margen blanco + 7 del cuadrado negro + 1): escalamos para
  // que el cuadrado negro mida exactamente `blackMm`.
  const totalMm = (blackMm * 9) / 7;
  const svg = dict.generateSVG(id).replace('<svg ', `<svg width="${totalMm}mm" height="${totalMm}mm" shape-rendering="crispEdges" `);
  const sheet = document.createElement('section');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <h2>${kind === 'table' ? 'MESA' : 'PISO'} · marcador ${id}</h2>
    <p>El cuadrado negro debe medir ${blackMm / 10} cm de lado</p>
    <div class="marker">${svg}</div>
    <p>▲ adelante (hacia la cámara) ▲</p>`;
  sheets.appendChild(sheet);
}
