# Motion, fases 0 y 1: reporte del 2026-09-24 (tarde)

Objetivo: ejecutar las fases 0 y 1 del plan `docs/superpowers/plans/2026-09-24-captions-ai-motion.md`: que el agente pueda ver el movimiento, y que Prism Pro (y las cajas karaoke de Focus, Lift y Stack) se muevan como en los previews de Captions.ai. Siete commits locales en `main`, sin push. Cada primitiva se comparó frame a frame contra el preview con `scripts/motion-compare.mjs` (arriba el preview, abajo nosotros); las hojas están en `.captions-tmp/motion-v1/`.

## Fase 0 — ver el movimiento (`d46eeed`, `90d8155`)

- `src/motion.ts`: llegadas (`cut`, `fade`, `ghost`, `blur`, `rgb`, `pop`, `drop`, `slideBlur`), salidas (`cut`, `fade`, `blur`, `letters`, `slideUp`, `slideDown`), `boxTravel` y `cardLanding`, con los tiempos medidos en el catálogo. 7 tests.
- `motion_proof` (MCP): 24 frames consecutivos desde un tiempo, 8 por fila. Tarda ~30 s la primera vez (bundle) y ~10 s después.
- `scripts/motion-compare.mjs`: la tira del preview sobre la nuestra, en una imagen.

## Fase 1 — Prism Pro al 100 % (`56a55ce`, `2d6141e`, `c2206b3`, `16f9673`)

| Primitiva | Preview | Nosotros | Estado |
|---|---|---|---|
| Palabra clave: fantasma + brillo | opacidad 0.4→1 en 6 f, brillo que barre el degradado, sin escala | igual; el brillo es una banda clara que recorre la palabra en 250 ms | ✓ `cmp-prism-ghost.jpg` |
| Degradado por página | cada clave muestra otro tramo (dorado / plata / teal) | rampa larga con fase distinta por palabra (`background-clip: text` del contenedor no atraviesa los `inline-block`, así que se emula por palabra) | ✓ |
| Salida de página | corte seco | `pageOut: cut` en prism, focus, stack, evo, prime, orbit, impact | ✓ |
| Caja karaoke que se desliza (Focus) | 2 f de viaje, blanca en la clave | 80 ms, medida desde el DOM tras cada render (una re-medición cuando carga la fuente) | ✓ `cmp-focus-box.jpg` |
| Caja que salta (Lift, Stack) | fundido 2 f, se apaga a los 0.3 s | igual | ✓ `cmp-lift-box.jpg` |
| Whip diagonal | 4 f de smear de salida + 6 f de entrada desde 1.3× | 5 + 8 f a 30 fps, estirado a 60° + blur suave; el smear no es tan direccional como el del preview | ≈ `cmp-prism-whip.jpg`, `whip-stills.jpg` |
| Apertura | zoom blur radial 5 f | blur 24 px + zoom 1.1 que se resuelven en ~200 ms (gaussiano, no radial) | ≈ `cmp-prism-open.jpg` |
| Tarjeta de B-roll | sube rápido, deriva 700 ms, sale acelerando; fondo desenfocado | `mode: card`: 70 % en 330 ms, deriva 700 ms, sale en 500 ms; el metraje se desenfoca | ✓ `cmp-prism-card.jpg`, `card-stills.jpg` |

Lo que cambió para el agente: `add_broll mode: card`, `set_transitions whipDiag`, `motion_proof` en el paso de verificación de `reel-edit`; `reel-plan` dice cuándo usarlos. Nada nuevo que decidir: el pack ya trae las llegadas, la salida, la apertura y el focus pull.

Lo que sigue siendo aproximado: el smear del whip es un estirado + blur, no un motion blur real a lo largo del ángulo (tres copias desplazadas lo darían a costa de decodificar el vídeo tres veces en esos frames); la apertura es gaussiana, no radial; los captions no bajan bajo la tarjeta como en el preview (posición de captions con tarjeta: fase 4).

## Corrida 10 (paridad, Claude, es-MX)

Mismo clip y brief que la corrida 9 (`pruebaeditoria`, cubrir el negro de 7 a 40 s, captions Prism Pro, gancho, etiquetas, dato, ubicación, música, cierre con CTA sin handle, render final). Proyecto `p-1790277613891`.

| Métrica | Corrida 9 | Corrida 10 |
|---|---|---|
| Duración final | 48.3 s | 48.3 s |
| Pack / héroes / claves | prism / 2 / 15 | prism / 3 ("cava", "Sky", "54") / 11 |
| B-roll | 2 propios + 3 stock | 2 propios + 4 stock, todos `fullscreen` (el negro no admite tarjeta) |
| Gráficos | 8 | 7 (hook-stack, 3 label-2tone, stat, location-tag, end-card) |
| Rechazos / errores / avisos | 0 / 0 / 0 | 0 / 0 / 0 |
| Turnos, minutos, costo | 55, 11.8, $1.31 | 65, 13.8, $1.94 |
| Render final con QC | pasó, −15 LUFS | pasó, −14.4 LUFS |

Lo que la corrida ejercitó de la Fase 1: la apertura con zoom blur (frames 0–6 del render), la llegada fantasma + brillo de "cava", "Sky" y "54" con el focus pull detrás, las salidas por corte y las claves en tramos distintos del degradado (`.captions-tmp/frames-run10/strips.jpg`). Lo que no ejercitó, y por qué: `whipDiag` necesita un corte entre clips y el material es una sola toma continua sin retomas; `mode: card` va sobre la presentadora y aquí el B-roll cubre negro; `motion_proof` no lo llamó aunque la skill ya lo pide (0 llamadas). El agente inventó "piso 12" en la etiqueta del sky bar y lo declaró él mismo; conviene una regla en la skill: nada de datos que no estén en el brief o en el transcript.

Archivos: render `public/exports/edited-1790278229007.mp4` (copia a 540p adjunta), frames `.captions-tmp/frames-run10/grid.jpg`, log `.captions-tmp/agent-run10.jsonl`, métricas `.captions-tmp/run10-metrics.json`.

## Qué sigue

Fase 2 del plan (transiciones: flash, spin, blur+RGB, franjas, polígonos, reloj, mosaico, partículas) y Fase 3 (revelados y salidas de títulos, trazos dibujados), que son las que hacen que Lift, Focus, Stack, Prime e Impact se vean como sus previews más allá de los captions.
