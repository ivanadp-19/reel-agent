import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {pendingChanges, planGate, planStatus, planWords, reviewPlan, withPlan} from '../src/plan.ts';

const PLAN = `STYLE: none
IDEA: the flat sells itself
HERO: terraza → a:12
BEATS:
  hook (0–3 s): a:0–a:4 → hook-stack
  close: a:40
B-ROLL: a:20 → pool
MUSIC / SFX / TRANSITIONS: no`;
const clips = [{id: 'c0', src: 'clips/a.mp4', inSec: 1, outSec: 11, sourceDurationSec: 30}, {id: 'c1', src: 'clips/a.mp4', inSec: 20, outSec: 25, sourceDurationSec: 30}];
const tr = [
  {clipId: 'c0', source: 'a', words: [{i: 0, word: 'Hola', startMs: 1200, endMs: 1500}, {i: 12, word: 'terraza', startMs: 5000, endMs: 5600}, {i: 20, word: 'alberca', startMs: 8000, endMs: 8600}]},
  {clipId: 'c1', source: 'a', words: [{i: 40, word: 'gracias', startMs: 21000, endMs: 21500}]},
];

test('a new or changed plan needs a new yes; the same text keeps it', () => {
  assert.deepEqual(withPlan({}, `  ${PLAN}\n`), {plan: PLAN, planApproved: false, changed: true});
  const ok = {plan: PLAN, planApproved: true};
  assert.equal(withPlan(ok, PLAN).planApproved, true);
  assert.equal(withPlan(ok, PLAN + '\nLENGTH: 30 s').planApproved, false);
});

test('the user answers in the chat: changes keep it pending, ok approves, the log keeps their words', () => {
  assert.match(reviewPlan({plan: ''}, {decision: 'approved', said: 'ok'}).error, /no plan/);
  assert.match(reviewPlan({plan: PLAN}, {decision: 'approved', said: '  '}).error, /user_said/);
  const asked = reviewPlan({plan: PLAN}, {decision: 'changes', said: 'sin música', notes: 'drop the music'}, 't1');
  assert.equal(asked.planApproved, false);
  assert.deepEqual(asked.planReviews, [{decision: 'changes', said: 'sin música', notes: 'drop the music', at: 't1'}]);
  const p = {plan: PLAN, ...asked};
  assert.deepEqual(pendingChanges(p).map((r) => r.said), ['sin música']);
  assert.match(planStatus(p), /^NOT APPROVED.*changes asked: "sin música" \(drop the music\)/);
  const yes = reviewPlan(p, {decision: 'approved', said: 'ok, dale'}, 't2');
  assert.equal(yes.planApproved, true);
  assert.equal(yes.planReviews.length, 2);
  assert.deepEqual(pendingChanges({plan: PLAN, ...yes}), []); // answered by the approval
  assert.equal(planStatus({plan: PLAN, ...yes}), 'APPROVED by the user — "ok, dale"');
  let q = {plan: PLAN};
  for (let i = 0; i < 20; i++) q = {...q, ...reviewPlan(q, {decision: 'changes', said: `c${i}`})};
  assert.equal(q.planReviews.length, 12); // the last rounds only
});

test('the gate: off without a plan or once approved; otherwise it names the action and the asked changes', () => {
  assert.equal(planGate({plan: ''}, 'cut_words'), null);
  assert.equal(planGate({plan: PLAN, planApproved: true}, 'cut_words'), null);
  const why = planGate({plan: PLAN, planApproved: false, planReviews: [{decision: 'changes', said: 'otra alberca', at: 't'}]}, 'cut_words');
  assert.match(why, /^cut_words waits for the user to approve the plan/);
  assert.match(why, /STOP until they answer/);
  assert.match(why, /Changes asked so far: "otra alberca"/);
  assert.match(why, /draft renders still work/);
});

test('word ids the plan names resolve to words on the timeline; trimmed-away ones are missing', () => {
  const {found, missing} = planWords(PLAN, tr, clips, 30);
  assert.deepEqual(found.map((w) => [w.wid, w.text]), [['a:0', 'Hola'], ['a:12', 'terraza'], ['a:20', 'alberca'], ['a:40', 'gracias']]);
  assert.equal(Math.round(found[1].atMs), 4000); // 5000 − 1000 (in) on the first clip
  assert.deepEqual(missing, ['a:4']);
});

// the MCP server end to end, on a throwaway project file: set_plan → gated edits → approve_plan → open
test('MCP: an unapproved plan blocks editing tools and the final render, not reads or drafts', async () => {
  const id = `p-plantest-${process.pid}`;
  const file = path.join('public', 'projects', `${id}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({name: 'plan gate test', clips, captions: [], brolls: [], graphics: []}));
  const client = new Client({name: 'test', version: '0'});
  // no backend: the tools that pass the gate fail on it later, which is fine here
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: 'http://127.0.0.1:9', REEL_AGENT: 'plan-test'}}));
  const call = async (name, args) => { const r = await client.callTool({name, arguments: {project_id: id, ...args}}); return {err: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n')}; };
  const gated = (r) => /waits for the user to approve the plan/.test(r.text);
  try {
    // no plan yet: nothing is gated
    assert.equal(gated(await call('set_accent_color', {color: '#FF0000'})), false);
    const saved = await call('set_plan', {plan: PLAN});
    assert.match(saved.text, /NOT APPROVED yet.*STOP/s);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).planApproved, false);
    for (const [name, args] of [['cut_words', {from_wid: 'a:0'}], ['set_accent_color', {color: '#00FF00'}], ['annotate_captions', {items: [{wid: 'a:12', tier: 2}]}], ['add_graphic', {template: 'big-word', props: {text: 'TERRAZA'}}], ['delete_clips', {clip_ids: ['c1']}], ['run_ai_step', {step: 'autocut'}], ['render', {draft: false}]]) {
      const r = await call(name, args);
      assert.ok(r.err && gated(r), `${name} should be gated: ${r.text.slice(0, 160)}`);
    }
    assert.match((await call('render', {draft: false})).text, /^The final render waits/);
    for (const [name, args] of [['get_project', {}], ['render', {draft: true}], ['validate', {}]]) assert.equal(gated(await call(name, args)), false, name);
    assert.match((await call('get_project', {})).text, /PLAN \(set_plan\) — NOT APPROVED/);
    await call('request_plan_changes', {user_said: 'sin música', notes: 'drop music'});
    assert.match((await call('cut_words', {from_wid: 'a:0'})).text, /Changes asked so far: "sin música"/);
    const ok = await call('approve_plan', {user_said: 'ok, dale'});
    assert.match(ok.text, /Plan APPROVED/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).planApproved, true);
    assert.equal(gated(await call('set_accent_color', {color: '#0000FF'})), false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accentColor, '#0000FF');
    await call('set_plan', {plan: PLAN}); // same text: still approved
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).planApproved, true);
    await call('set_plan', {plan: PLAN + '\nLENGTH: 20 s'}); // changed: asks again
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).planApproved, false);
    assert.ok(gated(await call('set_accent_color', {color: '#FFFFFF'})));
  } finally {
    await client.close();
    for (const f of [file, file.replace(/\.json$/, '.lock')]) fs.rmSync(f, {force: true});
  }
});
