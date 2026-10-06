// Renders scene.html frame by frame in headless Chromium and pipes the frames into ffmpeg, with the
// soundtrack (music.js, rendered offline in the same page) muxed underneath.
//   node record.cjs stills 300 600 900        → out/stills/f0300.png …
//   node record.cjs music                     → out/music.wav
//   node record.cjs video [out.mp4] [from] [to] → out/dispatch-pill.mp4 (1920×1080, 60 fps, AAC audio)
//   node record.cjs poster [frame]            → out/poster.png (the README's picture, 1600×900)
//   node record.cjs web                       → out/winter-dispatch.mp4 (the video for GitHub's player)
//   node record.cjs gif [fps] [width] [lossy] → out/dispatch.gif (the README's moving picture)
//   node record.cjs card [t] [variant…]       → out/social-preview[-v].png (GitHub's 1280×640 social card)
// Needs Playwright's Chromium, ffmpeg (libx264, aac) and gifsicle on the PATH.
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
  // The card's still keeps the plume's tiles off the session titles; the GIF has no soundtrack, so no
  // push on the beat.
  await page.goto('file://' + path.join(__dirname, 'scene.html') + ({ card: '?card', gif: '?silent' }[mode] || ''));
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
  } else if (mode === 'poster') {
    // The README's picture, and the first frame of the video GitHub plays: "Watch them work" at 21.6 s,
    // every window busy, brought down to 1600×900 with a hairline rim.
    await page.evaluate(n => window.renderRange(0, n), Number(rest[0] || 1296));
    const full = path.join(outDir, 'poster@1080.png'), out = path.join(outDir, 'poster.png');
    await page.screenshot({ path: full });
    await ffmpeg(['-i', full, '-vf', 'scale=1600:900:flags=lanczos,drawbox=x=0:y=0:w=iw:h=ih:color=0x111827@0.10:t=1', out]);
    console.log('wrote', out, `(${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  } else if (mode === 'web') {
    // The video for GitHub's own player, which plays only videos uploaded through github.com (an MP4
    // in the repository just downloads, and Safari plays animated AVIF slowly): the full cut under the
    // free plan's 10 MB upload cap, its first frame the poster so the player shows a real picture
    // before you press play. Run `video` and `poster` first.
    const master = path.join(outDir, 'dispatch-pill.mp4'), poster = path.join(outDir, 'poster@1080.png');
    const wav = path.join(outDir, 'music.wav'), out = path.join(outDir, 'winter-dispatch.mp4');
    for (const f of [master, poster, wav]) if (!fs.existsSync(f)) throw new Error(`no ${path.basename(f)}: run video and poster first`);
    await ffmpeg(['-i', master, '-i', poster, '-i', wav, '-filter_complex', "[0:v][1:v]overlay=enable='eq(n,0)'[v]",
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'slow', '-tune', 'animation',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out]);
    console.log('wrote', out, `(${(fs.statSync(out).size / 1048576).toFixed(2)} MB)`);
  } else if (mode === 'gif') {
    // The README's moving picture, as a GIF: the one animated format Safari and GitHub's iPhone app play
    // at the right speed (animated AVIF and WebP crawl there, slower and slower, since Apple's decoders
    // rebuild each frame from the last full one). The whole cut, silent, starting at 3.6 s (the heading
    // and the pill: a fair still while it loads or when autoplay is off) and wrapping through the end
    // card and the intro back to it. One palette for the whole loop and ordered dithering, so what does
    // not move stays byte-identical from frame to frame; gifsicle then trims what is left.
    const fps = Number(rest[0] || 15), W = Number(rest[1] || 800), lossy = rest[2] || '30';
    const step = 60 / fps, START = 216, frames = path.join(outDir, 'gif-frames');
    const [from, to] = [Number(rest[3] || 0), Number(rest[4] || total)];   // a sub-range, to try settings
    fs.rmSync(frames, { recursive: true, force: true });
    fs.mkdirSync(frames, { recursive: true });
    const order = [];
    const t0 = Date.now();
    for (let f = from; f < to; f += step) {
      await page.evaluate(n => window.renderFrame(n), f);
      const file = path.join(frames, `src${String(f).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 95 });
      order.push([f, file]);
      if (f % 240 === 0) console.log(`frame ${f}/${to}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    const whole = from === 0 && to === total;
    const seq = whole ? [...order.filter(([f]) => f >= START), ...order.filter(([f]) => f < START)] : order;
    seq.forEach(([, file], i) => fs.symlinkSync(file, path.join(frames, `seq${String(i).padStart(5, '0')}.jpg`)));
    const raw = path.join(frames, 'raw.gif'), out = path.join(outDir, whole ? 'dispatch.gif' : 'dispatch-try.gif');
    await ffmpeg(['-framerate', String(fps), '-i', path.join(frames, 'seq%05d.jpg'), '-filter_complex',
      `scale=${W}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full:max_colors=256[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      '-loop', '0', raw]);
    await new Promise((resolve, reject) => {
      const p = spawn('gifsicle', ['-O3', `--lossy=${lossy}`, '-o', out, raw], { stdio: 'inherit' });
      p.on('close', code => (code === 0 ? resolve() : reject(new Error('gifsicle exited ' + code))));
    });
    console.log('wrote', out, `(${(fs.statSync(raw).size / 1048576).toFixed(2)} MB before gifsicle, ${(fs.statSync(out).size / 1048576).toFixed(2)} MB after)`);
    if (whole) fs.rmSync(frames, { recursive: true, force: true });
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
