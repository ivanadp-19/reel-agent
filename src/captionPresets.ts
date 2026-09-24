// Caption presets: everything about how captions LOOK and MOVE lives here as
// data. The pager reads `layout`, the renderer reads the rest. The agent only
// picks a preset id and per-word tiers; it never writes style or animation.
//
// palabra / caja / tracked come from the real-estate reference reels
// (research/style-references.md): captions there are minimal — the headlines
// and labels carry the "premium" feel. prism mirrors Captions.ai "Prism Pro".

export type PresetId = 'palabra' | 'caja' | 'tracked' | 'prism';
export type AnimIn = 'fade' | 'slideUp' | 'pop' | 'blur';

export type Preset = {
  id: PresetId;
  label: string;
  desc: string; // one line for the UI and the agent
  font: {family: 'Montserrat' | 'Inter'; weight: number; sizePx: number; case: 'upper' | 'none'; trackingPx: number; lineHeight: number};
  colors: {text: string; dim: string; box?: string};
  shadow: string; // CSS text-shadow ('' = none)
  box: boolean; // dark rounded box behind the page
  active: 'none' | 'color'; // how the word being spoken is marked
  pageIn: {type: AnimIn; ms: number};
  pageOut: {ms: number}; // fade
  // tier 1 = accent color; tier 2 = accent + bigger + pop. Tier 3 (hero page) is reserved.
  tiers: {1: {scale: number; weight: number}; 2: {scale: number; weight: number}};
  layout: {maxWords: number; maxCharsLine: number};
};

const SOFT_SHADOW = '0 2px 14px rgba(0,0,0,0.55), 0 0 30px rgba(0,0,0,0.35)';

export const PRESETS: Record<PresetId, Preset> = {
  palabra: {
    id: 'palabra',
    label: 'Palabra',
    desc: 'one word at a time, big, centered, no box (R1/R4)',
    font: {family: 'Montserrat', weight: 700, sizePx: 92, case: 'none', trackingPx: -1, lineHeight: 1.1},
    colors: {text: '#ffffff', dim: '#ffffff'},
    shadow: SOFT_SHADOW,
    box: false,
    active: 'none',
    pageIn: {type: 'pop', ms: 160},
    pageOut: {ms: 100},
    tiers: {1: {scale: 1, weight: 800}, 2: {scale: 1.18, weight: 800}},
    layout: {maxWords: 1, maxCharsLine: 18},
  },
  caja: {
    id: 'caja',
    label: 'Caja',
    desc: 'short phrase in a dark rounded box, spoken word in white (R2)',
    font: {family: 'Inter', weight: 600, sizePx: 54, case: 'none', trackingPx: -0.5, lineHeight: 1.25},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.72)', box: 'rgba(0,0,0,0.72)'},
    shadow: '',
    box: true,
    active: 'color',
    pageIn: {type: 'fade', ms: 120},
    pageOut: {ms: 120},
    tiers: {1: {scale: 1, weight: 800}, 2: {scale: 1.12, weight: 800}},
    layout: {maxWords: 6, maxCharsLine: 26},
  },
  tracked: {
    id: 'tracked',
    label: 'Tracked',
    desc: 'small spaced caps, a phrase at a time, blur-in (R3)',
    font: {family: 'Montserrat', weight: 600, sizePx: 42, case: 'upper', trackingPx: 6, lineHeight: 1.35},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.85)'},
    shadow: SOFT_SHADOW,
    box: false,
    active: 'none',
    pageIn: {type: 'blur', ms: 220},
    pageOut: {ms: 160},
    tiers: {1: {scale: 1, weight: 800}, 2: {scale: 1.15, weight: 800}},
    layout: {maxWords: 4, maxCharsLine: 22},
  },
  prism: {
    id: 'prism',
    label: 'Prism',
    desc: 'light phrase, the tier words bold and bigger (Captions.ai Prism Pro)',
    font: {family: 'Inter', weight: 400, sizePx: 56, case: 'none', trackingPx: -0.5, lineHeight: 1.2},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.9)'},
    shadow: SOFT_SHADOW,
    box: false,
    active: 'none',
    pageIn: {type: 'slideUp', ms: 180},
    pageOut: {ms: 140},
    tiers: {1: {scale: 1.05, weight: 800}, 2: {scale: 1.3, weight: 800}},
    layout: {maxWords: 6, maxCharsLine: 28},
  },
};

export const DEFAULT_STYLE: PresetId = 'palabra';
export const presetOf = (id?: string): Preset => PRESETS[id as PresetId] ?? PRESETS[DEFAULT_STYLE];
