I checked official Anthropic and OpenAI docs, the source of the tools that already drive both engines, and the npm registry on 2026-09-23. Claims marked **[2nd]** come from secondary sources. Claims marked **[unverified]** are my own estimates or guesses.

## Short answer
- **Claude subscription:** allowed only in one form. Your app launches the user's own copy of the `claude` CLI, unmodified, after the user signed in through Claude's own login. Your app must never offer a Claude sign-in or handle Claude tokens itself. Building on the Agent SDK with Claude subscription login is not allowed unless Anthropic approves it. The API-key route is always allowed.
- **Codex with a ChatGPT plan:** OpenAI documents it for use inside your own product, but no terms page explicitly permits or forbids it. Lower risk than Anthropic, but also less explicit.
- **Architecture:** make your existing MCP server the contract, and write one small adapter per engine that launches the CLI and parses its JSON output. That is about 20 lines per engine; VibeTube does it in a 92-line file.

## 1. Claude Code as the engine
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk` (v0.3.281 on npm today) and Python `claude-agent-sdk`. The `query()` options include `allowedTools`, `permissionMode`, `canUseTool`, `mcpServers`, `hooks`, `agents` (subagents), `settingSources`, `skills`, `resume`/`forkSession`, `outputFormat: {type:'json_schema'}` and `maxBudgetUsd`. https://code.claude.com/docs/en/agent-sdk/typescript
- **Headless mode:**
  - Core flags: `claude -p --output-format stream-json --verbose`. Add `--input-format stream-json` for two-way sessions.
  - `--json-schema` puts the result in a `structured_output` field.
  - `--allowedTools`, `--permission-mode dontAsk|acceptEdits|auto` and `--permission-prompts none` control permissions.
  - `--mcp-config` with `--strict-mcp-config`, `--setting-sources`, `--max-budget-usd` and `--resume <session_id>` control config, spend and sessions.
  - JSON output includes `total_cost_usd`.
  - Sources: https://code.claude.com/docs/en/headless and https://code.claude.com/docs/en/cli-reference
- **Catch with `--bare`:** it is the recommended mode for scripts, but it "never reads OAuth credentials", so it only works with an API key. (headless doc above)
- **Skills:** `.claude/skills/<name>/SKILL.md`, following the agentskills.io open standard. https://code.claude.com/docs/en/skills
- **AGENTS.md:** read natively (v2.1.277+) when there is no CLAUDE.md. Anything under `.agents/` is not read. https://code.claude.com/docs/en/memory
- **Looking at rendered frames:** yes. The Read tool returns PNG/JPG "as visual content that Claude can see". https://code.claude.com/docs/en/tools-reference
- **Frame cost:** each 28×28-pixel patch is one token. A 1080×1920 frame is about 2,691 tokens; a 540×960 preview is about 700. https://platform.claude.com/docs/en/build-with-claude/vision

## 2. Codex as the engine
- **`codex exec`:**
  - Output: `--json` gives a JSONL event stream (`thread.started`, `turn.*`, `item.*`, `error`). `--output-schema <file>` and `-o` give the final message.
  - Run control: `--sandbox workspace-write`, `--skip-git-repo-check`, `--ephemeral`, `resume <id>`.
  - Auth: `CODEX_API_KEY` for CI.
  - Source: https://developers.openai.com/codex/noninteractive
- **SDK:**
  - `@openai/codex-sdk` (v0.156.1) wraps the CLI: `startThread`, `run`/`runStreamed`, `resumeThread`, `outputSchema`, and `{type:"local_image"}` input.
  - Python `openai-codex` drives the app-server.
  - Sources: https://github.com/openai/codex/blob/main/sdk/typescript/README.md and https://learn.chatgpt.com/docs/codex-sdk
- **app-server:** OpenAI recommends it for "a deep integration inside your own product". Auth modes are API key, `chatgpt` (Codex runs the OAuth itself) and `chatgptAuthTokens`. `turn/start` accepts `outputSchema` and `localImage`. https://developers.openai.com/codex/app-server
- **MCP:** `[mcp_servers.<name>]` in `~/.codex/config.toml` or a project's `.codex/config.toml` (trusted projects only). Supports stdio or streamable-HTTP `url`, and per-run `-c` overrides. https://developers.openai.com/codex/mcp
- **Skills:** same SKILL.md open standard. Folders are `.agents/skills` (repo) and `$HOME/.agents/skills`; invoke with `$skill-name`; optional `agents/openai.yaml`. https://developers.openai.com/codex/skills
- **Images:**
  - Codex has a built-in `view_image` tool: "View a local image file from the filesystem when visual inspection is needed." https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/view_image_spec.rs
  - `codex exec --image a.png,b.png` **[2nd]** https://codex.danielvaughan.com/2026/03/28/codex-cli-image-workflows/
- **Sandbox:** read-only, workspace-write (no network by default) or danger-full-access. `approval_policy` is `on-request` or `never`. https://learn.chatgpt.com/docs/sandboxing
- **Hooks:** PreToolUse, PostToolUse, Stop and others, in `hooks.json` or `config.toml` **[2nd]**. https://developers.openai.com/codex/config-reference

## 3. One interface for both engines
- **ACP (Zed's Agent Client Protocol, JSON-RPC):**
  - Adapters: `@agentclientprotocol/claude-agent-acp` (built on the Agent SDK) and `@agentclientprotocol/codex-acp` (built on app-server). Client library: `@agentclientprotocol/sdk` 1.5.0.
  - Sources: https://agentclientprotocol.com/get-started/agents and https://github.com/agentclientprotocol/codex-acp
  - Because the Claude adapter uses the Agent SDK, it falls under the SDK login restriction in §4 (my reading).
- **Vibe Kanban (sunsetting):** does not use ACP for these two. It runs `claude -p --output-format=stream-json --input-format=stream-json --include-partial-messages` and `codex app-server`, then converts each engine's logs into its own format.
  - https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executors/claude.rs
  - https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executors/codex.rs
- **VibeTube (closest to your product):**
  - Codex command: `codex exec --sandbox workspace-write -c approval_policy="never" --json --skip-git-repo-check [resume id]`.
  - Claude command: `claude -p … --permission-mode bypassPermissions --output-format stream-json --verbose [--resume id]`.
  - It writes CLAUDE.md and AGENTS.md, bundles the video-use skill and relies on the user's existing CLI login.
  - https://github.com/mutonby/vibetube/blob/main/electron/providers.js
- **Conductor:** reuses whatever Claude Code or Codex login is already on the machine **[2nd]**. https://rywalker.com/research/conductor
- **OpenCode:** runs its own agent loop over provider APIs. It removed Claude Pro/Max login in January 2026, citing Anthropic legal requests **[2nd]**. https://www.zbuild.io/resources/news/opencode-blocked-anthropic-2026
- **OpenShorts:** ships an Agent Skill and an MCP server; it does not wrap an engine. https://github.com/mutonby/openshorts

## 4. Auth and terms
**Anthropic** (primary source: https://code.claude.com/docs/en/legal-and-compliance):
- **Not allowed:** "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." Developers also "may not collect, store, or intermediate Claude.ai credentials or session tokens".
- **The exception:** it "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- **If you ship or host Claude Code in your product:**
  - Commercial Terms apply.
  - The binary must not be modified.
  - You cannot "pay for, resell, or intermediate" usage; each end user uses their own API key, subscription or cloud-provider credential.
- **Agent SDK:** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login… including agents built on the Claude Agent SDK." https://code.claude.com/docs/en/agent-sdk/overview
- **Usage limits:** Pro/Max limits "assume ordinary, individual usage". Headless and SDK usage currently count against subscription limits. The separate monthly credit Anthropic planned was paused on 2026-06-15, with advance notice promised before any revised version. https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- **The rules have changed often this year [2nd]:** January OAuth block, February terms clause, April 4 ban, May 13 reversal, June 15 pause. https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026
- **Therefore:**
  - OK: launching the user's installed `claude`, where they logged in themselves.
  - Not OK: a "Sign in with Claude" button in your app, or asking users to paste a `setup-token` into it.
  - Agent SDK with subscription login needs Anthropic's approval.
  - Get written confirmation from Anthropic sales before a commercial launch. This is not legal advice.

**OpenAI:**
- The auth docs recommend API keys for automated runs, say "Don't expose Codex execution in untrusted or public environments", and warn that `~/.codex/auth.json` holds access tokens and should be treated "like a password". https://developers.openai.com/codex/auth
- app-server officially offers ChatGPT-managed login for embedding in your own product (link in §2).
- When asked, OpenAI staff only pointed to the general Terms of Use; commercial bring-your-own-plan questions were still unanswered as of August 2026. https://github.com/openai/codex/discussions/8338
- An OpenAI executive publicly welcomed third-party harnesses on ChatGPT plans **[2nd]**. https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/

## 5. Pipeline practices from existing projects
- **video-use:** works from the transcript first (a packed file of about 12KB) and pulls filmstrip/waveform PNGs only when needed. Flow is EDL → render → self-check at every cut, with up to 3 re-renders. Its argument against sending raw frames: "30,000 frames × 1,500 tokens = 45M tokens". https://github.com/browser-use/video-use
- **Montazh_Agent:** cuts on word-level speech-to-text timestamps. It checks for black frames, silence and duration drift, and exports a JSON EDL plus OpenTimelineIO. https://github.com/AgentSmoki/Montazh_Agent
- **HyperFrames:** renders HTML to MP4 deterministically and ships skills for Claude Code and Codex. https://github.com/heygen-com/hyperframes
- **Remotion:** `npx skills add remotion-dev/skills`, for Claude Code, Codex and others. https://www.remotion.dev/docs/ai/skills
- **Failure modes, from a vendor blog:**
  - Opus claimed a 299 s reel but delivered 578 s (it got its own arithmetic wrong).
  - All 11 of 11 cuts landed mid-sentence.
  - Transcript word timestamps are only accurate to about 120 ms.
  - https://cutback.video/blog/claude-for-video-editing-in-2026-what-works-what-breaks-and-the-real-pipeline
- **Rules this suggests:**
  1. The agent refers to **word IDs and clip IDs, never seconds**. Your code computes times, padding and durations, which removes the timestamp and arithmetic errors.
  2. The agent submits its plan through an MCP tool such as `submit_edit_plan`, validated against a JSON Schema on the server. Errors go back as the tool result so the agent fixes them. This works the same on both engines. Use `--json-schema`/`--output-schema` only for the final summary. OpenAI's strict-schema subset is the safer shared format **[unverified]**.
  3. Run cheap automatic checks first (ffprobe duration, silence detection, black-frame detection, caption safe zones). Then render a 540×960 preview and send one contact-sheet image of frames at the cuts, which the agent inspects with Read or `view_image`. Cap this at 2–3 rounds.
  4. For motion graphics, render single stills and type-check the code before a full render.
  5. Use a Stop hook on both engines to block finishing until the checks pass, and put a time limit on the child process. VibeTube uses a 15-minute idle limit and a 3-hour cap.

## 6. Cost, latency and models [unverified estimates; measure with `total_cost_usd` and Codex `turn.completed` usage]
Assumed session: about 30 turns, about 1.5M cached input tokens read, about 150k cache-write tokens, about 40k output tokens, about 20 preview frames.

| Model | Price per million tokens (in / out / cache read) | Estimated cost per session |
|---|---|---|
| Sonnet 5 | $2 / $10 / $0.20 | ~$1.1 |
| Opus 5.5 | $4 / $20 / $0.20 | ~$1.9 |
| GPT-6 Sol | $2 / $10 / $0.20 | ~$1.0 |

Latency is roughly 3–10 minutes of agent time plus rendering.

Prices: https://platform.claude.com/docs/en/about-claude/pricing and https://developers.openai.com/api/docs/pricing

**Model choice:**
- Anthropic: "start with Claude Opus 5.5 for most workloads"; Sonnet 5 is "the best combination of speed and intelligence". https://platform.claude.com/docs/en/about-claude/models/overview
- OpenAI: GPT-6 Sol is "built for complex coding and agentic workflows"; Luna is for high-volume work; GPT-5.5 retires 2026-10-14. https://learn.chatgpt.com/docs/models
- My suggestion: Opus 5.5 or GPT-6 Sol for motion-graphics code and for editorial choices. Use Haiku 4.5 or GPT-6 Luna subagents for transcript tagging and B-roll keywords. No public benchmark covers editorial judgment, so run an eval on about 10 of your own reels.

## Recommended harness
```
project/
  AGENTS.md                      # one instruction file for both engines
  .agents/skills/*               # Codex reads this
  .claude/skills -> ../.agents/skills   # symlink for Claude
MCP server (you already have it): get_words, submit_edit_plan (schema-checked),
  render_preview, contact_sheet, pexels_search, render_final
```
```js
const args = {
  claude: (p, sid) => ['-p', p, '--output-format','stream-json','--verbose',
    '--mcp-config','mcp.json','--strict-mcp-config','--permission-mode','dontAsk',
    '--allowedTools','mcp__reel__*,Read,Write,Edit', ...(sid ? ['--resume', sid] : [])],
  codex: (p, sid) => ['exec','--json','--sandbox','workspace-write','-c','approval_policy="never"',
    '-c','mcp_servers.reel.url="http://127.0.0.1:7777/mcp"','--skip-git-repo-check',
    ...(sid ? ['resume', sid] : []), '--', p],
};
```
- The Codex `-c mcp_servers…` override comes from the config keys but I haven't tested it.
- Parse each output stream into `{text, tool, done, cost, sessionId}`.
- Two auth modes: "use my installed CLI login" (don't pass `--bare`) or "my API key" (put it in the child process's environment).
- **Left out:** ACP and both SDKs. Add ACP if you need an interactive approval UI or more engines. Add the Codex SDK or app-server if you want in-process callbacks. The Claude Agent SDK is the restricted route for subscription login.