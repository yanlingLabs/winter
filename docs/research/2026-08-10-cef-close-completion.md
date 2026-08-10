# What actually completes a CEF browser close — and the audio leak that proved it

**Date:** 2026-08-10 · **CEF:** `151.3.16+gbe1e15d+chromium-151.0.7922.109` (minimal, arm64) ·
**Measured on:** `main` @ `51a43124` (before) and its hotfix (after), Debug, scratch derivedData.

## The bug

Closing a panel tab started a browser close that never finished. The renderer process — and its
audio — survived until the app quit. Captured from the user's live run:

```
NormaCEF: browser created (id=1, live browsers=1)
NormaCEF: browser close handled by the host (DoClose->true, id=1)
NormaCEF: browser created (id=2, live browsers=2)
```

`DoClose` fired for id=1. **`OnBeforeClose` never did**, and the next create counted `live
browsers=2`.

## The mechanism

### 1. `DoClose → true` means CEF stops, completely

`cef_life_span_handler.h` documents `DoClose` as *"Called when an **Alloy style** browser is ready
to be closed"* — and ours receives it, so ours is Alloy style. In `AlloyBrowserHostImpl`:

```cpp
// CloseContents:
if (client_.get() && (IsWindowless() || !window_destroyed_)) {
  CefRefPtr<CefLifeSpanHandler> handler = client_->GetLifeSpanHandler();
  if (handler.get()) {
    close_browser = !handler->DoClose(this);
```

Answering `true` makes `close_browser` false, so neither destruction branch is taken and the
destruction state is reset. **Calling `CloseBrowser(true)` again does not help** — it re-enters
`CloseContents`, re-enters `DoClose`, gets `true` again, and resets again. Measured on this binary:
the repro's ledger shows `DoClose->true` printed **five times for two browser ids** with not one
`OnBeforeClose`.

### 2. The only remaining completion is one `-dealloc`

The header names two acceptable completions — *"by calling [Try]CloseBrowser() or by proceeding
with window/view hierarchy tear-down"* — and §1 just removed the first. On macOS the second is a
single object's destruction, from
`libcef/browser/native/browser_platform_delegate_native_mac.mm` (branch 7922):

```objc
@implementation CefBrowserHostView
@synthesize browser = browser_;

- (void)dealloc {
  if (browser_) {
    AlloyBrowserHostImpl::FromBaseChecked(browser_)->WindowDestroyed();
  }
}
@end
```

```cpp
void AlloyBrowserHostImpl::WindowDestroyed() {
  CEF_REQUIRE_UIT();
  DCHECK(!window_destroyed_);
  window_destroyed_ = true;
  menu_manager_.reset(nullptr);
  CloseBrowser(true);
```

`window_destroyed_ = true` is what makes the re-entrant `CloseBrowser(true)` different from every
earlier one: `CloseContents`'s guard `(IsWindowless() || !window_destroyed_)` is now false, so
`DoClose` is skipped and the browser is destroyed — `OnBeforeClose`.

The header says the same thing from the outside, twice, and it is easy to read as being about
detachment when it is about destruction:

- *"DoClose() will not be called if the browser's host window/view has already been **destroyed**
  (via parent window/view hierarchy tear-down, for example)"*
- Example 1, 9→10: *"Application's top-level window is destroyed, **triggering destruction of the
  child browser window**. 10. Application's OnBeforeClose() handler is called"*

**So: `removeFromSuperview` never completed a close. Dropping the last retain did.**

### 3. The regression

`51a43124` made `NormaCEFOpenBrowser.hostView` a **strong** reference to exactly that view, released
in `OnBeforeClose`. Circular wait: `OnBeforeClose` needs the view to deallocate; the view cannot
deallocate until `OnBeforeClose` releases it.

It also explains why the fix's own predecessor measurement went stale. B1 had measured that with the
detach block deleted, `OnBeforeClose` still fired — SwiftUI's release of the container discharging
the obligation. True at the time, and false from `51a43124` onwards, because a second strong
reference now sat where SwiftUI's release could no longer reach the view. What B1 measured was never
the detach; it was the release the detach happened to cause.

## The measurement

Harness: `apple/Norma/Sources/CEF/SpikeCloseLeak.swift` (`#if DEBUG`, `NORMA_SPIKE_CLOSE_LEAK=1`,
scratch Chromium profile). It creates a browser in the production `PanelCEFContainerView`, closes it
exactly as `PanelWebTab.dismantleNSView` does (three observers cleared → `NormaCEFCloseBrowser` →
container released), and holds CEF's own view **weakly**, so "did the close complete" is a fact about
object lifetime rather than an inference from a log.

| | before (`51a43124`) | after |
|---|---|---|
| CEF's host view after close | **alive for the whole 12.3 s run** | **deallocated within 290 ms** |
| container after close | released at +290 ms | released at +290 ms |
| `Norma Helper` children (renderers) | `6(2r)` → `6(2r)` | `6(2r)` → **`5(1r)`** |
| `browser closed (id=…)` | never | `live browsers=0` |
| `NormaCEFShutdown` drain | `2 browser(s) still open, 800 DoWork calls` | **`0 browser(s) still open`** |

The captured view's runtime class is literally `CefBrowserHostView` — the class whose `dealloc`
calls `WindowDestroyed()` — so the source identification is confirmed on this binary and not only
in the upstream tree.

**The shutdown path was never the exception.** It stalls identically; its bounded 50-turn drain did
not drain. Quitting silenced the audio because `CefShutdown()` tore the context down and the process
exited, taking its renderer children with it — not because the sweep completed a close.

## Facts later work can rely on

1. **`DoClose → true` transfers the whole completion obligation, and the only mechanism that
   discharges it on macOS is the deallocation of `CefBrowserHostView`.** Not detaching it; not
   calling `CloseBrowser` again.
2. **`CloseBrowser(true)` is idempotent to the point of uselessness after `DoClose → true`** — it
   re-runs `DoClose` and resets the destruction state every time.
3. **A close is asynchronous even after the release.** `removeFromSuperview` puts the view in an
   autorelease pool, so `OnBeforeClose` lands on a later turn (measured: under one 250 ms poll,
   never in the same turn). Anything that must observe a closed browser has to wait a turn.
4. **`Norma Helper` child count is a cheap, honest leak detector**: one renderer per live browser.
   `ps -ax -o ppid=,command=` filtered on this pid, `--type=renderer`.
5. **A strong reference to a CEF-owned view is a lifecycle decision, not a safety nicety.** Anything
   that retains one has to say when it lets go, and "at the callback" is exactly the wrong answer
   when the callback is downstream of the release.

## Re-running it

```sh
cd apple/Norma && xcodegen generate
xcodebuild -project Norma.xcodeproj -scheme Norma -configuration Debug \
  -destination 'platform=macOS' -derivedDataPath /tmp/dd build
NORMA_SPIKE_CLOSE_LEAK=1 NORMA_SPIKE_CEF_CACHE=/tmp/leak-cef \
  /tmp/dd/Build/Products/Debug/Norma.app/Contents/MacOS/Norma 2> /tmp/leak.log
grep -E '^(LEAK|NormaCEF:)' /tmp/leak.log
```

`NORMA_SPIKE_CLOSE_DEADLINE` (seconds, default 12) bounds the wait for the view to go. The run is
unattended and quits itself; it never touches `~/.norma*` and never uses the bundle-id Chromium
profile the user's live dev app holds an exclusive lock on.

## Limits

- Autoplay is refused without a user gesture (`title=audio refused: NotAllowedError`), so the run
  reproduces the **leaked renderer**, which is the mechanism, rather than the audible symptom. The
  user's tab had a gesture behind it; the surviving renderer is the same object either way.
- `AlloyBrowserHostImpl::DestroyBrowser` — the method that actually emits `OnBeforeClose` — was only
  retrievable in fragments. Nothing above depends on its internals: the measurement shows
  `OnBeforeClose` arriving iff the host view deallocates.
- Whether anything *other* than the record could retain CEF's host view (a platform-delegate member,
  say) is not established from source; it is answered behaviourally — with the record's reference
  dropped, the view deallocates, so nothing else held it in this configuration.
