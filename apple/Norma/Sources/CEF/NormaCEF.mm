#import "NormaCEF.h"

#import <Cocoa/Cocoa.h>

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
// WHAT THIS FILE DELIBERATELY DOES NOT DO: navigate. Task 6a is "a page renders in the panel".
// Back/forward/reload, the URL field, `panel.reportNavigation`, field-size caps and URL-scheme
// policy are all Task 6b. A page that renders and cannot yet be navigated is the correct end state.

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

namespace {

// stderr, unconditionally. Launched by LaunchServices this goes nowhere; launched by explicit path
// from a terminal — the only way this branch's dev app is ever started — it is the diagnostic
// channel for `LoadInMain`, `CefInitialize` and the versioned-framework resource paths, none of
// which had ever run inside Norma before this task.
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
                    public CefLoadHandler {
 public:
  NormaClient() = default;

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    g_browsers.push_back(browser);
    Log("browser created (id=%d, live browsers=%zu)", browser->GetIdentifier(), g_browsers.size());
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

  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override {
    CEF_REQUIRE_UI_THREAD();
    if (frame->IsMain()) {
      Log("load end (status=%d) %s", httpStatusCode, frame->GetURL().ToString().c_str());
    }
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
    Log("LOAD ERROR %d (%s) for %s", errorCode, errorText.ToString().c_str(),
        failedUrl.ToString().c_str());
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
  Log("queued browser for %s (context not up yet)", target.c_str());
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
    browser->GetHost()->CloseBrowser(true);
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
    browser->GetHost()->CloseBrowser(true);
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
