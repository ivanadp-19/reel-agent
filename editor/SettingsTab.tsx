import React, {useState} from 'react';
import {useEditor} from './store';
import {CLEAN, dbToGain, fmtDb, gainToDb, musicOf} from '../src/audio';
import {spansWithoutMatte} from '../src/graphicTemplates';
import {DELIVERABLES, deliverableName, eachTarget, identityOf, identityTaken, projectTargets, validateIdentity, type Issue} from '../src/validate';
import type {Matte} from '../src/Person';
import {runJob, readPublic} from './jobs';
import {Btn, Label, Row, Section, Select, TextInput, Toggle} from './ui';

type MusicRow = {id: string; title: string; creator: string; license: string; durationSec: number; url: string; page?: string; source?: string};

// Settings tab: music (set_music: level in dB, fades, duck), audio options (set_audio) and the music on
// the whole family (set_music targets), the agent's plan
// (set_plan), the identity (set_identity), the pre-render checks (validate, prepare_mattes) and project info.

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
