# Layered render benchmark

Question: what does a caption edit cost with the one-pass render (before) and with
the layered render (after: cached master + caption layer + composite)? And is the
layered file the same picture?

Machine: cloud container, 4 vCPU, 15 GB RAM, no GPU (not the production VM). No
8-vCPU box was available; the 2-vCPU numbers are the same container pinned to two
cores (`taskset -c 0,1`, `REEL_RENDER_CONCURRENCY=2`).

## Method

`node scripts/layers-bench.mjs [--draft] [--pack focus] [--alpha-compare] [--font-files …]`
through the running backend: the same queue, modes, cache, loudness and QC as the
editor and the MCP.

The reel is shaped like a client's reel, not a demo that loops one take:

- 60.7 s, 14 takes from **six distinct** 1080×1920 camera-like sources (h264
  ~14 Mbps with grain), no footage reused
- J-cut and L-cut, cover and reveal transitions (whip, punch, crossBlur, zoom,
  flash, polyWipe), keyframed push-ins
- three B-roll cues from their own sources, a hook, a location tag, a stat
- color grade on, music ducking under the speech, SFX on, voice cleanup `light`
- Spanish captions paged by the real pager (`src/paging.ts`) with uneven word gaps,
  compound names ("San Juan de los Lagos", "Montealbán 326") and key words

The caption edit is the tedious kind of review: fix a word's spelling, promote a
key word, nudge a page up. Timing is untouched (with ducked music, a re-timing
changes the speech spans the music ducks under, so it re-renders the master).

Fonts: Chrome inside this container cannot reach Google Fonts (Remotion launches
it with `--proxy-server=direct://`), so the bench uses a brand kit with a local OFL
font (Montserrat, `public/fonts/`, gitignored). Same code path as a client font.

Sync check: per frame, the pixels where |one-pass − master| and |layered − master|
exceed a threshold are the caption pixels of each file. The share of the frame
where the two masks disagree is reported, next to the same measure for the layered
file shifted by one frame (the size of a one-frame error).

## Results

### Draft (half resolution), 4 vCPU, pack `palabra` (117 pages)

| | full (before) | layers (after) |
|---|---|---|
| first render | 218 s | master 216 s + captions + composite* |
| after a caption edit | **220 s** | **46 s** (captions layer 35 s + composite 10 s) |

\* The first layered run with the VP9 layer rendered the master cold in 216 s,
about the same as a full render; the first render costs about the same in both
modes, plus the caption layer.

Caption sync (share of the frame where the caption masks disagree, 1821 frames):

| | mean | max | frames > 0.5 % |
|---|---|---|---|
| layered vs one-pass | 0.051 % | 0.77 % | 10 |
| layered shifted by one frame | 5.48 % | 73 % | 1094 |

The worst aligned frame (223) shows the same word at the same place in both files;
what's left is encoding noise on the edges of high-entropy footage (a fractal). Same
frame count (1821) in both files.

Caption layer formats, draft, same PNG frames (34 s to draw, 30 MB):

| format | encode | composite | layer file | sync mean / max |
|---|---|---|---|---|
| png (default) | — | 9.9 s | (the frames) | 0.051 % / 0.77 % |
| vp9 (yuva420p, realtime) | 11.2 s | 12.4 s | 2.5 MB | 0.023 % / 0.76 % |
| prores 4444 | 23.9 s | 14.3 s | 40 MB | 0.052 % / 0.77 % |

### Full resolution (1080×1920), 4 vCPU: the caption layer alone

Measured by hand on the same reel (`palabra`), to find where the caption layer's
time went:

| caption layer | draw | encode | composite | total |
|---|---|---|---|---|
| Remotion VP9 alpha (first version) | 207 s (draw and encode together) | — | ~50 s | ~257 s |
| Remotion ProRes 4444 | 152 s (draw and encode together) | — | ~49 s | ~201 s |
| PNG frames → ffmpeg VP9 realtime | 57 s | 30 s | ~53 s | ~140 s |
| **PNG frames → composite (default)** | 57 s | — | ~39 s | **~96 s** |

Remotion's VP9 encode was most of the caption layer's cost; hence the frames-first
path.

### Final render (1080×1920 + loudness + QC), pack `focus`

(pending: the run was in progress when this was written)

## Limitations

- Captions that reach into the footage force the one-pass render: focus pull on
  tier-2 words (prism), hero punch and glitch pulse (impact), glass pages (evo, the
  backdrop blur needs the footage), captions behind the presenter (drawn under the
  person matte). `src/layers.ts` names the reason; the result reports it.
- Music auto-duck is unchanged: it ducks under the caption pages' speech spans,
  which are part of the master's key when the music ducks. A spelling, emphasis or
  position edit keeps the master; a re-timing or re-paging makes a new one.
- The caption pack is part of the master's key (it also styles titles, B-roll
  motion and the accent), so switching packs re-renders the master.
- The composite re-encodes the master once more (crf 18 over a crf 16 master).
