# reel-agent — plan

Editor de reels open source cuyo cerebro es **Claude Code o Codex** (lo elige el usuario). El agente decide *qué* hacer (cortes, énfasis, B-roll, look, titulares); código determinista decide *dónde y cuándo* en milisegundos y renderiza. Cuatro problemas: **recorte**, **color grade**, **captions premium** y **B-roll** (propio, stock y motion graphics).

Actualizado: 2026-09-24. Evidencia en `research/`.

## 1. Decisiones tomadas

| Tema | Decisión | Consecuencia |
|---|---|---|
| Licencia | **Apache-2.0**, open source, sin venta comercial | Solo se copia código MIT/Apache (con atribución en `NOTICE`). MPL archivo por archivo. De AGPL, PolyForm y repos sin licencia, solo ideas. Todo asset empaquetado debe ser redistribuible |
| Base | Fork de `andriidrok1/autobroll@9122e89` (MIT) | Elegido por su estructura (MCP, modelo anclado, tamaño), no por lo que producía. Remotion como único motor por ahora; HyperFrames queda como opción si la comparativa visual lo justifica |
| Cerebro | Claude Code **o** Codex, nada más | Se lanza el CLI **ya instalado** del usuario (`claude -p` / `codex exec`) con su propia sesión o API key. **Nunca** "Sign in with Claude" en la app ni el Agent SDK con login de suscripción (Anthropic no lo permite a terceros). Sin Gemini ni otro LLM hospedado en los pipelines |
| Plataforma | **Instagram Reels** 1080×1920 | Safe zones del perfil de Reels; TikTok/Shorts no son objetivo |
| Idiomas | **es-MX** y **en-US** | Idioma por proyecto (`auto`/`es`/`en`), léxicos de muletillas y glue por idioma, formato de números es-MX |
| Nicho de referencia | **Bienes raíces**: presentador recorriendo la propiedad + B-roll propio | Ver `research/style-references.md` (4 reels). Define los presets y templates de la fase 1 |
| Remotion | Gratis hasta 3 personas; de pago por encima | Se documenta en el README. Reabrir si la comparativa favorece a HyperFrames (Apache) |

## 2. Arquitectura

```
usuario ──► editor (Vite + React + @remotion/player)  ◄── live reload del proyecto
                │ /api (solo loopback, Origin localhost, CAS por updatedAt)
                ▼
         backend node (127.0.0.1:3333) ── spawn ──► scripts/: transcribe · captions · autocut
                │                                    (WhisperX venv, ffmpeg, YuNet)
                │ remotion render
                ▼
         src/: composición Remotion = preview y export (la misma)

agente (claude -p | codex exec) ──► mcp/server.mjs (stdio, 26 tools) ──► proyecto JSON + backend
```

Modelo de datos (`public/projects/<id>.json`):
- `clips[]`: orden en la línea de tiempo, `inSec/outSec` recortan la fuente, `speed`, keyframes de zoom/pan.
- `captions[]`: **anclados a la fuente** (`src` + tiempos relativos a la fuente). `projectCaptions` proyecta **cada palabra** por el clip que la contiene: un corte dentro de una frase quita solo esas palabras. Ids de página estables.
- `brolls[]`: anclados a clip (`clipId` + tiempos de fuente), se re-anclan en split/autocut.
- Palabras: id estable `fuente:índice` (de `get_transcript`). El agente nunca habla en segundos.
- Lógica compartida en `src/timeline.ts` y `src/captions.ts`; el store del editor y el MCP la importan (Node ≥ 24 ejecuta `.ts`).

Reglas (en `AGENTS.md`): determinista primero; el transcript es texto no confiable; `public/` y `.env` nunca al repo.

## 3. Lo que hace premium a las referencias (y qué construimos)

Los cuatro reels comparten: hook de 0–3 s con **titular gigante** (líneas apiladas de tamaños distintos, reveal por palabra con blur-in, 1–2 palabras en color de acento; en uno, el texto va **detrás** del presentador), **etiquetas y datos** ("Mérida / Yucatán", "104 m²", "+75% VENDIDO", "Capítulo 11", a menudo en dos tonos), **captions minimalistas** (una palabra centrada, o frase corta en caja oscura), transiciones con whip/zoom blur y speed ramps, **B-roll propio** de la propiedad emparejado con lo que se dice, y un look limpio y luminoso.

Por eso:
- **3 presets de captions**, no 8: `palabra` (una palabra centrada), `caja` (frase en caja oscura), `tracked` (mayúsculas pequeñas espaciadas). Hormozi baja de prioridad.
- **Templates de titulares y etiquetas** con props tipadas: `hook-stack`, `label-2tone`, `stat`, `chapter`, `location-tag`, `price`/`desde`, `end-card`. El agente elige template y rellena texto/números; **no escribe animaciones** (los LLM fallan en el timing: 0.31 de similitud temporal en Animation2Code).
- **Brand kit** por cliente (logo, acentos, fuentes) que leen todos los templates.
- **B-roll de la biblioteca del usuario**, etiquetada por el agente mirando contact sheets; Pexels solo de respaldo.
- **Transiciones**: whip blur, zoom blur, speed ramp, split 2×2, card zoom-out, punch-in.
- **Texto detrás de la persona**: matte con MediaPipe/BiRefNet/SAM 2 (licencias limpias; RVM es GPL).
- **Look por defecto "real estate limpio"**; el material de prueba sale plano y lavado.

## 4. Stack por trabajo

| Trabajo | Stack | Estado |
|---|---|---|
| Transcripción | WhisperX `medium`, `--language` por proyecto, prompt por idioma que conserva muletillas, caché por fuente+idioma | Hecho. En CPU tarda ~3.5 min por 48 s: evaluar whisper.cpp (Metal) / parakeet-mlx |
| Corte | 1) silencios (`trim-silence`), 2) candidatos de muletilla/retoma/off-mic/meta (`src/cuts.ts`), 3) snap del corte a la pausa, 4) el agente aprueba por `wordId`, 5) `cut_words ranges` | Hecho |
| Color | HLG/PQ → SDR en el ingest (LUT generado, `src/hdr.ts`) → corrección automática acotada por fuente → look del catálogo con intensidad; aplicado en render como filtro SVG. El agente elige el look (`set_grade`) y verifica con `caption_proof` | Hecho (falta clip HDR real) |
| Captions | Datos: página `{src, words[{text,start,end,tier,emoji?,sfx?}], preset, topPct}`. Render en Remotion con animaciones `f(frame)`, fuentes OFL empaquetadas, emoji Noto/Fluent, SFX CC0. Paginado, timing, safe zone y validación en código; el agente emite tiers/emoji/SFX/breaks | Base hecha (Inter empaquetada, cara local, glue ES). Presets: fase 1 |
| B-roll propio | El agente etiqueta cada asset (`frame_at` / contact sheet) y lo empareja con menciones del transcript; reglas de los editores expertos: arranca a ±1 s de la palabra, 0.5–8 s, ~9 s entre inserts, nunca sobre el hook ni el remate | Fase 3 |
| B-roll stock | Pexels (`search_stock`, portrait), descarga solo desde pexels.com, atribución en UI. Sin índices ni copias masivas (términos) | Hecho como respaldo |
| Motion graphics | Registry tipado (zod) de templates 9:16 en Remotion; `add_graphic({template, props, anchorWordId})`; zoom punches por keyframes | Fase 1 (titulares) y 3 (resto) |
| Audio | Ducking; loudnorm dos pasadas a −14 LUFS / −1 dBTP y gate de QC en cada render final (hecho); limpieza opcional (DeepFilterNet o `arnndn`) y SFX a −12 dB de la voz pendientes | Parcial |
| Render | Remotion 4.0.380 vía backend. Línea base: 48 s con 31 captions = 60 s draft / 65 s final en M-series | Hecho |
| Harness | Un MCP para los dos cerebros. `AGENTS.md` (+ `CLAUDE.md` = `@AGENTS.md`), skills en `.agents/skills` con symlink a `.claude/skills`. Runner: `claude -p --allowedTools mcp__reel__* --strict-mcp-config --permission-mode dontAsk` / `codex exec --json --sandbox read-only` (patrón `providers.js` de vibetube, MIT). Sin shell para el agente headless | MCP y AGENTS hechos; runner fase 3 |
| Verificación | Automática (ffprobe, silencios, negro, safe zones, contraste) → preview 540×960 → contact sheet que el agente mira (`Read` en Claude, `view_image` en Codex), máximo 2–3 rondas | Fase 1 (captions) y 3 (completa) |

## 4b. Los 20 estilos de Captions.ai

El usuario quiere poder **imitar cada uno de los 20 estilos** de AI Edit de Captions.ai. Análisis completo en `research/captions-ai-styles.md`. Conclusión: casi todos se construyen con el mismo vocabulario: captions que se van construyendo palabra a palabra (build-up), 1–2 palabras con tratamiento de énfasis (bold/itálica/otra fuente/color/píldora/bloque), un título grande al inicio, layouts de tarjeta/split, transiciones con blur y una paleta fija. Lo que los diferencia son fuentes, contenedores, marcos, texturas y stickers.

Eso reordena las fases: la **fase 1** incluye captions v2 (build-up, karaoke, tratamientos de énfasis, contenedores, catálogo de fuentes OFL) y los primeros **style packs** (Prism Pro, Focus, Stack, Lift, Orbit, Impact II: solo tipografía y bloques de color); la **fase 2** suma layouts/marcos y transiciones; la **fase 3** suma matte de la persona, una herramienta de assets para el agente (búsqueda de stickers/iconos/texturas en una API con licencia clara + generación de PNGs con la API de imágenes de OpenAI + animación de PNGs por transformaciones; nada dibujado a mano ni modelos de SVG) y los estilos que dependen de ella (Paper II, Pop, Chalk, Sketch, Y2K, Lens, Align, Prime). Investigación: `research/asset-sourcing.md`.

## 5. Fases

### Fase 0 — base (hecha salvo spikes)

Hecho:
- Repo Apache-2.0, `NOTICE`, `AGENTS.md`, `.mcp.json` (`reel`), renombrado y `REEL_*`.
- Gemini eliminado: arrange, acentos y B-roll pasan al agente (`get_transcript`, `reorder_clips`, `delete_clips`, `edit_caption`, `search_stock`, `add_broll`).
- Idioma por proyecto; cara local (YuNet, 3 frames por fuente); Inter empaquetada.
- Captions por palabra ancladas a la fuente; `split`/`autocut`/`reanchor`/`mergeCaptions` compartidos; tests (`npm test`); `tsc` cubre `editor/`.
- CAS por `updatedAt` (409); backend solo loopback + `Origin`; descargas solo pexels.com.
- Verificado con `pruebaeditoria.mp4` (es-MX): transcripción correcta, 31 páginas, cara al 57 %, corte a mitad de frase correcto en el render.

Spikes pendientes (cada uno con informe go/no-go):
1. **Paridad de Codex**: `codex exec --sandbox read-only` + MCP: escribir proyecto, render, imagen de `frame_at`, shell bloqueado. Alternativa: `codex app-server` + `dynamicTools`. *Requiere instalar Codex en la máquina.*
2. **Comparativa visual de captions**: renderizar el mismo clip de 10 s con tscaps, una receta de open-edit, pycaps `hype` y los kits nativos de Remotion (`remotion-captions-kit`, `remotion-captioneer`, `remotion-captions-themes`, `captioncat`); ver los previews de HyperFrames; comparar contra un export de Captions.ai/Submagic. *Requiere ese export.* Decide qué presets se portan y si HyperFrames entra.
3. **Muletillas en español**: 3 clips reales, % de "eh/este/mmm" que WhisperX conserva vs conteo manual; plan B = energía de voz sin palabra alineada en huecos < 600 ms.
4. **Benchmark de render**: línea base tomada; medir de nuevo con bold-pop + blur/glow y fijar el ratio máximo aceptable.

### Fase 1 — captions premium + titulares + style packs (≈ 3–4 semanas, camino crítico)

Hecho hasta ahora: captions v2 (build-up, karaoke, tratamientos de énfasis, contenedores, posición flotante, catálogo de 13 fuentes OFL), 9 presets (`palabra`, `caja`, `tracked` + packs `prism`, `focus`, `stack`, `lift`, `orbit`, `impact`), tiers por palabra con ids estables, pager compartido, `set_caption_style`, `annotate_captions`; track de gráficos con `hook-stack`, `label-2tone`, `stat`, `chapter`, `big-word` (+ word wall), `kinetic-card`, `fill-title`, `script-title`, `sticker` y `add_graphic`/`edit_graphic`/`delete_graphics`; herramienta de assets (`search_asset` Iconify/Fluent 3D/Openverse, `generate_asset` OpenAI Images, librería local con `list_assets`); layouts (`layout`: marco redondeado/arco/círculo/phone sobre lienzo, split con B-roll); **matte de la persona** (MediaPipe selfie segmenter, ~30 fps en CPU, WebM VP9 con alfa) con gráficos `behind=true` y `prepare_mattes`, adelantado desde la fase 3; selector de estilo y tiers en el editor; **brand kit** por proyecto (`set_brand`: acento/oscuro/claro, fuente de titulares y de captions del catálogo OFL, logo; kits reutilizables en `public/brands/`; captions, templates y lienzos lo leen); **captions detrás de la persona** (`edit_caption behind`) y **emoji por palabra** (`annotate_captions emoji`, Noto Color Emoji OFL, también en el Inspector con clic derecho); templates `oversized`, `chapter-caps`, `starburst`, `location-tag`, `price`; texto que se encoge para caber en el cuadro; slots flotantes debajo de la franja superior de Reels; `validate` (safe zones, glue, timing, densidad de énfasis, solapes, mattes faltantes, hook) y `caption_proof` (contact sheet de stills en ~4–9 s para que el agente se revise); skill `reel-edit` con el flujo completo para Claude Code y Codex.

Entregables:
- Modelo de datos: `tier` (0–3), `emoji`, `sfx`, `brk`, `preset` por página; migración de `accent` → `tier: 1`.
- Paginado en módulo compartido (`src/`), usado por el pipeline y por `annotate_captions` (re-paginar sin perder anotaciones, por `wordId`).
- Captions v2: `reveal: 'build'` (las palabras aparecen y se quedan), karaoke (`upcoming: dim`), tratamientos de énfasis por tier (`weight`, `italic`, `font`, `color`, `scale`, `pill`, `block`, `underline`), contenedores de página (`none`/`pill`/`bar`/`glass`), posición flotante, catálogo de fuentes OFL (geométricas, condensadas, serif, script, manuscrita, mono, wide).
- Style packs = preset + templates + paleta: primero Prism Pro, Focus, Stack, Lift, Orbit, Impact II.
- Templates de título: `oversized`, `chapter-caps`, `starburst` hechos.
- Templates de titulares/etiquetas: `hook-stack`, `label-2tone`, `stat`, `chapter`, `location-tag`, `price`; track `graphics[]` anclado a fuente/palabra (`projectGraphics` clonado de `projectBrolls`).
- Brand kit: hecho (`brand` en el proyecto, kits en `public/brands/<slug>.json`, `set_brand`).
- Herramientas MCP: `annotate_captions`, `set_caption_style`, `add_graphic`, `edit_graphic`, `delete_graphics`, `caption_proof`.
- Validador: hecho salvo contraste real (las safe zones siguen siendo estimadas hasta tener capturas de Reels).
- `caption_proof`: hecho.
- UI mínima de pulido: preset, tier y emoji por palabra en el Inspector (hecho).

Criterios de aceptación:
- Tests del validador y del paginado pasan.
- Clip de 10 s en ES y en EN renderizado con los 3 presets: bounding box dentro de la safe zone en el 100 % de los stills, contraste OK, sin páginas en glue.
- Una sesión de Claude Code (y de Codex si el spike pasó) anota un reel de 60 s con ≤ 2 rondas del validador.
- Render del reel de 48 s ≤ 2× la línea base (130 s).
- **Gate subjetivo**: comparación a ciegas contra el export de Captions.ai/Submagic; si pierde claramente, se itera antes de pasar de fase.

### Fase 2 — corte, color y audio (≈ 1.5 semanas)

Hecho (2026-09-24): `find_cut_candidates` (retomas por similitud LCS con la última toma completa como la que se queda, líneas off-mic, meta-habla, muletillas ES/EN) + `cut_words ranges` en una llamada, con snap a las pausas y descarte de trozos mudos; loudnorm de dos pasadas en el render final y gate `qc` (−14 ±1 LUFS, ≤ −1 dBTP, tamaño, duración, audio; avisos de silencio y negro); color con corrección automática acotada por fuente + looks (`clean` = real estate limpio, `warm`, `crisp`, `moody`, `mono`) aplicados en render como filtro SVG (`set_grade`); tonemap HLG/PQ → SDR en el ingest con un LUT generado en código (ffmpeg sin zscale). Pendiente: probar con un clip HDR real de iPhone, limpieza de voz opcional, medir recall de muletillas en 5 clips anotados a mano.

Entregables:
- Candidatos de muletilla y retoma (ES/EN) + `find_cut_candidates` (el agente aprueba por `wordId`); snap del corte a huecos de audio; aplicación como `split`/`trim`.
- Ingest de color: tonemap HDR, auto-grade acotado, catálogo de looks (empezando por "real estate limpio"), `set_grade`; comparar bake en ingest vs LUT en tiempo de render sobre un clip HDR.
- Loudnorm de dos pasadas, limpieza de voz opcional (A/B en 3 grabaciones de teléfono), herramienta `qc` como gate del render final.

Criterios:
- Sobre 5 clips reales con retomas y muletillas anotadas a mano: ≥ 80 % de retomas detectadas como candidato, 0 cortes a mitad de palabra (verificado re-transcribiendo cada corte), recall de muletillas medido.
- Tras los cortes, captions y B-roll siguen en su sitio (tests).
- Clip HDR de iPhone no sale lavado; `pruebaeditoria.mp4` sale con el look elegido.
- Final a −14 LUFS ±1, true peak ≤ −1 dBTP; un render que falla el QC queda bloqueado.

### Fase 3 — B-roll propio, transiciones y los dos cerebros (≈ 2–3 semanas)

Entregables:
- Biblioteca de assets: etiquetado por el agente (contact sheet), matching con el transcript, reglas de colocación; Pexels de respaldo.
- Transiciones (whip blur, zoom blur, speed ramp, split 2×2, card zoom-out, punch-in) y golpes de SFX.
- Texto detrás del presentador: hecho en fase 1 (`behind=true` + `prepare_mattes`); falta el contorno dibujado (Chalk) y captions detrás.
- `end-card` y publicación del brand kit.
- Runner headless con selector de cerebro; registro del MCP en `~/.claude.json` y en el `config.toml` de Codex; skills para ambos.
- Crítica visual completa (contact sheet del render) con ≤ 3 rondas.

Criterios:
- Un solo comando produce un reel completo (corte, color, captions, ≥ 3 gráficos, B-roll propio, música) desde el crudo + biblioteca + brand kit, con cada cerebro, en el estilo de `research/style-references.md`.
- 0 solapes caption/gráfico; todos los templates dentro de la safe zone.
- Un test demuestra que el runner headless no puede usar shell ni escribir fuera del MCP.
- `pruebaeditoria.mp4`: el tramo negro 7.2–40.1 s (intencional) queda cubierto por B-roll y etiquetas.

### Fase 4+ — solo si hace falta

Etiquetas ancladas en 3D a la pared (tracking planar), sidecar de HyperFrames (render con alfa) tras revisar GSAP, TSX escrito por el LLM compilado en sandbox, ranking de stock con CLIP, face tracking por segundo, importación de templates de tscaps, palabra "hero" con matte.

## 6. Riesgos

1. **Captions y titulares dependen del gusto.** No hay librería open source lista; el gate subjetivo de la fase 1 manda.
2. **No existe una librería 9:16 de motion graphics profesional.** Semanas de diseño de templates; el demo inicial tendrá pocos.
3. **Muletillas en español.** WhisperX suele omitirlas; sin el spike 3, el corte por léxico puede no ver nada.
4. **Paridad de Codex sin verificar.** Codex no tiene equivalente a `--tools ""`; solo sandbox.
5. **Velocidad de WhisperX en Mac** (3.5 min por 48 s). Hay alternativas con Metal.
6. **Licencia de Remotion** para quien lo use en empresas > 3 personas; Remotion 5.0 endurece términos.
7. **Contaminación de licencias**: nada de OpenMontage, openchatcut (AGPL), studio de tscaps, video-editor-agent (sin licencia), binario de VEED, fuentes comerciales (Komika, The Bold Font, TT Norms), emoji de Apple, SFX de AIEV/pycaps.
8. **Bus factor 1** heredado; tests y CI se van añadiendo con cada fase.

## 7. Preguntas abiertas

- **Voz fuera de micrófono (directora dictando líneas).** Hoy se detecta por volumen (`src/speech.ts`: las tomas se separan en dos grupos de nivel; cuenta como segunda voz si quedan ≥ 6 dB por debajo y suman ≥ 15 % del habla) y por proyecto se marca, corta o ignora. Falla cuando la presentadora habla bajito (IMG_1778 a 122 s). La señal que lo rescataría es la boca (MediaPipe FaceLandmarker, jawOpen), pero mediapipe 1.0.1 revienta en macOS con `graph_service.h:139 Check failed: service_ Service is unavailable` en todos los modos; probar mediapipe 0.10.x en un venv aparte o esperar el fix. Diarización pyannote (viene con whisperx) es la otra vía, pero pide token de HF y aceptar modelos gated.
1. ¿HyperFrames/GSAP como sidecar opcional más adelante, o solo Remotion? (Se decide tras la comparativa visual.)
2. Capturas de un borrador gris en Reels para calibrar las safe zones reales.
3. Export de `pruebaeditoria.mp4` desde Captions.ai o Submagic, como referencia de la comparativa.
4. Instalar Codex (`npm i -g @openai/codex`, `codex login`) para el spike 1.
5. Cerrar el túnel de Cloudflare del clon local de autobroll, si sigue abierto.

## 8. Notas de la máquina de desarrollo

- Node 24, ffmpeg 8 (Homebrew, sin `drawtext`, `subtitles`/libass, `zscale` ni `libplacebo`), Python 3.12 en `.venv` (symlink al venv de autobroll), OpenCV 5 headless, YuNet en `.models/`.
- `pruebaeditoria.mp4`: 1080×1920, 29.97 fps, SDR bt709, 48.5 s, imagen plana; negro intencional de 7.2 a 40.1 s; audio con pico a 0 dB.
