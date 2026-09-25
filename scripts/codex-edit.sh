#!/usr/bin/env bash
# Run Codex CLI headless on a project with ONLY the reel MCP server (the second brain).
#   scripts/codex-edit.sh <project_id> "<brief>" [log_file]
# Uses the `codex` CLI the user already installed and signed in to. The user's
# own ~/.codex/config.toml is ignored for the run (no other MCP servers, no
# full-access sandbox): the reel server is passed on the command line with its
# tools pre-approved (default_tools_approval_mode=approve, approval_policy=never —
# without it Codex 0.156 rejects every MCP call in non-interactive mode), the
# shell sandbox is read-only (a `touch` in the repo is blocked; verified), nothing
# is persisted. The backend (npm start) must be running.
#   scripts/codex-edit.sh <project_id> --reply "<your answer to the plan>" [log_file]
# The agent shows its plan and keeps editing. If the brief asks to review the
# plan first, the run stops after presenting it; nothing is persisted, so --reply starts a new run that reads the plan back
# from the project (get_project) and acts on your answer.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$1"; shift
REPLY=""; if [ "${1:-}" = "--reply" ]; then REPLY="$2"; shift 2; else BRIEF="$1"; shift; fi
LOG="${1:-.captions-tmp/codex-$(date +%s).jsonl}"
mkdir -p "$(dirname "$LOG")"
# who holds the project lock while this run edits it (scripts/project-lock.mjs)
export REEL_AGENT="codex-edit ${PROJECT} ${LOG}"
ROOT="$(pwd)"

if [ -n "$REPLY" ]; then
  PROMPT="First read .agents/skills/reel-edit/SKILL.md, .agents/skills/reel-plan/SKILL.md and AGENTS.md and follow that workflow. Project id: ${PROJECT}. You presented this project's plan earlier (get_project shows it and whether it is approved). The user's answer to it: ${REPLY}
Work only through the reel MCP tools (never edit files or run commands). Approved → approve_plan quoting them, then finish the edit with validate + caption_proof, render a draft and say what you did, where you departed from the plan and what you would still improve. Changes → request_plan_changes, set_plan the revision, present it and stop."
else
  PROMPT="First read .agents/skills/reel-edit/SKILL.md and AGENTS.md and follow that workflow. Project id: ${PROJECT}. Brief: ${BRIEF}
Work only through the reel MCP tools (never edit files or run commands). After set_plan, show the plan in your message and keep going (plan mode auto) — unless the brief asks to review the plan first: then set_plan_mode review, present it and stop; the user answers with a new run. Finish with validate + caption_proof, then render a draft and say what you did, where you departed from the plan and what you would still improve."
fi

codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config \
  -C "$ROOT" -s read-only \
  -c 'approval_policy="never"' \
  -c "mcp_servers.reel.command=\"node\"" \
  -c "mcp_servers.reel.args=[\"${ROOT}/mcp/server.mjs\"]" \
  -c 'mcp_servers.reel.default_tools_approval_mode="approve"' \
  -c 'mcp_servers.reel.startup_timeout_sec=60' \
  -c 'mcp_servers.reel.tool_timeout_sec=1800' \
  "$PROMPT" \
  | tee "$LOG" \
  | node -e '
    // live one-line log: tool calls, agent text, final status (Codex event shapes vary by version)
    const rl = require("readline").createInterface({input: process.stdin});
    const t0 = Date.now();
    rl.on("line", (l) => {
      let e; try { e = JSON.parse(l); } catch { return; }
      const it = e.item ?? e;
      const kind = it.type ?? e.type ?? "";
      if (/mcp_tool_call|tool_call|function_call/i.test(kind) && (e.type ?? "").includes("started")) console.log(`→ ${(it.tool ?? it.name ?? "").replace(/^reel__?/, "")} ${JSON.stringify(it.arguments ?? it.input ?? "").slice(0, 140)}`);
      else if (/command_execution/i.test(kind) && (e.type ?? "").includes("started")) console.log(`⚠ shell: ${String(it.command ?? "").slice(0, 120)}`);
      else if (/agent_message|reasoning/i.test(kind) && (e.type ?? "").includes("completed") && it.text) console.log(`  ${String(it.text).slice(0, 300).replace(/\n/g, " ")}`);
      else if (e.type === "turn.completed" || e.type === "thread.completed" || e.type === "error") console.log(`■ ${e.type} — ${Math.round((Date.now() - t0) / 1000)} s${e.usage ? ` in ${e.usage.input_tokens} out ${e.usage.output_tokens}` : ""}${e.message ? ` ${e.message}` : ""}`);
    });'
