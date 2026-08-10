#ifndef NormaCEF_h
#define NormaCEF_h

#import <AppKit/AppKit.h>

/// panel-cef Task 6a — the ENTIRE Swift-facing surface of the CEF embed.
///
/// Plain Objective-C and `extern "C"`, deliberately: the implementation is Objective-C++
/// (`NormaCEF.mm`) and every CEF type stays confined to it, so Swift never sees one and the
/// bridging header never drags a C++ header into a Swift compile. Task 1 measured this shape
/// working end to end (`docs/research/2026-08-09-cef-pump.md`, "The bridging seam is narrower than
/// expected"), and it retires the spike's flagged "C API vs. C++-via-ObjC++" fork: the shim keeps
/// C++ in one file, so the plain C API is not a fork Plan B needs to take.
///
/// **The `extern "C"` block is load-bearing.** Without it an `.mm` implementation gives these
/// definitions C++ mangling and Swift's C-linkage references fail to link with a wall of
/// undefined symbols — a measured cost of one build cycle in Task 1.
///
/// EVERY function here is safe to call when CEF was never loaded or initialised. That is not a
/// nicety: Debug/unit-test hosts never start CEF (`NormaCEFRuntime` refuses under XCTest), the
/// framework can fail to `dlopen`, and `CefInitialize` can fail — and none of those may take
/// Norma down. Failure degrades to a placeholder plus a log line, never `exit()`. (`cefsimple`'s
/// `return 1` shape is right for a sample whose only job is CEF, and wrong for a host app.)

#ifdef __cplusplus
extern "C" {
#endif

/// `dlopen` the vendored framework from `Contents/Frameworks` — `CefScopedLibraryLoader::
/// LoadInMain()`. Idempotent; returns YES if the framework is loaded after the call.
///
/// The framework is NEVER linked directly. `include/wrapper/cef_library_loader.h` documents that
/// as a requirement of the macOS sandbox implementation, not a style choice. Nothing else in this
/// header may be called before this returns YES.
BOOL NormaCEFLoadLibrary(void);

/// `CefInitialize` with `external_message_pump = true`, plus the pump this file owns.
/// `argc`/`argv` are the process's real ones (`CommandLine.argc` / `CommandLine.unsafeArgv`), so
/// Chromium's own command-line switches — `--remote-debugging-port`, `--disable-gpu`,
/// `--use-angle=swiftshader`, `--enable-logging=stderr --v=1` — work exactly as they do for any
/// Chromium app, with no Norma-side harness code to ship or gate.
///
/// Returns NO (and leaves `NormaCEFLastError` set) rather than aborting.
BOOL NormaCEFInitialize(int argc,
                        char **argv,
                        const char *rootCachePath,
                        const char *subprocessPath);

/// YES once `CefInitialize` has succeeded. `CefShutdown` is terminal for a process — CEF cannot be
/// re-initialised afterwards — so this never returns to NO; `NormaCEFDidShutdown` is the other half.
BOOL NormaCEFIsInitialized(void);

/// YES once `CefBrowserProcessHandler::OnContextInitialized` has fired. Task 1 measured it firing
/// SYNCHRONOUSLY inside `CefInitialize` on every run, contrary to expectation — but that is timing,
/// not contract, so browser creation is still queued behind it (`NormaCEFCreateBrowser`).
BOOL NormaCEFIsContextInitialized(void);

/// The last failure reason, for the placeholder the panel shows instead of a page. Never NULL.
const char *NormaCEFLastError(void);

/// Create a browser as a child of `parent` and navigate it to `url`. If the CEF context is not up
/// yet the request is QUEUED and replayed from `OnContextInitialized`; `parent` is held weakly, so
/// a view torn down before then simply drops out.
void NormaCEFCreateBrowser(NSView *parent, const char *url);

#pragma mark - Task 6b: the browser chrome's two channels

/// panel-cef Task 6b — a LIVE snapshot of one browser's chrome-relevant state.
///
/// This is the channel that feeds the URL field and the back/forward/reload buttons, and it is
/// deliberately SEPARATE from the navigation channel below. The two answer different questions and
/// must not be conflated:
///
///   * this one is what the user is looking at RIGHT NOW. It fires for same-page navigations
///     (fragments, `history.pushState`) and for every loading-state flip, because a URL field that
///     did not follow a `#section` jump would be visibly wrong;
///   * the other is what gets WRITTEN DOWN, forever, in a session log — and that is bounded to
///     committed top-level navigations precisely so it does NOT include the above.
@interface NormaCEFBrowserState : NSObject
/// The main frame's current address — including same-page changes. NEVER persisted from here.
@property(nonatomic, readonly, copy) NSString *url;
/// The page's current title. May be empty (a page with no `<title>`).
@property(nonatomic, readonly, copy) NSString *title;
@property(nonatomic, readonly) BOOL isLoading;
@property(nonatomic, readonly) BOOL canGoBack;
@property(nonatomic, readonly) BOOL canGoForward;
@end

/// Observe the live state of the browser hosted by `parent`. Called on the MAIN thread (CEF's UI
/// thread IS the main thread under the external pump). Pass `nil` to stop observing.
///
/// Registered against the CONTAINER VIEW rather than a browser id, because the container exists
/// before the browser does — creation is asynchronous and may be queued behind
/// `OnContextInitialized` — so a registration made at `makeNSView` time is already in place
/// whenever the browser finally arrives.
void NormaCEFSetStateObserver(NSView *parent, void (^observer)(NormaCEFBrowserState *state));

/// Observe COMMITTED TOP-LEVEL NAVIGATIONS of the browser hosted by `parent` — the producer behind
/// `panel.reportNavigation`, which had no caller at all from Plan A until this task.
///
/// **What "committed top-level navigation" resolves to in CEF, and why it is not a filter we
/// maintain:** this fires from `CefLoadHandler::OnLoadEnd` gated on `frame->IsMain()`.
/// `include/cef_load_handler.h` states the exclusions itself — the callback arrives "after a
/// navigation has been committed", and "will not be called for same page navigations (fragments,
/// history state, etc.) or for navigations that fail or are canceled before commit". So:
///
///   * **no subframes** — `IsMain()`. An ad iframe navigating itself 40 times is invisible here;
///   * **no in-flight redirects** — a server redirect never commits an intermediate URL, so only
///     the final destination is ever seen. (A *JavaScript* or `<meta>` redirect genuinely does
///     commit an intermediate page, and is correctly reported as its own navigation — it is a real
///     page the user visited, however briefly.);
///   * **no fragment changes** — CEF's own documented exclusion, above.
///
/// That bound is the whole reason a browsing session costs ~10-50 events rather than thousands in a
/// JSONL that is replayed on every session open and re-read whole by `panel.list`.
///
/// Consecutive duplicates are suppressed: a reload, or any commit landing on the same url+title as
/// the last one reported, does not fire again. `NormaCEFSeedTabState` below is what extends that
/// suppression across a browser's whole lifetime rather than just one instance of it.
void NormaCEFSetNavigationObserver(NSView *parent, void (^observer)(NSString *url, NSString *title));

/// Prime a tab with what the daemon ALREADY knows about it, before its browser is created. Two
/// effects, both of which exist because **one browser per tab is created and destroyed on every tab
/// SWITCH** (`PanelCEFView` is `.id`'d by tab):
///
///  1. **It suppresses the restore re-report.** A fresh browser has an empty dedupe memory, so
///     loading the tab's own persisted URL commits, fires `OnLoadEnd`, and reports a
///     `panel_tab_navigated` byte-identical to the one already in the log. A session spent flipping
///     between two tabs would append an event per flip — quietly erasing the ~10-50 bound the
///     navigation channel exists to hold, and doing it invisibly.
///  2. **It stops the URL field flashing empty.** The state observer publishes the current snapshot
///     the moment it is registered, and for a brand-new container that snapshot is blank; seeding
///     means the chrome shows the tab's known address from the first frame instead of going empty
///     and refilling a second later.
///
/// Pass the URL the browser is actually being created at — not the tab's raw stored value, if the
/// two differ because scheme policy refused it.
void NormaCEFSeedTabState(NSView *parent, const char *url, const char *title);

#pragma mark - Task 6b: the chrome's verbs

/// Back / forward / reload / stop, and "go to what the user typed". All are no-ops when `parent`
/// hosts no browser, and none of them validate `url` — **scheme policy lives in Swift**
/// (`PanelURLPolicy`), in one place, applied before anything reaches here. A C seam that silently
/// second-guessed its caller would make the real policy impossible to locate.
void NormaCEFGoBack(NSView *parent);
void NormaCEFGoForward(NSView *parent);
void NormaCEFReload(NSView *parent);
void NormaCEFStopLoad(NSView *parent);
void NormaCEFLoadURL(NSView *parent, const char *url);

/// The ONE answer `CefLifeSpanHandler::DoClose` gives, exported so a test can read the VALUE rather
/// than infer it from a log string.
///
/// It must be YES. CEF's default is `false`, which means "proceed with the default close behaviour"
/// — and `include/cef_life_span_handler.h` spells that out: "returning false from DoClose() will
/// send the standard close notification to the browser's top-level parent window (... performClose:
/// on OS X ...)". `cefsimple` and `cefclient` both return false because each OWNS an NSWindow per
/// browser. Norma hosts the browser inside a window it owns and shares with the whole shell, so CEF
/// must never be allowed near it: at the user's live gate, closing a panel tab closed the app's
/// window and demoted it out of the Dock, leaving only the menu-bar orb.
BOOL NormaCEFDoCloseIsHandledByHost(void);

/// Close the browser hosted by `parent` (and drop any queued request for it). Called from
/// `NSViewRepresentable.dismantleNSView`.
void NormaCEFCloseBrowser(NSView *parent);

/// Close every live browser. REVERSIBLE — this is what `-terminate:` calls, and a terminate can be
/// CANCELLED by `AppDelegate.applicationShouldTerminate` (⌘Q and dock-quit both return
/// `.terminateCancel` in Norma). Nothing here forecloses running CEF afterwards.
void NormaCEFCloseAllBrowsers(void);

/// `CefShutdown`. The POINT OF NO RETURN — CEF cannot be initialised again in this process, which
/// is exactly why this is not what `-terminate:` calls. `NormaCEFInitialize` registers this against
/// `NSApplicationWillTerminateNotification` itself, so the guarantee lives with the thing it
/// guards rather than in a line of `AppDelegate` that could be dropped. Safe no-op if CEF was never
/// initialised, and safe to call twice.
void NormaCEFShutdown(void);

/// YES once `NormaCEFShutdown` has run. Exists so a test can pin the no-op-before-init property
/// (`CEFRuntimeTests`) — the property that makes it safe to wire into the termination path at all.
BOOL NormaCEFDidShutdown(void);

/// How many times `CefDoMessageLoopWork()` has been called. Diagnostics only: this is the counter
/// Task 1's A/B used to measure the run-loop-mode trap (0 calls across 5s of event tracking with
/// the timer in the default mode alone).
long NormaCEFDoWorkCount(void);

#ifdef __cplusplus
}
#endif

#endif /* NormaCEF_h */
