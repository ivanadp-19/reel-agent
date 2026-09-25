// The plan step, chat-first. The agent always writes its plan (set_plan) and
// shows it in the chat before editing — the point is to think before acting.
// That discipline lives in the skills (reel-plan / reel-edit). What happens
// after the plan is shown depends on the project's plan mode:
//   auto (default — unattended runs, nobody to ask): keep going.
//   review (opt-in, only when the user asks for it: set_plan_mode): present it
//     and stop; the user answers in the chat and the agent records it
//     (approve_plan / request_plan_changes). Until the plan is approved, the
//     MCP tools that edit the project and the final render refuse to run.
// Pure (no JSX, no fs): the MCP server shares every rule here.
import {placeClips, type Clip} from './timeline.ts';
import type {TClip} from './cuts.ts';

// one answer of the user to the plan, in their words
export type PlanReview = {decision: 'approved' | 'changes'; said: string; notes?: string; at: string};
// what approval needs from a project
export type Plannable = {plan?: string; planApproved?: boolean; planReviews?: PlanReview[]; planMode?: PlanMode | null; planModeLog?: PlanModeChange[]};
// who switched the plan mode, in their words
export type PlanModeChange = {mode: PlanMode; said: string; at: string};

export type PlanMode = 'auto' | 'review';
export const PLAN_MODES: PlanMode[] = ['auto', 'review'];
const isMode = (m: unknown): m is PlanMode => PLAN_MODES.includes(m as PlanMode);
// review only when the project was switched to it; anything else is auto
export const planMode = (p: Plannable): PlanMode => (isMode(p.planMode) ? p.planMode : 'auto');

const KEEP_REVIEWS = 12;

// switch the plan mode on the user's request; the log keeps who asked, quoted
export function setPlanMode(p: Plannable, mode: PlanMode, said: string, at = new Date().toISOString()): {planMode: PlanMode; planModeLog: PlanModeChange[]; error?: string} {
  const log = p.planModeLog ?? [];
  const quoted = said.trim();
  if (!isMode(mode)) return {planMode: planMode(p), planModeLog: log, error: `plan mode is ${PLAN_MODES.join(' or ')}`};
  if (!quoted) return {planMode: planMode(p), planModeLog: log, error: 'quote what the user said (user_said)'};
  return {planMode: mode, planModeLog: [...log, {mode, said: quoted, at}].slice(-KEEP_REVIEWS)};
}

// a new or edited plan needs a new yes; the same text keeps the answer it had
export function withPlan(p: Plannable, plan: string): {plan: string; planApproved: boolean; changed: boolean} {
  const next = plan.trim();
  const changed = next !== (p.plan ?? '').trim();
  return {plan: next, planApproved: changed ? false : !!p.planApproved, changed};
}

// record the user's answer → the new approval state (the log keeps the last few rounds)
export function reviewPlan(p: Plannable, r: {decision: PlanReview['decision']; said: string; notes?: string}, at = new Date().toISOString()): {planApproved: boolean; planReviews: PlanReview[]; error?: string} {
  const log = p.planReviews ?? [];
  if (!p.plan?.trim()) return {planApproved: false, planReviews: log, error: 'there is no plan yet (set_plan first)'};
  const said = r.said.trim();
  if (!said) return {planApproved: !!p.planApproved, planReviews: log, error: 'quote what the user said (user_said)'};
  const notes = r.notes?.trim();
  const entry: PlanReview = {decision: r.decision, said, ...(notes ? {notes} : {}), at};
  return {planApproved: r.decision === 'approved', planReviews: [...log, entry].slice(-KEEP_REVIEWS)};
}

// the changes the user asked for since the last yes (what a revised plan must answer)
export function pendingChanges(p: Plannable): PlanReview[] {
  const log = p.planReviews ?? [];
  const lastYes = log.findLastIndex((r) => r.decision === 'approved');
  return log.slice(lastYes + 1).filter((r) => r.decision === 'changes');
}

const quote = (r: PlanReview) => `"${r.said}"${r.notes ? ` (${r.notes})` : ''}`;

// one line for get_project
export function planStatus(p: Plannable, mode: PlanMode = planMode(p)): string {
  if (!p.plan?.trim()) return 'no plan';
  if (p.planApproved) {
    const yes = (p.planReviews ?? []).findLast((r) => r.decision === 'approved');
    return `APPROVED by the user${yes ? ` — ${quote(yes)}` : ''} (plan mode ${mode})`;
  }
  const asked = pendingChanges(p);
  const changes = asked.length ? `; changes asked: ${asked.map(quote).join('; ')}` : '';
  if (mode === 'auto') return `plan mode auto — shown in the chat, the edit goes on without waiting for approval${changes}`;
  return `NOT APPROVED (plan mode review) — present it in the chat and wait for the user's answer${changes}`;
}

// null = go ahead; otherwise why not. Auto mode or an approved plan = go ahead;
// in review mode, no plan yet blocks too (the user asked to see it first).
export function planGate(p: Plannable, action: string, mode: PlanMode = planMode(p)): string | null {
  if (mode !== 'review' || p.planApproved) return null;
  if (!p.plan?.trim()) return `${action} waits for the plan (plan mode review): write it with set_plan, present it in the chat and STOP until the user answers. Reading, looking (frame_at, caption_proof), searching and draft renders still work.`;
  const asked = pendingChanges(p);
  return `${action} waits for the user to approve the plan (plan mode review). Present the plan in the chat (get_project shows it) and STOP until they answer: "ok" → approve_plan with their words; changes → set_plan with the revised plan, present it again and stop.${asked.length ? ` Changes asked so far: ${asked.map(quote).join('; ')}.` : ''} Reading, looking (frame_at, caption_proof), searching and draft renders still work.`;
}

// ---- presenting the plan: the word ids it names, as words and where they sit ----
export type PlacedWord = {wid: string; text: string; clipId: string; atMs: number};
export function planWords(plan: string, tr: TClip[], clips: Clip[], fps: number): {found: PlacedWord[]; missing: string[]} {
  const wids = [...new Set((plan ?? '').match(/\b[\w.-]+:\d+\b/g) ?? [])];
  const placed = placeClips(clips, fps);
  const found: PlacedWord[] = [], missing: string[] = [];
  for (const wid of wids) {
    const k = wid.lastIndexOf(':'), source = wid.slice(0, k), i = Number(wid.slice(k + 1));
    let hit: PlacedWord | null = null;
    for (const t of tr) {
      if (t.source !== source) continue;
      const w = t.words.find((x) => x.i === i);
      const pc = placed.find((x) => x.clip.id === t.clipId);
      if (!w || !pc || w.startMs < pc.clip.inSec * 1000 || w.startMs >= pc.clip.outSec * 1000) continue;
      hit = {wid, text: w.word, clipId: t.clipId, atMs: pc.startMs + (w.startMs - pc.clip.inSec * 1000) / (pc.clip.speed ?? 1)};
      break;
    }
    if (hit) found.push(hit); else missing.push(wid);
  }
  return {found: found.sort((a, b) => a.atMs - b.atMs), missing};
}
