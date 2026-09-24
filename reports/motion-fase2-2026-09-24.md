# Motion, fase 2 (transiciones): reporte del 2026-09-24 (tarde)

Objetivo: el paquete de transiciones del plan `docs/superpowers/plans/2026-09-24-captions-ai-motion.md` (Fase 2): las 15 formas de cambiar de toma que usan los previews de Captions.ai, como funciones puras de frame en `src/transitions.ts`, con test y comparación frame a frame contra su preview (`scripts/motion-compare.mjs`; arriba el preview, abajo nosotros; hojas en `.captions-tmp/motion-v2/`). Commits locales en `main`, sin push.

## Cómo está construido

- **Una sola geometría**: recorte de polígonos por semiplano en % del cuadro (`clipPoly`), `clip-path` CSS para máscaras y formas, ruido determinista sembrado por id de clip (`seedOf`) para que preview y render pinten el mismo frame. Sin dependencias nuevas, sin decodificar el vídeo más de una vez.
- **Tres familias**: *cover* (formas que se dibujan sobre el corte, encima del metraje y del B-roll, debajo de gráficos y captions): flash, spin, rgbFlash, bands, clock, mosaic, disc, blinds, lightLeak y la banda de polyWipe; *reveal* (el clip saliente se enmascara sobre el entrante, que arranca antes por debajo): crossBlur, polyWipe, diagWipe, particles, blocks, además de card y split; *over*: cardDrop, el entrante cae encima girando.
- **Duración por transición** medida en el catálogo (`DUR_MS`), centrada en el corte; los captions siguen encima durante toda la transición, como en los previews.
- Los packs de captions declaran además el punch de 1.12× sobre la palabra héroe y el pulso blur + RGB en cada clave (Impact II).
- El agente: `set_transitions` describe cada tipo y la familia de cada pack; `reel-edit` y `reel-plan` piden quedarse en una familia por reel.

## Gate frame a frame (preview arriba, nosotros abajo)

| Transición | Estilo | Lo que coincide | Lo que difiere |
|---|---|---|---|
| flash | Stack | 2 frames a blanco + fade, captions encima del blanco | — |
| crossBlur | Prime | ambos clips se desenfocan y funden en ~5 f | — |
| spin | Prime | giro + blur + flash blanco en el centro | el remolino radial del preview es más fuerte; el nuestro es giro de 14° + blur + escala 1.1 |
| rgbFlash | Impact II | blur + separación RGB + frame blanco + enfoque | — |
| bands | Focus | tres franjas apiladas (acento, oscuro, marino) que barren 16 f | — |
| polyWipe | Lift | banda de acento diagonal desde abajo-derecha y el entrante descubierto detrás en ~7 f | la banda del preview es más ancha y facetada (`cmp-p2b-polyWipe.jpg`) |
| clock | Y2K | pastel claro que cubre en sentido horario y luego descubre | — |
| mosaic | Y2K | cuadrados 6×11 que crecen y encogen con retardo | — |
| disc | Orbit | disco desde una esquina que cubre, aguanta y se retira | — |
| blinds | Form | cinco barras de acento que cierran, aguantan y abren | el smear horizontal al abrir es sutil |
| particles | Form | frontera dentada que come el clip de izq. a der. en ~4 f | sin polvo real: es una máscara con borde ruidoso (`cmp-p2b-particles.jpg`) |
| diagWipe | Linen | borde a ~20° que baja descubriendo el entrante | sin el lavado a crema del saliente (`cmp-p2b-diagWipe.jpg`) |
| blocks | Vista | el entrante sube con borde escalonado que se redibuja cada 2–3 f | los escalones del preview son más regulares (`cmp-p2b-blocks.jpg`) |
| cardDrop | Pop | el entrante cae girando −15°→0 sobre el saliente | sin lienzo de cuadrícula debajo (Fase 4), el saliente solo se oscurece |
| lightLeak | Lens | mancha cálida + rosa en `screen`, pico en el frame central | gradientes, no textura fotográfica |
| punch + pulso | Impact II | 1.12× en la palabra héroe, blur + RGB en cada clave | — |

`tear` (papel de periódico, Paper II) queda pendiente: necesita dos texturas de papel con licencia de la librería de assets (`search_asset` / `generate_asset`), Fase 4.

## Archivos

- `src/transitions.ts` (núcleo puro, 15 tipos), `src/ClipMedia.tsx` (giro, RGB, caída, salidas fade / shrink / mask), `src/MultiClipVideo.tsx` (`TransitionOverlay`, pre-rolls de reveal y over, punch y pulso), `src/captionPresets.ts` (`heroPunch`, `glitchPulse`), `src/captions.ts` (`tierSpans`), `test/transitions.test.mjs`.
- Hojas: `.captions-tmp/motion-v2/cmp-p2-*.jpg` (misma toma a ambos lados del corte) y `cmp-p2b-*.jpg` (el entrante a 1.6× para ver los reveals).
