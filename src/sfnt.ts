// A TrueType / OpenType font file read as bytes (no DOM, no fs): its full name (name ID 4) and the
// advance width (em) of a text — cmap format 4, hmtx, and the 'kern' table's format-0 pairs (what
// Chrome applies to a face without GPOS). Enough for caption words. Shared by the renderer
// (src/projectFont.ts), validate's font check (mcp/checks.mjs, the editor), the render judge and the
// golden check (scripts/golden.mjs).
export function readFont(bytes: Uint8Array): {fullName: string | null; advance: (text: string) => number} {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => v.getUint16(o), i16 = (o: number) => v.getInt16(o), u32 = (o: number) => v.getUint32(o);
  const t: Record<string, number> = {};
  for (let i = 0; i < u16(4); i++) t[String.fromCharCode(...bytes.subarray(12 + 16 * i, 16 + 16 * i))] = u32(20 + 16 * i);
  if (t.head == null || t.hhea == null || t.hmtx == null || t.cmap == null) throw new Error('not a TrueType / OpenType font');

  // name ID 4, a Windows (UTF-16BE) record first, else a Mac (Latin) one
  let fullName: string | null = null;
  if (t.name != null) {
    const store = t.name + u16(t.name + 4);
    for (let r = 0; r < u16(t.name + 2); r++) {
      const o = t.name + 6 + 12 * r;
      if (u16(o + 6) !== 4) continue;
      const raw = bytes.subarray(store + u16(o + 10), store + u16(o + 10) + u16(o + 8));
      const wide = u16(o) === 3 || u16(o) === 0;
      const s = wide ? String.fromCharCode(...Array.from({length: raw.length >> 1}, (_, k) => (raw[2 * k] << 8) | raw[2 * k + 1])) : String.fromCharCode(...raw);
      if (wide || fullName == null) fullName = s;
      if (wide) break;
    }
  }

  const upem = u16(t.head + 18), nh = u16(t.hhea + 34);
  let sub = 0;
  for (let i = 0; i < u16(t.cmap + 2) && !sub; i++) { const o = t.cmap + u32(t.cmap + 8 + 8 * i); if (u16(o) === 4) sub = o; }
  const seg = sub ? u16(sub + 6) / 2 : 0, ends = sub + 14, starts = ends + 2 * seg + 2, deltas = starts + 2 * seg, ranges = deltas + 2 * seg;
  const glyph = (c: number) => {
    for (let s = 0; s < seg; s++) {
      if (c > u16(ends + 2 * s)) continue;
      if (c < u16(starts + 2 * s)) return 0;
      const ro = u16(ranges + 2 * s);
      const g = ro ? u16(ranges + 2 * s + ro + 2 * (c - u16(starts + 2 * s))) : c;
      return g ? (g + u16(deltas + 2 * s)) & 0xffff : 0;
    }
    return 0;
  };
  const kern = new Map<number, number>();
  if (t.kern != null) {
    const apple = u16(t.kern) === 1; // Apple: 32-bit version and table count, 8-byte subtable header
    let o = t.kern + (apple ? 8 : 4);
    for (let n = apple ? u32(t.kern + 4) : u16(t.kern + 2); n > 0; n--) {
      const len = apple ? u32(o) : u16(o + 2), format = apple ? u16(o + 4) & 0xff : u16(o + 4) >> 8, head = apple ? 8 : 6;
      if (format === 0) for (let p = 0, np = u16(o + head); p < np; p++) { const q = o + head + 8 + 6 * p; kern.set(u16(q) * 65536 + u16(q + 2), i16(q + 4)); }
      o += len;
    }
  }
  const advance = (text: string) => {
    let units = 0, prev = -1;
    for (const ch of text) { const g = glyph(ch.codePointAt(0)!); units += u16(t.hmtx + 4 * Math.min(g, nh - 1)) + (kern.get(prev * 65536 + g) ?? 0); prev = g; }
    return units / upem;
  };
  return {fullName, advance};
}
