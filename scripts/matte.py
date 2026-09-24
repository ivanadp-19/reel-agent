"""Person matte for a span of a clip → WebM VP9 with alpha (plays in Chrome and Remotion).

    .venv/bin/python scripts/matte.py <video> <startSec> <endSec> <out.webm> [--png probe.png]

Segmentation: MediaPipe Image Segmenter, selfie model (Apache-2.0), CPU. Frames
are decoded and encoded through ffmpeg pipes; the alpha is the person
confidence, feathered a little so hair and edges do not look cut with scissors.
With --png only the first frame is written as RGBA (quality/speed probe).
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / ".models" / "selfie_segmenter.tflite"


def probe(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", video], capture_output=True, text=True).stdout.strip().split(",")
    w, h = int(out[0]), int(out[1])
    num, den = out[2].split("/")
    return w, h, float(num) / float(den)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video"); ap.add_argument("start", type=float); ap.add_argument("end", type=float); ap.add_argument("out")
    ap.add_argument("--png", help="write only the first frame as RGBA PNG")
    ap.add_argument("--scale", type=float, default=1.0, help="output scale (0.5 halves both dimensions)")
    a = ap.parse_args()
    if not MODEL.exists():
        sys.exit(f"model missing: {MODEL} (run npm run setup)")
    w, h, fps = probe(a.video)
    ow, oh = int(w * a.scale) // 2 * 2, int(h * a.scale) // 2 * 2

    seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.VIDEO, output_confidence_masks=True, output_category_mask=False))

    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", str(a.start), "-t", str(a.end - a.start), "-i", a.video,
                            "-vf", f"scale={ow}:{oh}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = None
    if not a.png:
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{ow}x{oh}", "-r", str(fps), "-i", "-",
                                "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-deadline", "realtime", "-cpu-used", "6", "-row-mt", "1", a.out], stdin=subprocess.PIPE)
    n, t0 = 0, time.time()
    frame_bytes = ow * oh * 3
    while True:
        buf = dec.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(oh, ow, 3)
        ts_ms = int((a.start + n / fps) * 1000)
        res = seg.segment_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts_ms)
        conf = res.confidence_masks[0].numpy_view()  # 1 = person (selfie model)
        alpha = np.clip((conf - 0.35) / 0.4, 0, 1)  # soft threshold keeps hair, kills background noise
        alpha = cv2.GaussianBlur((alpha * 255).astype(np.uint8), (5, 5), 0)
        rgba = np.dstack([rgb, alpha])
        if a.png:
            cv2.imwrite(a.png, cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
            print(f"probe frame {ow}x{oh} in {time.time() - t0:.2f}s → {a.png}")
            dec.kill(); return
        enc.stdin.write(rgba.tobytes())
        n += 1
    enc.stdin.close(); enc.wait(); dec.wait()
    dt = time.time() - t0
    print(f"{n} frames {ow}x{oh} in {dt:.1f}s ({n / dt:.1f} fps) → {a.out}")


if __name__ == "__main__":
    main()
