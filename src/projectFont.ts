// Per-project fonts: real font FILES under public/fonts/ (e.g. a client's
// Helvetica Bold), unlike the OFL catalog in fonts.ts. set_brand only accepts
// catalog (OFL) families, so a licensed client face comes in as a file: drop
// it in public/fonts/, reference it from a preset's font.custom, and preview
// and export load the same file.
//
// VIBEM: supply your own licensed Helvetica-Bold.ttf at public/fonts/
// (the preset references that exact path; the file is not committed).

import {continueRender, delayRender, staticFile} from 'remotion';

export type CustomFont = {family: string; file: string; weight: number};

const loaded = new Set<string>();
let handle: number | null = null;

// Loads the face once (FontFace + document.fonts). Called during render; the
// first call holds the frame until the font is in.
export function ensureProjectFont(custom: CustomFont): string {
  if (!loaded.has(custom.family)) {
    loaded.add(custom.family);
    handle ??= delayRender(`project font ${custom.family}`);
    const face = new FontFace(custom.family, `url('${staticFile(custom.file)}')`, {weight: String(custom.weight)});
    face
      .load()
      .then((f) => {
        (document.fonts as unknown as {add: (f: FontFace) => void}).add(f);
        if (handle != null) continueRender(handle);
        handle = null;
      })
      .catch(() => {
        // fall back to system-ui rather than hang the render
        if (handle != null) continueRender(handle);
        handle = null;
      });
  }
  return `${custom.family}, system-ui, sans-serif`;
}
