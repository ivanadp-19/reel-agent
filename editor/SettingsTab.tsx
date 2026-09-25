import React, {useState} from 'react';
import {useEditor} from './store';
import {CLEAN} from '../src/audio';
import {spansWithoutMatte} from '../src/graphicTemplates';
import {validateProject, transcriptIssues, type Issue} from '../src/validate';
import type {TClip} from '../src/cuts';
import type {Matte} from '../src/Person';
import {runJob, readPublic} from './jobs';
import {Btn, Label, Row, Section, Select, Toggle} from './ui';

// Settings tab: music (as before), audio options (set_audio), the agent's plan
// (set_plan), the pre-render checks (validate, prepare_mattes) and project info.

const sourceOf = (src: string) => src.split('/').pop()!.replace(/\.[^.]+$/, '');

export const SettingsTab: React.FC<{notify: (msg: string, kind: 'error' | 'ok') => void}> = ({notify}) => {
  const {meta, clips, music, captions, graphics, mattes, captionStyle, offMic, audio, plan, setMusic, setAudio, setPlan, addMattes} = useEditor();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!meta) return null;
  const needMatte = spansWithoutMatte([...graphics, ...captions], mattes, clips);

  const validate = async () => {
    // face boxes the captions job wrote, per source; the last transcript run for the off-mic / cut-word checks
    const faces = Object.fromEntries(await Promise.all(clips.map(async (c) => [c.src, await fetch(`/clips/faces/${sourceOf(c.src)}.json`).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined)])));
    const tr = await fetch(`/transcript.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : [])).catch(() => []) as TClip[];
    setIssues([...validateProject({clips, captions, graphics, mattes, captionStyle}, meta.fps, faces), ...transcriptIssues({clips, offMic}, Array.isArray(tr) ? tr : [])]);
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
            <Label>Volume: {Math.round(music.volume * 100)}%</Label>
            <input type="range" min={0} max={100} value={Math.round(music.volume * 100)} onChange={(e) => setMusic({...music, volume: Number(e.target.value) / 100})} className="w-full accent-primary" />
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
          <p className="text-body-sm text-on-surface-variant/60">No music. Add a track in the Assets panel.</p>
        )}
      </Section>

      <Section title="Audio" hint="Voice cleanup runs on the final render only (drafts are untouched).">
        <Label>Voice cleanup</Label>
        <Select value={audio?.clean ?? 'off'} onChange={(clean) => setAudio({...(audio ?? {}), clean})} options={Object.entries(CLEAN).map(([k, v]) => ({value: k, label: `${k} — ${v.desc}`, title: v.desc}))} />
        <div className="flex items-center justify-between" title="Synthesized, license-free: a whoosh on whip/zoom/card/split cuts, a pop on stickers and starbursts">
          <Label>Sound effects</Label>
          <Toggle on={!!audio?.sfx} onChange={(sfx) => setAudio({...(audio ?? {}), sfx})} />
        </div>
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

      <div className="pt-4 border-t border-outline-variant/30">
        <Row k="Resolution" v={`${meta.width}×${meta.height}`} />
        <Row k="FPS" v={String(meta.fps)} />
        <Row k="Clips" v={String(clips.length)} />
        <Row k="Duration" v={`${(meta.durationInFrames / meta.fps).toFixed(1)}s`} />
      </div>
    </div>
  );
};
