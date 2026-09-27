"""Every face per image as fractions of the frame, with its score, via OpenCV YuNet (Apache-2.0).

    .venv/bin/python scripts/face.py .models/yunet.onnx a.jpg b.jpg
    → {"a.jpg": {"found": true, "left": .3, "top": .1, "right": .6, "bottom": .4, "size": [360, 640],
                 "faces": [{"left": .3, "top": .1, "right": .6, "bottom": .4, "score": .93}, …]},
       "b.jpg": {"found": false, "faces": []}}

A face under MIN_H of the frame's height is left out (a crowd far off, a photo on a wall); found / left /
top / right / bottom name the largest one, as before (older readers).
"""
import json
import sys

import cv2

MIN_H = 0.03

model, paths = sys.argv[1], sys.argv[2:]
det = cv2.FaceDetectorYN.create(model, "", (320, 320), 0.6, 0.3, 5000)
out = {}
for p in paths:
    img = cv2.imread(p)
    if img is None:
        out[p] = {"found": False, "faces": []}
        continue
    h, w = img.shape[:2]
    det.setInputSize((w, h))
    _, found = det.detect(img)
    faces = []
    for f in [] if found is None else found:
        x, y, fw, fh = (float(v) for v in f[:4])
        if fh / h < MIN_H:
            continue
        faces.append({"left": max(0.0, x / w), "top": max(0.0, y / h), "right": min(1.0, (x + fw) / w), "bottom": min(1.0, (y + fh) / h), "score": round(float(f[-1]), 3)})
    faces.sort(key=lambda b: (b["right"] - b["left"]) * (b["bottom"] - b["top"]), reverse=True)
    out[p] = {"found": bool(faces), **({k: faces[0][k] for k in ("left", "top", "right", "bottom")} if faces else {}), "size": [w, h], "faces": faces}
print(json.dumps(out))
