#import "NormaCEF.h"

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

#include <climits>
#include <cstdarg>
#include <cstdio>
#include <string>
#include <unistd.h>
#include <vector>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_library_loader.h"

// panel-cef Task 6a — CEF driven from the run loop SwiftUI already owns.
//
// PROVENANCE. The pump below is a port of CEF 151.3.16's own
// `tests/shared/browser/main_message_loop_external_pump.cc` (the algorithm) and
// `_mac.mm` (the NSTimer), read from the STANDARD distribution — both live under `tests/shared/`,
// which the minimal distribution this repo vendors does not ship, so they are VENDORED here, not
// referenced. Task 1 ran this exact port and proved a page renders
// (`docs/research/2026-08-09-cef-pump.md`).
//
// THE ONE SUBSTANTIVE DEVIATION FROM CEF'S SAMPLE: `MainMessageLoopExternalPumpMac::Run()` calls
// `[NSApp run]` itself. We never do. SwiftUI owns the run loop and calls `[NSApp run]` exactly
// once, as it always has; there is no `CefRunMessageLoop()` anywhere in this file. No CEF sample
// demonstrates this shape — every one of them owns the application's run loop — which is why
// Task 1 existed at all.
//
// THREE LOAD-BEARING DETAILS, each measured rather than argued:
//
//   1. THE TIMER IS REGISTERED IN `NSRunLoopCommonModes` **AND** `NSEventTrackingRunLoopMode`.
//      A timer in the default mode alone — what `Timer.scheduledTimer` gives you — performs
//      **0 `DoWork` calls across 5 seconds of event tracking**, measured A/B. That is not a
//      slowdown; it is a total freeze of the browser, every animation, every network callback and
//      every paint, for the entire duration of any window drag, scroll or menu track. Task 1 also
//      records that it never established WHICH of the two registrations does the work (common
//      modes alone was never tested), so both stay, exactly as CEF writes them.
//
//   2. THE 33 ms CEILING IS CEF's OWN `1000 / 30`, not a tuned value. Task 1 swept it: the pump
//      rate tracks the ceiling linearly (61.1 / 30.3 / 10.4 per second at 16 / 33 / 100 ms) but
//      CPU does NOT move monotonically (2.6% / 1.3% / 3.4% of one core across all six processes),
//      so between-run noise dominates and the interval is not what decides cost. 33 ms bounds
//      worst-case input-to-paint latency at one 30fps frame. Do not "optimise" it.
//
//   3. THE RE-ENTRANCY REPOST. `CefDoMessageLoopWork()` re-enters this pump through paint and IPC
//      callbacks; a discarded call must be REPOSTED, never dropped (`PerformMessageLoopWork`).
//
// TASK 6b ADDS: the two observer channels behind the browser chrome (live state for the URL field
// and the buttons; committed top-level navigations for `panel.reportNavigation`), the chrome's
// verbs, and the logging-privacy treatment below. URL-SCHEME POLICY AND FIELD CAPS DELIBERATELY DO
// NOT LIVE HERE — they are Swift's (`PanelURLPolicy`), expressed once, because a C seam that
// silently second-guessed its caller would make the real policy impossible to locate.

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

namespace {

// stderr. Launched by LaunchServices this goes nowhere; launched by explicit path from a terminal —
// the only way this branch's dev app is ever started — it is the diagnostic channel for
// `LoadInMain`, `CefInitialize` and the versioned-framework resource paths, none of which had ever
// run inside Norma before Task 6a.
//
// **Task 6b: URLs are logged in DEBUG BUILDS ONLY, and never in a shipped one.** Every call site
// below that would name a page splits into a `#if DEBUG` arm carrying the URL and a release arm
// that does not. "stderr goes nowhere under LaunchServices" is a true statement about a default,
// not a privacy guarantee — it is one `open -W` or one crash-reporter capture away from being
// false — and a user's browsing history is exactly the class of data this repo keeps off disk by
// construction (provider `encrypted_content` has the same rule). Chromium's own logging is closed
// off separately, at `CefSettings.log_severity`/`log_file` in `NormaCEFInitialize`.
void Log(const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  fprintf(stderr, "NormaCEF: ");
  vfprintf(stderr, fmt, args);
  fprintf(stderr, "\n");
  va_end(args);
  fflush(stderr);
}

}  // namespace

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

namespace {

// Verbatim from main_message_loop_external_pump.cc. "Intentionally 32-bit for Windows and OS X
// platform API compatibility" — CEF's own comment.
const int32_t kTimerDelayPlaceholder = INT_MAX;

// CEF's own: "The maximum number of milliseconds we're willing to wait between calls to DoWork()".
const int64_t kMaxTimerDelay = 1000 / 30;  // 30fps

bool g_library_loaded = false;
bool g_initialized = false;
bool g_context_initialized = false;
bool g_shutting_down = false;
bool g_did_shutdown = false;
long g_do_work_count = 0;
std::string g_last_error;

// Live browsers, in creation order. Populated in OnAfterCreated, drained in OnBeforeClose — both
// on the UI (= main) thread, so no lock is needed and none is taken.
std::vector<CefRefPtr<CefBrowser>> g_browsers;

}  // namespace

/// A browser creation requested before `OnContextInitialized`. `parent` is WEAK on purpose: a
/// panel tab torn down while the request is queued must not keep a dead view alive, and must not
/// get a browser parented into it either — the replay skips entries whose parent has gone.
@interface NormaCEFPendingBrowser : NSObject
@property(nonatomic, weak) NSView *parent;
@property(nonatomic, copy) NSString *url;
@end

@implementation NormaCEFPendingBrowser
@end

static NSMutableArray<NormaCEFPendingBrowser *> *g_pending = nil;

// ---------------------------------------------------------------------------
// Task 6b: the per-tab bridge — live state, the two observers, and the dedupe memory
// ---------------------------------------------------------------------------

@interface NormaCEFBrowserState ()
@property(nonatomic, copy) NSString *url;
@property(nonatomic, copy) NSString *title;
@property(nonatomic) BOOL isLoading;
@property(nonatomic) BOOL canGoBack;
@property(nonatomic) BOOL canGoForward;
@end

@implementation NormaCEFBrowserState
@end

/// Everything Task 6b tracks about one panel tab's browser, hung off the CONTAINER VIEW rather
/// than the browser.
///
/// Keyed by the container for three reasons, each of which the browser-keyed alternative gets
/// wrong: the container exists BEFORE the browser (creation is async and can queue behind
/// `OnContextInitialized`, so observers registered at `makeNSView` time have nowhere else to live);
/// the container OUTLIVES a close, so a late callback has somewhere to land harmlessly; and the
/// dedupe memory below has to survive the browser entirely — `PanelCEFView` is `.id`'d by tab, so
/// every tab SWITCH destroys one browser and builds another, and a per-browser memory would forget
/// what was already reported on every single flip.
///
/// Attached with `objc_setAssociatedObject`, so its lifetime is the view's and there is no global
/// table to leak or to sweep.
@interface NormaCEFTabBridge : NSObject
@property(nonatomic, copy) void (^stateObserver)(NormaCEFBrowserState *);
@property(nonatomic, copy) void (^navigationObserver)(NSString *, NSString *);
@property(nonatomic, copy) NSString *url;
@property(nonatomic, copy) NSString *title;
@property(nonatomic) BOOL isLoading;
@property(nonatomic) BOOL canGoBack;
@property(nonatomic) BOOL canGoForward;
/// The last (url, title) pair handed to `navigationObserver`, or seeded from the daemon's own
/// record by `NormaCEFSeedReportedNavigation`. Consecutive duplicates are suppressed against this.
@property(nonatomic, copy) NSString *lastReportedURL;
@property(nonatomic, copy) NSString *lastReportedTitle;
@end

@implementation NormaCEFTabBridge
- (instancetype)init {
  if ((self = [super init])) {
    _url = @"";
    _title = @"";
  }
  return self;
}
@end

namespace {

const char kTabBridgeKey = 'n';

/// The bridge for `container`, created on first use. `nil` only for a nil view.
NormaCEFTabBridge *BridgeFor(NSView *container) {
  if (container == nil) {
    return nil;
  }
  NormaCEFTabBridge *bridge = objc_getAssociatedObject(container, &kTabBridgeKey);
  if (bridge == nil) {
    bridge = [[NormaCEFTabBridge alloc] init];
    objc_setAssociatedObject(container, &kTabBridgeKey, bridge, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return bridge;
}

/// The bridge for a browser — CEF's own view is a SUBVIEW of the container (`SetAsChild`), so the
/// relation is descendancy and the walk goes upward. Returns `nil` (never creates) when no ancestor
/// carries one: a browser whose panel tab has already been dismantled is exactly that case, and it
/// must be silent rather than resurrecting state for a view nobody is watching.
NormaCEFTabBridge *BridgeForBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser || !browser->GetHost()) {
    return nil;
  }
  NSView *view = CAST_CEF_WINDOW_HANDLE_TO_NSVIEW(browser->GetHost()->GetWindowHandle());
  for (NSView *v = view; v != nil; v = [v superview]) {
    NormaCEFTabBridge *bridge = objc_getAssociatedObject(v, &kTabBridgeKey);
    if (bridge != nil) {
      return bridge;
    }
  }
  return nil;
}

/// Push the live snapshot to whoever is watching. Main thread by construction — CEF's UI thread IS
/// the main thread under the external pump — so the observer runs synchronously and SwiftUI's
/// `@Published` writes stay on the main actor.
void NotifyState(NormaCEFTabBridge *bridge) {
  if (bridge == nil || bridge.stateObserver == nil) {
    return;
  }
  NormaCEFBrowserState *state = [[NormaCEFBrowserState alloc] init];
  state.url = bridge.url ?: @"";
  state.title = bridge.title ?: @"";
  state.isLoading = bridge.isLoading;
  state.canGoBack = bridge.canGoBack;
  state.canGoForward = bridge.canGoForward;
  bridge.stateObserver(state);
}

}  // namespace

// ---------------------------------------------------------------------------
// The external message pump
// ---------------------------------------------------------------------------

@class NormaCEFPumpHandler;

namespace {

class ExternalPump {
 public:
  static ExternalPump *Get() { return instance_; }
  static void Create();

  // Called from CefBrowserProcessHandler::OnScheduleMessagePumpWork() on ANY CEF thread — hops to
  // the main thread before anything touches the timer.
  void OnScheduleMessagePumpWork(int64_t delay_ms);

  // Main thread only. The landing pad for the hop above.
  void OnScheduleWork(int64_t delay_ms);
  // Main thread only. The timer fired.
  void OnTimerTimeout();

  void KillTimer();
  bool IsTimerPending() { return timer_ != nil; }

 private:
  void SetTimer(int64_t delay_ms);
  void DoWork();
  bool PerformMessageLoopWork();

  static ExternalPump *instance_;
  NSTimer *timer_ = nil;
  NormaCEFPumpHandler *handler_ = nil;
  bool is_active_ = false;
  bool reentrancy_detected_ = false;
};

ExternalPump *ExternalPump::instance_ = nullptr;

}  // namespace

/// The timer's Objective-C target and the thread-hop landing pad — CEF's own `EventHandler`
/// (`main_message_loop_external_pump_mac.mm`), which exists for the same reason: `NSTimer` and
/// `performSelector:onThread:` both need an ObjC receiver, and the pump is C++.
@interface NormaCEFPumpHandler : NSObject
- (void)timerTimeout:(id)obj;
- (void)scheduleWork:(id)obj;
@end

@implementation NormaCEFPumpHandler
- (void)timerTimeout:(id)obj {
  if (auto *pump = ExternalPump::Get()) {
    pump->OnTimerTimeout();
  }
}
- (void)scheduleWork:(id)obj {
  if (auto *pump = ExternalPump::Get()) {
    pump->OnScheduleWork([obj longLongValue]);
  }
}
@end

namespace {

void ExternalPump::Create() {
  if (!instance_) {
    instance_ = new ExternalPump();
    instance_->handler_ = [[NormaCEFPumpHandler alloc] init];
  }
}

void ExternalPump::SetTimer(int64_t delay_ms) {
  const double delay_s = static_cast<double>(delay_ms) / 1000.0;
  timer_ = [NSTimer timerWithTimeInterval:delay_s
                                   target:handler_
                                 selector:@selector(timerTimeout:)
                                 userInfo:nil
                                  repeats:NO];

  // ****** THE detail that is easy to lose in a Swift port — see this file's header, point 1.
  // Both registrations, exactly as CEF writes them. `Timer.scheduledTimer` (the idiomatic Swift
  // one-liner) registers in the default mode ONLY and measured 0 DoWork calls across a 5-second
  // event-tracking window.
  NSRunLoop *owner_runloop = [NSRunLoop currentRunLoop];
  [owner_runloop addTimer:timer_ forMode:NSRunLoopCommonModes];
  [owner_runloop addTimer:timer_ forMode:NSEventTrackingRunLoopMode];
}

void ExternalPump::KillTimer() {
  if (timer_ != nil) {
    [timer_ invalidate];
    timer_ = nil;
  }
}

void ExternalPump::OnScheduleMessagePumpWork(int64_t delay_ms) {
  // May arrive on any CEF thread — hop to the main thread before anything touches the timer.
  //
  // CEF's own 4-argument form, restored after a MEASURED FAILURE. This first shipped as the
  // 5-argument `…modes:@[NSRunLoopCommonModes, NSEventTrackingRunLoopMode]`, reasoned to be
  // strictly-sooner delivery of the same work. It is not: `NSRunLoopCommonModes` is a PSEUDO-mode.
  // `addTimer:forMode:` expands it, but a perform's `modes:` array is matched against the mode the
  // run loop is actually running in — and a run loop is never "in" the common-modes pseudo-mode.
  // The result was a pump that never ran at all: `CefInitialize` succeeded, `OnContextInitialized`
  // fired, the browser was created, six helper processes started, DevTools bound its port — and
  // then nothing. No `OnLoadEnd`, and the DevTools HTTP endpoint never answered a single request,
  // because every message-loop turn after startup arrives through THIS call. Restoring CEF's form
  // fixed it in the same build.
  //
  // The freeze this looks like is not the run-loop-mode trap from Task 1 — that one is about the
  // TIMER, still registered in both modes above, and it costs you the pump only while AppKit is
  // tracking. This one cost the pump permanently.
  [handler_ performSelector:@selector(scheduleWork:)
                   onThread:[NSThread mainThread]
                 withObject:[NSNumber numberWithLongLong:delay_ms]
              waitUntilDone:NO];
}

// Verbatim port of MainMessageLoopExternalPump::OnScheduleWork.
void ExternalPump::OnScheduleWork(int64_t delay_ms) {
  if (g_shutting_down) {
    return;
  }
  if (delay_ms == kTimerDelayPlaceholder && IsTimerPending()) {
    // Don't set the maximum timer requested from DoWork() if one is already in flight.
    return;
  }
  KillTimer();
  if (delay_ms <= 0) {
    DoWork();
  } else {
    if (delay_ms > kMaxTimerDelay) {
      delay_ms = kMaxTimerDelay;
    }
    SetTimer(delay_ms);
  }
}

void ExternalPump::OnTimerTimeout() {
  if (g_shutting_down) {
    return;
  }
  KillTimer();
  DoWork();
}

void ExternalPump::DoWork() {
  const bool was_reentrant = PerformMessageLoopWork();
  if (was_reentrant) {
    // Execute the remaining work as soon as possible — the discarded call is REPOSTED, not lost.
    OnScheduleMessagePumpWork(0);
  } else if (!IsTimerPending()) {
    OnScheduleMessagePumpWork(kTimerDelayPlaceholder);
  }
}

bool ExternalPump::PerformMessageLoopWork() {
  if (is_active_) {
    // CefDoMessageLoopWork() can re-enter this through paint and IPC callbacks.
    reentrancy_detected_ = true;
    return false;
  }
  reentrancy_detected_ = false;
  is_active_ = true;
  g_do_work_count++;
  CefDoMessageLoopWork();
  is_active_ = false;
  // |reentrancy_detected_| may have changed due to re-entrant calls to this method.
  return reentrancy_detected_;
}

// ---------------------------------------------------------------------------
// CefApp / CefBrowserProcessHandler / CefClient
// ---------------------------------------------------------------------------

void CreateBrowserNow(NSView *parent, const std::string &url);
void ReplayPendingBrowsers();

/// Minimal client. `CefLifeSpanHandler` keeps `g_browsers` honest; `CefLoadHandler` exists because
/// Task 1 explicitly asked for it: "Do not trust the first navigation blindly" — it saw one
/// un-root-caused first-load failure in 23 runs, with every structural cause excluded by control,
/// and recommended wiring `OnLoadError`/`OnLoadEnd` rather than assuming the first page appears.
/// Here they log; Task 6b is where a visible retry belongs, alongside the chrome that would host it.
class NormaClient : public CefClient,
                    public CefLifeSpanHandler,
                    public CefLoadHandler,
                    public CefDisplayHandler {
 public:
  NormaClient() = default;

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  // Task 6b: address and title, for the URL field. NOT for the log — see OnLoadEnd.
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    g_browsers.push_back(browser);
    // Task 6b: a browser that exists but has not navigated yet still has chrome to draw (both
    // arrows disabled, no address). Pushing the empty snapshot now means the chrome's state comes
    // from exactly one channel from the very first frame, instead of a default it invents itself.
    NotifyState(BridgeForBrowser(browser));
    Log("browser created (id=%d, live browsers=%zu)", browser->GetIdentifier(), g_browsers.size());
  }

  /// **`true` — and the default of `false` closes NORMA'S OWN WINDOW.**
  ///
  /// Found at the user's live gate: closing a panel tab, or clicking Cowork in the sidebar with a
  /// tab open, made the whole app window vanish. The process survived (menu-bar orb still working,
  /// no crash report) — it was the window dying, not the app, and both triggers are the same event:
  /// SwiftUI dismantles `PanelCEFView`, which calls `CloseBrowser(true)`.
  ///
  /// `include/cef_life_span_handler.h` states the mechanism outright, and this is quoted rather
  /// than inferred:
  ///
  ///   "When windowed rendering is enabled CEF will create an internal child window/view to host
  ///    the browser. In that case returning false from DoClose() will send the standard close
  ///    notification to the browser's TOP-LEVEL PARENT WINDOW (e.g. WM_CLOSE on Windows,
  ///    **performClose: on OS X** ...)"
  ///
  /// The top-level parent window of a browser parented into `ShellPanel` is Norma's app window. So
  /// CEF was faithfully doing what an embedder that OWNS a window per browser wants — `cefsimple`
  /// and `cefclient` both return `false` for exactly that reason — and what an embedder hosting a
  /// browser inside a shared window it owns must never allow.
  ///
  /// The same header gives the escape and its obligation:
  ///
  ///   "If the browser's top-level parent window requires a non-standard close notification then
  ///    send that notification from DoClose() and return true. You are STILL REQUIRED to complete
  ///    the browser close as soon as possible (either by calling [Try]CloseBrowser() or by
  ///    proceeding with window/view hierarchy tear-down), otherwise the browser will be left in a
  ///    partially closed state that interferes with proper functioning."
  ///
  /// Norma needs no notification at all — the tab is already gone from the UI by the time this
  /// runs; the close was initiated BY that tear-down. The obligation is discharged by
  /// `NormaCEFCloseBrowser`, which calls `CloseBrowser(true)` and then removes CEF's host view from
  /// the container, so the view hierarchy tear-down the header names as the second acceptable
  /// completion always happens and never depends on SwiftUI's release timing.
  ///
  /// `OnBeforeClose` still fires after this (the header: "will be called after DoClose() ... and
  /// immediately before the browser object is destroyed"), which is what keeps `g_browsers`
  /// draining and the renderer process exiting. Verified by measurement, not assumed — returning
  /// `true` without completing the close would trade a window-close bug for a renderer leak.
  /// TWO PINS GUARD THIS, because one alone left the Critical re-openable:
  ///
  ///   * The body must not be REPLACED (e.g. pasted from `cefsimple`/`cefclient`, both of which
  ///     return false). The log literal below is what a replacement would take with it, and
  ///     `testTheBrowserClientOverridesDoCloseSoCEFCannotCloseNormasWindow` scans the built binary
  ///     for it.
  ///   * The ANSWER must not be FLIPPED. That is why this returns
  ///     `NormaCEFDoCloseIsHandledByHost()` — an exported single source of truth a test can call
  ///     and read directly — rather than a bare `true`. A string scan cannot see a return value:
  ///     the first version of this pin searched for "DoClose->true", which is emitted by a `Log`
  ///     statement with zero coupling to the `return`, so changing only the return kept the test
  ///     green while restoring the bug.
  ///
  /// One case is still not covered and is named rather than papered over: surgically editing this
  /// one line to `return false;` while leaving the log call intact. Nothing a test can observe
  /// distinguishes that, because no test can call a C++ virtual method it cannot construct a
  /// `CefBrowser` for. It is also the least likely edit — the named regression vector is pasting a
  /// sample's body, which brings its own body and no such log line, and the string scan catches it.
  bool DoClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    Log("browser close handled by the host (DoClose->true, id=%d)", browser->GetIdentifier());
    return NormaCEFDoCloseIsHandledByHost();
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    for (auto it = g_browsers.begin(); it != g_browsers.end(); ++it) {
      if ((*it)->IsSame(browser)) {
        g_browsers.erase(it);
        break;
      }
    }
    Log("browser closed (id=%d, live browsers=%zu)", browser->GetIdentifier(), g_browsers.size());
  }

  /// Task 6b: the ONE signal the chrome's buttons need, delivered by CEF already computed — "will
  /// be called before any calls to OnLoadStart and after all calls to OnLoadError and/or
  /// OnLoadEnd" (`cef_load_handler.h`). Browser-wide, not per-frame, which is exactly right for a
  /// toolbar.
  void OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                            bool isLoading,
                            bool canGoBack,
                            bool canGoForward) override {
    CEF_REQUIRE_UI_THREAD();
    NormaCEFTabBridge *bridge = BridgeForBrowser(browser);
    if (bridge == nil) {
      return;
    }
    bridge.isLoading = isLoading;
    bridge.canGoBack = canGoBack;
    bridge.canGoForward = canGoForward;
    NotifyState(bridge);
  }

  /// Task 6b: the commit point. Used ONLY to forget the outgoing page's title — not to report.
  ///
  /// Without this clear, a page with no `<title>` of its own inherits whatever the PREVIOUS page
  /// was called: `OnTitleChange` simply never fires for it, so the cache would still hold the old
  /// value when `OnLoadEnd` reads it, and the wrong title would be written to the session log
  /// permanently. Chromium fires an early `OnTitleChange` carrying a URL-derived placeholder for
  /// most navigations, which is what fills the gap in the ordinary case.
  void OnLoadStart(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   TransitionType transition_type) override {
    CEF_REQUIRE_UI_THREAD();
    if (!frame->IsMain()) {
      return;
    }
    NormaCEFTabBridge *bridge = BridgeForBrowser(browser);
    if (bridge == nil) {
      return;
    }
    bridge.title = @"";
    NotifyState(bridge);
  }

  /// **THE PRODUCER `panel.reportNavigation` never had.** See `NormaCEFSetNavigationObserver`'s
  /// header doc for why `OnLoadEnd` + `IsMain()` is precisely "committed top-level navigation" in
  /// CEF's own words, and which three classes of event it excludes by contract rather than by a
  /// filter maintained here.
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override {
    CEF_REQUIRE_UI_THREAD();
    if (!frame->IsMain()) {
      return;
    }
    NSString *url = [NSString stringWithUTF8String:frame->GetURL().ToString().c_str()] ?: @"";
    NormaCEFTabBridge *bridge = BridgeForBrowser(browser);
    if (bridge != nil) {
      bridge.url = url;
      NSString *title = bridge.title ?: @"";
      // Consecutive-duplicate suppression, seeded across browser lifetimes by
      // `NormaCEFSeedReportedNavigation`. A reload, or a re-created browser landing back on the
      // page the daemon already recorded, adds nothing to the log.
      const BOOL isRepeat = [url isEqualToString:bridge.lastReportedURL ?: @""] &&
                            [title isEqualToString:bridge.lastReportedTitle ?: @""];
      if (!isRepeat && bridge.navigationObserver != nil && url.length > 0) {
        bridge.lastReportedURL = url;
        bridge.lastReportedTitle = title;
        bridge.navigationObserver(url, title);
      }
      NotifyState(bridge);
    }
#if DEBUG
    Log("load end (status=%d) %s", httpStatusCode, url.UTF8String);
#else
    // Task 6b: the page's address is a browsing-history fact and never reaches a shipped build's
    // stderr. The status code alone still says whether the load worked.
    Log("load end (status=%d)", httpStatusCode);
#endif
  }

  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode,
                   const CefString &errorText,
                   const CefString &failedUrl) override {
    CEF_REQUIRE_UI_THREAD();
    if (errorCode == ERR_ABORTED) {
      return;  // a superseded navigation, not a failure — Task 1 nearly misdiagnosed exactly this
    }
#if DEBUG
    Log("LOAD ERROR %d (%s) for %s", errorCode, errorText.ToString().c_str(),
        failedUrl.ToString().c_str());
#else
    Log("LOAD ERROR %d (%s)", errorCode, errorText.ToString().c_str());
#endif
  }

  // MARK: CefDisplayHandler — Task 6b's LIVE channel (never the persisted one)

  /// Fires for same-page navigations too (a `#fragment` jump, `history.pushState`), which is
  /// exactly why the URL field reads from here and the session log does not: a field that did not
  /// follow a fragment would be visibly wrong, and a log that did would be thousands of entries.
  void OnAddressChange(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       const CefString &url) override {
    CEF_REQUIRE_UI_THREAD();
    if (!frame->IsMain()) {
      return;
    }
    NormaCEFTabBridge *bridge = BridgeForBrowser(browser);
    if (bridge == nil) {
      return;
    }
    bridge.url = [NSString stringWithUTF8String:url.ToString().c_str()] ?: @"";
    NotifyState(bridge);
  }

  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString &title) override {
    CEF_REQUIRE_UI_THREAD();
    NormaCEFTabBridge *bridge = BridgeForBrowser(browser);
    if (bridge == nil) {
      return;
    }
    bridge.title = [NSString stringWithUTF8String:title.ToString().c_str()] ?: @"";
    NotifyState(bridge);
  }

 private:
  IMPLEMENT_REFCOUNTING(NormaClient);
  DISALLOW_COPY_AND_ASSIGN(NormaClient);
};

CefRefPtr<NormaClient> g_client;

class NormaApp : public CefApp, public CefBrowserProcessHandler {
 public:
  NormaApp() = default;

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    g_context_initialized = true;
    Log("context initialized");
    ReplayPendingBrowsers();
  }

  // The whole reason this file exists.
  void OnScheduleMessagePumpWork(int64_t delay_ms) override {
    if (auto *pump = ExternalPump::Get()) {
      pump->OnScheduleMessagePumpWork(delay_ms);
    }
  }

 private:
  IMPLEMENT_REFCOUNTING(NormaApp);
  DISALLOW_COPY_AND_ASSIGN(NormaApp);
};

CefRefPtr<NormaApp> g_app;

void CreateBrowserNow(NSView *parent, const std::string &url) {
  CefWindowInfo window_info;
  const NSRect b = [parent bounds];
  window_info.SetAsChild(CAST_NSVIEW_TO_CEF_WINDOW_HANDLE(parent),
                         CefRect(0, 0, static_cast<int>(b.size.width),
                                 static_cast<int>(b.size.height)));
  // Providing `parent_view` ALREADY forces Alloy style (`cef_types_mac.h:152`), which is what
  // keeps the Chrome-style omnibox chrome the spike warned about out of an embedded panel. Stated
  // explicitly anyway so a future refactor that drops SetAsChild cannot silently inherit it.
  window_info.runtime_style = CEF_RUNTIME_STYLE_ALLOY;

  CefBrowserSettings browser_settings;
  CefBrowserHost::CreateBrowser(window_info, g_client, CefString(url), browser_settings, nullptr,
                                nullptr);
}

void ReplayPendingBrowsers() {
  if (g_pending == nil) {
    return;
  }
  NSArray<NormaCEFPendingBrowser *> *pending = [g_pending copy];
  [g_pending removeAllObjects];
  for (NormaCEFPendingBrowser *request in pending) {
    NSView *parent = request.parent;
    if (parent == nil) {
      Log("dropping queued browser — its panel tab went away before the context came up");
      continue;
    }
    CreateBrowserNow(parent, std::string([request.url UTF8String]));
  }
}

/// The browser hosted inside `parent`, if any. CEF's own `NSView` is added as a subview of the
/// container by `SetAsChild`, so descendancy — not identity — is the relation to test.
CefRefPtr<CefBrowser> BrowserForParent(NSView *parent) {
  if (parent == nil) {
    return nullptr;
  }
  for (auto &browser : g_browsers) {
    NSView *view = CAST_CEF_WINDOW_HANDLE_TO_NSVIEW(browser->GetHost()->GetWindowHandle());
    if (view != nil && (view == parent || [view isDescendantOf:parent])) {
      return browser;
    }
  }
  return nullptr;
}

}  // namespace

/// Runs `CefShutdown` at the process's real point of no return. See `NormaCEFShutdown`.
@interface NormaCEFTerminationObserver : NSObject
- (void)applicationWillTerminate:(NSNotification *)note;
@end

@implementation NormaCEFTerminationObserver
- (void)applicationWillTerminate:(NSNotification *)note {
  NormaCEFShutdown();
}
@end

static NormaCEFTerminationObserver *g_termination_observer = nil;

// ---------------------------------------------------------------------------
// The C entry points — the Swift-facing seam
// ---------------------------------------------------------------------------

BOOL NormaCEFLoadLibrary(void) {
  if (g_library_loaded) {
    return YES;
  }
  // `LoadInMain` — the MAIN-process arm of the loader. Task 5's signing A/B exercised only
  // `LoadInHelper`; same team-ID logic and the same symlink, but this call had never run anywhere
  // before Task 6a. It computes `<executable dir>/../Frameworks/Chromium Embedded Framework
  // .framework/Chromium Embedded Framework` (`cef_scoped_library_loader_mac.mm`, kPathFromMainExe)
  // — which, since Task 5 restructured the embedded copy into the versioned macOS layout Xcode's
  // product validator demands, resolves through the framework's top-level symlink to
  // `Versions/A/`. dlopen follows symlinks, so the path is unchanged from CEF's flat original.
  static void *loader = nullptr;
  loader = cef_scoped_library_loader_create(0 /* 0 = main process, not helper */);
  if (loader == nullptr) {
    g_last_error = "could not load the Chromium Embedded Framework (LoadInMain failed)";
    Log("FAILED: %s", g_last_error.c_str());
    return NO;
  }
  g_library_loaded = true;
  Log("framework loaded (LoadInMain)");
  return YES;
}

BOOL NormaCEFInitialize(int argc,
                        char **argv,
                        const char *rootCachePath,
                        const char *subprocessPath) {
  if (g_initialized) {
    return YES;
  }
  if (g_did_shutdown) {
    // CefShutdown is terminal for a process. Refusing loudly beats a confusing crash inside CEF.
    g_last_error = "CEF was already shut down in this process and cannot be restarted";
    Log("REFUSED: %s", g_last_error.c_str());
    return NO;
  }
  if (!NormaCEFLoadLibrary()) {
    return NO;
  }

  ExternalPump::Create();

  CefMainArgs main_args(argc, argv);

  CefSettings settings;
  settings.external_message_pump = true;  // this app's run loop is SwiftUI's, and already running
  settings.multi_threaded_message_loop = false;  // unsupported on macOS anyway
  settings.no_sandbox = false;                   // the helpers' CEF_USE_SANDBOX half is in project.yml
  CefString(&settings.root_cache_path).FromString(rootCachePath);
  // Set explicitly rather than left to CEF's default derivation. CEF documents the default as
  // "Contents/Frameworks/<app> Helper.app/…" derived from the bundle — and Norma's CFBundleName is
  // "Norma Dev" in Debug while the helper bundles are named "Norma Helper" in every configuration
  // (PRODUCT_NAME, config-independent). Deriving would look for a "Norma Dev Helper.app" that does
  // not exist. Chromium appends its own per-role suffix — " (Renderer)", " (GPU)", … — to whatever
  // base path it is given, so the four suffixed bundles are still reached from this one setting.
  CefString(&settings.browser_subprocess_path).FromString(subprocessPath);

  // Task 6b — CHROMIUM'S OWN LOGGING, set deliberately rather than inherited.
  //
  // Both fields matter and neither default is acceptable here:
  //
  //   * `log_file` empty means Chromium writes `debug.log` **into the process's current working
  //     directory** — for an app launched from a terminal that is wherever the developer happened
  //     to be, and for a LaunchServices launch it is `/`. A file of network errors (each naming a
  //     URL) landing in an arbitrary directory is not something to leave to a default. It is
  //     pointed inside the CEF profile directory, which is already bundle-id-scoped and already
  //     where Chromium's other state lives.
  //   * `log_severity` defaults to INFO, which is chatty and URL-bearing. A SHIPPED build gets
  //     `LOGSEVERITY_DISABLE`: no Chromium log file is created at all and nothing reaches stderr,
  //     which is the only form of "browsing history is not written down" that does not depend on
  //     where stderr happens to be pointed. Debug keeps WARNING — enough to see the GPU-process and
  //     resource-loading failures Task 6a needed, without INFO's per-request noise.
  //
  // Explicit command-line switches still win: `--enable-logging=stderr --v=1`, the diagnostic
  // channel every task on this branch has used, is unaffected in Debug (verified by running it).
  const std::string logPath = std::string(rootCachePath) + "/chromium-debug.log";
  CefString(&settings.log_file).FromString(logPath);
#if DEBUG
  settings.log_severity = LOGSEVERITY_WARNING;
#else
  settings.log_severity = LOGSEVERITY_DISABLE;
#endif

  g_app = new NormaApp();
  g_client = new NormaClient();

  const bool ok = CefInitialize(main_args, settings, g_app.get(), nullptr);
  if (!ok) {
    g_last_error = "CefInitialize failed (exit code " + std::to_string(CefGetExitCode()) + ")";
    Log("FAILED: %s", g_last_error.c_str());
    g_app = nullptr;
    g_client = nullptr;
    return NO;
  }
  g_initialized = true;
  Log("CefInitialize ok; context initialized synchronously = %s",
      g_context_initialized ? "yes" : "no");

  // The shutdown guarantee lives HERE, with the thing it guards, rather than in a line of
  // AppDelegate that could be deleted without anything failing to compile. It is registered only
  // once CEF is actually up, so a build that never starts CEF never arms it.
  if (g_termination_observer == nil) {
    g_termination_observer = [[NormaCEFTerminationObserver alloc] init];
    [[NSNotificationCenter defaultCenter] addObserver:g_termination_observer
                                             selector:@selector(applicationWillTerminate:)
                                                 name:NSApplicationWillTerminateNotification
                                               object:nil];
  }
  return YES;
}

BOOL NormaCEFIsInitialized(void) {
  return g_initialized ? YES : NO;
}

BOOL NormaCEFIsContextInitialized(void) {
  return g_context_initialized ? YES : NO;
}

const char *NormaCEFLastError(void) {
  return g_last_error.c_str();
}

void NormaCEFCreateBrowser(NSView *parent, const char *url) {
  if (!g_initialized || g_shutting_down || parent == nil) {
    return;
  }
  const std::string target(url != nullptr ? url : "");
  if (g_context_initialized) {
    CreateBrowserNow(parent, target);
    return;
  }
  // Task 1 measured OnContextInitialized firing SYNCHRONOUSLY inside CefInitialize on every run —
  // but that is timing, not contract, and `makeNSView` can plausibly run before the context on a
  // slower or busier launch. The queue costs nothing and removes the ordering assumption.
  if (g_pending == nil) {
    g_pending = [[NSMutableArray alloc] init];
  }
  NormaCEFPendingBrowser *request = [[NormaCEFPendingBrowser alloc] init];
  request.parent = parent;
  request.url = [NSString stringWithUTF8String:target.c_str()];
  [g_pending addObject:request];
#if DEBUG
  Log("queued browser for %s (context not up yet)", target.c_str());
#else
  Log("queued a browser (context not up yet)");
#endif
}

// ---------------------------------------------------------------------------
// Task 6b: the observers, the dedupe seed, and the chrome's verbs
// ---------------------------------------------------------------------------

void NormaCEFSetStateObserver(NSView *parent, void (^observer)(NormaCEFBrowserState *state)) {
  NormaCEFTabBridge *bridge = BridgeFor(parent);
  bridge.stateObserver = observer;
  // Deliver the current snapshot immediately rather than waiting for the next CEF callback. A tab
  // switched away from and back to re-registers against a container whose state is already known,
  // and without this the chrome would sit blank until the page happened to change something.
  if (observer != nil) {
    NotifyState(bridge);
  }
}

void NormaCEFSetNavigationObserver(NSView *parent, void (^observer)(NSString *url, NSString *title)) {
  BridgeFor(parent).navigationObserver = observer;
}

void NormaCEFSeedTabState(NSView *parent, const char *url, const char *title) {
  NormaCEFTabBridge *bridge = BridgeFor(parent);
  NSString *seedURL = url != nullptr ? [NSString stringWithUTF8String:url] : @"";
  NSString *seedTitle = title != nullptr ? [NSString stringWithUTF8String:title] : @"";
  // The dedupe memory (effect 1) and the displayed values (effect 2) — see the header doc.
  bridge.lastReportedURL = seedURL;
  bridge.lastReportedTitle = seedTitle;
  bridge.url = seedURL;
  bridge.title = seedTitle;
}

void NormaCEFGoBack(NSView *parent) {
  if (auto browser = BrowserForParent(parent)) {
    browser->GoBack();
  }
}

void NormaCEFGoForward(NSView *parent) {
  if (auto browser = BrowserForParent(parent)) {
    browser->GoForward();
  }
}

void NormaCEFReload(NSView *parent) {
  if (auto browser = BrowserForParent(parent)) {
    browser->Reload();
  }
}

void NormaCEFStopLoad(NSView *parent) {
  if (auto browser = BrowserForParent(parent)) {
    browser->StopLoad();
  }
}

void NormaCEFLoadURL(NSView *parent, const char *url) {
  if (url == nullptr || *url == '\0') {
    return;
  }
  if (auto browser = BrowserForParent(parent)) {
    // No validation here on purpose — `PanelURLPolicy` (Swift) is the one place the scheme
    // allowlist is expressed, and it has already run at the field. See this function's header doc.
    browser->GetMainFrame()->LoadURL(CefString(url));
  }
}

BOOL NormaCEFDoCloseIsHandledByHost(void) {
  // Flipping this to NO re-opens the live-gate Critical: CEF would send `performClose:` to the
  // browser's top-level parent window, which is Norma's own app window. `CEFRuntimeTests
  // .testDoCloseAnswersThatTheHostHandlesTheCloseSoCEFNeverTouchesNormasWindow` reads this value.
  return YES;
}

void NormaCEFCloseBrowser(NSView *parent) {
  if (parent == nil) {
    return;
  }
  if (g_pending != nil) {
    NSMutableArray<NormaCEFPendingBrowser *> *survivors = [[NSMutableArray alloc] init];
    for (NormaCEFPendingBrowser *request in g_pending) {
      if (request.parent != nil && request.parent != parent) {
        [survivors addObject:request];
      }
    }
    g_pending = survivors;
  }
  if (!g_initialized) {
    return;
  }
  if (auto browser = BrowserForParent(parent)) {
    // Order matters, and `DoClose` returning true is what makes this order safe.
    //
    // 1. `CloseBrowser(true)` starts CEF's close sequence. `DoClose` answers true, so CEF does NOT
    //    send `performClose:` to Norma's app window — the defect this pair of changes fixes.
    // 2. Returning true means CEF hands the completion back to us: "you are still required to
    //    complete the browser close as soon as possible ... or by proceeding with window/view
    //    hierarchy tear-down" (`cef_life_span_handler.h`). Detaching CEF's own host view IS that
    //    tear-down.
    //
    //    MEASURED, so the comment does not overclaim: this detach is NOT required on the panel-tab
    //    path. With `DoClose` alone and this block deleted, `OnBeforeClose` still fires,
    //    `g_browsers` still drains to 0 and the renderer still exits — SwiftUI's own release of the
    //    container discharges the obligation. It is kept for the two cases where nothing else will:
    //    `NormaCEFCloseAllBrowsers` (from `-terminate:`) has no SwiftUI dismantle behind it at all,
    //    and the header makes completion the CALLER's duty once DoClose answers true rather than
    //    something to infer from another framework's release timing.
    //
    // The view is fetched BEFORE the close call — `GetWindowHandle()` is not guaranteed to answer
    // once the close is under way.
    NSView *hostView = CAST_CEF_WINDOW_HANDLE_TO_NSVIEW(browser->GetHost()->GetWindowHandle());
    browser->GetHost()->CloseBrowser(true);
    if (hostView != nil && [hostView superview] != nil) {
      [hostView removeFromSuperview];
    }
  }
}

void NormaCEFCloseAllBrowsers(void) {
  if (g_pending != nil) {
    [g_pending removeAllObjects];
  }
  if (!g_initialized) {
    return;
  }
  // Iterate a COPY: OnBeforeClose can land during this loop and mutate g_browsers.
  std::vector<CefRefPtr<CefBrowser>> browsers = g_browsers;
  for (auto &browser : browsers) {
    // Same two-step as NormaCEFCloseBrowser, and for the same reason: `DoClose` returns true, so
    // completing the close is ours to do. See its comment.
    NSView *hostView = CAST_CEF_WINDOW_HANDLE_TO_NSVIEW(browser->GetHost()->GetWindowHandle());
    browser->GetHost()->CloseBrowser(true);
    if (hostView != nil && [hostView superview] != nil) {
      [hostView removeFromSuperview];
    }
  }
}

void NormaCEFShutdown(void) {
  if (g_did_shutdown || !g_initialized) {
    // Never initialised: there is nothing to shut down, and calling CefShutdown would dispatch
    // through a dylib stub that was never resolved. This no-op is what makes the termination
    // wiring safe in every build — including the unit-test host, which never starts CEF.
    g_did_shutdown = true;
    return;
  }
  g_did_shutdown = true;
  g_shutting_down = true;
  if (auto *pump = ExternalPump::Get()) {
    pump->KillTimer();
  }
  NormaCEFCloseAllBrowsers();
  // CloseBrowser is asynchronous and the run loop is about to stop, so the pump can no longer
  // deliver the turns CEF needs to finish closing. Drive them directly, bounded — CEF's own
  // external-pump sample does the same thing after `[NSApp run]` returns
  // (`main_message_loop_external_pump_mac.mm:114-125`, "run the message pump until it is idle...
  // we don't have that information here so we run the message loop 'for a while'").
  for (int i = 0; i < 50 && !g_browsers.empty(); i++) {
    CefDoMessageLoopWork();
    usleep(10000);
  }
  Log("shutting down (%zu browser(s) still open, %ld DoWork calls)", g_browsers.size(),
      g_do_work_count);
  CefShutdown();
}

BOOL NormaCEFDidShutdown(void) {
  return g_did_shutdown ? YES : NO;
}

long NormaCEFDoWorkCount(void) {
  return g_do_work_count;
}
