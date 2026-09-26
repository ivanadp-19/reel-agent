import React, {useEffect, useRef, useState} from 'react';
import {useEditor} from './store';
import {PRESETS, type PresetId} from '../src/captionPresets';
import {PACKS} from '../src/stylePacks';
import {FONT_FAMILIES, type ClientFont} from '../src/fonts';
import {glossaryText, parseGlossary, styleEffects, styleSchema, type Brand, type Style} from '../src/brand';
import {ColorSection} from './ColorSection';
import {Btn, IconBtn, Label, Section, Select, TextInput} from './ui';

// Styles tab: style pack + accent (as before), the brand kit (set_brand) and
// color (set_grade / create_lut, ColorSection).

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
  const {accentColor, captionStyle, brand, grade, audio, setAccentColor, setBrand, setGrade, setAudio, setCaptionsOff} = useEditor();
  const [kits, setKits] = useState<Kit[]>([]);
  const logoInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const loadKits = () => fetch('/api/brands').then((r) => (r.ok ? r.json() : [])).then((l) => setKits(Array.isArray(l) ? l : [])).catch(() => setKits([]));
  useEffect(() => { loadKits(); }, []);

  const patchBrand = (fn: (b: Brand) => Brand) => brand && setBrand(fn(brand));
  const loadKit = async (slug: string) => {
    if (!slug) return;
    const k = await fetch(`/api/brands/${slug}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!k?.colors?.accent) return notify('Could not load that kit', 'error');
    setBrand(k);
    // its style on this project, as set_brand from does (src/brand.ts styleEffects); a LUT is baked by the render if not yet
    const fx = styleEffects(k.style);
    if (fx.captionsOff != null) setCaptionsOff(fx.captionsOff);
    if (fx.audio) setAudio({...(audio ?? {}), ...fx.audio});
    if (fx.grade) setGrade({...(grade ?? {look: 'none', intensity: 0.8, auto: false, bySrc: {}}), ...fx.grade, ...(fx.grade.adjust ? {adjust: {...grade?.adjust, ...fx.grade.adjust}} : {})});
    // as set_brand: the kit's pack, re-paged — the same pack too when the kit brings another glossary
    if (fx.pack && (fx.pack !== captionStyle || JSON.stringify(k.glossary ?? []) !== JSON.stringify(brand?.glossary ?? []))) onStyleChange(fx.pack);
    notify(`Brand kit "${k.name ?? slug}" loaded${k.style ? ' with its style' : ''}`, 'ok');
  };
  // the kit's style: notes in words + the other preferences as JSON (validated by styleSchema)
  const {notes = '', ...prefs} = brand?.style ?? {};
  const [prefsText, setPrefsText] = useState('');
  const [prefsErr, setPrefsErr] = useState<string | null>(null);
  useEffect(() => { setPrefsText(Object.keys(prefs).length ? JSON.stringify(prefs, null, 1) : ''); setPrefsErr(null); }, [brand?.name, JSON.stringify(prefs)]); // eslint-disable-line react-hooks/exhaustive-deps
  const setStyle = (st: Style) => patchBrand((b) => { const clean = Object.fromEntries(Object.entries(st).filter(([, v]) => v !== '' && v != null)); return Object.keys(clean).length ? {...b, style: clean as Style} : (({style: _, ...rest}) => rest)(b); });
  const commitPrefs = () => {
    let obj: unknown = {};
    try { obj = prefsText.trim() ? JSON.parse(prefsText) : {}; } catch { return setPrefsErr('not valid JSON'); }
    const r = styleSchema.safeParse({...(obj as object), ...(notes ? {notes} : {})});
    if (!r.success) return setPrefsErr(r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
    setPrefsErr(null); setStyle(r.data);
  };
  // set_brand glossary: one term a line, "Altabrisa: Alta Brisa, Altabriza" (applied when captions are generated or re-paged)
  const [glossText, setGlossText] = useState('');
  useEffect(() => { setGlossText(glossaryText(brand?.glossary)); }, [brand?.name, JSON.stringify(brand?.glossary)]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitGlossary = () => patchBrand((b) => { const g = parseGlossary(glossText, b.glossary); return g.length ? {...b, glossary: g} : (({glossary: _, ...rest}) => rest)(b); });
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
            <Label>Style — how this client edits (read by the plan)</Label>
            <textarea value={notes} onChange={(e) => setStyle({...prefs, notes: e.target.value} as Style)} rows={3} placeholder="In their words: sin subtítulos, cortes secos, color natural, piel sin naranja…" className="w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded p-2 text-[12px] resize-y" />
            <textarea value={prefsText} onChange={(e) => setPrefsText(e.target.value)} onBlur={commitPrefs} rows={prefsText ? Math.min(10, prefsText.split('\n').length + 1) : 2} placeholder='Preferences as JSON: {"captions": "off", "pack": "palabra", "grade": {"look": "natural", "skin": 0.8}, "pace": "rápido"}' className="w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded p-2 text-[11px] font-mono resize-y" />
            {prefsErr && <p className="text-[11px] text-error">{prefsErr}</p>}
            <Label>Glossary — the client's spellings, applied when captions are generated</Label>
            <textarea value={glossText} onChange={(e) => setGlossText(e.target.value)} onBlur={commitGlossary} rows={glossText ? Math.min(10, glossText.split('\n').length + 1) : 2} placeholder={'Altabrisa: Alta Brisa\nStar Médica: Esther Médica'} className="w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded p-2 text-[11px] font-mono resize-y" />
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

      <ColorSection notify={notify} />
    </div>
  );
};
