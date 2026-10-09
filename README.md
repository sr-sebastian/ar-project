# AR Proyect

Plataforma de realidad aumentada para **PC con una cámara RGB común** (webcam o celular usado como cámara). Reconoce el cuerpo completo, las manos y sus gestos, y la cara y sus expresiones, todo en un **espacio 3D en metros**. También detecta la superficie de juego (el piso o una mesa) y coloca encima objetos 3D con física, sombras y oclusión.

Corre en el navegador del PC (Chrome o Edge) con TypeScript, MediaPipe, Three.js y Rapier.

## Modos y apps

| Modo | Superficie | Cámara | Apps |
|---|---|---|---|
| **Cuerpo completo** | Piso | De frente, a 2–3 m, con el cuerpo entero a la vista | Fruit Slicer, Bloques, Visor |
| **Mesa** | Mesa | Apuntando a la mesa en diagonal o desde arriba | Aplastá al Topo, Bloques, Visor |

- **Fruit Slicer** (cuerpo completo): las frutas se cortan con las manos o con una **katana** clavada al costado. Para agarrarla, cerrá el puño sobre el mango; para soltarla, abrí la palma. Las bombas se esquivan con el cuerpo. Abrir la boca activa la cámara lenta, y sonreír al final guarda el puntaje.
- **Aplastá al Topo** (mesa): un tablero de ~45 cm se apoya sobre tu mesa real. Los topos salen de adentro de los agujeros y se aplastan bajando la mano sobre ellos. Levantar las cejas los congela.
- **Bloques** (ambos modos): bloques con física para agarrar con una mano (puño o pellizco), abrazar con los dos brazos, apilar y lanzar. En el modo Torre se mide la altura y se guarda el récord. En el piso los bloques miden 25–45 cm; en la mesa, 4–7 cm.
- **Visor de tracking**: muestra el esqueleto, las manos (indicando si se vieron de lejos), la cara, las expresiones, las distancias en metros, la superficie con sus ejes, el mapa de profundidad y los oclusores.

## Control con la mano (sin mouse)

- **Apuntar:** el índice mueve el cursor. Aparece sólo con una mano estable y se suaviza para no temblar.
- **Elegir:** **pellizcá y mantené** ~0,5 s. El anillo se llena y, si soltás antes, se cancela. Quedarse quieto **no** hace click, así que con las manos en reposo no se elige nada sin querer.
- **Volver:** palma abierta **en alto** (tercio superior de la imagen) durante 2 s. También funcionan el botón *Menú* y `Esc`.
- **Objetivo pegajoso:** el botón señalado no se pierde por unos píxeles, y durante el pellizco el cursor queda fijo.

## Superficies: cómo se ubican el piso y la mesa

Hay varios métodos. Se usa el mejor disponible, y el chip de arriba a la derecha indica cuál está activo:

1. **Marcador impreso:** es lo más preciso. Abrí `marcador.html` (o *Imprimir marcadores* en el menú) e imprimí al 100% de escala.
   - **Mesa:** apoyá el marcador 107 (cuadrado negro de 10 cm) sobre la mesa.
   - **Piso:** apoyá el marcador 185 (18 cm, entra en una hoja A4) en el suelo, frente a vos.

   Como el tamaño es conocido, la cámara calcula la posición, la inclinación y la distancia exactas. El centro y la orientación del marcador definen dónde aparece el juego. Si lo tapás, el sistema recuerda la última posición.
2. **Por tu cuerpo (piso):** con los pies a la vista, el piso pasa por tus pies y la vertical sale de tu postura de pie, o de la gravedad del celular si lo usás como cámara.
3. **Por tu mano (mesa):** apoyá la mano abierta y plana sobre la mesa durante 1 s. El centro de la palma da el punto y la orientación de la mano da la inclinación.
4. **Profundidad por IA** (opcional, en Ajustes): Depth Anything V2 estima la inclinación de la mesa y la zona útil.

Para volver a detectar la superficie (por ejemplo, si moviste la cámara), usá el botón de la mira.

## Detección a distancia

- Se pide la cámara en **1080p**.
- Si la pose ve una muñeca o la cabeza pero el detector no encuentra la mano o la cara, se **recorta y amplía esa zona** y se vuelve a buscar ahí.
- Si aun así no aparece, se usa una mano aproximada con los puntos de la pose. Alcanza para cortar, empujar y abrazar, no para gestos finos.
- De lejos, la posición de la mano se ancla a la muñeca del esqueleto para que todo quede coherente.
- En *Ajustes → Modelo de cuerpo*, *Heavy* es el modelo que mejor funciona de lejos.

## Integración visual

- El video se dibuja dentro de WebGL y la cámara 3D replica a la real (mismo campo de visión y recorte), **en metros**.
- **Oclusión:** las manos y el cuerpo, reconstruidos en 3D, tapan a los objetos virtuales que están detrás. En *Ajustes* podés verlos con *Ver oclusores*.
- **Sombras de contacto** sobre la superficie real, **iluminación estimada** a partir del video y reflejos con un entorno PBR.
- **Modelos 3D procedurales:** frutas con texturas (sandía, manzana, naranja, limón, durazno) y mitades con la pulpa a la vista, bomba, katana, topo con pelaje, bloques de juguete y de madera.
- **Modelos propios (opcional):** si ponés `public/models3d/katana.glb` o `public/models3d/mole.glb`, se usan en lugar de los procedurales.

## Empezar

```bash
npm install
npm run models:download   # opcional: modelos de MediaPipe en public/models (si no, se bajan de Google)
npm run dev
```

Abrí `https://localhost:5173` y aceptá el certificado autofirmado. Hace falta HTTPS para que el celular pueda usar la cámara por la red local.

## Usar el celular como cámara

- **Con una app de cámara virtual** (DroidCam, Iriun, Camo, Continuity, Phone Link): el celular aparece en *Ajustes → Dispositivo*.
- **Sin instalar nada (WebRTC):** en *Ajustes*, tocá *Conectar celular por QR* y escaneá el código con el celular, en la misma red Wi-Fi. El celular también manda la gravedad, y eso mejora la detección del piso.

Cada cámara guarda su propia calibración: espejado, campo de visión e inclinación.

## Arquitectura

```
src/
  core/         App (shell, menú, guía de superficie, loop), SceneManager (video en WebGL,
                cámara métrica, sombras, luz), occlusion (oclusores), Viewport, Overlay2D, modos
  camera/       fuentes de cámara: dispositivo y celular por WebRTC
  tracking/     Tracker (MediaPipe + recortes guiados por la pose + mano desde la pose)
  perception/   gestos, expresiones, cuerpo, metric (PnP de traslación → metros), Perception
    space/      marcadores ArUco, calibraciones (piso por cuerpo, mesa por palma),
                plano en disparidad, worker de profundidad
  input/        HandCursor (pellizcar y mantener, objetivo pegajoso, volver con la palma en alto)
  models/       modelos y texturas procedurales, cargador de GLB opcional
  ui/           íconos (Lucide)
  apps/         fruit-slicer (+ katana), whack-a-mole, blocks (Rapier), debug
server/         plugin de Vite: señalización WebSocket + WASM de MediaPipe (+ parche Node 22.21)
marcador.html   marcadores para imprimir a escala real
```

### Agregar un minijuego

1. Creá `src/apps/mi-juego/` con un `AppDefinition` (`icon`, `accent`, `modes`, `modules`, `usesSurface`, `create()`).
2. Implementá `mount(ctx)`, `update(frame, dt)` y `unmount()`. `frame` trae `hands`, `body` y `face`, cada uno con coordenadas en metros (`camera`, `palm3`, `velocity3`), y `space` con la superficie, su centro y su eje.
3. Para apoyar contenido sobre la superficie: `new SurfaceAnchor(ctx.scene, tamaño)` y `anchor.update(frame.space)`. Lo que agregues a `anchor.group` usa metros, con el eje Y como la normal.
4. Registralo en `src/apps/registry.ts`.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo HTTPS en la LAN (`AR_NO_HTTPS=1` para usar HTTP) |
| `npm run build` | Typecheck y build de producción en `dist/` |
| `npm run preview` | Sirve el build, con señalización incluida |
| `npm test` | Tests unitarios (métrica, superficies, marcadores, gestos, juegos, agarre, katana) |
| `npm run lint` / `npm run typecheck` | Calidad de código |
| `npm run models:download` | Descarga los modelos de MediaPipe para trabajar offline |
