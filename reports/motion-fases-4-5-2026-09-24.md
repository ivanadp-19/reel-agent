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

GATE_RESULT

## Archivos

- `src/motion.ts`, `src/Broll.tsx`, `src/brollModel.ts`, `src/Graphics.tsx`, `src/graphicTemplates.ts`, `src/Person.tsx`, `src/MultiClipVideo.tsx`, `src/captionPresets.ts`, `src/stylePacks.ts`, `src/brand.ts`, `src/fonts.ts`, `mcp/server.mjs`, `scripts/motion-gate.mjs`, tests en `test/motion.test.mjs`, `test/graphics.test.mjs`, `test/captions.test.mjs`.
