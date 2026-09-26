// Per-project fonts: real font FILES under public/fonts/ (e.g. a client's
// Helvetica Bold), unlike the OFL catalog in fonts.ts. set_brand only accepts
// catalog (OFL) families, so a licensed client face comes in as a file: drop
// it in public/fonts/, reference it from a preset's font.custom, and preview
// and export load the same file.
//
// VIBEM: public/fonts/Helvetica-Bold.ttf. `npm run setup` extracts it from
// macOS's own Helvetica.ttc; elsewhere bring your licensed file. It is never
// committed. A missing or broken file — or another face under that file name
// (font.custom.name: an Arial saved as Helvetica-Bold.ttf) — fails the render
// (cancelRender, like the brand fonts in fonts.ts), never a silent stand-in.

import {useEffect, useState} from 'react';
import {cancelRender, continueRender, delayRender, staticFile} from 'remotion';
import {realAdvances} from './captionLayout';
import {readFont} from './sfnt';

// ascent / descent (em): pinned vertical metrics, so any file of the face sits on the same baseline.
// name: the face's full name (name ID 4) the file must carry
export type CustomFont = {family: string; file: string; weight: number; ascent?: number; descent?: number; name?: string};

const loading = new Map<string, Promise<void>>();
const done = new Set<string>(); // families read and in
const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
const fonts = () => document.fonts as unknown as {add: (f: FontFace) => void; delete: (f: FontFace) => void};

async function load(c: CustomFont): Promise<void> {
  const res = await fetch(staticFile(c.file));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const file = readFont(new Uint8Array(bytes));
  if (c.name && file.fullName !== c.name) throw new Error(`it is "${file.fullName}", not ${c.name}`);
  realAdvances(c.family, file.advance); // the page fits its words at their real widths (captionLayout)
  const pinned = c.ascent != null && c.descent != null;
  const face = (ascent?: number) =>
    new FontFace(c.family, bytes.slice(0), {weight: String(c.weight), ...(pinned ? {ascentOverride: pct(ascent!), descentOverride: pct(c.descent!), lineGapOverride: '0%'} : {})}).load();
  let f = await face(c.ascent);
  fonts().add(f);
  if (!pinned) return;
  // Chrome on macOS adds 15 % of (ascent + descent) to the ascent of any face whose internal
  // family is Helvetica, Times or Courier, overrides included (Blink AscentDescentWithHacks):
  // the text lands ~3 px low at 576×1024. Measure that extra and take it back out of the ascent.
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${c.weight} 100px "${c.family}"`;
  const extra = (ctx.measureText('H').fontBoundingBoxAscent / 100 - c.ascent!) / (c.ascent! + c.descent!);
  if (extra < 0.01) return; // Linux, Windows, a file under another family name: the pins already hold
  fonts().delete(f);
  f = await face((c.ascent! - extra * c.descent!) / (1 + extra)); // A' + extra·(A' + D) = A (±1 px rounding off 100 / 115 px)
  fonts().add(f);
}
const loaded = (c: CustomFont) => load(c).then(() => void done.add(c.family));

// Loads the face once. Called during render; the first call holds the frame until the font is in.
export function ensureProjectFont(custom: CustomFont): string {
  if (!loading.has(custom.family)) {
    const handle = delayRender(`project font ${custom.family}`);
    const p = loaded(custom);
    loading.set(custom.family, p);
    p.then(
      () => continueRender(handle),
      (e) => cancelRender(new Error(`caption font ${custom.family}: public/${custom.file} did not load (${e instanceof Error ? e.message : e}) — run \`npm run setup\` on macOS, or copy the licensed file there`)),
    );
  }
  return `${custom.family}, system-ui, sans-serif`;
}

// For a component that sizes text by the face's real widths (CaptionTrack's fitPage): the family, and a
// re-render once the file is read — the frame is held until that render, so no frame is sized by the estimate.
export function useProjectFont(custom?: CustomFont): string | undefined {
  const family = custom ? ensureProjectFont(custom) : undefined;
  const [ready, setReady] = useState(() => !custom || done.has(custom.family));
  const [handle] = useState(() => (ready ? null : delayRender(`caption sizes ${custom!.family}`)));
  useEffect(() => { if (!ready && custom) loading.get(custom.family)!.then(() => setReady(true), () => {}); }, [custom?.family]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && handle != null) continueRender(handle); }, [ready, handle]);
  return family;
}
