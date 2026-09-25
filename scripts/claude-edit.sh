#!/usr/bin/env bash
# Run Claude Code headless on a project with ONLY the reel MCP tools.
#   scripts/claude-edit.sh <project_id> "<brief>" [log_file]
# Uses the `claude` CLI the user already installed and signed in to. No shell,
# no file writes: the agent can only act through the MCP server (and Read, to
# look at images). The backend (npm start) must be running.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$1"; BRIEF="$2"; LOG="${3:-.captions-tmp/agent-$(date +%s).jsonl}"
mkdir -p "$(dirname "$LOG")"
# who holds the project lock while this run edits it (scripts/project-lock.mjs)
export REEL_AGENT="claude-edit ${PROJECT} ${LOG}"

PROMPT="Use the reel-edit skill. Project id: ${PROJECT}. Brief: ${BRIEF}
Work only through the reel MCP tools. Finish with validate + caption_proof, then render a draft and say what you did and what you would still improve."

claude -p "$PROMPT" \
  --output-format stream-json --verbose \
  --mcp-config .mcp.json --strict-mcp-config \
  --allowedTools "mcp__reel__*,Read,Skill" \
  --permission-mode dontAsk \
  --max-turns "${MAX_TURNS:-80}" \
  | tee "$LOG" \
  | node -e '
    // live one-line log of what the agent does
    const rl = require("readline").createInterface({input: process.stdin});
    rl.on("line", (l) => {
      let e; try { e = JSON.parse(l); } catch { return; }
      const blocks = e.message?.content ?? [];
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b.type === "tool_use") console.log(`→ ${b.name.replace("mcp__reel__", "")} ${JSON.stringify(b.input).slice(0, 140)}`);
        if (b.type === "text" && e.type === "assistant") console.log(`  ${b.text.slice(0, 300).replace(/\n/g, " ")}`);
      }
      if (e.type === "result") console.log(`\n■ ${e.subtype} — ${e.num_turns} turns, ${Math.round((e.duration_ms ?? 0) / 1000)} s${e.total_cost_usd ? `, $${e.total_cost_usd.toFixed(2)}` : ""}`);
    });'
