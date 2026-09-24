# Motion, fases 4 y 5 (layouts, B-roll, decoración y los 20 style packs): reporte del 2026-09-24 (noche)

Objetivo: cerrar el plan `docs/superpowers/plans/2026-09-24-captions-ai-motion.md`. Fase 4: cómo entran y salen los layouts y los cues de B-roll, el carrusel, las ventanas con estela, el recorte sobre lienzo, los stickers que se desdoblan y el contorno de la persona. Fase 5: un *style pack* por estilo de Captions.ai, que junta captions, paleta, caras, familia de transición, movimiento del B-roll y marco, y un gate por pack para el veredicto subjetivo. Commits locales en `main`, sin push; hojas en `.captions-tmp/motion-v4/` (Fase 4) y `.captions-tmp/motion-gate/` (Fase 5).

## Fase 4 — qué se construyó

- **Layouts** (`add_graphic template=layout`): `enter` (`frameIn` 300 ms Evo/Stack, `tile` 330 ms Align, `capsule` Bloom, `inset` Align, `slide` Y2K) con su salida propia; `shape: window` dibuja el cromo de Mac OS clásico y, entrando con `slide`, deja cuatro copias que se recogen en 333 ms; `canvas: grid` (papel cuadriculado, Pop) y `paper` (crema, Chalk); `cutout` funde el metraje en 2 f para que el lienzo se vea detrás de la persona recortada (Stack), y vuelve en 4 f.
- **B-roll** (`add_broll` / `edit_broll`): `arrive` (`slideUp` con ease-out fuerte, `popFrom` desde un punto en 11 f, `slideRight`) y `leave` (`slideDown` con motion blur en 5 f, `shrink` a 0 en 9 f, `fall`); el pack pone los suyos cuando el cue no dice. `mode: carousel` es el de Prime: el panel central funde en 3 f, los laterales se expanden en 4–5 f con perspectiva, y cada 2.4 s el conjunto avanza un panel en 2 frames con smear horizontal.
- **Decoración**: `sticker anim: unfold` (bolita arrugada junto a la cabeza que viaja, gira y se desdobla en 10–12 f; se pliega al salir), `ornament` (✳ y compañía, estático), `rules` (líneas finas de margen), `person-outline` (ocho `drop-shadow` desplazados bajo el matte, con *boil* determinista por frame; cuenta como span de matte).

| Movimiento | Estilo | Coincide | Difiere |
|---|---|---|---|
| B-roll slideUp + slideDown | Elevate | sube desde abajo con ease-out fuerte, baja con blur | — (`cmp-p4-slideUp.jpg`) |
| B-roll popFrom + shrink | Evo | escala desde un punto en 11 f, se encoge a 0 | el preview lleva borde azul claro y esquinas: `layout border` (`cmp-p4-popFrom.jpg`) |
| carousel | Prime | central por fade, laterales en perspectiva, paso con smear | — (`cmp-p4-carousel.jpg`) |
| layout frameIn | Evo | el vídeo se encoge al marco redondeado en 8–9 f | — (`cmp-p4-frameIn.jpg`) |
| layout window + slide | Y2K | ventana Mac clásica que entra desde la derecha con estela | el preview arrastra dos ventanas; la segunda es un cue con `slideRight` (`cmp-p4-window.jpg`) |
| sticker unfold | Paper II | bolita que viaja desde la cabeza y se desdobla | los del preview son recortes de papel: assets (`cmp-p4-unfold.jpg`) |
| layout cutout | Stack | el fondo funde a color detrás de la persona recortada | las letras en marquesina detrás son `oversized` + `life: marquee` + `behind` (`cmp-p4-cutout.jpg`) |
| person-outline | Chalk | contorno que hierve alrededor de la silueta | el trazo del preview es más fino y garabateado; el nuestro es un stroke uniforme (`cmp-p4-outline.jpg`) |

`tear` (papel de periódico) sigue pendiente de una textura con licencia.

## Fase 5 — los 20 style packs

`src/stylePacks.ts`: cada pack lleva su preset de captions (12 nuevos: paper, elevate, sketch, lens, vista, pop, y2k, form, bloom, chalk, linen, align; contenedor cómic para Pop; Pinyon Script para los títulos caligráficos), paleta (acento, oscuro, claro) y caras (display, script) que `resolveBrand` usa cuando no hay brand kit ni acento de proyecto, familia de transición (`set_transitions type: pack`), `arrive`/`leave` del B-roll por defecto, el modo de B-roll que favorece y el marco en el que vive. `set_caption_style` describe los 20; `reel-plan` tiene la tabla brief → pack.

Prioridad de color: brand kit > acento del proyecto (si no es el default) > paleta del pack.

## Gate por pack

`scripts/motion-gate.mjs` restiliza el proyecto de la corrida 9 con cada pack a través del MCP (los captions se re-paginan como lo harían con el agente), le pone el título de firma del estilo, su marco si lo tiene, un corte con su familia y un cue de B-roll a su manera, y pone nuestras tiras bajo las del preview en tres momentos: título, palabra clave y corte.

Los 20 packs rindieron sus tres tiras sin errores (`.captions-tmp/motion-gate/<pack>/{title,key,cut}.jpg`, índice en `.captions-tmp/motion-gate/README.md`). Mi lectura, para que tú decidas sobre las hojas:

| Pack | Lo que ya se ve como el preview | Lo que aún difiere |
|---|---|---|
| prism | claves con brillo, focus pull, tarjeta de B-roll, whip diagonal | el smear del whip es más suave que el del preview |
| focus | banda "FOLLOWERS" que sube y baja, caja azul que se desliza palabra a palabra, franjas | — |
| stack | "TECHNOLOGY" que cae con zoom-out, píldora roja que salta, flash | el título del preview es bicolor; `big-word` es de un color |
| lift | tarjeta "Your Team" con wipe angular, caja menta que salta, polígono | la tarjeta es cutaway completo; en el preview el polígono sólo cubre la franja superior con la persona debajo (un `layout` con canvas parcial: pendiente) |
| evo | marco redondeado sobre degradado, vidrio esmerilado, blur-in por palabra, pop del B-roll | el degradado azul→rosa del preview frente a nuestro azul→blanco |
| prime | marco neón que se dibuja y oscila, "Progress" en script por letras que crece, spin + flash, carrusel | el brillo del script del preview es más intenso |
| orbit | "FRIENDS" que baja con punch de cámara, píldora serif azul con blur-in, disco desde la esquina con círculo y anillo | el anillo del preview es más fino |
| impact | "BALANCE" blanca con blur y punch de cámara, cian condensado con RGB, pulso glitch | — |
| paper | etiquetas typewriter, caja blanca con karaoke gris→negro, partículas | sin papel rasgado ni stickers de papel (assets) |
| elevate | "Momentum" caligráfico por letras con estrella y subtítulo, serif con itálica, crossBlur | la caligráfica del preview es más fina |
| sketch | "MIND MAP" con elipse garabateada, manuscritas palabra a palabra, inset circular | el título del preview se destapa con máscara de rotulador (`markerMask`, no implementada: usa blur-in) |
| lens | inset con visor y HUD sobre azul marino, mono en barra negra, "Aperture" typewriter, light leak | el typewriter del preview es 4× más lento (knob de velocidad pendiente) |
| vista | "REALTY" gigante que baja, serif con fade por palabra, bloques escalonados | falta el skyline al pie (bloques como decoración, no como transición) |
| pop | starburst "PROJECT" como sello, píldoras cómic, marco sobre cuadrícula, cardDrop | sin los stickers alrededor (assets escalonados) |
| y2k | ventana Mac con estela, "Summer" script amarillo, amarillo sans, reloj | el preview arrastra dos ventanas y el collage de móviles (assets) |
| form | "RESULTS" que se desmonta letra a letra, bold itálica en claves, persianas, partículas | las líneas naranjas de margen (`rules`) no se pusieron en el gate |
| bloom | arco con cápsula, "Routine" caligráfico + MOISTURIZE, claves grandes con blur | el arco del preview "respira" (se expande fuera y vuelve): pendiente |
| chalk | "YOUTH" en muro de tiza por letras, amarillo en etiquetas negras, contorno que hierve, papel crema | la tiza del preview tiene textura; la nuestra es una fuente de rotulador |
| linen | "WEAR / your style" serif, caja melocotón, bandas diagonales a 20° | el lavado a crema del saliente |
| align | "COMPUTERS" con tracking, subtítulo por barajado, mono en caja blanca, tiles por escala | — |

Tres cosas que salieron del gate y ya están hechas o anotadas: el gate mismo (`scripts/motion-gate.mjs`) para repetirlo en un minuto por pack cuando cambies algo; la máscara de rotulador de Sketch y el arco que respira de Bloom quedan como los dos únicos movimientos del catálogo sin primitiva propia; y `tear` (Paper II) espera la textura.

## Archivos

- `src/motion.ts`, `src/Broll.tsx`, `src/brollModel.ts`, `src/Graphics.tsx`, `src/graphicTemplates.ts`, `src/Person.tsx`, `src/MultiClipVideo.tsx`, `src/captionPresets.ts`, `src/stylePacks.ts`, `src/brand.ts`, `src/fonts.ts`, `mcp/server.mjs`, `scripts/motion-gate.mjs`, tests en `test/motion.test.mjs`, `test/graphics.test.mjs`, `test/captions.test.mjs`.
