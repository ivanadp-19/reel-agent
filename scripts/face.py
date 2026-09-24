"""Largest face per image as fractions of the frame, via OpenCV YuNet (Apache-2.0).

    .venv/bin/python scripts/face.py .models/yunet.onnx a.jpg b.jpg
    → {"a.jpg": {"found": true, "left": .3, "top": .1, "right": .6, "bottom": .4}, "b.jpg": {"found": false}}
"""
import json
import sys

import cv2

model, paths = sys.argv[1], sys.argv[2:]
det = cv2.FaceDetectorYN.create(model, "", (320, 320), 0.6, 0.3, 5000)
out = {}
for p in paths:
    img = cv2.imread(p)
    if img is None:
        out[p] = {"found": False}
        continue
    h, w = img.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(img)
    if faces is None or len(faces) == 0:
        out[p] = {"found": False}
        continue
    x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])[:4]
    out[p] = {"found": True, "left": float(x / w), "top": float(y / h), "right": float((x + fw) / w), "bottom": float((y + fh) / h)}
print(json.dumps(out))
