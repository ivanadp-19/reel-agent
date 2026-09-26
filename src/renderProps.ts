// The composition props a render of a saved project gets — one list for the MCP
// (render, start_render, caption_proof) and the render CLI (scripts/render-cli.mjs),
// with the same defaults the MCP applies when it loads a project. The editor sends
// the same fields from its store; the backend puts the fps on them (withDeliveryFps).
import {normalizeCaption} from './captions.ts';
import {deliveryFps} from './timeline.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Project = Record<string, any>;

export function projectRenderProps(p: Project) {
  return withDeliveryFps({
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
  }, p);
}

// The render props with what the SAVED project delivers (null: no saved project), whatever they came with:
// its fps (src/timeline.ts deliveryFps) — 29.97 for a client's deliverables, drafts included — and, for those,
// solid plates (src/graphicTemplates.ts backing: no backdrop blur, so the supers layer carries its plate and
// master + supers == composite). The editor's preview gets its props from here too. At 30 the props carry
// neither, so a project without identity renders, and keys its master, as before.
export function withDeliveryFps<T extends object>(props: T, saved: Project | null): T & {fps?: number; solidPlates?: true} {
  const {fps: _drop, solidPlates: _solid, ...rest} = props as T & {fps?: unknown; solidPlates?: unknown};
  const fps = deliveryFps(saved);
  return (fps === 30 ? rest : {...rest, fps, solidPlates: true}) as T & {fps?: number; solidPlates?: true};
}
