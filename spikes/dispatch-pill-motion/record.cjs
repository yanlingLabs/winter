// Renders scene.html frame by frame in headless Chromium and pipes the frames into ffmpeg, with the
// soundtrack (music.js, rendered offline in the same page) muxed underneath.
//   node record.cjs stills 300 600 900        → out/stills/f0300.png …
//   node record.cjs music                     → out/music.wav
//   node record.cjs video [out.mp4] [from] [to] → out/dispatch-pill.mp4 (1920×1080, 60 fps, AAC audio)
//   node record.cjs loop                      → out/dispatch-loop.avif (the README's silent hero loop)
//   node record.cjs card [t] [variant…]       → out/social-preview[-v].png (GitHub's 1280×640 social card)
// Needs Playwright's Chromium and ffmpeg (libx264, aac, libsvtav1) on the PATH.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch { /* fall through */ }
  return require('/opt/node22/lib/node_modules/playwright'); // the cloud container's global install
}

// The Winter mark, read from the app's own asset catalog so the video never drifts from it.
function brandPaths() {
  const svg = fs.readFileSync(path.join(__dirname, '../../apple/Winter/Assets.xcassets/BrandMark.imageset/yanling-scale-burst-v2.svg'), 'utf8');
  return [...svg.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
}

(async () => {
  const { chromium } = loadPlaywright();
  const [mode, ...rest] = process.argv.slice(2);
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--allow-file-access-from-files', '--disable-lcd-text'] });
  // The card's still is taken at 2× so the pills stay crisp in a card rendered at 2×.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: mode === 'card' ? 2 : 1 });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.addInitScript(paths => { window.BRAND_PATHS = paths; }, brandPaths());
  // The loop plays without its soundtrack, so the camera does not push on the beat; the card's still
  // keeps the plume's tiles off the session titles.
  await page.goto('file://' + path.join(__dirname, 'scene.html') + ({ loop: '?silent', card: '?card' }[mode] || ''));
  await page.waitForFunction(() => window.sceneReady === true);
  const total = await page.evaluate(() => window.TOTAL_FRAMES);

  const renderMusic = async () => {
    const { wav, peak } = await page.evaluate(() => window.renderMusic());
    const file = path.join(outDir, 'music.wav');
    fs.writeFileSync(file, Buffer.from(wav, 'base64'));
    console.log('wrote', file, `(pre-normalise peak ${peak.toFixed(3)})`);
    return file;
  };

  const ffmpeg = args => new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('close', code => (code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code))));
  });

  if (mode === 'music') {
    await renderMusic();
  } else if (mode === 'card') {
    // 1. The pills alone, transparent around them: the same render as the video at time t.
    const t = Number(rest[0] || 12.55), variants = rest.slice(1).length ? rest.slice(1) : ['b'];
    await page.evaluate(n => window.renderRange(0, n), Math.round(t * 60));
    await page.addStyleTag({ content: `html, body, #viewport, #screen { background: transparent !important; box-shadow: none !important; }
      #screen { overflow: visible !important; }
      #wallpaper, #menubar, #windows, #overlays, #intro, #outro, #cursor, #ring { display: none !important; }` });
    const clip = await page.evaluate(() => {
      const bounds = () => {
        const rs = [...document.querySelectorAll('#pill, #childRow .child')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0);
        return { x0: Math.min(...rs.map(r => r.left)), y0: Math.min(...rs.map(r => r.top)), x1: Math.max(...rs.map(r => r.right)), y1: Math.max(...rs.map(r => r.bottom)) };
      };
      // Lift the stack off the bottom of the frame so its shadow is whole, keeping the video's scale.
      const screen = document.getElementById('screen');
      const [, tx, ty, S] = screen.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/).map(Number);
      let b = bounds();
      screen.style.transform = `translate(${tx + 960 - (b.x0 + b.x1) / 2}px, ${ty + 540 - (b.y0 + b.y1) / 2}px) scale(${S})`;
      b = bounds();
      const m = 110;   // room for the pill's shadow (28 pt of blur at the video's scale)
      return { x: Math.floor(b.x0 - m), y: Math.floor(b.y0 - m), width: Math.ceil(b.x1 - b.x0 + 2 * m), height: Math.ceil(b.y1 - b.y0 + 2 * m) };
    });
    await page.screenshot({ path: path.join(outDir, 'card-pills.png'), clip, omitBackground: true });
    // 2. The card around them, rendered at 2× and brought down to GitHub's 1280×640 with Lanczos.
    const card = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
    card.on('pageerror', e => console.log('[pageerror]', e.message));
    await card.addInitScript(paths => { window.BRAND_PATHS = paths; }, brandPaths());
    for (const v of variants) {
      await card.goto('file://' + path.join(__dirname, 'card.html') + '?v=' + v);
      await card.waitForFunction(() => window.cardReady === true);
      const big = path.join(outDir, `card-${v}@2x.png`);
      await card.screenshot({ path: big });
      const out = path.join(outDir, variants.length > 1 ? `social-preview-${v}.png` : 'social-preview.png');
      await ffmpeg(['-i', big, '-vf', 'scale=1280:640:flags=lanczos', '-pix_fmt', 'rgb24', out]);
      console.log('wrote', out, `(${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    }
  } else if (mode === 'loop') {
    // The README's hero: the whole cut at 30 fps, silent, 1600 wide with a hairline rim, as an animated
    // AVIF (AV1, 10-bit). WebP was tried first: its encoder keeps "unchanged" blocks from the frame
    // before, which smears every camera move, and it came out at 10 MB against AVIF's 4. The loop
    // starts at 3.6 s (the heading up, the pill there — a still worth showing when autoplay is off)
    // and wraps through the end card and the intro back to it.
    const START = 216, frames = path.join(outDir, 'loop-frames');
    fs.rmSync(frames, { recursive: true, force: true });
    fs.mkdirSync(frames, { recursive: true });
    const t0 = Date.now();
    const order = [];
    for (let f = 0; f < total; f += 2) {
      await page.evaluate(n => window.renderFrame(n), f);
      const file = path.join(frames, `src${String(f).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 95 });
      order.push(file);
      if (f % 240 === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    const at = f => Number(path.basename(f).slice(3, 8));
    const rotated = [...order.filter(f => at(f) >= START), ...order.filter(f => at(f) < START)];
    rotated.forEach((f, i) => fs.symlinkSync(f, path.join(frames, `seq${String(i).padStart(5, '0')}.jpg`)));
    const out = path.join(outDir, 'dispatch-loop.avif');
    await ffmpeg(['-framerate', '30', '-i', path.join(frames, 'seq%05d.jpg'),
      '-vf', 'scale=1600:900:flags=lanczos,drawbox=x=0:y=0:w=iw:h=ih:color=0x111827@0.10:t=1,format=yuv420p10le',
      '-c:v', 'libsvtav1', '-preset', '4', '-crf', rest[0] || '32', '-g', '600', '-svtav1-params', 'tune=0', '-loop', '0', out]);
    fs.rmSync(frames, { recursive: true, force: true });
    console.log('wrote', out, `(${(fs.statSync(out).size / 1048576).toFixed(2)} MB)`);
  } else if (mode === 'stills') {
    fs.mkdirSync(path.join(outDir, 'stills'), { recursive: true });
    let at = -1;
    for (const f of rest.map(Number).sort((a, b) => a - b)) {
      await page.evaluate(([a, b]) => window.renderRange(a, b), [at + 1, f]);   // every frame, so view state is exact
      at = f;
      const file = path.join(outDir, 'stills', `f${String(f).padStart(4, '0')}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
  } else {
    const out = path.resolve(outDir, rest[0] || 'dispatch-pill.mp4');
    const from = Number(rest[1] || 0), to = Number(rest[2] || total);
    const wav = await renderMusic();
    const audio = from === 0 ? ['-i', wav, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k', '-shortest'] : [];
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'mjpeg', '-i', '-', ...audio,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '14', '-preset', 'slow', '-tune', 'animation', '-movflags', '+faststart', out],
      { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now();
    for (let f = from; f < to; f++) {
      await page.evaluate(n => window.renderFrame(n), f);
      const buf = await page.screenshot({ type: 'jpeg', quality: 96 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (f % 120 === 0) console.log(`frame ${f}/${to}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await new Promise(r => ff.on('close', r));
    console.log('wrote', out);
  }
  await browser.close();
})();
