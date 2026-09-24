// Metrics of one headless agent run (scripts/claude-edit.sh):
//   node scripts/run-report.mjs <log.jsonl> <project_id> [--json]
// Reads the stream-json log and the project as it ended (public/projects/<id>.json).
import fs from 'node:fs';
import path from 'node:path';
import {validateProject} from '../src/validate.ts';
import {placeClips} from '../src/timeline.ts';
import {transcribeClip} from './lib-transcribe.mjs';

const [logFile, id, flag] = process.argv.slice(2);
if (!logFile || !id) { console.error('usage: node scripts/run-report.mjs <log.jsonl> <project_id> [--json]'); process.exit(1); }
const PUBLIC = path.join(process.cwd(), 'public');
const events = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const p = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'projects', `${id}.json`), 'utf8'));

const calls = {}; const errors = []; let bySeconds = 0;
for (const e of events) for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
  if (b.type === 'tool_use') {
    const n = b.name.replace('mcp__reel__', '');
    calls[n] = (calls[n] ?? 0) + 1;
    if ((n === 'split_clip' && b.input?.at_sec != null) || n === 'trim_clip') bySeconds++;
  }
  if (b.type === 'tool_result' && b.is_error) errors.push((Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join(' ') : String(b.content)).replace(/\s+/g, ' ').slice(0, 160));
}
const schema = errors.filter((t) => /invalid_type|Too big|Too small|expected|Invalid|must be|: props|InputValidationError/i.test(t));
const result = events.findLast((e) => e.type === 'result') ?? {};

// off-mic words still inside the cut (same flags the agent saw)
let offKept = 0;
for (const c of p.clips) {
  let words = [];
  try { words = transcribeClip(c, p.lang ?? 'auto', 'mark'); } catch {}
  offKept += words.filter((w) => w.off && w.endMs > c.inSec * 1000 && w.startMs < c.outSec * 1000).length;
}
const faces = Object.fromEntries(p.clips.map((c) => { try { return [c.src, JSON.parse(fs.readFileSync(path.join(PUBLIC, 'clips', 'faces', `${path.basename(c.src).replace(/\.[^.]+$/, '')}.json`), 'utf8'))]; } catch { return [c.src, undefined]; } }));
const issues = validateProject(p, 30, faces);
const placed = placeClips(p.clips, 30);
const out = {
  project: id,
  durationSec: +(placed.length ? placed[placed.length - 1].endMs / 1000 : 0).toFixed(1),
  clips: p.clips.length,
  offMicWordsKept: offKept,
  cutsBySeconds: bySeconds,
  cutWords: calls.cut_words ?? 0,
  schemaRejections: schema.length,
  toolErrors: errors.length,
  validateWarnings: issues.length,
  validate: issues.map((i) => `${i.code}: ${i.msg}`),
  turns: result.num_turns ?? null,
  minutes: result.duration_ms ? +(result.duration_ms / 60000).toFixed(1) : null,
  costUsd: result.total_cost_usd != null ? +result.total_cost_usd.toFixed(2) : null,
  toolCalls: Object.values(calls).reduce((a, b) => a + b, 0),
  calls,
  errors,
  captionStyle: p.captionStyle,
  graphics: (p.graphics ?? []).map((g) => `${g.template}${g.behind ? ' (behind)' : ''}`),
};
if (flag === '--json') console.log(JSON.stringify(out, null, 2));
else {
  const row = (k, v) => console.log(`${k.padEnd(20)} ${v}`);
  for (const k of ['durationSec', 'clips', 'offMicWordsKept', 'cutsBySeconds', 'cutWords', 'schemaRejections', 'toolErrors', 'validateWarnings', 'turns', 'minutes', 'costUsd', 'toolCalls', 'captionStyle']) row(k, out[k]);
  row('graphics', out.graphics.join(', '));
  for (const v of out.validate) row('  validate', v);
  for (const e of out.errors) row('  error', e);
}
