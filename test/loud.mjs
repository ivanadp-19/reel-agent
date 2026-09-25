// Loudness-track fixtures shared by the speech and cuts tests: 50 windows/s at
// -60 dBFS (room tone); paint(t, a, b, db) sets seconds a..b to a level.
export const track = (sec) => ({fps: 50, db: new Array(Math.round(sec * 50)).fill(-60)});
export const paint = (t, a, b, db) => { for (let i = Math.round(a * 50); i < Math.round(b * 50); i++) t.db[i] = db; };
