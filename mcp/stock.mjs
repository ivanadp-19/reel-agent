// Stock B-roll from Pexels (portrait), used by the MCP tool search_stock and
// the backend's /api/stock for the editor. Rows: {src, duration?, size?, alt?, page}.
export async function searchStock(query, kind = 'video', count = 5, key) {
  if (!key) throw new Error('PEXELS_API_KEY missing in .env');
  const url = kind === 'video'
    ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`
    : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
  const d = await fetch(url, {headers: {Authorization: key}}).then((r) => r.json());
  if (kind === 'video') {
    return (d.videos ?? []).map((v) => {
      const files = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && f.height);
      const tall = files.filter((f) => f.height >= 1920).sort((a, b) => a.height - b.height);
      const pick = tall[0] ?? files.sort((a, b) => b.height - a.height)[0];
      return pick ? {src: pick.link, duration: v.duration, size: `${pick.width}x${pick.height}`, page: v.url, thumb: v.image} : null;
    }).filter(Boolean);
  }
  return (d.photos ?? []).map((ph) => ({src: ph.src?.large2x || ph.src?.large, alt: ph.alt, page: ph.url, thumb: ph.src?.medium})).filter((x) => x.src);
}
