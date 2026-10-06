// The README's lockup — the Winter mark and "winter" — set exactly as the video's end card sets it, as
// outlines, so it renders the same everywhere (GitHub shows SVGs as images: no web fonts).
//   node lockup.cjs   → out/lockup-on-light.svg, out/lockup-on-dark.svg
// Needs opentype.js (`npm i opentype.js`) and Inter Display at /usr/share/fonts/opentype/inter.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

// The end card's numbers (scene.js OUTRO, scene.html #outroWord): a 200 px box for the mark, a 26 px gap,
// "winter" in 120 px Inter Display Regular at -2.5 px tracking, its x-height centred on the mark's ink.
const BOX = 200, GAP = 26, SIZE = 120, TRACK = -2.5;
const INKS = { 'lockup-on-light.svg': '#0b0b0f', 'lockup-on-dark.svg': '#ffffff' };

const svg = fs.readFileSync(path.join(__dirname, '../../apple/Winter/Assets.xcassets/BrandMark.imageset/yanling-scale-burst-v2.svg'), 'utf8');
const polys = [...svg.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
const pts = polys.flatMap(d => d.replace(/[MZ]/g, ' ').trim().split(/\s+/).map(Number)).reduce((a, v, i) => (i % 2 ? a[a.length - 1].push(v) : a.push([v]), a), []);
const s = BOX / 240;   // the mark's viewBox is 240 wide
const mark = {
  x0: Math.min(...pts.map(p => p[0])) * s, x1: Math.max(...pts.map(p => p[0])) * s,
  y0: Math.min(...pts.map(p => p[1])) * s, y1: Math.max(...pts.map(p => p[1])) * s,
};

const font = opentype.loadSync('/usr/share/fonts/opentype/inter/InterDisplay-Regular.otf');
const k = SIZE / font.unitsPerEm;
const xHeight = font.tables.os2.sxHeight * k;
const baseline = (mark.y0 + mark.y1) / 2 + xHeight / 2;
const word = new opentype.Path();
let x = BOX + GAP, prev = null;
for (const ch of 'winter') {
  const g = font.charToGlyph(ch);
  if (prev) x += font.getKerningValue(prev, g) * k;
  word.extend(g.getPath(x, baseline, SIZE));
  x += g.advanceWidth * k + TRACK;
  prev = g;
}
const wb = word.getBoundingBox();
const pad = 2;
const vb = { x: Math.floor(Math.min(mark.x0, wb.x1) - pad), y: Math.floor(Math.min(mark.y0, wb.y1) - pad) };
vb.w = Math.ceil(Math.max(mark.x1, wb.x2) + pad) - vb.x;
vb.h = Math.ceil(Math.max(mark.y1, wb.y2) + pad) - vb.y;

fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
for (const [file, ink] of Object.entries(INKS)) {
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${vb.w}" height="${vb.h}" role="img" aria-label="Winter">
<title>Winter</title>
<g fill="${ink}"><g transform="scale(${s.toFixed(6)})">${polys.map(d => `<path d="${d}"/>`).join('')}</g><path d="${word.toPathData(2)}"/></g>
</svg>
`;
  fs.writeFileSync(path.join(__dirname, 'out', file), out);
  console.log('wrote', file, `${vb.w}×${vb.h}`, `${out.length} bytes`);
}
