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
# Node 24.2+ (package.json engines, .nvmrc; the scripts tell they were run directly with
# import.meta.main). On the VM it comes from nvm: load it and install/use the latest 24
# when the node on PATH is older or missing.
node_ok() { command -v node >/dev/null && [ "$(node -p 'const [a, b] = process.versions.node.split(".").map(Number); +(a > 24 || (a === 24 && b >= 2))')" = 1 ]; }
if ! node_ok; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  if [ -s "$NVM_DIR/nvm.sh" ]; then set +u; . "$NVM_DIR/nvm.sh"; nvm install 24 >/dev/null && nvm use 24 >/dev/null; set -u; fi
fi
if node_ok; then ok "node $(node -v)"; else miss "Node 24.2 or newer is required — install nvm (https://github.com/nvm-sh/nvm), then: nvm install 24 && nvm alias default 24"; exit 1; fi
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

echo "API keys"
if [ ! -f .env ]; then cp .env.example .env; fi
if grep -q '^PEXELS_API_KEY=.\+' .env; then ok "PEXELS_API_KEY set"; else miss "PEXELS_API_KEY empty (optional) — https://www.pexels.com/api"; fi

echo
echo "Done. Start with:  npm start   → http://localhost:5173"
