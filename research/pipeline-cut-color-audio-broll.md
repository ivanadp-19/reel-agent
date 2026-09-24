I've researched all seven jobs. Each has a recommended stack, alternatives, gotchas and working commands, with a source link on every claim; anything I couldn't confirm from a primary source is marked (unverified).

# AI reel editor: component research (as of 2026-09-23)

## 1. Cutting
**Recommended stack**
- **Speech-to-text:** WhisperX ([BSD-2](https://github.com/m-bain/whisperX)) runs faster-whisper, then wav2vec2 to pin each word's timing. Spanish has a built-in timing model.
  - Gotcha: words with digits or symbols (e.g. "2014.") get no timestamp.
- **Second opinion / Mac:** NVIDIA Parakeet-TDT-0.6B-v3 ([CC-BY-4.0, OK for commercial use](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)). It covers 25 languages including Spanish (3.45% word error rate on the FLEURS benchmark) and returns word timestamps directly. On Apple Silicon use [parakeet-mlx](https://github.com/senstella/parakeet-mlx).
  - [Canary-1B-v2](https://huggingface.co/nvidia/canary-1b-v2) (CC-BY-4.0) adds translation.
  - [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) runs on the Mac GPU via Metal.
- **Silence:** auto-editor ([Unlicense, now written in Nim](https://github.com/WyattBlue/auto-editor)). It cuts on audio level or motion and exports to Premiere, Resolve, Final Cut, Shotcut, Kdenlive, or its own JSON timeline format [v3](https://auto-editor.com/docs/v3). The alternative is [Silero VAD](https://github.com/snakers4/silero-vad) (MIT, 8/16 kHz, has a `speech_pad_ms` setting).

**Filler words ("eh", "este", "um")**
- **No commercially usable open model is verified for Spanish verbatim.**
- CrisperWhisper is built for this, but its weights are [CC-BY-NC-4.0 (non-commercial) and only guaranteed for English and German](https://huggingface.co/nyrahealth/CrisperWhisper). v2.0 needs a [commercial license](https://github.com/nyrahealth/CrisperWhisper).
- In one English study, filler recall was only [1.6–7.1% for Whisper and 0.4–4.2% for Parakeet-110M](https://arxiv.org/html/2609.20828).
- One project reports Parakeet-v3 keeps "um/uh" ([unverified, test on your own Spanish](https://github.com/ferraroroberto/voice-transcriber/issues/198)).
- Putting fillers in Whisper's `initial_prompt` raises recall but [causes hallucinated words](https://github.com/SYSTRAN/faster-whisper/discussions/569).
- A deterministic trick (my idea, untested): any stretch where the VAD hears speech but no transcribed word covers it is likely a filler. Mark it as a cut candidate.

**Retakes**
- [hatimmrabet/video-editor](https://github.com/hatimmrabet/video-editor/issues/127) (MIT) is a Claude Code editor like yours. It detects retakes three ways:
  - immediate repeated word sequences
  - false start then restart (fuzzy prefix match with `difflib`)
  - a list of stall words
- It keeps the **last** take, and an LLM read of the transcript catches the semantic cases. [TimeBolt](https://www.timebolt.io/blog/auto-remove-bad-takes) also keeps the last take.
- Add a Spanish/English cue list ("no, otra vez", "de nuevo", "corta", "perdón", "let me start over").

**Padding**
- Use about 0.22 s before speech and 0.10 s after, and nudge each in-point to the first sharp frame using `blurdetect` ([#128](https://github.com/hatimmrabet/video-editor/issues/128)).
- WhisperX words that failed to align [inherit a neighbour's timestamps](https://github.com/calebn/sharecut-studio/issues/195), so cut inside silences, not on word edges.
- Add a ~10 ms `afade` at every audio cut (my recommendation).

```
auto-editor in.mp4 --edit audio:threshold=0.04 --margin 0.2s,0.1s --export resolve
whisperx in.wav --model large-v3 --language es --highlight_words True
```

## 2. Captions
**Recommended: stay in Remotion**
- [`createTikTokStyleCaptions({captions, combineTokensWithinMilliseconds})`](https://www.remotion.dev/docs/captions/create-tiktok-style-captions) groups words into pages. Each word's text needs a **leading space** and must render with `white-space: pre`.
- The official [remotion-dev/skills](https://github.com/remotion-dev/skills) repo is written for Claude Code and Codex (`npx skills add remotion-dev/skills`, includes `/remotion-captions`).

**Remotion license**
- [Free for companies of up to 3 employees](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md). Above that, the "Automators" plan is [$0.01/render with a $100/month minimum](https://www.remotion.dev/docs/license/faq).
- A SaaS that generates Remotion code with AI is allowed. Letting users upload their own Remotion code is **not**.

**Alternatives**
- **ASS subtitles burned in with ffmpeg (libass):** fast and needs no Chromium.
- **[pycaps](https://github.com/francozanardi/pycaps)** (MIT): CSS-styled templates rendered with Playwright. It describes itself as "very alpha" and isn't on PyPI.

**Styles**
- **Hormozi:** heavy uppercase sans (close to Montserrat Black), white with a thick black outline, active word yellow, 2–4 words on screen, words pop in ([third-party description](https://ascynd.io/en/blog/hormozi-captions)).

```
Dialogue: 0,0:00:01.00,0:00:01.60,Big,,0,0,0,,{\fscx70\fscy70\t(0,80,\fscx100\fscy100)}ESTO ES {\c&H00FFFF&}CLAVE
ffmpeg -i in.mp4 -vf "subtitles=caps.ass:fontsdir=./fonts" -c:a copy out.mp4
```

**Face-aware placement**
- Reuse the face box from the reframing step. Default captions to about 65–70% of frame height, and move them to the upper third if they would overlap the face.
- Instagram/TikTok UI covers roughly the top 220–270 px and bottom 320–400 px of a 1080×1920 frame ([community figures that vary, unverified](https://www.firstpier.com/resources/instagram-ad-safe-zones)).

## 3. Color grade
**Step 1: detect the input**
- `ffprobe -show_entries stream=color_transfer`: `arib-std-b67` means HLG, `smpte2084` means PQ.
- iPhone HDR video is [Dolby Vision 8.4 on an HLG base](https://engineering.fb.com/2025/11/17/ios/enhancing-hdr-on-instagram-for-ios-with-dolby-vision/).

**Step 2: convert HDR to SDR once, up front, in ffmpeg**
- Remotion only outputs SDR, and its OffthreadVideo component [tone-maps by default](https://www.remotion.dev/docs/hdr). Converting first means grading and the vision checks all see the same pixels.
- For Dolby Vision, use `libplacebo=apply_dolbyvision=true:tonemapping=bt.2390` ([requires a Vulkan build](https://dev.to/masonwritescode/ffmpeg-hdr-to-sdr-tone-mapping-that-doesnt-look-washed-out-2026-24ie)).

```
-vf "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
```

**Log footage**
- **Apple Log:** Apple's LUT is in the Apple Developer downloads. It was built for the 15 Pro, and Apple Log 2 has no easy official LUT ([user reports, unverified](https://discussions.apple.com/thread/256176419)).
- **S-Log3:** [Sony's official LUTs](https://pro.sony/en_GB/technology/professional-video-lut-look-up-table).

**Automatic correction**
- [`colorcorrect=analyze=average`](https://ayosec.github.io/ffmpeg-filters-docs/4.4/Filters/Video/colorcorrect.html) does gray-world white balance.
- Also useful: `normalize` (set `independence=0` to keep hue), `colortemperature`, `eq`, `curves`. Measure results with `signalstats`.

**Matching clips to each other**
- Compute the transform once per shot from a keyframe, using [skimage `match_histograms`](https://scikit-image.org/docs/stable/api/skimage.exposure.html) (BSD) or [color-matcher](https://github.com/hahnec/color-matcher) (**GPL-3.0**; MKL/Reinhard methods).
- Then **bake it into a LUT** by applying it to ffmpeg's identity image (`haldclutsrc`), and apply that with `haldclut` ([ffmpeg docs](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/haldclut.html)). Result: no flicker between frames, and fully deterministic.

**Where looks come from**
- Build your own looks the same way: run an ffmpeg filter chain on `haldclutsrc`. You own the output.
- Most free LUT packs allow use in projects but **forbid redistribution inside an app** ([FilterGrade, Shutterstock](https://www.shutterstock.com/blog/free-luts-for-log-footage)).

**AI grading: skip for v1**
- [Image-Adaptive-3DLUT](https://github.com/HuiZeng/Image-Adaptive-3DLUT), [AdaInt](https://github.com/ImCharlesY/AdaInt) and SepLUT are research code (licenses of the training data are unverified).
- [Deep Analog](https://arxiv.org/abs/2608.14702) (August 2026) predicts a `.cube` LUT from one reference frame. Whether its code is released is unverified.

**Letting the LLM pick a look safely**
- The LLM chooses only from a fixed list of LUT names plus an intensity capped at 0.8.
- Render a before/after contact sheet and have a vision model check skin tones and clipping.
- Add numeric guards on `signalstats` (YMIN/YMAX, SATAVG). If anything fails, fall back to "neutral".

```
ffmpeg -f lavfi -i haldclutsrc=8 -vf "curves=preset=medium_contrast,eq=saturation=1.1" -frames:v 1 look.png
-filter_complex "[0:v]split[a][b];[b]lut3d=file=look.cube:interp=tetrahedral[g];[g][a]blend=all_mode=normal:all_opacity=0.6"
```

## 4. Audio
**Noise reduction**
- **Recommended: [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)** (MIT/Apache, 48 kHz). The last official release is 0.5.6 and there's a [fork for Python 3.12](https://pypi.org/project/DeepFilterNet-py312/), so use the Rust `deep-filter` binary.
- **Built into ffmpeg:** `arnndn`. Its model files are not bundled; download them from [GregorR/richardpl](https://www.ffmpeg-micro.com/blog/ffmpeg-can-remove-background-noise-arnndn-breaks-in-docker).
- **[Resemble Enhance](https://github.com/resemble-ai/resemble-enhance)** (MIT): use `--denoise_only`. Its enhancer may change the voice (unverified).

**Loudness**
- Target −14 LUFS, −1 dBTP. This is common guidance; the [platforms don't publish official targets](https://apu.software/tiktok-instagram-reels-loudness/) (unverified).
- Use two-pass loudnorm with `linear=true` and pin `-ar 48000`, because [loudnorm upsamples to 192 kHz](https://dev.to/masonwritescode/two-pass-loudness-normalization-with-ffmpeg-loudnorm-the-right-way-1nm3). [ffmpeg-normalize](https://github.com/slhck/ffmpeg-normalize) automates this.

**Music ducking and sound effects**
- Use `amix` with `normalize=0`. Otherwise amix scales every input down.
- Timing is a heuristic (unverified): whoosh peak lands on the cut, pop on text appearing, sound effects about 10–15 dB under the voice.
- [Mixkit](https://www.licenseorg.com/guide/video/mixkit) sound effects need no attribution.

```
-filter_complex "[0:a]asplit[v][sc];[1:a][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[m];[v][m]amix=inputs=2:normalize=0"
```

## 5. B-roll sourcing and matching

| Source | Terms |
|---|---|
| **[Pexels](https://www.pexels.com/api/documentation/)** | 200 requests/hour, 20k/month (higher on request). A prominent Pexels link and photographer credit are required. No competing services. The [terms](https://www.pexels.com/terms-of-service/) ban "bulk, large-scale or systematic copying" and data mining "for machine learning purposes". Don't build a stored library or embedding index without permission. `video_pictures` gives preview frames; `orientation=portrait` works. |
| **[Pixabay](https://pixabay.com/api/docs/)** | 100 requests/60 s. Results must be cached 24 h. No permanent hotlinking, no systematic mass downloads, no orientation filter for video. |
| **[Coverr](https://coverr.co/license)** | **The license explicitly excludes "video editing services".** Avoid it, or negotiate. |
| **Mixkit** | Free license, no attribution, no competing service ([summary](https://www.licenseorg.com/guide/video/mixkit)). No public API. |
| **[Storyblocks API](https://www.storyblocks.com/resources/business-solutions/api)** | Paid, custom quote; used by Descript, Pictory and Lumen5. Artgrid has [no public API](https://www.saasworthy.com/product/artgrid). |

**Ranking candidates**
1. The LLM rewrites the spoken sentence into 2–3 concrete visual queries in English.
2. Fetch about 30 portrait candidates.
3. Score thumbnails and preview frames with [SigLIP 2](https://huggingface.co/google/siglip2-so400m-patch16-naflex) (Apache-2.0, multilingual).
4. Penalise cheesy stock with negative prompts ("staged handshake, thumbs up") and a [LAION aesthetic predictor](https://github.com/christophschuhmann/improved-aesthetic-predictor) (license unverified).
5. A vision LLM makes the final pick from the top 3–5 as a contact sheet.

**Where to place B-roll**
- The [B-Script study (CHI 2019)](https://arxiv.org/html/1902.11216v1) measured expert editors:
  - 73% of B-roll starts within ±1 s of the keyword it illustrates.
  - Clips run 0.5–8 s.
  - Median gap between B-roll clips is 9 s.
  - About 13% of the video ends up covered.
- For reels, keep the hook and punchlines on the face and put B-roll on concrete nouns and abstract ideas (practitioner consensus, unverified).

## 6. Reframing and zooms
**Face detection**
- **Recommended: MediaPipe Face Detector, Tasks API** ([Apache-2.0](https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector)). The older `mp.solutions` API is deprecated.
- **Lighter option: [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)** (MIT, via OpenCV `FaceDetectorYN`). It only detects faces of roughly 10–300 px, so downscale the frame first.
- **Avoid Ultralytics YOLO:** it's [AGPL-3.0](https://www.ultralytics.com/license), which forces a closed SaaS to buy an Enterprise license.
- Google's AutoFlip reframer was [discontinued in March 2023](https://mediapipe.readthedocs.io/en/latest/solutions/autoflip.html).

**Crop strategy**
- For a talking head, one **static crop per shot at the median face centre** beats continuous tracking.
- Track only when the subject moves. Smooth the path with a One-Euro filter plus a dead zone.
- [auto-vertical-reframe](https://github.com/KazKozDev/auto-vertical-reframe) (MIT, beta) is a reference implementation. It uses YOLO, so it inherits the AGPL problem.

**Punch-in zooms**
- Do them in Remotion: `scale(1.1–1.2)` with the transform origin on the face, starting at the emphasis word.
- The LLM marks which words to emphasise, confirmed against audio energy peaks.

```
-vf "crop=ih*9/16:ih:X:0,scale=1080:1920"
```

## 7. How the agent "sees" the video
- **Primary signal:** the word-timed transcript. Use frames only for visual quality checks.
- **Contact sheets:**
  - With more than 20 images per request, [Claude limits each image to 2000 px](https://platform.claude.com/docs/en/build-with-claude/vision).
  - Cost is ⌈w/28⌉×⌈h/28⌉ tokens, so a 6×3 grid of 180×320 thumbnails costs about 1.4k tokens.
  - Claude 4.7 and later accept images up to 2576 px on the long edge.
  - In Codex, attach with `codex -i a.png,b.png` ([docs](https://developers.openai.com/codex/cli/features.md)).
- **Scene detection:**
  - [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) (BSD-3, v0.7.1).
  - [TransNetV2](https://github.com/soCzech/TransNetV2) (MIT) is better on gradual transitions and stock clips.
- **Gemini native video:**
  - [Samples 1 fps by default](https://ai.google.dev/gemini-api/docs/video-understanding); fps and start/end offsets are adjustable.
  - Costs about 300 tokens/s (100 at low resolution) and includes the audio.
  - Its timestamps are only accurate to about 1–3 s ([forum](https://discuss.ai.google.dev/t/improve-timestamp-accuracy-on-video-understanding/95356)).
  - Use it for judgments like "which take is better" or "where does the energy drop", **never for cut points**.

```
ffmpeg -i in.mp4 -vf "fps=1,scale=180:320,drawtext=text='%{pts\:hms}':fontsize=14:fontcolor=white:box=1,tile=6x3" -frames:v 1 sheet.jpg
scenedetect -i in.mp4 detect-adaptive list-scenes save-images -n 1
```

**License red flags in one place:**
- CrisperWhisper weights: non-commercial.
- Ultralytics YOLO: AGPL.
- color-matcher: GPL-3.0; call it as a separate process.
- Coverr: excludes video editing services.
- Pexels: no bulk copying or indexing for ML.
- Remotion: paid once you pass 3 employees.