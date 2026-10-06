'use strict';
// The soundtrack, composed to the cut: 120 BPM (a bar every 2 s, 18 bars), synthesised offline with
// Web Audio so every hit lands on the frame it belongs to. `window.MUSIC` carries the beat facts the
// picture moves with (kicks, impacts); `window.renderMusic()` renders the track and returns a WAV
// (base64) for record.cjs to mux under the video.
(function () {
  const BPM = 120, BEAT = 60 / BPM, BAR = 4 * BEAT, DUR = 36, SR = 48000;
  const range = (a, b, step) => { const out = []; for (let t = a; t < b - 1e-6; t += step) out.push(Math.round(t * 1000) / 1000); return out; };

  // ---- the arrangement (seconds) — the picture's events are timed to these
  const GROOVES = [[8, 13, 1], [16, 24, 1], [27.5, 31, 0.72]];        // [from, to, intensity]
  const KICKS = GROOVES.flatMap(([a, b, v]) => range(a, b, BEAT).map(t => ({ t, v })));
  const IMPACTS = [{ t: 3.0, a: 0.35 }, { t: 8.0, a: 0.6 }, { t: 16.0, a: 1 }, { t: 27.0, a: 0.65 }, { t: 29.5, a: 0.35 }, { t: 34.0, a: 1 }];
  const CH = {
    Cmaj9: [48, 55, 59, 62, 64], Fmaj9: [53, 57, 60, 64, 67], Am7: [57, 60, 64, 67], G6: [55, 59, 62, 64],
    Gsus4: [55, 60, 62, 67], Em7: [52, 55, 59, 62],
  };
  const ROOT = { Cmaj9: 36, Fmaj9: 41, Am7: 45, G6: 43, Gsus4: 43, Em7: 40 };
  const CHORDS = [
    [0, 2, 'Cmaj9'], [2, 4, 'Fmaj9'], [4, 6, 'Am7'], [6, 7, 'G6'], [7, 8, 'Gsus4'],
    [8, 10, 'Cmaj9'], [10, 12, 'Fmaj9'], [12, 14, 'Am7'], [14, 15, 'G6'], [15, 16, 'Gsus4'],
    [16, 18, 'Cmaj9'], [18, 20, 'Em7'], [20, 22, 'Fmaj9'], [22, 24, 'G6'],
    [24, 26, 'Am7'], [26, 28, 'Fmaj9'], [28, 29.5, 'Gsus4'], [29.5, 32, 'Cmaj9'],
    [32, 34, 'Fmaj9'], [34, 36, 'Cmaj9'],
  ];
  const chordAt = t => (CHORDS.find(([a, b]) => t >= a && t < b) || CHORDS[CHORDS.length - 1])[2];
  // How full the pad is, and how open its filter, through the piece.
  const PAD_SHAPE = [[0, 0.95, 1700], [2, 0.9, 2200], [8, 0.6, 2600], [13, 1.0, 2100], [16, 0.6, 2700], [20, 0.6, 3200],
    [24, 1.0, 2100], [27.5, 0.62, 2300], [32, 1.1, 3000], [34, 1.15, 3200]];
  // A quiet, bright layer two octaves up for the calm stretches (no drums there to carry the top end).
  const SHIMMER = [[0, 7.5], [13, 16], [24, 27.5], [31, 36]];
  const padShape = t => PAD_SHAPE.reduce((acc, row) => (t >= row[0] ? row : acc), PAD_SHAPE[0]);

  window.MUSIC = { BPM, BEAT, BAR, KICKS, IMPACTS };

  window.renderMusic = async function () {
    const ctx = new OfflineAudioContext(2, SR * DUR, SR);
    let seed = 0x2545F491;
    const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
    const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

    // Shared noise, and a generated stereo hall for the reverb.
    const NOISE = ctx.createBuffer(1, SR * 5, SR);
    { const d = NOISE.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1; }
    const IR = ctx.createBuffer(2, SR * 3, SR);
    for (let c = 0; c < 2; c++) {
      const d = IR.getChannelData(c); let lp = 0;
      for (let i = 0; i < d.length; i++) { const t = i / SR; lp += 0.35 * ((rand() * 2 - 1) - lp); d[i] = lp * Math.exp(-t / 0.75) * (t < 0.012 ? t / 0.012 : 1); }
    }

    // ---- buses: drums | bass + pad (ducked by the kick) | plucks | bells | fx  →  glue compressor
    const master = ctx.createGain(); master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.008; comp.release.value = 0.2;
    const fadeOut = ctx.createGain();
    fadeOut.gain.setValueAtTime(1, 0); fadeOut.gain.setValueAtTime(1, DUR - 0.9); fadeOut.gain.linearRampToValueAtTime(0, DUR - 0.05);
    // Mastering EQ: a touch less boom, a touch more presence and air.
    const lowShelf = ctx.createBiquadFilter(); lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 110; lowShelf.gain.value = -3;
    const highShelf = ctx.createBiquadFilter(); highShelf.type = 'highshelf'; highShelf.frequency.value = 3200; highShelf.gain.value = 4.5;
    master.connect(lowShelf).connect(highShelf).connect(comp).connect(fadeOut).connect(ctx.destination);
    const reverb = ctx.createConvolver(); reverb.buffer = IR;
    const reverbOut = ctx.createGain(); reverbOut.gain.value = 0.55; reverb.connect(reverbOut).connect(master);
    const delay = ctx.createDelay(1); delay.delayTime.value = 3 * BEAT / 4;          // dotted eighth
    const fb = ctx.createGain(); fb.gain.value = 0.34;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 3200;
    delay.connect(dlp).connect(fb).connect(delay);
    const delayOut = ctx.createGain(); delayOut.gain.value = 0.5; dlp.connect(delayOut).connect(master);
    const bus = (gain, rev = 0, dly = 0, ducked = false) => {
      const g = ctx.createGain(); g.gain.value = gain;
      g.connect(ducked ? duck : master);
      if (rev) { const s = ctx.createGain(); s.gain.value = rev; g.connect(s).connect(reverb); }
      if (dly) { const s = ctx.createGain(); s.gain.value = dly; g.connect(s).connect(delay); }
      return g;
    };
    const duck = ctx.createGain(); duck.gain.value = 1; duck.connect(master);
    const B = {
      drums: bus(0.85, 0.06), bass: bus(0.48, 0, 0, true), pad: bus(0.62, 0.35, 0, true),
      pluck: bus(0.6, 0.22, 0.3), bell: bus(0.58, 0.5, 0.22), fx: bus(0.6, 0.25),
    };

    // ---- instruments
    const noise = (t, dur) => { const s = ctx.createBufferSource(); s.buffer = NOISE; s.start(t, rand() * (5 - dur - 0.1)); s.stop(t + dur + 0.05); return s; };
    const filt = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q) n.Q.value = q; return n; };
    const pan = p => { const n = ctx.createStereoPanner(); n.pan.value = p; return n; };
    function noiseHit(t, dur, type, f, q, gain, dest, p = 0, attack = 0.001) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      noise(t, dur).connect(filt(type, f, q)).connect(g).connect(pan(p)).connect(dest);
    }
    function tone(t, f, dur, gain, dest, type = 'sine') {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(dest); o.start(t); o.stop(t + dur + 0.02);
    }
    function kick(t, v) {
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(165, t);
      o.frequency.exponentialRampToValueAtTime(55, t + 0.08); o.frequency.exponentialRampToValueAtTime(43, t + 0.32);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.75 * v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g).connect(B.drums); o.start(t); o.stop(t + 0.45);
      noiseHit(t, 0.014, 'highpass', 2600, 0, 0.1 * v, B.drums);
      // Sidechain: the pad and bass breathe around the kick.
      duck.gain.setTargetAtTime(1 - 0.55 * v, t, 0.004); duck.gain.setTargetAtTime(1, t + 0.06, 0.085);
    }
    function clap(t, v) {
      [0, 0.011, 0.023].forEach(d => noiseHit(t + d, 0.035, 'bandpass', 1900, 0.8, 0.6 * v, B.drums, 0.05));
      noiseHit(t + 0.03, 0.22, 'bandpass', 2300, 0.6, 0.32 * v, B.drums, 0.05);
    }
    const hat = (t, v, open) => noiseHit(t, open ? 0.2 : 0.045, 'highpass', 7200, 0, (open ? 0.2 : 0.17) * v, B.drums, open ? 0.18 : -0.14);
    const crash = (t, v) => noiseHit(t, 2.2, 'highpass', 5000, 0, 0.22 * v, B.drums, 0, 0.002);
    function snare(t, v) { noiseHit(t, 0.1, 'bandpass', 2100, 0.8, 0.35 * v, B.drums); tone(t, 195, 0.08, 0.1 * v, B.drums); }
    function pad(t0, t1, notes, level, cutoff) {
      const f = filt('lowpass', cutoff, 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(level, t0 + (t0 === 0 ? 1.6 : 0.4));
      g.gain.setValueAtTime(level, t1); g.gain.linearRampToValueAtTime(0.0001, t1 + (t1 >= DUR ? 0.05 : 0.8));
      f.connect(g).connect(B.pad);
      notes.forEach((m, i) => [-9, 0, 9].forEach((det, j) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det + (rand() - 0.5) * 4;
        const og = ctx.createGain(); og.gain.value = 0.06;
        o.connect(og).connect(pan([-0.45, 0, 0.45][j] * (i % 2 ? -1 : 1))).connect(f);
        o.start(Math.max(0, t0 - 0.02)); o.stop(Math.min(DUR, t1 + 0.85));
      }));
    }
    function bass(t, dur, m, v) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m);
      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = mtof(m);
      const f = filt('lowpass', 900, 2.5); f.frequency.setValueAtTime(1100, t); f.frequency.exponentialRampToValueAtTime(420, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.3 * v, t + 0.006); g.gain.exponentialRampToValueAtTime(0.17 * v, t + 0.12);
      g.gain.setValueAtTime(0.17 * v, t + dur - 0.03); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      const sg = ctx.createGain(); sg.gain.value = 0.45;
      o.connect(f).connect(g); sub.connect(sg).connect(g); g.connect(B.bass);
      o.start(t); sub.start(t); o.stop(t + dur + 0.02); sub.stop(t + dur + 0.02);
    }
    function pluck(t, m, v, p = 0, dur = 0.5) {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = mtof(m);
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = mtof(m) * 2;
      const g2 = ctx.createGain(); g2.gain.value = 0.14;
      const f = filt('lowpass', 5200, 0.7); f.frequency.setValueAtTime(5200, t); f.frequency.exponentialRampToValueAtTime(1500, t + 0.25);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.5 * v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f); o2.connect(g2).connect(f); f.connect(g).connect(pan(p)).connect(B.pluck);
      o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    }
    function shimmer(t0, t1, notes) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(1, t0 + 0.6); g.gain.setValueAtTime(1, t1); g.gain.linearRampToValueAtTime(0.0001, t1 + 0.6);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 4.0; const depth = ctx.createGain(); depth.gain.value = 0.35;
      const trem = ctx.createGain(); trem.gain.value = 0.65; lfo.connect(depth).connect(trem.gain);
      g.connect(trem).connect(B.pad); lfo.start(t0); lfo.stop(Math.min(DUR, t1 + 0.7));
      notes.slice(-2).forEach((m, i) => {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = mtof(m + 24);
        const og = ctx.createGain(); og.gain.value = 0.045;
        o.connect(og).connect(pan(i ? 0.35 : -0.35)).connect(g); o.start(t0); o.stop(Math.min(DUR, t1 + 0.7));
      });
    }
    function bell(t, m, v, p = 0) {
      const f0 = mtof(m);
      [[1, 1, 1.9], [2.756, 0.32, 0.7], [5.404, 0.1, 0.32], [2, 0.18, 1.1]].forEach(([ratio, amp, decay]) => {
        const o = ctx.createOscillator(); o.frequency.value = f0 * ratio;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.28 * v * amp, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        o.connect(g).connect(pan(p)).connect(B.bell); o.start(t); o.stop(t + decay + 0.05);
      });
    }
    function sweep(t0, t1, f0, f1, peak, shape) {   // a filtered-noise sweep: rise (riser), fall (downlifter) or swell-and-fade (whoosh)
      const f = filt('bandpass', f0, 1.3); f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(f1, t1);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
      if (shape === 'rise') { g.gain.exponentialRampToValueAtTime(peak, t1 - 0.02); g.gain.linearRampToValueAtTime(0.0001, t1 + 0.04); }
      else if (shape === 'fall') { g.gain.linearRampToValueAtTime(peak, t0 + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t1); }
      else { const mid = (t0 + t1) / 2; g.gain.exponentialRampToValueAtTime(peak, mid); g.gain.exponentialRampToValueAtTime(0.0001, t1); }
      noise(t0, t1 - t0 + 0.1).connect(f).connect(g).connect(B.fx);
    }
    function whoosh(t0, t1, v) {
      const f = filt('bandpass', 400, 1.1), mid = (t0 + t1) / 2;
      f.frequency.setValueAtTime(380, t0); f.frequency.exponentialRampToValueAtTime(2600, mid); f.frequency.exponentialRampToValueAtTime(420, t1);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.32 * v, mid); g.gain.exponentialRampToValueAtTime(0.0001, t1);
      noise(t0, t1 - t0 + 0.1).connect(f).connect(g).connect(B.fx);
    }
    function impact(t, a) {
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.9);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.7 * a, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(g).connect(B.fx); o.start(t); o.stop(t + 1.5);
      noiseHit(t, 0.7, 'lowpass', 1400, 0, 0.22 * a, B.fx, 0, 0.004);
    }
    const reverseSwell = (t0, t1, v) => sweep(t0, t1, 1200, 9000, 0.12 * v, 'rise');
    const keyClick = t => noiseHit(t, 0.018, 'bandpass', 3600, 1.4, 0.05, B.fx, (rand() - 0.5) * 0.3);
    function mouseClick(t) { noiseHit(t, 0.014, 'highpass', 2400, 0, 0.09, B.fx, 0.1); tone(t, 1300, 0.025, 0.03, B.fx); }
    function thock(t) { tone(t, 150, 0.07, 0.12, B.fx); noiseHit(t, 0.04, 'bandpass', 950, 1, 0.08, B.fx); }

    // ---- the score
    for (const [a, b, name] of CHORDS) {
      const [, level, cutoff] = padShape(a); pad(a, b, CH[name], level, cutoff);
      for (const [s0, s1] of SHIMMER) { const x0 = Math.max(a, s0), x1 = Math.min(b, s1); if (x1 > x0) shimmer(x0, x1, CH[name]); }
    }
    for (const k of KICKS) kick(k.t, k.v);
    for (const [a, b, v] of GROOVES) {
      for (let t = a; t < b - 1e-6; t += BEAT / 2) {     // bass: driving eighths, octave on the off-beat
        const off = Math.round((t - a) / (BEAT / 2)) % 2 === 1;
        bass(t, BEAT / 2 - 0.02, ROOT[chordAt(t)] + (off ? 12 : 0), v);
      }
      for (let t = a; t < b - 1e-6; t += BEAT) {
        const beatInBar = Math.round((t - a) / BEAT) % 4;
        if (v >= 1 && (beatInBar === 1 || beatInBar === 3)) clap(t, v);
        hat(t + BEAT / 2, v, true);
      }
    }
    for (const t of range(16, 24, BEAT / 4)) hat(t, 0.55, false);                  // sixteenths through the windows and the drop
    for (const t of range(3.5, 7.5, BEAT / 2)) hat(t, 0.45, false);                 // a light tick under the typing
    for (const t of range(27.5, 31, BEAT / 2)) hat(t, 0.4, false);
    range(15, 16, BEAT / 8).forEach((t, i, all) => snare(t, 0.15 + 0.75 * (i / all.length)));   // the roll into the windows
    crash(8, 0.6); crash(16, 1); crash(24, 0.45); crash(34, 0.8);
    // Plucked arpeggios: under the typing, through the drop, and under the report.
    const arp = (a, b, step, v, oct, pattern) => range(a, b, step).forEach((t, i) => {
      const notes = CH[chordAt(t)];
      pluck(t, notes[pattern[i % pattern.length] % notes.length] + oct, v, i % 2 ? 0.28 : -0.28, step * 2.2);
    });
    arp(3.5, 7.5, BEAT / 2, 0.5, 12, [0, 2, 1, 3, 2, 4, 3, 1]);
    arp(20, 24, BEAT / 4, 0.3, 12, [0, 1, 2, 3, 4, 3, 2, 1]);
    arp(27.5, 29.5, BEAT / 2, 0.34, 12, [0, 2, 3, 1]);
    // Moments.
    bell(0.3, 79, 0.6, -0.2); bell(0.55, 84, 0.5, 0.2);                             // the mark appears
    reverseSwell(1.3, 2.0, 0.8); whoosh(2.0, 2.7, 0.45);                            // into the desktop
    impact(3.0, 0.35); [65, 69, 72].forEach((m, i) => pluck(3.0 + i * 0.03, m, 0.34, (i - 1) * 0.3, 0.9));   // the pill pops up
    for (const t of (window.KEYSTROKES || [])) keyClick(t);
    sweep(6.9, 7.5, 500, 5000, 0.2, 'rise'); thock(7.5); whoosh(7.5, 8.1, 0.6);     // send
    impact(8, 0.6);
    bell(8.5, 76, 0.6, -0.3); bell(9.25, 79, 0.6, 0); bell(10.0, 84, 0.6, 0.3);     // three sessions rise out of the pill
    bell(11.0, 79, 0.42, -0.15); bell(11.0, 84, 0.42, 0.15); [72, 76, 79].forEach((m, i) => pluck(11.0, m, 0.3, (i - 1) * 0.3, 0.8));   // the reply
    thock(13.0); pluck(13.0, 79, 0.36); thock(13.5); pluck(13.5, 76, 0.36);          // esc, esc
    whoosh(14.0, 15.5, 0.75); sweep(14.5, 16.0, 350, 7000, 0.26, 'rise');            // the camera pulls back
    impact(16, 1);
    [16.0, 17.5, 19.0, 20.5].forEach(mouseClick);
    pluck(17.5, 81, 0.45, -0.2, 0.7); pluck(19.0, 84, 0.45, 0.2, 0.7);              // more windows
    [88, 91, 95].forEach((m, i) => bell(20.5 + i * 0.06, m, 0.32, (i - 1) * 0.3));   // a thinking pill opens
    bell(22.5, 84, 0.55, -0.25); bell(24.0, 88, 0.55, 0); bell(25.0, 91, 0.55, 0.25);   // done, done, done
    whoosh(26.0, 27.0, 0.6); sweep(26.25, 27.0, 6000, 260, 0.2, 'fall');            // in to the pill; the sessions sink
    impact(27.0, 0.65);
    impact(29.5, 0.35); bell(29.5, 84, 0.5, -0.15); bell(29.5, 88, 0.45, 0.15);    // the report
    whoosh(31.0, 32.3, 0.5);
    [79, 86, 91].forEach((m, i) => bell(33.0 + i * 0.08, m, 0.42, (i - 1) * 0.35));  // the mark
    reverseSwell(33.35, 34.0, 1);
    impact(34, 1); bell(34.0, 84, 0.5, -0.2); bell(34.0, 91, 0.4, 0.2);            // Winter

    const buf = await ctx.startRendering();
    // Peak-normalise to -1 dBFS and write 16-bit PCM WAV.
    const L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length;
    let peak = 1e-9; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const k = 0.891 / peak, bytes = new Uint8Array(44 + n * 4), dv = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true);
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 4, true);
    for (let i = 0, o = 44; i < n; i++, o += 4) {
      dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(L[i] * k * 32767))), true);
      dv.setInt16(o + 2, Math.max(-32768, Math.min(32767, Math.round(R[i] * k * 32767))), true);
    }
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { wav: btoa(bin), peak };
  };
})();
