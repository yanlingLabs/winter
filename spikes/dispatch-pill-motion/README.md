# Dispatch pill — motion video

A frame-stepped HTML recreation of the Mac app's Dispatch pill, rendered to a 1920×1080, 60 fps
video: the compact → typing → working pill, the child-session pills rising out of it, and the
pill-themed session windows stacking above it.

It is drawn from the Swift source rather than screen captures:

- **The plume** is `PropulsionPlume` / `WorkingAnimationModel` ported line for line
  (`apple/Winter/Sources/DispatchPill/WorkingAnimationView.swift`): the same seed, SplitMix64,
  puff and spark rates, lifetimes, travel exponents, glow, throw spacing and repeat cadence.
- **Geometry and motion**: `DispatchPillMetrics`, `dispatchPillMorphBlur`, `dispatchPillCornerRadius`,
  `childPillLayout`, `ChildPillEntrance` and `childRowSpring` (`DispatchPillLayout.swift`,
  `ChildSessionPillsView.swift`); the pill's spring is `morphStep` (140 / 22 at 60 Hz).
- **Windows**: `sessionWindowStackFrames` and the 0.32 s ease-out stack moves
  (`SessionWindowStack.swift`), `DetachedWindowRootView`, `PillChromeComposer`, the tool-pill
  wording of `pillToolLabel` (`PillToolRunHeader.swift`), and the thinking pills beside them
  (`PillThinkingHeader`: "Thinking" → the block's title → done; opened, `PillMorphChrome` morphs it
  into a rounded rect holding the reasoning as it streams, `PillThinkingText`).

Stand-ins: Inter for SF Pro (when SF is not available), hand-drawn glyphs for SF Symbols, and
monogram discs for site favicons. The story (prompt, sessions, tool calls) is scripted in
`scene.js`'s `CHILD_DEFS` and `EVENTS`.

**The soundtrack** (`music.js`) is composed to the cut and synthesised offline with Web Audio in the
same page: 120 BPM, a bar every 2 s. Pads, bass, plucked arpeggios, drums, bells and sweeps are
scheduled against the story — a chime for each session that rises out of the pill, the big hit on
the first window, a chime per finished session, the sink when Dispatch wakes, the logo hit at 34 s —
and the picture's events sit on the same beat grid. `window.MUSIC` (kicks, impacts) also drives a
small camera push on every kick and a bigger one on each impact.

## Render

```sh
cd spikes/dispatch-pill-motion
node record.cjs stills 200 700 1150     # spot-check frames → out/stills/
node record.cjs music                   # → out/music.wav (the soundtrack alone)
node record.cjs video                   # → out/dispatch-pill.mp4 (~36 s, with the soundtrack)
```

Needs Playwright with its Chromium (`npm i -g playwright && npx playwright install chromium`) and
`ffmpeg` with libx264 and aac, and gifsicle. `out/` is git-ignored (`spikes/*/out/`).

## The repository's README assets

The README's media come from the same render, so they never drift from the video:

```sh
node record.cjs gif         # → out/dispatch.gif            → assets/readme/dispatch.gif
node record.cjs card        # → out/social-preview.png      → assets/readme/social-preview.png
node lockup.cjs             # → out/lockup-on-{light,dark}.svg → assets/brand/
node record.cjs poster      # → out/poster.png (and poster@1080.png)
node record.cjs web         # → out/winter-dispatch.mp4     (after `video` and `poster`)
```

- **`gif`** is the README's moving picture: the whole cut, silent (`scene.html?silent` turns off the
  camera's push on the beat, which only makes sense with the music), 15 fps and 800 wide, about
  6 MB. It starts at 3.6 s, so its first frame (the heading and the pill) is a fair still while it
  loads or when autoplay is off, and wraps through the end card and the intro. It is a GIF because
  that is the one animated format Safari and GitHub's iPhone app play at the right speed: animated
  AVIF (4 MB) and animated WebP play slower and slower there, since Apple's decoders rebuild each
  frame from the last full one (and WebP's encoder also smears camera moves). One palette for the
  whole loop and ordered dithering keep what does not move byte-identical from frame to frame;
  gifsicle's lossy pass trims the rest.
- **`card`** is GitHub's 1280×640 social preview: the pills at 12.55 s, cut out of the video's own
  render (`scene.html?card` keeps the plume's tiles off the session titles so they read at
  thumbnail size), framed by `card.html`.
- **`lockup.cjs`** sets the mark and "winter" exactly as the end card does, as outlines (GitHub
  shows SVGs as images, without web fonts). Needs `opentype.js`.
- **`poster`** and **`web`** make the video with sound for GitHub's own player, which plays only
  videos uploaded through github.com (an MP4 in the repository just downloads, and GitHub's iPhone
  app shows even uploaded ones as a link): the full cut under the free plan's 10 MB upload cap, its
  first frame "Watch them work" at 21.6 s so the player shows a picture before you press play.
