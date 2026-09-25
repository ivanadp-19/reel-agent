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
import type {CustomFont} from './projectFont.ts';
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
  font: {family: FontFamily | (string & {}); custom?: CustomFont; weight: number; sizePx: number; case: 'upper' | 'none'; trackingPx: number; wordGapEm?: number; lineHeight: number; italic?: boolean; fauxStrokePx?: number}; // fauxStrokePx: same-color outline to thicken glyphs (paint-order: stroke)
  colors: {
    text: string;
    dim: string; // not-yet-spoken (karaoke) or not-active words
    accent?: string; // pack palette; the project accent is used when absent
    onAccent?: string; // text color on pill/block backgrounds
    container?: string; // page container background
    gradient?: string; // CSS gradient for `fill: 'gradient'` tiers
  };
  shadow: string; // CSS text-shadow ('' = none)
  container: 'none' | 'pill' | 'bar' | 'glass' | 'comic'; // comic = white pill, black border, hard offset shadow (Pop)
  reveal: 'page' | 'build'; // build = words appear at their onset and stay
  upcoming: 'hidden' | 'dim' | 'collapse'; // build only. hidden: space reserved; dim: karaoke; collapse: no space — the block recenters as words join
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
  titles: {reveal: import('./graphicTemplates.ts').Reveal; out: import('./graphicTemplates.ts').Out}; // how the pack's titles arrive and leave when a graphic sets neither
  heroPunch: number; // extra scale on the footage while a tier-2 word is up, 3–4 f in (Impact II: 0.12; 0 = off)
  glitchPulse: boolean; // a 250 ms blur + chromatic pulse on the footage at each tier-1 word (Impact II)
  tiers: {0?: TierStyle; 1: TierStyle; 2: TierStyle}; // 0 = plain words (rarely styled)
  layout: {maxWords: number; maxCharsLine: number; unbreakable?: boolean}; // unbreakable: never split tier spans / name+number pairs across pages (César 10:35, 'Montealbán 326' is one name)
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
  titles: {reveal: 'auto', out: 'auto'},
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
  // César's own WithSubtitles look (measured on his Morantes reels):
  // Helvetica Bold caps, white, no box, words pop in one by one as they are
  // spoken, key words flat yellow #FFE500. The font is a per-project FILE
  // (public/fonts/Helvetica-Bold.ttf — currently a Liberation Sans Bold
  // stand-in until César's file lands; src/projectFont.ts).
  vibem: {
    ...base,
    id: 'vibem',
    label: 'VIBEM (César)',
    desc: "César published-reel captions (frames 9:20): Helvetica-Bold caps, whole phrase on 2 balanced lines, sized to span most of the frame, tight tracking, white, soft diffuse gray shadow (no offset), no stroke, keyword words #FFE500 at the SAME size. Entry = his CC slide up; hard-cut exit",
    font: {family: 'Helvetica', custom: {family: 'HelveticaCesar', file: 'fonts/Helvetica-Bold.ttf', weight: 700}, weight: 700, sizePx: 100, case: 'upper', trackingPx: -2, lineHeight: 1.05, wordGapEm: 0.22},
    colors: {text: 'rgba(255,255,255,0.85)', dim: 'rgba(255,255,255,0.55)', accent: '#FFE500'}, // César 9:37: letters at 85% opacity (rgba so the shadow keeps full strength)
    // his Premiere caption shadow (9:21 screenshot): opacity 75, angle 135, distance 0, size 7.8, blur 40
    // -> centered soft halo: tight 8px core at 0.75 + wide 40px diffusion; NO offset (he rejected the hard look)
    shadow: '0 0 8px rgba(0,0,0,0.75), 0 0 40px rgba(0,0,0,0.55)',
    reveal: 'build',
    upcoming: 'collapse', // César 10:35 (frame sequences from his 9 reels): words DO build in, but the block
    // RECENTERS live as it grows ('TODO A' -> 'TODO A LA MANO', always centered) — unspoken words take no space
    pageIn: {type: 'none', ms: 0},
    pageOut: 'cut',
    wordIn: 'ccSlideUp',
    keyIn: 'highlightRise', // classifier highlights (keywords/questions/CTAs): per-char rise + white->yellow sweep (César 9:27)
    holdMs: 250, // César 9:47: NO captions during silence — page ends ~250ms after its last word; never hold through pauses
    tiers: {1: {weight: 700, color: 'accent', scale: 1.15}, 2: {weight: 700, color: 'accent', scale: 1.15}}, // highlights: solid #FFE500, slightly bigger, dynamic entry
    layout: {maxWords: 6, maxCharsLine: 24, unbreakable: true}, // his reels: phrases of 2-5 words, one line when it fits, 2 balanced lines when not; 3 lines / smaller size beat splitting a name (César 10:35)
    titles: {reveal: 'riseChars', out: 'cut'}, // César 9:51: Apple-style title default = per-char rise (his pick 1); pick 2 = 'trackingSnap' per graphic; clean-blue graphics keep his .aep bounceCharsBlue
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
    titles: {reveal: 'blur', out: 'fade'},
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
    titles: {reveal: 'band', out: 'band'},
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
    titles: {reveal: 'drop', out: 'fade'},
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
    titles: {reveal: 'wipe', out: 'slideUp'},
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
    titles: {reveal: 'blur', out: 'fade'},
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
    titles: {reveal: 'letters', out: 'fade'},
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
    titles: {reveal: 'slideDown', out: 'slideUp'},
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
    titles: {reveal: 'blur', out: 'cut'},
    heroPunch: 0.12,
    glitchPulse: true,
    tiers: {1: {scale: 1.25}, 2: {scale: 1.6}},
    layout: {maxWords: 3, maxCharsLine: 16},
  },
};

// ---- the rest of the Captions.ai catalog (research/captions-ai-motion.md) ----
Object.assign(PRESETS, {
  paper: {
    ...base, id: 'paper', label: 'Paper',
    desc: 'bold rounded sans in a white paper box, words grey until spoken, pages crossfade (Captions.ai Paper II)',
    font: {family: 'Poppins', weight: 700, sizePx: 56, case: 'none', trackingPx: -0.5, lineHeight: 1.2},
    colors: {text: '#1f1f1f', dim: '#9a9a9a', accent: '#2F6BFF', container: '#ffffff'},
    shadow: '', container: 'pill', reveal: 'build', upcoming: 'dim', wordIn: 'cut', keyIn: 'cut', pageIn: {type: 'fade', ms: 80}, pageOut: 'fade',
    titles: {reveal: 'typewriter', out: 'fade'},
    tiers: {1: {weight: 800, color: 'text'}, 2: {weight: 800, scale: 1.1, color: 'text'}}, layout: {maxWords: 5, maxCharsLine: 22},
  },
  elevate: {
    ...base, id: 'elevate', label: 'Elevate',
    desc: 'editorial serif phrase, key words in italic of the same size, pages cut in and out (Captions.ai Elevate)',
    font: {family: 'Playfair Display', weight: 400, sizePx: 58, case: 'none', trackingPx: 0, lineHeight: 1.2},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.6)', accent: '#E8DCC8'},
    pageIn: {type: 'fade', ms: 60}, pageOut: 'cut', keyIn: 'cut',
    titles: {reveal: 'letters', out: 'blur'},
    tiers: {1: {italic: true, color: 'text'}, 2: {italic: true, color: 'text'}}, layout: {maxWords: 5, maxCharsLine: 24},
  },
  sketch: {
    ...base, id: 'sketch', label: 'Sketch',
    desc: 'handwritten marker phrase built word by word, two lines (Captions.ai Sketch)',
    font: {family: 'Caveat', weight: 700, sizePx: 66, case: 'none', trackingPx: 0, lineHeight: 1.1},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.5)', accent: '#E9DCC5'},
    reveal: 'build', wordIn: 'cut', keyIn: 'cut', pageIn: {type: 'none', ms: 0}, pageOut: 'cut',
    titles: {reveal: 'blur', out: 'fade'},
    tiers: {1: {weight: 700, color: 'text'}, 2: {weight: 700, scale: 1.2, color: 'text'}}, layout: {maxWords: 4, maxCharsLine: 22},
  },
  lens: {
    ...base, id: 'lens', label: 'Lens',
    desc: 'monospace capitals in a black label bar, built word by word — a camera viewfinder (Captions.ai Lens)',
    font: {family: 'Courier Prime', weight: 700, sizePx: 44, case: 'upper', trackingPx: 1, lineHeight: 1.3},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.5)', accent: '#F2A33A', container: '#0d0d0d'},
    shadow: '', container: 'bar', reveal: 'build', wordIn: 'cut', keyIn: 'cut', pageIn: {type: 'none', ms: 0}, pageOut: 'cut',
    titles: {reveal: 'typewriter', out: 'letters'},
    tiers: {1: {weight: 700, color: 'accent'}, 2: {weight: 700, color: 'accent', scale: 1.1}}, layout: {maxWords: 3, maxCharsLine: 18},
  },
  vista: {
    ...base, id: 'vista', label: 'Vista',
    desc: 'white serif with a shadow, built word by word with a fade, words grey until spoken (Captions.ai Vista)',
    font: {family: 'Playfair Display', weight: 400, sizePx: 60, case: 'none', trackingPx: 0, lineHeight: 1.2},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.45)', accent: '#BFC3C7'},
    reveal: 'build', upcoming: 'dim', wordIn: 'fade', keyIn: 'fade', pageIn: {type: 'none', ms: 0}, pageOut: 'cut',
    titles: {reveal: 'slideDown', out: 'fade'},
    tiers: {1: {weight: 700, color: 'text'}, 2: {weight: 700, color: 'text', scale: 1.1}}, layout: {maxWords: 5, maxCharsLine: 22},
  },
  pop: {
    ...base, id: 'pop', label: 'Pop',
    desc: 'italic sans in a white comic pill with a black border and hard shadow, key words bold (Captions.ai Pop)',
    font: {family: 'Poppins', weight: 600, sizePx: 50, case: 'none', trackingPx: 0, lineHeight: 1.2, italic: true},
    colors: {text: '#111111', dim: '#777777', accent: '#E9A6D9', container: '#ffffff'},
    shadow: '', container: 'comic', pageIn: {type: 'none', ms: 0}, pageOut: 'cut', keyIn: 'cut',
    titles: {reveal: 'fade', out: 'fade'},
    tiers: {1: {weight: 800, color: 'text'}, 2: {weight: 800, color: 'text', scale: 1.1}}, layout: {maxWords: 5, maxCharsLine: 22},
  },
  y2k: {
    ...base, id: 'y2k', label: 'Y2K',
    desc: 'yellow bold sans built word by word with a 2-frame fade, no key-word treatment (Captions.ai Y2K)',
    font: {family: 'Inter', weight: 700, sizePx: 52, case: 'none', trackingPx: 0, lineHeight: 1.2},
    colors: {text: '#F0FF00', dim: 'rgba(240,255,0,0.5)', accent: '#EEFF3A'},
    shadow: '0 2px 8px rgba(0,0,0,0.45)', reveal: 'build', wordIn: 'fade', keyIn: 'fade', pageIn: {type: 'none', ms: 0}, pageOut: 'cut',
    titles: {reveal: 'fade', out: 'fade'},
    tiers: {1: {weight: 700, color: 'text'}, 2: {weight: 700, color: 'text'}}, layout: {maxWords: 5, maxCharsLine: 24},
  },
  form: {
    ...base, id: 'form', label: 'Form',
    desc: 'light sans pages that blur in whole, key words in bold italic 1.35× (Captions.ai Form)',
    font: {family: 'Inter', weight: 300, sizePx: 48, case: 'none', trackingPx: 0, lineHeight: 1.25},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.5)', accent: '#D9502E'},
    pageIn: {type: 'blur', ms: 125}, pageOut: 'cut', keyIn: 'cut',
    titles: {reveal: 'fade', out: 'letters'},
    tiers: {1: {weight: 800, italic: true, scale: 1.35, color: 'text'}, 2: {weight: 800, italic: true, scale: 1.5, color: 'text'}}, layout: {maxWords: 5, maxCharsLine: 24},
  },
  bloom: {
    ...base, id: 'bloom', label: 'Bloom',
    desc: 'thin sans built word by word with a blur-in, key words 1.5× and heavier (Captions.ai Bloom)',
    font: {family: 'Inter', weight: 300, sizePx: 40, case: 'none', trackingPx: 0, lineHeight: 1.3},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.5)', accent: '#C8785A'},
    reveal: 'build', wordIn: 'blur', keyIn: 'blur', pageIn: {type: 'none', ms: 0}, pageOut: 'cut', autoScale: true,
    titles: {reveal: 'blur', out: 'fade'},
    tiers: {1: {weight: 600, scale: 1.5, color: 'text'}, 2: {weight: 600, scale: 1.7, color: 'text'}}, layout: {maxWords: 5, maxCharsLine: 24},
  },
  chalk: {
    ...base, id: 'chalk', label: 'Chalk',
    desc: 'handwritten white words that fade in, key words in yellow on a black tag (Captions.ai Chalk)',
    font: {family: 'Caveat', weight: 700, sizePx: 60, case: 'none', trackingPx: 0, lineHeight: 1.15},
    colors: {text: '#ffffff', dim: 'rgba(255,255,255,0.5)', accent: '#FFE600'},
    reveal: 'build', wordIn: 'fade', keyIn: 'fade', pageIn: {type: 'none', ms: 0}, pageOut: 'fade',
    titles: {reveal: 'letters', out: 'letters'},
    tiers: {1: {block: true, bg: '#1b1b1b', fg: '#FFE600'}, 2: {block: true, bg: '#1b1b1b', fg: '#FFE600', scale: 1.2}}, layout: {maxWords: 4, maxCharsLine: 20},
  },
  linen: {
    ...base, id: 'linen', label: 'Linen',
    desc: 'small serif italic in a peach box, whole pages that crossfade, no key words (Captions.ai Linen)',
    font: {family: 'Playfair Display', weight: 400, sizePx: 46, case: 'none', trackingPx: 0, lineHeight: 1.25, italic: true},
    colors: {text: '#4a2e2a', dim: '#a08a86', accent: '#6E3B4E', container: '#F1D9C6'},
    shadow: '', container: 'pill', pageIn: {type: 'fade', ms: 125}, pageOut: 'fade', keyIn: 'cut',
    titles: {reveal: 'fade', out: 'fade'},
    tiers: {1: {color: 'text'}, 2: {color: 'text'}}, layout: {maxWords: 5, maxCharsLine: 24},
  },
  align: {
    ...base, id: 'align', label: 'Align',
    desc: 'monospace capitals, black on a white box, one page per short phrase with a one-frame grey (Captions.ai Align)',
    font: {family: 'Courier Prime', weight: 700, sizePx: 40, case: 'upper', trackingPx: 1, lineHeight: 1.3},
    colors: {text: '#111111', dim: '#8a8a8a', accent: '#111111', container: '#ffffff'},
    shadow: '', container: 'bar', pageIn: {type: 'fade', ms: 40}, pageOut: 'cut', keyIn: 'cut',
    titles: {reveal: 'tracking', out: 'cut'},
    tiers: {1: {weight: 700, color: 'text'}, 2: {weight: 700, color: 'text'}}, layout: {maxWords: 4, maxCharsLine: 20},
  },
} satisfies Record<string, Preset>);

export type PresetId = string;
export const DEFAULT_STYLE = 'palabra';
export const presetOf = (id?: string): Preset => PRESETS[id ?? ''] ?? PRESETS[DEFAULT_STYLE];
