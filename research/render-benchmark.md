# Render benchmark (VM KVM 2: 2 vCPU AMD EPYC 9354P, 7.9 GB RAM, no GPU)

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

(see below — filled in by the run)
