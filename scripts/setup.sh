#!/usr/bin/env bash
# One-shot local setup: checks the toolchain, creates the WhisperX venv, seeds .env.
#   npm run setup            # GPU build of torch if you have an NVIDIA card (large, ~7 GB)
#   npm run setup -- --cpu   # CPU-only torch (~1 GB) — fine for short clips
set -euo pipefail
cd "$(dirname "$0")/.."

CPU_ONLY=0
for a in "$@"; do [ "$a" = "--cpu" ] && CPU_ONLY=1; done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
miss() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "Checking tools"
# Node 24 (package.json engines, .nvmrc). On the VM it comes from nvm: load it
# and install/use 24 when the node on PATH is older or missing.
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" -lt 24 ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  if [ -s "$NVM_DIR/nvm.sh" ]; then set +u; . "$NVM_DIR/nvm.sh"; nvm install 24 >/dev/null && nvm use 24 >/dev/null; set -u; fi
fi
if [ "$(node_major)" -ge 24 ]; then ok "node $(node -v)"; else miss "Node 24 is required — install nvm (https://github.com/nvm-sh/nvm), then: nvm install 24 && nvm alias default 24"; exit 1; fi
if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"; else miss "ffmpeg/ffprobe not found — apt install ffmpeg | brew install ffmpeg | winget install ffmpeg"; exit 1; fi
PY=""
for c in python3.12 python3.11 python3.10 python3; do command -v "$c" >/dev/null && PY="$c" && break; done
if [ -n "$PY" ]; then ok "$PY ($($PY -c 'import sys;print(".".join(map(str,sys.version_info[:2])))'))"; else miss "Python 3.10+ not found"; exit 1; fi

echo "Node packages"
[ -d node_modules ] || npm install --no-audit --no-fund
ok "node_modules"

echo "WhisperX (word-level transcription)"
if [ ! -x .venv/bin/whisperx ]; then
  [ -d .venv ] || "$PY" -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  if [ "$CPU_ONLY" = 1 ]; then
    echo "  installing CPU-only torch…"
    .venv/bin/pip install -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  fi
  echo "  installing whisperx (this pulls torch — a few minutes)…"
  .venv/bin/pip install -q whisperx
fi
DEV=$(.venv/bin/python -c 'import torch;print("cuda" if torch.cuda.is_available() else "cpu")' 2>/dev/null || echo cpu)
ok "whisperx ready — device: $DEV"

echo "Face detection (caption placement)"
.venv/bin/python -c 'import cv2' 2>/dev/null || .venv/bin/pip install -q opencv-python-headless
mkdir -p .models
[ -f .models/yunet.onnx ] || curl -sSfL -o .models/yunet.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
ok "YuNet ready"

echo "Person segmentation (text behind the presenter)"
.venv/bin/python -c 'import mediapipe' 2>/dev/null || .venv/bin/pip install -q mediapipe
[ -f .models/selfie_segmenter.tflite ] || curl -sSfL -o .models/selfie_segmenter.tflite https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
ok "MediaPipe selfie segmenter ready"

echo "Caption fonts (licensed files, never committed)"
# the vibem pack loads public/fonts/Helvetica-Bold.ttf (src/projectFont.ts); a Mac has it inside Helvetica.ttc
if [ -f public/fonts/Helvetica-Bold.ttf ]; then
  # the face, not just the file name: an Arial saved as Helvetica-Bold.ttf renders, silently, in Arial
  face=$(node --input-type=module -e "import fs from 'node:fs'; import {readFont} from './src/sfnt.ts'; try { console.log(readFont(fs.readFileSync('public/fonts/Helvetica-Bold.ttf')).fullName); } catch { console.log('not a font file'); }")
  if [ "$face" = "Helvetica Bold" ]; then ok "public/fonts/Helvetica-Bold.ttf"
  else miss "public/fonts/Helvetica-Bold.ttf is \"$face\", not Helvetica Bold — replace it with the licensed file (on a Mac: delete it and run npm run setup again)"; fi
elif [ -f /System/Library/Fonts/Helvetica.ttc ]; then
  .venv/bin/python -c 'import fontTools' 2>/dev/null || .venv/bin/pip install -q fonttools
  mkdir -p public/fonts
  .venv/bin/python - <<'PY'
import logging; logging.disable(logging.WARNING)  # fontTools: "'created' timestamp seems very low"
from fontTools.ttLib import TTCollection
next(f for f in TTCollection('/System/Library/Fonts/Helvetica.ttc').fonts if f['name'].getDebugName(4) == 'Helvetica Bold').save('public/fonts/Helvetica-Bold.ttf')
PY
  ok "public/fonts/Helvetica-Bold.ttf (extracted from this Mac's Helvetica.ttc)"
else miss "public/fonts/Helvetica-Bold.ttf missing (the vibem caption pack needs it) — copy your licensed Helvetica Bold .ttf there (on a Mac, npm run setup extracts it)"; fi

echo "API keys"
if [ ! -f .env ]; then cp .env.example .env; fi
if grep -q '^PEXELS_API_KEY=.\+' .env; then ok "PEXELS_API_KEY set"; else miss "PEXELS_API_KEY empty (optional) — https://www.pexels.com/api"; fi

echo
echo "Done. Start with:  npm start   → http://localhost:5173"
