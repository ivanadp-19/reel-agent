# G10: the ungraded heads (numbers only)

Why: in G10 V1 the client's pre-edit export starts three shots ungraded. After
each real cut, the first 10 frames (≈ 0.33 s) come out flat, and then the grade
switches on inside the same shot. The frames, joins and contact sheets are the
client's footage, so they stay out of git in
`public/clients/vibem/research/g10/` (`g10-v1/join-9s.jpg`,
`g10-v1/uniones-antes-despues.jpg`, `cc/joins_before.jpg`, `cc/joins_after.jpg`,
`cc/sky_j1.jpg`). This page keeps only the measurements and what they mean for
detection (design D25, plan phases 15–16).

## Method

`ffmpeg -i <file> -vf "signalstats,metadata=print:file=<out>.txt" -f null -`,
every frame at full resolution, whole frame. We read YAVG, UAVG, VAVG and SATAVG
(8-bit). The step at a head is the mean of the first 3 graded frames minus the
mean of the last 3 head frames. Noise is the largest frame-to-frame |ΔYAVG|
inside one shot.

Files:
- **source**: the client's export `Guion10_1.mp4` (1080×1920, 30000/1001,
  bt709), which is the defect as delivered.
- **antes**: `g10-v1/VIBEM_G10_V1_master_limpio_antes.mp4` (30 fps). It is our
  master with each head split off (`split_clip`) and pushed by a per-clip
  `set_grade` (exposure ≈ +0.4, contrast ≈ 1.5, saturation 2). There, master
  t = source t − 0.0667 s.
- **después**: `g10-v1/VIBEM_G10_V1_master_limpio.mp4`, the same edit with a
  pixel-pair match LUT per head (the `cc/fitlut.mjs` prototype, plan phase 14).

## The heads

| Head (source s) | Frames (source) | Master (antes/después) |
|---|---|---|
| 8.876–9.176 | 266–275 (10) | 8.809–9.109, frames 264–273 |
| 24.992–25.292 | 749–758 (10) | 24.925–25.225, frames 748–757 |
| 37.638–37.938 | 1128–1137 (10) | 37.571–37.871, frames 1127–1136 |

## The step (source)

| Head | ΔY | ΔU | ΔV | SAT head → graded | SAT ratio |
|---|---|---|---|---|---|
| 8.876 | **+36.2** | +2.8 | +1.0 | 1.53 → 7.76 | **×5.05** |
| 24.992 | **+32.2** | −0.3 | +3.4 | 1.53 → 8.04 | **×5.24** |
| 37.638 | **+36.6** | +1.9 | +1.6 | 1.00 → 5.64 | **×5.63** |

The largest |ΔU| or |ΔV| of each head is 2.8, 3.4 and 1.9, so every chroma
step is between 0.3 and 3.4. The head itself is almost neutral: SAT 1.0–1.5,
with U and V at about 128.

At the real cut into each head, luma barely moves in the source (ΔY −0.5,
−4.9, −0.7). What changes is saturation: from 8.6–9.4 on the graded shot before
the cut to 1.0–1.5 on the head, a ratio of 5.6–9.6 downward.

## In-shot noise

The largest frame-to-frame |ΔY| inside one shot:
- source: 0.10–0.18 inside the heads and 0.14–0.33 in the graded second after
  them. The second before a head reads 0.17–0.81, the top of that range while
  the camera moves.
- masters: 0.12–0.38 inside a head and 0.25–0.32 in the graded run.

So the noise is 0.1–0.4 Y, and up to ~1 Y with camera motion. Frame to frame,
U, V and SAT move by 0.06–0.23 in one shot.

## Fixes against the residual bar |ΔY| < 2, |ΔU/V| < 1, |Δsat| < 0.8

| Head | antes (per-clip `set_grade`): ΔY / ΔU / ΔV / Δsat (ratio) | después (match LUT): ΔY / ΔU / ΔV / Δsat (ratio) |
|---|---|---|
| 8.876 | −1.8 / +0.6 / −0.7 / **+1.23** (×1.14) | +0.3 / −0.2 / −0.2 / +0.45 (×1.05) |
| 24.992 | +0.1 / +0.7 / −0.9 / **+1.68** (×1.19) | −0.5 / −0.1 / +0.2 / +0.26 (×1.02) |
| 37.638 | −1.6 / **+1.7 / −1.4 / +3.02** (×1.47) | −0.5 / +0.1 / +0.2 / +0.33 (×1.04) |

The statistics grade gets luma under 2. It leaves saturation 1.2–3.0 off and,
on the third head, chroma 1.4–1.7 off, which is still visible at the join. The
match LUT meets the bar on all three heads, with a worst case of 0.5 / 0.2 / 0.45.

## What this means for detection (D25)

- **U/V alone misses the defect.** A U/V threshold of 4, D25's initial value,
  catches none of the three heads, because the largest chroma step is 3.4.
- **Luma ≥ 12 or a SAT ratio ≥ 2 catches all three with room to spare.** The
  smallest luma step, 32.2, is 2.7 times the threshold and about 80 times the
  in-shot noise. The smallest SAT ratio, ×5.05, is 2.5 times its threshold.
  Take the ratio in either direction (max/min), because the cut into a head
  shows up as a saturation drop with almost no change in luma.
- **A real cut steps as much or more.** In our masters the cuts into the heads
  read ΔY +40 to +63. So a step is a half-graded head only while the picture
  stays the same shot. That is the structure check of plan phase 15 (the judge's
  9×8 hash), not a lower threshold.
- **Coverage (after a fix): a residual bar near |ΔY| 2 / |ΔU/V| 1 / |Δsat| 0.8.**
  It passes the match LUT and fails the partial `set_grade` fix, which is the
  difference the eye sees at the join.
