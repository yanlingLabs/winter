'use strict';
// A frame-stepped recreation of Winter's Dispatch pill (apple/Winter/Sources/DispatchPill) — the
// compact/typing/working pill, the child-session row above it, and the pill-themed session windows
// stacked on it. Geometry, springs, colours and the plume's physics are ported from the Swift source;
// `renderFrame(n)` advances a fixed 60 Hz simulation so every captured frame is deterministic.

const FPS = 60, DT = 1 / FPS;
const DURATION = 36;
const TOTAL_FRAMES = Math.round(DURATION * FPS);
const SW = 1536, SH = 864;            // the virtual screen, in points
const BASE = 1.25;                    // points → video pixels at zoom 1
const VISIBLE = { minX: 0, minY: 4, maxX: 1536, maxY: 839 };   // Dock hidden, 25 pt menu bar (y-up)
const M = {                           // DispatchPillMetrics
  compactWidth: 316, expandedWidth: 560, pillHeight: 44, maxExpandedHeight: 240, composerVerticalPadding: 18,
  leadingPadding: 18, trailingPadding: 6, sendCircleSize: 32, accessoryButtonSize: 28, accessoryApproachMargin: 14,
  rowSpacing: 6, previewVerticalInset: 12, previewLineGap: 4, dockGap: 28, stackGap: 8, childPillGap: 6,
  minChildPillWidth: 72, maxMorphBlur: 8, morphBlurFalloff: 12, maxCornerRadius: 22,
};
const PILL_BOTTOM = SH - VISIBLE.minY - M.dockGap;   // y-down
const LINE = 17;                                      // composer line height
const EMITTER_INSET = M.trailingPadding + M.sendCircleSize / 2;

// ---------------------------------------------------------------- math
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeOut = t => 1 - (1 - t) * (1 - t);
const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
const ramp = (t, t0, dur, ease = easeInOut) => ease(clamp((t - t0) / dur, 0, 1));

/** A value eased between targets over a duration — SwiftUI's timed curves. */
class Anim {
  constructor(v) { this.from = v; this.to = v; this.t0 = 0; this.dur = 0; this.ease = easeInOut; }
  set(target, t, dur, ease = easeInOut) {
    if (target === this.to) return;
    this.from = this.value(t); this.to = target; this.t0 = t; this.dur = dur; this.ease = ease;
  }
  snap(v) { this.from = v; this.to = v; this.dur = 0; }
  value(t) {
    if (this.dur <= 0) return this.to;
    return lerp(this.from, this.to, this.ease(clamp((t - this.t0) / this.dur, 0, 1)));
  }
}

/** SwiftUI `.spring(response:dampingFraction:)`, integrated in substeps. */
class Spring {
  constructor(x, response, damping) {
    this.x = x; this.v = 0; this.target = x;
    this.k = Math.pow(2 * Math.PI / response, 2); this.c = 4 * Math.PI * damping / response;
  }
  step(dt) {
    const h = dt / 6;
    for (let i = 0; i < 6; i++) { const a = this.k * (this.target - this.x) - this.c * this.v; this.v += a * h; this.x += this.v * h; }
  }
  settled() { return Math.abs(this.target - this.x) < 0.002 && Math.abs(this.v) < 0.02; }
}

// ---------------------------------------------------------------- SF Symbol stand-ins (24-unit boxes)
const C = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const ICONS = {
  'stop.fill': [['f', 'M8.4 6.2h7.2a2.2 2.2 0 0 1 2.2 2.2v7.2a2.2 2.2 0 0 1-2.2 2.2H8.4a2.2 2.2 0 0 1-2.2-2.2V8.4a2.2 2.2 0 0 1 2.2-2.2z']],
  'arrow.up': [['s', 'M12 19.2V5.2M5.9 11.2 12 5.1l6.1 6.1', 2.9]],
  'mic.fill': [['f', 'M12 2.4a3.4 3.4 0 0 1 3.4 3.4v5.5a3.4 3.4 0 0 1-6.8 0V5.8A3.4 3.4 0 0 1 12 2.4z'], ['s', 'M6 11.2a6 6 0 0 0 12 0M12 17.3v3.5', 2.2]],
  'ellipsis': [['f', C(5.6, 12, 1.9) + C(12, 12, 1.9) + C(18.4, 12, 1.9)]],
  'expand': [['s', 'M10.2 10.2 4.6 4.6M4.6 9.6v-5h5M13.8 13.8l5.6 5.6M19.4 14.4v5h-5', 2.3]],
  'paperplane.fill': [['f', 'M3.3 10.7 19.8 3.7c.8-.3 1.5.4 1.2 1.2l-7 16.4c-.3.8-1.5.7-1.7-.1l-1.8-6.8-6.9-1.9c-.8-.2-.9-1.4-.1-1.8z']],
  'person.2.fill': [['f', C(8.8, 7.6, 3.5) + C(16.6, 8.6, 2.8)], ['f', 'M2.6 19.1c.4-3.7 3-5.8 6.2-5.8s5.8 2.1 6.2 5.8c.1.6-.4 1.1-1 1.1H3.6c-.6 0-1.1-.5-1-1.1z'], ['f', 'M16.4 13.1c2.7 0 4.7 1.7 5.1 4.6.1.5-.3 1-.9 1h-3.4c-.2-2.1-1-3.8-2.4-5.1.5-.3 1-.5 1.6-.5z']],
  'magnifyingglass': [['s', C(10.3, 10.3, 6.3), 2.5], ['s', 'M15.1 15.1l5.3 5.3', 2.8]],
  'text.magnifyingglass': [['s', 'M3 5.5h10M3 10h6M3 14.5h4.5', 2.1], ['s', C(15.2, 13.8, 4.3), 2.3], ['s', 'M18.4 17l3 3', 2.5]],
  'terminal': [['s', 'M5 4.4h14a2.1 2.1 0 0 1 2.1 2.1v11a2.1 2.1 0 0 1-2.1 2.1H5a2.1 2.1 0 0 1-2.1-2.1v-11A2.1 2.1 0 0 1 5 4.4z', 2], ['s', 'M7 9.3l3.1 2.7L7 14.7M12.6 15h4.6', 2.1]],
  'doc.text': [['s', 'M7.2 2.8h6.4l5.2 5.2v11.1a2.1 2.1 0 0 1-2.1 2.1H7.2a2.1 2.1 0 0 1-2.1-2.1V4.9a2.1 2.1 0 0 1 2.1-2.1z', 2], ['s', 'M13.4 3.1v5.1h5.1M8.7 12.6h6.6M8.7 16.3h6.6', 1.9]],
  'pencil': [['f', 'M15.5 4.2a2.1 2.1 0 0 1 3 0l1.3 1.3a2.1 2.1 0 0 1 0 3L9.1 19.2l-5.1 1.4c-.5.1-.9-.3-.8-.8L4.6 14.8z']],
  'checkmark': [['s', 'M4.8 12.7l4.7 4.7L19.3 7.4', 2.9]],
  'globe': [['s', C(12, 12, 9), 1.8], ['s', 'M12 3c-2.9 2.7-2.9 15.3 0 18M12 3c2.9 2.7 2.9 15.3 0 18M3.4 9h17.2M3.4 15h17.2', 1.6]],
  'chevron.down': [['s', 'M6.5 9.4 12 14.9l5.5-5.5', 3]],
  'safari': [['s', C(12, 12, 9), 1.9], ['f', 'M16.2 7.8l-2.7 5.7-5.7 2.7 2.7-5.7z']],
  'ibeam': [['s', 'M8.6 4.4h6.8M8.6 19.6h6.8M12 4.4v15.2', 2.3]],
  'macwindow': [['s', 'M4.6 5h14.8a1.6 1.6 0 0 1 1.6 1.6v10.8a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 17.4V6.6A1.6 1.6 0 0 1 4.6 5zM3 9.2h18', 1.9], ['f', C(6.1, 7.1, 0.8) + C(8.5, 7.1, 0.8) + C(10.9, 7.1, 0.8)]],
  'grid4': [['f', C(8.6, 8.6, 2) + C(15.4, 8.6, 2) + C(8.6, 15.4, 2) + C(15.4, 15.4, 2)]],
  'return': [['s', 'M19.2 5.5v6.2a2.4 2.4 0 0 1-2.4 2.4H5.4M9.4 10.1 5.4 14.1l4 4', 2.3]],
  'hammer.fill': [['f', 'M13.5 3.5l6.8 6.8-2.4 2.4-2-2-8.8 8.8a1.7 1.7 0 0 1-2.4-2.4l8.8-8.8-2-2z']],
  'brain': [['s', 'M12 5.3c-.5-1.3-1.8-2.1-3.2-2.1-1.9 0-3.4 1.4-3.5 3.3-1.4.4-2.5 1.8-2.5 3.3 0 .7.2 1.4.6 1.9-.6.6-.9 1.5-.9 2.4 0 1.6 1.1 3 2.7 3.4.3 1.8 1.8 3.1 3.7 3.1 1.5 0 2.8-.9 3.1-2.2zM12 5.3c.5-1.3 1.8-2.1 3.2-2.1 1.9 0 3.4 1.4 3.5 3.3 1.4.4 2.5 1.8 2.5 3.3 0 .7-.2 1.4-.6 1.9.6.6.9 1.5.9 2.4 0 1.6-1.1 3-2.7 3.4-.3 1.8-1.8 3.1-3.7 3.1-1.5 0-2.8-.9-3.1-2.2', 1.8],
            ['s', 'M8.3 9.1c1.1.1 1.9.9 2.1 2M15.7 9.1c-1.1.1-1.9.9-2.1 2M8 14.8c1-.7 2.2-.7 3.2 0M16 14.8c-1-.7-2.2-.7-3.2 0', 1.6]],
};
const pathCache = new Map();
function iconParts(name) { return ICONS[name] || ICONS['hammer.fill']; }
function svgIcon(name, size, color) {
  const parts = iconParts(name).map(([m, d, sw]) => (m === 'f'
    ? `<path d="${d}" fill="${color}"/>`
    : `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`)).join('');
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block">${parts}</svg>`;
}
function drawIcon(ctx, name, cx, cy, size, color) {
  const s = size / 24;
  ctx.save(); ctx.translate(cx - size / 2, cy - size / 2); ctx.scale(s, s);
  for (const [m, d, sw] of iconParts(name)) {
    let p = pathCache.get(d); if (!p) { p = new Path2D(d); pathCache.set(d, p); }
    if (m === 'f') { ctx.fillStyle = color; ctx.fill(p); }
    else { ctx.strokeStyle = color; ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(p); }
  }
  ctx.restore();
}

// Stand-in favicons: a monogram on the site's colour (no real logos are drawn).
const SITES = {
  'npmjs.com': { bg: '#CB3837', t: 'n' }, 'github.com': { bg: '#1F2328', t: 'G' }, 'nodejs.org': { bg: '#3C873A', t: 'N' },
  'typescriptlang.org': { bg: '#3178C6', t: 'TS' }, 'vitejs.dev': { bg: '#7C6CFF', t: 'V' }, 'bun.sh': { bg: '#F4E1C8', t: 'b', fg: '#3B2A1E' },
  'stackoverflow.com': { bg: '#F48024', t: 'S' }, 'jestjs.io': { bg: '#99425B', t: 'J' }, 'developer.mozilla.org': { bg: '#15141A', t: 'M' },
  'keepachangelog.com': { bg: '#E05735', t: 'K' },
};
function drawFavicon(ctx, host, cx, cy, d) {
  const s = SITES[host] || { bg: '#888', t: '?' };
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.fillStyle = s.bg; ctx.fill();
  ctx.fillStyle = s.fg || '#fff'; ctx.font = `700 ${d * (s.t.length > 1 ? 0.44 : 0.62)}px W`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.t, cx, cy + d * 0.04); ctx.restore();
}
function faviconHTML(host, d) {
  const s = SITES[host] || { bg: '#888', t: '?' };
  return `<div class="fav" style="width:${d}px;height:${d}px;background:${s.bg};color:${s.fg || '#fff'};font-size:${d * (s.t.length > 1 ? 0.44 : 0.62)}px;line-height:${d}px">${s.t}</div>`;
}

// ---------------------------------------------------------------- palettes (PlumePalette)
const PAL = {
  blue: { tail: [0.05, 0.33, 1.0], body: [0.16, 0.55, 1.0], hot: [0.80, 0.93, 1.0] },
  violet: { tail: [0.36, 0.12, 0.92], body: [0.64, 0.40, 1.0], hot: [0.93, 0.87, 1.0] },
  mint: { tail: [0.0, 0.50, 0.46], body: [0.15, 0.84, 0.70], hot: [0.82, 1.0, 0.94] },
  rose: { tail: [0.82, 0.08, 0.40], body: [1.0, 0.36, 0.60], hot: [1.0, 0.87, 0.92] },
};
function plumeRGB(heat, pal) {
  const stops = [[0, pal.tail], [0.55, pal.body], [1, pal.hot]];
  const h = clamp(heat, 0, 1);
  for (let i = 0; i < 2; i++) {
    const [a0, ac] = stops[i], [b0, bc] = stops[i + 1];
    if (h <= b0) { const t = (h - a0) / (b0 - a0); return [ac[0] + (bc[0] - ac[0]) * t, ac[1] + (bc[1] - ac[1]) * t, ac[2] + (bc[2] - ac[2]) * t]; }
  }
  return stops[2][1];
}
const rgbStr = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

// ---------------------------------------------------------------- the plume (PropulsionPlume, ported)
class SplitMix64 {
  constructor(seed) { this.state = BigInt.asUintN(64, seed); }
  nextU64() {
    this.state = BigInt.asUintN(64, this.state + 0x9E3779B97F4A7C15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94D049BB133111EBn);
    return z ^ (z >> 31n);
  }
  next(lo, hi) { const unit = Number(this.nextU64() >> 11n) / 9007199254740992; return lo + unit * (hi - lo); }
}
const PP = {
  puffsPerSecond: 34, sparksPerSecond: 6, puffLifetime: [0.95, 1.3], sparkLifetime: [0.45, 0.65], puffSize: [0.78, 1.0],
  nozzleDiameterShare: 0.9, sparkDiameterShare: 0.14, shrinkAlongPlume: 0.5, tailOvershootShare: 0.4, travelExponent: 1.7,
  tokenLifetime: [1.6, 1.9], tokenSideShare: 0.7, tokenEmergeShare: 0.08, tokenTravelExponent: 1.35,
};
class Plume {
  constructor(prewarmed) {
    this.puffs = []; this.tokens = []; this.puffDebt = 0; this.sparkDebt = 0;
    this.rng = new SplitMix64(0x9E3779B97F4A7C15n);
    if (prewarmed) for (let i = 0; i < Math.floor(PP.puffLifetime[1] * 60) + 1; i++) this.advance(1 / 60);
  }
  clone() {
    const p = Object.create(Plume.prototype);
    p.puffs = this.puffs.map(x => ({ ...x })); p.tokens = this.tokens.map(x => ({ ...x }));
    p.puffDebt = this.puffDebt; p.sparkDebt = this.sparkDebt; p.rng = new SplitMix64(this.rng.state);
    return p;
  }
  advance(dt) {
    if (dt <= 0) return;
    for (const p of this.puffs) p.age += dt;
    this.puffs = this.puffs.filter(p => p.age < p.lifetime);
    for (const t of this.tokens) t.age += dt;
    this.tokens = this.tokens.filter(t => t.age < t.lifetime);
    this.puffDebt += dt * PP.puffsPerSecond;
    while (this.puffDebt >= 1) { this.puffDebt -= 1; this.spawn(this.puffDebt / PP.puffsPerSecond, false); }
    this.sparkDebt += dt * PP.sparksPerSecond;
    while (this.sparkDebt >= 1) { this.sparkDebt -= 1; this.spawn(this.sparkDebt / PP.sparksPerSecond, true); }
  }
  launch(item) {
    this.tokens.push({ age: 0, lifetime: this.rng.next(...PP.tokenLifetime), lane: this.rng.next(-0.85, 0.85), item });
  }
  spawn(age, spark) {
    const lifetime = this.rng.next(...(spark ? PP.sparkLifetime : PP.puffLifetime));
    const lane = this.rng.next(-1, 1);
    const size = spark ? 1 : this.rng.next(...PP.puffSize);
    this.puffs.push({ age: Math.min(age, lifetime * 0.5), lifetime, lane, size, spark });
  }
}
function puffCircle(p, h, emitterX, tailX) {
  const q = clamp(p.age / p.lifetime, 0, 1);
  const travel = p.spark ? q : Math.pow(q, PP.travelExponent);
  const x = emitterX - travel * (emitterX - tailX);
  const d = p.spark ? h * PP.sparkDiameterShare * (1 - 0.5 * travel)
    : h * PP.nozzleDiameterShare * p.size * (1 - PP.shrinkAlongPlume * travel);
  const slack = Math.max(0, (h - d) / 2);
  const y = h / 2 + p.lane * slack * Math.min(1, q * 3);
  return { x, y, d: Math.max(0, d), heat: p.spark ? 1 : 1 - q, spark: p.spark };
}
function tokenTile(t, h, emitterX, tailX) {
  const q = clamp(t.age / t.lifetime, 0, 1);
  const travel = Math.pow(q, PP.tokenTravelExponent);
  const x = emitterX - travel * (emitterX - tailX);
  const side = h * PP.tokenSideShare * Math.min(1, 0.35 + 0.65 * q / PP.tokenEmergeShare);
  const slack = Math.max(0, (h - side) / 2);
  const y = h / 2 + t.lane * slack * Math.min(1, q * 2.5);
  return { x, y, side: Math.max(0, side), item: t.item };
}

/** WorkingAnimationModel, ported: queued throws leave 0.22 s apart; a running round repeats every 0.4 s. */
class WorkingModel {
  static fresh() {
    if (!WorkingModel._seed) WorkingModel._seed = new Plume(true);
    const m = new WorkingModel(); m.plume = WorkingModel._seed.clone(); return m;
  }
  constructor() { this.queued = []; this.seen = new Set(); this.primed = false; this.sinceLastThrow = Infinity; this.repeatCursor = 0; }
  tick(rawDt, incoming = [], repeating = []) {
    const dt = clamp(rawDt, 0, 0.1);
    if (!this.primed) { this.primed = true; this.seen = new Set(incoming.map(i => i.id)); }
    else {
      for (const item of incoming) if (!this.seen.has(item.id)) { this.seen.add(item.id); this.queued.push(item); }
      if (this.queued.length > 24) this.queued.splice(0, this.queued.length - 24);
    }
    this.plume.advance(dt);
    this.sinceLastThrow += dt;
    if (this.queued.length) {
      if (this.sinceLastThrow < 0.22) return;
      this.plume.launch(this.queued.shift()); this.sinceLastThrow = 0;
    } else if (repeating.length && this.sinceLastThrow >= 0.4) {
      this.plume.launch(repeating[this.repeatCursor % repeating.length]);
      this.repeatCursor = (this.repeatCursor + 1) % repeating.length; this.sinceLastThrow = 0;
    } else if (!repeating.length) this.repeatCursor = 0;
  }
}

/** One plume drawn into its own canvas (WorkingAnimationView's Canvas). */
class PlumeView {
  constructor(canvas, scale) { this.cv = canvas; this.scale = scale; this.glow = document.createElement('canvas'); }
  draw(cssW, cssH, model, pal, emitterInset = EMITTER_INSET) {
    const s = this.scale, W = Math.max(1, Math.round(cssW * s)), H = Math.max(1, Math.round(cssH * s));
    const cv = this.cv, g = this.glow;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    if (!model) return;
    const emitterX = cssW - emitterInset, tailX = -cssH * PP.tailOvershootShare;
    const circles = [];
    for (const p of model.plume.puffs) { const c = puffCircle(p, cssH, emitterX, tailX); if (c.d > 0.25) circles.push(c); }
    // The soft glow under everything, added rather than painted.
    if (g.width !== W || g.height !== H) { g.width = W; g.height = H; }
    const gc = g.getContext('2d');
    gc.setTransform(1, 0, 0, 1, 0, 0); gc.clearRect(0, 0, W, H); gc.setTransform(s, 0, 0, s, 0, 0);
    for (const c of circles) if (!c.spark) { gc.fillStyle = rgbStr(plumeRGB(c.heat, pal)); disc(gc, c.x, c.y, c.d * 1.15); }
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55;
    ctx.filter = `blur(${(cssH * 0.22 * s * 0.75).toFixed(2)}px)`; ctx.drawImage(g, 0, 0); ctx.restore();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    for (const c of circles) if (!c.spark) { ctx.fillStyle = rgbStr(plumeRGB(c.heat, pal)); disc(ctx, c.x, c.y, c.d); }
    ctx.fillStyle = rgbStr(plumeRGB(1, pal), 0.95);
    for (const c of circles) if (c.spark) disc(ctx, c.x, c.y, c.d);
    for (const tk of model.plume.tokens) {
      const t = tokenTile(tk, cssH, emitterX, tailX);
      if (t.side <= 0.5) continue;
      ctx.fillStyle = '#fff'; disc(ctx, t.x, t.y, t.side);
      if (t.item.kind === 'tool') drawIcon(ctx, t.item.symbol, t.x, t.y, t.side * 0.5, rgbStr(plumeRGB(0, pal)));
      else {
        const inner = t.side * 0.64;
        ctx.save(); ctx.beginPath(); ctx.arc(t.x, t.y, inner / 2 + t.side * 0.04, 0, Math.PI * 2); ctx.clip();
        drawFavicon(ctx, t.item.host, t.x, t.y, inner); ctx.restore();
      }
    }
  }
}
function disc(ctx, x, y, d) { ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2); ctx.fill(); }

// ---------------------------------------------------------------- DOM helpers
const $ = id => document.getElementById(id);
function el(tag, cls, parent, html) {
  const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e); return e;
}
const css = (e, o) => { for (const k in o) e.style[k] = o[k]; };
const BRAND = (window.BRAND_PATHS || []).filter(p => p.startsWith('M'));   // injected by record.cjs from the asset catalog
let gradSeq = 0;
/** The Winter mark as SVG, its fill a gradient whose band we slide for BandShimmer. */
function brandSVG(size, color = '#fff') {
  const id = 'bg' + (gradSeq++);
  const svg = `<svg viewBox="0 0 240 240" width="${size}" height="${size}" style="display:block;overflow:visible">
    <defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="240" y2="0" spreadMethod="pad">
      <stop offset="0" stop-color="${color}" stop-opacity="1"/><stop offset="0.5" stop-color="${color}" stop-opacity="1"/><stop offset="1" stop-color="${color}" stop-opacity="1"/>
    </linearGradient></defs><g fill="url(#${id})">${BRAND.map(d => `<path d="${d}"/>`).join('')}</g></svg>`;
  return { svg, id };
}
/** BandShimmer's mask over a 240-unit mark `size` px wide: alpha = rest + band·peak·(1−rest). */
function shimmerMark(root, id, size, T, rest, peak, minBand, bandShare) {
  const grad = root.querySelector('#' + id); if (!grad) return;
  const phase = Math.min(1, (T % 2.0) / (2.0 * 0.7));
  const band = Math.max(minBand, size * bandShare), u = 240 / size;
  const start = (-band + (size + band) * phase) * u;
  grad.setAttribute('x1', start); grad.setAttribute('x2', start + band * u);
  const stops = grad.querySelectorAll('stop');
  stops[0].setAttribute('stop-opacity', rest); stops[2].setAttribute('stop-opacity', rest);
  stops[1].setAttribute('stop-opacity', rest + peak * (1 - rest));
}
/** BandShimmer on a text element `w` px wide (rest 0.5 → white at the band's centre). */
function shimmerText(e, w, T, active) {
  if (!active) { css(e, { backgroundImage: 'none', color: 'rgba(255,255,255,.9)', webkitTextFillColor: '' }); return; }
  const phase = Math.min(1, (T % 2.0) / 1.4);
  const band = Math.max(60, w * 0.6), s = -band + (w + band) * phase;
  css(e, {
    backgroundImage: `linear-gradient(90deg, rgba(255,255,255,.5) ${s.toFixed(1)}px, rgba(255,255,255,1) ${(s + band / 2).toFixed(1)}px, rgba(255,255,255,.5) ${(s + band).toFixed(1)}px)`,
    webkitBackgroundClip: 'text', backgroundClip: 'text', webkitTextFillColor: 'transparent', color: 'transparent',
  });
}

// ---------------------------------------------------------------- the story
const PROMPT = 'Get 2.4 out: check the milestone, fix the flaky login test, bump deps (read the changelogs) and draft release notes.';
const REPLY_1 = 'I’ve started three sessions, one per task. They’ll check upstream issues and changelogs first; I’ll report back as each one finishes.';
const REPLY_2 = 'All three are done and CI is green: the login fix matches a known Jest issue, 14 packages are bumped, and RELEASE.md links every PR.';

const CHILD_DEFS = [
  {
    id: 'A', title: 'Fix flaky login test', pal: PAL.violet, spawn: 8.6, done: 24.0,
    items: [
      { type: 'user', at: 8.6, text: 'Fix the flaky login test in packages/auth. It fails about one run in five on CI; check for known upstream issues first.' },
      { type: 'think', id: 'think1', at: 8.7, titleAt: 8.85, done: 9.15, title: 'Reproducing the flaky test' },
      { type: 'tool', at: 9.2, kind: 'read', file: 'login.test.ts', calls: [9.2], done: 10.0 },
      { type: 'tool', at: 10.15, kind: 'search', calls: [10.15], resultAt: 11.0, done: 11.3,
        sites: ['github.com', 'stackoverflow.com', 'jestjs.io', 'nodejs.org', 'developer.mozilla.org'] },
      { type: 'tool', at: 11.45, kind: 'fetch', calls: [11.45], hosts: ['github.com'], callDone: [12.3], done: 12.3 },
      { type: 'tool', at: 12.5, kind: 'shell', calls: [12.5, 14.0, 15.4], done: 17.0 },
      { type: 'think', id: 'think2', at: 17.25, titleAt: 17.4, done: 17.85, title: 'Tracing the cookie race' },
      { type: 'tool', at: 17.95, kind: 'edit', file: 'login.test.ts', calls: [17.95], done: 19.3 },
      { type: 'tool', at: 19.5, kind: 'shell', calls: [19.5], done: 23.4 },
      { type: 'assistant', at: 23.5, text: 'Fixed. It matches a known Jest issue: the test raced the session-cookie write. It now awaits the store’s <code>ready</code> promise, and 50 runs in a row pass.' },
    ],
  },
  {
    id: 'B', title: 'Bump dependencies', pal: PAL.mint, spawn: 9.3, done: 22.4,
    items: [
      { type: 'user', at: 9.3, text: 'Bump our dependencies to their latest compatible versions. Read each changelog for breaking changes, and keep the build green.' },
      { type: 'think', id: 'think1', at: 9.4, titleAt: 9.55, done: 9.85, title: 'Checking for newer releases' },
      { type: 'tool', at: 9.9, kind: 'search', calls: [9.9], resultAt: 11.2, done: 11.6,
        sites: ['npmjs.com', 'github.com', 'nodejs.org', 'typescriptlang.org', 'vitejs.dev', 'bun.sh'] },
      { type: 'tool', at: 12.0, kind: 'read', file: 'package.json', calls: [12.0], done: 12.9 },
      { type: 'think', id: 'think2', at: 12.95, titleAt: 13.1, done: 13.55, title: 'Choosing safe upgrades' },
      { type: 'tool', at: 13.65, kind: 'edit', file: 'package.json', calls: [13.65], done: 15.3 },
      { type: 'tool', at: 15.5, kind: 'shell', calls: [15.5], done: 17.6 },
      { type: 'tool', at: 17.8, kind: 'search', calls: [17.8], resultAt: 18.75, done: 19.05,
        sites: ['github.com', 'typescriptlang.org', 'npmjs.com', 'vitejs.dev'] },
      { type: 'tool', at: 19.25, kind: 'fetch', calls: [19.25, 19.55], hosts: ['github.com', 'typescriptlang.org'], callDone: [20.3, 20.75], done: 20.75 },
      { type: 'tool', at: 20.95, kind: 'shell', calls: [20.95], done: 21.9 },
      { type: 'assistant', at: 22.0, text: 'Bumped 14 packages, none across a major version. TypeScript’s release notes flagged one stricter check, fixed in one line. Build and tests are green.' },
    ],
  },
  {
    id: 'C', title: 'Draft release notes', pal: PAL.rose, spawn: 10.0, done: 25.0,
    items: [
      { type: 'user', at: 10.0, text: 'Draft the 2.4 release notes from the commits since v2.3, in Keep a Changelog style with each change linked to its PR. Save as RELEASE.md.' },
      { type: 'think', id: 'think1', at: 10.1, titleAt: 10.25, done: 10.55, title: 'Reading the commit log' },
      { type: 'tool', at: 10.6, kind: 'shell', calls: [10.6], done: 12.2 },
      { type: 'tool', at: 12.35, kind: 'fetch', calls: [12.35], hosts: ['github.com'], callDone: [13.2], done: 13.2 },
      { type: 'tool', at: 13.35, kind: 'read', file: 'CHANGELOG.md', calls: [13.35], done: 14.0 },
      { type: 'tool', at: 14.2, kind: 'write', file: 'RELEASE.md', calls: [14.2], linesAt: 14.6, lines: 42, done: 16.0 },
      { type: 'tool', at: 16.4, kind: 'grep', pattern: 'BREAKING', calls: [16.4], done: 18.0 },
      // The one the cursor opens: its reasoning streams in while it is live (PillThinkingText).
      { type: 'think', id: 'think2', at: 18.1, titleAt: 18.4, done: 21.2, title: 'Grouping the changes by area', rate: 110,
        text: '**Grouping the changes by area**\n\nThe log since v2.3 has 31 commits: three user-facing features, seven fixes — most of them in packages/auth — and the dependency bump. Keep a Changelog wants Added, Changed and Fixed; readers will look for the login fix first, so Fixed leads, and every line links its PR.' },
      { type: 'tool', at: 21.35, kind: 'fetch', calls: [21.35, 21.65], hosts: ['keepachangelog.com', 'github.com'], callDone: [22.1, 22.45], done: 22.45 },
      { type: 'tool', at: 22.6, kind: 'edit', file: 'RELEASE.md', calls: [22.6], done: 24.5 },
      { type: 'assistant', at: 24.6, text: 'RELEASE.md is drafted in Keep a Changelog style: three features, seven fixes and the dependency bump, each linked to its PR.' },
    ],
  },
];
const TOOL_SYMBOL = { read: 'doc.text', shell: 'terminal', edit: 'pencil', write: 'pencil', grep: 'text.magnifyingglass', search: 'magnifyingglass', fetch: 'safari' };
// What a child's turn has thrown by time T (plumeThrows): a tool puff per call — a search throws its sites instead.
for (const def of CHILD_DEFS) {
  def.throws = [];
  def.items.forEach((it, i) => {
    if (it.type !== 'tool') return;
    if (it.kind === 'search') it.sites.forEach(h => def.throws.push({ at: it.resultAt, item: { id: `${def.id}${i}#${h}`, kind: 'site', host: h } }));
    else it.calls.forEach((c, j) => {
      def.throws.push({ at: c, item: { id: `${def.id}${i}.${j}`, kind: 'tool', symbol: TOOL_SYMBOL[it.kind] } });
      if (it.kind === 'fetch') def.throws.push({ at: it.callDone[j], item: { id: `${def.id}${i}.${j}#${it.hosts[j]}`, kind: 'site', host: it.hosts[j] } });
    });
  });
  def.throws.sort((a, b) => a.at - b.at);
}
const throwsAt = (def, T) => def.throws.filter(x => x.at <= T).map(x => x.item);

// ---------------------------------------------------------------- state
let T = 0, frameNo = -1, evIdx = 0;
const exchanges = [];
const main = {
  visible: false, presentation: 'compact', draft: '', running: false, preview: null,
  w: M.compactWidth, h: M.pillHeight, vw: 0, vh: 0, tw: M.compactWidth, th: M.pillHeight,
  model: null, thrown: [],
  fieldA: new Anim(1), plumeA: new Anim(0), previewA: new Anim(0), accVis: new Anim(1), accPresent: new Anim(0),
  sendIcon: 'mic.fill', prevIcon: null, iconT: -9, lastKeyAt: -9,
};
let typing = null;
const children = [];
const rowP = new Spring(0, 0.45, 0.8);
const windows = [];

// ---------------------------------------------------------------- measurement
const mLine = $('mLine'), mBlock = $('mBlock'), mReply = $('mReply');
const measureCache = new Map();
function lineWidth(s) { if (!s) return 0; mLine.textContent = s; return Math.ceil(mLine.getBoundingClientRect().width); }
function draftLines(s) {
  if (measureCache.has(s)) return measureCache.get(s);
  mBlock.textContent = s || ' ';
  const n = Math.max(1, Math.round(mBlock.getBoundingClientRect().height / LINE));
  measureCache.set(s, n); return n;
}
function previewHeight(reply) {
  mReply.textContent = reply;
  const w = Math.ceil(mReply.getBoundingClientRect().width);
  const lines = Math.min(2, Math.max(1, Math.ceil(w / (M.expandedWidth - 2 * M.leadingPadding))));
  return Math.ceil(Math.max(M.pillHeight, 2 * M.previewVerticalInset + LINE + M.previewLineGap + lines * LINE));
}

// ---------------------------------------------------------------- the pill's decisions (DispatchPillLayout)
function fieldWidth(pillWidth) { return Math.max(1, pillWidth - M.leadingPadding - M.trailingPadding - M.sendCircleSize - M.rowSpacing); }
const FIELD_BESIDE_ACC = fieldWidth(M.expandedWidth) - 2 * M.accessoryButtonSize - 2 * M.rowSpacing;
function accessoryVisible(draft) { return !draft.includes('\n') && lineWidth(draft) + M.accessoryApproachMargin <= FIELD_BESIDE_ACC; }
function mainTarget() {
  if (main.presentation === 'compact') return [M.compactWidth, M.pillHeight];
  const content = 8 + LINE * draftLines(main.draft);
  const total = main.preview ? main.preview.height : Math.max(M.pillHeight, content + M.composerVerticalPadding);
  return [M.expandedWidth, clamp(total, M.pillHeight, M.maxExpandedHeight)];
}
const morphBlur = () => { const r = Math.min(M.maxMorphBlur, Math.max(Math.abs(main.tw - main.w), Math.abs(main.th - main.h)) / M.morphBlurFalloff); return r < 0.25 ? 0 : r; };
function childLayout(count, rowWidth) {
  const gap = M.childPillGap, ov = M.pillHeight, min = M.minChildPillWidth;
  if (!count) return { visible: 0, w: 0, overflow: 0 };
  const fitting = Math.max(1, Math.floor((rowWidth + gap) / (min + gap)));
  if (count <= fitting) return { visible: count, w: Math.max(0, (rowWidth - gap * (count - 1)) / count), overflow: 0 };
  const visible = Math.max(1, Math.floor((rowWidth - ov) / (min + gap)));
  return { visible, w: Math.max(0, (rowWidth - ov - gap * visible) / visible), overflow: count - visible };
}
function turnPreview(i) {
  const ex = exchanges[i];
  return { prompt: ex.prompt || 'Update from your sessions', reply: ex.reply, position: `${i + 1}/${exchanges.length}`, height: previewHeight(ex.reply) };
}

// ---------------------------------------------------------------- actions
function setDraft(d) {
  const old = main.draft; main.draft = d;
  if (main.presentation === 'compact' && old !== d && d) main.presentation = 'expanded';
}
function submit(t) {
  exchanges.push({ prompt: main.draft, reply: '' });
  typing = null; main.draft = ''; main.presentation = 'compact';
  startTurn(t);
}
function startTurn() { main.running = true; main.thrown = []; }
function endTurn(t, reply) {
  main.running = false;
  exchanges[exchanges.length - 1].reply = reply;
  // dispatchPillRevealsReply: on screen, not previewing, no draft → pin the newest turn.
  if (main.visible && !main.preview && !main.draft.trim()) {
    main.preview = turnPreview(exchanges.length - 1);
    main.presentation = 'expanded';
  }
}
function esc() {
  if (main.preview) { main.preview = null; return; }
  if (main.presentation === 'expanded') main.presentation = 'compact';
}
function spawnChild(i, t) {
  const def = CHILD_DEFS[i];
  const before = childLayout(children.length, main.w);
  const after = childLayout(children.length + 1, main.w);
  children.forEach((c, k) => {   // siblings re-split the row on the child row's spring
    c.xOff.x += k * (before.w + M.childPillGap) - k * (after.w + M.childPillGap);
    c.wOff.x += before.w - after.w;
  });
  const first = children.length === 0;
  const enter = new Spring(first ? 1 : 0, 0.45, 0.8); enter.target = 1;
  children.push({
    def, status: 'running', enter, xOff: new Spring(0, 0.45, 0.8), wOff: new Spring(0, 0.45, 0.8),
    doneA: new Anim(0), plumeA: new Anim(1), model: WorkingModel.fresh(), dom: null, pv: null,
  });
}
function wake(t) {
  exchanges.push({ prompt: '', reply: '' });           // dispatch-wake: a promptless exchange
  startTurn(t);
  // SessionModel: finished children are pruned at the next main turn_started.
  for (const c of children) if (c.status !== 'running') c.pruned = true;
}
function mainThrow(item) { main.thrown.push(item); }

// ---------------------------------------------------------------- windows (SessionWindowStack)
function stackFrames(count) {
  const width = 560, maxH = 640, minH = 240, gap = 12, topMargin = 12;
  const bottomY = VISIBLE.minY + M.dockGap + M.pillHeight + M.stackGap + M.pillHeight + 22;
  const avail = Math.max(minH, VISIBLE.maxY - topMargin - bottomY);
  const perColumn = Math.max(1, Math.floor((avail + gap) / (minH + gap)));
  const columns = Math.ceil(count / perColumn);
  const totalWidth = columns * width + (columns - 1) * gap;
  let firstX = Math.round(SW / 2 - totalWidth / 2);
  firstX = Math.min(Math.max(firstX, VISIBLE.minX + gap), Math.max(VISIBLE.minX + gap, VISIBLE.maxX - gap - totalWidth));
  const frames = [];
  for (let col = 0; col < columns; col++) {
    const members = Math.min(perColumn, count - col * perColumn);
    const h = Math.min(maxH, Math.max(minH, (avail - gap * (members - 1)) / members));
    const x = firstX + col * (width + gap);
    for (let i = 0; i < members; i++) {
      const y = bottomY + (members - 1 - i) * (h + gap);
      const x0 = Math.floor(x), y0 = Math.floor(y);
      frames.push({ x: x0, y: y0, w: Math.ceil(x + width) - x0, h: Math.ceil(y + h) - y0 });
    }
  }
  return frames;
}
function openWindow(i, t) {
  const def = CHILD_DEFS[i];
  const w = new SessionWindow(def, t);
  windows.push(w);
  const targets = stackFrames(windows.length);
  windows.forEach((m, k) => {
    const to = targets[k];
    if (m === w) { m.move = { from: { ...to, y: to.y - 26 }, to, t0: t, fade: true }; m.frame = { ...m.move.from }; m.alpha = 0; }
    else m.move = { from: { ...m.frame }, to, t0: t, fade: false };
  });
}

class SessionWindow {
  constructor(def, t) {
    this.def = def; this.openT = t; this.frame = { x: 0, y: 0, w: 560, h: 640 }; this.alpha = 0;
    this.loadA = new Anim(1); this.plumeA = new Anim(T < def.done ? 1 : 0); this.model = null;
    const root = this.root = el('div', 'win', $('windows'));
    const clip = el('div', 'wclip', root);
    const scroll = el('div', 'wscroll', clip);
    this.col = el('div', 'wcol', scroll);
    el('div', 'wskirt', clip);
    const comp = this.comp = el('div', 'wcomposer', clip);
    this.pv = new PlumeView(el('canvas', '', comp), 2.5);
    this.ph = el('div', 'wph', comp, 'Type here');
    this.btn = el('div', 'circleBtn', comp); css(this.btn, { right: '6px', bottom: '6px' });
    this.btnG = el('div', 'g', this.btn);
    this.btnIcon = '';
    const load = this.load = el('div', 'wloading', clip);
    const mark = brandSVG(56); this.markId = mark.id; load.innerHTML = mark.svg;
    this.title = el('div', 'wtitle', clip, def.title);
    el('div', 'wlights', clip, '<i style="background:#FF5F57"></i><i style="background:#FEBC2E"></i><i style="background:#28C840"></i>');
    // The transcript, built once; each item shows from its own time.
    this.items = [];
    let flow = null;
    for (const it of def.items) {
      if (it.type === 'think') {
        if (!flow) flow = el('div', 'flow', this.col);
        const e = el('div', 'tk', flow);
        const bg = el('div', 'tkbg', e);
        const row = el('div', 'tkrow', e);
        el('div', 'disc', row, svgIcon('brain', 12, '#000'));
        const lbl = el('span', 'tl', row);
        const chev = el('span', 'chev', row, svgIcon('chevron.down', 9, 'rgba(255,255,255,.45)'));
        const text = el('div', 'tktext', e);
        this.items.push({ it, e, bg, lbl, chev, text, openS: null, w0: 0, shownChars: -1 });
        continue;
      }
      if (it.type === 'tool') {
        if (!flow) flow = el('div', 'flow', this.col);
        const e = el('div', 'tp', flow);
        const discs = el('div', 'discs', e), lbl = el('span', 'tl', e);
        el('span', '', e, svgIcon('chevron.down', 9, 'rgba(255,255,255,.45)'));
        const rim = el('div', 'rim', e);
        this.items.push({ it, e, discs, lbl, rim, cu: { shown: null, target: 0, next: 0 }, discKey: '' });
        continue;
      }
      flow = null;
      if (it.type === 'user') {
        const e = el('div', 'ruled', this.col, `<div class="rtext">${it.text}</div><div class="rrule"></div>`);
        this.items.push({ it, e });
      } else {
        const e = el('div', 'asst', this.col);
        this.items.push({ it, e, shownChars: -1 });
      }
    }
  }
  landed(t) { return t >= this.openT + 0.75; }
  update(t) {
    const def = this.def;
    // The stack's manual 60 Hz move: ease-out cubic over 0.32 s; a newcomer rises 26 pt and fades in.
    if (this.move) {
      const p = easeOutCubic((t - this.move.t0) / 0.32), f = this.move.from, to = this.move.to;
      this.frame = { x: lerp(f.x, to.x, p), y: lerp(f.y, to.y, p), w: lerp(f.w, to.w, p), h: lerp(f.h, to.h, p) };
      if (this.move.fade) this.alpha = p;
      if (p >= 1) this.move = null;
    }
    this.loadA.set(this.landed(t) ? 0 : 1, t, 0.3, easeOut);
    for (const x of this.items) if (x.openS) x.openS.step(DT);
    const working = t < def.done;
    this.plumeA.set(working ? 1 : 0, t, 0.25, easeOut);
    if (working && !this.model) this.model = WorkingModel.fresh();
    if (this.model) {
      const thrown = throwsAt(def, t);
      this.model.tick(DT, thrown, thrown);
      if (!working && this.plumeA.value(t) <= 0) this.model = null;
    }
  }
  render(t) {
    const f = this.frame, def = this.def;
    css(this.root, { left: f.x + 'px', top: (SH - f.y - f.h) + 'px', width: f.w + 'px', height: f.h + 'px', opacity: this.alpha });
    const la = this.loadA.value(t);
    css(this.load, { opacity: la, display: la <= 0.001 ? 'none' : 'flex' });
    if (la > 0) shimmerMark(this.load, this.markId, 56, t, 0.18, 0.5, 32, 0.7);
    this.title.style.opacity = 1 - la;
    // Transcript items: history is in place at landing; anything after that arrives with a short fade.
    for (const x of this.items) {
      const it = x.it, shown = t >= it.at;
      x.e.style.display = shown ? '' : 'none';
      if (!shown) continue;
      const live = it.at > this.openT + 0.75;
      const a = live ? ramp(t, it.at, 0.3, easeOut) : 1;
      css(x.e, { opacity: a, transform: `translateY(${((1 - a) * 6).toFixed(2)}px)` });
      if (it.type === 'tool') this.renderTool(x, t);
      if (it.type === 'think') this.renderThink(x, t);
      if (it.type === 'assistant') {
        const n = live ? Math.floor((t - it.at) * 90) : 1e9;
        const plain = it.text.replace(/<[^>]+>/g, '');
        const k = Math.min(n, plain.length);
        if (k !== x.shownChars) { x.shownChars = k; x.e.innerHTML = k >= plain.length ? it.text : plain.slice(0, k); }
      }
    }
    // The floating composer: the plume in the session's colour while it works, else "Type here".
    const pa = this.plumeA.value(t), cw = f.w - 32;
    this.pv.draw(cw, 44, this.model, def.pal);
    this.pv.cv.style.opacity = pa;
    this.ph.style.opacity = 1 - pa;
    const icon = t < def.done ? 'stop.fill' : 'mic.fill';
    if (icon !== this.btnIcon) { this.btnIcon = icon; this.btnG.innerHTML = svgIcon(icon, 15, '#000'); }
  }
  /** PillThinkingHeader: the tool pill's capsule with the brain disc — the block's title once its heading
   *  line has closed, else "Thinking" while live and "Thought" once done; opened, it morphs into a rounded
   *  rect (PillMorphChrome) holding the reasoning (PillThinkingText, white at 0.72). */
  renderThink(x, t) {
    const it = x.it, running = t < it.done;
    const label = t >= it.titleAt ? it.title : (running ? 'Thinking' : 'Thought');
    if (x.lbl.textContent !== label) x.lbl.textContent = label;
    shimmerText(x.lbl, x.lbl.offsetWidth, t, running);
    const live = running ? 1 : clamp(1 - (t - it.done) / 0.3, 0, 1);
    x.bg.style.boxShadow = `inset 0 0 0 1px rgba(255,255,255,${(0.08 + 0.47 * easeInOut(live)).toFixed(3)})`;
    const p = x.openS ? Math.max(0, x.openS.x) : 0;
    if (p <= 0) { css(x.e, { flexBasis: '', width: '', height: '' }); css(x.bg, { width: '', borderRadius: '' }); x.text.style.display = 'none'; return; }
    // Open: the pill takes a line of its own (PillFlowFullWidth); the capsule widens and grows down around the text.
    const full = x.e.parentElement.clientWidth;
    const body = thinkingBody(it, t);
    if (body.length !== x.shownChars) { x.shownChars = body.length; x.text.textContent = body; }
    css(x.text, { display: 'block', width: (full - 32) + 'px', opacity: (0.72 * clamp(p, 0, 1)).toFixed(3) });
    const textH = x.text.offsetHeight;
    css(x.e, { flexBasis: '100%', width: full + 'px', height: (34 + (2 + textH + 14) * p).toFixed(2) + 'px' });
    css(x.bg, { width: lerp(x.w0, full, Math.min(p, 1.04)).toFixed(2) + 'px', borderRadius: lerp(17, 16, clamp(p, 0, 1)) + 'px' });
    x.chev.style.transform = `rotate(${(180 * clamp(p, 0, 1)).toFixed(1)}deg)`;
    x.lbl.style.maxWidth = 'none';
  }
  openThinking(id, t) {
    const x = this.items.find(i => i.it.id === id); if (!x) return;
    x.w0 = x.bg.offsetWidth; x.openS = new Spring(0, 0.38, 0.86); x.openS.target = 1;
  }
  renderTool(x, t) {
    const it = x.it, running = t < it.done;
    const lab = toolLabel(it, t);
    // PillCountUp: climbs one by one to its target, at most 0.9 s per climb.
    let text = lab.lead;
    if (lab.count != null) {
      const cu = x.cu;
      if (cu.shown == null) { cu.shown = lab.count > 1 ? 1 : lab.count; cu.next = t; }
      if (lab.count !== cu.target) { cu.target = lab.count; cu.interval = Math.min(0.06, 0.9 / Math.max(1, cu.target - cu.shown)); cu.next = t + cu.interval; }
      while (cu.shown < cu.target && t >= cu.next) { cu.shown++; cu.next += cu.interval; }
      if (cu.shown > cu.target) cu.shown = cu.target;
      text += `${cu.shown} ${cu.shown === 1 ? lab.noun[0] : lab.noun[1]}`;
    }
    if (lab.rot) text += lab.rot;
    if (lab.rots) text += lab.rots[Math.floor(t / 0.5) % lab.rots.length];   // a rotating name, every half second
    text += lab.tail || '';
    if (x.lbl.textContent !== text) x.lbl.textContent = text;
    shimmerText(x.lbl, x.lbl.offsetWidth, t, running);
    const live = running ? 1 : clamp(1 - (t - it.done) / 0.3, 0, 1);
    x.rim.style.borderColor = `rgba(255,255,255,${(0.08 + 0.47 * easeInOut(live)).toFixed(3)})`;
    // Discs: a tool's symbol; a search's favicons (one rotating while it runs, up to five once done).
    let key, html;
    if (it.kind === 'fetch') {
      if (running && lab.rots) { const h = lab.rots[Math.floor(t / 0.5) % lab.rots.length]; key = 'r' + h; html = `<div class="disc">${faviconHTML(h, 14)}</div>`; }
      else {   // toolRunDiscs: its own tile, then each page's favicon — each distinct disc once
        const hosts = [...new Set(it.hosts)];
        key = 'done';
        html = [`<div class="disc" style="z-index:9">${svgIcon('safari', 12, '#000')}</div>`]
          .concat(hosts.slice(0, 4).map((h, i) => `<div class="disc" style="z-index:${8 - i}">${faviconHTML(h, 14)}</div>`)).join('');
      }
    } else if (it.kind === 'search' && t >= it.resultAt) {
      if (running) { const h = it.sites[Math.floor(t / 0.5) % it.sites.length]; key = 'r' + h; html = `<div class="disc">${faviconHTML(h, 14)}</div>`; }
      else {
        key = 'done';
        html = it.sites.slice(0, 5).map((h, i) => `<div class="disc" style="z-index:${5 - i}">${faviconHTML(h, 14)}</div>`).join('')
          + (it.sites.length > 5 ? `<span class="more" style="padding-left:11px">+${it.sites.length - 5}</span>` : '');
      }
    } else { key = TOOL_SYMBOL[it.kind]; html = `<div class="disc">${svgIcon(key, 11, '#000')}</div>`; }
    if (key !== x.discKey) { x.discKey = key; x.discs.innerHTML = html; }
  }
}
function thinkingBody(it, t) {
  const n = t >= it.done ? it.text.length : Math.max(0, Math.floor((t - it.at) * it.rate));   // done: the whole block
  const sofar = it.text.slice(0, Math.min(n, it.text.length));
  const head = `**${it.title}**`;
  if (sofar.startsWith(head)) return sofar.slice(head.length).replace(/^\s+/, '');
  return head.startsWith(sofar) ? '' : sofar;
}
function toolLabel(it, t) {
  const running = t < it.done, n = it.calls.filter(c => c <= t).length;
  const cmd = ['shell command', 'shell commands'];
  switch (it.kind) {
    case 'read': return running ? { lead: 'Reading ', rot: it.file } : { lead: `Read ${it.file}` };
    case 'edit': return running ? { lead: 'Editing ', rot: it.file } : { lead: `Edited ${it.file}` };
    case 'shell': return running ? { lead: 'Running ', count: n, noun: cmd } : { lead: 'Ran ', count: n, noun: cmd };
    case 'grep': return running ? { lead: 'Searching for ', rot: `“${it.pattern}”` } : { lead: `Searched for “${it.pattern}”` };
    case 'fetch': {
      const called = it.calls.map((c, i) => ({ at: c, host: it.hosts[i], done: it.callDone[i] })).filter(c => c.at <= t);
      if (running) {
        const live = called.filter(c => t < c.done), names = (live.length ? live : called).map(c => c.host);
        return names.length ? { lead: 'Reading ', rots: names } : { lead: 'Reading a page' };
      }
      return it.hosts.length === 1 ? { lead: `Read ${it.hosts[0]}` } : { lead: 'Read ', count: it.hosts.length, noun: ['page', 'pages'] };
    }
    case 'search': {
      const sites = t >= it.resultAt ? it.sites.length : 0, noun = ['website', 'websites'];
      if (running) return sites ? { lead: 'Searching the web · ', count: sites, noun } : { lead: 'Searching the web' };
      return { lead: 'Searched ', count: sites, noun };
    }
    case 'write': {
      const lines = t >= it.linesAt ? it.lines : 0;
      if (running) return lines ? { lead: 'Writing ', count: lines, noun: ['line', 'lines'], tail: ` to ${it.file}` } : { lead: `Writing ${it.file}` };
      return { lead: `Wrote ${it.file}` };
    }
  }
  return { lead: '' };
}

// ---------------------------------------------------------------- timeline
const EVENTS = [
  [2.9, () => { main.visible = true; }],
  [3.6, t => { typing = { start: t, times: typingTimes(PROMPT) }; }],
  [7.35, t => submit(t)],
  [7.6, () => mainThrow({ id: 'ls1', kind: 'tool', symbol: 'person.2.fill' })],
  [7.8, () => mainThrow({ id: 'wf1', kind: 'tool', symbol: 'safari' })],
  [8.1, () => mainThrow({ id: 'wf1#github.com', kind: 'site', host: 'github.com' })],
  [8.25, () => mainThrow({ id: 'sp1', kind: 'tool', symbol: 'paperplane.fill' })],
  [8.6, t => spawnChild(0, t)],
  [8.95, () => mainThrow({ id: 'sp2', kind: 'tool', symbol: 'paperplane.fill' })],
  [9.3, t => spawnChild(1, t)],
  [9.65, () => mainThrow({ id: 'sp3', kind: 'tool', symbol: 'paperplane.fill' })],
  [10.0, t => spawnChild(2, t)],
  [10.9, t => endTurn(t, REPLY_1)],
  [13.2, () => esc()],
  [13.7, () => esc()],
  [15.9, t => openWindow(0, t)],
  [17.4, t => openWindow(1, t)],
  [18.9, t => openWindow(2, t)],
  [20.35, t => windows.find(w => w.def === CHILD_DEFS[2])?.openThinking('think2', t)],
  [27.1, t => wake(t)],
  [27.45, () => mainThrow({ id: 'ls2', kind: 'tool', symbol: 'person.2.fill' })],
  [27.75, () => mainThrow({ id: 'wf2', kind: 'tool', symbol: 'safari' })],
  [28.15, () => mainThrow({ id: 'wf2#github.com', kind: 'site', host: 'github.com' })],
  [29.4, t => endTurn(t, REPLY_2)],
];
function typingTimes(text) {
  // A (fast) human cadence: ~40 chars/s, a little longer after spaces and punctuation.
  const times = []; let at = 0;
  for (let i = 0; i < text.length; i++) {
    const h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    let d = (1 / 40) * (0.55 + 0.9 * h);
    if (text[i - 1] === ' ') d *= 1.25;
    if (',.:'.includes(text[i - 1] || '')) d += 0.09;
    at += d; times.push(at);
  }
  return times;
}

// ---------------------------------------------------------------- camera, cursor, captions, keys
const CAM = [ // t, zoom, centre x, centre y (points; clamped so the screen always fills the frame)
  [0, 2.9, 768, 820], [3.0, 2.9, 768, 820], [3.9, 2.5, 768, 820], [7.5, 2.5, 768, 820],
  [9.2, 2.1, 768, 820], [13.9, 2.1, 768, 820], [15.3, 0.85, 768, 432], [26.1, 0.85, 768, 432],
  [27.4, 1.9, 768, 820], [31.0, 1.9, 768, 820], [32.3, 0.85, 768, 432], [36, 0.85, 768, 432],
];
function camera(t) {
  let i = 0; while (i < CAM.length - 2 && t >= CAM[i + 1][0]) i++;
  const a = CAM[i], b = CAM[i + 1];
  const p = easeInOut(clamp((t - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1));
  const zoom = Math.exp(lerp(Math.log(a[1]), Math.log(b[1]), p));
  const S = BASE * zoom;
  // Zoomed in, the screen always fills the frame; pulled back past it, it is centred and sits low,
  // leaving the band at the top to the chapter headings.
  const tx = SW * S >= 1920 ? clamp(960 - lerp(a[2], b[2], p) * S, 1920 - SW * S, 0) : (1920 - SW * S) / 2;
  const ty = SH * S >= 1080 ? clamp(540 - lerp(a[3], b[3], p) * S, 1080 - SH * S, 0) : (1080 - SH * S) * 0.84;
  return { S, tx, ty };
}
const CHILD_Y = PILL_BOTTOM - M.pillHeight - M.stackGap - M.pillHeight / 2;
const CURSOR_PATH = [ // t0, t1, to (a point, or a function resolved once when the segment starts)
  [15.0, 15.75, [652, CHILD_Y + 2]],
  [16.55, 17.25, [760, CHILD_Y + 2]],
  [18.05, 18.75, [868, CHILD_Y + 2]],
  [19.6, 20.25, () => elementCentre(windows.find(w => w.def === CHILD_DEFS[2])?.items.find(i => i.it.id === 'think2')?.lbl)],
  [20.8, 21.6, from => [from[0] + 170, from[1] + 110]],
];
const CURSOR_START = [990, 560];
const CLICKS = [15.9, 17.4, 18.9, 20.35];
const resolvedTargets = [];
/** An element's centre in screen points, through the camera. */
function elementCentre(e) {
  if (!e) return [1100, 600];
  const r = e.getBoundingClientRect(), cam = camera(T);
  return [(r.left + r.width / 2 - cam.tx) / cam.S, (r.top + r.height / 2 - cam.ty) / cam.S];
}
function cursorAt(t) {
  let pos = CURSOR_START, from = CURSOR_START;
  CURSOR_PATH.forEach(([t0, t1, to], i) => {
    if (t < t0) return;
    if (!resolvedTargets[i]) resolvedTargets[i] = typeof to === 'function' ? to(from) : to;
    const b = resolvedTargets[i], p = easeInOutSine(clamp((t - t0) / (t1 - t0), 0, 1));
    pos = [lerp(from[0], b[0], p), lerp(from[1], b[1], p)];
    from = b;
  });
  const alpha = ramp(t, 14.85, 0.3) * (1 - ramp(t, 21.0, 0.5));
  return { pos, alpha };
}
// The narration: each chapter's heading sits straight on the frame in a heavy face, in the band at
// the top that every shot leaves clear. Its letters rise into place from behind the baseline in a
// quick cascade and leave upward the same way as the next heading comes in, while a bar in the
// chapter's plume colour draws in beneath and retracts with them. No container.
const CHAPTERS = [   // t: the letters start rising; end: the last one has left (the next heading rises just before)
  { t: 2.55, end: 7.45, pal: PAL.blue, head: 'Ask Dispatch anything' },
  { t: 7.35, end: 14.05, pal: PAL.violet, head: 'It fans the work out' },
  { t: 13.95, end: 20.65, pal: PAL.mint, head: 'Open any session' },
  { t: 20.55, end: 24.1, pal: PAL.rose, head: 'Watch them work' },
  { t: 24.0, end: 26.6, pal: PAL.blue, head: 'Then it reports back' },
];
const TITLE = { top: 20, line: 88, barGap: 6 };
const KEYS = [   // the key hints: a keycap and what it did, top right
  { presses: [2.9], cap: 'grid4', labels: ['Summon Dispatch'] },
  { presses: [7.35], cap: 'return', labels: ['Send'] },
  { presses: [13.2, 13.7], text: 'esc', labels: ['Close the reply', 'Collapse'] },
];
const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeInCubic = x => x * x * x;
const easeOutQuint = x => 1 - Math.pow(1 - x, 5);
const easeInQuint = x => x * x * x * x * x;
const easeInOutQuart = x => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2);

// ---------------------------------------------------------------- build static DOM
function buildDesktop() {
  const mb = $('menubar');
  mb.innerHTML = `<span style="display:flex;align-items:center">${brandSVG(15, '#1d1d1f').svg}</span><span class="app">Winter</span>`
    + ['File', 'Edit', 'View', 'Window', 'Help'].map(s => `<span class="mi">${s}</span>`).join('')
    + `<span class="spacer"></span>`
    + `<span style="display:flex;align-items:center;opacity:.9">${brandSVG(14, '#1d1d1f').svg}</span>`
    + `<span class="mi" style="display:flex;align-items:center;gap:3px"><svg width="22" height="11" viewBox="0 0 22 11"><rect x=".5" y=".5" width="18" height="10" rx="3" fill="none" stroke="rgba(0,0,0,.45)"/><rect x="2" y="2" width="12.5" height="7" rx="1.6" fill="#1d1d1f"/><rect x="19.6" y="3.6" width="1.6" height="3.8" rx=".8" fill="rgba(0,0,0,.45)"/></svg></span>`
    + `<span class="mi">Tue 6 Oct&nbsp;&nbsp;9:41</span>`;
  // Menu-bar marks are static (no shimmer): full white.
  mb.querySelectorAll('stop').forEach(s => s.setAttribute('stop-opacity', 1));
}
const pillEl = $('pill'), shapeEl = pillEl.querySelector('.pshape'), strokeEl = pillEl.querySelector('.pstroke');
const contentEl = $('pcontent'), slotEl = $('fieldSlot'), fieldTextEl = $('fieldText'), placeholderEl = $('placeholder'), draftEl = $('draft');
const accEl = $('accessories'), sendEl = $('sendBtn'), sendG1 = $('sendG1'), sendG2 = $('sendG2'), previewEl = $('preview'), rowEl = $('childRow');
const mainPV = new PlumeView($('mainPlume'), 4);
accEl.innerHTML = `<div class="acc">${svgIcon('ellipsis', 14, '#fff')}</div><div class="acc">${svgIcon('expand', 13, '#fff')}</div>`;

const overlays = $('overlays');
// Letters in a mask per word, so each can rise from behind the baseline.
const maskedLetters = text => text.split(' ').map(w => `<span class="mask">${[...w].map(c => `<span class="ch">${c}</span>`).join('')}</span>`).join(' ');
const titleEl = el('div', '', overlays); titleEl.id = 'titles';
const titleViews = CHAPTERS.map(c => {
  const line = el('div', 'title-line', titleEl, maskedLetters(c.head));
  const bar = el('div', 'title-bar', titleEl);
  bar.style.background = `linear-gradient(90deg, ${rgbStr(c.pal.tail)}, ${rgbStr(c.pal.body)})`;
  return { line, bar, chars: [...line.querySelectorAll('.ch')], width: 0 };
});
const keyViews = KEYS.map(k => {
  const e = el('div', 'key', overlays);
  const cap = el('div', 'kcap', e, k.text ? k.text : svgIcon(k.cap, 18, '#1d1d1f'));
  const labels = el('div', 'klabels', e);
  const spans = k.labels.map(l => el('span', '', labels, l));
  return { e, cap, labels, spans, measured: false };
});
const introMark = brandSVG(132, '#0b0b0f'), outroMark = brandSVG(132, '#0b0b0f');
$('intro').innerHTML = `<div id="introMark">${introMark.svg}</div><div class="brandTitle" id="introTitle">Dispatch</div><div class="brandSub" id="introSub">in Winter for Mac</div>`;
$('outro').innerHTML = `<div id="outroMark">${outroMark.svg}</div><div class="brandTitle" id="outroTitle">Dispatch</div><div class="brandSub" id="outroSub">One pill. Every session.</div>`;

// ---------------------------------------------------------------- simulate one fixed step
function simulate(t) {
  while (evIdx < EVENTS.length && EVENTS[evIdx][0] <= t + 1e-9) { EVENTS[evIdx][1](t); evIdx++; }
  if (typing) {
    let n = 0; const dt = t - typing.start;
    while (n < typing.times.length && typing.times[n] <= dt) n++;
    const d = PROMPT.slice(0, n);
    if (d !== main.draft) { setDraft(d); main.lastKeyAt = t; }
  }
  // Children finishing.
  for (const c of children) {
    if (c.status === 'running' && t >= c.def.done) { c.status = 'completed'; c.doneA.set(1, t, 0.3, easeInOut); c.plumeA.set(0, t, 0.25, easeOut); }
  }
  // The main pill's spring (morphStep: stiffness 140, damping 22, at 60 Hz).
  [main.tw, main.th] = mainTarget();
  const stepAxis = (x, v, target) => { const a = 140 * (target - x) - 22 * v; const nv = v + a * DT; return [x + nv * DT, nv]; };
  [main.w, main.vw] = stepAxis(main.w, main.vw, main.tw);
  [main.h, main.vh] = stepAxis(main.h, main.vh, main.th);
  if (Math.abs(main.tw - main.w) < 0.5 && Math.abs(main.vw) < 4 && Math.abs(main.th - main.h) < 0.5 && Math.abs(main.vh) < 4) {
    main.w = main.tw; main.h = main.th; main.vw = 0; main.vh = 0;
  }
  const working = main.presentation === 'compact' && main.running;
  main.fieldA.set(working ? 0 : 1, t, 0.25, easeOut);
  main.plumeA.set(working ? 1 : 0, t, 0.25, easeOut);
  main.previewA.set(main.preview ? 1 : 0, t, 0.2, easeOut);
  main.accPresent.set(main.presentation === 'expanded' ? 1 : 0, t, 0.2, easeOut);
  main.accVis.set(main.presentation === 'expanded' && !main.preview && accessoryVisible(main.draft) ? 1 : 0, t, 0.22, easeOut);
  if (working && !main.model) main.model = WorkingModel.fresh();
  if (main.model) {
    main.model.tick(DT, main.thrown, main.thrown);
    if (!working && main.plumeA.value(t) <= 0) main.model = null;
  }
  const icon = main.running ? 'stop.fill' : (main.draft.trim() ? 'arrow.up' : 'mic.fill');
  if (icon !== main.sendIcon) { main.prevIcon = main.sendIcon; main.sendIcon = icon; main.iconT = t; }
  // The child row.
  const live = children.filter(c => !c.pruned);
  rowP.target = live.length ? 1 : 0; rowP.step(DT);
  if (!live.length && children.length && rowP.x < 0.02 && Math.abs(rowP.v) < 0.2) children.length = 0;
  for (const c of children) {
    c.enter.step(DT); c.xOff.target = 0; c.wOff.target = 0; c.xOff.step(DT); c.wOff.step(DT);
    if (c.model) {
      const thrown = throwsAt(c.def, t);
      c.model.tick(DT, thrown, thrown);
      if (c.status !== 'running' && c.plumeA.value(t) <= 0) c.model = null;
    }
  }
  for (const w of windows) w.update(t);
}

// ---------------------------------------------------------------- render
function render(t) {
  // Camera.
  const cam = camera(t);
  $('screen').style.transform = `translate(${cam.tx.toFixed(3)}px, ${cam.ty.toFixed(3)}px) scale(${cam.S.toFixed(5)})`;

  renderMainPill(t);
  renderChildren(t);
  for (const w of windows) w.render(t);
  renderCursor(t);
  renderOverlays(t);
}

function renderMainPill(t) {
  pillEl.style.display = main.visible ? 'block' : 'none';
  if (!main.visible) return;
  const w = main.w, h = main.h, tw = main.tw, th = main.th;
  const r = Math.min(Math.max(0, h) / 2, M.maxCornerRadius);
  css(pillEl, { left: (SW / 2 - w / 2) + 'px', top: (PILL_BOTTOM - h) + 'px', width: w + 'px', height: h + 'px' });
  shapeEl.style.borderRadius = strokeEl.style.borderRadius = r + 'px';
  // Content at the TARGET height, bottom-anchored; its width rides the animated shape.
  const cw = w, ch = th;
  css(contentEl, { width: cw + 'px', height: ch + 'px', top: (h - th) + 'px', filter: morphBlur() ? `blur(${(morphBlur() * 0.8).toFixed(2)}px)` : 'none' });
  // The plume: full width, the pill's resting height, its nozzle on the stop button.
  const pa = main.plumeA.value(t);
  mainPV.draw(cw, M.pillHeight, main.model, PAL.blue);
  mainPV.cv.style.opacity = pa;
  // Composer row.
  const prevA = main.previewA.value(t);
  $('composerRow').style.opacity = 1 - prevA;
  css(slotEl, { width: Math.max(0, cw - M.leadingPadding - M.rowSpacing - M.sendCircleSize - M.trailingPadding) + 'px' });
  const lines = draftLines(main.draft);
  const fieldH = Math.max(26, 8 + LINE * lines);
  css(fieldTextEl, { width: fieldWidth(tw) + 'px', height: fieldH + 'px', opacity: main.fieldA.value(t) });
  const expanded = main.presentation === 'expanded';
  placeholderEl.textContent = main.draft ? '' : 'Type here';
  placeholderEl.style.color = expanded ? 'rgba(255,255,255,.5)' : '#686868';
  draftEl.style.width = (fieldWidth(tw) - 4) + 'px';
  const caretOn = main.draft && (t - main.lastKeyAt < 0.5 || Math.floor((t - main.lastKeyAt) * 2) % 2 === 1);
  draftEl.innerHTML = main.draft ? escapeHTML(main.draft) + (caretOn ? '<span class="caret"></span>' : '<span class="caret" style="opacity:0"></span>') : '';
  // ↗ and ⋯ float over the field's trailing end and blur out as the text reaches them.
  const av = main.accVis.value(t), ap = main.accPresent.value(t);
  css(accEl, {
    right: (M.trailingPadding + M.sendCircleSize + M.rowSpacing) + 'px', bottom: ((M.pillHeight - M.sendCircleSize) / 2 + 2) + 'px',
    opacity: av * ap, filter: av < 0.999 ? `blur(${((1 - av) * 6 * 0.7).toFixed(2)}px)` : 'none', transform: `scale(${0.9 + 0.1 * av})`,
  });
  // The trailing circle: stop while running, send with text, the voice glyph without.
  css(sendEl, { right: M.trailingPadding + 'px', bottom: (M.pillHeight - M.sendCircleSize) / 2 + 'px' });
  const ip = clamp((t - main.iconT) / 0.22, 0, 1);
  sendG1.innerHTML = svgIcon(main.sendIcon, 15, '#000');
  css(sendG1, { opacity: easeOut(ip), transform: `scale(${0.55 + 0.45 * easeOut(ip)})`, filter: ip < 1 ? `blur(${(1 - ip) * 2}px)` : 'none' });
  if (main.prevIcon && ip < 1) {
    sendG2.innerHTML = svgIcon(main.prevIcon, 15, '#000');
    css(sendG2, { display: 'flex', opacity: 1 - easeOut(ip), transform: `scale(${1 - 0.45 * easeOut(ip)})` });
  } else sendG2.style.display = 'none';
  // A pinned turn, alone in the pill.
  if (main.preview) {
    previewEl.querySelector('.pprompt').textContent = main.preview.prompt;
    previewEl.querySelector('.ppos').textContent = main.preview.position;
    previewEl.querySelector('.preply').textContent = main.preview.reply;
  }
  previewEl.style.opacity = prevA;
}
const escapeHTML = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function renderChildren(t) {
  const live = children.filter(c => !c.pruned);
  const rowW = main.w;
  const p = clamp(rowP.x, 0, 1);
  css(rowEl, {
    display: children.length && main.visible ? 'block' : 'none',
    left: (SW / 2 - rowW / 2) + 'px', top: (PILL_BOTTOM - main.h - M.stackGap - M.pillHeight) + 'px', width: rowW + 'px',
    transform: `translateY(${((1 - p) * 18).toFixed(2)}px) scale(${(0.55 + 0.45 * p).toFixed(4)})`,
    opacity: p, filter: p < 0.999 ? `blur(${((1 - p) * 6 * 0.8).toFixed(2)}px)` : 'none',
  });
  const lay = childLayout(live.length || children.length, rowW);
  children.forEach((c, k) => {
    if (!c.dom) buildChildDom(c);
    const d = c.dom;
    const x = k * (lay.w + M.childPillGap) + c.xOff.x, w = Math.max(0, lay.w + c.wOff.x);
    const e = clamp(c.enter.x, 0, 1);
    css(d.root, {
      left: x + 'px', width: w + 'px', opacity: e,
      transform: `translateY(${((1 - e) * 18).toFixed(2)}px) scale(${(0.55 + 0.45 * e).toFixed(4)})`,
      filter: e < 0.999 ? `blur(${((1 - e) * 6 * 0.8).toFixed(2)}px)` : 'none',
    });
    const done = c.doneA.value(t), pa = c.plumeA.value(t);
    c.pv.draw(w, M.pillHeight, c.model, c.def.pal);
    c.pv.cv.style.opacity = 0.8 * pa;
    // HStack(spacing 6): [glyph] [title] [stop], padded 12 / 6.
    const glyphW = 20 * done, g1 = 6 * done, stopW = 32 * (1 - done), g2 = 6 * (1 - done);
    css(d.glyph, { left: (12) + 'px', opacity: done, transform: `scale(${0.6 + 0.4 * done})` });
    const titleL = 12 + glyphW + g1, titleR = M.trailingPadding + stopW + g2;
    css(d.title, { left: titleL + 'px', width: Math.max(0, w - titleL - titleR) + 'px', textShadow: `0 0 2px rgba(0,0,0,${(0.8 * (1 - done)).toFixed(2)})` });
    css(d.stop, { right: M.trailingPadding + 'px', opacity: 1 - done, transform: `scale(${1 - 0.3 * done})` });
  });
}
function buildChildDom(c) {
  const root = el('div', 'child', rowEl);
  const body = el('div', 'cbody', root);
  const cv = el('canvas', '', body);
  el('div', 'cstroke', root);
  const glyph = el('div', 'cglyph', root, svgIcon('checkmark', 12, '#30D158'));
  const title = el('div', 'ctitle', root, c.def.title);
  const stop = el('div', 'cstop', root, svgIcon('stop.fill', 15, '#fff'));
  stop.style.background = rgbStr(c.def.pal.body);
  c.dom = { root, glyph, title, stop };
  c.pv = new PlumeView(cv, 4);
}

const cursorEl = $('cursor'), ringEl = $('ring');
function renderCursor(t) {
  const { pos, alpha } = cursorAt(t);
  let press = 1, ring = null;
  for (const c of CLICKS) {
    if (t >= c - 0.08 && t < c + 0.18) press = Math.min(press, 0.86 + 0.14 * Math.abs((t - c) / (t < c ? 0.08 : 0.18)));
    if (t >= c && t < c + 0.5) ring = (t - c) / 0.5;
  }
  css(cursorEl, { display: alpha > 0 ? 'block' : 'none', opacity: alpha, transform: `translate(${pos[0] - 1.5 * 1.2}px, ${pos[1] - 1.5 * 1.2}px) scale(${press * 1.2})` });
  if (ring != null && alpha > 0) {
    const r = 6 + 22 * easeOutCubic(ring);
    css(ringEl, { display: 'block', left: (pos[0] - r) + 'px', top: (pos[1] - r) + 'px', width: 2 * r + 'px', height: 2 * r + 'px', opacity: 0.85 * (1 - ring) });
  } else ringEl.style.display = 'none';
}

/** Each heading's width, measured once its face has loaded. */
function measureTitles() {
  for (const v of titleViews) {
    v.line.style.display = 'block';
    v.width = Math.ceil(v.line.getBoundingClientRect().width);
    v.line.style.display = 'none';
  }
}
const TITLE_IN = { stagger: 0.022, dur: 0.8 }, TITLE_OUT = { stagger: 0.01, dur: 0.36 };
function renderTitles(t) {
  titleViews.forEach((v, i) => {
    const ch = CHAPTERS[i], n = v.chars.length;
    const leave = ch.end - ((n - 1) * TITLE_OUT.stagger + TITLE_OUT.dur);   // the exit starts here and is over by `end`
    if (t < ch.t || t >= ch.end) { v.line.style.display = 'none'; v.bar.style.display = 'none'; return; }
    css(v.line, { display: 'block', top: TITLE.top + 'px', transform: 'translateX(-50%)' });
    // Each letter rises from below its word's baseline mask on a long ease-out, a beat after the one
    // before it; it leaves upward through the top of the mask on an ease-in.
    v.chars.forEach((c, k) => {
      const inP = easeOutQuint(clamp((t - (ch.t + k * TITLE_IN.stagger)) / TITLE_IN.dur, 0, 1));
      const outP = easeInQuint(clamp((t - (leave + k * TITLE_OUT.stagger)) / TITLE_OUT.dur, 0, 1));
      c.style.transform = `translateY(${((1 - inP) * 112 - outP * 112).toFixed(2)}%)`;
    });
    // The bar draws in from the left as the letters land, and retracts to the right as they leave.
    const grow = easeInOutQuart(clamp((t - (ch.t + 0.18)) / 0.85, 0, 1));
    const shrink = easeInQuint(clamp((t - leave) / 0.45, 0, 1));
    const left = 960 - v.width / 2, w = v.width * Math.max(0, grow - shrink);
    css(v.bar, { display: w > 0.5 ? 'block' : 'none', left: (left + v.width * shrink).toFixed(2) + 'px', width: w.toFixed(2) + 'px',
      top: (TITLE.top + TITLE.line + TITLE.barGap) + 'px' });
  });
}
function renderKeys(t) {
  KEYS.forEach((k, i) => {
    const v = keyViews[i], first = k.presses[0], last = k.presses[k.presses.length - 1];
    const pin = easeOutBack(clamp((t - (first - 0.32)) / 0.42, 0, 1)), pout = ramp(t, last + 0.7, 0.35, easeInOut);
    if (t < first - 0.32 || pout >= 1) { v.e.style.display = 'none'; return; }
    v.e.style.display = 'flex';
    if (!v.measured) { v.labels.style.width = Math.ceil(Math.max(...v.spans.map(s => s.offsetWidth))) + 'px'; v.measured = true; }
    css(v.e, { opacity: (clamp(pin, 0, 1) * (1 - pout)).toFixed(3),
      transform: `translateY(${((1 - pin) * -14 - pout * 10).toFixed(2)}px) scale(${(0.86 + 0.14 * pin).toFixed(4)})`,
      filter: (1 - clamp(pin, 0, 1)) + pout > 0.001 ? `blur(${(((1 - clamp(pin, 0, 1)) * 8) + pout * 8).toFixed(2)}px)` : 'none' });
    const pressed = k.presses.some(p => t >= p && t < p + 0.16);
    css(v.cap, { transform: `translateY(${pressed ? 2.5 : 0}px)`, boxShadow: pressed ? '0 0.5px 0 rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.06)' : '' });
    const n = Math.max(0, k.presses.filter(p => t >= p).length - 1);
    v.spans.forEach((sp, j) => {
      const since = t - k.presses[j];
      const a = j === n ? (j === 0 ? 1 : easeOutCubic(clamp(since / 0.25, 0, 1))) : (j === n - 1 ? 1 - easeInOut(clamp((t - k.presses[n]) / 0.2, 0, 1)) : 0);
      css(sp, { opacity: a.toFixed(3), filter: a < 1 ? `blur(${((1 - a) * 6).toFixed(2)}px)` : 'none' });
    });
  });
}
function renderOverlays(t) {
  renderTitles(t);
  renderKeys(t);
  // Intro.
  const intro = $('intro');
  const ia = 1 - ramp(t, 1.95, 0.6, easeInOut);
  intro.style.display = ia > 0 ? 'flex' : 'none';
  if (ia > 0) {
    intro.style.opacity = ia;
    const m = ramp(t, 0.25, 0.8, easeOutCubic);
    css($('introMark'), { opacity: m, transform: `scale(${0.86 + 0.14 * m})`, filter: m < 1 ? `blur(${(1 - m) * 10}px)` : 'none' });
    shimmerMark(intro, introMark.id, 132, t + 0.6, 0.55, 1, 60, 0.7);
    const tt = ramp(t, 0.6, 0.7, easeOutCubic);
    css($('introTitle'), { opacity: tt, transform: `translateY(${(1 - tt) * 16}px)` });
    const ts = ramp(t, 0.85, 0.7, easeOutCubic);
    css($('introSub'), { opacity: ts, transform: `translateY(${(1 - ts) * 12}px)` });
  }
  // Outro.
  const outro = $('outro');
  const oa = ramp(t, 32.6, 0.8, easeInOut);
  outro.style.display = oa > 0 ? 'flex' : 'none';
  if (oa > 0) {
    outro.style.opacity = oa;
    const m = ramp(t, 33.1, 0.8, easeOutCubic);
    css($('outroMark'), { opacity: m * (1 - ramp(t, 35.3, 0.6)), transform: `scale(${0.86 + 0.14 * m})`, filter: m < 1 ? `blur(${(1 - m) * 10}px)` : 'none' });
    shimmerMark(outro, outroMark.id, 132, t, 0.55, 1, 60, 0.7);
    const tt = ramp(t, 33.4, 0.7, easeOutCubic), fade = 1 - ramp(t, 35.3, 0.6);
    css($('outroTitle'), { opacity: tt * fade, transform: `translateY(${(1 - tt) * 16}px)` });
    const ts = ramp(t, 33.65, 0.7, easeOutCubic);
    css($('outroSub'), { opacity: ts * fade, transform: `translateY(${(1 - ts) * 12}px)` });
  }
}

// ---------------------------------------------------------------- entry points for the recorder
buildDesktop();
window.TOTAL_FRAMES = TOTAL_FRAMES;
window.renderRange = function (a, b) { for (let n = a; n <= b; n++) window.renderFrame(n); return T; };
window.renderFrame = function (n) {
  while (frameNo < n) { frameNo++; T = frameNo / FPS; simulate(T); }
  render(T);
  return T;
};
Promise.all(['800 76px WD', '700 24px WD', '400 14px W', '500 14px W', '600 16px W'].map(f => document.fonts.load(f)))
  .then(() => document.fonts.ready)
  .then(() => { measureTitles(); window.sceneReady = true; });
