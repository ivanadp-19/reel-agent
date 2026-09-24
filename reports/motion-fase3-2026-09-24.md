# Motion, fase 3 (títulos y trazos): reporte del 2026-09-24 (noche)

Objetivo: Fase 3 del plan `docs/superpowers/plans/2026-09-24-captions-ai-motion.md`: cómo llegan, viven y se van los títulos y gráficos en los previews de Captions.ai, y los trazos que se dibujan. Cada movimiento se comparó frame a frame contra su preview (`scripts/motion-compare.mjs`; arriba el preview, abajo nosotros; hojas en `.captions-tmp/motion-v3/`). Commits locales en `main`, sin push.

## Cómo está construido

- **Un envoltorio común** (`One` en `src/Graphics.tsx`) aplica a cualquier gráfico su llegada de bloque (`drop`, `slideBlur`, `slideDown`, `band`, `wipe`, `fade`), su salida (`fade`, `cut`, `blur`, `slideUp`, `band`) y su vida (`grow`, `marquee`, `drift`, `oscillate`), todas funciones puras de `src/motion.ts`.
- **Un componente de texto compartido** (`Letters`) que todas las plantillas de texto usan: cuando el revelado o la salida trabajan por carácter (`letters`, `typewriter`, `shuffle`, `tracking`; salida `letters`), dibuja carácter a carácter con el tiempo medido (42 ms por letra con la puntera desenfocada, 30 ms en typewriter, 290 ms de barajado, 375 ms de tracking); si no, un solo `span`.
- **Cinco plantillas nuevas**: `band-title` (Focus), `neon-frame` (Prime: se dibuja en 3 f, inclinado, oscila ±3° con una copia 4 f detrás), `scribble` (Sketch/Chalk: elipse doble, subrayado u onda que se dibuja en 6 f, con *boil*), `outline-rect` (Evo: se dibuja en 11 f y se expande hasta salir), `frame-light` (Prime: un segmento de luz que recorre el borde). El `starburst` aterriza como sello (`anim: stamp`, Pop).
- **Cámara**: `camera: punch` en un gráfico empuja el metraje 1.4× con el título y lo devuelve al salir (Orbit).
- **Defaults por pack** (`titles` en `captionPresets.ts`): focus → band/band, stack → drop/fade, lift → wipe/slideUp, prime → letters/fade, orbit → slideDown/slideUp; prism, evo e impact conservan la entrada propia de cada plantilla (su blur-in ya es el de los previews).
- **El agente**: `add_graphic` / `edit_graphic` aceptan `reveal`, `out`, `life`, `camera` con la explicación de cada valor; las skills dicen cuándo tocarlos.

## Gate frame a frame (preview arriba, nosotros abajo)

| Movimiento | Estilo | Lo que coincide | Lo que difiere |
|---|---|---|---|
| reveal letters | Elevate | "Momentum" se construye letra a letra con la puntera desenfocada en ~10 f; la etiqueta y el subtítulo fundan después | nuestra script (Caveat) es más gruesa que la caligráfica del preview (`cmp-p3-letters.jpg`) |
| reveal typewriter | Lens | "Aperture" letra a letra, la puntera con fundido | Lens teclea a ~125 ms por letra; el nuestro a 30 ms (la cadencia de Align y Paper II); haría falta un knob de velocidad (`cmp-p3-typewriter.jpg`) |
| reveal shuffle | Align | glifos aleatorios que se resuelven de izq. a der. en ~9 f | el barajado de Align es más ralo (letras sueltas con huecos), el nuestro denso (`cmp-p3-shuffle.jpg`) |
| reveal tracking | Align | "COMPUTERS" se asienta de 0.7 a 0.38 em en ~9 f | — (`cmp-p3-tracking.jpg`) |
| reveal drop | Stack | "TECHNOLOGY" cae desde arriba con zoom-out 1.3→1 en 3 f | el título del preview es bicolor (TECH / NOLOGY); `big-word` es de un color (`cmp-p3-drop.jpg`) |
| reveal band + out band | Focus | la banda de acento sube desde el borde inferior en 4 f con el texto recortado por su borde, y baja al salir | — (`cmp-p3-band.jpg`) |
| out letters | Form | "RESULTS" se desmonta de la última letra a la primera, ~1.5 f por letra | — (`cmp-p3-lettersOut.jpg`) |
| life grow | Prime | "Progress" en script se revela por letras y crece hacia 1.3× | la script del preview es de pincel (Kaushan), la del template `script` es Caveat: decisión de pack (Fase 5) (`cmp-p3-grow.jpg`) |
| life marquee | Stack | el `oversized` en contorno se desplaza ~17 px/f | el preview lo lleva detrás de la persona recortada (`behind: true` + matte) (`cmp-p3-marquee.jpg`) |
| reveal slideBlur | Prime | "GROWTH" entra desde la derecha con motion blur y se asienta en ~6 f | sin el muro de contorno detrás (`big-word repeat` + `drift`, aparte) (`cmp-p3-slideBlur.jpg`) |
| camera punch | Orbit | "FRIENDS" baja desde el borde superior en 5 f mientras el metraje empuja a 1.4× en 8 f | — (`cmp-p3-punch.jpg`) |
ROWS_PENDING

## Archivos

- `src/motion.ts` (`revealText`, `scrambleChar`, `lifeFx`, llegadas `band` / `slideDown` / `wipe`), `src/Graphics.tsx` (`Letters`, `One`, cinco componentes), `src/graphicTemplates.ts` (plantillas, `reveal` / `out` / `life` / `camera`), `src/MultiClipVideo.tsx` (zoom con título), `src/captionPresets.ts` (`titles`), `mcp/server.mjs`, `test/motion.test.mjs`, `test/graphics.test.mjs`.
- Hojas: `.captions-tmp/motion-v3/cmp-p3-*.jpg`.
