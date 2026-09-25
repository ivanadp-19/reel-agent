// Voice cleanup options for the final render (scripts/qc.mjs applies `af`
// before loudness normalization; drafts are untouched). Data only, so the
// editor and the MCP tool can list them without importing ffmpeg code.
export const CLEAN = {
  off: {desc: 'nothing', af: ''},
  light: {desc: 'low cut at 80 Hz + gentle spectral denoise (room hiss, hum)', af: 'highpass=f=80,afftdn=nf=-25:nr=10:nt=w'},
  strong: {desc: 'low cut at 100 Hz + heavier denoise + de-esser', af: 'highpass=f=100,afftdn=nf=-30:nr=18:nt=w,deesser=i=0.35'},
} as const;
export type CleanId = keyof typeof CLEAN;
export type AudioOptions = {clean?: CleanId | string; sfx?: boolean} | null;
