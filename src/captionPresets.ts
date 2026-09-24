// Caption presets ("style packs"): everything about how captions LOOK and
// MOVE lives here as data. The pager reads `layout`, the renderer reads the
// rest. The agent only picks a preset id and per-word tiers; it never writes
// style or animation.
//
// palabra / caja / tracked come from the real-estate reference reels
// (research/style-references.md). The rest imitate Captions.ai AI Edit styles
// (research/captions-ai-styles.md) with OFL fonts and our own palettes.

import type {FontFamily} from './fonts.ts';

export type AnimIn = 'fade' | 'slideUp' | 'pop' | 'blur';

// what a tier does to a word (combinable)
export type TierStyle = {
  scale?: number;
  weight?: number;
  italic?: boolean;
  font?: FontFamily; // switch family (script / serif / hand)
  color?: 'accent' | 'text'; // default accent
  pill?: boolean; // solid accent background, rounded
  block?: boolean; // solid accent background, square-ish (marker highlight)
  underline?: boolean;
};

export type Preset = {
  id: string;
  label: string;
  desc: string; // one line for the UI and the agent
  font: {family: FontFamily; weight: number; sizePx: number; case: 'upper' | 'none'; trackingPx: number; lineHeight: number; italic?: boolean};
  colors: {
    text: string;
    dim: string; // not-yet-spoken (karaoke) or not-active words
    accent?: string; // pack palette; the project accent is used when absent
    onAccent?: string; // text color on pill/block backgrounds
    container?: string; // page container background
  };
  shadow: string; // CSS text-shadow ('' = none)
  container: 'none' | 'pill' | 'bar' | 'glass';
  reveal: 'page' | 'build'; // build = words appear at their onset and stay
  upcoming: 'hidden' | 'dim'; // build only: words not yet spoken
  active: 'none' | 'color'; // mark the word being spoken (page reveal)
  position: 'anchored' | 'float'; // anchored = face-aware topPct; float = alternate corners
  pageIn: {type: AnimIn; ms: number};
  pageOut: {ms: number}; // fade
  tiers: {1: TierStyle; 2: TierStyle}; // tier 3 (hero page) is reserved
  layout: {maxWords: number; maxCharsLine: number};
};

const SOFT = '0 2px 14px rgba(0,0,0,0.55), 0 0 30px rgba(0,0,0,0.35)';
const HARD = '0 4px 0 rgba(0,0,0,0.35), 0 10px 40px rgba(0,0,0,0.45)';

const base = {
  colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.55)'},
  shadow: SOFT,
  container: 'none',
  reveal: 'page',
  upcoming: 'hidden',
  active: 'none',
  position: 'anchored',
  pageIn: {type: 'fade', ms: 120},
  pageOut: {ms: 120},
  tiers: {1: {weight: 800}, 2: {weight: 800, scale: 1.15}},
  layout: {maxWords: 6, maxCharsLine: 26},
} satisfies Omit<Preset, 'id' | 'label' | 'desc' | 'font'>;

// floating positions cycle per page (Prism-style): top-left, top-right, low-center.
// Tops stay under the Reels top UI band (validate.ts SAFE.topPct = 13).
export const FLOAT_SLOTS = [
  {top: 15, align: 'flex-start'},
  {top: 18, align: 'flex-end'},
  {top: 64, align: 'center'},
] as const;

export const PRESETS: Record<string, Preset> = {
  // ---- from the real-estate references ----
  palabra: {
    ...base,
    id: 'palabra',
    label: 'Palabra',
    desc: 'one word at a time, big, centered, no box (R1/R4)',
    font: {family: 'Montserrat', weight: 700, sizePx: 92, case: 'none', trackingPx: -1, lineHeight: 1.1},
    pageIn: {type: 'pop', ms: 160},
    pageOut: {ms: 100},
    tiers: {1: {weight: 800}, 2: {weight: 800, scale: 1.18}},
    layout: {maxWords: 1, maxCharsLine: 18},
  },
  caja: {
    ...base,
    id: 'caja',
    label: 'Caja',
    desc: 'short phrase in a dark rounded box, spoken word in white (R2)',
    font: {family: 'Inter', weight: 600, sizePx: 54, case: 'none', trackingPx: -0.5, lineHeight: 1.25},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.72)', container: 'rgba(0,0,0,0.72)'},
    shadow: '',
    container: 'pill',
    active: 'color',
    tiers: {1: {weight: 800}, 2: {weight: 800, scale: 1.12}},
  },
  tracked: {
    ...base,
    id: 'tracked',
    label: 'Tracked',
    desc: 'small spaced caps, a phrase at a time, blur-in (R3)',
    font: {family: 'Montserrat', weight: 600, sizePx: 42, case: 'upper', trackingPx: 6, lineHeight: 1.35},
    pageIn: {type: 'blur', ms: 220},
    pageOut: {ms: 160},
    layout: {maxWords: 4, maxCharsLine: 22},
  },
  // ---- Captions.ai-like packs (level A: typography and color blocks only) ----
  prism: {
    ...base,
    id: 'prism',
    label: 'Prism',
    desc: 'light phrase built word by word, key words bold italic in a cool tint, floating position (Captions.ai Prism Pro)',
    font: {family: 'Inter', weight: 300, sizePx: 58, case: 'none', trackingPx: -0.5, lineHeight: 1.15},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.4)', accent: '#9FD9DC'},
    reveal: 'build',
    position: 'float',
    pageIn: {type: 'slideUp', ms: 160},
    tiers: {1: {weight: 800, italic: true, scale: 1.12}, 2: {weight: 800, italic: true, scale: 1.4}},
    layout: {maxWords: 6, maxCharsLine: 24},
  },
  focus: {
    ...base,
    id: 'focus',
    label: 'Focus',
    desc: 'white sans, key word on a solid highlight block, royal blue (Captions.ai Focus)',
    font: {family: 'Inter', weight: 600, sizePx: 54, case: 'none', trackingPx: -0.5, lineHeight: 1.3},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#3B5BFF', onAccent: '#ffffff'},
    reveal: 'build',
    tiers: {1: {weight: 700, block: true}, 2: {weight: 800, block: true, scale: 1.1}},
  },
  stack: {
    ...base,
    id: 'stack',
    label: 'Stack',
    desc: 'bold sans, key words in red pills (Captions.ai Stack)',
    font: {family: 'Inter', weight: 700, sizePx: 54, case: 'none', trackingPx: -0.5, lineHeight: 1.3},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#E63312', onAccent: '#ffffff'},
    reveal: 'build',
    tiers: {1: {weight: 800, pill: true}, 2: {weight: 800, pill: true, scale: 1.15}},
  },
  lift: {
    ...base,
    id: 'lift',
    label: 'Lift',
    desc: 'white sans, key words in mint pills with dark text (Captions.ai Lift)',
    font: {family: 'Inter', weight: 600, sizePx: 52, case: 'none', trackingPx: -0.3, lineHeight: 1.3},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#7EE0B4', onAccent: '#1F3A2E'},
    reveal: 'build',
    tiers: {1: {weight: 700, pill: true}, 2: {weight: 800, pill: true, scale: 1.12}},
  },
  orbit: {
    ...base,
    id: 'orbit',
    label: 'Orbit',
    desc: 'serif phrase in a royal-blue pill, emphasis in italic (Captions.ai Orbit)',
    font: {family: 'Playfair Display', weight: 500, sizePx: 48, case: 'none', trackingPx: 0, lineHeight: 1.3},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.7)', accent: '#ffffff', container: '#2456C7'},
    shadow: '',
    container: 'pill',
    tiers: {1: {italic: true, color: 'text'}, 2: {italic: true, color: 'text', scale: 1.15}},
    layout: {maxWords: 5, maxCharsLine: 24},
  },
  impact: {
    ...base,
    id: 'impact',
    label: 'Impact',
    desc: 'condensed uppercase, 1–3 words, cyan with white emphasis, pop (Captions.ai Impact II)',
    font: {family: 'Bebas Neue', weight: 400, sizePx: 96, case: 'upper', trackingPx: 2, lineHeight: 1},
    colors: {text: '#38BDF8', dim: 'rgba(56,189,248,0.5)', accent: '#ffffff'},
    shadow: HARD,
    pageIn: {type: 'pop', ms: 140},
    pageOut: {ms: 80},
    tiers: {1: {scale: 1.25}, 2: {scale: 1.6}},
    layout: {maxWords: 3, maxCharsLine: 16},
  },
};

export type PresetId = string;
export const DEFAULT_STYLE = 'palabra';
export const presetOf = (id?: string): Preset => PRESETS[id ?? ''] ?? PRESETS[DEFAULT_STYLE];
