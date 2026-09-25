import React, {useEffect, useRef, useState} from 'react';
import {useEditor} from './store';
import {PRESETS, type PresetId} from '../src/captionPresets';
import {PACKS} from '../src/stylePacks';
import {FONT_FAMILIES, type ClientFont} from '../src/fonts';
import {LOOKS, type ProjectGrade} from '../src/grade';
import type {Brand} from '../src/brand';
import {runJob, readPublic} from './jobs';
import {Btn, IconBtn, Label, Section, Select, TextInput, Toggle} from './ui';

// Styles tab: style pack + accent (as before), the brand kit (set_brand) and
// color (set_grade).

const ACCENT_SWATCHES = ['#FFB020', '#c2c1ff', '#ffb785', '#adc6ff', '#39d98a', '#ff6b8b'];
const HEX = /^#[0-9a-fA-F]{6}$/;
type Kit = {slug: string; name: string};

const ColorField: React.FC<{label: string; value?: string; fallback: string; onChange: (v: string | undefined) => void; clearable?: boolean}> = ({label, value, fallback, onChange, clearable}) => (
  <div className="flex items-center justify-between gap-2">
    <Label>{label}</Label>
    <div className="flex items-center gap-1">
      <input type="color" value={value ?? fallback} onChange={(e) => onChange(e.target.value)} className="w-7 h-7 rounded border border-outline-variant/40 bg-transparent cursor-pointer" />
      <span className="text-[10px] font-mono text-on-surface-variant w-14">{value ?? '—'}</span>
      {clearable && value && <IconBtn icon="close" title="Use the default" onClick={() => onChange(undefined)} />}
    </div>
  </div>
);

export const StylesTab: React.FC<{onStyleChange: (s: PresetId) => void; notify: (msg: string, kind: 'error' | 'ok') => void}> = ({onStyleChange, notify}) => {
  const {clips, accentColor, captionStyle, brand, grade, setAccentColor, setBrand, setGrade} = useEditor();
  const [kits, setKits] = useState<Kit[]>([]);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const loadKits = () => fetch('/api/brands').then((r) => (r.ok ? r.json() : [])).then((l) => setKits(Array.isArray(l) ? l : [])).catch(() => setKits([]));
  useEffect(() => { loadKits(); }, []);

  const patchBrand = (fn: (b: Brand) => Brand) => brand && setBrand(fn(brand));
  const loadKit = async (slug: string) => {
    if (!slug) return;
    const k = await fetch(`/api/brands/${slug}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (k?.colors?.accent) { setBrand(k); notify(`Brand kit "${k.name ?? slug}" loaded`, 'ok'); } else notify('Could not load that kit', 'error');
  };
  const saveKit = async () => {
    if (!brand) return;
    const name = window.prompt('Save this kit as', brand.name ?? '');
    if (!name?.trim()) return;
    const r = await fetch(`/api/brands/${encodeURIComponent(name.trim())}`, {method: 'POST', body: JSON.stringify({...brand, name: brand.name ?? name.trim()})}).then((x) => x.json()).catch(() => null);
    if (r?.slug) { notify(`Saved as "${r.slug}"`, 'ok'); loadKits(); } else notify('Could not save the kit', 'error');
  };
  const onLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const r = await fetch('/api/upload-image?name=' + encodeURIComponent(f.name), {method: 'POST', body: f}).then((x) => x.json()).catch(() => null);
    if (r?.src) patchBrand((b) => ({...b, logo: r.src})); else notify('Logo upload failed', 'error');
  };

  // set_brand font_files / drop_fonts: the client's own faces, uploaded to public/fonts/
  const onFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const r = await fetch('/api/upload-font?name=' + encodeURIComponent(f.name), {method: 'POST', body: f}).then((x) => x.json()).catch(() => null) as ClientFont | null;
    if (r?.file) { patchBrand((b) => ({...b, fonts: {...b.fonts, files: [...(b.fonts?.files ?? []).filter((x) => x.file !== r.file), r]}})); notify(`Font ${r.family} ${r.weight} added — pick it as headline or caption font`, 'ok'); }
    else notify('Font upload failed (.ttf, .otf, .woff, .woff2)', 'error');
  };
  const dropFont = (family: string) => patchBrand((b) => {
    const {display, body, ...rest} = b.fonts ?? {};
    return {...b, fonts: {...rest, files: (rest.files ?? []).filter((x) => x.family !== family), ...(display && display !== family ? {display} : {}), ...(body && body !== family ? {body} : {})}};
  });
  const clientFamilies = [...new Set((brand?.fonts?.files ?? []).map((x) => x.family))];
  const fontOptions = [...clientFamilies.map((f) => ({value: f, label: `${f} (client font)`})), ...FONT_FAMILIES.map((f) => ({value: f as string}))];

  const analyze = async (g: ProjectGrade) => {
    setAnalyzing('Starting…');
    try {
      await runJob('/api/grade', {clips}, (s) => setAnalyzing(`${s.label ?? ''} ${s.progress ?? 0}%`));
      const r = await readPublic<{bySrc?: ProjectGrade['bySrc']}>('grade.json');
      setGrade({...g, auto: true, bySrc: r.bySrc ?? {}});
      notify(`Analyzed ${Object.keys(r.bySrc ?? {}).length} source(s)`, 'ok');
    } catch (e) { notify('Color analysis failed: ' + (e as Error).message, 'error'); }
    setAnalyzing(null);
  };

  return (
    <div className="space-y-5">
      <Section title="Caption style">
        <div className="grid grid-cols-2 gap-2">
          {Object.values(PRESETS).map((p) => (
            <button
              key={p.id}
              onClick={() => onStyleChange(p.id)}
              title={PACKS[p.id] ? `${p.desc}\ncuts: ${PACKS[p.id].transition}` : p.desc}
              className={`py-2 rounded-lg border text-body-md font-bold ${captionStyle === p.id ? 'border-primary text-primary bg-primary-container/20' : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/30'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Accent color" hint="Highlights the meaningful words in your captions.">
        <div className="flex flex-wrap gap-2 items-center">
          {ACCENT_SWATCHES.map((c) => (
            <button key={c} onClick={() => setAccentColor(c)} style={{background: c}} className={`w-8 h-8 rounded-full border-2 ${accentColor.toLowerCase() === c.toLowerCase() ? 'border-on-surface' : 'border-transparent'}`} title={c} />
          ))}
          <input type="color" value={HEX.test(accentColor) ? accentColor : '#FFB020'} onChange={(e) => setAccentColor(e.target.value)} title="Any color" className="w-8 h-8 rounded-full border-2 border-outline-variant/40 bg-transparent cursor-pointer" />
          <span className="text-[10px] font-mono text-on-surface-variant">{accentColor}</span>
        </div>
      </Section>

      <Section title="Brand kit" hint="A client's palette, fonts and logo. Captions, templates and canvases read it; it overrides the pack's palette.">
        {brand ? (
          <>
            <TextInput value={brand.name ?? ''} placeholder="Kit name" maxLength={40} onChange={(v) => patchBrand((b) => ({...b, name: v || undefined}))} />
            <ColorField label="Accent" value={brand.colors.accent} fallback="#FFB020" onChange={(v) => v && setAccentColor(v)} />
            <ColorField label="Dark canvas" value={brand.colors.dark} fallback="#0b0b0d" clearable onChange={(v) => patchBrand((b) => ({...b, colors: {...b.colors, dark: v}}))} />
            <ColorField label="Light canvas" value={brand.colors.light} fallback="#f3f3f0" clearable onChange={(v) => patchBrand((b) => ({...b, colors: {...b.colors, light: v}}))} />
            <div className="grid grid-cols-2 gap-2">
              <div><Label>Headline font</Label><Select value={brand.fonts?.display ?? ''} onChange={(v) => patchBrand((b) => ({...b, fonts: {...b.fonts, display: v || undefined}}))} options={[{value: '', label: 'template default'}, ...fontOptions]} /></div>
              <div><Label>Caption font</Label><Select value={brand.fonts?.body ?? ''} onChange={(v) => patchBrand((b) => ({...b, fonts: {...b.fonts, body: v || undefined}}))} options={[{value: '', label: 'pack default'}, ...fontOptions]} /></div>
            </div>
            <div className="flex items-center justify-between gap-2" title="The client's own font files (e.g. Helvetica Bold). They stay in public/fonts/ on this machine, never in the repo.">
              <Label>Client fonts</Label>
              <input ref={fontInput} type="file" accept=".ttf,.otf,.woff,.woff2" onChange={onFont} className="hidden" />
              <Btn onClick={() => fontInput.current?.click()}>Upload font</Btn>
            </div>
            {(brand.fonts?.files ?? []).map((x) => (
              <div key={x.file} className="flex items-center justify-between gap-2 text-[11px] text-on-surface-variant">
                <span className="truncate" title={x.file}>{x.family} {x.weight}{x.italic ? ' italic' : ''}</span>
                <IconBtn icon="close" title={`Remove ${x.family}`} onClick={() => dropFont(x.family)} />
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <Label>Logo</Label>
              <input ref={logoInput} type="file" accept="image/*" onChange={onLogo} className="hidden" />
              <div className="flex items-center gap-2">
                {brand.logo && <img src={'/' + brand.logo} alt="logo" className="h-7 max-w-[80px] object-contain rounded bg-surface-container-lowest" />}
                <Btn onClick={() => logoInput.current?.click()}>{brand.logo ? 'Replace' : 'Upload'}</Btn>
                {brand.logo && <IconBtn icon="close" title="Remove logo" onClick={() => patchBrand(({logo: _, ...b}) => b)} />}
              </div>
            </div>
            <div className="flex gap-2">
              <Btn onClick={saveKit} className="flex-1">Save as kit…</Btn>
              <Btn onClick={() => { setBrand(null); notify('Brand kit removed', 'ok'); }} className="flex-1">Remove kit</Btn>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <Btn primary onClick={() => setBrand({colors: {accent: accentColor}, fonts: {}})} className="flex-1">Create kit</Btn>
            {kits.length > 0 && <Select value="" onChange={loadKit} options={[{value: '', label: 'Load a saved kit…'}, ...kits.map((k) => ({value: k.slug, label: k.name}))]} className="flex-1" />}
          </div>
        )}
      </Section>

      <Section title="Color" hint="A bounded automatic correction per source plus one look, applied at render and in the preview.">
        {grade ? (
          <>
            <Select value={grade.look} onChange={(look) => setGrade({...grade, look})} options={Object.values(LOOKS).map((l) => ({value: l.id, label: `${l.id} — ${l.desc}`, title: l.desc}))} />
            <Label>Intensity: {Math.round(grade.intensity * 100)}%</Label>
            <input type="range" min={0} max={100} value={Math.round(grade.intensity * 100)} onChange={(e) => setGrade({...grade, intensity: Number(e.target.value) / 100})} className="w-full accent-primary" />
            <div className="flex items-center justify-between" title="Measure each source's lit frames and correct exposure, contrast, cast and saturation within bounds">
              <Label>Automatic correction {grade.auto && !Object.keys(grade.bySrc ?? {}).length ? '(analyze first)' : ''}</Label>
              <Toggle on={grade.auto} onChange={(on) => (on ? analyze(grade) : setGrade({...grade, auto: false}))} />
            </div>
            <div className="flex gap-2">
              <Btn onClick={() => analyze(grade)} disabled={!!analyzing || !clips.length} className="flex-1">{analyzing ?? 'Analyze sources'}</Btn>
              <Btn onClick={() => setGrade(null)} className="flex-1">Remove</Btn>
            </div>
          </>
        ) : (
          <Btn primary onClick={() => setGrade({look: 'clean', intensity: 0.8, auto: false, bySrc: {}})} className="w-full">Enable color</Btn>
        )}
      </Section>
    </div>
  );
};
