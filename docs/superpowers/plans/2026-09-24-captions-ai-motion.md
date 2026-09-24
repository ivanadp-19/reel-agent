# Motion design de Captions.ai en reel-agent — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que cada movimiento catalogado en `research/captions-ai-motion.md` (los 20 estilos de AI Edit) exista como primitiva determinista en la composición de Remotion, agrupada en *style packs* que el agente elige por id, sin que el agente escriba nunca animación.

**Architecture:** una librería pura `src/motion.ts` (funciones de frame → estado: llegadas, salidas, brillos, máscaras) que consumen los tres renderers que ya existen (`CaptionTrack.tsx`, `Graphics.tsx`, `ClipMedia.tsx`/`Broll.tsx`); los packs (`captionPresets.ts` + un nuevo `src/stylePacks.ts`) fijan qué primitiva usa cada elemento; `transitions.ts` crece con las transiciones nuevas; una herramienta `motion_proof` deja al agente *ver* el movimiento (tira de 1 s a 24 fps) igual que `caption_proof` le deja ver un still.

**Tech Stack:** Remotion 4.0.380 (`interpolate`, `spring`, `Easing`), React 18, CSS `clip-path`/`mask`/`filter`, SVG `stroke-dashoffset`, ffmpeg (tiras), node:test. Sin dependencias nuevas.

**Spec:** `research/captions-ai-motion.md` (Parte 1: catálogo por estilo; Parte 2: vocabulario de primitivas y prioridad).

## Global Constraints

- Toda animación es `f(frame)` con `interpolate`/`spring`; nunca CSS `transition`/`@keyframes` (AGENTS.md: determinista, preview = export).
- El agente decide *qué* (pack, tiers, plantilla, transición por id); el código decide *cuándo y cuánto* (AGENTS.md).
- Sin dependencias nuevas; `@remotion/layout-utils` no está instalado: medir texto con `canvas.measureText`.
- Tiempos en frames del preset a 30 fps del proyecto; los valores de referencia se midieron a 24 fps y se convierten a ms (1 f = 42 ms).
- Los captions nunca se desenfocan con el metraje (el texto va en capas fuera del `FocusPull` y de las transiciones).
- `public/`, `.env`, `.refs/` fuera de git. Cada tarea termina con `npm run typecheck` y `node --test` en verde y un commit.
- Nada de assets dibujados a mano ni modelos SVG; las texturas (papel, periódico, light leak) se buscan o generan (`mcp/assets.mjs`), nunca se dibujan.

---

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/motion.ts` (nuevo) | Primitivas puras: `arrive()`, `leave()`, `shine()`, `wipe()`, `flash()`, easings. Sin React. |
| `src/captionPresets.ts` | Campos nuevos por pack: `wordIn`, `keyIn`, `pageIn`, `pageOut`, `active`, `gradientSpan`, `opening`. |
| `src/CaptionTrack.tsx` | Consume `motion.ts` para palabras y páginas; caja karaoke que salta o se desliza. |
| `src/transitions.ts` | Tipos nuevos de `enter` y su `Fx` (blur direccional, spin, flash, rgb, máscaras). |
| `src/ClipMedia.tsx` | Aplica `Fx` nuevos: `clip-path`, flash, separación RGB, spin blur. |
| `src/Graphics.tsx` + `src/graphicTemplates.ts` | Props `reveal`, `out`, `life` por plantilla con defaults por pack; componentes draw-on. |
| `src/Broll.tsx` + `src/brollModel.ts` | Entradas de B-roll: `slideUp`, `popFrom`, `card`; carrusel; ventanas con estela. |
| `src/stylePacks.ts` (nuevo) | Un pack = preset de captions + defaults de plantillas + transiciones + apertura + lienzo. |
| `src/MultiClipVideo.tsx` | Apertura del reel (`opening`), punch en tier 2 (impact), pulso glitch. |
| `mcp/proof.mjs` + `mcp/server.mjs` | `motion_proof`: tira de 24 frames consecutivos en una hoja. |
| `scripts/motion-compare.mjs` (nuevo) | Tira nuestra vs. tira del preview, lado a lado, para el gate visual. |
| `test/motion.test.mjs`, `test/transitions.test.mjs`, `test/stylePacks.test.mjs` | Tests de las funciones puras. |

---

## Fase 0 — Ver el movimiento (media jornada)

### Task 0.1: `motion_proof`, la tira que el agente puede mirar

**Files:**
- Modify: `mcp/proof.mjs` (añadir `renderStrip`)
- Modify: `mcp/server.mjs` (registrar `motion_proof`, junto a `caption_proof`)
- Test: manual con el proyecto `p-1790272422452` (corrida 9)

**Interfaces:**
- Produces: `renderStrip(props, atSec, {frames = 24, cols = 8, scale = 0.17}) → {sheet, frames}` en `mcp/proof.mjs`.

- [ ] **Step 1: `renderStrip` en `mcp/proof.mjs`** — reutiliza `getBundle()` y `renderStill` frame a frame desde `round(atSec·fps)`, guarda `strip-<i>.jpg` y los une con el mismo `xstack` que `renderProof` (8 por fila).

```js
export async function renderStrip(props, atSec, outDir, {frames = 24, cols = 8, scale = 0.17} = {}) {
  fs.mkdirSync(outDir, {recursive: true});
  const serveUrl = await getBundle();
  const composition = await selectComposition({serveUrl, id: 'MultiClip', inputProps: props});
  const first = Math.max(0, Math.min(composition.durationInFrames - frames, Math.round(atSec * composition.fps)));
  const stills = [];
  for (let i = 0; i < frames; i++) {
    const out = path.join(outDir, `strip-${String(i).padStart(2, '0')}.jpg`);
    await renderStill({composition, serveUrl, output: out, inputProps: props, frame: first + i, scale, imageFormat: 'jpeg', jpegQuality: 80});
    stills.push(out);
  }
  const sheet = path.join(outDir, 'strip.jpg');
  const layout = stills.map((_, i) => `${(i % cols) === 0 ? 0 : Array.from({length: i % cols}, (_, k) => `w${k}`).join('+')}_${Math.floor(i / cols) === 0 ? 0 : Array.from({length: Math.floor(i / cols)}, (_, k) => `h${k * cols}`).join('+')}`).join('|');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...stills.flatMap((s) => ['-i', s]), '-filter_complex', `${stills.map((_, i) => `[${i}]`).join('')}xstack=inputs=${stills.length}:layout=${layout}`, '-q:v', '4', sheet]);
  if (r.status !== 0) throw new Error(`ffmpeg tiling failed: ${String(r.stderr).slice(-200)}`);
  return {sheet, first, fps: composition.fps};
}
```

- [ ] **Step 2: herramienta `motion_proof`** en `mcp/server.mjs`, debajo de `caption_proof`:

```js
server.registerTool('motion_proof', {description: 'SEE the motion: 24 consecutive frames (0.8 s at 30 fps) from a timeline time, tiled 8 per row left→right top→bottom. Use it on a word arrival, a transition or a title to check timing and easing; caption_proof shows a single still.', inputSchema: {project_id: pid, at_sec: sec('timeline time to start from')}}, async ({project_id, at_sec}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const outDir = path.join(ROOT, '.captions-tmp', `strip-${Date.now()}`);
  const {sheet, first, fps} = await renderStrip(projectProps(p), at_sec, outDir);
  const data = fs.readFileSync(sheet).toString('base64');
  fs.rmSync(outDir, {recursive: true, force: true});
  return {content: [{type: 'text', text: `24 frames from ${f1(first / fps)}s (1 frame = ${Math.round(1000 / fps)} ms), 8 per row`}, {type: 'image', data, mimeType: 'image/jpeg'}]};
});
```

- [ ] **Step 3: probar** con un cliente MCP de un solo uso (patrón de `.captions-tmp/finish8.mjs`): `motion_proof {project_id: 'p-1790272422452', at_sec: 4.3}` debe devolver una hoja de 8×3 en < 25 s. Mirar la imagen.
- [ ] **Step 4: `scripts/motion-compare.mjs`** — `node scripts/motion-compare.mjs <ref.mp4> <refSec> <project.json> <ourSec> <out.jpg>`: tira del preview (`ffmpeg -ss -t 1 tile=8x3`) apilada sobre nuestra tira (`renderStrip`), para el gate visual de cada tarea siguiente.
- [ ] **Step 5: commit** — `git add mcp/proof.mjs mcp/server.mjs scripts/motion-compare.mjs && git commit -m "motion_proof: a 24-frame strip the agent can look at"`.

---

## Fase 1 — Prism Pro al 100 % (1–2 días)

### Task 1.1: `src/motion.ts` — llegadas y salidas puras

**Files:**
- Create: `src/motion.ts`
- Test: `test/motion.test.mjs`

**Interfaces:**
- Produces:
```ts
export type ArriveKind = 'cut' | 'fade' | 'ghost' | 'blur' | 'rgb' | 'pop' | 'drop' | 'slideBlur';
export type Arrival = {opacity: number; scale: number; dx: number; dy: number; blur: number; rgb: number; shine: number}; // dx/dy px, blur px, rgb px de separación, shine 0..1 posición del brillo
export function arrive(kind: ArriveKind, frame: number, fps: number): Arrival; // frame relativo al onset (negativo = aún no)
export type LeaveKind = 'cut' | 'fade' | 'blur' | 'letters' | 'slideUp' | 'slideDown';
export function leave(kind: LeaveKind, framesLeft: number, fps: number): {opacity: number; blur: number; dy: number; letterCut: number}; // letterCut = cuántas letras desde el final ya no se ven
export const ms = (fps: number, millis: number) => Math.max(1, Math.round((fps * millis) / 1000));
```
- Tiempos (de la Parte 1 del catálogo, 24 fps → ms): `fade` 170 ms; `ghost` 250 ms desde opacidad 0.4 con `shine` 0→1 en esos 250 ms; `blur` 100 ms desde 15 px; `rgb` 125 ms desde 10 px de blur + 6 px de separación; `pop` spring 0.7→1 (damping 12, stiffness 220) — el actual; `drop` 125 ms escala 1.3→1 y dy −0.5 em→0; `slideBlur` 250 ms dx +600→0 px con blur 30→0 (GROWTH de Prime).

- [ ] **Step 1: test que falla** (`test/motion.test.mjs`):

```js
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {arrive, leave, ms} from '../src/motion.ts';

test('ghost: starts at 40 % opacity and the shine crosses the word in 250 ms', () => {
  const a0 = arrive('ghost', 0, 30), a3 = arrive('ghost', 3, 30), a8 = arrive('ghost', 8, 30);
  assert.ok(a0.opacity >= 0.38 && a0.opacity <= 0.42);
  assert.ok(a3.shine > 0 && a3.shine < 1);
  assert.equal(a8.opacity, 1); assert.equal(a8.shine, 1); assert.equal(a8.scale, 1);
});
test('before the onset every arrival is invisible; cut is fully there at frame 0', () => {
  assert.equal(arrive('fade', -1, 30).opacity, 0);
  assert.equal(arrive('cut', 0, 30).opacity, 1);
});
test('rgb: blur and channel split fall to 0 within 125 ms', () => {
  assert.ok(arrive('rgb', 0, 30).rgb > 0);
  assert.equal(arrive('rgb', ms(30, 125), 30).rgb, 0);
});
test('leave letters: the last letter goes first, 1.5 frames apart', () => {
  assert.equal(leave('letters', 100, 24).letterCut, 0);
  assert.ok(leave('letters', 3, 24).letterCut >= 2);
});
```

- [ ] **Step 2: correr** `node --test test/motion.test.mjs` → falla (módulo inexistente).
- [ ] **Step 3: implementación mínima** (`src/motion.ts`):

```ts
import {interpolate, spring, Easing} from 'remotion';
const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const OUT = Easing.out(Easing.cubic);
export const ms = (fps: number, millis: number) => Math.max(1, Math.round((fps * millis) / 1000));
const NONE: Arrival = {opacity: 1, scale: 1, dx: 0, dy: 0, blur: 0, rgb: 0, shine: 1};
export function arrive(kind: ArriveKind, frame: number, fps: number): Arrival {
  if (frame < 0) return {...NONE, opacity: 0, shine: 0};
  const t = (millis: number) => interpolate(frame, [0, ms(fps, millis)], [0, 1], {...CLAMP, easing: OUT});
  switch (kind) {
    case 'cut': return NONE;
    case 'fade': { const a = t(170); return {...NONE, opacity: a, dy: (1 - a) * 6}; }
    case 'ghost': { const a = t(250); return {...NONE, opacity: 0.4 + 0.6 * a, shine: a}; }
    case 'blur': { const a = t(100); return {...NONE, opacity: a, blur: (1 - a) * 15}; }
    case 'rgb': { const a = t(125); return {...NONE, opacity: Math.min(1, a * 1.5), blur: (1 - a) * 10, rgb: (1 - a) * 6}; }
    case 'pop': { const s = spring({frame, fps, config: {damping: 12, stiffness: 220, mass: 0.6}}); return {...NONE, scale: 0.7 + 0.3 * s, opacity: Math.min(1, s * 2)}; }
    case 'drop': { const a = t(125); return {...NONE, scale: 1.3 - 0.3 * a, dy: -(1 - a) * 40}; }
    case 'slideBlur': { const a = t(250); return {...NONE, dx: (1 - a) * 600, blur: (1 - a) * 30}; }
  }
}
export function leave(kind: LeaveKind, framesLeft: number, fps: number) {
  const k = (millis: number) => interpolate(framesLeft, [0, ms(fps, millis)], [0, 1], CLAMP); // 1 = lejos del final
  switch (kind) {
    case 'cut': return {opacity: 1, blur: 0, dy: 0, letterCut: 0};
    case 'fade': return {opacity: k(120), blur: 0, dy: 0, letterCut: 0};
    case 'blur': return {opacity: k(200), blur: (1 - k(200)) * 12, dy: 0, letterCut: 0};
    case 'slideUp': return {opacity: 1, blur: 0, dy: -(1 - k(290)) * 600, letterCut: 0};
    case 'slideDown': return {opacity: 1, blur: 0, dy: (1 - k(170)) * 600, letterCut: 0};
    case 'letters': return {opacity: 1, blur: 0, dy: 0, letterCut: Math.max(0, Math.floor((ms(fps, 460) - framesLeft) / (1.5 * fps / 24)))}; // Form: 11 f para 7 letras a 24 fps
  }
}
```

- [ ] **Step 4: correr** → pasa. `npm run typecheck`.
- [ ] **Step 5: commit** `git add src/motion.ts test/motion.test.mjs && git commit -m "motion.ts: pure arrivals and exits measured on the Captions.ai previews"`.

### Task 1.2: captions con `motion.ts` — fantasma + brillo, degradado por página, salida por corte

**Files:**
- Modify: `src/captionPresets.ts` (tipos y packs)
- Modify: `src/CaptionTrack.tsx` (`Word`, `CaptionPage`)
- Test: `test/paging.test.mjs` (solo tipos) + gate visual con `motion_proof`

**Interfaces:**
- `Preset.wordIn: ArriveKind` (plain), nuevo `Preset.keyIn: ArriveKind` (tiers), `Preset.pageOut: {type: LeaveKind; ms: number}`, nuevo `Preset.gradientSpan: 'word' | 'page'`.
- Prism: `wordIn: 'fade'`, `keyIn: 'ghost'`, `pageOut: {type: 'cut', ms: 0}`, `gradientSpan: 'page'`, `pageIn: {type: 'none', ms: 0}`.
- Stack: `wordIn: 'fade'`, `keyIn: 'pop'` (la caja roja sí hace pop), Focus/Lift: `wordIn: 'cut'` con el frame gris (ver 1.3), Impact: `wordIn: 'rgb'`, `keyIn: 'blur'`, Evo: `wordIn: 'blur'`, Prime: `keyIn: 'fade'`.

- [ ] **Step 1:** en `Word`, sustituir el bloque `anim/pop/a/scale/dy` por `const m = arrive(tier ? preset.keyIn : build ? preset.wordIn : 'cut', local, fps)` y aplicar `opacity: m.opacity`, `transform: translate(dx,dy) scale(m.scale)`, `filter: blur(m.blur)` (solo si > 0.2), separación RGB como dos `text-shadow` (`${m.rgb}px 0 rgba(255,0,80,.7), ${-m.rgb}px 0 rgba(0,200,255,.7)`) cuando `m.rgb > 0.3`.
- [ ] **Step 2: brillo** — para `fill: 'gradient'` la posición del degradado sigue a `m.shine`: `backgroundSize: '220% 100%'`, `backgroundPosition: \`${(1 - m.shine) * 100}% 0\``. Con `gradientSpan: 'page'` el degradado se pinta sobre el contenedor de la página (`backgroundImage` en el `div` de la página con `WebkitBackgroundClip: 'text'` y las palabras normales `color: preset.colors.text` con `WebkitTextFillColor`), de modo que cada palabra clave muestre otro tramo (el "First-Time" dorado frente al "Mistake" teal del preview).
- [ ] **Step 3: salida por corte** — en `CaptionPage`, `disappear` usa `leave(preset.pageOut.type, durationInFrames - frame, fps)`; con `cut` la página se queda opaca hasta su último frame.
- [ ] **Step 4: gate visual** — `node scripts/motion-compare.mjs .refs/captions-ai/prism-pro.mp4 0.40 public/projects/p-1790272422452.json 4.30 .captions-tmp/cmp-prism-ghost.jpg` y mirar: la palabra clave debe llegar en ~6 frames sin cambiar de tamaño y el brillo cruzar de izquierda a derecha.
- [ ] **Step 5:** `npm run typecheck && node --test` y commit `"prism: ghost + shine arrivals, page-wide gradient, cut exits"`.

### Task 1.3: karaoke por caja — salto (Lift/Stack) y deslizamiento (Focus)

**Files:**
- Modify: `src/captionPresets.ts` (`active: 'none' | 'color' | 'box-jump' | 'box-slide'`)
- Modify: `src/CaptionTrack.tsx`
- Test: `test/motion.test.mjs` (función pura `boxTravel`)

**Interfaces:**
- `src/motion.ts`: `export function boxTravel(prevX: number, nextX: number, frame: number, fps: number): number` — x interpolada en 80 ms (2 f a 24 fps), ease-out.

- [ ] **Step 1: test** — `boxTravel(0, 100, 0, 30) === 0`, `boxTravel(0, 100, ms(30, 80), 30) === 100`, monótona.
- [ ] **Step 2:** en `CaptionPage`, cuando `active` es `box-*`: medir el ancho de cada palabra con `canvas.measureText` (fuente del preset, `fontSize` real) y calcular la x de cada palabra dentro de su línea (mismo `gap` que el flex); pintar UNA caja absoluta (`div` detrás del texto) con `left = boxTravel(xPrev, xActive, frame - onsetActive, fps)` en `box-slide`, o con opacidad `arrive('fade', …)` en `box-jump` (la anterior se apaga en 2 f). La palabra dentro de la caja toma `preset.colors.onAccent`.
- [ ] **Step 3:** el frame gris de Focus/Align: `wordIn: 'cut'` + `preset.upcoming: 'dim'` ya lo produce (1 frame en `dim` antes del onset porque el onset se redondea hacia arriba). Verificar en `motion_proof` que aparece exactamente 1 frame gris.
- [ ] **Step 4:** gate visual contra `focus.mp4` t=0.60 (caja que viaja en 2 f) y `lift.mp4` t=0.75 (caja que salta). Commit `"karaoke box: slides (focus) or jumps (lift, stack)"`.

### Task 1.4: whip diagonal con escala, apertura del reel y tarjeta de B-roll con aterrizaje largo

**Files:**
- Modify: `src/transitions.ts` (`Enter` += `'whipDiag'`; `Fx` += `angle`, `opening`)
- Modify: `src/ClipMedia.tsx` (blur direccional = `filter: blur()` + `transform: rotate(angle) scaleY()` no sirve; usar `feConvolveMatrix`? No: usar el truco barato de tres copias desplazadas a lo largo del ángulo con opacidad 1/3 + blur gaussiano — determinista y sin dependencias)
- Modify: `src/MultiClipVideo.tsx` (`opening` del pack: blur radial 5 f en el frame 0)
- Modify: `src/Broll.tsx`, `src/brollModel.ts` (`enter: 'card'` → tarjeta cuadrada que sube 330 ms rápido y sigue subiendo 700 ms lento; `exit: 'up'` con aceleración 12 f)
- Test: `test/transitions.test.mjs`

**Interfaces:**
- `transitionFx` devuelve además `angle` (grados) y la entrada `whipDiag` usa 4 f de salida (blur 0→18 px, ángulo 60°) y 6 f de entrada (blur 18→0, escala 1.3→1.0).
- `src/motion.ts`: `export function cardLanding(frame: number, fps: number): number` — 0→1: 0.7 en los primeros 330 ms (ease-out), el 0.3 restante lineal en 700 ms.

- [ ] **Step 1: tests** — `transitionFx({enter:'whipDiag'}, 0, 60)` → `blur ≈ 18, scale ≈ 1.3`; en el frame 6 → `blur 0, scale 1`; `cardLanding(0)=0`, `cardLanding(ms(30,330))≈0.7`, `cardLanding(ms(30,1030))=1`.
- [ ] **Step 2:** implementar; en `ClipMedia`, si `fx.angle` y `fx.blur > 0.2`, envolver el `<Comp>` en tres capas desplazadas `±blur·0.6 px` a lo largo de `angle` con `opacity 0.34` cada una, además del `blur(fx.blur·0.5)`.
- [ ] **Step 3:** `opening: 'zoomBlur' | 'blurIn' | 'none'` en el pack; `MultiClipVideo` aplica al `FocusPull` un `k` extra en los primeros 5–8 f (reutilizar el wrapper: escala 1.06 y blur 20→0).
- [ ] **Step 4:** `add_broll` acepta `enter: 'card'` (y el pack Prism lo usa por defecto): el cue se dibuja como cuadrado del 80 % del ancho, centrado, con sombra `0 30px 80px rgba(0,0,0,.35)`, `translateY((1 - cardLanding) · 900px)`; el metraje de fondo se desenfoca mientras la tarjeta está (`focusSpans` += spans de cues `card`).
- [ ] **Step 5:** gate visual contra `prism-pro.mp4` t=9.07 (whip) y t=10.30 (tarjeta); `set_transitions` y `set_audio sfx` ya cubren el whoosh. Commit `"prism: diagonal whip with scale, reel opening, B-roll card with a long landing"`.

### Task 1.5: pack Prism completo y corrida de paridad

- [ ] Actualizar `desc` del preset `prism` y el skill (`reel-plan`: "prism: cues de B-roll en tarjeta, whip diagonal entre tomas").
- [ ] Corrida headless en `pruebaeditoria` con el brief de la corrida 9; `motion_proof` en tres momentos; comparar con `motion-compare` contra el preview. Anotar en `reports/`.
- [ ] Commit.

---

## Fase 2 — Paquete de transiciones (2–3 días)

Todas son funciones puras en `transitions.ts` que devuelven, además de `Fx`, una **máscara** (`clip-path` CSS) o un **flash**; `ClipMedia` y `MultiClipVideo` solo pintan. Cada tarea: test de la función (valores en frame 0, medio y final), gate visual contra el preview indicado, commit.

### Task 2.1: flash blanco y desenfoque cruzado
- `'flash'`: 2 f a blanco + 4 f de fade (Stack 3.61). `Fx.flash: 0..1` → `MultiClipVideo` pinta un `AbsoluteFill` blanco con esa opacidad por encima de los clips y del B-roll, debajo de captions.
- `'crossBlur'`: 5 f, saliente blur 0→30 px y opacidad 1→0 mientras la entrante blur 30→0 (Prime 9.98, Linen). Necesita `OVERLAP` como `card`/`split` (ya existe el mecanismo).
- Referencias: `stack.mp4` 3.61, `prime.mp4` 9.98.

### Task 2.2: spin blur con flash (Prime) y blur + RGB + flash (Impact II)
- `'spin'`: 6–11 f; blur rotacional ≈ tres copias rotadas `±4°` alrededor del centro de la cara (usar `transformOrigin: 50% 38%`, como el punch) + blur 20 px + flash blanco al 100 % en el frame central. Referencia `prime.mp4` 3.06 y 4.77.
- `'rgbFlash'`: 3 f blur 0→20 px con separación RGB creciente (dos copias `mix-blend-mode: screen` desplazadas ±6 px en rojo y cian), 1 f blanco, 4 f de enfoque del clip nuevo. Referencia `impact-ii.mp4` 7.26.
- Pulso glitch (`MultiClipVideo`, pack impact): `glitchPulse(frame)` 6 f de blur+RGB cada N s sin corte, y **punch-in 1.12 en 3–4 f** en cada tier 2 (`focusSpans` reutilizado como `punchSpans`).

### Task 2.3: máscaras geométricas
- `'bands'`: tres franjas horizontales apiladas (colores del pack: acento, acento oscuro, marino) que suben 16 f cubriendo 8 f y revelando 8 f; dirección alterna por uso (Focus 3.40 / 5.48). Implementación: tres `div` con `translateY` interpolado, lineal.
- `'polyWipe'`: máscara poligonal diagonal desde abajo-derecha en 6–7 f con borde de dos colores (Lift 3.52); `clip-path: polygon(...)` con el vértice interpolado.
- `'clock'`: barrido radial horario 13–21 f, `clip-path` con `conic-gradient`-mask (usar `mask-image: conic-gradient(black var(--a), transparent 0)`); Y2K 3.00.
- `'mosaic'`: rejilla 6×11 de cuadrados que crecen 8 f (`scale` por celda desde 0) y encogen 8 f; Y2K 5.79.
- `'disc'` (Orbit): `clip-path: circle(r at x y)` con el centro fuera de una esquina y r 0→160 % en 4–8 f (ease-out) para entrar, 7 f (ease-in) para retirarse; el B-roll en círculo: `circle(r at 40% 45%)` r 0→~46 % en 11 f, salida 3–4 f a 0 hacia arriba-izq.; anillo decorativo = `div` con `border` que rota ~70°/s.
- `'blocks'` (Vista): 5 columnas de anchos distintos cuya altura salta cada 2–4 f (ruido determinista por columna, semilla = índice) formando un skyline; como frontera de split, `clip-path: polygon` escalonado que sube 12 f y baja 7 f.
- `'triangles'` (Vista): rejilla de ~6×11 triángulos rectángulos (`clip-path: polygon` por celda) que se encienden desde abajo-der. en 11 f con retardo por distancia y se apagan hacia la der. en 10 f; opacidad por celda con jitter ±10 %.
- `'markerMask'` (Sketch): máscara con borde rugoso (PNG de borde generado una vez con ruido) que destapa un título de der. a izq. en 4 saltos (8–9 f) y lo borra en 3 (7 f).
- `'blinds'`: persianas verticales de anchos distintos que se ensanchan 6 f y se retiran 4 f con whip horizontal (Form 0.50).

### Task 2.4: partículas y papel (texturas)
- `'particles'`: disolución de izquierda a derecha 4–7 f (Form 7.88): máscara `linear-gradient` con borde ruidoso (`mask-image` compuesto por un PNG de ruido generado una vez con ffmpeg `nullsrc + noise` en `public/sfx/../noise.png` — generado, no dibujado) que avanza; sin sistema de partículas real (ponytail: el borde ruidoso da el 90 % del efecto).
- `'tear'`: papel rasgado 16 f (Paper II 6.68): dos capas PNG de periódico (asset buscado con `search_asset`, CC0) que entran en diagonal y se retiran; requiere `mcp/assets.mjs` → Fase 4 si no hay asset.
- `'lightLeak'` (Lens): capa cálida/rosa `mix-blend-mode: screen` que aparece en 1–2 f y se apaga en 3–5 f, a pantalla completa con pico en el frame central del cambio de layout; imagen generada con `generate_asset` una sola vez y cacheada en la librería (dos variantes: cálida y rosa).
- `'cardDrop'` (Pop): la tarjeta entrante cae desde fuera del borde superior girando −15°→0° en 4–5 f ease-out sobre la anterior; el vídeo base se encoge a 0.85 en 3 f. Sin blur.

---

## Fase 3 — Movimiento de títulos y gráficos (2–3 días)

`graphicTemplates.ts` añade a toda plantilla de texto tres props opcionales con default por pack: `reveal: 'blur' | 'letters' | 'typewriter' | 'shuffle' | 'tracking' | 'drop' | 'slideBlur' | 'band' | 'wipe'`, `out: 'cut' | 'fade' | 'letters' | 'blur' | 'slideUp' | 'band'`, `life: 'none' | 'grow' | 'marquee' | 'drift' | 'oscillate'`. `Graphics.tsx` implementa cada uno con `motion.ts`:

### Task 3.1: revelados
- `letters`: máscara que avanza letra a letra con blur (8 f para 8 letras; Elevate "Momentum", Prime "Progress"): `clip-path: inset(0 X% 0 0)` + blur 10→0 en la letra frontal (aprox. con `filter` en un `span` por letra).
- `typewriter`: caja negra que crece con el texto, 2–3 chars/frame (Paper II) o 1 letra/frame (Align); `span` por letra con `visibility` por frame.
- `shuffle`: 7 f de letras aleatorias deterministas (semilla = id del gráfico) que se resuelven de izquierda a derecha (Align).
- `tracking`: letter-spacing 0.7→0.38 em en 9 f (ya en `chapter-caps`; generalizar).
- `drop`, `slideBlur`, `band` (banda que sube 4 f y recorta el texto), `wipe` (poly desde la izquierda 5 f, Lift "Faster Decisions").

### Task 3.2: salidas
- `letters` (escala a 0 de la última a la primera, 1.5 f entre letras; Form), `blur` (borrado derecha→izquierda 5 f; Elevate), `slideUp` (7 f ease-in; Lift), `band` (4 f; Focus), `fade` (6 f; Prime).

### Task 3.3: vida
- `grow`: escala 1.0→1.3 lineal en 1.2 s hasta desbordar (Prime "Progress").
- `marquee`: desplazamiento horizontal continuo ~17 px/frame de una fila de letras en contorno (Stack) — plantilla `oversized` con `repeat` y `life: 'marquee'`.
- `drift`: patrón de palabra repetida que deriva 50–80 px/s (Form fondo "RESULTS") — `big-word repeat` + `life: 'drift'`.
- `oscillate` + estela: marco neón que rota ±3° y deja una copia desfasada 4 f (Prime) — nueva plantilla `neon-frame` (SVG `rect` con `stroke-dashoffset` 3 f de dibujo, glow por `filter: drop-shadow`).
- `stamp` (Pop): escala 1.15→0.85 en 3 f para `starburst`; `pop` escalonado por pieza (3 f, 1–2 f entre piezas) para `sticker` en grupo (nuevo prop `stagger` en `add_graphic` para varios stickers).
- `punchWithTitle` (Orbit): `hook-stack`/`big-word` con `camera: 'punch'` → el clip base hace 1.0→1.4× en 8 f desde 3 f antes del título y vuelve a 1.15× en 5–6 f al salir (keyframes generados, no escritos por el agente).

### Task 3.4: trazos que se dibujan (SVG, geometría pura, permitido por AGENTS.md)
- `scribble-ellipse` alrededor de un gráfico o palabra (Sketch), `underline`, `outline-rect` que se dibuja 11 f y luego se expande (Evo 7.77), `border-light` (segmento de luz que recorre el borde de una tarjeta, Prime 3.47). Todos con `stroke-dasharray/dashoffset` interpolados.

---

## Fase 4 — Layouts, B-roll y decoración (3 días)

### Task 4.1: entradas de layout y B-roll
- `slideUp` con ease-out para splits (7–15 f; Elevate/Impact/Form/Focus) y salida `slideDown` con motion blur vertical 5 f.
- `popFrom`: B-roll que escala desde un punto (11 f) y sale escalando a 0 (9 f) (Evo).
- `frameIn`: el vídeo se encoge a un marco redondeado 8–9 f (Evo/Stack) y vuelve en 4 f; `inset` 0.85 en 6 f (Align); `tileScale` 1.0→0.55 en 10 f para splits editoriales (Align).
- `carousel`: tres paneles verticales, el central por fade 3 f y los laterales expandiéndose 4–5 f, paso con motion blur 2 f (Prime).
- `windows`: ventana estilo Mac OS clásico que entra con estela de 4–5 copias desfasadas y las recoge en 8 f (Y2K) — la ventana es un `layout` con `shape: 'window'`; las copias, `div` con opacidad decreciente.
- `cutout`: lienzo de color con la persona recortada (Stack rojo) = `layout canvas accent` + matte, ya existe; añadir `bg` que se funde en 2 f y sale en 4–5 f.

### Task 4.2: decoración
- `sticker` gana `anim: 'unfold'` (bolita que viaja hacia afuera 10–12 f escalando 0.15→1; Paper II) e `anim: 'pop'` ya existe; `ornament` estático (estrella ✳ de Elevate) que viaja con la costura del split.
- Iconos de esquina que aparecen 1–2 f (Stack), líneas finas de margen (Form, Elevate): plantilla `rules` (líneas verticales/horizontales de N px, sin animación).

### Task 4.3: contorno de la persona (Chalk) y packs B/C
- Contorno dibujado: borde del matte (ya existe la máscara VP9 con alfa) → `feMorphology` dilate + `feColorMatrix` amarillo, dibujado con `stroke-dashoffset` sobre el contorno vectorizado por `potrace`? No: usar el matte como máscara de un `div` amarillo dilatado 6 px (`filter: drop-shadow` ×3) detrás de la persona — barato y determinista.
- Packs `paper`, `pop`, `chalk`, `sketch`, `y2k`, `lens`, `align` completos cuando existan sus texturas/stickers en la librería (Fase 2.4 y `mcp/assets.mjs`).

---

## Fase 5 — Style packs y gate subjetivo (1 día)

### Task 5.1: `src/stylePacks.ts`
```ts
export type StylePack = {id: string; captions: PresetId; opening: 'none' | 'zoomBlur' | 'blurIn'; transition: Enter; brollEnter: BrollEnter; titles: {reveal: Reveal; out: Out}; canvas?: 'accent' | 'dark' | 'light' | 'gradient' | 'paper' | 'grid'; palette: {accent: string; bg?: string}};
export const PACKS: Record<string, StylePack>; // 20 entradas, una por estilo del catálogo
```
`set_caption_style` pasa a `set_style` (alias conservado): fija el preset de captions y los defaults del pack para `add_graphic` (reveal/out), `set_transitions` (tipo por defecto), `add_broll` (enter) y la apertura. El agente sigue eligiendo qué y dónde.

### Task 5.2: gate
- `scripts/motion-compare.mjs` en modo lote: para cada pack, 3 momentos (llegada de palabra clave, transición, título) nuestra tira contra la del preview → `reports/motion-gate-<fecha>.md` con las hojas. Felipe decide qué estilos pasan.

---

## Orden y estimación

| Fase | Entrega | Días |
|---|---|---|
| 0 | `motion_proof`, `motion-compare` | 0.5 |
| 1 | Prism Pro al 100 % (fantasma+brillo, karaoke por caja, whip diagonal, apertura, tarjeta) | 1.5 |
| 2 | 12 transiciones nuevas + pulso/punch de Impact | 2.5 |
| 3 | Revelados/salidas/vida de títulos + trazos dibujados | 2.5 |
| 4 | Layouts, carrusel, ventanas, stickers unfold, contorno Chalk | 3 |
| 5 | 20 style packs + gate | 1 |

Riesgos: (1) coste de render de `filter: blur` y `backdrop-filter` en 1080×1920 — medir con `render draft` tras la Fase 1 (hoy 48 s ≈ 65 s de render; tope aceptable 2×); (2) medir texto con canvas exige que la fuente esté cargada (los loaders de `fonts.ts` la esperan con `delayRender`, verificar en el primer frame); (3) el `mask-image` con `conic-gradient` y `clip-path: polygon` animados son CSS puro, deterministas por frame; (4) texturas (papel, periódico, light leak) dependen de assets con licencia: si `search_asset` no da nada, esos tres efectos van con `generate_asset` una sola vez y se cachean.
