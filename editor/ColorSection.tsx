import React, {useEffect, useRef, useState} from 'react';
import {useEditor} from './store';
import {DEFAULTS, LOOKS, autoSources, lutBakes, paramsFor, type Adjust, type GradeParams, type ProjectGrade} from '../src/grade';
import {runJob, readPublic} from './jobs';
import {Btn, Label, Section, Select, Toggle} from './ui';

// Color (set_grade / create_lut): the whole reel or one source / clip (an
// override), every knob of src/grade.ts, LUTs (upload a .cube or make one from
// reference photos). The same resolution and bake list as the MCP.

type Lut = {name: string; file: string};
const base = (src: string) => src.split('/').pop()!;
const NEW: ProjectGrade = {look: 'none', intensity: 0.8, auto: false, bySrc: {}};
const KNOBS: {k: keyof Adjust; label: string; min: number; max: number; step: number; def: number; fmt: (v: number) => string}[] = [
  {k: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05, def: 0, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st`},
  {k: 'contrast', label: 'Contrast', min: 0.5, max: 1.5, step: 0.01, def: 1, fmt: (v) => `×${v.toFixed(2)}`},
  {k: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, def: 1, fmt: (v) => `×${v.toFixed(2)}`},
  {k: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.05, def: 0, fmt: (v) => `${v > 0 ? 'warm ' : v < 0 ? 'cool ' : ''}${v.toFixed(2)}`},
  {k: 'tint', label: 'Tint', min: -1, max: 1, step: 0.05, def: 0, fmt: (v) => `${v > 0 ? 'magenta ' : v < 0 ? 'green ' : ''}${v.toFixed(2)}`},
];
const Slider: React.FC<{label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void}> = ({label, value, min, max, step, fmt, onChange}) => (
  <div>
    <Label>{label}: {fmt(value)}</Label>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-primary" />
  </div>
);

export const ColorSection: React.FC<{notify: (msg: string, kind: 'error' | 'ok') => void}> = ({notify}) => {
  const {clips, mattes, grade, setGrade} = useEditor();
  const [target, setTarget] = useState(''); // '' = whole reel, else a source or a clip id
  const [luts, setLuts] = useState<Lut[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const cubeInput = useRef<HTMLInputElement>(null);
  const refsInput = useRef<HTMLInputElement>(null);
  const loadLuts = () => fetch('/api/luts').then((r) => (r.ok ? r.json() : [])).then((l) => setLuts(Array.isArray(l) ? l : [])).catch(() => setLuts([]));
  useEffect(() => { loadLuts(); }, []);

  // measure the auto sources and bake the LUTs the grade needs, then store it
  const settle = async (g: ProjectGrade) => {
    setGrade(g);
    const need = autoSources(g, clips).filter((s) => !g.bySrc?.[s]);
    const bakes = lutBakes(g, clips, mattes).filter((b) => !g.baked?.[b.key]);
    if (!need.length && !bakes.length) return;
    setBusy('Starting…');
    try {
      const next = {...g};
      if (need.length) {
        await runJob('/api/grade', {clips: need.map((src) => ({src}))}, (s) => setBusy(`${s.label ?? ''} ${s.progress ?? 0}%`));
        next.bySrc = {...next.bySrc, ...((await readPublic<{bySrc?: ProjectGrade['bySrc']}>('grade.json')).bySrc ?? {})};
      }
      if (bakes.length) {
        await runJob('/api/lut', {bake: bakes}, (s) => setBusy(`${s.label ?? ''} ${s.progress ?? 0}%`));
        next.baked = {...next.baked, ...((await readPublic<{baked?: Record<string, string>}>('lut.json')).baked ?? {})};
      }
      setGrade(next);
    } catch (e) { notify('Color: ' + (e as Error).message, 'error'); }
    setBusy(null);
  };

  if (!grade) return (
    <Section title="Color" hint="Off: the footage plays as shot. Everything here is opt-in.">
      <Btn primary onClick={() => setGrade(NEW)} className="w-full">Enable color</Btn>
    </Section>
  );

  const sources = [...new Set(clips.map((c) => c.src))];
  const layer: GradeParams = target ? grade.overrides?.[target] ?? {} : grade;
  const clipOf = clips.find((c) => c.id === target);
  const eff = paramsFor(grade, clipOf?.src ?? target, clipOf?.id); // what this target resolves to
  const patch = (fn: (l: GradeParams) => GradeParams) => settle(target ? {...grade, overrides: {...grade.overrides, [target]: fn(layer)}} : {...grade, ...fn(grade)});
  const setAdj = (k: keyof Adjust, v: number) => patch((l) => ({...l, adjust: {...l.adjust, [k]: v}}));

  const onCube = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const r = await fetch('/api/upload-lut?name=' + encodeURIComponent(f.name), {method: 'POST', body: f}).then((x) => x.json()).catch(() => null);
    if (r?.file) { await loadLuts(); patch((l) => ({...l, lut: r.file})); } else notify('LUT upload failed (.cube)', 'error');
  };
  const onRefs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []); e.target.value = '';
    if (!files.length) return;
    const name = window.prompt('Name of the new LUT (letters, digits, - _)', 'client-look')?.trim();
    if (!name || !/^[\w-]{1,40}$/.test(name)) return;
    const strength = Number(window.prompt('Strength toward the references, 0–1', '0.7') ?? '0.7');
    setBusy('Uploading references…');
    try {
      const refs: string[] = [];
      for (const f of files) {
        const r = await fetch(`/api/upload-ref?lut=${encodeURIComponent(name)}&name=${encodeURIComponent(f.name)}`, {method: 'POST', body: f}).then((x) => x.json());
        if (!r?.file) throw new Error(r?.error ?? 'upload failed');
        refs.push(r.file);
      }
      await runJob('/api/lut', {make: {name, refs, clips: clips.map((c) => ({src: c.src})), strength: Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0.7}}, (s) => setBusy(`${s.label ?? ''} ${s.progress ?? 0}%`));
      const {lut} = await readPublic<{lut?: string}>('lut.json');
      await loadLuts();
      setBusy(null);
      if (lut) { patch((l) => ({...l, lut})); notify(`LUT ${name} made from ${refs.length} photo(s)`, 'ok'); }
    } catch (err) { setBusy(null); notify('Create LUT: ' + (err as Error).message, 'error'); }
  };

  return (
    <Section title="Color" hint="Opt-in and per target: the whole reel, or one source / clip on top of it. Preview = export.">
      <Label>Apply to</Label>
      <Select value={target} onChange={setTarget} options={[{value: '', label: 'Whole reel'}, ...sources.map((s) => ({value: s, label: `Source ${base(s)}${grade.overrides?.[s] ? ' •' : ''}`})), ...clips.map((c) => ({value: c.id, label: `Clip ${c.id}${grade.overrides?.[c.id] ? ' •' : ''}`}))]} />
      <Label>Look</Label>
      <Select value={layer.look ?? ''} onChange={(look) => patch((l) => ({...l, look: look || undefined}))} options={[...(target ? [{value: '', label: `inherit (${eff.look ?? 'none'})`}] : []), ...Object.values(LOOKS).map((l) => ({value: l.id, label: `${l.id} — ${l.desc}`, title: l.desc}))]} />
      <Slider label="Look intensity" value={eff.intensity ?? 0.8} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch((l) => ({...l, intensity: v}))} />
      {KNOBS.map((k) => <Slider key={k.k} label={k.label} value={eff.adjust?.[k.k] ?? k.def} min={k.min} max={k.max} step={k.step} fmt={k.fmt} onChange={(v) => setAdj(k.k, v)} />)}
      <Slider label="Highlight rolloff" value={eff.highlights ?? DEFAULTS.highlights} min={0} max={1} step={0.05} fmt={(v) => (v === 0 ? 'hard clip' : `${Math.round(v * 100)}%`)} onChange={(v) => patch((l) => ({...l, highlights: v}))} />
      <Slider label="Skin protection" value={eff.skin ?? DEFAULTS.skin} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch((l) => ({...l, skin: v}))} />
      <div className="flex items-center justify-between" title="Measure this source's lit frames and correct exposure, contrast, cast and saturation within bounds (flat, dim or tinted footage)">
        <Label>Automatic correction</Label>
        <Toggle on={!!eff.auto} onChange={(auto) => patch((l) => ({...l, auto}))} />
      </div>
      <Label>LUT</Label>
      <div className="flex gap-1">
        <Select value={layer.lut === null ? 'none' : layer.lut ?? ''} onChange={(v) => patch((l) => ({...l, lut: v === '' ? undefined : v === 'none' ? null : v}))} options={[...(target ? [{value: '', label: `inherit (${eff.lut ? base(eff.lut) : 'none'})`}] : [{value: '', label: 'none'}]), ...(target ? [{value: 'none', label: 'none'}] : []), ...luts.map((l) => ({value: l.file, label: l.name}))]} className="flex-1" />
        <input ref={cubeInput} type="file" accept=".cube" onChange={onCube} className="hidden" />
        <Btn onClick={() => cubeInput.current?.click()} title="Upload a .cube">.cube</Btn>
      </div>
      {eff.lut ? <Slider label="LUT mix" value={eff.lutMix ?? 1} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch((l) => ({...l, lutMix: v}))} /> : null}
      <input ref={refsInput} type="file" accept="image/*" multiple onChange={onRefs} className="hidden" />
      <Btn onClick={() => refsInput.current?.click()} disabled={!!busy || !clips.length} title="Match the footage's colors to reference photos of the look (deterministic, bounded) and save it as a .cube" className="w-full">Create LUT from reference photos…</Btn>
      {busy && <p className="text-[11px] text-on-surface-variant truncate">{busy}</p>}
      <div className="flex gap-2">
        {target && grade.overrides?.[target] ? <Btn onClick={() => { const {[target]: _, ...rest} = grade.overrides ?? {}; setGrade({...grade, overrides: rest}); }} className="flex-1">Reset override</Btn> : null}
        <Btn onClick={() => setGrade(null)} className="flex-1">Remove color</Btn>
      </div>
    </Section>
  );
};
