// The composition props a render of a saved project gets — one list for the MCP
// (render, start_render, caption_proof) and the render CLI (scripts/render-cli.mjs),
// with the same defaults the MCP applies when it loads a project. The editor sends
// the same fields from its store.
import {normalizeCaption} from './captions.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Project = Record<string, any>;

export function projectRenderProps(p: Project) {
  return {
    clips: p.clips ?? [],
    music: p.music ?? null,
    captions: (p.captions ?? []).map(normalizeCaption),
    brolls: p.brolls ?? [],
    graphics: p.graphics ?? [],
    mattes: p.mattes ?? [],
    accentColor: p.accentColor ?? '#FFB020',
    captionStyle: p.captionStyle ?? 'palabra',
    brand: p.brand ?? null,
    grade: p.grade ?? null,
    audio: p.audio ?? {clean: 'off'},
    captionsOff: p.captionsOff ?? false,
  };
}
