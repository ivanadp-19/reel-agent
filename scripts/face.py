"""Every face per image as fractions of the frame, with its score, via OpenCV YuNet (Apache-2.0).

    .venv/bin/python scripts/face.py .models/yunet.onnx a.jpg b.jpg
    → {"a.jpg": {"found": true, "left": .3, "top": .1, "right": .6, "bottom": .4, "size": [1080, 1920],
                 "faces": [{"left": .3, "top": .1, "right": .6, "bottom": .4, "score": .93}, {…, "score": .71, "look": .88}]},
       "b.jpg": {"found": false, "size": [1080, 1920], "faces": []}}

Each image is searched at DETECT px high; a face under MIN_H of the frame's height is left out (a crowd far off, a
photo on a wall). A face that scores under SURE there is looked at again on the full-resolution image — a crop around
it, scaled so the box is LOOK_PX — and that score is its `look`: a face on a phone or turned down gains there (César's
phone-call scene 0.61 → 0.67–0.93), a rooftop chair or a bottle loses it (0.6–0.8 → 0–0.59). src/faces.ts decides which
it trusts. found / left / top / right / bottom name the largest one, as before (older readers).
"""
import json
import sys

import cv2

MIN_H = 0.03
DETECT = 640
SURE = 0.85
LOOK_PX = 160

model, paths = sys.argv[1], sys.argv[2:]
cv2.setNumThreads(1)  # one core, like the ffmpeg pass: a render or another session keeps the rest
det = cv2.FaceDetectorYN.create(model, "", (320, 320), 0.6, 0.3, 5000)
near = cv2.FaceDetectorYN.create(model, "", (320, 320), 0.3, 0.3, 5000)


def look(img, x0, y0, x1, y1):
    """YuNet's best score for a face over the box's centre, the box LOOK_PX high in a crop of the full image"""
    h, w = img.shape[:2]
    cx, cy, s = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) * 1.5
    a, b, c, e = int(max(0, cx - s)), int(max(0, cy - s)), int(min(w, cx + s)), int(min(h, cy + s))
    k = LOOK_PX / max(1.0, max(x1 - x0, y1 - y0))
    crop = cv2.resize(img[b:e, a:c], (max(1, int((c - a) * k)), max(1, int((e - b) * k))))
    near.setInputSize((crop.shape[1], crop.shape[0]))
    _, found = near.detect(crop)
    ox, oy = (cx - a) * k, (cy - b) * k
    return max([float(f[-1]) for f in ([] if found is None else found) if f[0] <= ox <= f[0] + f[2] and f[1] <= oy <= f[1] + f[3]], default=0.0)


out = {}
for p in paths:
    img = cv2.imread(p)
    if img is None:
        out[p] = {"found": False, "faces": []}
        continue
    h, w = img.shape[:2]
    k = min(1.0, DETECT / h)
    small = cv2.resize(img, (max(1, round(w * k)), max(1, round(h * k)))) if k < 1 else img
    det.setInputSize((small.shape[1], small.shape[0]))
    _, found = det.detect(small)
    faces = []
    for f in [] if found is None else found:
        x, y, fw, fh = (float(v) / k for v in f[:4])
        if fh / h < MIN_H:
            continue
        face = {"left": max(0.0, x / w), "top": max(0.0, y / h), "right": min(1.0, (x + fw) / w), "bottom": min(1.0, (y + fh) / h), "score": round(float(f[-1]), 3)}
        if face["score"] < SURE:
            face["look"] = round(look(img, x, y, x + fw, y + fh), 3)
        faces.append(face)
    faces.sort(key=lambda b: (b["right"] - b["left"]) * (b["bottom"] - b["top"]), reverse=True)
    out[p] = {"found": bool(faces), **({k2: faces[0][k2] for k2 in ("left", "top", "right", "bottom")} if faces else {}), "size": [w, h], "faces": faces}
print(json.dumps(out))
