import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {MultiClipVideo} from '../src/MultiClipVideo';
import {placeClips, sampleTransform} from '../src/timeline';
import {projectCaptions, mergeCaptions, normalizeCaption} from '../src/captions';
import {reapplyTiers} from '../src/paging';
import type {PresetId} from '../src/captionPresets';
import {useEditor} from './store';
import {Timeline} from './Timeline';
import {AssetsSidebar} from './AssetsSidebar';
import {TranscriptPanel} from './TranscriptPanel';
import {Inspector} from './Inspector';
import {pollJob} from './jobs';
import {SharePanel} from './SharePanel';

const fmt = (sec: number) => {
  const s = Math.max(0, sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

// Premounted (upcoming) clips are in the DOM but invisible — they must not win
// hit-tests or selection-box measurement.
const isVisibleNode = (el: HTMLElement | null): boolean => {
  let n = el;
  while (n) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    n = n.parentElement;
  }
  return true;
};

const META_RELOAD = {durationInFrames: 1, fps: 30, width: 1080, height: 1920};

export const Editor: React.FC<{onBackToStart: () => void}> = ({onBackToStart}) => {
  const {
    meta, projectId, projectName, clips, music, captions, brolls, graphics, mattes, accentColor, selectedId, currentFrame, past, future,
    brollAssets, lang, offMic, setOffMic, hiddenWids, brand, grade, audio, plan, captionsOff, captionStyle, setCaptionStyle, selectedClipId, select, selectClip, setCurrentFrame, setTopPct, setCaptionScale, setBrollScale, setKeyframe, removeKeyframe, setCaptions, setClipOrder, applyAutocut, setLang, setProjectName, pushHistory, undo, redo,
  } = useEditor();
  const playerRef = useRef<PlayerRef>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [exp, setExp] = useState<{status: string; progress?: number; file?: string; qc?: string; label?: string; version?: number; versionError?: string} | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genLabel, setGenLabel] = useState('');
  const [trimming, setTrimming] = useState(false);
  const [trimLabel, setTrimLabel] = useState('');
  const [playing, setPlaying] = useState(false);
  const [boxRect, setBoxRect] = useState<{left: number; top: number; w: number; h: number} | null>(null);
  const [notice, setNotice] = useState<{msg: string; kind: 'error' | 'ok'} | null>(null);
  const [left, setLeft] = useState<'assets' | 'transcript'>('assets'); // left column: media, or the words (get_transcript / cut_words)
  const notify = (msg: string, kind: 'error' | 'ok') => {
    setNotice({msg, kind});
    window.setTimeout(() => setNotice(null), kind === 'error' ? 6000 : 3000);
  };

  // Stable Player props: rebuild ONLY when the data changes, never on the
  // per-frame currentFrame updates — otherwise the Player re-syncs the video
  // every frame and stutters/repeats a fraction of a second.
  const inputProps = useMemo(
    () => ({clips, music, captions, brolls, graphics, mattes, accentColor, captionStyle, brand, grade, audio, captionsOff}),
    [clips, music, captions, brolls, graphics, mattes, accentColor, captionStyle, brand, grade, audio, captionsOff],
  );

  // (project load + Start/Editor routing live in App.tsx)

  // autosave the whole project to its own file (debounced). Note: no clips.length
  // guard — deleting the last clip must persist too (init() nulls projectId, so a
  // freshly cleared state never overwrites another project).
  const lastSeenUpdate = useRef<string | null>(null); // updatedAt we wrote or loaded — anything newer came from outside
  useEffect(() => {
    if (!meta || !projectId) return;
    const t = setTimeout(() => {
      fetch('/api/projects/' + projectId, {
        method: 'POST',
        body: JSON.stringify({name: projectName, clips, music, captions, brolls, graphics, mattes, brollAssets, accentColor, lang, captionStyle, offMic, hiddenWids, brand, grade, audio, plan, captionsOff, updatedAt: lastSeenUpdate.current ?? undefined}),
      })
        .then(async (r) => {
          if (r.status === 409) { notify('Project was changed outside the editor — reloading, your last edit was dropped', 'error'); return; }
          const x = await r.json();
          if (x?.updatedAt) lastSeenUpdate.current = x.updatedAt;
        })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [meta, projectId, projectName, clips, music, captions, brolls, graphics, mattes, brollAssets, accentColor, lang, captionStyle, offMic, hiddenWids, brand, grade, audio, plan, captionsOff]);

  // Live reload: the MCP server (Claude) writes the same project file. Poll its
  // updatedAt and pull the new state in when someone else saved it.
  useEffect(() => {
    if (!projectId) return;
    lastSeenUpdate.current = null;
    const iv = setInterval(async () => {
      try {
        const p = await fetch('/api/projects/' + projectId).then((r) => (r.ok ? r.json() : null));
        if (!p?.updatedAt) return;
        if (lastSeenUpdate.current === null) { lastSeenUpdate.current = p.updatedAt; return; } // first tick = baseline
        if (p.updatedAt <= lastSeenUpdate.current) return;
        lastSeenUpdate.current = p.updatedAt;
        const st = useEditor.getState();
        st.init(META_RELOAD, {...p, captions: (p.captions ?? []).map(normalizeCaption)});
        st.setProjectInfo(projectId, p.name || 'Untitled project');
        notify('Project updated from outside (agent)', 'ok');
      } catch { /* backend hiccup — try again next tick */ }
    }, 2000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // undo/redo keyboard (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault(); // play/pause, not page scroll
        playerRef.current?.toggle();
        return;
      }
      if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); // split clip at playhead (read fresh frame from store)
        const st = useEditor.getState();
        st.splitClipAtFrame(st.currentFrame);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // sync playhead + play state from the player
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: {detail: {frame: number}}) => setCurrentFrame(e.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [meta, setCurrentFrame]);

  // Measure the selected caption/b-roll element in the preview DOM and draw a
  // selection box over it. Runs every render (guarded) so the box tracks the
  // element as it moves/scales. Remotion Player renders real DOM → queryable.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) { if (boxRect) setBoxRect(null); return; }
    // a selected clip wins; otherwise a selected caption/b-roll
    let sel: {kind: string; id: string} | null = null;
    if (selectedClipId) sel = {kind: 'clip', id: selectedClipId};
    else if (selectedId && captions.some((c) => c.id === selectedId)) sel = {kind: 'cap', id: selectedId};
    else if (selectedId && brolls.some((b) => b.id === selectedId)) sel = {kind: 'broll', id: selectedId};
    if (!sel) { if (boxRect) setBoxRect(null); return; }
    const node = document.querySelector(`[data-ab="${sel.kind}:${sel.id}"]`) as HTMLElement | null;
    // hide the box when the element isn't actually on screen (premounted/out of playhead)
    if (!node || !isVisibleNode(node)) { if (boxRect) setBoxRect(null); return; }
    const r = node.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const nb = {left: r.left - s.left, top: r.top - s.top, w: r.width, h: r.height};
    setBoxRect((prev) =>
      prev && Math.abs(prev.left - nb.left) < 0.5 && Math.abs(prev.top - nb.top) < 0.5 && Math.abs(prev.w - nb.w) < 0.5 && Math.abs(prev.h - nb.h) < 0.5 ? prev : nb,
    );
  });

  const exportVideo = async (draft = false) => {
    setExp({status: 'running', progress: 0});
    try {
      const r = await fetch('/api/render', {method: 'POST', body: JSON.stringify({clips, music, captions, brolls, graphics, mattes, accentColor, captionStyle, brand, grade, audio, captionsOff, draft, project_id: projectId})}).then((x) => x.json());
      pollJob(
        '/api/render', r.jobId,
        (s) => setExp({status: 'running', progress: s.progress ?? 0, label: s.label}), // "Queued — n renders ahead" while it waits its turn
        async () => {
          const s = await fetch('/api/render/' + r.jobId).then((x) => x.json());
          setExp(s);
          notify(s.versionError ? `Export ready — review version not recorded: ${s.versionError}` : s.version ? `Export ready — review version v${s.version}` : 'Export ready', s.versionError ? 'error' : 'ok');
        },
        (msg) => { setExp({status: 'error'}); notify('Export failed: ' + msg, 'error'); },
        2400, // renders can take a while — allow up to ~1h
      );
    } catch {
      setExp({status: 'error'});
      notify('Could not start export', 'error');
    }
  };

  // replace = re-page everything for a new style (word tiers carried over by word id)
  const generateCaptions = async (replace = false, style: PresetId = captionStyle) => {
    setGenerating(true);
    setGenLabel('Starting…');
    try {
      const {jobId} = await fetch('/api/captions', {method: 'POST', body: JSON.stringify({clips, lang, style, offMic})}).then((x) => x.json());
      pollJob(
        '/api/captions', jobId,
        (s) => setGenLabel(`${s.label ?? ''} ${s.progress ?? 0}%`),
        async () => {
          const fresh = await fetch(`/captions.multi.json?_=${Date.now()}`).then((x) => x.json()).catch(() => []);
          const freshPages = Array.isArray(fresh) ? fresh : [];
          const {captions: merged, added} = replace
            ? {captions: [...captions.filter((c) => !c.words.some((w) => w.wid)), ...reapplyTiers(captions, freshPages)], added: freshPages.length}
            : mergeCaptions(captions, freshPages, clips);
          pushHistory();
          setCaptions(merged);
          setGenerating(false);
          notify(added ? `Captions ready (+${added})` : 'Captions up to date', 'ok');
        },
        (msg) => { setGenerating(false); notify('Captions failed: ' + msg, 'error'); },
      );
    } catch {
      setGenerating(false);
      notify('Could not start caption generation', 'error');
    }
  };

  // Auto-trim leading/trailing silence on every clip (uses cached transcripts).
  const trimSilence = async () => {
    setTrimming(true);
    setTrimLabel('Starting…');
    try {
      const {jobId} = await fetch('/api/trim-silence', {method: 'POST', body: JSON.stringify({clips, lang, offMic})}).then((x) => x.json());
      pollJob(
        '/api/trim-silence', jobId,
        (s) => setTrimLabel(`${s.label ?? ''} ${s.progress ?? 0}%`),
        async () => {
          const {plan} = await fetch(`/trim-silence.json?_=${Date.now()}`).then((x) => x.json()).catch(() => ({plan: null}));
          if (Array.isArray(plan) && plan.length) applyAutocut(plan);
          setTrimming(false);
          const cuts = Array.isArray(plan) ? plan.reduce((n, p) => n + (p.segments?.length ?? 0), 0) : 0;
          notify(Array.isArray(plan) && plan.length ? `Autocut — ${plan.length} clip(s) → ${cuts} segment(s)` : 'Nothing to cut', 'ok');
        },
        (msg) => { setTrimming(false); notify('Autocut failed: ' + msg, 'error'); },
      );
    } catch {
      setTrimming(false);
      notify('Could not start silence trim', 'error');
    }
  };

  if (!meta) return <Center>Loading…</Center>;

  const totalSec = meta.durationInFrames / meta.fps;
  const nowMs = (currentFrame / meta.fps) * 1000;
  // captions are clip-anchored → project to absolute for hit-testing the preview
  const projCaps = projectCaptions(captions, clips, meta.fps);
  const visibleCaption = projCaps.find((c, i) => {
    const nextStart = projCaps[i + 1]?.startMs ?? Infinity;
    const visEnd = Math.min(nextStart, c.endMs + 700, c.holdMaxMs ?? Infinity);
    return nowMs >= c.startMs && nowMs < visEnd;
  });

  // keyframe context for the selected clip at the current playhead
  const clipKfCtx = (clipId: string) => {
    const clip = clips.find((c) => c.id === clipId);
    const pc = placeClips(clips, meta.fps).find((p) => p.clip.id === clipId);
    if (!clip || !pc) return null;
    const sourceSec = Math.min(clip.outSec, Math.max(clip.inSec, clip.inSec + ((currentFrame - pc.fromFrame) / meta.fps) * (clip.speed ?? 1)));
    return {clip, sourceSec, cur: sampleTransform(clip.transform, sourceSec)};
  };

  // drag the selection box corner to scale: clip → zoom keyframe; caption/b-roll → static scale
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const isClip = !!selectedClipId;
    const id = (selectedClipId || selectedId)!;
    if (!id) return;
    const kind = isClip ? 'clip' : captions.some((c) => c.id === id) ? 'cap' : 'broll';
    const node = document.querySelector(`[data-ab="${kind}:${id}"]`);
    if (!node) return;
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const startDist = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const ctx = isClip ? clipKfCtx(id) : null;
    const startScale = isClip ? ctx?.cur.scale ?? 1 : (kind === 'cap' ? captions.find((c) => c.id === id) : brolls.find((b) => b.id === id))?.scale ?? 1;
    let snapped = false; // push history once, only when the drag actually moves
    const move = (ev: PointerEvent) => {
      if (!snapped && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 2) { pushHistory(); snapped = true; }
      if (!snapped) return;
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const ns = Math.min(4, Math.max(0.3, (startScale * dist) / startDist));
      if (isClip && ctx) setKeyframe(id, ctx.sourceSec, {scale: ns, x: ctx.cur.x, y: ctx.cur.y});
      else if (kind === 'cap') setCaptionScale(id, ns);
      else setBrollScale(id, ns);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // add (or toggle off) a keyframe at the playhead, pinning the clip's current transform
  const toggleKeyframe = () => {
    if (!selectedClipId) return;
    const ctx = clipKfCtx(selectedClipId);
    if (!ctx) return;
    const existing = (ctx.clip.transform ?? []).find((k) => Math.abs(k.t - ctx.sourceSec) < 0.06);
    if (existing) {
      removeKeyframe(selectedClipId, ctx.sourceSec); // pushes its own history step
    } else {
      pushHistory();
      setKeyframe(selectedClipId, ctx.sourceSec, ctx.cur);
    }
  };

  // clip boundaries for skip prev/next
  const bounds = placeClips(clips, meta.fps).map((p) => p.fromFrame);
  const skip = (dir: -1 | 1) => {
    const sorted = [...bounds, meta.durationInFrames].sort((a, b) => a - b);
    const target = dir < 0
      ? [...sorted].reverse().find((f) => f < currentFrame - 2) ?? 0
      : sorted.find((f) => f > currentFrame + 2) ?? meta.durationInFrames;
    playerRef.current?.seekTo(target);
  };

  // topmost VISIBLE composition element (clip/b-roll/caption) under a screen point
  const elementAt = (x: number, y: number): {kind: string; id: string} | null => {
    let found: {kind: string; id: string} | null = null;
    document.querySelectorAll('[data-ab]').forEach((n) => {
      const el = n as HTMLElement;
      if (!isVisibleNode(el)) return; // skip premounted/hidden sequences
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const [kind, id] = (el.dataset.ab || '').split(':');
        if (id) found = {kind, id}; // last match wins ≈ topmost (captions render above b-roll)
      }
    });
    return found;
  };

  // click the preview to select what's under the cursor.
  //   caption → vertical drag to reposition · b-roll → select · clip → select + pan (x/y keyframe)
  const onStagePointerDown = (e: React.PointerEvent) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const hit = elementAt(e.clientX, e.clientY);
    if (!hit || !rect) { playerRef.current?.toggle(); return; }

    if (hit.kind === 'cap') {
      select(hit.id);
      const cap = captions.find((c) => c.id === hit.id);
      if (!cap) return;
      const startY = e.clientY;
      const startTop = cap.topPct;
      let snapped = false;
      const move = (ev: PointerEvent) => {
        const dPct = ((ev.clientY - startY) / rect.height) * 100;
        if (Math.abs(ev.clientY - startY) > 3 && !snapped) { pushHistory(); snapped = true; }
        setTopPct(hit.id, Math.min(88, Math.max(5, startTop + dPct)));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    if (hit.kind === 'broll') { select(hit.id); return; }

    // clip: select + drag to pan (writes an x/y keyframe at the playhead)
    selectClip(hit.id);
    const ctx = clipKfCtx(hit.id);
    if (!ctx) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const cur = ctx.cur;
    let snapped = false;
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - startX) / rect.width) * 100;
      const dy = ((ev.clientY - startY) / rect.height) * 100;
      if ((Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) && !snapped) { pushHistory(); snapped = true; }
      if (snapped) setKeyframe(hit.id, ctx.sourceSec, {scale: cur.scale, x: cur.x + dx, y: cur.y + dy});
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-on-surface">
      {/* toast */}
      {notice && (
        <div
          className={`fixed top-3 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-lg text-body-md font-medium shadow-lg border ${
            notice.kind === 'error' ? 'bg-error-container text-on-error-container border-error/40' : 'bg-surface-container-high text-on-surface border-outline-variant'
          }`}
        >
          {notice.msg}
        </div>
      )}
      {/* Top bar */}
      <header className="bg-surface-container border-b border-outline-variant flex justify-between items-center h-12 px-4 z-50 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBackToStart} title="Back to projects" className="flex items-center gap-1 text-on-surface-variant hover:text-on-surface transition-colors">
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            <span className="text-headline-md font-headline-md font-bold">reel-agent</span>
          </button>
          <div className="h-4 w-px bg-outline-variant" />
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="bg-transparent text-primary font-bold text-body-md border-b border-transparent focus:border-primary focus:outline-none px-1 max-w-[220px]"
            placeholder="Untitled project"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 mr-2">
            <HdrIcon icon="undo" title="Undo (⌘Z)" onClick={undo} disabled={!past.length} />
            <HdrIcon icon="redo" title="Redo (⇧⌘Z)" onClick={redo} disabled={!future.length} />
          </div>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as typeof lang)}
            title="Transcription language"
            className="bg-transparent px-2 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant text-body-md font-bold"
          >
            <option value="auto">Auto</option>
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
          <select
            value={offMic}
            onChange={(e) => setOffMic(e.target.value as typeof offMic)}
            title="Off-mic voice (someone behind the camera feeding lines, quieter than the presenter): mark it in the transcript, cut it with Autocut, or ignore it"
            className="bg-transparent px-2 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant text-body-md font-bold"
          >
            <option value="mark">Off-mic: mark</option>
            <option value="cut">Off-mic: cut</option>
            <option value="off">Off-mic: off</option>
          </select>
          <button
            onClick={trimSilence}
            disabled={trimming || !clips.length}
            title="Cut silence at the ends AND long pauses inside every clip"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-variant disabled:opacity-40 transition-colors text-body-md font-bold"
          >
            <span className={`material-symbols-outlined text-[18px] ${trimming ? 'animate-spin' : ''}`}>{trimming ? 'progress_activity' : 'cut'}</span>
            {trimming ? (trimLabel || 'Cutting…') : 'Autocut'}
          </button>
          {exp?.status === 'running' && <span className="text-body-sm text-on-surface-variant">{exp.label?.startsWith('Queued') ? exp.label : `Rendering… ${exp.progress ?? 0}%`}</span>}
          {exp?.status === 'done' && exp.file && <a href={exp.file} download className="text-body-sm text-[#39d98a]">↓ Download mp4</a>}
          {exp?.status === 'done' && exp.qc && <span title={exp.qc} className="text-body-sm text-on-surface-variant cursor-help">QC ✓</span>}
          <SharePanel projectId={projectId} refreshKey={exp?.version} notify={notify} />
          {exp?.status === 'error' && <span className="text-body-sm text-error">Render error</span>}
          <button
            onClick={() => exportVideo(true)}
            disabled={exp?.status === 'running'}
            title="Half resolution, fastest encode — for a quick check (~40% faster)"
            className="px-3 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-variant disabled:opacity-40 transition-colors text-body-md font-bold"
          >
            Draft
          </button>
          <button onClick={() => exportVideo(false)} disabled={exp?.status === 'running'} className="bg-primary-container text-on-primary-container px-4 py-1.5 rounded-lg font-bold text-body-md hover:brightness-110 active:scale-95 disabled:opacity-40 transition-all">
            Export mp4
          </button>
        </div>
      </header>


      <main className="flex-1 flex overflow-hidden">
        <div className={`${left === 'assets' ? 'w-64' : 'w-96'} shrink-0 flex flex-col h-full border-r border-outline-variant bg-surface-container-low`}>
          <div className="flex border-b border-outline-variant shrink-0">
            {(['assets', 'transcript'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setLeft(t)}
                className={`flex-1 py-2 text-[10px] font-label-bold uppercase tracking-wider border-b-2 transition-colors ${left === t ? 'border-primary text-on-primary-container' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {left === 'assets' ? <AssetsSidebar playerRef={playerRef} /> : <TranscriptPanel playerRef={playerRef} notify={notify} />}
        </div>

        {/* Preview + transport */}
        <section className="flex-1 bg-surface-dim flex flex-col min-w-0">
          <div className="flex-1 flex items-center justify-center p-6 min-h-0">
            <div className="relative h-full" style={{aspectRatio: `${meta.width} / ${meta.height}`}}>
              <Player
                ref={playerRef}
                component={MultiClipVideo}
                inputProps={inputProps}
                durationInFrames={meta.durationInFrames}
                fps={meta.fps}
                compositionWidth={meta.width}
                compositionHeight={meta.height}
                style={{width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(70,69,84,0.3)'}}
              />
              <div ref={stageRef} onPointerDown={onStagePointerDown} className="absolute inset-0" style={{cursor: selectedClipId ? 'move' : visibleCaption ? 'grab' : 'default'}} />

              {/* selection box + corner resize handle (caption / b-roll / clip) */}
              {boxRect && (
                <>
                  <div
                    className="absolute border-2 border-primary rounded-sm pointer-events-none z-20"
                    style={{left: boxRect.left, top: boxRect.top, width: boxRect.w, height: boxRect.h}}
                  />
                  <div
                    onPointerDown={startResize}
                    title="Drag to resize"
                    className="absolute z-30 w-4 h-4 -ml-2 -mt-2 bg-primary border-2 border-white rounded-sm cursor-nwse-resize hover:scale-110 transition-transform"
                    style={{left: boxRect.left + boxRect.w, top: boxRect.top + boxRect.h}}
                  />
                </>
              )}

              {/* clip keyframe (flag) control — appears when a clip is selected */}
              {selectedClipId && (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={toggleKeyframe}
                  title="Add/remove a keyframe at the playhead (then move + resize to animate)"
                  className="absolute z-30 top-2 left-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-container-high/95 border border-outline-variant text-on-surface text-body-sm font-bold hover:bg-surface-variant"
                >
                  <span className="material-symbols-outlined text-[16px] text-primary" style={{fontVariationSettings: "'FILL' 1"}}>diamond</span>
                  Keyframe
                </button>
              )}
            </div>
          </div>

          {/* transport */}
          <div className="h-14 bg-surface-container-low border-t border-outline-variant flex items-center justify-between px-6 shrink-0">
            <span className="font-mono text-mono-label text-primary">{fmt(currentFrame / meta.fps)} / {fmt(totalSec)}</span>
            <div className="flex items-center gap-6">
              <button onClick={() => skip(-1)} className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors">skip_previous</button>
              <button onClick={() => playerRef.current?.toggle()} className="w-10 h-10 rounded-full bg-on-surface text-surface flex items-center justify-center hover:scale-105 active:scale-95 transition-all">
                <span className="material-symbols-outlined text-[26px]" style={{fontVariationSettings: "'FILL' 1"}}>{playing ? 'pause' : 'play_arrow'}</span>
              </button>
              <button onClick={() => skip(1)} className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors">skip_next</button>
            </div>
            <button onClick={() => playerRef.current?.requestFullscreen()} className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors text-[20px]">fullscreen</button>
          </div>
        </section>

        <Inspector
          playerRef={playerRef}
          onGenerate={() => generateCaptions(false)}
          onStyleChange={(s) => { setCaptionStyle(s); if (captions.length) generateCaptions(true, s); }}
          generating={generating}
          progressLabel={genLabel}
          notify={notify}
        />
      </main>

      {/* Timeline */}
      <footer className="bg-surface-container-lowest border-t border-outline-variant z-50 shrink-0" style={{height: 300}}>
        <Timeline playerRef={playerRef} />
      </footer>
    </div>
  );
};

const HdrIcon: React.FC<{icon: string; title: string; onClick: () => void; disabled?: boolean}> = ({icon, title, onClick, disabled}) => (
  <button
    title={title}
    onClick={onClick}
    disabled={disabled}
    className="p-1.5 rounded-lg hover:bg-surface-variant transition-colors text-on-surface-variant disabled:opacity-30"
  >
    <span className="material-symbols-outlined text-[20px]">{icon}</span>
  </button>
);

const Center: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div className="flex h-screen items-center justify-center text-on-surface-variant">{children}</div>
);
