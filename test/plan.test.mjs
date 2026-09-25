import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {pendingChanges, planGate, planMode, planStatus, planWords, reviewPlan, setPlanMode, withPlan} from '../src/plan.ts';

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
  assert.match(planStatus(p, 'review'), /^NOT APPROVED \(plan mode review\).*changes asked: "sin música" \(drop the music\)/);
  const yes = reviewPlan(p, {decision: 'approved', said: 'ok, dale'}, 't2');
  assert.equal(yes.planApproved, true);
  assert.equal(yes.planReviews.length, 2);
  assert.deepEqual(pendingChanges({plan: PLAN, ...yes}), []); // answered by the approval
  assert.equal(planStatus({plan: PLAN, ...yes}, 'review'), 'APPROVED by the user — "ok, dale" (plan mode review)');
  assert.match(planStatus(p), /^plan mode auto — shown in the chat, the edit goes on.*changes asked: "sin música"/);
  let q = {plan: PLAN};
  for (let i = 0; i < 20; i++) q = {...q, ...reviewPlan(q, {decision: 'changes', said: `c${i}`})};
  assert.equal(q.planReviews.length, 12); // the last rounds only
});

test('plan mode: auto unless the project was switched to review', () => {
  assert.equal(planMode({}), 'auto');
  assert.equal(planMode({planMode: null}), 'auto');
  assert.equal(planMode({planMode: 'nonsense'}), 'auto');
  assert.equal(planMode({planMode: 'auto'}), 'auto');
  assert.equal(planMode({planMode: 'review'}), 'review');
});

test('switching the plan mode keeps who asked for it, quoted', () => {
  const r = setPlanMode({}, 'review', '  muéstrame el plan antes  ', 't1');
  assert.deepEqual(r, {planMode: 'review', planModeLog: [{mode: 'review', said: 'muéstrame el plan antes', at: 't1'}]});
  const back = setPlanMode({planMode: 'review', planModeLog: r.planModeLog}, 'auto', 'ya no esperes mi ok', 't2');
  assert.deepEqual(back.planModeLog.map((x) => [x.mode, x.said]), [['review', 'muéstrame el plan antes'], ['auto', 'ya no esperes mi ok']]);
  assert.match(setPlanMode({}, 'review', ' ').error, /user_said/);
  assert.match(setPlanMode({}, 'nope', 'x').error, /auto or review/);
});

test('the gate: only in review mode, with an unapproved plan; it names the action and the asked changes', () => {
  const pending = {plan: PLAN, planApproved: false, planReviews: [{decision: 'changes', said: 'otra alberca', at: 't'}]};
  assert.equal(planGate(pending, 'cut_words'), null); // auto (default): the plan is shown, the edit goes on
  assert.equal(planGate({...pending, planMode: 'auto'}, 'cut_words', 'auto'), null);
  assert.equal(planGate({plan: ''}, 'cut_words'), null); // auto, no plan: nothing to wait for
  assert.match(planGate({plan: ''}, 'cut_words', 'review'), /^cut_words waits for the plan \(plan mode review\): write it with set_plan/); // review: no plan blocks too
  assert.equal(planGate({plan: PLAN, planApproved: true}, 'cut_words', 'review'), null);
  const why = planGate(pending, 'cut_words', 'review');
  assert.match(why, /^cut_words waits for the user to approve the plan \(plan mode review\)/);
  assert.match(why, /STOP until they answer/);
  assert.match(why, /Changes asked so far: "otra alberca"/);
  assert.match(why, /draft renders still work/);
  assert.equal(planGate({...pending, planMode: 'review'}, 'cut_words') === null, false); // the project's own mode
});

test('word ids the plan names resolve to words on the timeline; trimmed-away ones are missing', () => {
  const {found, missing} = planWords(PLAN, tr, clips, 30);
  assert.deepEqual(found.map((w) => [w.wid, w.text]), [['a:0', 'Hola'], ['a:12', 'terraza'], ['a:20', 'alberca'], ['a:40', 'gracias']]);
  assert.equal(Math.round(found[1].atMs), 4000); // 5000 − 1000 (in) on the first clip
  assert.deepEqual(missing, ['a:4']);
});

// the MCP server end to end, on a throwaway project file (no backend: tools that
// pass the gate fail on it later, which is fine here)
async function withServer(env, fn) {
  const id = `p-plantest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join('public', 'projects', `${id}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({name: 'plan gate test', clips, captions: [], brolls: [], graphics: []}));
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd(), env: {...process.env, REEL_API: 'http://127.0.0.1:9', REEL_AGENT: 'plan-test', ...env}}));
  const call = async (name, args) => { const r = await client.callTool({name, arguments: {project_id: id, ...args}}); return {err: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n')}; };
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try { await fn(call, saved); } finally {
    await client.close();
    for (const f of [file, file.replace(/\.json$/, '.lock')]) fs.rmSync(f, {force: true});
  }
}
const gated = (r) => /waits for the user to approve the plan/.test(r.text);
const EDITS = [['cut_words', {from_wid: 'a:0'}], ['set_accent_color', {color: '#00FF00'}], ['annotate_captions', {items: [{wid: 'a:12', tier: 2}]}], ['add_graphic', {template: 'big-word', props: {text: 'TERRAZA'}}], ['delete_clips', {clip_ids: ['c1']}], ['run_ai_step', {step: 'autocut'}], ['render', {draft: false}]];

test('MCP, plan mode auto (the default): the plan is shown and the edit goes on without approval', async () => {
  await withServer({}, async (call, saved) => {
    const r = await call('set_plan', {plan: PLAN});
    assert.match(r.text, /Plan mode auto: show the whole plan to the user in your message now.*go on with the edit without waiting/s);
    assert.doesNotMatch(r.text, /STOP/);
    assert.equal(saved().plan, PLAN);
    for (const [name, args] of EDITS) assert.equal(gated(await call(name, args)), false, name);
    assert.equal(saved().accentColor, '#00FF00');
    assert.match((await call('get_project', {})).text, /PLAN \(set_plan\) — plan mode auto/);
  });
});

test('MCP, plan mode review: an unapproved plan blocks editing tools and the final render, not reads or drafts', async () => {
  await withServer({}, async (call, saved) => {
    // auto, no plan yet: nothing is gated
    assert.equal(gated(await call('set_accent_color', {color: '#FF0000'})), false);
    assert.match((await call('set_plan_mode', {mode: 'review', user_said: 'muéstrame el plan antes de editar'})).text, /Plan mode review/);
    assert.equal(saved().planMode, 'review');
    assert.deepEqual(saved().planModeLog.map((x) => [x.mode, x.said]), [['review', 'muéstrame el plan antes de editar']]);
    // review, no plan yet: editing waits for the plan too
    const early = await call('set_accent_color', {color: '#123456'});
    assert.ok(early.err && /waits for the plan \(plan mode review\)/.test(early.text), early.text);
    const r = await call('set_plan', {plan: PLAN});
    assert.match(r.text, /Plan mode review — NOT APPROVED yet.*STOP/s);
    assert.equal(saved().planApproved, false);
    for (const [name, args] of EDITS) {
      const e = await call(name, args);
      assert.ok(e.err && gated(e), `${name} should be gated: ${e.text.slice(0, 160)}`);
    }
    assert.match((await call('render', {draft: false})).text, /^The final render waits/);
    for (const [name, args] of [['get_project', {}], ['render', {draft: true}], ['validate', {}]]) assert.equal(gated(await call(name, args)), false, name);
    assert.match((await call('get_project', {})).text, /PLAN \(set_plan\) — NOT APPROVED \(plan mode review\)/);
    await call('request_plan_changes', {user_said: 'sin música', notes: 'drop music'});
    assert.match((await call('cut_words', {from_wid: 'a:0'})).text, /Changes asked so far: "sin música"/);
    assert.match((await call('approve_plan', {user_said: 'ok, dale'})).text, /Plan APPROVED/);
    assert.equal(saved().planApproved, true);
    assert.equal(gated(await call('set_accent_color', {color: '#0000FF'})), false);
    assert.equal(saved().accentColor, '#0000FF');
    await call('set_plan', {plan: PLAN}); // same text: still approved
    assert.equal(saved().planApproved, true);
    await call('set_plan', {plan: PLAN + '\nLENGTH: 20 s'}); // changed: asks again
    assert.equal(saved().planApproved, false);
    assert.ok(gated(await call('set_accent_color', {color: '#FFFFFF'})));
  });
});

test('MCP: back to auto when the user says so, and the gate is gone', async () => {
  await withServer({}, async (call, saved) => {
    await call('set_plan_mode', {mode: 'review', user_said: 'quiero revisar el plan'});
    await call('set_plan', {plan: PLAN});
    assert.ok(gated(await call('cut_words', {from_wid: 'a:0'})));
    await call('set_plan_mode', {mode: 'auto', user_said: 'ya no esperes mi ok'});
    assert.equal(saved().planMode, 'auto');
    assert.deepEqual(saved().planModeLog.map((x) => x.said), ['quiero revisar el plan', 'ya no esperes mi ok']);
    assert.equal(gated(await call('cut_words', {from_wid: 'a:0'})), false);
  });
});
