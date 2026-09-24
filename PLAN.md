# reel-agent: plan inicial

Editor de reels open source cuyo cerebro es **Claude Code o Codex** (lo elige el usuario). Tiene que resolver cuatro cosas: **recorte**, **color grade**, **captions premium** (nivel Captions.ai/Submagic) y **B-roll**, tanto stock (Pexels) como **motion graphics de calidad** estilo reels.

## Decisiones ya tomadas (2026-09-23)

| Tema | Decisión | Consecuencia |
|---|---|---|
| Licencia | Open source, **Apache-2.0** | Solo se copia código MIT o Apache (con atribución). MPL, archivo por archivo. De AGPL, de PolyForm y de repos sin licencia, solo ideas |
| Uso comercial | No lo vendemos, pero terceros podrán usarlo | Toda dependencia y asset que se empaquete tiene que ser redistribuible. Remotion es gratis hasta 3 personas; se documenta en el README que las empresas más grandes necesitan su licencia |
| Cerebro | Claude Code **o** Codex | El harness lanza el CLI **ya instalado** del usuario (`claude -p` / `codex exec`), con la sesión que el usuario inició él mismo, o bien con su API key. **Nunca** "Sign in with Claude" en la app, ni el Agent SDK con login de suscripción: Anthropic no lo permite a terceros. Ver `research/harness-claude-codex.md` |
| Base | Fork de `andriidrok1/autobroll` (MIT) dentro de este repo, conservando su aviso MIT y el crédito | Elegido por un panel de 3 jueces entre 18 candidatos evaluados a nivel de código (`research/evaluations.json`, `research/judges.json`). Se eligió por su estructura, no por la calidad de lo que produce hoy |
| Plataforma | **Instagram Reels** | Safe zones y límites según el perfil de Reels (1080×1920). TikTok y Shorts no son objetivo por ahora |
| Idiomas | **Español de México (es-MX)** e **inglés de EE. UU. (en-US)** | WhisperX con `--language es|en` por clip. Léxicos de muletillas, lista GLUE y formato de números por idioma (es-MX: `1,500.50`, `$` MXN, fechas dd/mm). Probar al menos un clip que mezcle los dos idiomas |
| LLM | **Solo Claude Code o Codex. Sin Gemini** | Se elimina `scripts/gemini.mjs`. Acentos, plan de B-roll y orden de tomas los decide el agente vía MCP. La cara se detecta en local con MediaPipe (Apache-2.0) o YuNet (MIT). La visión la da el propio agente: `Read` en Claude, `view_image` en Codex. Los botones de IA del editor lanzan el runner headless en vez de llamar a una API |

**Investigación de respaldo** (carpeta `research/`):
- `oss-landscape.md`: los 14 repos verificados más otros proyectos.
- `motion-graphics-engines.md`: Remotion, HyperFrames, GSAP, Lottie, video con IA y assets.
- `pipeline-cut-color-audio-broll.md`: recorte, color, audio, B-roll y reencuadre.
- `harness-claude-codex.md`: el harness y la autenticación.
- `captions-*.md`: teardown de Captions.ai y Submagic, engines open source de captions y spec de captions premium.
- `evaluations.json` y `judges.json`: evaluaciones de código verificadas y veredictos de los jueces.
- `critic.json`: huecos detectados por el critic.

## Resumen: por qué los captions actuales no alcanzan

Sí, los captions de autobroll son básicos. `src/CaptionTrack.tsx` tiene un solo estilo fijo:

- Inter a 62 px, con la palabra de acento a peso 800 y color de acento.
- La palabra que se está diciendo pasa a blanco y a `scale(1.05)`, sin easing.
- Cada página entra con un fade y un desplazamiento de 10 px.
- No hay presets, animación por palabra, emoji, SFX, stroke ni pill.
- Inter no está empaquetada en el bundle de render, así que el export no se ve igual que el preview.

Ninguno de los 18 candidatos trae captions de nivel Captions.ai o Submagic listos para usar. Lo más cercano está en tres proyectos, y ninguno sirve tal cual:

- open-edit: su renderer es cerrado y tiene licencia PolyForm Shield.
- HyperFrames: sería un segundo motor, su configuración por defecto es 16:9 y rechaza material con cortes.
- tscaps: solo corre en el navegador y su pegamento es AGPL.

Captions.ai se siente premium por dos cosas: (1) un vocabulario de estilo y movimiento, y (2) decisiones por palabra (énfasis, emoji, SFX) que esos productos toman en sus servidores. En tu harness, la parte (2) la hace Claude Code o Codex mandando JSON por MCP. La parte (1) hay que construirla en Remotion, portando recetas de proyectos con licencia limpia. **El hueco de captions no justifica cambiar de base.**

---

## 1. Decisión final

**Estrategia híbrida. La base es autobroll (MIT, fork de andriidrok1). Un solo motor: Remotion 4.0.380. Las piezas se copian de otros repos solo si son MIT o Apache, y siempre con atribución.** Los tres jueces eligieron esta estrategia y esta base; en el motor de motion graphics discreparon (ver tabla).

> **Sesgo a tener en cuenta:** el prompt les dijo a los jueces que existía una copia local de autobroll con cambios del usuario, y dos de ellos lo tomaron como "ya es tuyo, está prácticamente forkeado". No es así: es el repo de otra persona que clonaste para probar. Sin ese factor, el caso de autobroll se sostiene solo por su estructura (MCP, modelo anclado a clip, tamaño), mientras que HyperFrames lo supera en todas las capacidades (ver sección 7). Hay que decidirlo después de la comparativa visual de la fase 0.

Por qué autobroll, aunque sus propias notas sean bajas (captions 2/5, motion graphics 0, color 0):

- Es MIT, así que se puede forkear aquí conservando su aviso, y es pequeño: unas 4.6k líneas que se pueden entender y mantener enteras.
- Tiene una sola composición Remotion para preview y export.
- Su modelo es anclado a clip: captions y B-roll se mantienen en su sitio después de trims, reordenamientos y cambios de velocidad. **Ojo:** esto solo es cierto cuando el corte cae entre páginas de caption. Si el corte cae dentro de una frase, se rompe (ver sección 7, punto 1).
- Tiene un servidor MCP stdio de 24 herramientas que tu sesión de Claude Code ya tiene montado.
- Ya incluye WhisperX, corte de silencios, Pexels en vertical, placement según la cara, ducking de música y un editor con live reload.
- Todo lo que falta se añade encima: tracks nuevos anclados a clip y reescribir `CaptionTrack`. Ninguna pieza exige cambiar la arquitectura.

Por qué no otra base:

| Candidato | Motivo |
|---|---|
| HyperFrames | Segundo motor (Chrome + GSAP + Python), unos 8k archivos, varias releases al día, el 92% de sus bloques son 16:9, la skill de captions rechaza material con cortes, y GSAP tiene licencia no OSI |
| open-edit | El render, la verificación y las safe zones corren en un binario cerrado con cláusula de no competencia |
| diffusionstudio | Transcripción en un backend cerrado y de pago, solo corre en Electron, y sus captions tienen el mismo hueco |
| AIEV | Pensado primero para vietnamita, solo funciona con Claude y no tiene stock |
| OpenMontage, openchatcut | AGPL |
| video-editor-agent | Sin licencia |

**Dónde discreparon los jueces y cómo lo resuelvo:**

| Tema | Juez MVP | Juez calidad | Juez harness/riesgo | Decisión |
|---|---|---|---|---|
| Nota de autobroll | 8 | 6.5 ("no aporta calidad por sí solo") | 7 | Base por su forma (MCP, modelo anclado, Remotion, MIT), no por lo que produce hoy |
| Motor de motion graphics | Remotion nativo | **HyperFrames como dependencia fijada**, render alpha (ProRes 4444/VP9) compuesto con `OffthreadVideo transparent` | Remotion nativo; HyperFrames solo como sidecar opcional tras revisión legal de GSAP | **Remotion nativo por defecto.** Un motor, una licencia, y captions y gráficos en el mismo DOM, así se esquivan entre sí. HyperFrames queda como opción de fase 4 si tus templates no alcanzan, con GSAP revisado y el tiempo de render medido (en Mac no hay BeginFrame) |
| Semilla de presets de captions | 8 presets TS escritos a mano; tscaps en fase 2 | tscaps (38 templates MIT) como librería base, tras un spike | tscaps + open-edit, spike de 1–2 días | **8 presets nativos primero** (camino crítico sin depender de algo no probado). Spike de tscaps en fase 0, en paralelo; si pasa, amplía el catálogo después |
| Runner headless de Claude/Codex | vibetube | diffusionstudio (Agent SDK + app-server) | vibetube + flags de openreelio | **vibetube `providers.js` (MIT, pequeño, con tests) + flags de openreelio.** De diffusionstudio solo el registro MCP (MPL, o reescribirlo) |
| Gemini dentro del pipeline | Pasarlo al agente o dejarlo de fallback | — | Sustituirlo por pasos del cerebro | **El agente decide acentos y plan de B-roll vía MCP. Gemini se elimina** (decisión del usuario, 2026-09-23) |

---

## 2. Ranking de candidatos

El orden sale del promedio de las notas de los jueces. Captions, motion graphics, corte, color y harness son las puntuaciones /5 de las evaluaciones verificadas. La última columna de notas es el encaje como base, /10, también verificado.

| # | Repo | Licencia | Captions | Motion graphics | Corte | Color | Harness | Fit base | Jueces (media) | Uso |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | andriidrok1/autobroll | MIT (las deps de Remotion van con Remotion License) | 2 | 0 | 2 | 0 | 3 | 5 | 7.2 | **Base** |
| 2 | heygen-com/hyperframes | Apache-2.0 (npm engine sin campo license, GSAP no OSI, fuentes comerciales dentro del repo) | 4 | 4 | 2 | 4 | 5 | 6 | 7.0 | Donante de diseño y reglas de captions; posible sidecar en fase 4 |
| 3 | veedstudio/open-edit | Apache-2.0; el renderer es PolyForm Shield | 4 | 2 | 2 | 0 | 4 | 3 | 6.3 | Donante de recetas de captions y de speech-probe |
| 4 | francozanardi/tscaps | Engine y templates MIT; studio AGPL | 4 | 1 | 2 | 0 | 1 | 3 | 6.2 | Donante de templates de captions (tras el spike) |
| 5 | notivn/AIEV | MIT (SFX no comerciales) | 2 | 2 | 4 | 2 | 3 | 3 | 5.3 | Donante de corte, color y QC |
| 6 | diffusionstudio/editor | MPL-2.0; backend cerrado | 2 | 2 | 2 | 2 | 5 | 5 | 5.3 | Donante del registro MCP en Codex y Claude |
| 7 | mariagorskikh/talking-head-reel | MIT | 2 | 3 | 2 | 0 | 2 | 2 | 4.5 | Donante de overlays 9:16, zoom y SFX |
| 8 | openreelio/openreelio | MIT (bundlea FFmpeg GPL sin aviso) | 1 | 1 | 2 | 3 | 4 | 3 | 3.7 | Referencia de flags headless y de QC de contraste |
| 9 | mutonby/vibetube | MIT (matting opcional GPL/no comercial) | 1 | 2 | 1 | 2 | 4 | 2 | 3.5 | Donante del runner `claude -p`/`codex exec` |
| 10 | browser-use/video-use | MIT | 1 | 1 | 2 | 2 | 3 | 2 | 3.5 | Donante de ingest HDR, loudnorm y auto-grade |
| 11 | francozanardi/pycaps | MIT (SFX y fuentes sin licencia) | 3 | 0 | 0 | 0 | 2 | 2 | 3.3 | Solo patrones (SFX por tag, ritmo de emoji) |
| 12 | LeonSooLab/openchatcut | AGPL-3.0 | 2 | 3 | 2 | 2 | 3 | 3 | 2.8 | Solo la idea: JSX escrito por el LLM, sandbox y verificación por frames |
| 13 | kwakseongjae/dawn-cut | MIT (stickers con emoji de Apple) | 2 | 2 | 2 | 2 | 2 | 3 | 2.7 | Patrones: bus de comandos, dry-run, selectores |
| 14 | calesthio/OpenMontage | AGPL-3.0 | 2 | 2 | 2 | 2 | 4 | 2 | 2.3 | Solo la idea: CLIP + MMR para stock |
| 15 | mutonby/openshorts | MIT + `cloud/` comercial; importa Ultralytics (AGPL) | 2 | 1 | 1 | 1 | 2 | 2 | 2.3 | Patrón: el LLM genera un EDL que se compila a FFmpeg |
| 16 | krusemediallc/video-editor-agent | **Sin licencia** | 2 | 2 | 3 | 0 | 3 | 2 | 1.8 | Solo ideas; no se puede copiar nada |
| 17 | mutonby/shortcast | Apache-2.0 | 0 | 1 | 1 | 0 | 1 | 1 | 1.2 | Nada relevante |
| 18 | itsjwill/vanta | MIT | 1 | 1 | 1 | 1 | 1 | 1 | 0.8 | Patrones mínimos (grano, wipe de palabra) |

---

## 3. Piezas donantes exactas

Regla general: se copia código solo de MIT o Apache, con atribución. Los archivos de MPL se mantienen MPL o se reescriben. De AGPL, de lo que no tiene licencia y de PolyForm solo se toma la idea.

### Base (autobroll: se modifica, no se reescribe)

| Ruta | Para qué |
|---|---|
| `mcp/server.mjs` | La única superficie de herramientas para ambos cerebros. Añadir `get_transcript`, `annotate_captions`, `set_caption_style`, `caption_proof`, `find_cut_candidates`, `set_grade`, `add_graphic` y `qc` |
| `src/captions.ts` (projectCaptions), `src/Broll.tsx` (projectBrolls), `src/timeline.ts` (placeClips, sampleTransform) | Modelo anclado a clip. `projectGraphics` se clona de `projectBrolls` |
| `scripts/lib-transcribe.mjs` | WhisperX con caché. Cambiar `--language en` por `es|en|auto` e internacionalizar `PROMPT_BIAS` |
| `scripts/captions-multiclip.mjs` (buildCaptions, detectFaces/faceToTop) | Paginado y cara. Pasa a un módulo compartido con el MCP y lleva la lista GLUE en español |
| `scripts/trim-silence.mjs` | Corte de silencios de base |
| `scripts/broll-multiclip.mjs` (searchPexels), `server/index.mjs` (localizeRemoteBrolls, /api/render) | Stock vertical y job de render |
| `src/MultiClipVideo.tsx` (MusicTrack) | Ducking de la música bajo la voz |

### Corte

| Repo | Ruta | Para qué |
|---|---|---|
| notivn/AIEV (MIT) | `apps/server/src/deadWeight.ts` | Candidatos de muletilla, tartamudeo, retoma (LCS) y titubeo. Hay que cambiar los léxicos vietnamitas por ES/EN |
| notivn/AIEV (MIT) | `apps/server/src/autoTrim.ts`, `jobs/autoTrim.ts` | Barrido de umbrales con guarda de punto medio de palabra, y el flujo en que el LLM aprueba los candidatos |
| veedstudio/open-edit (Apache) | `cli/src/commands/speech-probe.ts` | Ajustar cada corte a un hueco real de audio, con piso de ruido adaptativo |
| heygen-com/hyperframes (Apache) | `packages/cli/src/media-use/lib/cutlist.mjs`, `transcriptCutFade.mjs` | Referencia de compilación de cut-list y de fades anti-click |
| kwakseongjae/dawn-cut (MIT) | `packages/core/src/selectors.ts`, `dryrun.ts` | Que el LLM seleccione por wordId, nunca en ms, y reciba un dry-run con errores |

### Color

| Repo | Ruta | Para qué |
|---|---|---|
| notivn/AIEV (MIT) | `apps/server/src/color.ts` | 14 presets de ffmpeg y tonemap HDR/HLG |
| browser-use/video-use (MIT) | `helpers/grade.py` (auto_grade_for_clip) | Corrección automática acotada. **Arreglar:** que analice después del tonemap, no antes |
| browser-use/video-use (MIT) | `helpers/render.py` (is_hdr_source, TONEMAP_CHAIN, is_portrait_source, probe_source_fps) | Ingest de vídeo HDR vertical de iPhone |
| heygen-com/hyperframes (Apache) | `packages/core/src/mediaGradeAnalyzer.ts`, `colorLuts.ts` | Sugerencias de exposición y balance de blancos a partir de signalstats, y manejo de .cube |

### Captions premium

| Repo | Ruta | Para qué |
|---|---|---|
| veedstudio/open-edit (Apache) | `refs/html/*/recipe.ts`, `refs/html/classic/classic-lib.ts`, `pipeline/recipes/lib.ts`, `template-lib.ts` | Vocabulario de movimiento (stagger por glifo, bigPop, karaoke, dropIn, escalera de tamaños) reescrito con `interpolate()`. Los anchos de glifo hay que volver a medirlos en Chrome |
| francozanardi/tscaps (MIT) | `templates/*/style.scss`, `templates/_lib/animation/*`, `packages/engine/src/modules/document/CssVariable.ts`, `Word.ts`, `Decoration.ts`, `rendering/subtitle/SegmentSubtreeHtmlBuilder.ts`, `rendering/styles/BaselineCssComposer.ts`, `FrozenFrameCss.ts`, `splitting/BalancedPixelWidthLineSplitter.ts` | Ampliación del catálogo (fase 4) si pasa el spike. Las shims de Sass las escribes tú, porque las originales son AGPL. Excluir Loki (fuente Komika) |
| heygen-com/hyperframes (Apache) | `skills/embedded-captions/dna/*.json`, `themes/*.json`, `lib-dna.cjs` (heroImpact), `check-timing` / `check-occlusion` / `check-overflow`, `safe-zones.cjs` | Reglas de la palabra "hero", tolerancia de sync de 80 ms y diseño del validador y de los checks de geometría. **No copiar TT Norms Pro ni ABC Solar Display** |
| francozanardi/pycaps (MIT, solo patrón) | `effect/sound/sound_effect.py`, `effect/text/emoji_in_segment_effect.py`, `tag/tag_condition.py` | SFX disparado por el tier de la palabra y reglas de presupuesto de emoji. No reutilizar sus mp3 |
| openreelio/openreelio (MIT, Rust, referencia) | `src-tauri/src/core/qc/caption_contrast.rs` | Diseño del check de contraste (etapa C) |

### Motion graphics B-roll

| Repo | Ruta | Para qué |
|---|---|---|
| mariagorskikh/talking-head-reel (MIT) | `remotion/src/talk/reel-overlays.tsx`, `overlays.tsx` (Card, Big, LogoRow) | Semilla de la librería de templates 9:16, convertidos en templates tipados con zod |
| mariagorskikh/talking-head-reel (MIT) | `remotion/src/talk/Reel.tsx` (useZoom, E()) | Zoom punches (snap y push) y el mapeo de tiempo de origen a tiempo de edición |
| mariagorskikh/talking-head-reel (MIT) | `remotion/scripts/make_sfx.py` | SFX sintetizados con licencia limpia (pop, whoosh, tap, ding, thud) |
| notivn/AIEV (MIT) | `engines/remotion/src/components/SceneClip.tsx` (ZoomWrapper) | Zoom con origen desplazado hacia la cara |
| heygen-com/hyperframes (Apache) | `registry/blocks/*`, `registry/components/*` (count-up, data-chart, lt-*, notification-cascade, chatgpt-exchange) | Solo referencia de diseño, para re-crear en Remotion a 9:16 |
| itsjwill/vanta (MIT) | `src/components/GradientBackground.tsx`, `src/scenes/KineticText.tsx`, `DataVizScene.tsx` | Grano y viñeta, wipe de palabra con clip-path, barras escalonadas |

### Audio y QC

| Repo | Ruta | Para qué |
|---|---|---|
| browser-use/video-use (MIT) | `helpers/render.py` (measure_loudness, apply_loudnorm_two_pass) | Entrega a −14 LUFS y −1 dBTP |
| notivn/AIEV (MIT) | `apps/server/src/qc.ts` | Gate de QC antes del render final: loudness, negro, congelado |
| veedstudio/open-edit (Apache) | `cli/src/commands/mix-audio.ts` | Referencia de sidechain para SFX y música |

### Harness

| Repo | Ruta | Para qué |
|---|---|---|
| mutonby/vibetube (MIT) | `electron/providers.js`, `electron/agent.js`, `test/providers.test.js` | Argumentos para `claude -p` y `codex exec`, resume de sesión, timeouts, kill del grupo de procesos. **Cambiar:** bypassPermissions por solo MCP, y comprobar éxito por mtime o hash |
| openreelio/openreelio (MIT, referencia) | `src-tauri/src/core/claude_headless.rs` | Flags: `--tools ""`, `--allowedTools mcp__autobroll__*`, `--strict-mcp-config`, `CLAUDE_CONFIG_DIR` aislado |
| diffusionstudio/editor (MPL-2.0) | `apps/desktop/src/mcp-config.ts`, `mcp-install.ts`, `mcp-config.test.ts` | Registro del MCP en `~/.claude.json` y en el TOML de Codex. Mantener MPL o reescribir |
| veedstudio/open-edit (Apache) | `.claude/skills/open-edit/SKILL.md`, `AGENTS.md`, `CLAUDE.md = @AGENTS.md` | Una sola fuente de instrucciones para ambos cerebros, **sin** los hooks `npx --yes` |

---

## 4. Stack recomendado por trabajo

| Trabajo | Stack | Notas |
|---|---|---|
| **Corte** | 1. WhisperX (`--language es|en|auto`, `initial_prompt` literal con "eh, este, o sea")<br>2. Silencio: `trim-silence` + snap con speech-probe<br>3. `deadWeight` ES/EN produce candidatos<br>4. El LLM aprueba vía `find_cut_candidates`<br>5. Se aplica como `split_clip`/`trim_clip` | No es destructivo: captions y B-roll se re-anclan solos. Siempre se aprueba el candidato, porque el LCS puede cortar repeticiones intencionales |
| **Color** | Bake con ffmpeg en el transcode de ingest que autobroll ya hace: tonemap HDR, luego auto-grade acotado, luego preset de AIEV o `lut3d` .cube. Herramienta MCP `set_grade` para re-transcodificar por fuente | No se ajusta en vivo en el MVP. No hay manejo de piel ni shot-matching |
| **Captions premium** | Reescribir `CaptionTrack.tsx` según el spec: 8 presets como datos, animaciones `f(frame)`, stroke con copia apilada, fuentes OFL con `delayRender`, emoji como Noto SVG, SFX en tier 3, placer con safe zone. Herramientas `set_caption_style`, `annotate_captions`, validador (etapa A) y `caption_proof` (etapas B–D) | El LLM solo emite tiers, roles, emoji, SFX y breaks. Paginado, timing, layout y validación son código determinista |
| **Stock B-roll** | El `searchPexels` actual (portrait, bajada de resolución antes del render). Mejora barata: el LLM revisa miniaturas con `frame_at` antes de aceptar. Añadir fade-out | CLIP + MMR (idea de OpenMontage, reimplementada) solo si la relevancia falla |
| **Motion graphics B-roll** | Track de gráficos anclado a clip (`projectGraphics`) con un registry tipado (zod) de 6–8 templates: lower-third, titular cinético, stat count-up, pop de emoji o icono, tarjeta de notificación o UI, lista/stamp, CTA/end card. Herramienta `add_graphic({template, props, anchorWordId})`. Zoom punches por keyframes | En el MVP el LLM elige template y props; no escribe código. JSX escrito por el LLM o sidecar de HyperFrames quedan para la fase 4 |
| **Audio** | Ducking actual, SFX (sintetizados + CC0 verificado por archivo) a −12 dB respecto a la voz, loudnorm de dos pasadas a −14 LUFS, gate de QC | El QC bloquea el render final si falla |
| **Render** | Remotion 4.0.380 vía `server/index.mjs`. Un solo motor para captions, gráficos y B-roll | Fijar la versión 4.x. Medir el coste de blur y glow |
| **Harness** | Un solo servidor MCP stdio (autobroll) para ambos cerebros. SKILL.md + AGENTS.md. Runner headless: `claude -p --allowedTools mcp__autobroll__* --strict-mcp-config` / `codex exec` con sandbox read-only. Registro automático en ambas configs | Sin shell para el agente headless. El texto del transcript se trata como no confiable (vía de prompt-injection). Sin Gemini: la visión la da el propio agente (`Read` / `view_image`) |

---

## 5. Plan por fases

Las duraciones son orientativas. El plan de 4 semanas del juez MVP es optimista para tener motion graphics de calidad.

### Fase 0: endurecimiento y spikes (unos 5–7 días)

**Entregables:**
- Seguridad:
  - Backend en `127.0.0.1` con token por sesión.
  - Quitar `.trycloudflare.com` de `allowedHosts`, o protegerlo con el token.
  - Eliminar `scripts/gemini.mjs` y sus llamadas: acentos, B-roll y arrange pasan a herramientas MCP; la cara a MediaPipe/YuNet local.
- Arreglos en autobroll:
  - Parámetro `--language es|en|auto` y prompt localizado.
  - Lista GLUE en español.
  - Inter y las fuentes OFL empaquetadas con `delayRender`.
  - Documentar `set_keyframes` en %.
  - Herramienta `get_transcript` a nivel de palabra.
  - `edit_caption` conserva los timings de las palabras que no cambian.
- Spikes con límite de tiempo, cada uno con un informe go/no-go:
  1. Codex conectado al MCP de autobroll vía `config.toml`: ¿funciona, y ve las imágenes de `frame_at`?
  2. Un template de tscaps con paused-CSS dentro de Remotion (máximo 2 días).
  3. WhisperX en español con prompt literal sobre 3 clips reales: qué % de muletillas quedan en el transcript frente a un conteo manual.
  4. `paint-order: stroke fill` en Chrome 134, con un still.

**Criterios de aceptación:**
- Un clip de 60 s en español sale transcrito en español.
- Un still exportado y `frame_at` del preview usan la misma fuente (comparación visual o SSIM).
- Un script de smoke corre `get_project` + `frame_at` desde Claude Code y desde Codex (o documenta el fallo de Codex).
- El backend no responde desde la IP de la LAN.
- Existen los 4 informes de spike con su decisión.

### Fase 1: núcleo de captions premium (unas 2 semanas, el camino crítico)

**Entregables:**
- Modelo de datos (`tier`, `role`, `emoji`, `sfx`, `brk`) y migración de `accent` a `tier: 1`.
- Módulo de paginado compartido entre el pipeline y el MCP. Quita la duplicación con `editor/store.ts` en la parte de captions.
- Primero 4 presets (clean, bold-pop, pill, karaoke), luego los 8.
- Librería de animación `f(frame)`.
- Placer con la safe zone de Instagram Reels (punto de partida: y 270–1440, x 140–940; calibrar con capturas reales de la UI de Reels).
- `set_caption_style` y `annotate_captions`.
- Validador de la etapa A con `node --test`.
- Emoji Noto SVG y pack de SFX.
- `caption_proof`, etapas B y C (hasta que exista, sirve `render draft` + `frame_at`).

**Criterios de aceptación:**
- El test del validador pasa.
- Clips de prueba de 10 s en ES y EN, renderizados con los 8 presets:
  - Bounding box (por canal alfa) dentro de la safe zone en el 100% de los probes.
  - Ninguna página termina en palabra glue.
  - Timing dentro de ±80 ms del transcript.
- Contraste ≥ 4.5:1, o ≥ 3:1 con stroke o caja.
- Una sesión de Claude anota un reel de 60 s de principio a fin con 2 rondas del validador como máximo.
- **Gate subjetivo:** comparas a ciegas el mismo clip exportado desde Captions.ai o Submagic. Si pierde claramente, se itera sobre los presets antes de pasar de fase.

### Fase 2: corte, color y audio (1–1.5 semanas)

**Entregables:**
- `deadWeight` portado con léxicos ES/EN y la herramienta `find_cut_candidates`.
- Snap de cortes con speech-probe.
- Aplicación de los cortes como split/trim.
- Bake de color en el ingest (tonemap, auto-grade, preset o LUT) y `set_grade`.
- Loudnorm de dos pasadas y herramienta `qc` como gate del render final.

**Criterios de aceptación:**
- Sobre 5 clips reales ES/EN con retomas y muletillas anotadas por ti:
  - ≥ 80% de las retomas aparecen como candidato.
  - 0 cortes a mitad de palabra (verificado re-transcribiendo cada corte).
  - Recall de muletillas medido y reportado. El umbral se fija con los datos del spike 3.
- Tras los cortes, captions y B-roll siguen anclados.
- Un clip HDR de iPhone no sale lavado.
- El final queda en −14 LUFS ±1, con true peak ≤ −1 dBTP.
- Un render que falla el QC queda bloqueado.

### Fase 3: motion graphics y los dos cerebros (2–3 semanas)

**Entregables:**
- `projectGraphics` y un registry de 6–8 templates zod sembrados desde talking-head-reel.
- `add_graphic`, zoom punches y golpes de SFX.
- El placer de captions evita los rectángulos de los gráficos.
- Runner headless con selector de cerebro (Claude o Codex).
- Registro MCP en ambas configs.
- SKILL.md y AGENTS.md.
- `caption_proof` etapa D (crítica visual con la visión del agente; si el resultado MCP no lleva la imagen a Codex, el agente abre el PNG con `view_image`).

**Criterios de aceptación:**
- Un solo comando produce un reel completo (corte, grade, captions, 3 o más gráficos, B-roll, música) desde el clip crudo, con cada uno de los dos cerebros.
- 0 solapes entre captions y gráficos en el check de geometría.
- Cada template renderiza a 1080×1920 dentro de la safe zone.
- Un test demuestra que el runner headless no puede usar shell ni escribir archivos fuera del MCP.

### Después (fase 4+, solo si hace falta)

- Importar templates de tscaps si el spike pasó.
- Sidecar de HyperFrames para renders con alfa, tras una revisión legal de GSAP.
- TSX escrito por el LLM, compilado en sandbox (idea de openchatcut, reimplementada).
- Palabra hero detrás del hablante, con matte.
- Ranking de stock con CLIP.
- Face tracking por segundo, si la crítica visual lo pide.

---

## 6. Riesgos principales

1. **Captions: el camino crítico depende del gusto.** Ningún proyecto open source trae captions premium listos. Construir 8 presets, la herramienta de anotación y el validador lleva 1–2 semanas, y el resultado depende tanto del diseño como del código.
2. **Motion graphics: no existe una librería open source 9:16 de calidad profesional.** HyperFrames es 92% 16:9 y talking-head-reel tiene una estética estrecha. Cuenta con semanas de diseño de templates, y el demo inicial tendrá pocos.
3. **Muletillas en español.** WhisperX suele omitir "eh", "este" y "mmm". Sin el spike 3, el corte por léxico puede no ver nada. El plan B es sondear los huecos por RMS.
4. **Licencia de Remotion.** Es gratis hasta 3 empleados y de pago por encima. Los términos cambian en Remotion 5.0. Afecta a cualquier camino que use autobroll.
5. **Paridad de Codex no verificada.** Ni el MCP vía `config.toml` ni las imágenes en resultados de MCP están probados.
6. **Contaminación de licencias.** No copiar código de OpenMontage, openchatcut, el studio de tscaps (incluidas sus funciones Sass) ni `main.py` de openshorts. Nada de video-editor-agent. Nada del binario weave de VEED. Tampoco copiar fuentes y assets problemáticos: Komika, The Bold Font, emoji de Apple, SFX de AIEV y de pycaps, fuentes comerciales de HyperFrames.
7. **autobroll tiene bus factor 1, sin tests ni CI.** Tiene lógica duplicada entre el MCP y `editor/store.ts`, y agente y UI escriben el proyecto con last-write-wins. El fork es tuyo y lo mantienes entero.
8. **Seguridad.** El backend escucha en todas las interfaces sin auth y posiblemente está expuesto con un túnel. Hay que cerrarlo antes de cualquier loop de agente.
9. **Sin verificar:** los píxeles de las safe zones, `paint-order`, la licencia del Noto animado y el coste de render de blur y glow.

## Preguntas abiertas para ti

_Respondidas el 2026-09-23 (ver "Decisiones ya tomadas"): proyecto open source Apache-2.0 para terceros y sin venta comercial; plataforma Instagram Reels; idiomas es-MX y en-US; LLM solo Claude Code o Codex, sin Gemini. Seguridad y concurrencia agente/UI deben cumplir el estándar de un proyecto que otros van a instalar._

1. **¿Aceptas GSAP/HyperFrames como sidecar opcional (fase 4), o prefieres solo Remotion?** GSAP es gratis pero no tiene licencia OSI, así que no se empaqueta; solo sería una dependencia opcional.
2. **Calibración de Reels:** ¿puedes subir a Instagram un vídeo gris de prueba como borrador y sacar capturas? Con eso se miden las safe zones reales.
3. **Referencias de estilo:** ¿3–5 creadores o reels que quieras igualar? Es la entrada principal para diseñar presets y templates.
4. **Túnel:** en tu clon local de autobroll, `vite.config.ts` permite `.trycloudflare.com`. Si ese túnel sigue abierto, el backend sin autenticación está expuesto a internet. Ciérralo.
---

## 7. Correcciones del critic (obligatorias antes de ejecutar)

El critic revisó esta síntesis contra la evidencia (detalle completo en `research/critic.json`). Cambios al plan:

**Altas: cambian el orden de las fases**

1. **Re-anclaje por palabra, no por página.**
   - **Problema:** hoy `applyAutocut` (`mcp/server.mjs:141-162`) y `editor/store.ts:202-247` mueven páginas enteras de caption, y `projectCaptions` nunca descarta las palabras cortadas. Con cortes dentro de una frase (que es justo el objetivo: muletillas y retomas), la palabra borrada sigue en pantalla.
   - **Arreglo:** asignar cada palabra al segmento que la contiene, descartar las que caen en rangos eliminados y volver a paginar. Las páginas se derivan del transcript más la lista de edición; ya no se guardan.
   - **Cuándo:** va en la **fase 1**, antes de `find_cut_candidates`, con un test `node --test` que meta un corte dentro de una página.
2. **Comparativa visual antes de la fase 1.** Nadie ha visto todavía un render: toda la calidad de captions se juzgó leyendo código.
   - Renderizar el mismo clip en español de 10 s con tscaps, una receta de open-edit y pycaps "hype".
   - Ver los previews publicados de HyperFrames.
   - Comparar todo contra un export de Captions.ai o Submagic.
   - Con el resultado se decide qué presets portar y cuáles escribir a mano.
3. **Paridad de Codex (spike 1 ampliado).** Codex no tiene equivalente a `--tools ""`: el shell no se puede quitar, solo meter en sandbox. Bajo `codex exec --sandbox read-only`, probar:
   - una herramienta MCP que escribe el proyecto;
   - una que dispara un render;
   - que la imagen de `frame_at` llegue al modelo;
   - que un intento de usar el shell quede bloqueado.
   Probar también el patrón de openreelio (`codex app-server` con `dynamicTools`). Se queda el que pase.

**Medias**

- **IDs de palabra estables** (fuente + startMs o índice del transcript). Toda anotación y edición se dirige por `wordId`; el id de página es solo para mostrar. Hoy `mergeCaptions` renumera `c${i}`.
- **Kits de captions nativos de Remotion sin revisar:**
  - `remotion-captions-kit` (MIT, 6 presets)
  - `remotion-captioneer` (15 animaciones y emoji)
  - `remotion-captions-themes` (13 temas, layout que evita colisiones)
  - `captioncat` (36 presets)

  Leer su código y renderizar cada uno una vez dentro de la ventana de tiempo del spike 2, antes de escribir 8 presets desde cero. Revisar también OpenChatCut en su upstream real (`0xsline/OpenChatCut`), no en el fork muerto.
- **Opciones de compra:** precio por minuto de APIs de captions hospedadas (tscaps.io, Submagic, ZapCap) y su soporte de español. También Lottie con licencia vía `@remotion/lottie` para lower thirds y stats. Comparar contra las semanas de diseño de templates.
- **Mismo criterio de licencia para Remotion y GSAP.** Los dos son no-OSI. Como el proyecto es open source Apache-2.0, esto pesa a favor de HyperFrames (Apache). La decisión "Remotion por defecto" se mantiene por la base y el modelo anclado, pero queda **reabierta** si la comparativa visual favorece a HyperFrames.
- **Un solo módulo de mutaciones del proyecto.** Hoy la lógica está duplicada en `editor/store.ts` y `mcp/server.mjs`. El módulo lo importan ambos, con compare-and-swap por `updatedAt` en `POST /api/projects/:id` para que el agente y la UI no se pisen. Va en la fase 0.
- **Benchmark de render en la fase 0:** el reel de 60 s 1080×1920 actual contra el mismo reel con bold-pop + blur + glow. Fijar una proporción máxima aceptable como criterio de la fase 1.
- **Limpieza de voz (fase 2):** `arnndn`/`afftdn` o DeepFilterNet (MIT/Apache) como paso opcional de ingest, en A/B sobre 3 grabaciones reales de teléfono.
- **UI de pulido manual:** preset, tier, emoji y SFX por palabra en el Inspector, y re-timing arrastrando en el track de captions. Si no se hace, hay que aceptar explícitamente que el producto solo se usa con agente.
- **Ranking honesto:** por el `fit_as_base` verificado, HyperFrames (6) queda por encima de autobroll (5), y HyperFrames gana en todas las dimensiones de capacidad. autobroll se elige **pese a eso**, por su MCP, su modelo anclado a clip y su tamaño abarcable. Es una decisión de juicio, no algo que salga de los números.

**Bajas**

- **Plan B para muletillas en español:** buscar "energía de voz sin palabra alineada" en huecos menores a 600 ms. El RMS solo no las detecta, porque "eh" y "este" tienen energía. Probar también un clip que mezcle ES y EN.
- **Color:** comparar el bake en el ingest contra una LUT en tiempo de render (CSS/WebGL) sobre un clip HDR de iPhone.
- **Correcciones menores:**
  - Excluir los templates de tscaps luca, luna y milo (necesitan el frame dentro del DOM) y pastor (necesita segmentación), y las 11 recetas de open-edit que son solo 16:9.
  - Arreglar en la fase 2 el bug de arrange-clips que manda el transcript de la fuente completa después del autocut.
  - Revisar los términos de la API de Pexels.
