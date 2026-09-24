I checked all 14 repos you listed through the GitHub API and read each one's LICENSE, README, file tree and latest commit. Star counts and commit dates are as of 2026-09-23/24. All 14 exist, but some are smaller or thinner than their READMEs make them sound. The biggest licensing point applies to our own base: Remotion is not free for most companies, and HyperFrames is.

**Remotion licensing (applies to our base and to every Remotion project below).** Remotion is free only for individuals, companies with up to 3 employees, and non-profits ([LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)). Remotion's pricing page lists video editors and prompt-to-video apps under its "Automators" plan: $0.01 per render, $100/month minimum ([remotion.pro/license](https://www.remotion.pro/license)). A pending Remotion 5.0 license would also count contractors toward team size ([PR #3750](https://github.com/remotion-dev/remotion/pull/3750), still open).

---

### 1. itsjwill/vanta — https://github.com/itsjwill/vanta
- **Basics:** MIT, with an appended note that third-party models keep their own licenses (which is why GitHub shows "NOASSERTION"). 121★, last commit 2026-07-26, only 8 commits and 34 files. TypeScript on Remotion 4.
- **LLM/agent:** none. No MCP server, no skills, no API integration.
- **Motion graphics:** 5 demo scenes (such as KineticText and DataViz) plus "integration" files that are mostly config stubs or HTTP wrappers for servers you host yourself. The "100+ transitions" claim is about 30 transition names in [transitions.ts](https://github.com/itsjwill/vanta/blob/main/src/integrations/transitions.ts); `gl-transitions` isn't even a dependency.
- **Verdict:** a marketing README that funnels to a paid Skool community. It says it "replaces Remotion Pro" but is built on Remotion, so the Remotion license still applies. **Nothing worth reusing.**

### 2. notivn/AIEV — https://github.com/notivn/AIEV
- **Basics:** MIT, 119★. Last commit on main 2026-08-16 (last push 2026-09-19). TypeScript: Next.js web app, Express backend, SQLite.
- **LLM/agent:** runs Claude Code headless through `@anthropic-ai/claude-agent-sdk`, using either your Claude Code subscription login or `ANTHROPIC_API_KEY` ([agent.ts](https://github.com/notivn/AIEV/blob/main/apps/server/src/agent.ts)). Allowed tools are restricted and web tools are off, to limit prompt injection. About 20 skills in `.claude/skills`, including HyperFrames, GSAP, color-grading, auto-cut and short-form-video. Gemini generates illustrations.
- **Motion graphics:** Claude writes HyperFrames scenes (HTML + GSAP): kinetic typography, karaoke captions, beat-synced zooms, SFX placed by timestamp. Remotion then assembles the timeline. It also has 14 color presets, a draft → QC → final render queue, and brand kits.
- **Caveats:** the bundled SFX library has no licensing records, and its own README says not to use it commercially ([README](https://github.com/notivn/AIEV/blob/main/assets/sound-effects/README.md)). Using Remotion means we'd owe the Remotion license.
- **Reuse:** the architecture closest to what we want. Borrow the orchestration, skills, QC gates and the HyperFrames-scenes-into-assembly split.

### 3. LeonSooLab/openchatcut — https://github.com/LeonSooLab/openchatcut
- **Basics:** a **fork** (3★, last commit 2026-07-21) of the real project **0xsline/OpenChatCut** — https://github.com/0xsline/OpenChatCut — 1,983★, last commit 2026-09-21. **AGPL-3.0.** React 19, Electron, WebGL, Remotion (Player and export).
- **LLM/agent:** built-in agent on Vercel AI SDK, bring your own key for many providers. It also exposes an MCP endpoint over Streamable HTTP that Claude Code or Codex can connect to. Edits come as proposals you accept or undo.
- **Motion graphics:** the LLM writes inline JSX assets that run in a sandbox ([create-motion-graphics skill](https://github.com/0xsline/OpenChatCut/blob/main/src/agent/skills/create-motion-graphics/SKILL.md)), plus template packs. Before generating a batch it forces the user to pick a design style.
- **Reuse:** **ideas only.** AGPL rules out copying code into a closed product, and it uses Remotion.

### 4. veedstudio/open-edit — https://github.com/veedstudio/open-edit
- **Basics:** 684★, last commit 2026-09-22. TypeScript CLI plus a skill for Claude Code, Codex or Gemini CLI (`npx skills add`).
- **License split:** the repo is Apache-2.0. The renderer is **not in the repo**. It's a prebuilt binary downloaded at setup under **PolyForm Shield 1.0.0**, which forbids building a product that competes with VEED ([NOTICE](https://github.com/veedstudio/open-edit/blob/main/NOTICE), [LICENSE-binary.md](https://github.com/veedstudio/weave-renderer-public-releases/blob/main/LICENSE-binary.md)). Those two files even name the binary differently (`veed-engine-cli` vs `weave-viewer-cli`). **An AI reels editor would compete with VEED, so we can't ship its renderer.**
- **How it works:** the agent writes an HTML/CSS-style `.wv` document, which the native renderer draws (no headless browser, but it needs a desktop session). Only Apple Silicon and Windows x64. Transcription is VEED-hosted or local WhisperX.
- **Maturity:** the README says v1 targets captions, and motion graphics have rough edges.
- **Reuse:** the CLI's quality gates are worth copying: safe-zone, WCAG contrast, required per-word timings, EDL, beat frames.

### 5. diffusionstudio/editor — https://github.com/diffusionstudio/editor
- **Basics:** MPL-2.0 (brand assets excluded). 3,045★, last commit 2026-09-23 (v0.206.0). SolidJS, Electron, its own engine (koota ECS, mediabunny encoder, WebGPU). **No Remotion.**
- **LLM/agent:** the desktop app registers an MCP server with Claude Code, Codex, Cursor or Gemini. There's also a `diffusion`/`dapi` CLI, and skills at [diffusionstudio/skills](https://github.com/diffusionstudio/skills) (MIT).
- **How it works:** a project is a folder of JSX that the agent writes directly. Edits sync both ways: change the canvas and the code updates, change the code and the canvas redraws. Media tools include probe, filmstrip, waveform, transcribe and `listen` (ask a multimodal model about a clip).
- **Caveat:** transcription uploads to Diffusion's cloud (`api.diffusion.studio`), per the [transcribe handler](https://github.com/diffusionstudio/editor/blob/main/apps/web/src/dapi/handlers/media-transcribe.ts). Pricing and account requirements: **UNVERIFIED.**
- **diffusionstudio/core** — https://github.com/diffusionstudio/core — MPL-2.0, but its README says renders carry a watermark unless you buy a license key. 1,245★, last commit 2025-11-18, so effectively stale.

### 6. heygen-com/hyperframes — https://github.com/heygen-com/hyperframes
- **Basics:** **Apache-2.0, no per-render or company-size fees.** 52,699★, last commit 2026-09-24, v0.8.70, 68 contributors. Node 22.
- **How it works:** videos are plain HTML with `data-*` timing attributes. Animation can be GSAP, CSS, Lottie, Three.js, Anime.js or WAAPI. It renders frame-by-frame in headless Chrome and encodes with FFmpeg, so output is deterministic. Also available: AWS Lambda or HeyGen cloud rendering.
- **Skills (21):** a `/hyperframes` router plus workflows, including `/talking-head-recut` (lower thirds, data callouts, kinetic titles, picture-in-picture over the untouched clip), `/embedded-captions`, `/motion-graphics`, `/music-to-video` (beat-synced), `/remotion-to-hyperframes`, `/hyperframes-audio` and `/media-use`. Works with Claude Code, Codex and others.
- **Catalog:** [registry.json](https://github.com/heygen-com/hyperframes/blob/main/registry/registry.json) has 164 blocks, 223 components and 8 examples. Relevant ones include many `caption-*` styles, `yt-lower-third`, `data-chart`, `bar-chart-race`, `count-up`, `kinetic-type`, `ui-focus-zoom`, `cinematic-zoom`, `beat-accent`, `icon-morph-beat`, `x-follow-card` and `logo-sting`.
- **Caveat:** the `media-use` asset catalog (10k+ music tracks, 75k+ vectors, voice) needs a HeyGen CLI sign-in. The engine itself is fully local.
- **Reuse:** **the best motion-graphics engine and catalog for our purpose.**

### 7. browser-use/video-use — https://github.com/browser-use/video-use
- **Basics:** MIT, 26,570★, last commit 2026-08-30. A Python skill for Claude Code or Codex, symlinked into the agent's skills folder.
- **Cutting:** ElevenLabs Scribe transcription (**API key required**) is packed into a ~12KB `takes_packed.md`. For hard decisions, `timeline_view` renders a PNG of filmstrip, waveform and word labels. The agent writes an edit decision list, which renders through ffmpeg with 30ms audio fades at every cut. `grade.py` does color grading. After rendering, it checks every cut point and re-renders up to 3 times.
- **Motion graphics:** sub-agents build animations in parallel with HyperFrames, Remotion, Manim or PIL.
- **Reuse:** **copy the cutting pipeline**: pack the transcript as text, only look at pictures on demand, then self-check the render.

### 8. Quick checks

| Repo | License | ★ / last commit | Summary |
|---|---|---|---|
| [kwakseongjae/dawn-cut](https://github.com/kwakseongjae/dawn-cut) | MIT | 10 / 2026-07-10 | Local Electron editor (whisper.cpp + FFmpeg): text-based cutting, silence removal, Korean subtitles, color, reframing. Its local-LLM planner and MCP server are labeled experimental. v0.1. |
| [openreelio/openreelio](https://github.com/openreelio/openreelio) | MIT | 76 / 2026-09-13 | Prompt-first desktop editor (Tauri 2/Rust + React). Pre-alpha. |
| [mutonby/openshorts](https://github.com/mutonby/openshorts) | MIT, **except `cloud/`**, which is under a commercial license | 5,558 / 2026-09-23 | Python: long video → 9:16 shorts. Gemini picks moments, face tracking, subtitles, dubbing. Has MCP and REST. |
| [mutonby/shortcast](https://github.com/mutonby/shortcast) | Apache-2.0 | 386 / 2026-06-04 | Native macOS app, on-device (Gemma 4 12B + WhisperKit + MLX): auto-cuts and captions shorts. |
| [mutonby/vibetube](https://github.com/mutonby/vibetube) | MIT | 78 / 2026-09-15 | Electron screen+webcam recorder. Runs Claude Code or `codex exec --json` headless with the bundled video-use skill, HyperFrames and HeyGen SFX; publishes via Upload-Post. |
| [andriidrok1/autobroll](https://github.com/andriidrok1/autobroll) | MIT | 11 / 2026-09-16 | Confirmed: Remotion + WhisperX + Gemini + Pexels, MCP server with 24 tools (added in v0.4.0). |

### 9. Other active projects
- **[calesthio/OpenMontage](https://github.com/calesthio/OpenMontage)**: AGPL-3.0, 61k★ (created 2026-03-29), last commit 2026-09-06. Python agent pipelines (including `talking-head.yaml`). The agent chooses Remotion or HyperFrames per project from a decision matrix.
- **[digitalsamba/claude-code-video-toolkit](https://github.com/digitalsamba/claude-code-video-toolkit)**: MIT, 2.1k★, last commit 2026-09-10. Claude Code `/video` and `/setup` commands, Remotion templates, open models on your own cloud GPU.
- **[nateherkai/hyperframes-student-kit](https://github.com/nateherkai/hyperframes-student-kit)**: MIT, but AI Automation Society brand assets are excluded. 914★, last commit 2026-09-08. 14 skills in both `.claude` and `.agents` form (cut-silences, cut-mistakes, short-form-edit) and 406 draft motion-graphics cards on HyperFrames.
- **[nexu-io/html-video](https://github.com/nexu-io/html-video)**: Apache-2.0, 4.6k★, last commit 2026-06-21. HTML → MP4 for agents, pluggable render engines, 21 templates.
- **[pireel/pireel](https://github.com/pireel/pireel)**: AGPL-3.0-only (its agent plugin is Apache-2.0), 1.2k★, last commit 2026-09-18. A CapCut-style editor agents drive over MCP.
- **[remotion-dev/skills](https://github.com/remotion-dev/skills)**: 4.7k★, last commit 2026-09-22. Official Remotion agent skills (captions, create, maps). **No LICENSE file, so reuse terms are UNVERIFIED.**
- Also [mariagorskikh/talking-head-reel](https://github.com/mariagorskikh/talking-head-reel) (MIT, 42★, created 2026-09-22), a Claude Code skill that matches our use case almost exactly. I only checked its metadata; **its features are UNVERIFIED.**

---

### Most reusable for us (ranked)
1. **HyperFrames**: Apache-2.0 engine with no render fees, and 387 catalog items covering captions, lower thirds, charts, count-ups and beat zooms. It directly solves the motion-graphics B-roll problem.
2. **video-use**: MIT, a proven cutting brain (packed transcript, timeline PNG, edit list → ffmpeg, grading, self-check). Lift it almost whole.
3. **AIEV**: MIT, closest end-to-end match (Claude Agent SDK on the user's subscription + HyperFrames scenes + assembly + QC gates). Copy the orchestration and skills; leave out the SFX library.
4. **hyperframes-student-kit**: MIT, ready-made reels skills and 406 cards for both Claude and Codex.
5. **vibetube**: MIT, a working example of driving Claude Code and Codex headless from an app (sessions per provider, CLAUDE.md/AGENTS.md brief, timeouts).
6. **open-edit**: Apache CLI with good quality gates to copy. Its renderer is off-limits because of the noncompete.
7. **diffusionstudio/editor**: MPL, worth borrowing the "edits become code" sync and its media inspection tools. Its AI features depend on their cloud.
8. **OpenChatCut / OpenMontage**: AGPL, ideas only (proposal-based MCP edits, design-style gate, choosing the render engine per project).
9. **Vanta**: nothing usable.

**Strategic flag:** if we ship a product with Remotion rendering (our current base), we owe Remotion $0.01 per render with a $100/month minimum. Moving motion graphics, or all rendering, to HyperFrames avoids that.