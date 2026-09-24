// Caption presets ("style packs"): everything about how captions LOOK and
// MOVE lives here as data. The pager reads `layout`, the renderer reads the
// rest. The agent only picks a preset id and per-word tiers; it never writes
// style or animation.
//
// palabra / caja / tracked come from the real-estate reference reels
// (research/style-references.md). The rest imitate Captions.ai AI Edit styles
// (research/captions-ai-styles.md) with OFL fonts and our own palettes. Sizes
// were measured on their 1080×1920 previews: phrase styles run 62–88 px with
// key words 1.5–1.9× bigger; a page of one or two words renders larger still.

import type {FontFamily} from './fonts.ts';
import type {ArriveKind, LeaveKind} from './motion.ts';

export type AnimIn = 'fade' | 'slideUp' | 'pop' | 'blur' | 'none';

// what a tier does to a word (combinable)
export type TierStyle = {
  scale?: number;
  weight?: number;
  italic?: boolean;
  font?: FontFamily; // switch family (script / serif / hand)
  color?: 'accent' | 'text'; // default accent
  fill?: 'gradient'; // metallic gradient (colors.gradient) instead of a flat color
  pill?: boolean; // solid accent background, rounded
  block?: boolean; // solid accent background, square-ish (marker highlight)
  bg?: string; // pill/block colors when not the accent
  fg?: string;
  underline?: boolean;
  glow?: boolean; // neon glow in the word's color
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
    gradient?: string; // CSS gradient for `fill: 'gradient'` tiers
  };
  shadow: string; // CSS text-shadow ('' = none)
  container: 'none' | 'pill' | 'bar' | 'glass';
  reveal: 'page' | 'build'; // build = words appear at their onset and stay
  upcoming: 'hidden' | 'dim'; // build only: words not yet spoken
  active: 'none' | 'color' | 'box-slide' | 'box-jump'; // the spoken word: color, or a karaoke box that slides to it (Focus, 80 ms) or jumps by fade (Lift, Stack)
  position: 'anchored' | 'float'; // anchored = face-aware topPct; float = alternate corners
  pageIn: {type: AnimIn; ms: number};
  pageOut: LeaveKind; // how a page leaves (src/motion.ts; cut = it stays until the next page)
  wordIn: ArriveKind; // build: how a plain word arrives at its onset (src/motion.ts)
  keyIn: ArriveKind; // how a tier word arrives (at its onset in build mode, with the page otherwise)
  holdMs: number; // a page stays this long after its last word (never past the next page)
  autoScale: boolean; // short pages render bigger (1 word ×1.5, 2 ×1.35, 3 ×1.18)
  focusPull: number; // px of blur on the footage while a tier-2 word is on screen (0 = off)
  opening: 'none' | 'zoomBlur' | 'blurIn'; // the reel's first ~200 ms: a radial zoom-blur landing (Prism, Stack, Impact) or a plain blur-in (Prime)
  heroPunch: number; // extra scale on the footage while a tier-2 word is up, 3–4 f in (Impact II: 0.12; 0 = off)
  glitchPulse: boolean; // a 250 ms blur + chromatic pulse on the footage at each tier-1 word (Impact II)
  tiers: {0?: TierStyle; 1: TierStyle; 2: TierStyle}; // 0 = plain words (rarely styled)
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
  pageOut: 'fade',
  wordIn: 'pop',
  keyIn: 'pop',
  holdMs: 700,
  autoScale: false,
  focusPull: 0,
  opening: 'none',
  heroPunch: 0,
  glitchPulse: false,
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

// short pages get bigger type (Captions.ai "auto scale"): one word alone on
// screen is a statement, not a subtitle
export const pageScale = (p: Preset, nWords: number) => (!p.autoScale ? 1 : nWords <= 1 ? 1.5 : nWords === 2 ? 1.35 : nWords === 3 ? 1.18 : 1);

export const PRESETS: Record<string, Preset> = {
  // ---- from the real-estate references ----
  palabra: {
    ...base,
    id: 'palabra',
    label: 'Palabra',
    desc: 'one word at a time, big, centered, no box (R1/R4)',
    font: {family: 'Montserrat', weight: 700, sizePx: 92, case: 'none', trackingPx: -1, lineHeight: 1.1},
    pageIn: {type: 'pop', ms: 160},
    holdMs: 250, // word-at-a-time pages should not linger
    tiers: {1: {weight: 800}, 2: {weight: 800, scale: 1.18}},
    layout: {maxWords: 1, maxCharsLine: 18},
  },
  caja: {
    ...base,
    id: 'caja',
    label: 'Caja',
    desc: 'short phrase in a dark rounded box, spoken word in white (R2)',
    font: {family: 'Inter', weight: 600, sizePx: 62, case: 'none', trackingPx: -0.5, lineHeight: 1.25},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.72)', container: 'rgba(0,0,0,0.72)'},
    shadow: '',
    container: 'pill',
    active: 'color',
    tiers: {1: {weight: 800}, 2: {weight: 800, scale: 1.12}},
    layout: {maxWords: 6, maxCharsLine: 24},
  },
  tracked: {
    ...base,
    id: 'tracked',
    label: 'Tracked',
    desc: 'small spaced caps, a phrase at a time, blur-in (R3)',
    font: {family: 'Montserrat', weight: 600, sizePx: 42, case: 'upper', trackingPx: 6, lineHeight: 1.35},
    pageIn: {type: 'blur', ms: 220},
    layout: {maxWords: 4, maxCharsLine: 22},
  },
  // ---- Captions.ai-like packs ----
  prism: {
    ...base,
    id: 'prism',
    label: 'Prism',
    desc: 'clean sans built word by word in floating positions; key words 1.5× in bold italic arrive as a ghost with a shine across a metallic gradient, and a tier-2 word blurs the footage behind it (Captions.ai Prism Pro)',
    font: {family: 'Inter', weight: 400, sizePx: 64, case: 'none', trackingPx: -0.5, lineHeight: 1.12},
    // a long metallic ramp (gold → silver → white → teal → steel); each key word shows a different stretch of it
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.4)', accent: '#9FD9DC', gradient: 'linear-gradient(100deg, #cfae7a 0%, #f1e6d0 14%, #ffffff 32%, #b3e3e5 52%, #6c9ea1 72%, #e6ebec 88%, #a9dfe1 100%)'},
    reveal: 'build',
    position: 'float',
    pageIn: {type: 'none', ms: 0}, // the page appears with its first word
    pageOut: 'cut',
    wordIn: 'fade',
    keyIn: 'ghost', // 40 % → 100 % while a shine crosses the gradient, no scale
    holdMs: 1200,
    autoScale: true,
    focusPull: 18,
    opening: 'zoomBlur',
    tiers: {1: {weight: 800, italic: true, scale: 1.45, fill: 'gradient'}, 2: {weight: 800, italic: true, scale: 1.9, fill: 'gradient'}},
    layout: {maxWords: 6, maxCharsLine: 24},
  },
  focus: {
    ...base,
    id: 'focus',
    label: 'Focus',
    desc: 'bold white sans, words dim until spoken, a royal-blue box slides word to word as they are said, tier 2 gets it in white (Captions.ai Focus)',
    font: {family: 'Inter', weight: 700, sizePx: 68, case: 'none', trackingPx: -0.5, lineHeight: 1.25},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#3B5BFF', onAccent: '#ffffff'},
    reveal: 'build',
    upcoming: 'dim',
    pageIn: {type: 'none', ms: 0},
    pageOut: 'cut',
    active: 'box-slide', // one blue box travels word to word; a tier-2 word gets it in white with black text
    wordIn: 'cut', // the 1-frame grey comes from `upcoming: dim`
    keyIn: 'cut',
    tiers: {1: {weight: 700}, 2: {weight: 800, bg: '#ffffff', fg: '#111111', scale: 1.12}},
    layout: {maxWords: 5, maxCharsLine: 20},
  },
  stack: {
    ...base,
    id: 'stack',
    label: 'Stack',
    desc: 'bold rounded sans, words dim until spoken, a red pill jumps to each word as it is said; key words 1.5× bigger (Captions.ai Stack)',
    font: {family: 'Poppins', weight: 700, sizePx: 62, case: 'none', trackingPx: -0.5, lineHeight: 1.15},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#E63312', onAccent: '#ffffff'},
    reveal: 'build',
    upcoming: 'dim',
    pageIn: {type: 'none', ms: 0},
    pageOut: 'cut',
    opening: 'zoomBlur',
    active: 'box-jump', // the red pill jumps to each spoken word
    wordIn: 'fade',
    keyIn: 'pop',
    tiers: {1: {weight: 800, scale: 1.5, color: 'text'}, 2: {weight: 800, scale: 1.6, color: 'text'}},
    layout: {maxWords: 6, maxCharsLine: 22},
  },
  lift: {
    ...base,
    id: 'lift',
    label: 'Lift',
    desc: 'large medium-weight sans, words dim until spoken, a mint pill with dark text jumps to each word as it is said (Captions.ai Lift)',
    font: {family: 'Inter', weight: 500, sizePx: 84, case: 'none', trackingPx: -1, lineHeight: 1.15},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#6FD3A5', onAccent: '#163B2E'},
    reveal: 'build',
    upcoming: 'dim',
    pageIn: {type: 'none', ms: 0},
    pageOut: 'fade',
    active: 'box-jump', // the mint box fades from word to word and switches off ~0.3 s after the last one
    wordIn: 'cut',
    keyIn: 'cut',
    tiers: {1: {weight: 500}, 2: {weight: 600, scale: 1.12}},
    layout: {maxWords: 5, maxCharsLine: 18},
  },
  evo: {
    ...base,
    id: 'evo',
    label: 'Evo',
    desc: 'bold italic sans in a frosted-glass pill, 1–3 words per page floating around the frame, words dim until spoken (Captions.ai Evo)',
    font: {family: 'Inter', weight: 700, sizePx: 78, case: 'none', trackingPx: -1, lineHeight: 1.15, italic: true},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#ffffff', container: 'rgba(255,255,255,0.16)'},
    shadow: '0 2px 10px rgba(0,0,0,0.45)',
    container: 'glass',
    reveal: 'build',
    upcoming: 'dim',
    position: 'float',
    pageIn: {type: 'blur', ms: 70},
    pageOut: 'cut',
    wordIn: 'blur',
    keyIn: 'blur',
    autoScale: true,
    tiers: {1: {weight: 800, scale: 1.15, color: 'text'}, 2: {weight: 800, scale: 1.35, color: 'text'}},
    layout: {maxWords: 3, maxCharsLine: 16},
  },
  prime: {
    ...base,
    id: 'prime',
    label: 'Prime',
    desc: 'extra-bold white sans, 1–3 words per page, key words switch to a glowing cyan brush script (Captions.ai Prime)',
    font: {family: 'Montserrat', weight: 800, sizePx: 74, case: 'none', trackingPx: -1, lineHeight: 1.15},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.5)', accent: '#7CEFF5'},
    shadow: '0 3px 0 rgba(0,0,0,0.25), 0 6px 24px rgba(0,0,0,0.5)',
    pageIn: {type: 'fade', ms: 80},
    pageOut: 'cut',
    keyIn: 'fade',
    opening: 'blurIn',
    tiers: {1: {font: 'Kaushan Script', weight: 400, scale: 1.7, glow: true}, 2: {font: 'Kaushan Script', weight: 400, scale: 2.1, glow: true}},
    layout: {maxWords: 3, maxCharsLine: 16},
  },
  orbit: {
    ...base,
    id: 'orbit',
    label: 'Orbit',
    desc: 'serif phrase in a royal-blue pill, emphasis in italic (Captions.ai Orbit)',
    font: {family: 'Playfair Display', weight: 400, sizePx: 52, case: 'none', trackingPx: 0, lineHeight: 1.3},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.7)', accent: '#ffffff', container: '#2456C7'},
    shadow: '',
    container: 'pill',
    pageIn: {type: 'blur', ms: 125},
    pageOut: 'cut',
    keyIn: 'cut',
    tiers: {1: {italic: true, weight: 500, color: 'text'}, 2: {italic: true, weight: 500, color: 'text', scale: 1.15}},
    layout: {maxWords: 4, maxCharsLine: 22},
  },
  impact: {
    ...base,
    id: 'impact',
    label: 'Impact',
    desc: 'condensed uppercase, 1–3 words, glowing cyan with white emphasis, pop (Captions.ai Impact II)',
    font: {family: 'Bebas Neue', weight: 400, sizePx: 88, case: 'upper', trackingPx: 2, lineHeight: 1},
    colors: {text: '#38C8F4', dim: 'rgba(56,200,244,0.5)', accent: '#ffffff'},
    shadow: `0 0 22px rgba(56,200,244,0.55), ${HARD}`,
    pageIn: {type: 'blur', ms: 100},
    pageOut: 'cut',
    keyIn: 'blur',
    opening: 'zoomBlur',
    heroPunch: 0.12,
    glitchPulse: true,
    tiers: {1: {scale: 1.25}, 2: {scale: 1.6}},
    layout: {maxWords: 3, maxCharsLine: 16},
  },
};

export type PresetId = string;
export const DEFAULT_STYLE = 'palabra';
export const presetOf = (id?: string): Preset => PRESETS[id ?? ''] ?? PRESETS[DEFAULT_STYLE];
