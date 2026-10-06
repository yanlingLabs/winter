// Renders scene.html frame by frame in headless Chromium and pipes the frames into ffmpeg.
//   node record.cjs stills 300 600 900        → out/stills/f0300.png …
//   node record.cjs video [out.mp4] [from] [to] → out/dispatch-pill.mp4 (1920×1080, 60 fps)
// Needs Playwright's Chromium and ffmpeg (libx264) on the PATH.
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
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.addInitScript(paths => { window.BRAND_PATHS = paths; }, brandPaths());
  await page.goto('file://' + path.join(__dirname, 'scene.html'));
  await page.waitForFunction(() => window.sceneReady === true);
  const total = await page.evaluate(() => window.TOTAL_FRAMES);

  if (mode === 'stills') {
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
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'mjpeg', '-i', '-',
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
