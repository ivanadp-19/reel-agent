// Brand kit: a client's palette, fonts and logo. Stored on the project
// (`brand`), reusable across projects as public/brands/<slug>.json. Caption
// presets, graphics templates and layout canvases read it through
// BrandContext, so one kit restyles everything without touching the presets.

import {createContext, useContext} from 'react';
import {z} from 'zod';
import {FONT_FAMILIES, type FontFamily} from './fonts.ts';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex color like #FFB020');
const family = z.enum(FONT_FAMILIES as [FontFamily, ...FontFamily[]]);

export const brandSchema = z.object({
  name: z.string().trim().max(40).optional(),
  colors: z.object({
    accent: hex.describe('highlight color: caption emphasis, accent lines, accent canvases'),
    dark: hex.optional().describe('dark canvas / card background (default #0b0b0d)'),
    light: hex.optional().describe('light canvas / card background (default #f3f3f0)'),
  }),
  fonts: z.object({
    display: family.optional().describe('headline font (graphics templates)'),
    body: family.optional().describe('caption font (overrides the preset family)'),
  }).default({}),
  logo: z.string().optional().describe('image under public/, e.g. brands/acme.png'),
});
export type Brand = {name?: string; colors: {accent: string; dark?: string; light?: string}; fonts: {display?: FontFamily; body?: FontFamily}; logo?: string};

// what the renderer uses: every value resolved, `branded` = a kit is active
export type Kit = {branded: boolean; accent: string; dark: string; light: string; display?: FontFamily; body?: FontFamily; logo?: string};

export const DEFAULT_ACCENT = '#FFB020';
export function resolveBrand(brand: Brand | null | undefined, accentColor?: string): Kit {
  return {
    branded: !!brand,
    accent: brand?.colors.accent ?? accentColor ?? DEFAULT_ACCENT,
    dark: brand?.colors.dark ?? '#0b0b0d',
    light: brand?.colors.light ?? '#f3f3f0',
    display: brand?.fonts?.display,
    body: brand?.fonts?.body,
    logo: brand?.logo,
  };
}

// relative luminance (WCAG) of a #rrggbb color; null when it is not one
export function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  const lin = (h: string) => { const c = parseInt(h, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}
// readable text color on a background: near-black on light colors, white on dark
export function ink(bg: string): string {
  const L = luminance(bg);
  return L != null && L > 0.4 ? '#111111' : '#ffffff';
}
// the accent as TEXT over footage: a dark brand color (navy, deep blue) is mixed
// toward white just enough to read (luminance ≥ 0.3); fills keep the exact color
export function legible(accent: string): string {
  const L = luminance(accent);
  if (L == null || L >= 0.3) return accent;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.replace('#', '').slice(i - 1, i + 1), 16));
  for (let t = 0.1; t <= 0.8; t += 0.1) {
    const mix = [r, g, b].map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')).join('');
    if ((luminance(`#${mix}`) ?? 0) >= 0.3) return `#${mix}`;
  }
  return '#ffffff';
}

export const BrandContext = createContext<Kit>(resolveBrand(null));
export const useBrand = () => useContext(BrandContext);
