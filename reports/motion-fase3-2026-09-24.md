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
| reveal wipe | Lift | la tarjeta entra con un barrido inclinado desde la izquierda en 5 f con el título dentro | la tarjeta del preview es verde oscuro con un polígono menta: paleta y lienzo de pack (Fase 5) (`cmp-p3-wipe.jpg`) |
| neon-frame | Prime | el marco se dibuja en 3 f, inclinado, y oscila con una copia 4 f detrás | el brillo del preview es más ancho y cian: paleta de pack (`cmp-p3-neon.jpg`) |
| outline-rect | Evo | el contorno fino se dibuja desde el borde derecho en ~11 f y sigue expandiéndose | el degradado azul→violeta del preview es el acento del pack (`cmp-p3-outline.jpg`) |
| scribble ellipse | Sketch | la elipse doble se traza en ~6 f alrededor del punto | el trazo del preview es más grueso y beige; `color: light` lo deja crema (`cmp-p3-scribble.jpg`) |
| starburst stamp | Pop | aterriza 1.25→1 en 3 f y se queda quieto | rosa y con decoración escalonada alrededor en el preview: pack + stickers (`cmp-p3-stamp.jpg`) |
| frame-light | Prime | un segmento de luz recorre el borde, una vuelta cada ~700 ms | — (`cmp-p3-light.jpg`) |

Nota del gate: la primera pasada de seis casos (tarjeta, neón, contorno, garabato, sello, luz) salió vacía o mal porque el script escribió los props sin pasarlos por `parseProps`, así que los defaults (anchos, vueltas, el `text` de las líneas) no existían; el agente nunca pasa por ahí porque `add_graphic` valida siempre. Se corrigió el script y se repitieron.

## Lo que queda para las fases siguientes

- **Paleta y caras por pack** (Fase 5): casi todas las diferencias restantes son de color (cian de Prime, verde de Lift, rosa de Pop) o de fuente (script de pincel para Prime, título bicolor de Stack), no de movimiento.
- **Velocidad del typewriter**: Lens teclea a ~125 ms por letra y Align/Paper II a ~30 ms; hoy es una sola cadencia. Un knob `speed` en `reveal` cuando un pack lo pida.
- **Decoración escalonada** (stickers que llegan uno tras otro) y el **lienzo de cuadrícula** de Pop: Fase 4.

## Archivos

- `src/motion.ts` (`revealText`, `scrambleChar`, `lifeFx`, llegadas `band` / `slideDown` / `wipe`), `src/Graphics.tsx` (`Letters`, `One`, cinco componentes), `src/graphicTemplates.ts` (plantillas, `reveal` / `out` / `life` / `camera`), `src/MultiClipVideo.tsx` (zoom con título), `src/captionPresets.ts` (`titles`), `mcp/server.mjs`, `test/motion.test.mjs`, `test/graphics.test.mjs`.
- Hojas: `.captions-tmp/motion-v3/cmp-p3-*.jpg`.
