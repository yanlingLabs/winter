# Reparenting a live CEF browser between a hidden window and a visible one

**Date:** 2026-08-10 · **Status:** measured in a scratch build of the real app; the harness is
committed (`apple/Norma/Sources/CEF/SpikeReparent.swift`, Debug-only, `NORMA_SPIKE_REPARENT=1`) ·
**Question:** the Browser Runtime spec (§3) rests on one AppKit/CEF interaction — that a live
windowed CEF browser survives having its container `NSView` moved between a hidden parking window
and a visible one, repeatedly, both directions, with audio playing, input working and the page
correctly sized. Does it?

**Short answer: yes, on every axis, with zero failures in 138 reparents across nine runs — and the
spec's stated *mechanism* is wrong.** Parking a browser in a hidden `NSWindow` does **not** make
Chromium think the page is hidden and does **not** throttle anything: `requestAnimationFrame`,
`setInterval` and CPU are *identical* parked and visible, and `document.visibilityState` stays
`"visible"`. That is good news for headless (§5) and a cost the cap in §4 has to be re-priced
against. Three further findings change what Task 5 has to write:

1. **A reparent fires no CEF callback at all** — not `OnLoadEnd`, not `OnAddressChange`, not
   `OnLoadingStateChange`. Task 5's fold logic has nothing to defend against here.
2. **First responder is destroyed by the move and must be restored by hand**, and the view to
   restore it to is **not** the one `NormaCEFCreateBrowser` parents in. Getting this wrong is
   silent: the wrong view accepts first-responder status and then delivers nothing.
3. **`NSWindow.sendEvent` cannot be used to drive a CEF browser** — it bypasses
   `NormaApplication.sendEvent:` and therefore `CefScopedSendingEvent`. 40 of 40 keystrokes
   vanished before this was found.

---

## What was run

| | |
|---|---|
| Machine / OS | arm64 Mac, macOS 26.6.1 (Darwin 25.6.0) |
| CEF | `151.3.16+gbe1e15d+chromium-151.0.7922.109` (the vendored minimal distribution) |
| Build | the **real app**, Debug, `-derivedDataPath /private/tmp/norma-dd-spike` |
| Isolation | `NORMA_HOME=$(mktemp -d)` per run; Chromium profile `/private/tmp/norma-spike-cef` |
| Launch | the raw executable from a terminal (never `open`), stderr to a file |
| Page | a file:// page the spike writes, instrumenting itself (see "the page" below) |

Nine runs, 138 reparents (42+42+10+12+6+18+8), **not one failure of any kind** — no crash, no blank
browser, no lost page, no reload, no geometry error:

| run | park mode | shape | what it answered |
|---|---|---|---|
| 1, 2 | never ordered in | 20 cycles + 40 s park / 40 s show | the brief's 20-each-direction; audio, resize, callbacks, CPU |
| 3 | never | 4 cycles, synthetic click before keys | input works at all |
| 4 | never | 5 cycles, **no** click | is `makeFirstResponder` alone enough? |
| 5 | ordered-out | 2 cycles + 40 s park / 40 s show, unsliced | first look at a non-`never` park mode; produced the 565 ms wobble §1 cites, and is why 6–8 are sliced |
| 6–8 | never / ordered-out / offscreen | 2 cycles + 40 s park / 40 s show, sliced at 5 s, back to back | occlusion throttling, per-mode CPU, where audio drift lives |
| 9 | never | 3 cycles + window screenshots at ~11 Hz | white flash / stale layer |

`NORMA_SPIKE_PARK_MODE` covers the three plausible parking shapes: **never** ordered in at all (the
spec's literal wording), **ordered-out** (ordered front once, then `orderOut:`), and **offscreen**
(positioned at −20000, −20000 and ordered front).

**How the page reports.** `NormaCEF.h` exposes no JS evaluation and `javascript:` never enters a
load path, so the one channel out of a page is `document.title` →
`CefDisplayHandler::OnTitleChange` → the container's state observer. The page publishes a
pipe-delimited payload 4×/s carrying: sequence, `performance.now()`, accumulated `<audio>` media
time, `AudioContext.currentTime`, rAF count, timer ticks, key count, `document.visibilityState`,
`innerWidth`/`innerHeight`, paused flag, `AudioContext.state`, `document.activeElement.id`, the
text field's length, the last key, and a per-sample background colour. Audio is two independent
paths on purpose: a looping `<audio>` element (what a real page uses) and a Web Audio oscillator
(whose `currentTime` **is the audio hardware clock**, and therefore the strictest continuity probe
available).

---

## 1. Audio continuity — continuous, measured two ways

`wall − AudioContext.currentTime`, which steps permanently the instant audio is suspended:

| run | reparents | drift range over the whole run |
|---|---|---|
| 1 | 42 | **129 – 134 ms** over 235 s |
| 2 | 42 | **124 – 133 ms** over 235 s (reproduced) |

Five milliseconds of spread across 235 seconds and 42 reparents. In the 5-second-sliced runs 6–8
the per-slice delta is **±3 ms in every slice of every phase of every park mode with exactly two
exceptions** — two consecutive mid-park slices in run 6 (`never`), analysed in the next paragraph.
**No reparent, in any run, produced a step in either clock.**

Two wobbles were seen and neither is a reparent artefact. Both happened in the *middle of a long
park*, nowhere near a move: 72 ms + 88 ms lost across two consecutive 5-second slices (run 6,
`never`), and ~565 ms accumulated across one 40-second park (run 5, `ordered-out`, sampled
too coarsely to localise — which is why runs 6–8 are sliced). Both are bounded, non-recurring,
sub-1.5 % clock wobbles with both clocks still advancing — CoreAudio wobble, not a dropout. Six
long parks, two wobbles, zero long-show wobbles; too small a sample to call it park-related, and
too small an effect to matter if it is.

**The `<audio loop>` media clock loses ~88 ms per loop iteration** — uniformly, identically parked
and visible, with no step at any reparent. That is Chromium's re-seek gap at a loop boundary, and
it is the one number here that looks alarming (19 s "lost" over a 235 s run) and means nothing.
Anyone re-running this harness should expect it.

**Honest limit:** continuity is established *instrumentally*, by two clocks. Nobody listened. A
by-ear confirmation is still the human's to make — though `AudioContext.currentTime` advancing at
wall-clock rate for 235 s is direct evidence that CoreAudio was pulling buffers the entire time.

## 2. Input after reparent — works, but ONLY after an explicit re-focus of the right view

The view chain under a container, dumped live:

```
PanelCEFContainerView
  > CefBrowserHostView        acceptsFirstResponder = NO     ← what SetAsChild parents in
    > WebContentsViewCocoa    acceptsFirstResponder = NO
      > RenderWidgetHostViewCocoa  acceptsFirstResponder = YES ← the only one that takes keys
```

| after attach, before typing | keystrokes delivered |
|---|---|
| nothing (first responder is the `NSWindow`) | **0** — run 4, every cycle |
| `makeFirstResponder(RenderWidgetHostViewCocoa)` | **all of them** — run 4 1/1 × 5 cycles, run 3 2/2 × 4 cycles |
| a synthetic click into the page | also all of them (the click makes the same view first responder) |

Every attach logs `frBefore=NSWindow frAfter=NSWindow`: **the move destroys first-responder status
and attaching does not restore it.** The host must restore it.

**DOM focus, by contrast, survives untouched.** `document.activeElement` stayed the page's text
field across all 42 reparents of run 1, and the characters typed after re-focus land in that same
field (`field.value.length` grows 1:1 with keys). So the user's caret position is not lost — only
AppKit's first responder is.

**Two traps, both silent.** `makeFirstResponder(CefBrowserHostView)` — the natural choice, since
that view *is* `container.subviews.first` and is what `GetWindowHandle()` returns — **succeeds**
(returns `true`, and the window reports it as first responder) and then delivers nothing. And
`NSWindow.sendEvent` delivers nothing either, because it bypasses `NSApplication.sendEvent:`, which
is exactly where `NormaApplication` (the `CefAppProtocol` subclass `main.swift` exists to install)
wraps dispatch in `CefScopedSendingEvent`. Runs 1 and 2 combined both mistakes and lost 40 of 40
keystrokes with every log line looking green.

## 3. Resize after reparent — exact, every time

The parking window is deliberately 700×500 and the visible window alternates 1000×700 / 820×560, so
**every** move is also a resize. At all 42 measurement points of run 1 the container's frame,
`CefBrowserHostView`'s frame and the page's own `window.innerWidth`/`innerHeight` agreed exactly —
`{{0,0},{820,560}}` / `{{0,0},{1000,700}}` / `{{0,0},{700,500}}` and `820|560` / `1000|700` /
`700|500`. No lag, no stale geometry, no half-resized frame.

**Brief correction:** the container's autoresize path is
**`PanelCEFContainerView.resizeSubviews(withOldSize:)`**, not `layout()`. `layout()` only positions
the CEF-unavailable placeholder label and its retry button.

## 4. CPU parked vs visible — THE SPEC'S THROTTLING ASSUMPTION IS FALSE

Three park modes, back to back under identical conditions, 37-second windows, summed over app +
GPU + renderer + utility processes (100 % = one core):

| park mode | parked | visible | parked ÷ visible |
|---|---|---|---|
| never ordered in | 24.7 % | 25.4 % | **0.97** |
| ordered front then `orderOut:` | 24.7 % | 24.6 % | **1.00** |
| positioned offscreen | 23.8 % | 25.8 % | **0.92** |
| run 2 (`never`, a 30 fps environment) | 12.8 % | 13.2 % | **0.97** |

**The right-hand column is the finding; the left two are not constants.** The absolute cost tracks
the display's refresh state — the same page, the same code, measured at 12.8 %/13.2 % in run 2 and
24.7 %/25.4 % in run 6, a ~2× swing driven by something the spike does not control (§"Environment
note" below). What survives across that swing is the ratio: **parked costs what visible costs, in
every run that measured both.** Within any one run the renderer's own share is 5.0–9.8 % and the
GPU process's 6.2–14.3 %, moving together with the absolute. Peak RSS (run 2, and RSS does *not*
swing with refresh state): app 207 MB, renderer 148 MB, GPU 112 MB, utility 88 MB.

The page-side counters say why:

| | parked | visible |
|---|---|---|
| `requestAnimationFrame` | **120.0 fps** | 120.0 fps |
| `setInterval(…, 250)` | 4.00 Hz | 4.00 Hz |
| `document.visibilityState` | **`"visible"`** | `"visible"` |

In all three park modes. **A hidden `NSWindow` does not make Chromium consider the page hidden.**
Spec §3's "occlusion throttles *rendering* while JS, network and audio keep running" describes a
mechanism that does not engage here — nothing throttles, in either direction. What the spec wanted
(JS, network and audio keep running while parked) is delivered in full and then some; what it
assumed would pay for it is not.

Consequences worth carrying into Task 5 / §4:

- **Headless is stronger than the spec promised.** A parked, agent-driven page runs at full rate:
  no background-tab timer throttling, no rAF suspension, no intensive-throttling cliff after 5
  minutes. Anything B2 drives behaves exactly as it would on screen.
- **`browserMaxLive = 16` needs re-pricing — but price it in RATIOS, not in this document's
  percentages.** The durable fact is that a parked browser is not cheap-by-occlusion: it costs
  **1.0× what the same page costs visible**. What that multiplies is whatever a real page actually
  costs on the user's machine, which this spike cannot tell you: the same page measured 12.8 % and
  24.7 % of a core in two runs of the *same* build, and it is deliberately pathological besides (a
  full-rate rAF canvas plus two audio sources). A parked *idle* page still costs what an idle page
  costs. The design consequence needs no absolute number: sixteen live browsers cost sixteen
  browsers' worth of work whether or not anyone is looking at them, and the runtime cannot assume
  the parked ones are idle — which is precisely the case §4's cap exists for.
- The linger (§4) and the cap are therefore doing more work than the spec thought, not less.

**Measurement note:** `ps -o %cpu` is a **lifetime average**, not an instantaneous rate — the first
sampler used it and produced numbers that cannot answer a phase question at all. The figures above
come from differencing cumulative `ps -o time` at 1 Hz.

**Environment note:** runs 1–2 recorded 30.0 fps in *both* phases and runs 6–8 recorded 120.0 fps in
*both* phases. The absolute number tracks the display's refresh state, which is outside the spike's
control; only the within-run parked-vs-visible comparison is used anywhere in this document, and it
is flat in all six runs that measured it.

## 5. CEF callbacks fired by a reparent — none, in 42 reparents

`NotifyState` is one channel with four producers (`OnTitleChange`, `OnAddressChange`,
`OnLoadingStateChange`, `OnLoadEnd`), so the observer alone cannot say which fired. The page mutates
its title 4×/s with a monotonic sequence number, which makes them separable exactly: a callback
carrying a title **identical** to the previous one provably did not come from `OnTitleChange`.

Run 1, 235 seconds, 42 reparents: **six** such callbacks, all at t < 400 ms, all part of the
initial load (`loading` false→true→…→false as the file:// page committed). Not one after any
reparent. The navigation observer (`OnLoadEnd` + `IsMain()`, the producer behind
`panel.reportNavigation`) fired **exactly once in the entire run** — the initial commit.

For Task 5 this closes a whole class of worry: reparenting cannot append a `panel_tab_navigated`,
cannot flip `isLoading`, cannot make the URL field flash, and cannot re-enter the fold.

## 6. Window-server behaviour — the first frame after attach is already live and current

The page paints its background a different colour every 250 ms and reports that colour in its
payload, so a screenshot decodes to *the frame the window server is actually showing*. Run 9
captured the visible window at ~11 Hz (87–105 ms apart) through three attaches; 286 frames, decoded
after converting each PNG from the display profile to sRGB (raw pixels do **not** match the CSS
values — max residual after conversion 2.2/255, mean 0.7).

At every one of the three attaches the sequence is: blank window, blank window, **then a frame
carrying a current, live page colour** (decoded sequence 7, 36, 65), which then advances
monotonically (7→8→9, 36→37→38, 65→66→67). Across all 286 frames: **zero backward jumps, zero
white or partial frames after an attach, zero repeated-stale runs.** The window's pixel size changes
in the same frame the content appears (2000×1464 ↔ 1640×1184), i.e. the resize and the correct
content land together.

**Bound:** the capture cadence is ~90 ms, so a flash shorter than that is not excluded by this
evidence. Nothing suggests one — no callback, no reload, no rAF interruption, correct geometry from
the first instant — but the honest claim is "no flash at ≥90 ms resolution", not "no flash".

## 7. Two facts that came free

- **A browser created into a parked container loads normally.** The spike creates the browser while
  the container is in the never-ordered-in parking window: `load end (status=200)`, the page runs,
  and audio is playing *before the first attach ever happens*. Spec §5's headless path and B2's
  agent-driven browsers both need this and now have it measured.
- **Quitting with a browser parked is clean.** Every run ends by terminating with the container in
  the parking window: `browser close handled by the host (DoClose->true)` → `shutting down` →
  `browser closed (id=1, live browsers=0)`, process gone. "No stranded helpers" is not an inference
  from those log lines — it is the CPU sampler's silence: in run 8 (the last of the back-to-back
  sequence, so nothing else could reoccupy the filter) the sampler's final row is **1.2 s after the
  QUIT line**, and it then polled `ps` at 1 Hz for a further **15.9 s and matched nothing at all** —
  no app, renderer, GPU, utility or helper process of the spike bundle survived. That is live gate
  7's shape, passing.

---

## Traps found (the section the B1 spikes taught this document to have)

1. **Chromium's `root_cache_path` lock is exclusive and bundle-id-scoped, and the hazard is
   bidirectional.** `NormaCEFRuntime.rootCachePath()` derives from the bundle id, and a Debug spike
   build carries the *same* bundle id as the user's live dev app. Whichever process initialises
   second fails with exit code 24 — so a careless spike does not merely fail, it can break the
   browser panel of the app the user is working in. The harness takes a scratch profile
   (`NORMA_SPIKE_CEF_CACHE`) and calls `NormaCEFInitialize` directly for exactly this reason.
2. **`NSWindow.sendEvent` silently loses every event destined for CEF** (§2).
3. **`makeFirstResponder` on the wrong view succeeds and delivers nothing** (§2).
4. **A reparent resets first responder to the window** (§2) — the *only* thing about input that a
   reparent breaks, and it breaks it every single time.
5. **`ps -o %cpu` is a lifetime average** and cannot answer a phase question (§4).
6. **The container's autoresize path is `resizeSubviews(withOldSize:)`, not `layout()`** (§3).
7. **Hidden ≠ occluded ≠ throttled** (§4) — the spec's cost model needs correcting.
8. **`<audio loop>` loses ~88 ms per loop in Chromium** (§1) — a 19-second "gap" that is not one.
9. **Screenshots of a CEF window need ICC conversion before their colours mean anything** (§6).
10. **`NotifyState` is one channel for four producers**; only a monotonically-changing title
    separates them (§5). Any future test that wants to know *which* CEF callback fired needs this
    trick or an equivalent.
11. **The spike must run INSTEAD of `boot()`, not after it.** `boot()` registers an `SMAppService`
    helper, a login item, launchd migration, the updater and a menu-bar orb — all account-global,
    all pointed at whatever bundle is executing, which for a spike is a scratch `derivedData` path
    that gets deleted.

## Facts later tasks may rely on

1. **Reparenting a live windowed CEF browser between a hidden parking window and a visible one is
   safe, repeatable in both directions, and preserves audio, DOM focus, page state and geometry.**
   138 reparents, nine runs, zero failures. The spec's §3 assumption holds.
2. **`attachViewport` must call `window.makeFirstResponder(…)` on the container's
   `RenderWidgetHostViewCocoa` descendant**, or the shown tab takes no keyboard input. Attaching
   alone leaves the window as first responder. That view is *not* `container.subviews.first` and
   *not* `GetWindowHandle()`'s view — both of those are the outer `CefBrowserHostView`, which
   accepts first-responder status and then delivers nothing.
   **Find it by identity, not by depth.** The harness takes "the last
   `acceptsFirstResponder` view in a pre-order walk", which happens to equal
   `RenderWidgetHostViewCocoa` only because the single spine measured here is three views deep with
   exactly one candidate at the bottom. Chromium's view tree is not Norma's to promise: Task 3
   should search for the descendant whose class is `RenderWidgetHostViewCocoa` (or, more durably,
   the one conforming to `NSTextInputClient` — that conformance is what makes it the view that can
   take a keystroke) and log loudly if it finds zero or more than one.
3. **Reparenting fires no CEF callback**, so the fold, the navigation channel and the chrome's URL
   field need no defence against attach/detach.
4. **Resize is handled entirely by `PanelCEFContainerView.resizeSubviews(withOldSize:)`** — set the
   container's frame after `addSubview` and the page follows exactly. Nothing else is needed.
5. **Move the container with a single `addSubview`; never `removeFromSuperview` first.** The spec's
   "in a window at all times" invariant is what was measured, and it is what AppKit's `addSubview`
   already does when the view has another superview.
6. **A parked browser is NOT throttled and NOT cheap.** rAF, timers and CPU are identical to
   visible; `document.visibilityState` stays `"visible"`. Good for headless, and the reason §4's cap
   and linger matter more than the spec assumed. If a future pass *wants* throttling, none of the
   three obvious window shapes (never-ordered-in, ordered-out, offscreen) provides it — it would
   have to come from `CefBrowserHost::WasHidden()`, which is not on `NormaCEF.h` today.
7. **A browser created into a parked container loads and runs normally** — headless creation needs
   no visible window at any point.
8. **Quit with parked browsers is clean** (`DoClose->true`, registry drains, no stranded helpers).
9. **The park mode does not matter.** never-ordered-in, ordered-out and offscreen were measured
   back to back and are indistinguishable on audio, rAF, timers, visibility and CPU. Task 5 should
   take the simplest — never ordered in — and this document is why that is not a guess.
10. **Two limits ride with this list; do not lift facts 1 and 6 without them.**
    (a) **Audio continuity is proven instrumentally, not by ear** — two clocks, no listener. A
    by-ear pass on a real page is still a human live-gate item and nothing here discharges it.
    (b) **"No white flash / no stale layer" is bounded at the ~90 ms screenshot cadence** (§6). A
    flash shorter than that is not excluded by any evidence in this document.
11. **The absolute CPU and fps numbers in §4 are environment-bound and must not be quoted as
    constants** — the same page measured 12.8 % and 24.7 % of a core in two runs of the same build.
    Only the within-run parked-vs-visible ratio (1.0×) is durable.

## Re-running the harness

```sh
cd apple/Norma && xcodegen generate && xcodebuild -project Norma.xcodeproj -scheme Norma \
  -configuration Debug -destination 'platform=macOS' -derivedDataPath /private/tmp/norma-dd-spike build

NORMA_HOME=$(mktemp -d) NORMA_PROFILE=dev NORMA_SPIKE_REPARENT=1 \
NORMA_SPIKE_CEF_CACHE=/private/tmp/norma-spike-cef \
  /private/tmp/norma-dd-spike/Build/Products/Debug/Norma.app/Contents/MacOS/Norma \
  --autoplay-policy=no-user-gesture-required 2>&1 | tee /tmp/spike.log
```

`--autoplay-policy=no-user-gesture-required` is what makes the run unattended; it reaches Chromium
because `NormaCEFInitialize` is handed the process's real `argv` (`NormaCEF.h`). Without it the page
shows a Start button and waits for a click, and the cycle loop refuses to begin until the page's
audio clock proves audio is actually playing — never on a fixed delay, so a run where autoplay
silently failed cannot produce twenty green cycles proving nothing.

Knobs: `NORMA_SPIKE_CYCLES` (default 20), `NORMA_SPIKE_LONG_DWELL` (40 s),
`NORMA_SPIKE_PARK_MODE` (`never` | `ordered-out` | `offscreen`), `NORMA_SPIKE_NO_CLICK=1`.

**With the CPU sampler, and then the derivation** — §4's table needs both halves, so start the
sampler about a second before the app and hand both files to the analyser afterwards:

```sh
REF=docs/research/reference/2026-08-10-cef-reparent-spike
"$REF"/cpusample.sh 330 > /tmp/cpu.txt &        # 1 Hz, filtered to the spike bundle only
sleep 1
NORMA_HOME=$(mktemp -d) NORMA_SPIKE_REPARENT=1 … /…/Norma > /tmp/spike.log 2>&1
python3 "$REF"/analyze-spike-ledger.py /tmp/spike.log /tmp/cpu.txt
```

`analyze-spike-ledger.py` prints, per long phase, exactly the numbers §1/§4/§5 quote: rAF fps,
`setInterval` Hz, `document.visibilityState`, `wall − AudioContext.currentTime` with its per-slice
deltas, CPU as % of one core by process role, and the non-`OnTitleChange` state-callback count. It
reproduces every published figure from all nine ledgers, including the two pre-slicing runs
(`cpusample.sh` refuses `%cpu` input outright — trap 5).

**One piece of evidence is NOT re-derivable: §6's frames.** The 286 PNGs were captured to a session
scratch directory and are gone; the analysis (decoded sequence numbers 7/36/65, zero backward jumps,
no white frames) survives only as this document's claim. Re-establishing it means re-running with
an external `screencapture -x -o -l<windowNumber>` loop against the window number the ledger's
`SHOWWINDOW` line reports, and decoding each PNG's background colour **after** converting it from
the display profile to sRGB (raw pixels do not match the CSS values). The nine ledgers and their
CPU samples are likewise session-scratch; the tooling above is committed so that any future run
regenerates them rather than depending on files nobody kept.

**The gate is inert.** With `NORMA_SPIKE_REPARENT` unset the whole file is unreachable and in
Release it is not compiled at all (`#if DEBUG`). Proven: the app suite is **1324 passed, 0 failed**
and `packages/core` `tsc --noEmit` reports its usual **6** pre-existing errors (all in
`test/agent/approvals.test.ts`; this task changed no TypeScript).
