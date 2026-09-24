// B-roll cue model and its projection onto the timeline. Pure (no JSX) so the
// MCP server and tests can import it; the layer that draws cues is Broll.tsx.
import {placeClips, type Clip} from './timeline.ts';

export type BrollItem = {
  id: string;
  clipId?: string; // anchor; startMs/endMs are source-relative when set
  startMs: number;
  endMs: number;
  kind: 'video' | 'image';
  mode: 'fullscreen' | 'inset' | 'top' | 'card'; // card = Prism's square card rising over the blurred footage
  src: string;
  source?: 'own' | 'pexels';
  query?: string;
  alternatives?: string[];
  scale?: number; // size multiplier (1 = default), set via the on-preview slider
  enter?: 'cut' | 'punch' | 'zoom' | 'whip' | 'whipDiag'; // how the cue comes in (src/transitions.ts; card/split are for clips)
};

// the creator's own B-roll source (pool the generator can pick from)
export type BrollAsset = {id: string; src: string; kind: 'video' | 'image'; label: string; thumb?: string};

// Source-relative B-roll → absolute timeline, honoring clip order + trim
// (mirrors projectCaptions). Drops cues whose clip was removed or trimmed away.
export function projectBrolls(items: BrollItem[], clips: Clip[], fps: number): BrollItem[] {
  if (!clips.length) return items;
  const placed = placeClips(clips, fps);
  const byId = new Map(placed.map((p) => [p.clip.id, p]));
  const out: BrollItem[] = [];
  for (const b of items) {
    if (!b.clipId) {
      out.push(b);
      continue;
    }
    const pc = byId.get(b.clipId);
    if (!pc) continue;
    const inMs = pc.clip.inSec * 1000;
    const outMs = pc.clip.outSec * 1000;
    if (b.startMs >= outMs || b.endMs <= inMs) continue;
    const speed = pc.clip.speed ?? 1;
    const toAbs = (srcMs: number) => pc.startMs + (srcMs - inMs) / speed;
    out.push({...b, startMs: toAbs(b.startMs), endMs: toAbs(b.endMs)});
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

