**autobroll's captions are basic "highlight one word", and no open-source project matches Captions.ai or Submagic on its own. Don't fork one as the base. Keep Remotion and bring in parts from tscaps (MIT templates), HyperFrames and remotion-captions-kit.**

What I checked: I read the source through `gh api` and did not clone or run anything. The Remotion+tscaps integration in the recommendation has not been tested and needs a 1–2 day test build first.

## Where autobroll stands today
- `/Users/felipealonzo/autobroll/src/CaptionTrack.tsx` has one hardcoded style:
  - Inter font at weight 600/800.
  - Accent color `#FFB020`.
  - The word being spoken scales to 1.05×.
  - Each caption page fades in and out, and has a text shadow.
- `/Users/felipealonzo/autobroll/src/captions.ts`: each word carries only text, timing and an on/off accent (`CaptionWord {text,startMs,endMs,accent:boolean}`).
- What's missing: style presets, per-word entrance animation (pop, slam, bounce), emphasis levels, emoji, stroke/pill/box backgrounds, sound effects tied to words, text behind the speaker, and more fonts. The missing part is the style system, not transcription.

## Candidates

| Project | License / activity | How it renders | Premium features actually found in the code | Quality ceiling | How an LLM would drive it |
|---|---|---|---|---|---|
| **@remotion/captions** ([packages/captions](https://github.com/remotion-dev/remotion/tree/main/packages/captions)) | package.json says MIT (v4.0.527). Remotion itself is under the [Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md): free for companies with up to 3 employees, paid above that. Very active. | No rendering. Data only. | A `Caption` type, SRT parse/serialize, and `createTikTokStyleCaptions`, which only splits words into pages by a time window or a silence gap. No styling. | n/a | Data model only |
| **remotion-dev/template-tiktok** ([repo](https://github.com/remotion-dev/template-tiktok)) | No LICENSE file (README points to the Remotion license). 281★, pushed 2026-09-05 | Remotion/React | `Page.tsx`: text fitted to width, uppercase The Bold Font, 20px black stroke, the spoken word turns green `#39E508`, and each page enters with a 5-frame spring. That's all. | Basic ("one colored word") | Code |
| **pycaps** ([repo](https://github.com/francozanardi/pycaps)) | MIT, 215★, v0.2.1 alpha. Last code change Feb 2026, docs June 2026 | Python. CSS is rendered in Playwright, **one PNG screenshot per word per state**, then movielite moves/scales/fades them. CSS `@keyframes` never run. | JSON templates (12 presets: hype, explosive, word-focus…); fade/pop/bounce/slide/zoom/typewriter motion; tags on words; emoji in a segment plus emoji animation; 17 sound-effect mp3s triggered by tags; AI tagger using OpenAI gpt-4.1-mini (`PYCAPS_OPENAI_API_KEY`). Emoji selection calls the hosted `pycaps.com/api` with an API key. | Medium: the CSS look is real, but the motion is limited to raster transforms | JSON template plus tagger rules (good) |
| **tscaps** ([repo](https://github.com/francozanardi/tscaps)), same author as pycaps | Engine `@tscaps/engine` is **MIT**, `templates/` is **MIT**, the studio app is **AGPL-3.0**. No root LICENSE, so GitHub shows "none". 70★, created 2026-06-10, pushed 2026-09-18, pre-1.0 | Browser only. The caption DOM is drawn to an SVG `foreignObject`, then canvas, then WebCodecs encodes the mp4. The engine "does not run in Node". | **Paused-animation model**: every CSS animation is paused and positioned by per-element timing variables (`--on-<state>-starts/-ends`). Classes for `.segment/.line/.word/.letter/.word-decoration`, state and structure tags, semantic tags as CSS classes. 38 Sass templates, each with color variants and style controls. Per-word overrides, letter mode, a layer that can use the video's own pixels (frosted glass, blend effects), text behind the subject (on-device segmentation), right-to-left text, SRT/VTT/ASS export. The **local version has no LLM tagger**; only the hosted cloud version tags words automatically. | **High** (real CSS, SVG filters, per-letter, per-frame) | Template id + variant overrides + per-word tags. Best fit for an LLM. |
| **HyperFrames** ([repo](https://github.com/heygen-com/hyperframes)) | Apache-2.0, 52.7k★ per the API, pushed daily | HTML + GSAP rendered in headless Chrome | (a) 16 `registry/components/caption-*` blocks (kinetic-slam, emoji-pop, pill-karaoke, particle-burst, glitch-rgb…). Each is a standalone 1920×1080 demo with a hardcoded `WORDS` array: snippets, not a parameter-driven engine. (b) The `skills/embedded-captions` agent skill: 10 "DNA" style JSON files (motion levels with GSAP eases, hero "slam", dim-others, accent color sampled from the scene, contact shadow). A normal caption line plus the occasional big "hero" word placed **behind the speaker** using a person cutout (u2net_human_seg, CPU at about 2 fps at 1080p, 168 MB of weights). WhisperX run through `uvx`. Luminance and safe-zone checks, and a check that caption timing stays within 80 ms of the transcript. | **Highest** in the open-source set | DNA JSON plus theme/plan JSON. Built for agents, but it is a **second render engine** with Python and slow cutout processing |
| **captioncat** ([repo](https://github.com/ItisShikhar/captioncat)) | MIT, 11★, created 2026-08-18 | Node 22 + Skia Canvas + bundled FFmpeg | 36 JSON presets (banger, go-viral, karaoke-1, ig-sticker, imessage…), animation tracks and curves, OpenAI/ElevenLabs transcription adapters. I only checked the README, the file tree and one preset. | Medium-high (canvas-drawn, no CSS) | Pure JSON (most JSON-driven of all) |
| **remotion-captions-kit** ([repo](https://github.com/Fats403/remotion-captions-kit)) | MIT, 5★ | Remotion, built on @remotion/captions | Page breaks at sentence boundaries; 6 presets (KaraokeFill, KineticSlam, PillKaraoke, WeightShift, NeonGlow, EditorialEmphasis); emphasis rules that match words and apply a color or style. | Medium | Props |
| **remotion-captions-themes** ([repo](https://github.com/vshukla7/remotion-captions-themes)) / **remotion-captioneer** ([repo](https://github.com/neutral-Stage/remotion-captioneer)) | MIT, 9★ and 16★ | Remotion | 13 themes plus a collision-aware layout engine / 15 animation components plus emoji support | Medium | Props |
| **captacity** ([repo](https://github.com/unconv/captacity)) | MIT, 139★, **stale since 2024-06** | MoviePy + Pillow | Font, stroke, shadow blur, highlight the current word | Basic | Function arguments |
| **ASS/libass via ffmpeg** ([libass](https://github.com/libass/libass), ISC) | Mature | Burned in by ffmpeg | Word-by-word color fill (`\k`, `\kf`), scale pop (`\t(...\fscx120)`), fades, movement, rotation, blur, outline, clipping. Moving each word on its own means one subtitle line per word with positions you compute yourself. **No color emoji** ([issue #381](https://github.com/libass/libass/issues/381), still open). Real-world examples: [youtube-shorts-pipeline](https://github.com/rushindrasinha/youtube-shorts-pipeline) `verticals/captions.py` (changes the active word's color, bold and size); [clippyme](https://github.com/fralapo/clippyme) `generate_ass_karaoke`, 6 presets using `\k`. | Low-medium; fastest render | Text template |

**Avoid:**
- [Trianglezichopper/submagic-core](https://github.com/Trianglezichopper/submagic-core): 218★ but no license and no code. The README only sends you to an external Windows download and says to "run as administrator". Treat it as likely malware.
- [vanta](https://github.com/itsjwill/vanta) and [claude-shorts](https://github.com/AgriciDaniel/claude-shorts): their caption code is basic highlight-style (7 simple styles and 3 presets).
- Revideo's shorts example: basic.
- [twick](https://github.com/ncounterspecialist/twick): a general editor SDK, and GitHub can't identify its license.

## Fonts

| Font | License | Notes |
|---|---|---|
| Montserrat, Poppins, Inter, Anton, Bangers, League Spartan, Archivo Black | OFL (checked in [google/fonts](https://github.com/google/fonts) metadata) | All include latin-ext, so Spanish accents, ñ, ¿ and ¡ are covered. Safe to bundle and burn into videos. |
| Bebas Neue | OFL | Uppercase design only |
| The Bold Font (free version) | [dafont](https://www.dafont.com/the-bold-font.font) says "100% Free", but the file in template-tiktok says "All rights reserved" and gives no explicit right to redistribute | Uppercase only, 121 glyphs; Spanish accents not confirmed. The [Pro version](https://the-bold-font.com/) is paid, priced by company size. Don't bundle it without buying Pro. |
| Komika Axis | [Apostrophic Labs freeware](https://www.fontsquirrel.com/license/komika-axis) | Commercial use allowed, but no modification or repackaging and it "shall not be sold". Bundling it in a paid product is a gray area. |
| Emoji | [Noto Color Emoji](https://github.com/googlefonts/noto-emoji): OFL. [Twemoji](https://github.com/jdecked/twemoji): CC-BY 4.0, attribution required | Apple emoji can't be licensed for this |

## Recommendation
1. **Keep Remotion** (autobroll is already on 4.0.380) and don't bring in a second renderer. HyperFrames and captioncat are both separate engines.
2. **Add caption presets to autobroll's own `CaptionTrack`:**
   - The engine would reproduce tscaps' CSS rules (class names plus the `--on-*-starts/-ends` timing variables) and compute the variables from `useCurrentFrame`, with animations forced to paused.
   - This matches tscaps' own export model, and Remotion renders every frame in Chromium. So in principle the 38 MIT tscaps templates would render frame by frame without writing styles by hand.
   - The Sass templates would be compiled at build time.
   - This is the unverified part: test it for 1–2 days before committing.
3. **The LLM (Claude Code or Codex) only emits JSON through the existing MCP tools** (`add_caption`, `edit_caption`):
   - `{preset, variant, overrides, words:[{i, tags:["emphasis","hook","number"], emoji?, sfx?}], pageBreaks}`
   - Tagging words and choosing emoji is the part tscaps.io and Submagic do on their servers. In this setup the harness's LLM does it.
   - `CaptionWord.accent:boolean` becomes `tags[]` + `emoji` + `sfx`.
4. **Parts to borrow from other projects:**
   - remotion-captions-kit: page breaks at sentence boundaries, and its 6 MIT presets as a fallback if the test in step 2 fails.
   - HyperFrames: the DNA style fields, the "normal line plus rare hero word" rules, and the luminance check.
   - pycaps: the pattern of triggering a sound effect from a word's tag. I didn't check the license of its bundled sound files.
   - Later, text behind the speaker: needs a person cutout, done on-device in tscaps and with u2net in HyperFrames.
5. **Use ASS only to export .srt/.ass files**, not for burned-in premium captions: no color emoji and limited motion.