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

## Render

```sh
cd spikes/dispatch-pill-motion
node record.cjs stills 200 700 1150     # spot-check frames → out/stills/
node record.cjs video                   # → out/dispatch-pill.mp4 (~36 s)
```

Needs Playwright with its Chromium (`npm i -g playwright && npx playwright install chromium`) and
`ffmpeg` with libx264. `out/` is git-ignored (`spikes/*/out/`).
