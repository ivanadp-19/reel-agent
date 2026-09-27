import React, {useState} from 'react';
import {useEditor} from './store';
import {CLEAN, dbToGain, fmtDb, gainToDb, musicOf} from '../src/audio';
import {spansWithoutMatte} from '../src/graphicTemplates';
import {DELIVERABLES, deliverableName, eachTarget, identityOf, identityTaken, projectTargets, validateIdentity, type Issue} from '../src/validate';
import type {Matte} from '../src/Person';
import {SCOPABLE, STAGES, STAGES_MODES, inScope, scopeInput, type Scopable} from '../src/stages';
import {runJob, readPublic} from './jobs';
import {Btn, Label, Row, Section, Select, TextInput, Toggle} from './ui';

type MusicRow = {id: string; title: string; creator: string; license: string; durationSec: number; url: string; page?: string; source?: string};

// Settings tab: music (set_music: level in dB, fades, duck), audio options (set_audio) and the music on
// the whole family (set_music targets), the agent's plan
// (set_plan), the identity (set_identity), the stages (set_scope, check_stage, stage_status), the pre-render
// checks (validate, prepare_mattes) and project info.

// set_identity: client, script and variant — the delivered files are named from it. The same rules as the
// MCP and the backend (src/validate.ts); a repeated one is caught against the project list before saving
// (the backend's 400 on the save covers a race). Keyed by the identity, so a reload from the agent resets it.
const IdentitySection: React.FC<{notify: (msg: string, kind: 'error' | 'ok') => void}> = ({notify}) => {
  const {projectId, identity, setIdentity} = useEditor();
  const va = (identity?.variant ?? {}) as {hook?: number; cta?: number; v?: number};
  const str = (n?: number) => (n == null ? '' : String(n));
  const [f, setF] = useState({client: identity?.client ?? '', script: str(identity?.script), hook: str(va.hook), cta: str(va.cta), v: str(va.v), family: identity && identity.family !== `${identity.client}-G${identity.script}` ? identity.family : '', development: identity?.development ?? ''});
  const field = (k: keyof typeof f) => (x: string) => setF({...f, [k]: x});
  const num = (x: string) => (x.trim() === '' ? undefined : Number(x));
  const save = async () => {
    const r = validateIdentity(identityOf({client: f.client.trim(), script: num(f.script), hook: num(f.hook), cta: num(f.cta), v: num(f.v), family: f.family.trim() || undefined, development: f.development}));
    if (!r.identity) return notify(r.error ?? 'Fill in client and script', 'error');
    try {
      const taken = identityTaken(await fetch('/api/projects').then((x) => x.json()), projectId ?? '', r.identity);
      if (taken) return notify(taken, 'error');
    } catch { /* the backend still refuses a repeated one when the project saves */ }
    setIdentity(r.identity);
    notify('Identity set', 'ok');
  };
  const shown = validateIdentity(identity); // a hand-edited file may hold a bad one: say so, never crash
  return (
    <Section title="Identity" hint="Client, script (G) and variant (hook / CTA, or a plain V) — the delivered files are named from it (set_identity). One project per client, script and variant. Development: whose approved color the judge compares with.">
      <div className="grid grid-cols-3 gap-1">
        <div className="col-span-2"><Label>Client</Label><TextInput value={f.client} onChange={field('client')} placeholder="vibem" maxLength={32} /></div>
        <div><Label>Script G</Label><TextInput type="number" min={1} max={99} value={f.script} onChange={field('script')} placeholder="2" /></div>
        <div><Label>Hook</Label><TextInput type="number" min={1} max={999} value={f.hook} onChange={field('hook')} placeholder="—" /></div>
        <div><Label>CTA</Label><TextInput type="number" min={1} max={999} value={f.cta} onChange={field('cta')} placeholder="—" /></div>
        <div><Label>or V</Label><TextInput type="number" min={1} max={999} value={f.v} onChange={field('v')} placeholder="—" /></div>
      </div>
      <Label>Family</Label>
      <TextInput value={f.family} onChange={field('family')} placeholder={f.client && f.script ? `${f.client.trim()}-G${f.script.trim()}` : '<client>-G<script>'} />
      <Label>Development</Label>
      <TextInput value={f.development} onChange={field('development')} placeholder="Montealbán 326 · Thula · marca" maxLength={60} title="The building or project the reel sells: the render judge compares its color with that development's approved references only" />
      <div className="flex gap-2">
        <Btn onClick={save} disabled={!projectId} className="flex-1">Save identity</Btn>
        <Btn onClick={() => setIdentity(null)} disabled={!identity}>Clear</Btn>
      </div>
      {shown.identity && DELIVERABLES.map(({kind, ext}) => deliverableName({identity: shown.identity, v: 1, kind, ext})).map((n) => <p key={n} className="text-[11px] font-mono text-on-surface-variant truncate" title={n}>{n}</p>)}
      {shown.error && <p className="text-[11px] text-error">{shown.error}</p>}
    </Section>
  );
};

// The stages of the reel (src/stages.ts; the MCP's set_scope, check_stage, stage_status — one backend for both):
// what the job asks for — a stage left out is omitida: its gate does not run and what is found there is advisory —
// and each stage's gate, run on the saved project (autosaved 600 ms after an edit). The editor is never refused (a
// person edits freely; the edits still reopen stages). A finding is waived with a reason (waive_finding: a warning
// by anyone, a blocker by the owner's login only), and the mode (off / advisory / enforce: how the agent's tools are
// held) changes with the owner's login only — the backend answers 403 otherwise, local mode included (E-2).
type StageRow = {stage: string; status: string; findings?: (Issue & {waived?: {reason: string; by: string | null}})[]; waitingOn?: string[]; infra?: boolean};
const StagesSection: React.FC<{notify: (msg: string, kind: 'error' | 'ok') => void}> = ({notify}) => {
  const {projectId, scope, setScope} = useEditor();
  const [rows, setRows] = useState<StageRow[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState('0');
  const [reason, setReason] = useState('');
  const at = `/api/projects/${encodeURIComponent(projectId ?? '')}/stages`;
  const refresh = async () => {
    try { const v = await fetch(at).then((r) => r.json()); if (!Array.isArray(v.stages)) throw new Error(v.error ?? 'no answer'); setRows(v.stages); setMode(v.mode); }
    catch (e) { notify(`Stages: ${(e as Error).message}`, 'error'); }
  };
  const post = async (label: string, route: string, body: object, done: string) => {
    setBusy(label);
    try {
      const r = await fetch(`${at}/${route}`, {method: 'POST', body: JSON.stringify(body)}).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      notify(done, 'ok');
      await refresh();
      return true;
    } catch (e) { notify(`${label}: ${(e as Error).message}`, 'error'); return false; }
    finally { setBusy(null); }
  };
  const open = rows?.flatMap((r) => (r.findings ?? []).filter((f) => !f.waived).map((f) => ({stage: r.stage, f}))) ?? [];
  const chosen = open[+pick] ?? open[0];
  const check = async (stage: string) => {
    setBusy(stage);
    try {
      const r = await fetch(`${at}/${stage}/check`, {method: 'POST'}).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      if (r.discarded) notify(`${stage}: the project changed while it ran — its result was discarded, check again`, 'error');
      else if (r.superseded) notify(`${stage}: a newer check started meanwhile — its result is the one shown`, 'ok');
      await refresh();
    } catch (e) { notify(`Check ${stage}: ${(e as Error).message}`, 'error'); }
    setBusy(null);
  };
  // the captions gate asks for a caption_proof and a motion_proof: a person who watched the captions in the preview
  // (which is the render) records both, of the revision this editor shows (the same route as the MCP's proofs)
  const proofed = async () => {
    setBusy('proof');
    try {
      for (const kind of ['caption_proof', 'motion_proof']) {
        const r = await fetch(`${at}/captions/proof`, {method: 'POST', body: JSON.stringify({kind, rev: useEditor.getState().rev})}).then((x) => x.json());
        if (r.error || !r.recorded) throw new Error(r.error ?? `${r.reason} (wait for the autosave)`);
      }
      notify('captions: proofed in the preview — Check captions now', 'ok');
    } catch (e) { notify(`Proof: ${(e as Error).message}`, 'error'); }
    setBusy(null);
  };
  const asked: Scopable[] = scope ?? [...SCOPABLE];
  const toggle = (s: Scopable) => {
    const r = scopeInput(asked.includes(s) ? asked.filter((x) => x !== s) : [...asked, s]);
    if (r.error) return notify(r.error, 'error');
    setScope(r.scope);
  };
  const on = inScope(scope);
  return (
    <Section title="Stages" hint="What the job asks for (set_scope): a stage left out is omitted — its checks do not run and what is found there is only advisory. Check runs a stage's gate on the saved project (check_stage).">
      {STAGES.map((s) => {
        const row = rows?.find((x) => x.stage === s);
        const status = !on.includes(s) ? 'omitida' : row && row.status !== 'omitida' ? row.status : '—';
        const errs = row?.findings?.filter((i) => i.level === 'error' && !i.waived).length ?? 0;
        return (
          <div key={s} className="flex items-center gap-2 text-[12px]" title={row?.findings?.map((i) => `${i.waived ? 'WAIVED' : i.level === 'error' ? 'ERR' : 'WARN'} ${i.code}: ${i.msg}${i.waived ? ` — ${i.waived.by}: ${i.waived.reason}` : ''}`).join('\n') || undefined}>
            {(SCOPABLE as readonly string[]).includes(s)
              ? <input type="checkbox" checked={asked.includes(s as Scopable)} onChange={() => toggle(s as Scopable)} className="accent-primary" aria-label={`${s} in scope`} />
              : <span className="w-[13px]" title={s === 'guion' ? 'goes with captions' : 'always runs'} />}
            <span className="flex-1 font-mono">{s}</span>
            <span className={status === 'rojo' ? 'text-error' : status === 'verde' ? 'text-[#39d98a]' : 'text-on-surface-variant'}>{status}{row?.infra ? ' (infra)' : ''}{errs ? ` · ${errs} err` : ''}{row?.findings?.some((i) => i.waived) ? ` · ${row.findings.filter((i) => i.waived).length} waived` : ''}{row?.waitingOn?.length ? ` · waits on ${row.waitingOn.join(', ')}` : ''}</span>
            {s === 'captions' && <Btn onClick={proofed} disabled={!projectId || !!busy || !on.includes(s)} title="I watched the captions in the preview, stills and motion: records the caption_proof and motion_proof the captions check asks for">{busy === 'proof' ? '…' : 'Proofed'}</Btn>}
            <Btn onClick={() => check(s)} disabled={!projectId || !!busy || !on.includes(s)}>{busy === s ? '…' : 'Check'}</Btn>
          </div>
        );
      })}
      {chosen && (
        <div className="flex items-center gap-2 text-[12px]">
          <Select value={String(open.indexOf(chosen))} onChange={setPick} title="a finding of the last check: a warning you may waive; a blocker only the owner's login" options={open.map(({stage, f}, i) => ({value: String(i), label: `${stage} · ${f.level === 'error' ? 'ERR' : 'WARN'} ${f.code}${f.ref ? ` (${f.ref})` : ''}`, title: f.msg}))} className="flex-1" />
          <TextInput value={reason} onChange={setReason} placeholder="why it is right as it is" maxLength={500} className="flex-1" />
          <Btn onClick={() => post('Waive', `${chosen.stage}/waive`, {rule: chosen.f.code, ref: chosen.f.ref, reason}, `${chosen.stage} ${chosen.f.code} waived — Check ${chosen.stage} to apply it`).then((ok) => ok && setReason(''))} disabled={!reason.trim() || !!busy}>Waive</Btn>
        </div>
      )}
      <div className="flex items-center gap-2 text-[12px]">
        <Btn onClick={refresh} disabled={!projectId}>Show status</Btn>
        {mode && <span className="flex-1 text-right text-on-surface-variant">Mode</span>}
        {mode && <Select value={mode} onChange={(m) => post('Mode', 'mode', {mode: m}, `Stages mode ${m}`)} title="off: nothing logged nor refused; advisory: the agent's tools on a red or stale stage are logged; enforce: refused. The owner's login only." options={STAGES_MODES.map((m) => ({value: m}))} className="w-auto" />}
      </div>
    </Section>
  );
};

export const SettingsTab: React.FC<{notify: (msg: string, kind: 'error' | 'ok') => void}> = ({notify}) => {
  const {meta, projectId, clips, music, captions, graphics, mattes, audio, plan, identity, setMusic, setAudio, setPlan, addMattes} = useEditor();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mq, setMq] = useState('');
  const [mrows, setMrows] = useState<MusicRow[] | null>(null);
  const [mbusy, setMbusy] = useState<string | null>(null);
  const [timing, setTiming] = useState<string | null>(null);
  const [except, setExcept] = useState('');
  const [fbusy, setFbusy] = useState(false);
  if (!meta) return null;
  const family = validateIdentity(identity).identity?.family;
  // set_music targets {family} minus except: this project's music on its siblings — the same selection rule
  // as the MCP (projectTargets, src/validate.ts: never across clients), each saved by its own CAS route
  // (GET then POST {music, updatedAt}: a sibling changed meanwhile is a 409, reported, never overwritten)
  const musicToFamily = async () => {
    if (!family || !music) return;
    setFbusy(true);
    try {
      const r = projectTargets(await fetch('/api/projects').then((x) => x.json()), {family}, except.split(',').map((x) => x.trim()).filter(Boolean));
      if (r.error) throw new Error(r.error);
      const others = r.ids.filter((id) => id !== projectId); // this project already has it (autosave)
      if (!others.length) throw new Error(`no other project in family ${family}`);
      const {failed, lines} = await eachTarget(others, async (id) => {
        const at = `/api/projects/${encodeURIComponent(id)}`;
        const cur = await fetch(at);
        if (!cur.ok) throw new Error(`could not read it (${cur.status})`);
        const w = await fetch(at, {method: 'POST', body: JSON.stringify({music, updatedAt: (await cur.json()).updatedAt})});
        if (w.status === 409) throw new Error('it changed meanwhile — apply again');
        if (!w.ok) throw new Error((await w.json().catch(() => ({}))).error ?? `save failed (${w.status})`);
      });
      notify(`Music on family ${family}: ${others.length - failed} of ${others.length} set — ${lines.join('; ')}`, failed ? 'error' : 'ok');
    } catch (e) { notify('Apply to family: ' + (e as Error).message, 'error'); }
    setFbusy(false);
  };
  // where this project's time went (scripts/timing.mjs; the MCP's timing_report reads the same log)
  const loadTiming = async () => {
    if (!projectId) return;
    try { setTiming((await fetch(`/api/timing/${encodeURIComponent(projectId)}`).then((r) => r.json())).text); }
    catch { notify('Could not read the timing log', 'error'); }
  };
  // search_music / set_music music_id: clean licenses (Openverse CC0 / CC BY), credit kept with the project
  const searchMusic = async () => {
    if (mq.trim().length < 2) return;
    setMbusy('…');
    try {
      const r = await fetch(`/api/music/search?q=${encodeURIComponent(mq)}&limit=6`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'search failed');
      setMrows(d);
      if (!d.length) notify('No tracks for that — try other mood or genre words', 'ok');
    } catch (e) { notify('Music search: ' + (e as Error).message, 'error'); }
    setMbusy(null);
  };
  const pickMusic = async (row: MusicRow) => {
    setMbusy('Downloading…');
    try {
      const r = await fetch('/api/music/pick', {method: 'POST', body: JSON.stringify({id: row.id})});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'download failed');
      setMusic({src: d.src, ...musicOf({}), credit: d.credit});
      setMrows(null);
      notify('Music set — the credit line is kept with the project', 'ok');
    } catch (e) { notify('Music: ' + (e as Error).message, 'error'); }
    setMbusy(null);
  };
  const needMatte = spansWithoutMatte([...graphics, ...captions], mattes, clips);

  // the MCP's validate on the saved project (autosaved 600 ms after an edit): mcp/checks.mjs projectIssues —
  // faces, font files and this project's own transcripts are read there, from public/
  const validate = async () => {
    if (!projectId) return;
    const r = await fetch(`/api/validate/${encodeURIComponent(projectId)}`).then((x) => x.json()).catch((e) => ({error: String(e)}));
    if (!Array.isArray(r.issues)) return notify(`Validate: ${r.error ?? 'no answer from the backend'}`, 'error');
    setIssues(r.issues);
  };
  const prepareMattes = async () => {
    setBusy('Starting…');
    try {
      await runJob('/api/matte', {spans: needMatte}, (s) => setBusy(`${s.label ?? ''} ${s.progress ?? 0}%`));
      const done = await readPublic<Matte[]>('mattes.json');
      addMattes(Array.isArray(done) ? done : []);
      notify(`Matted ${done.length} span(s)`, 'ok');
    } catch (e) { notify('Mattes failed: ' + (e as Error).message, 'error'); }
    setBusy(null);
  };

  return (
    <div className="space-y-5">
      <Section title="Music">
        {music ? (
          <>
            <p className="text-body-sm text-on-surface truncate">{music.src.split('/').pop()}</p>
            {music.credit && <p className="text-[10px] text-on-surface-variant/70" title="Ship this credit line with the reel">Credit: {music.credit}</p>}
            <Label>Volume: {fmtDb(music.volume)}</Label>
            <input type="range" min={-60} max={0} step={0.5} value={Math.max(-60, gainToDb(music.volume))} onChange={(e) => setMusic({...music, volume: dbToGain(Number(e.target.value))})} className="w-full accent-primary" />
            <Label>Fade-in: {(music.fadeInSec ?? 0).toFixed(1)}s</Label>
            <input type="range" min={0} max={100} value={Math.round((music.fadeInSec ?? 0) * 10)} onChange={(e) => setMusic({...music, fadeInSec: Number(e.target.value) / 10})} className="w-full accent-primary" />
            <Label>Fade-out: {music.fadeOutSec.toFixed(1)}s</Label>
            <input type="range" min={0} max={50} value={Math.round(music.fadeOutSec * 10)} onChange={(e) => setMusic({...music, fadeOutSec: Number(e.target.value) / 10})} className="w-full accent-primary" />
            <div className="flex items-center justify-between">
              <Label>Duck under voice</Label>
              <Toggle on={!!music.duck} onChange={(duck) => setMusic({...music, duck})} title="Automatically lower the music while someone is speaking" />
            </div>
            {music.duck && (
              <>
                <Label>Ducked level: {Math.round((music.duckLevel ?? 0.25) * 100)}%</Label>
                <input type="range" min={5} max={80} value={Math.round((music.duckLevel ?? 0.25) * 100)} onChange={(e) => setMusic({...music, duckLevel: Number(e.target.value) / 100})} className="w-full accent-primary" />
                <p className="text-[10px] text-on-surface-variant/50">Speech is detected from your captions — generate captions first.</p>
              </>
            )}
          </>
        ) : (
          <p className="text-body-sm text-on-surface-variant/60">No music. Upload a track in the Assets panel, or search one below.</p>
        )}
        <div className="flex gap-1 pt-1">
          <TextInput value={mq} onChange={setMq} placeholder="mood or genre: upbeat corporate, lo-fi…" />
          <Btn onClick={searchMusic} disabled={!!mbusy || mq.trim().length < 2}>{mbusy ?? 'Search'}</Btn>
        </div>
        {mrows && mrows.length > 0 && (
          <div className="space-y-1">
            {mrows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 p-1.5 rounded border border-outline-variant/30 bg-surface-variant/20 text-[11px]">
                <div className="flex-1 min-w-0">
                  <p className="text-on-surface truncate" title={r.title}>{r.title}</p>
                  <p className="text-on-surface-variant/70 truncate">{r.creator} · {r.durationSec}s · {r.license}</p>
                </div>
                <Btn onClick={() => pickMusic(r)} disabled={!!mbusy}>Use</Btn>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Audio" hint="Voice cleanup runs on the final render only (drafts are untouched).">
        <Label>Voice cleanup</Label>
        <Select value={audio?.clean ?? 'off'} onChange={(clean) => setAudio({...(audio ?? {}), clean})} options={Object.entries(CLEAN).map(([k, v]) => ({value: k, label: `${k} — ${v.desc}`, title: v.desc}))} />
        <div className="flex items-center justify-between" title="Synthesized, license-free: a whoosh on whip/zoom/card/split cuts, a pop on stickers and starbursts">
          <Label>Sound effects</Label>
          <Toggle on={!!audio?.sfx} onChange={(sfx) => setAudio({...(audio ?? {}), sfx})} />
        </div>
        {family && music && (
          <>
            <Label>Music on the family {family}</Label>
            <p className="text-[10px] text-on-surface-variant/60">This project's track, level and fades on every project of the family (never another client's).</p>
            <div className="flex gap-1">
              <TextInput value={except} onChange={setExcept} placeholder="except: project ids, comma-separated" />
              <Btn onClick={musicToFamily} disabled={fbusy}>{fbusy ? '…' : 'Apply to family'}</Btn>
            </div>
          </>
        )}
      </Section>

      <Section title="Plan" hint="What the agent intends (set_plan): idea, hero word, beats, cuts, pack, key words, B-roll. Editable.">
        <textarea
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          rows={plan ? Math.min(14, plan.split('\n').length + 1) : 3}
          placeholder="No plan yet. The reel-plan skill writes one before editing."
          className="w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded p-2 text-[12px] font-mono resize-y"
        />
      </Section>

      <IdentitySection key={JSON.stringify(identity ?? null)} notify={notify} />

      <StagesSection notify={notify} />

      <Section title="Checks" hint="Safe zones, glue words, timing, emphasis density, overlaps, missing mattes and hook — estimated geometry; the preview is the truth.">
        <div className="flex gap-2">
          <Btn onClick={validate} disabled={!clips.length} className="flex-1"><span className="material-symbols-outlined text-[16px]">fact_check</span>Validate</Btn>
          <Btn onClick={prepareMattes} disabled={!!busy || !needMatte.length} title={needMatte.length ? 'Cut the presenter out for every behind-span (MediaPipe, local)' : 'Every behind-span has its matte'} className="flex-1">
            <span className={`material-symbols-outlined text-[16px] ${busy ? 'animate-spin' : ''}`}>{busy ? 'progress_activity' : 'person_remove'}</span>
            {busy ?? `Prepare mattes${needMatte.length ? ` (${needMatte.length})` : ''}`}
          </Btn>
        </div>
        {issues && (
          <div className="space-y-1">
            {!issues.length && <p className="text-body-sm text-[#39d98a]">OK — no issues</p>}
            {issues.map((i, k) => (
              <p key={k} className={`text-[11px] leading-snug ${i.level === 'error' ? 'text-error' : 'text-on-surface-variant'}`}>
                <span className="font-mono uppercase mr-1">{i.level === 'error' ? 'ERR' : 'WARN'}</span>
                <span className="font-mono text-on-surface/80 mr-1">{i.code}:</span>
                {i.msg}
              </p>
            ))}
          </div>
        )}
      </Section>

      <Section title="Timing" hint="Where this project's time went: the agent's decisions (gaps between its tool calls), inspection, transcription, render by stage, loudness + QC. Every tool call and backend job is logged.">
        <Btn onClick={loadTiming} disabled={!projectId}>Show timing</Btn>
        {timing && <pre className="text-[11px] leading-snug text-on-surface-variant whitespace-pre-wrap">{timing}</pre>}
      </Section>

      <div className="pt-4 border-t border-outline-variant/30">
        <Row k="Resolution" v={`${meta.width}×${meta.height}`} />
        <Row k="FPS" v={String(+meta.fps.toFixed(3))} />
        <Row k="Clips" v={String(clips.length)} />
        <Row k="Duration" v={`${(meta.durationInFrames / meta.fps).toFixed(1)}s`} />
      </div>
    </div>
  );
};
