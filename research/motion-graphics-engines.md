**Recommendation:** keep Remotion as the only renderer. Build a small, locked library of motion-graphics templates in Remotion (about 20–30 components, each with typed props) and have the agent pick a template and fill in the text, numbers, icons and word timestamps. Don't have it write animation code from scratch. Don't adopt HyperFrames as a second engine yet. Borrow ideas from its catalog instead. Use Veo 3.1 Lite/Fast or Kling only for realistic 3–5s B-roll, never for text, numbers or UI.

The research points to one conclusion: LLMs are good at layout but bad at timing. The template holds the timing; the LLM supplies the content.

## 1. Remotion
- **License:** free for individuals, for-profit companies with up to 3 employees, non-profits, and evaluation. Everyone else needs a Company License ([LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)).
  - Automators tier: **$0.01 per render, $100/mo minimum**. Creators tier: **$25/seat/mo**. Enterprise: from $500/mo ([remotion.pro/license](https://www.remotion.pro/license)).
  - AI video editors and prompt-to-video services are explicitly allowed. Letting users upload their own Remotion code is not. Player and Studio previews are not counted as renders ([FAQ](https://www.remotion.dev/docs/license/faq)).
- **v5.0 changes (not released yet; latest is v4.0.527, 2026-09-22):**
  - Telemetry becomes mandatory on the Automators tier.
  - Contractors now count toward the 3-person limit ([5.0 migration](https://www.remotion.dev/docs/5-0-migration)).
  - `@remotion/media-parser` stops getting releases after 4.x. **Your repo depends on it** (`/Users/felipealonzo/autobroll/package.json`).
- **Agent skills:** `npx skills add remotion-dev/skills` works with Claude Code, Codex and Cursor ([docs](https://www.remotion.dev/docs/ai/skills)). There is also an official [prompt-to-motion-graphics SaaS template](https://www.remotion.dev/docs/ai/ai-saas-template) that compiles in the browser just in time and retries on compile errors.
- **@remotion/captions:** a standard `Caption` type with converters for whisper.cpp, whisper-web, the OpenAI Whisper API and ElevenLabs. MIT licensed ([docs](https://www.remotion.dev/docs/captions/api)).
- **Rendering options:**
  - Local rendering.
  - Lambda: a 1-minute video costs about $0.017 and takes about 19s ([cost example](https://www.remotion.dev/docs/lambda/cost-example)).
  - Cloud Run: "Alpha … not actively being developed" ([docs](https://www.remotion.dev/docs/cloudrun/)).
  - Vercel Sandbox: runs on a single machine, so it is slower than Lambda ([docs](https://www.remotion.dev/docs/vercel-sandbox)).
- **Open question:** your repo is MIT-licensed. The FAQ doesn't say whether companies of 4+ people who self-host it need their own Remotion license. Email hi@remotion.dev (**unverified**).

## 2. HeyGen HyperFrames
- **What it is:** each scene is an HTML page (CSS plus GSAP, CSS, Lottie, Three.js, Anime.js or WAAPI). Headless Chrome seeks frame by frame and FFmpeg encodes the result. Output is deterministic.
- **Status:** Apache-2.0, about 52.7k stars, v0.8.70 (no 1.0 yet) ([repo](https://github.com/heygen-com/hyperframes), [releases](https://github.com/heygen-com/hyperframes/releases)). Reported launch was April 2026 (**unverified**).
- **Agent skills:** `npx skills add heygen-com/hyperframes` works with Claude Code, Codex, Cursor and Gemini CLI. Several skills match your product directly: `/talking-head-recut`, `/embedded-captions`, `/motion-graphics` and `/remotion-to-hyperframes`.
- **Catalog:** 381 blocks, including 73 text/caption blocks, 18 chart blocks and 31 transitions ([catalog](https://hyperframes.heygen.com/catalog)).
- **Alpha output:** `--format mov` gives ProRes 4444 and `--format webm` gives VP9 alpha. The page background has to be left unpainted ([rendering](https://hyperframes.heygen.com/guides/rendering)). On Windows, WebM comes out with no alpha channel; that issue was closed "not planned" ([#2824](https://github.com/heygen-com/hyperframes/issues/2824)).
- **Weaknesses it admits:** it "breaks quietly" if you break its rules (paused timeline, no wall clock, seeded randomness only) ([vs Remotion](https://hyperframes.heygen.com/guides/hyperframes-vs-remotion)).
- **Speed:** reports conflict. One says a 30s 1080p render takes about 3 minutes locally ([andrew.ooo](https://andrew.ooo/posts/hyperframes-heygen-html-video-agents-review/)); another says it is faster than Remotion ([cutback](https://cutback.video/blog/hyperframes-vs-remotion-vs-selects)). Both are anecdotal and **unverified**.

## 3. Motion Canvas and Revideo
- **Motion Canvas:** MIT, 19k stars. The last npm release was 3.17.2 in February 2025, and the only 2026 commit is a docs domain change (checked with the GitHub API). Treat it as **dormant**.
- **Revideo:** MIT, moved to `midrender/revideo`, v0.11.0 released July 2026. PostHog telemetry is on by default ([repo](https://github.com/redotvideo/revideo)).
- **For LLM authoring:** both use TypeScript generator scenes, which have far less training data than HTML or React. Not recommended.

## 4. GSAP
- Everything is free for commercial use, including SplitText and MorphSVG, and "AI-generated code is not a Prohibited Use" ([license](https://gsap.com/community/standard-license/)).
- **The restriction:** you can't use it in "tools that allow users to build visual animations without code" that compete with Webflow's animation builder. "Competitive Products" means a "visual interface or builder similar to Webflow".
- **What that means for you:** a prompt-driven video editor is a **grey area**. The risk goes up if you add a visual editor for animations. Remotion doesn't need GSAP (it has `interpolate` and `spring`), but many HyperFrames blocks use it. Adopting HyperFrames brings this risk with it.

## 5. Lottie
- **Renderers:** `@remotion/lottie` uses lottie-web, whose repo was last pushed September 2025 ([docs](https://www.remotion.dev/docs/lottie/lottie)). dotLottie-web uses a ThorVG/WASM engine and is MIT ([repo](https://github.com/LottieFiles/dotlottie-web)). Skottie/SkottieTool is native Skia ([docs](https://skia.org/docs/user/modules/skottie/)).
- **LottieFiles free animations (Lottie Simple License):** commercial use is allowed and attribution isn't required. You may not "collect or compile Files … to develop a similar or competing service" ([help](https://help.lottiefiles.com/hc/en-us/articles/45243303062681-Commercial-Use-Attribution)).
- **LLMs writing Lottie JSON:** they do it badly. In the OmniLottie paper (CVPR 2026), GPT-5 produced a valid result only **12.7%** of the time on text-to-Lottie, with "schema hallucination" ([arXiv 2603.02138](https://arxiv.org/html/2603.02138v1)). Use Lottie only as curated assets; let the LLM change colors or text at most.

## 6. Other tools
- **Theatre.js:** the main repo was last pushed August 2024. Stalled.
- **Rive:** runtimes are open source. Production exports need a paid editor plan (about $9–32/seat, **unverified**). Built for interactive state machines, not video.
- **Manim:** MIT, active, 41k stars. Only useful for explainer-style scenes. A fine-tuned model with the renderer in the loop reached a 94% render success rate ([arXiv 2604.18364](https://arxiv.org/abs/2604.18364)).
- **nexrender:** MIT. Workers run only on Windows or macOS, and it needs After Effects installed. It auto-writes a render-only license file; check Adobe's EULA before using that on servers (**unverified**) ([repo](https://github.com/inlife/nexrender)).
- **Paid template APIs, as a price benchmark:**
  - Shotstack: $0.20–0.30 per minute ([pricing](https://shotstack.io/pricing/)).
  - JSON2Video: $49.95/mo for 200 minutes ([pricing](https://json2video.com/pricing/)).
  - Creatomate: about 14 credits per minute at 720p; the Essential plan is $54/mo (**unverified**, third-party source) ([pricing](https://creatomate.com/pricing)).

## 7. Which approach LLMs author most reliably
- **Timing is the weak spot.** In the Animation2Code benchmark (1,069 web animations), frontier models got 100% execution and 0.84 appearance similarity, but only **0.31 temporal similarity**. Iterative refinement didn't fix it ([arXiv 2606.28593](https://arxiv.org/html/2606.28593)).
- **Freehand Remotion drifts.** One practitioner saw font sizes vary from 14 to 19px for the same role and gaps from 2 to 22px. Locking a kit of tokens and components fixed it: "make it impossible to import" the old patterns ([Roboto Studio](https://robotostudio.com/blog/how-to-use-remotion-agent-skills-with-claude-code)).
- **HTML vs React:** HTML plausibly has the most training data, and both use the same Chrome + FFmpeg engine, so the quality ceiling is similar. Most of the comparison posts are vendor-adjacent ([HF guide](https://hyperframes.heygen.com/guides/hyperframes-vs-remotion)).
- **Ranking:** templates with typed props, then freehand HTML/GSAP, then freehand React. Rendering a still frame and checking it with a vision model helps in every case.

## 8. Transparent overlays (both commands tested locally with Homebrew ffmpeg)
- **Remotion ProRes:** `--image-format=png --pixel-format=yuva444p10le --codec=prores --prores-profile=4444`
- **Remotion WebM:** `--pixel-format=yuva420p --codec=vp8`. WebM alpha can flicker at chunk boundaries on Lambda, so use ProRes there ([docs](https://www.remotion.dev/docs/transparent-videos)).
- **HyperFrames:** `npx hyperframes render --format mov|webm`.
- **Compositing onto your footage** (tested: the overlay shows only in its time window and blends with alpha):
  ```
  ffmpeg -i base.mp4 -i ov.mov -filter_complex "[1:v]setpts=PTS-STARTPTS+1.5/TB[o];[0:v][o]overlay=0:0:eof_action=pass" -c:v libx264 -pix_fmt yuv420p out.mp4
  ```
- **Gotcha:** for VP9 WebM input, put `-c:v libvpx-vp9` **before** `-i`. Tested locally: ffmpeg's built-in VP9 decoder returns `yuv420p` and drops the alpha; libvpx returns `yuva420p`.

## 9. AI-generated B-roll (a complement, not the motion-graphics layer)
- **Veo 3.1 (official, audio included):**

  | Tier | 720p | 1080p |
  |---|---|---|
  | Lite | $0.05/s | $0.08/s |
  | Fast | $0.10/s | $0.12/s |
  | Standard | $0.40/s | $0.40/s |

  Source: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). A SynthID watermark is always embedded ([Veo docs](https://ai.google.dev/gemini-api/docs/veo)).
- **Runway API:** $0.01 per credit ([docs](https://docs.dev.runwayml.com/guides/pricing/)). Gen-4.5 is 12 credits, so $0.12/s (**secondary source**). Outputs can be used commercially, but Runway may train on them unless you're on Enterprise ([help](https://help.runwayml.com/hc/en-us/articles/21668707517587-Can-I-use-the-content-I-made-in-Runway-for-commercial-purposes)).
- **Kling 3.0:** 6–12 credits/s officially; about $0.075–0.10/s through resellers ([aggregator](https://www.buildmvpfast.com/api-costs/ai-video)).
- **Seedance 2.0:** $0.04–0.78/s on BytePlus (**unverified**).
- **Open weights:**
  - Wan 2.2: Apache-2.0 ([repo](https://github.com/Wan-Video/Wan2.2)). Wan 2.5 and 2.6 are reportedly API-only (**unverified**).
  - LTX-2: community license, free under $10M ARR ([LICENSE](https://github.com/Lightricks/LTX-2/blob/main/LICENSE.md)).
  - HunyuanVideo: license excludes the EU, UK and South Korea, and needs a separate license above 100M MAU ([LICENSE](https://github.com/Tencent-Hunyuan/HunyuanVideo/blob/main/LICENSE.txt)).
- **Cost and quality:** a 4s insert costs about $0.20–0.50. Quality is good for scenery, hands and products, and unreliable for text, numbers and UI. That second point is from practitioners and is **unverified**.

## 10. Asset sources (licenses checked in the repos and the Iconify API)
- **Icons:**
  - Lucide: ISC.
  - Phosphor: MIT.
  - Iconify: 238 sets with mixed licenses. Allow only MIT, Apache, ISC, CC0 and OFL. Exclude the 8 GPL or NC sets (for example `dashicons`, `icomoon-free`), and attribute or skip the 52 CC-BY sets ([api](https://api.iconify.design/collections)).
- **Emoji:**
  - Fluent Emoji (including the 3D versions): MIT. The best fit for emoji pops.
  - Noto: images Apache-2.0, font OFL.
  - Twemoji: graphics are **CC-BY 4.0, so attribution is required**.
- **Fonts:** Google Fonts is mostly OFL. I couldn't load the official FAQ, so this is **unverified**; check the license per family.
- **Sound effects:**
  - Freesound: filter to CC0 only; CC-BY-NC isn't commercial ([FAQ](https://freesound.org/help/faq/)). Commercial use of the **API needs a negotiated agreement** ([API ToS](https://freesound.org/help/tos_api/)). Pre-download a curated pack instead.
  - Pixabay: its API covers only images and video, no audio ([api](https://pixabay.com/api/docs/)), and standalone redistribution is banned. Curate by hand.

## License and cost risk

| Item | Risk | Cost | Note |
|---|---|---|---|
| Remotion | Medium | Free up to 3 people; then $0.01/render (min $100/mo) | 5.0 counts contractors, mandatory telemetry; self-hosters of your MIT repo unclear |
| HyperFrames | Low (license) / Medium (pre-1.0) | Free | Brings GSAP risk; Windows WebM alpha bug |
| GSAP | Medium (grey area) | Free | "No-code animation builder" clause |
| LottieFiles assets | Low–Medium | Free | Can't compile them into a competing library |
| Veo / Kling / Runway | Low | $0.05–0.40/s | Watermark (Veo); training on your outputs (Runway) |
| LTX-2 / Hunyuan | Medium | Your own GPUs | Revenue limit; territory exclusions |
| Twemoji / CC-BY icons | Low | Free | Attribution required |
| Freesound API / Pixabay SFX | Medium | Free | Needs an agreement (Freesound API) / no audio API (Pixabay); pre-curate |

**Unverified:** Creatomate and Seedance prices, Runway's per-model credits, Wan 2.5/2.6 availability, the HyperFrames launch date and speed claims, the Google Fonts FAQ, Adobe's render-node EULA, and how Remotion licensing applies to people who self-host your MIT repo.