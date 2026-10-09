# AR Proyect

Plataforma de realidad aumentada para **PC con una cámara RGB común** (webcam o celular usado como cámara). Reconoce el cuerpo completo, las manos y sus gestos, la cara y sus expresiones, y estima el espacio 3D. Sobre esa base corren minijuegos y utilidades.

Corre en el navegador del PC (Chrome o Edge) con TypeScript, MediaPipe y Three.js.

## Modos

| Modo | Superficie | Cámara | Apps |
|---|---|---|---|
| 🧍 **Cuerpo completo** | Piso | De frente, a 2–3 m, con el cuerpo entero a la vista | 🍉 Fruit Slicer, 🔬 Visor |
| 🪑 **Mesa** | Mesa | Apuntando a la mesa en diagonal o desde arriba | 🐹 Aplastá al Topo, 🔬 Visor |

### Minijuegos
- **🍉 Fruit Slicer** (cuerpo completo): se cortan frutas moviendo las manos rápido. Las bombas se esquivan con la cabeza o el torso, y cortarlas resta una vida. Para empezar, levantá los dos brazos o hacé 👍. Abrir la boca activa la cámara lenta, una vez por partida. Al terminar, sonreír guarda el puntaje en el ranking.
- **🐹 Aplastá al Topo** (mesa): los topos salen de agujeros apoyados sobre la mesa detectada. Se aplastan bajando la mano rápido o cerrando el puño encima. Levantar las cejas los congela, una vez por partida. Cada partida dura 60 s.

### Utilidad
- **🔬 Visor de tracking**: muestra el esqueleto, las manos con su gesto, la malla facial, las barras de expresiones, la pose de la cabeza, los ángulos articulares, el mapa de profundidad, la nube de puntos y la grilla de la superficie.

### Control sin mouse
- Mover la mano mueve el cursor, que sigue la punta del índice.
- Para hacer click, pellizcá, o dejá el cursor quieto 1.5 s sobre un botón.
- Para volver al menú, mantené la palma abierta y quieta. También funciona `Esc`.

## Empezar

```bash
npm install
npm run models:download   # opcional: guarda los modelos de MediaPipe en public/models (si no, se bajan de Google)
npm run dev
```

Abrí `https://localhost:5173` y aceptá el certificado autofirmado. Hace falta HTTPS para que el celular pueda usar la cámara por la red local.

## Usar el celular como cámara (con paridad respecto a la webcam)

Después de recibir el video, el pipeline es idéntico para cualquier fuente. Hay dos formas de conectar el celular:

1. **App de cámara virtual** (DroidCam, Iriun, Camo, Continuity de macOS, Phone Link de Windows). El celular aparece como una cámara más. Elegila en ⚙️ → *Dispositivo*.
2. **Sin instalar nada (WebRTC)**: en ⚙️ tocá *📱 Conectar celular por QR* y escaneá el código. El celular tiene que estar en la misma red Wi-Fi. En el celular aceptá el certificado y tocá *Conectar*. El celular también manda la dirección de la gravedad desde el acelerómetro, y eso mejora la detección del piso y de la mesa.

Cada cámara guarda su propia calibración: espejado, campo de visión e inclinación supuesta para el modo mesa.

## Espacio 3D

Al activar *Espacio 3D* en ⚙️ (o en el Visor) se carga **Depth Anything V2 small**, que estima la profundidad monocular. Corre en un Web Worker con WebGPU y, si no hay WebGPU, con WASM. La primera vez descarga entre 25 y 100 MB. Con el mapa de profundidad:
- se arma una nube de puntos con la cámara calibrada por FOV;
- se ajusta un plano con RANSAC más un refinamiento por mínimos cuadrados (en el modo cuerpo completo es el piso, en el modo mesa es la mesa);
- los objetos virtuales se apoyan sobre ese plano (`SurfaceAnchor`).

Sin profundidad se usa una superficie supuesta, ajustable con la inclinación de la cámara.

## Arquitectura

```
src/
  core/         App (shell, menú, loop), SceneManager (Three.js alineado con la cámara real),
                Viewport, Overlay2D, EventBus, modos, settings
  camera/       CameraSource, DeviceCameraSource, PhoneWebRTCSource, señalización
  tracking/     Tracker (MediaPipe: pose + manos/gestos + cara), filtro One-Euro
  perception/   gestos, expresiones, cuerpo/postura, Perception (estado + eventos)
    space/      worker de profundidad, estimación de superficie (RANSAC)
  input/        HandCursor (cursor de mano, pinch, dwell, palma = volver)
  apps/         minijuegos y utilidades (cada uno con su lógica pura testeable)
  phone/        página emisora del celular
server/         plugin de Vite: señalización WebSocket + WASM de MediaPipe
```

### Agregar un minijuego
1. Crear `src/apps/mi-juego/` con un `AppDefinition` que tenga `modes`, `modules` y `create()`.
2. Implementar `mount(ctx)`, `update(frame, dt)` y `unmount()`. `frame` trae `hands`, `face`, `body` y `space`, y `ctx.events` emite eventos como `gesture`, `pinch`, `swipe` y `expression`.
3. Registrarlo en `src/apps/registry.ts`.

Para apoyar contenido sobre el piso o la mesa: `new SurfaceAnchor(ctx.scene, anchor)` y después `anchor.update(frame.space)`.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo HTTPS en la LAN (`AR_NO_HTTPS=1` para usar HTTP) |
| `npm run build` | Typecheck y build de producción en `dist/` |
| `npm run preview` | Sirve el build, con señalización incluida |
| `npm test` | Tests unitarios (gestos, expresiones, filtros, RANSAC, lógica de los juegos) |
| `npm run lint` / `npm run typecheck` | Calidad de código |
| `npm run models:download` | Descarga los modelos de MediaPipe para trabajar offline |
