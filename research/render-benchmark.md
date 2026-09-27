# Render benchmark (the VM: KVM, 8 vCPU AMD EPYC 9354P, 31 GB RAM, no GPU)

Why: César asked "¿por qué tarda tanto?" and whether the 12 reels can be edited
in parallel. Baseline reported on 2026-09-24: **a 69 s draft ≈ 5 min** on this VM
(on a Mac M: 60 s for 48 s of video), renders chained by hand with `nohup`.

## Method

`node scripts/render-bench.mjs --sec <s> --renders <n> --workers <w> --concurrency <c>`

- Same `remotion render` arguments and the same queue as the backend
  (`scripts/render-queue.mjs`), so it measures what an export costs.
- Synthetic reel shaped like a real one: two 1080×1920 30 fps sources (h264 at
  ~16 Mbps with grain, like a phone), a cut every ~5 s alternating sources with
  punch-ins, a caption page every 1.2 s (`palabra`, one accented word each), the
  color grade on. No B-roll, graphics or mattes (they add per-frame cost on top).
- The script waits until no other `remotion render` or `ffmpeg` runs on the
  machine: the VM is shared with real client work, which must not slow down for a
  benchmark, and a busy box would make the numbers meaningless.
- Wall time per render and in total; "setup" = seconds until the first frame is
  reported rendered (bundling + browser start).

## Results

### Phase 25: a layered client final on the VM (2026-09-27, main b9330b2)

The real thing instead of the synthetic reel: César's G2 edited end to end by the phase-26 headless agent (VIBEM
G2 H1 C1 — three raw takes, 5 clips, 4 B-roll cues, a text graphic, vibem captions, identity → the pair), 52.4 s,
rendered as a FINAL through the queue on the VM (ffmpeg 6.1.1, node 24.8, one render at a time, no master cached).

| | |
|---|---|
| **Total, queued → version recorded** | **12 min 41 s** (15:59:31 → 16:12:13 UTC) — CEO-3's bar is 15 min per 50 s reel |
| Stages (s) | master 230.4 · supers 53.8 + encode 57.2 · captions 61.4 + encode 57.1 · captions PNG 1.5 · composite 156.9 · QC 30.7 · pair 88.9 |
| QC | 1080×1920, 52.42 s, −14.4 LUFS, −1.8 dBTP, no silence / black, frame 0 is footage |
| Delivered (`reviews/<id>/v1/`, MB) | captions.mov 365.2 · captions.png.zip 223.5 · master 86.8 · supers.mov 67.8 · master_supers 58.9 = **802** (15.3 MB per second of reel) + proxy 7.4 + poster 0.06 |
| Also written | export 60 · master cache 87.5 · webpack bundle cache 80 (first render after a deploy only) |
| Memory | the unit's cgroup `memory.peak` 6.8 GB (page cache included) of 31 GB — no memory wait |
| Judge (César's profile, on the VM) | "1 hallazgo": the same single major as on the Mac (a page 1 % under a chin) — the judge reads the same on ffmpeg 6.1 and 8 |

Calibration from these numbers (defaults unchanged, now measured):
- `REEL_PAIR_MB_PER_SEC` 25: the render's own bytes were ≈ 1.04 GB for 52 s (v1 + export + master + bundle) ≈ 20 MB/s,
  plus the caption frames while they exist (~4 MB/s) — 25 holds. (The disk's own delta over the run was 2.9 GB because
  other work ran on the box meanwhile: another session's 8 renders and a CLI update.)
- `REEL_RENDER_START_MIN_MEM_MB` 2560 / `REEL_PROOF_START_MIN_MEM_MB` 1024: a final peaks at ~6.8 GB with cache on a
  31 GB box that sits at ~26–30 GB available — both floors are far below what the VM has; keep them (they matter on a
  smaller box).
- `REEL_REVIEW_KEEP_UNAPPROVED` 3: ≈ 0.8 GB per unapproved version of a ~50 s reel with text graphics → 26 variants ×
  3 ≈ 60 GB worst case on a disk with 277 GB free — keep 3.
- Throughput: one final every ~13 min → ~4.5 per hour serial; the 26 variants of César's scripts ≈ 5.5 h of renders,
  fewer when only the captions change (the master comes from the cache: the master pass, 230 s, is skipped).

## Per-vN size (Mac)

Measured 2026-09-27 on the Mac (plan phase 7): the bytes each client version (`public/reviews/<id>/v<n>/`) keeps. The
encoders make the same files on any machine, so these size the retention (`REEL_REVIEW_KEEP_UNAPPROVED`) and the pair
disk floor before the VM run (T2 / phase 25). MB = 10^6 bytes.

| version | reel | master | captions.mov | captions.png.zip | supers.mov | master_supers | proxy | new bytes in v<n>/ |
|---|---|---|---|---|---|---|---|---|
| VIBEM_G2_H1_C1 v1 (Morantes2.1, captions only, before phase 7) | 43.2 s | 97.9 (rendered) | 320.3 | 186.0 | 41.2 (transparent: no text graphic) | = master (hard link) | 6.3 | 652 |
| VIBEM_G3_H2_C1 v1 (Morantes3.3, before phase 7) | 54.4 s | 87.1 (rendered) | 345.9 | 210.9 | 51.9 (transparent) | = master (hard link) | 6.3 | 702 |
| VIBEM_G1_V1 v1 (Guion1, 6 text graphics, pack vibem) | 37.6 s | 67.2 (rendered) | 226.1 | 136.0 | 183.2 | 38.8 | 4.5 | 656 |
| VIBEM_G1_V1 v2 (the same, rendered again) | 37.6 s | = v1's (hard link: same master key + audio sha256) | 226.1 | 136.0 | 183.2 | 38.8 | 4.5 | 589 |
| VIBEM_G4_H1_C1 v1 (Morantes4.1, captions only → César's own file) | 68.0 s | 161.8 (his export, hard link: 0 new) | 479.0 | 281.3 | — (no text graphic) | — | 7.8 | 768 |
| VIBEM_G3_H2_C2 v1–v3 (Morantes3.4, captions only → César's own file; v3 approved, its master the development's colorRef) | 54.1 s | 128.3 (his export: one inode for the clip, v1–v3 and refs/ — 0 new) | 349.3–351.3 | 212.0–212.8 | — (no text graphic) | — | 5.7 | 567–570 each |

Poster ≈ 50–66 KB and snapshot 18–27 KB per version; the export itself (`public/exports/`, 40–58 MB) is
`cleanup-exports`' to purge. Per second of reel: captions.mov (ProRes 4444) 6.0–7.4 MB/s — the biggest file of every
version —, the PNG zip 3.6–4.3 MB/s, a rendered master 1.6–2.3 MB/s, supers 1 MB/s transparent but 4.9 MB/s when the
reel is full of text graphics. What phase 7 changed: a reel without text graphics no longer keeps a transparent
supers.mov (−41 / −52 MB above); a captions-only job on the client's export keeps no master of its own (his file,
linked); an unchanged master is linked across versions (G1 v2: −67 MB).

- **Retention** (`node scripts/reviews.mjs prune`, per variant): the approved versions + the newest 3 unapproved ≈
  3 × 0.6–0.8 GB per variant of ~40–70 s; 26 variants ≈ 50–60 GB before approvals. Everything older keeps only its
  proxy, poster and snapshot (~5–8 MB), or those too when it has no notes.
- **Pair disk floor** (`admitRender`: `REEL_RENDER_MIN_FREE_DISK_MB` + `REEL_PAIR_MB_PER_SEC` × seconds, default 25):
  while it runs a client's final holds its v<n>/ files (11–17 MB/s above), the export (~1.3 MB/s), the caption PNG
  frames in the OS temp dir (~4 MB/s), the supers frames and a new master in the cache (~2 MB/s): ≈ 20–25 MB per
  second of reel → a 50 s pair needs ~1.25 GB over the floor.
- **Times on the Mac** (same queue, one render at a time): G4 captions only (68 s, no master pass) 154 s end to end;
  G3 H2 C2 captions only (54 s) 99–137 s; G1 with its text graphics 245 s (master 83 s, supers pass + ProRes encode 48 s), G1 v2 with the master cached 189 s;
  the earlier G2 (43 s) and G3 (54 s) pairs with a rendered master 320 s and 374 s. The VM's own numbers (phase 25) are
  under Results.
