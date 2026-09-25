import React, {useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {TEMPLATES, LIFE_KINDS, OUT_KINDS, REVEAL_KINDS, fieldsOf, parseProps, projectGraphics, type Field, type Graphic, type TemplateId} from '../src/graphicTemplates';
import {Btn, IconBtn, Label, NumberInput, Section, Select, TextInput, Toggle, fmtSec} from './ui';

// Graphics tab: add_graphic / edit_graphic / delete_graphics in the editor.
// Props forms are generated from each template's zod schema (fieldsOf), so a
// new template shows up here with no UI work.

const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

// default props for a template: every field's default, arrays with their minimum rows
const defaultsOf = (fields: Field[]): Record<string, unknown> =>
  Object.fromEntries(fields.map((f) => [f.key, f.kind === 'array' ? Array.from({length: f.min ?? 1}, () => defaultsOf(f.item ?? [])) : f.default ?? (f.kind === 'boolean' ? false : f.kind === 'number' ? f.min ?? 0 : f.kind === 'enum' ? f.options?.[0] : '')]));

const PropsForm: React.FC<{fields: Field[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void}> = ({fields, value, onChange}) => {
  const set = (k: string, v: unknown) => onChange({...value, [k]: v});
  return (
    <div className="space-y-2">
      {fields.map((f) => {
        const v = value[f.key];
        const title = f.desc ?? (f.kind === 'string' && f.max ? `≤ ${f.max} chars` : undefined);
        if (f.kind === 'boolean') return (
          <div key={f.key} className="flex items-center justify-between" title={title}>
            <Label>{f.key}</Label>
            <Toggle on={!!v} onChange={(on) => set(f.key, on)} />
          </div>
        );
        if (f.kind === 'array') {
          const rows = (Array.isArray(v) ? v : []) as Record<string, unknown>[];
          return (
            <div key={f.key} title={title}>
              <div className="flex items-center justify-between">
                <Label>{f.key}</Label>
                <IconBtn icon="add" title="Add row" disabled={f.max != null && rows.length >= f.max} onClick={() => set(f.key, [...rows, defaultsOf(f.item ?? [])])} />
              </div>
              <div className="space-y-1.5 mt-1">
                {rows.map((row, i) => (
                  <div key={i} className="flex gap-1 items-start">
                    <div className="flex-1 p-2 rounded bg-surface-container-lowest/60 border border-outline-variant/20">
                      <PropsForm fields={f.item ?? []} value={row} onChange={(nr) => set(f.key, rows.map((r, j) => (j === i ? nr : r)))} />
                    </div>
                    <IconBtn icon="close" title="Remove row" danger disabled={f.min != null && rows.length <= f.min} onClick={() => set(f.key, rows.filter((_, j) => j !== i))} />
                  </div>
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={f.key} title={title}>
            <Label>{f.key}{f.required ? '' : ''}</Label>
            {f.kind === 'enum' ? (
              <Select value={String(v ?? f.options?.[0] ?? '')} onChange={(nv) => set(f.key, nv)} options={(f.options ?? []).map((o) => ({value: o}))} />
            ) : f.kind === 'number' ? (
              <NumberInput value={Number(v ?? f.default ?? 0)} min={f.min} max={f.max} step={f.max != null && f.max <= 20 ? 0.5 : 1} onChange={(nv) => set(f.key, nv)} />
            ) : (
              <TextInput value={String(v ?? '')} maxLength={f.max} placeholder={f.required ? 'required' : ''} onChange={(nv) => set(f.key, nv)} />
            )}
          </div>
        );
      })}
    </div>
  );
};

export const GraphicsTab: React.FC<{playerRef: React.RefObject<PlayerRef | null>; notify: (msg: string, kind: 'error' | 'ok') => void}> = ({playerRef, notify}) => {
  const {meta, clips, graphics, currentFrame, selectedId, select, addGraphic, editGraphic, removeGraphic} = useEditor();
  const [template, setTemplate] = useState<TemplateId>('hook-stack');
  const [draft, setDraft] = useState<Record<string, unknown>>(() => defaultsOf(fieldsOf(TEMPLATES['hook-stack'].schema)));
  const [edit, setEdit] = useState<{id: string; props: Record<string, unknown>} | null>(null);
  if (!meta) return null;
  const fps = meta.fps;
  const projGfx = projectGraphics(graphics, clips, fps);
  const seekMs = (ms: number) => playerRef.current?.seekTo(Math.round((ms / 1000) * fps));
  const sel = graphics.find((g) => g.id === selectedId);
  const selProj = projGfx.find((g) => g.id === selectedId);
  const selFields = sel ? fieldsOf(TEMPLATES[sel.template].schema) : [];
  const editProps = edit && sel && edit.id === sel.id ? edit.props : sel?.props;

  const pickTemplate = (t: TemplateId) => { setTemplate(t); setDraft(defaultsOf(fieldsOf(TEMPLATES[t].schema))); };
  const add = () => {
    try {
      const props = parseProps(template, draft);
      addGraphic(currentFrame, {template, props});
      notify(`Added ${template}`, 'ok');
    } catch (e) { notify(String((e as Error).message), 'error'); }
  };
  const applyProps = () => {
    if (!sel || !editProps) return;
    try { editGraphic(sel.id, {props: parseProps(sel.template, editProps)}); setEdit(null); notify('Graphic updated', 'ok'); }
    catch (e) { notify(String((e as Error).message), 'error'); }
  };
  const motion = (k: 'reveal' | 'out' | 'life' | 'camera', v: string) => sel && editGraphic(sel.id, {[k]: v === 'auto' && k !== 'reveal' && k !== 'out' ? undefined : v} as Partial<Graphic>);

  return (
    <div className="space-y-5">
      {/* selected graphic */}
      {sel && selProj && (
        <div className="p-3 rounded-lg bg-surface-variant/40 border border-primary/30 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-label-bold font-label-bold uppercase text-primary">{sel.template}</span>
            <div className="flex gap-1">
              <IconBtn icon="delete" title="Delete graphic" danger onClick={() => { removeGraphic(sel.id); select(null); }} />
            </div>
          </div>
          <PropsForm fields={selFields} value={editProps ?? {}} onChange={(p) => setEdit({id: sel.id, props: p})} />
          {edit?.id === sel.id && <Btn primary onClick={applyProps} className="w-full">Apply props</Btn>}
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Start (s)</Label><NumberInput value={+(selProj.startMs / 1000).toFixed(2)} min={0} step={0.1} onChange={(v) => editGraphic(sel.id, {startSec: v})} /></div>
            <div><Label>Duration (s)</Label><NumberInput value={+((sel.endMs - sel.startMs) / 1000).toFixed(2)} min={0.5} max={15} step={0.1} onChange={(v) => editGraphic(sel.id, {durationSec: Math.min(15, Math.max(0.5, v))})} /></div>
          </div>
          <div>
            <Label>Vertical position: {sel.yPct ?? TEMPLATES[sel.template].y ?? '—'}%</Label>
            <input type="range" min={0} max={90} value={sel.yPct ?? TEMPLATES[sel.template].y ?? 40} onChange={(e) => editGraphic(sel.id, {yPct: Number(e.target.value)})} className="w-full mt-1 accent-primary" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Reveal</Label><Select value={sel.reveal ?? 'auto'} onChange={(v) => motion('reveal', v)} options={REVEAL_KINDS.map((k) => ({value: k}))} /></div>
            <div><Label>Out</Label><Select value={sel.out ?? 'auto'} onChange={(v) => motion('out', v)} options={OUT_KINDS.map((k) => ({value: k}))} /></div>
            <div><Label>Life</Label><Select value={sel.life ?? 'none'} onChange={(v) => motion('life', v)} options={LIFE_KINDS.map((k) => ({value: k}))} /></div>
            <div><Label>Camera</Label><Select value={sel.camera ?? 'none'} onChange={(v) => motion('camera', v)} options={[{value: 'none'}, {value: 'punch', title: 'the footage pushes in 1.4× with the title'}]} /></div>
          </div>
          <div className="flex items-center justify-between" title="Draw it behind the presenter (needs a person matte: Settings → Prepare mattes)">
            <Label>Behind the presenter</Label>
            <Toggle on={!!sel.behind} onChange={(on) => editGraphic(sel.id, {behind: on})} />
          </div>
        </div>
      )}

      {/* add */}
      <Section title="Add graphic" hint="Anchored to the word under the playhead; it follows cuts and reorders.">
        <Select value={template} onChange={(t) => pickTemplate(t as TemplateId)} options={TEMPLATE_IDS.map((id) => ({value: id, title: TEMPLATES[id].desc}))} />
        <p className="text-[11px] text-on-surface-variant/60">{TEMPLATES[template].desc}</p>
        <PropsForm fields={fieldsOf(TEMPLATES[template].schema)} value={draft} onChange={setDraft} />
        <Btn primary onClick={add} disabled={!clips.length} className="w-full"><span className="material-symbols-outlined text-[16px]">add</span>Add at playhead</Btn>
      </Section>

      {/* list */}
      <Section title={`Graphics (${projGfx.length})`}>
        {!projGfx.length && <p className="text-body-sm text-on-surface-variant/60">None yet.</p>}
        {projGfx.map((g) => {
          const isSel = g.id === selectedId;
          const summary = Object.values(g.props).map((v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? (x as {text?: string}).text : x)).join(' / ') : typeof v === 'string' ? v : '')).filter(Boolean).join(' · ');
          return (
            <div
              key={`${g.id}@${g.startMs}`}
              onClick={() => { select(g.id); setEdit(null); seekMs(g.startMs + 20); }}
              className={`p-2.5 rounded cursor-pointer transition-colors ${isSel ? 'bg-surface-variant/40 border-2 border-primary' : 'bg-surface-variant/20 border border-outline-variant/30 hover:border-primary/30'}`}
            >
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono text-on-surface-variant">{fmtSec(g.startMs)} – {fmtSec(g.endMs)}</span>
                <span className="text-[10px] uppercase text-primary">{g.template}{g.behind ? ' · behind' : ''}</span>
              </div>
              <p className="text-body-sm text-on-surface truncate">{summary || g.id}</p>
            </div>
          );
        })}
      </Section>
    </div>
  );
};
