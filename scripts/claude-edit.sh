#!/usr/bin/env bash
# Run Claude Code headless on a project with ONLY the reel MCP tools.
#   scripts/claude-edit.sh <project_id> "<brief>" [log_file]
#   scripts/claude-edit.sh <project_id> --reply "<your answer to the plan>" [log_file]
# Uses the `claude` CLI the user already installed and signed in to. No shell,
# no file writes: the agent can only act through the MCP server (and Read, to
# look at images). The backend (npm start) must be running.
# The agent shows its plan and keeps editing. If the brief asks to review the
# plan first, the run stops after presenting it; answer with --reply ("ok", or the changes you want), which resumes
# the same conversation (session id kept in .captions-tmp/claude-<project>.session).
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$1"; shift
REPLY=""; if [ "${1:-}" = "--reply" ]; then REPLY="$2"; shift 2; else BRIEF="$1"; shift; fi
LOG="${1:-.captions-tmp/agent-$(date +%s).jsonl}"
mkdir -p "$(dirname "$LOG")" .captions-tmp
export SESSION_FILE=".captions-tmp/claude-${PROJECT}.session"
# who holds the project lock while this run edits it (scripts/project-lock.mjs)
export REEL_AGENT="claude-edit ${PROJECT} ${LOG}"

RESUME=()
if [ -n "$REPLY" ]; then
  if [ -s "$SESSION_FILE" ]; then
    PROMPT="$REPLY"; RESUME=(--resume "$(cat "$SESSION_FILE")")
  else
    PROMPT="Use the reel-edit skill. Project id: ${PROJECT}. You presented this project's plan earlier (get_project shows it and whether it is approved). The user's answer to it: ${REPLY}
Work only through the reel MCP tools. Approved → approve_plan quoting them, then finish the edit with validate + caption_proof, render a draft and say what you did, where you departed from the plan and what you would still improve. Changes → request_plan_changes, set_plan the revision, present it and stop."
  fi
else
  PROMPT="Use the reel-edit skill. Project id: ${PROJECT}. Brief: ${BRIEF}
Work only through the reel MCP tools. After set_plan, show the plan in your message and keep going (plan mode auto) — unless the brief asks to review the plan first: then set_plan_mode review, present it and stop; the user answers in the next message. Finish with validate + caption_proof, then render a draft and say what you did, where you departed from the plan and what you would still improve."
fi

claude -p "$PROMPT" ${RESUME[@]+"${RESUME[@]}"} \
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
      // keep the conversation for --reply
      if (e.session_id && process.env.SESSION_FILE && (e.type === "system" || e.type === "result")) require("fs").writeFileSync(process.env.SESSION_FILE, e.session_id);
      const blocks = e.message?.content ?? [];
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b.type === "tool_use") console.log(`→ ${b.name.replace("mcp__reel__", "")} ${JSON.stringify(b.input).slice(0, 140)}`);
        if (b.type === "text" && e.type === "assistant") console.log(`  ${b.text.slice(0, 300).replace(/\n/g, " ")}`);
      }
      if (e.type === "result") console.log(`\n■ ${e.subtype} — ${e.num_turns} turns, ${Math.round((e.duration_ms ?? 0) / 1000)} s${e.total_cost_usd ? `, $${e.total_cost_usd.toFixed(2)}` : ""}`);
    });'
