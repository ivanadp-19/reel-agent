# Premium caption system: design spec (autobroll / reel-agent harness)

## 0. Summary

- **What's missing is a style system plus per-word decisions and a verification loop. Transcription and timing already work.** autobroll already gets WhisperX word timings, places pages by where the face is, and has an MCP surface. It lacks presets, per-word animation, emphasis tiers, emoji, sound effects, safe zones and a way to check the result.
- **Keep Remotion as the renderer.** Presets become plain data objects, and every animation is a small TypeScript function of the current frame. The LLM, Claude Code or Codex, only sends word annotations as JSON over MCP. Deterministic code handles timing, paging, layout, budgets and validation.
- **Three problems in today's code need fixing first**, because the premium presets depend on them:
  1. **`edit_caption` destroys word timing.** In `mcp/server.mjs`, "words are re-timed evenly across the page", which throws away the WhisperX timings that karaoke and word-by-word reveal need. Fix: keep the original timings for words that didn't change, and only interpolate timings for the edited ones.
  2. **The glue-word list is English only.** The `GLUE` set in `scripts/captions-multiclip.mjs` has no Spanish words, so Spanish pages can end on "de", "la", "que" or "y".
  3. **Captions can land in the platform UI.** `MAX_TOP=72` plus `BLOCK_PCT=9` lets the caption block reach about 81% of the frame height (about 1555 px), which is inside the bottom UI band defined in §3. `BLOCK_PCT` also assumes 62 px text on 2 lines, which is wrong for presets at 92–120 px. The block height must come from the preset.

---

## 1. Data model

```ts
// Project level. Replaces p.accentColor, which stays as an alias for overrides.colors.accent.
type CaptionStyle = {
  preset: PresetId;              // 'clean'|'bold-pop'|'beast'|'pill'|'karaoke'|'boxed'|'serif'|'hype'
  variant?: string;              // a palette defined by the preset
  overrides?: DeepPartial<Preset>; // brand kit: colors.accent, font.family, font.sizePx, ...
  platform: 'universal'|'tiktok'|'reels'|'shorts'|'reels-ads';  // selects the safe-zone profile (§3)
  locale: string;                // 'es-MX'|'es-ES'|'en-US'...; drives Intl.NumberFormat, the glue list and uppercasing
};

type Tier = 0 | 1 | 2 | 3;  // 0 plain, 1 accent color, 2 emphasis (color + size + animation), 3 hero (own page, supersize, may carry SFX)
type ColorRole = 'accent' | 'accent2' | 'negative';  // key idea / numbers and results / warnings, "no", "nunca"

type CaptionWord = {            // times stay SOURCE-relative ms, as today
  text: string; startMs: number; endMs: number;
  tier?: Tier;                  // replaces accent:boolean (accent:true becomes tier 1)
  role?: ColorRole;             // defaults to 'accent' when tier >= 1
  emoji?: string;               // codepoint sequence, e.g. "1f92f"; the tool also accepts the literal character
  sfx?: 'whoosh'|'pop'|'ding'|'boom'|'click'|'cash';
  anim?: AnimId;                // overrides the preset's word entrance (rarely needed)
  brk?: 'line'|'page';          // forced break AFTER this word
};

type Caption = {                // one page; existing fields kept
  id: string; clipId?: string; words: CaptionWord[];
  startMs: number; endMs: number;
  topPct: number;               // set by the placer (§3)
  pinned?: boolean;             // set when the LLM or user chose topPct; the placer won't move it
  hero?: boolean;               // page built by the pager for a single tier-3 word
  scale?: number; holdMaxMs?: number;
};

type Anim = {type: AnimId; ms: number; ease: 'outCubic'|'outQuart'|'outBack'|'inOutCubic'|'linear'; from?: number; rot?: number};
type TierStyle = {color?: 'accent'|'accent2'|'text'; scale?: number; weight?: number; anim?: Anim; glowPx?: number; font?: string};
type Preset = {
  id: PresetId;
  font: {family: string; weight: number; sizePx: number; case: 'upper'|'none'; tracking: number; lineHeight: number};
  colors: {text: string; dim?: string; accent: string; accent2: string; negative: string; stroke?: string; box?: string; boxText?: string};
  strokePx: number;             // 0 = none
  shadow: string;               // CSS text-shadow
  box: 'none'|'line'|'pill-active';
  reveal: 'page'|'word';        // 'page' shows the whole page at once; 'word' shows each word at its onset
  active: {mode: 'none'|'color'|'scale'|'pill'|'fill'; scale?: number};
  wordIn?: Anim; pageIn: Anim; pageOut: Anim;
  tiers: {1: TierStyle; 2: TierStyle; 3: TierStyle};  // tier 3 always gets its own page
  layout: {maxWords: number; maxLines: 1|2; maxCharsLine: number; anchorY: number};  // anchorY = preferred block center, 0..1
  emoji: {on: boolean; pos: 'above'|'after'; sizeEm: number; anim: Anim};
  sfx: {tier3?: SfxId; gainDb: number};
};
```

**What the LLM sends** through the new MCP tool `annotate_captions`. Words are addressed as `{cap, w}`, the ids `get_project` prints (see §3.1):

```json
{"items":[
  {"cap":"c0","w":3,"tier":3,"emoji":"1f92f","sfx":"whoosh"},
  {"cap":"c2","w":1,"tier":1,"role":"accent2"},
  {"cap":"c4","w":4,"tier":2,"role":"negative","emoji":"274c"},
  {"cap":"c5","w":0,"text":"10.000"}
]}
```

**What the tool returns:** it applies the annotations, re-pages around tier-3 words, re-places pages that aren't pinned, validates, and returns lines like these:

```
ERR c4: 2 tier-2 words (max 1 per page)
ERR c7 w2 "de": tier on a function word
WARN emoji every 2.1s on average (target >= 3s)
OK 23 pages, 9/148 words tiered (6.1%)
```

**Other MCP changes, kept small:**

- `set_caption_style({preset, variant?, overrides?, platform?, locale?})`. `set_accent_color` becomes an alias for it.
- `edit_caption` gets `pos: 'auto'|number` and the timing fix from §0.
- `caption_proof` is described in §5.
- `run_ai_step captions` stays as the path for editor-button users with no LLM agent. Its Gemini accents map to tier 1.

---

## 2. Starter preset catalog (8)

All sizes are px on a 1080-wide frame. All fonts are OFL. I checked `google/fonts` METADATA: Anton, Bangers, Archivo Black, Instrument Serif, League Spartan and Montserrat all include `latin-ext`, which covers á, ñ, ¿ and ¡. Inter and Poppins come from the earlier report. Every animation is a function of the frame (library listed after the presets). "Cut" means 0 ms.

| # | id | Type | Color, stroke, shadow | Highlight behavior | In / out | Paging |
|---|---|---|---|---|---|---|
| 1 | **clean** (default; today's look, upgraded) | Inter 700 (tiered words 800), 64 px, sentence case, tracking −0.01em, line-height 1.2 | #FFF; other words at `rgba(255,255,255,.75)`; accent = brand color (default #FFB020). No stroke. Shadow `0 2px 4px rgba(0,0,0,.5), 0 0 24px rgba(0,0,0,.35)` | Active word goes to full white at 1.04× (2-frame ease). T1: accent color. T2: accent, 1.12×, pop 160 ms. T3: own page at 1.6×, pop | Page rises 14→0 px with a fade, 160 ms outCubic. Out: fade 140 ms inOutCubic | ≤5 words, ≤2 lines, ≤20 chars per line; anchor 62% |
| 2 | **bold-pop** (Hormozi-type; Anton replaces TheBoldFont, which can't be bundled) | Anton 400, 92 px, uppercase, tracking +0.01em, line-height 1.05 | #FFF; T1 #FFE500, T2 #2BFF88, negative #FF3B30; 9 px black stroke; shadow `0 5px 0 rgba(0,0,0,.45)` | Words appear as spoken. Active word held at 1.08×. T3: own page at 1.5×, slam, `whoosh` | Each word: pop 0.5→1, 140 ms outBack(1.7), opacity 0→1 in the first 60 ms. Page out: cut | ≤4 words, ≤2 lines, ≤14 chars; anchor 64%. Emoji above the line, 1.1em, pop 180 ms |
| 3 | **beast** (MrBeast-type; Bangers replaces Komika Axis, whose license is a gray area) | Bangers 400, 104 px, uppercase, tracking +0.02em, line-height 1.0 | #FFF; accent #3CFF3C, accent2 #FFD400, negative #FF2D2D; 12 px black stroke; shadow `0 8px 0 #000` | The page is the active unit. T1: accent with a 16 px glow in the accent color. T2: also 1.2×. T3: 1.5×, `boom` | Page slams in: scale 1.45→1, rotation ±4°→±2° (sign alternates by page index, so it's deterministic), 120 ms outBack(2). Out: cut | ≤2 words, 1 line, ≤12 chars; anchor 60%. Emoji after the word, 1em |
| 4 | **pill** (active-word background, like Submagic and Captions) | Montserrat 800, 68 px, sentence case (`upper` variant available), line-height 1.3 | #FFF text. Pill colors by variant: violet #7C3AED with white text, lime #C6FF00 with black, red #FF3B30 with white. No stroke. Shadow `0 3px 12px rgba(0,0,0,.55)` | Pill behind the active word: radius 16, padding 2×14, enters at 0.85→1 with a fade over 90 ms outCubic. T1 is #FFE500 while inactive. T2: 1.1×. T3: own page at 1.4× | Page: fade plus scale 0.94→1, 150 ms outCubic. Out: fade 120 ms | ≤5 words, ≤2 lines, ≤20 chars; anchor 64%. Emoji above, 0.9em |
| 5 | **karaoke** (left-to-right fill) | Poppins 800, 70 px, uppercase, line-height 1.15 | Unspoken text #FFF; spoken fill #FFD60A; 6 px black stroke; shadow `0 4px 10px rgba(0,0,0,.5)` | Fill sweeps across each word, linear from `startMs` to `endMs`. T1 fills #00E5FF. T2: 1.1×. T3: own page | Fade 100 ms in and out | ≤6 words, ≤2 lines, ≤18 chars; anchor 66%. No emoji |
| 6 | **boxed** (TikTok-native look; also the contrast fallback) | Inter 700, 54 px, sentence case, line-height 1.35 | #111 text on a #FFF box per line: radius 12, padding 6×16, `box-decoration-break: clone`, box shadow `0 4px 14px rgba(0,0,0,.25)` | No active highlight. T1: the word gets its own #FFE500 box. T2: also weight 900. T3: own page at 1.3× | Rise 24 px with a fade, 180 ms outQuart. Out: fade 100 ms | ≤7 words, ≤2 lines, ≤24 chars; anchor 66% |
| 7 | **serif** (understated; emphasis comes from switching typeface) | Inter 500, 56 px, sentence case, line-height 1.2; T1 and T2 switch to Instrument Serif Italic 400 at 1.15× | #FFF (cream variant #F3E3C3). No stroke. Shadow `0 2px 18px rgba(0,0,0,.55)` | No active highlight; emphasis is the serif italic. T3: own page, serif italic at 1.8× | Words appear as spoken: blur 10→0 px, opacity 0→1, y 8→0, 240 ms outCubic. Page out: fade plus blur 0→6 px, 160 ms | ≤7 words, ≤2 lines, ≤26 chars; anchor 64%. No emoji or SFX |
| 8 | **hype** (one word per beat) | Archivo Black 400, 120 px, uppercase, tracking −0.01em | #FFF; accent #FF3D7F, accent2 #FFE500; 8 px black stroke; shadow `0 6px 0 rgba(0,0,0,.4)` | T1: accent. T2: accent, 1.2×. T3: 1.5×, `whoosh`, plus a `punch` hint sent to the zoom track | Pop 1.3→1, 80 ms outCubic. Out: cut | 1 word per page; glue words merge forward ("DE LA", "IN THE", ≤12 chars); anchor 55%; minimum page 200 ms. Emoji above, pop |

**Shared animation library** (about 80 lines of TS). Easing uses Remotion's `Easing`; I confirmed that `Easing.back(s)`, `bezier` and `elastic` exist in the installed 4.0.380.

| id | What it animates | Defaults |
|---|---|---|
| none / cut | nothing | – |
| fade | opacity 0→1 | 120 ms outCubic |
| rise | translateY(d→0) and opacity | d = 14 px, 160 ms outCubic |
| pop | scale s0→1; opacity reaches 1 in the first 40% | s0 = 0.5, 140 ms outBack(1.7) |
| slam | scale s0→1 and rotation r0→r1 | s0 = 1.45, 120 ms outBack(2) |
| blur | blur(b→0), opacity, y 8→0 | b = 10 px, 240 ms outCubic |
| typewriter | visible characters = ceil(p · length) | 30 ms per character |
| drop | translateY(−40→0) | 180 ms outBack(1.4) |

**Emoji:** rendered from Noto SVG images. The noto-emoji README says its image resources are Apache-2.0 and its fonts OFL. The license of the animated Noto emoji (Lottie/WebP) is **[UNVERIFIED]**.

**SFX:** a pack of 6 CC0 files (the license must be checked per file, since pycaps' bundled mp3s have an unchecked license). Mixed at −12 dB relative to the voice. `whoosh` starts 150 ms before the word; the others start at the word's onset.

---

## 3. What the LLM decides and what the rules decide

### 3.1 LLM decisions (Claude Code or Codex, through MCP)

What the LLM gets:
- The transcript as it appears in `get_project`, with page ids, word indices and `‖` marking pauses over 450 ms.
- The face band for each clip.
- The preset catalog, placed in the `set_caption_style` tool description.

At 150–180 words per 60 s reel, this is a small input.

What the LLM decides:

| Decision | Hard limits the validator enforces (errors go back to the LLM so it can fix them) |
|---|---|
| Preset and variant for the video, based on tone, niche and brand | The id must exist |
| Tier for each word (0–3) and its color role (accent, accent2 for numbers and results, negative for warnings) | Tier ≥1 on at most 12% of words. Tier 2: ≤1 per page and ≤1 per 3 s. Tier 3: ≤1 per 8 s and never on consecutive pages. No tiers on function words (ES and EN lists) |
| Emoji: which words, which glyph, including cultural fit for Spanish vs English audiences | ≤1 per page, pages with emoji ≥2 s apart, glyph must be in the Noto set |
| SFX on hero moments | ≥2.5 s apart; tier-3 words or explicit only |
| Text fixes: brand names, transcription errors, spelled-out numbers turned into digits | The normalized text may differ from the transcript only on the edited words |
| Forced breaks (`brk`) to split a setup from its punchline | The page must still meet the minimum duration |
| Fixes after a vision critique (§5) | Same limits as above |

### 3.2 Deterministic rules (code, never the LLM)

**Timing (constants):**

- `PAGE_LEAD_MS = 100`: the page shows 100 ms before its first word, but never before the previous page ends. Opus recommends 100–200 ms early.
- `WORD_LEAD_MS = 50`: a word's entrance animation starts 50 ms before the audio onset.
- `HOLD_MAX_MS = 700`: already in the code today. Gaps under 250 ms to the next page are bridged, so there's never a blank flash.
- `MIN_PAGE_MS = 330` (200 for hype): shorter pages merge with a neighbor.
- The active word stays active until the next word starts if the gap is under 250 ms, so the highlight doesn't flicker.
- `SYNC_TOL_MS = 80`: for words whose text didn't change, timing must stay within 80 ms of the transcript. This check is borrowed from HyperFrames.

**Paging and line breaks** (extends `buildCaptions` and moves it into a module that both the pipeline script and the MCP server import):

- **Hard breaks:** sentence end (`.?!`), clip boundary, pauses over 450 ms, `brk`, and on both sides of a tier-3 word.
- **Soft breaks:** clause punctuation (`,;:`), and the preset's `maxWords` or `maxCharsLine`.
- **Never** end a line or page on a glue word. Add a Spanish list: *de, del, la, el, los, las, un, una, y, e, o, u, que, en, a, al, por, para, con, sin, se, lo, le, me, te, nos, mi, tu, su, es, muy, más, no, si, pero, como*.
- **Keep together:** number plus unit ("10 mil", "$5", "3x", "20%"), `¿`/`¡` with the next word, and name pairs.
- **Two-line pages are balanced by character count,** keeping line 1 no more than 4 characters longer than line 2.
- **Numbers:** when the LLM asks for digits, use `Intl.NumberFormat(locale)`. `es-MX` gives 10,000 and `es-ES` gives 10.000.
- **Uppercasing:** CSS `text-transform: uppercase` with `lang="es"`, so accents survive (á becomes Á).
- **Autofit at render:** measure with the browser's native canvas `measureText`, which needs no dependency, and shrink the font down to 0.8× at most to fit the maximum width. Below 0.8× the validator fails the page, and the pager splits it.

**Placement** (replaces `faceToTop`):

1. Block height `H = lines × sizePx × lineHeight + 2 × strokePx`, plus `1.1 × emoji size` when the emoji sits above the line.
2. Try each top position `y` from the safe top down to `safeBottom − H`, in 10 px steps. Score each:
   ```
   cost = 1e6·overlap(block, critical face band)   // eyes to chin: [face.top + 0.25h, face.bottom]
        + 1e3·overlap(block, whole face box)
        + 1e3·overlap(block, B-roll / motion-graphic rects)   // the B-roll layer must export these
        + |blockCenter − anchorY·1920|
        + 200·(y differs from the previous page on the same clip)   // stability
   ```
3. Take the lowest cost. Pinned pages are skipped.
4. Face box: keep today's per-clip Gemini box, which is cached. Only move to per-second detection if the vision check keeps flagging overlaps.
5. While a full-frame B-roll is on screen, the face terms are turned off.

**Safe zones, 1080×1920, in px.** Every value here comes from third parties or is my estimate, and the whole table is **[UNVERIFIED]**:

| Profile | Top | Bottom | Left | Right | Basis |
|---|---|---|---|---|---|
| tiktok | 160 | 440 | 60 | 140 (action rail, roughly y 700–1600) | Third-party ranges: 130–200 top, 334–484 bottom, 120–140 right |
| reels (organic) | 220 | 420 | 65 | 130 | My estimate |
| reels-ads | 269 | 672 | 65 | 65 | Meta's 2026 figures of 14% / 35% / 6% (checked only against a third-party page, not Meta's official docs) |
| shorts | 180 | 400 | 60 | 150 | My estimate |
| **universal (default)** | **270** | **480** | **140** | **140** | Maximum of the organic rows, with equal side margins so captions stay centered. The caption box must fit in **y 270–1440, x 140–940 (800 px wide)** |

**How to calibrate the safe zones:** the user posts a flat gray 1080×1920 test video (as a draft or private post) to each app and takes a screenshot. The screenshots are saved as `assets/safezones/{platform}.png` masks. The geometry check in §5 tests against those masks, and the table above is only the fallback.

---

## 4. Rendering engine: stay on Remotion

**Why Remotion:**

- autobroll already runs on it (4.0.380), and the editor preview (Player) and the MP4 export share the same renderer.
- It renders every frame in Chromium. The `@remotion/renderer` in node_modules lists `TESTED_VERSION` Chrome 134. That gives the full CSS and SVG vocabulary: stroke, background-clip text, blur filters, `box-decoration-break`.
- Color emoji work as images, and SFX go on the same timeline with `<Audio>`.
- The B-roll and motion-graphics layer will use the same engine, so captions and graphics can avoid each other.

**Implementation rules:**

- Every animation is `f(frame)` computed with `interpolate` and `Easing`. Never use CSS `@keyframes` or `transition`, because they aren't locked to Remotion's frames.
- **Structure:** `CaptionTrack` → one `<Sequence>` per page → `Page` (preset, autofit, placer output) → `Word` (local time `t = absMs − startMs`, animation function, tier style, active mode).
- **Stroke:** two stacked copies of the text. The bottom copy has `-webkit-text-stroke: 2×strokePx` and the shadow; the top copy is the fill. `paint-order: stroke fill` on HTML text should work in Chrome 134 and would halve the DOM nodes, but that's **[UNVERIFIED]**; check it with one still.
- **Karaoke fill:** `background: linear-gradient(90deg, fill p%, text p%)` with `background-clip: text`, drawn over the stroke copy.
- **Fonts:** bundle OFL woff2 files in `public/fonts`, load them with `FontFace`, and hold the render with `delayRender` until they're ready. The render must never fall back to macOS system fonts. That matters most for emoji, because Apple Color Emoji can't be licensed for this use, so emoji are always `<Img>` of Noto SVGs.
- **SFX:** `<Sequence from={wordFrame − lead}><Audio src={staticFile('sfx/…')} volume={…}/></Sequence>`.
- **Remotion license:** according to the earlier report, it's free for companies with up to 3 employees; a larger company needs a paid license **[UNVERIFIED terms; check before any commercial launch]**.

**Rejected as the engine:**

| Candidate | Why not the engine | What to borrow instead |
|---|---|---|
| ASS/libass | No color emoji (libass issue #381) and weak per-word motion | Use it only to export `.srt`/`.ass` |
| tscaps | Runs only in the browser via WebCodecs, not in Node | Its 38 MIT templates, through a paused-CSS test build in Phase 3 **[UNTESTED]** |
| HyperFrames | A second engine (GSAP plus a Python person cutout) | The DNA style fields, the hero-word rules and the luminance check |
| pycaps | Motion is raster transforms of one PNG per state | The pattern of triggering SFX from a word's tag |
| captioncat | Skia-based, 11 stars, only partly reviewed | Nothing for now |

---

## 5. Verification loop

**One new MCP tool, `caption_proof({pages?, platform?})`,** runs stages B to D and returns a report plus contact-sheet images. The existing `render draft` + `frame_at` tools can stand in until it's built.

| Stage | Cost | What it does | Pass criteria / automatic fix |
|---|---|---|---|
| **A. Validate** | ms, no render | Schema; budgets from §3.1; glue-word tags; timing is monotonic, words sit inside their page, pages meet the minimum duration, `SYNC_TOL_MS`; text drift from the transcript; unknown preset, emoji or SFX ids; estimated characters per line | Errors go back to the LLM as the tool result, and the LLM fixes them. Ship with one `node --test` file for the validator |
| **B. Geometry** | seconds | Render **caption-only** transparent PNG stills with `@remotion/renderer`, bundling once and calling `renderStill` for each frame, with the input prop `layers:'captions'`. Probe frames: each page's fullest state (last word start + entrance time + 1 frame), each hero word at its peak overshoot, and the hook at t = 1.0 s. At most 24 probes. The bounding box comes from the alpha channel via `ffmpeg -vf alphaextract -f rawvideo -pix_fmt gray` and a byte scan, so no new dependency | The box stays inside the safe zone, or inside the mask when one exists. It doesn't touch the critical face band or the B-roll rects. Its height stays under `maxLines × lineHeight × 1.2`, which catches unexpected wrapping |
| **C. Contrast** | seconds | Composite still at the same frames; compare the text fill's luminance with the median of a 12 px ring around the caption alpha | Contrast ≥4.5:1, or ≥3:1 when the stroke is at least 4 px or a box is present. Automatic fix: add a 4 px black stroke, or switch to the `boxed` look for that page |
| **D. Vision critique** | about 1 LLM call | Contact sheet: 12 stills at 360×640 in a 4×3 grid, labeled with page id and time, with a translucent red safe-zone overlay; plus a 6-frame strip of one hero entrance. Scoring rubric returned as JSON: `[{page, severity 1-3, issue: covers_face\|illegible\|wrong_emphasis\|emoji_mismatch\|typo\|missing_accent_mark\|too_busy\|off_brand, fix}]` | The LLM applies fixes through the edit tools; stages B–D then run again only on the pages it touched. **At most 2 rounds**, stopping early when no issue has severity ≥2. Claude Code sees MCP image results today, as `frame_at` already shows. Codex's support for images in MCP results is **[UNVERIFIED]**; the fallback is to run this critique on the Gemini vision call autobroll already has (`gemini.mjs` accepts `imagePath`) and return only text |
| **E. Golden regression** | CI | Fixed 10 s Spanish and 10 s English test clips; each preset's probe stills compared with committed PNGs using ffmpeg `ssim` | SSIM ≥0.98. Catches presets broken by CSS edits |
| **F. Final audio** | seconds | ffmpeg `ebur128` on the render | −14 LUFS ±1, true peak ≤ −1 dBTP |

---

## 6. Build order

1. **Core:**
   - The three fixes from §0.
   - The data model, including the `accent` → `tier` migration.
   - The 8 presets and the animation library.
   - Stroke copies, font loading and autofit.
   - The placer with the universal safe zone.
   - `set_caption_style` and `annotate_captions`.
   - The stage A validator and its test.
2. **Premium extras:** emoji (Noto SVG), the SFX pack, `caption_proof` with stages B, C and D.
3. **Later:**
   - The pill sliding between words (needs each word's x offset from `measureText`).
   - A hero word placed behind the speaker (needs a person cutout, as in tscaps and HyperFrames).
   - The tscaps paused-CSS template import test.
   - Golden tests.

Skipped on purpose: a different preset per page (a hook title belongs to the motion-graphics layer) and per-second face tracking. Add either only if the vision check shows it's needed.

**Unverified items:**

- All safe-zone pixel values.
- `paint-order` on HTML text in Chrome 134.
- The license of the animated Noto emoji.
- The license of each SFX file.
- Codex CLI support for images in MCP tool results.
- The tscaps paused-CSS approach inside Remotion.
- The render-time cost of blur and glow filters (measure it against the current render time).
- Remotion's license terms.
- Spanish glyph coverage for Inter and Poppins (taken from the earlier report; the other fonts' `latin-ext` subsets I checked myself).

The files this spec is based on:
- /Users/felipealonzo/autobroll/src/CaptionTrack.tsx
- /Users/felipealonzo/autobroll/src/captions.ts
- /Users/felipealonzo/autobroll/scripts/captions-multiclip.mjs
- /Users/felipealonzo/autobroll/mcp/server.mjs