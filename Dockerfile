FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fontconfig fonts-liberation fonts-dejavu-core \
    python3 python3-venv python3-pip curl ca-certificates \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6 libxi6 libxtst6 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN python3 -m venv .venv \
  && .venv/bin/pip install -q --upgrade pip \
  && .venv/bin/pip install -q opencv-python-headless mediapipe
RUN mkdir -p .models \
  && curl -sSfL -o .models/yunet.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx \
  && curl -sSfL -o .models/selfie_segmenter.tflite https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
RUN npx vite build && npx remotion browser ensure
ENV REEL_PUBLIC=1 REEL_DEVICE=cpu REEL_HOST=0.0.0.0 HF_HOME=/app/public/.hf NODE_ENV=production
EXPOSE 3333
CMD ["node", "server/index.mjs"]
