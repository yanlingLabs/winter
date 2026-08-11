#import "NormaCEF.h"

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

#include <climits>
#include <cstdarg>
#include <cstdio>
#include <map>
#include <string>
#include <unistd.h>
#include <vector>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
// Both arrive transitively through `cef_client.h`; named here because this file IMPLEMENTS them
// (`CefRequestHandler::OnOpenURLFromTab`, `CefContextMenuHandler`), and a transitive include is not
// a dependency anybody can see. `cef_menu_model.h` comes with the context-menu header.
#include "include/cef_context_menu_handler.h"
#include "include/cef_request_handler.h"
// B2 Task 3 — the CDP door. The observer is IMPLEMENTED here; the other two are what
// `AddDevToolsMessageObserver` returns and what turns a Swift-built params string into the
// `CefDictionaryValue` `ExecuteDevToolsMethod` takes.
#include "include/cef_devtools_message_observer.h"
#include "include/cef_parser.h"
#include "include/cef_registration.h"
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

// How many 10 ms message-loop turns `NormaCEFShutdown` is willing to drive after the sweep, waiting
// for every close to complete. Named rather than inline because the shutdown line now reports the
// turns actually used against it — see that function for what has been measured at what N.
const int kShutdownDrainTurns = 50;

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
// The OTHER creation window: CEF's own queue, where our parent handle is RAW
// ---------------------------------------------------------------------------

/// ONE `CefBrowserHost::CreateBrowser(...)` call that CEF has not finished executing yet.
///
/// **`parent` is STRONG, and that one word is the crash fix.**
///
/// `CreateBrowser` is ASYNCHRONOUS, which `cef_browser.h:290-295` states in the sentence that is
/// easiest to misread as reassurance: "All values will be copied internally and the actual window
/// (if any) will be created on the UI thread ... **will not block**". What is copied is the
/// HANDLE. `CAST_NSVIEW_TO_CEF_WINDOW_HANDLE` is a cast and nothing more, so what CEF carries
/// across that gap is a raw, unretained `NSView *`. The call posts a `CreateBrowserHelper` task;
/// when that task later runs, `CefBrowserPlatformDelegateNativeMac::CreateHostWindow()` MESSAGES
/// that view, to add Chromium's own view as a subview of it. Nothing in CEF retains it in between.
///
/// At the user's live gate that gap was fatal. A panel tab dismantled inside it released the
/// container, `CreateHostWindow()` messaged a deallocated object, and the browser process died —
/// taking the app with it. Crash report `Norma-2026-08-10-130829.ips`, thread `CrBrowserMain`,
/// `EXC_BAD_ACCESS` at `0x0`, symbolicated against CEF's own `release_symbols` dSYM:
/// `ZombieObjectCrash` ← `-[CrZombie forwardingTargetForSelector:]` ← `___forwarding___` ←
/// `CefBrowserPlatformDelegateNativeMac::CreateHostWindow()` ← `AlloyBrowserHostImpl::CreateInternal`
/// ← `CreateBrowserHelper::Run()`. Reproduced by opening a session whose saved tab pointed at a
/// domain that fails DNS, so the tab was created and torn down in quick succession.
///
/// Holding the view here, for exactly the length of the creation, is what closes that window. The
/// record is owned by the `NormaClient` built for this one browser, so the retain lasts precisely as
/// long as CEF holds that client: dropped in `OnAfterCreated`, and dropped anyway if CEF abandons
/// the creation without ever calling it.
@interface NormaCEFBrowserCreation : NSObject
@property(nonatomic, strong) NSView *parent;
/// The container was dismantled while this creation was still inside CEF's own queue.
///
/// `NormaCEFCloseBrowser` can prune `g_pending` — our queue — but has nothing to cancel in CEF's:
/// it looks for a browser to close and there is none yet, so it closes nothing and returns. Without
/// this flag the browser arrives afterwards, parented into a view nothing is showing, and never
/// closes: `DoClose` answers `true`, so completing a close is the host's job, and the host no longer
/// knows the browser exists. That is a live renderer process per abandoned tab. `OnAfterCreated`
/// reads this and closes the browser the moment it arrives.
@property(nonatomic) BOOL abandoned;
@end

@implementation NormaCEFBrowserCreation
/// **The retained view is released on the MAIN thread, whichever thread let go of this record.**
///
/// By the time a creation settles, `parent` is an `NSView` with a SwiftUI-built subtree and possibly
/// Chromium's own host view under it; AppKit does not promise any of that is safe to deallocate off
/// the main thread. Every release path this fix actually uses is already on CEF's UI thread — which
/// IS the main thread under the external pump — because `OnAfterCreated` runs there and so does the
/// destruction of the creation task that owns the client when creation fails. The hop costs nothing
/// and means the fix does not rest on that staying true inside CEF.
- (void)dealloc {
  NSView *doomed = _parent;
  if (doomed != nil && ![NSThread isMainThread]) {
    // The block's own capture retains `doomed` past this dealloc; it is released when the block is
    // destroyed, on the main queue. The empty body is the point.
    dispatch_async(dispatch_get_main_queue(), ^{
      (void)doomed;
    });
  }
}
@end

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
/// `OnContextInitialized`, so observers registered at create time have nowhere else to live); the
/// container OUTLIVES a close, so a late callback has somewhere to land harmlessly; and the dedupe
/// memory below has to survive the browser entirely — a tab's browser is created more than once
/// over that tab's life (on every tab SWITCH until browser-runtime T4; on a session hop, a relaunch
/// or a lifecycle-engine stop-then-return since), and a per-browser memory would forget what was
/// already reported each time.
///
/// Attached with `objc_setAssociatedObject`, so its lifetime is the view's and there is no global
/// table to leak or to sweep.
@interface NormaCEFTabBridge : NSObject
@property(nonatomic, copy) void (^stateObserver)(NormaCEFBrowserState *);
@property(nonatomic, copy) void (^navigationObserver)(NSString *, NSString *);
/// Where a popup this browser asks for goes — a new panel tab, in THIS tab's session. Keyed on the
/// container like everything else here, which is what makes "the session the popup came from"
/// answerable at all: the block is created when the tab's browser is (`BrowserRuntime.wire`, and
/// the view's own `makeNSView` before browser-runtime T4), so it closes over that tab's model and
/// its captured session id. `nil` for a container nobody wired one to, and that
/// case cancels the popup exactly as this file did before the route existed.
@property(nonatomic, copy) void (^popupObserver)(NSString *);
@property(nonatomic, copy) NSString *url;
@property(nonatomic, copy) NSString *title;
/// **Which document `title` actually describes.** A title is not a property of a browser, it is a
/// property of a page, and CEF only reports that one CHANGED — so a cache with no provenance
/// silently attributes the outgoing page's title to the incoming one whenever the new page never
/// fires `OnTitleChange`. Recorded from the main frame's own URL at the moment the title arrives,
/// and checked against the committing URL before anything is written down. See `OnTitleChange`.
@property(nonatomic, copy) NSString *titleURL;
@property(nonatomic) BOOL isLoading;
@property(nonatomic) BOOL canGoBack;
@property(nonatomic) BOOL canGoForward;
/// The last (url, title) pair handed to `navigationObserver`, or seeded from the daemon's own
/// record by `NormaCEFSeedTabState`. Consecutive duplicates are suppressed against this.
@property(nonatomic, copy) NSString *lastReportedURL;
@property(nonatomic, copy) NSString *lastReportedTitle;
/// The browser creation currently in flight for this container, if any — **WEAK, necessarily**.
/// The record retains the container (that is the crash fix) and the container owns this bridge, so
/// a strong link here would close a cycle that releases neither, ever. The record's owner is the
/// `NormaClient` CEF holds; this handle exists only so `NormaCEFCloseBrowser` can find a creation BY
/// PARENT VIEW and mark it abandoned, and it zeroes itself the moment the creation settles.
@property(nonatomic, weak) NormaCEFBrowserCreation *creation;
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

// ---------------------------------------------------------------------------
// The ObjC side of a live browser — because a window HANDLE is not a way to find a view
// ---------------------------------------------------------------------------

/// Everything about ONE OPEN BROWSER that lives in AppKit rather than in CEF, captured at the one
/// moment CEF hands it over and released the moment CEF says the browser is gone.
///
/// **`CefBrowserHost::GetWindowHandle()` keeps answering after the view behind it is dead**, and
/// messaging that pointer is not a nil-check away from safe: Chromium replaces deallocated ObjC
/// objects with `CrZombie`s in the browser process, so the FIRST message is a deliberate crash of
/// the whole app. That is the live-gate crash this record was added for
/// (`Norma-2026-08-10-152114.ips`, `CrBrowserMain`, `ZombieObjectCrash` under a late
/// `OnTitleChange`), and the same hazard sat under every other caller of that handle: the chrome
/// verbs' `BrowserForParent` walk and the three close paths' `removeFromSuperview`.
///
/// Keyed by `CefBrowser::GetIdentifier()` in `g_open_browsers`, filled in `OnAfterCreated` and
/// dropped in `OnBeforeClose` — **the same two callbacks that keep `g_browsers` honest, one line
/// apart in each**, which is the whole reason the two collections cannot drift.
@interface NormaCEFOpenBrowser : NSObject
/// CEF's own view — the one `SetAsChild` parented into the container.
///
/// **Strong on purpose, and released at close INITIATION rather than at `OnBeforeClose`.** Both
/// halves of that sentence are load-bearing and each fixes a shipped bug:
///
///   * Strong, because the close path's own `[hostView removeFromSuperview]` can drop the last
///     reference. Anything that reads this afterwards must get a real object or `nil`, never a
///     pointer into freed memory — the `CrZombie` crash `NormaCEFOpenBrowser` was added for.
///   * Released at close initiation, because **`-[CefBrowserHostView dealloc]` IS how a windowed
///     close completes.** It calls `AlloyBrowserHostImpl::WindowDestroyed()`, and once `DoClose`
///     has answered `true` that is the only remaining route to `DestroyBrowser()` and therefore to
///     `OnBeforeClose` (CEF 7922, `browser_platform_delegate_native_mac.mm` +
///     `alloy_browser_host_impl.cc`; see `CompleteCloseByReleasingHostView`). Holding this until
///     `OnBeforeClose` was a circular wait: the callback needed the view to deallocate, the view
///     could not deallocate until the callback drained the record. `DoClose` fired, `OnBeforeClose`
///     never did, and the renderer — with its audio — outlived the tab by the whole run.
///
/// So `nil` here means "already handed back to AppKit by a close", and the close paths treat it
/// exactly as they treat a browser with no record: nothing to detach.
@property(nonatomic, strong) NSView *hostView;
/// The tab this browser belongs to — the bridge its `NormaClient` was built with. Pointer identity
/// against a container's own bridge is how `BrowserForParent` maps a view to a browser without
/// messaging any view at all.
@property(nonatomic, strong) NormaCEFTabBridge *bridge;
@end

@implementation NormaCEFOpenBrowser
@end

/// Browser identifier → its ObjC side, for exactly as long as the browser is open. Parallel to
/// `g_browsers` and filled/drained beside it in the same two callbacks.
static NSMutableDictionary<NSNumber *, NormaCEFOpenBrowser *> *g_open_browsers = nil;

namespace {

const char kTabBridgeKey = 'n';

/// The bridge ALREADY attached to `container`, or `nil` — never creates one. For callers that are
/// asking a question about a view rather than setting something up on it: creating a bridge on a
/// view that never had one would attach state to a view on its way out.
NormaCEFTabBridge *ExistingBridgeFor(NSView *container) {
  if (container == nil) {
    return nil;
  }
  return objc_getAssociatedObject(container, &kTabBridgeKey);
}

/// The bridge for `container`, created on first use. `nil` only for a nil view.
NormaCEFTabBridge *BridgeFor(NSView *container) {
  if (container == nil) {
    return nil;
  }
  NormaCEFTabBridge *bridge = ExistingBridgeFor(container);
  if (bridge == nil) {
    bridge = [[NormaCEFTabBridge alloc] init];
    objc_setAssociatedObject(container, &kTabBridgeKey, bridge, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return bridge;
}

/// The ObjC side of `browser`, or `nil` once it has been closed (or before it was ever created).
NormaCEFOpenBrowser *OpenBrowserRecordFor(CefRefPtr<CefBrowser> browser) {
  if (!browser || g_open_browsers == nil) {
    return nil;
  }
  return g_open_browsers[@(browser->GetIdentifier())];
}

// ---------------------------------------------------------------------------
// B2 Task 3: the pending-CDP registry — which completion a DevTools reply belongs to
// ---------------------------------------------------------------------------

/// Browser identifier → (DevTools message id → the completion waiting on it).
///
/// **Nested rather than keyed on a composite, because the two operations this needs are "settle ONE
/// reply" and "fail EVERY call a browser stranded"** — and the second is what makes the door's
/// always-answers contract true. A flat map keyed by a packed pair would make the fail-all a scan of
/// every pending call in the process on each close.
///
/// Message ids are assigned by CEF and are per-browser (`ExecuteDevToolsMethod`'s own doc:
/// "an incremental number ... based on previous values"), so the browser id is a necessary part of
/// the key — two tabs can legitimately be waiting on the same number.
static NSMutableDictionary<NSNumber *, NSMutableDictionary<NSNumber *, NormaCEFCDPCompletion> *>
    *g_pending_cdp = nil;

/// The DevTools observer registration for each open browser, filled beside its `NormaCEFOpenBrowser`
/// record in `RememberOpenBrowser` and dropped beside it in `ForgetOpenBrowser` — the same
/// "one line apart, so the two collections cannot drift" discipline `g_browsers`/`g_open_browsers`
/// already use.
///
/// **Holding it IS the registration**: `AddDevToolsMessageObserver`'s own contract is that "the
/// observer will remain registered until the returned Registration object is destroyed"
/// (`cef_browser.h`), so this map is not bookkeeping about a subscription — it is the subscription.
/// Dropping the entry at `OnBeforeClose` is what unregisters, and the observer object dies with it.
static std::map<int, CefRefPtr<CefRegistration>> g_cdp_registrations;

/// A `{"message": …}` object — the shape `NormaCEFCDPCompletion` promises for every failure this
/// bridge decides itself. Built with `NSJSONSerialization` rather than string concatenation for the
/// obvious reason (a reason string with a quote in it would emit invalid JSON and the Swift parse
/// would then report the wrong failure), and with Foundation rather than `CefWriteJSON` for a
/// sharper one: this runs on paths where CEF was never loaded.
NSString *CDPReasonJSON(NSString *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"message" : message ?: @""}
                                                 options:0
                                                   error:nil];
  NSString *json = data != nil ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
                               : nil;
  // A hand-written fallback for a failure that cannot happen (a dictionary of two literals is always
  // serialisable) but must not become silence if it ever did.
  return json ?: @"{\"message\":\"the browser could not report why this failed\"}";
}

/// Register a completion against the id CEF assigned its method call.
void RememberPendingCDP(int browser_id, int message_id, NormaCEFCDPCompletion completion) {
  if (g_pending_cdp == nil) {
    g_pending_cdp = [[NSMutableDictionary alloc] init];
  }
  NSMutableDictionary<NSNumber *, NormaCEFCDPCompletion> *byMessage = g_pending_cdp[@(browser_id)];
  if (byMessage == nil) {
    byMessage = [[NSMutableDictionary alloc] init];
    g_pending_cdp[@(browser_id)] = byMessage;
  }
  byMessage[@(message_id)] = [completion copy];
}

/// Settle exactly one pending call. **Erase THEN call** — the same delete-then-resolve ordering the
/// daemon's own registry uses (`PanelCommandRegistry.resolve`) and for the same reason: a completion
/// can re-enter this file (it hops to Swift, which may close the tab), and an entry still in the map
/// when that happens is an entry a fail-all would fire a second time.
///
/// A reply with no pending entry is dropped in silence, deliberately. It is not an error condition:
/// a DevTools front-end attached to the same browser, or an event message that reached
/// `OnDevToolsMethodResult` for a call this app never made, has no completion to be owed one.
void SettlePendingCDP(int browser_id, int message_id, BOOL ok, NSString *payloadJSON) {
  NSMutableDictionary<NSNumber *, NormaCEFCDPCompletion> *byMessage = g_pending_cdp[@(browser_id)];
  NormaCEFCDPCompletion completion = byMessage[@(message_id)];
  if (completion == nil) {
    return;
  }
  [byMessage removeObjectForKey:@(message_id)];
  if (byMessage.count == 0) {
    [g_pending_cdp removeObjectForKey:@(browser_id)];
  }
  completion(ok, payloadJSON);
}

/// **Fail every call one browser stranded** — the whole of "error, never silence" for a browser that
/// goes away mid-flight.
///
/// The map entry is taken out BEFORE any completion runs, for the ordering reason above and for a
/// second one specific to this path: the three callers can reach each other (an app-initiated close
/// is followed by `OnBeforeClose`; a detach can precede either), and a fail-all that iterated the
/// live map would let a re-entrant second sweep fire the same completions again.
void FailAllPendingCDP(int browser_id, NSString *reason) {
  NSMutableDictionary<NSNumber *, NormaCEFCDPCompletion> *byMessage = g_pending_cdp[@(browser_id)];
  if (byMessage == nil || byMessage.count == 0) {
    return;
  }
  [g_pending_cdp removeObjectForKey:@(browser_id)];
  NSString *payload = CDPReasonJSON(reason);
  Log("cdp-pending-failed (id=%d, %lu call(s), %s)", browser_id,
      static_cast<unsigned long>(byMessage.count), reason.UTF8String);
  for (NSNumber *messageId in [byMessage allKeys]) {
    NormaCEFCDPCompletion completion = byMessage[messageId];
    if (completion != nil) {
      completion(NO, payload);
    }
  }
}

/// **The reply side of the CDP door.** One instance per open browser, alive for exactly as long as
/// its registration is (`g_cdp_registrations`).
///
/// Only two of the five callbacks are overridden, and the two that are left alone are left alone on
/// purpose. `OnDevToolsMessage` would see every message before it is dispatched — returning `true`
/// from it would SUPPRESS the structured callbacks below, which is the opposite of what this needs —
/// and `OnDevToolsEvent` fires only while a domain's notifications are enabled, which nothing here
/// enables (B2's verbs are all method calls). `OnDevToolsAgentAttached` is a fact with no consequence
/// for a caller that is already waiting.
class NormaCDPObserver : public CefDevToolsMessageObserver {
 public:
  /// A method call finished. `message_id` is the id `ExecuteDevToolsMethod` returned to the caller,
  /// which is the whole correlation: `result` is the protocol's `"result"` dictionary on success and
  /// its `"error"` dictionary on failure (`cef_devtools_message_observer.h`), and both are already
  /// the JSON object this door's completion promises — so neither is reshaped here.
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser,
                              int message_id,
                              bool success,
                              const void* result,
                              size_t result_size) override {
    CEF_REQUIRE_UI_THREAD();
    if (!browser) {
      return;
    }
    // "|result| is only valid for the scope of this callback and should be copied if necessary" —
    // and it is necessary: the completion hands this to Swift.
    NSString *payload = nil;
    if (result != nullptr && result_size > 0) {
      payload = [[NSString alloc] initWithBytes:result
                                         length:result_size
                                       encoding:NSUTF8StringEncoding];
    }
    if (payload == nil) {
      // An empty result is documented and ordinary ("which may be empty"); an empty ERROR would
      // leave the Swift side with nothing to say, so each gets the right empty object.
      payload = success ? @"{}" : CDPReasonJSON(@"the DevTools method failed without a reason");
    }
    SettlePendingCDP(browser->GetIdentifier(), message_id, success ? YES : NO, payload);
  }

  /// **The one CEF documents as losing results**: "Any method results that were pending before the
  /// agent became detached will not be delivered." Without this every call in flight at that moment
  /// would be silent forever — the exact failure the door exists to make impossible.
  void OnDevToolsAgentDetached(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    if (!browser) {
      return;
    }
    FailAllPendingCDP(browser->GetIdentifier(),
                      @"the browser's DevTools agent detached before the result arrived");
  }

 private:
  IMPLEMENT_REFCOUNTING(NormaCDPObserver);
};

/// **The second half of every close, and the one that actually finishes it.**
///
/// `DoClose` answers `true`, so CEF stops: `AlloyBrowserHostImpl::CloseContents` computes
/// `close_browser = !handler->DoClose(this)`, takes neither branch, and resets `destruction_state_`
/// to `DESTRUCTION_STATE_NONE`. Calling `CloseBrowser(true)` again just re-enters `DoClose` and
/// resets again — MEASURED, not reasoned: the repro's ledger shows `DoClose->true` for the same
/// browser id FOUR times (the close, then three sweeps) without a single `OnBeforeClose`
/// (`docs/research/2026-08-10-cef-close-completion.md`).
///
/// What remains is the header's other acceptable completion — *"proceeding with window/view
/// hierarchy tear-down"* — and on macOS that reduces to one `-dealloc`:
///
///   `-[CefBrowserHostView dealloc]` → `AlloyBrowserHostImpl::WindowDestroyed()`
///     → `window_destroyed_ = true` → `CloseBrowser(true)` → `CloseContents`, which now SKIPS
///       `DoClose` (its guard is `IsWindowless() || !window_destroyed_`) → `DestroyBrowser()`
///         → `OnBeforeClose`.
///
/// So the close completes when, and only when, CEF's own view is deallocated. Detaching it is not
/// enough; **releasing it is the whole point.** Three orderings here are deliberate:
///
///   1. This runs AFTER `CloseBrowser(true)`, never before. Released first, the header says
///      `DoClose` is not called at all ("will not be called if the browser's host window/view has
///      already been destroyed") — which would silently retire a pin, a log line and the one
///      decision that keeps CEF from sending `performClose:` to Norma's window.
///   2. The record lets go BEFORE the last reference drops. `OnBeforeClose` can arrive re-entrantly
///      inside the `dealloc` this function triggers, and `ForgetOpenBrowser` would then release the
///      record's reference to a view that is already inside its own `dealloc`.
///   3. The record is nil'd, not erased. A later close for the same browser (a shutdown sweep over a
///      tab the user closed a moment ago; the same tab closed twice) still finds its record, reads
///      `nil`, and skips the detach — `nil`, never a dangling pointer. That is the `CrZombie` crash
///      this record exists to prevent, and it is preserved here without any code messaging a freed
///      view.
void CompleteCloseByReleasingHostView(int browser_id) {
  if (g_open_browsers == nil) {
    return;
  }
  NormaCEFOpenBrowser *record = g_open_browsers[@(browser_id)];
  NSView *hostView = record.hostView;
  if (hostView == nil) {
    return;  // no record, or an earlier close already handed the view back
  }
  record.hostView = nil;  // (2) — before anything can deallocate it
  if ([hostView superview] != nil) {
    [hostView removeFromSuperview];
  }
  Log("close-releases-CEFs-host-view (its dealloc is what completes the close, id=%d)", browser_id);
  // The last reference here — but NOT the last one anywhere: `-removeFromSuperview` autoreleases
  // the view, so the `dealloc` (→ `WindowDestroyed()` → … → `OnBeforeClose`) lands when the
  // enclosing autorelease pool pops, not on this line. Measured at +290 ms on the panel-tab path,
  // one run-loop turn later; `NormaCEFShutdown` has to open a pool of its own because at quit
  // nothing ever pops the outer one.
  hostView = nil;
}

/// Record the ObjC side of a browser CEF has just created. **The one place in this file that casts
/// a CEF window handle to an `NSView`** — and the only moment where doing so is provably safe: the
/// creation has just completed, so CEF's view exists and is a subview of the parent the creation
/// record is still retaining. Every later user reads the strong reference taken here instead of
/// asking CEF again; see `NormaCEFOpenBrowser` for the crash that made that the rule.
void RememberOpenBrowser(CefRefPtr<CefBrowser> browser, NormaCEFTabBridge *bridge) {
  if (!browser || !browser->GetHost()) {
    return;
  }
  if (g_open_browsers == nil) {
    g_open_browsers = [[NSMutableDictionary alloc] init];
  }
  NormaCEFOpenBrowser *record = [[NormaCEFOpenBrowser alloc] init];
  record.hostView = CAST_CEF_WINDOW_HANDLE_TO_NSVIEW(browser->GetHost()->GetWindowHandle());
  record.bridge = bridge;
  g_open_browsers[@(browser->GetIdentifier())] = record;

  // B2 Task 3 — the CDP reply channel, registered HERE rather than lazily at the first
  // `NormaCEFExecuteCDP`, for two reasons. **Lifetime**: filled and drained beside the record above,
  // so "registered for exactly as long as the browser is open" is structural rather than a rule
  // someone maintains. **Ordering**: a registration made inside the call it is meant to hear the
  // reply to would be a race with no upside.
  //
  // It costs nothing on a browser that is never CDP'd: `AddDevToolsMessageObserver` does not attach
  // the DevTools agent (the agent attaches "in response to the first message sent while the agent is
  // detached", `cef_devtools_message_observer.h`) and no event messages are delivered unless a domain
  // has been enabled, which nothing here enables.
  g_cdp_registrations[browser->GetIdentifier()] =
      browser->GetHost()->AddDevToolsMessageObserver(new NormaCDPObserver());
  Log("cdp-observer-registered (id=%d)", browser->GetIdentifier());
}

/// Drop a closed browser's ObjC side, releasing the host view and the bridge with it.
void ForgetOpenBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser || g_open_browsers == nil) {
    return;
  }
  [g_open_browsers removeObjectForKey:@(browser->GetIdentifier())];
  // B2 Task 3, beside the removal above. The FAIL comes first and the unregister second: dropping
  // the registration destroys the observer, and an observer that is gone can deliver nothing to a
  // call still sitting in the pending map. In practice the close that brought us here has already
  // failed these (`NormaCEFCloseBrowser`); this is the belt for a browser destroyed by a route this
  // app did not initiate — CEF's own shutdown sweep, or a renderer that went away.
  FailAllPendingCDP(browser->GetIdentifier(), @"the tab's browser closed before the result arrived");
  g_cdp_registrations.erase(browser->GetIdentifier());
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
void CloseAbandonedBrowser(CefRefPtr<CefBrowser> browser, NormaCEFBrowserCreation *creation);

/// **Hand a URL to the container's "open this as a new panel tab" channel.** Returns whether it was
/// taken — `false` means there is nowhere to route it (no bridge, no observer, or nothing to open),
/// and the caller decides what to do instead.
///
/// The channel is the one `OnBeforePopup` already uses (`NormaCEFSetPopupObserver`), reused rather
/// than paralleled: it is registered on the CONTAINER VIEW, so the block it runs is the tab's own
/// and carries the tab's captured session, and everything downstream — `PanelURLPolicy.mayOpenTab`,
/// `ShellSessionHost.openPanelTab`, `panel.openTab` — is the daemon-minted tab door every other
/// panel tab comes through. A second route would be a second place for policy to be missing from.
///
/// **Scheme policy is deliberately NOT applied here.** It lives in Swift, once
/// (`PanelURLPolicy`), and the observer runs it on the far side of this call. A C seam that
/// second-guessed its caller would make the real policy impossible to locate, and a second copy of
/// an allowlist in a second language is this repo's worst known drift class.
///
/// Synchronous, no thread hop, exactly as `OnBeforePopup` calls it — CEF's UI thread IS the main
/// thread under the external pump, and what the block does is a policy check plus an RPC enqueue.
///
/// Takes the BRIDGE rather than the browser: both callers are `NormaClient` methods, and the client
/// carries its own tab (`NormaClient::Tab()`). Deriving it from the browser here meant asking CEF
/// for a window handle and messaging the view behind it, which is the zombie crash described on
/// `NormaCEFOpenBrowser`.
bool RouteURLToNewPanelTab(NormaCEFTabBridge *bridge, const std::string &url) {
  if (url.empty()) {
    return false;
  }
  if (bridge == nil || bridge.popupObserver == nil) {
    return false;
  }
  NSString *target = [NSString stringWithUTF8String:url.c_str()];
  if (target.length == 0) {
    return false;  // not valid UTF-8, or empty after conversion
  }
  bridge.popupObserver(target);
  return true;
}

/// Put `text` on the general pasteboard. **Presentation, not a door** — copying a string loads
/// nothing and stores nothing, so `PanelURLPolicy`'s allowlist does not apply and is not consulted
/// (see that file's "Not every caller of `isAllowed` is one of these doors").
void CopyToGeneralPasteboard(const std::string &text) {
  NSString *value = [NSString stringWithUTF8String:text.c_str()];
  if (value.length == 0) {
    return;
  }
  NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
  [pasteboard clearContents];
  [pasteboard setString:value forType:NSPasteboardTypeString];
}

/// Norma's own context-menu commands. `MENU_ID_USER_FIRST`..`MENU_ID_USER_LAST` is the range CEF
/// reserves for the embedder — "All user-defined command ids should be between MENU_ID_USER_FIRST
/// and MENU_ID_USER_LAST" (`cef_context_menu_handler.h`) — and staying inside it is what keeps
/// `OnContextMenuCommand`'s `default: return false` able to hand every OTHER id back to CEF's own
/// default handling.
constexpr int kMenuIdOpenLinkInNewTab = MENU_ID_USER_FIRST + 0;
constexpr int kMenuIdCopyLinkAddress = MENU_ID_USER_FIRST + 1;
constexpr int kMenuIdCopyImageAddress = MENU_ID_USER_FIRST + 2;

/// Minimal client. `CefLifeSpanHandler` keeps `g_browsers` honest; `CefLoadHandler` exists because
/// Task 1 explicitly asked for it: "Do not trust the first navigation blindly" — it saw one
/// un-root-caused first-load failure in 23 runs, with every structural cause excluded by control,
/// and recommended wiring `OnLoadError`/`OnLoadEnd` rather than assuming the first page appears.
/// Here they log; Task 6b is where a visible retry belongs, alongside the chrome that would host it.
class NormaClient : public CefClient,
                    public CefLifeSpanHandler,
                    public CefLoadHandler,
                    public CefDisplayHandler,
                    public CefRequestHandler,
                    public CefContextMenuHandler {
 public:
  /// **ONE CLIENT PER BROWSER**, holding the in-flight record for the creation it was made for and
  /// the tab that creation belongs to. See `CreateBrowserNow` for why the client — rather than a
  /// table, an arrival order or a walk up the view hierarchy — is what maps `OnAfterCreated` back to
  /// its parent view.
  NormaClient(NormaCEFBrowserCreation *creation, NormaCEFTabBridge *bridge)
      : creation_(creation), bridge_(bridge) {}

  /// **The tab this client's browser belongs to — and the whole callback-side zombie fix.**
  ///
  /// Every callback below used to find it by casting `GetHost()->GetWindowHandle()` to an `NSView`
  /// and walking up the superview chain looking for the associated bridge. That is a message to a
  /// view nothing guarantees is alive: a tab torn down while the renderer still has updates in
  /// flight leaves CEF answering with a freed pointer, and the first `[v superview]` on it killed
  /// the browser process — and the app — at the user's live gate (`Norma-2026-08-10-152114.ips`,
  /// `ZombieObjectCrash` under `OnTitleChange`, during rapid tab switching, where every switch
  /// closes one browser mid-navigation and reloads another).
  ///
  /// The client already knows the answer with no lookup at all: it is built per browser, from the
  /// creation that named the container. Nothing here touches a view, so nothing here can touch a
  /// dead one. `nil` after `OnBeforeClose`, which is the last callback CEF promises.
  NormaCEFTabBridge *Tab() const { return bridge_; }

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  // Task 6b: address and title, for the URL field. NOT for the log — see OnLoadEnd.
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  // ⌘-click / middle-click, via `OnOpenURLFromTab` below. **These getters are the whole reason the
  // two handlers exist at all**: a `CefClient` that returns nothing for them gets CEF's documented
  // defaults for every method on them, silently — the class of gap `OnBeforePopup` was, twice over.
  // Every OTHER method on both interfaces is left at its default deliberately; nothing here changes
  // navigation, credentials, certificate errors or resource loading.
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  // The context menu: Open Link in New Tab / Copy Link Address / Copy Image Address, and the
  // removal of a stock item that does nothing on macOS. See OnBeforeContextMenu.
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }

  /// **A popup becomes a PANEL TAB — and CEF still never creates a window.** Those are two separate
  /// decisions and only the first of them changed here.
  ///
  /// **The cancel is unconditional and must stay that way.** `true` means "cancel the popup". With
  /// `false` — the base class's default — a native-hosted Alloy parent gets "a native popup window"
  /// of CEF's own (`cef_life_span_handler.h`): a top-level Chromium window outside the panel,
  /// outside every chrome verb, and outside Norma's window management. `DoClose` answers `true`,
  /// i.e. the HOST completes every close, so for a window the host does not know exists nothing ever
  /// does — a single `target="_blank"` would strand a window and its renderer process for the life
  /// of the app. The return is `NormaCEFPopupsAreCancelledSoCEFNeverCreatesAWindow()` rather than a
  /// bare literal for the same reason `DoClose`'s is: a test can read the VALUE, which a binary
  /// string scan structurally cannot.
  ///
  /// **What the user gets instead** is an ordinary daemon-minted panel tab, opened through the app's
  /// existing door (`ShellSessionHost.openPanelTab` → `panel.openTab`), in the session THIS browser
  /// belongs to. Nothing here decides that: the URL is handed to the container's `popupObserver`,
  /// which is the tab's own block and therefore carries the tab's captured session. Scheme policy
  /// (`PanelURLPolicy`) runs on the Swift side of that call, where it lives for every other panel
  /// url — a page-supplied URL is exactly the untrusted input it exists for, and a C seam that
  /// second-guessed its caller would make the real policy impossible to locate. A refusal there is
  /// silent here by construction and costs the user a link that does not open, which is what a
  /// popup blocker does.
  ///
  /// **Only a GESTURED popup is routed** — `user_gesture` is true for a clicked link or a
  /// `window.open` inside a click handler, false for one fired by a timer or `DOMContentLoaded`,
  /// which is the classic ad-popup shape. The ungestured case is cancelled and logged, i.e. exactly
  /// today's behaviour. The reason to keep that line is stronger for Norma than for a browser: a
  /// panel tab is APPEND-ONLY SESSION STATE (`panel_tab_opened` in a log that is never
  /// auto-deleted), so an unwanted popup tab is permanent litter in the user's history rather than a
  /// window they close and forget. The cost is the honest one — an OAuth-style `window.open` issued
  /// after an `await` has lost its gesture and stays blocked — and it is not a regression, since
  /// every popup was blocked until now.
  ///
  /// **What that does NOT bound, stated rather than implied:** one gesture can drive more than one
  /// `window.open`, so a click handler opening ten tabs is not stopped by anything in this file.
  /// Chromium's own popup blocker is what normally bounds that, and whether it is active for this
  /// native-hosted Alloy embed was not verified by this change. The bound that IS held is the one
  /// that matters for an unattended page: a popup with no gesture at all opens no tab, ever.
  ///
  /// `target_disposition` is deliberately not consulted: every popup becomes an ordinary foreground
  /// tab, because `panel.openTab` activates what it mints. A ctrl-clicked "open in BACKGROUND tab"
  /// therefore comes to the front — named, not hidden; the daemon has no background-open today.
  ///
  /// No per-popup state is kept, so `OnBeforePopupAborted` is not implemented and does not need to
  /// be: it fires only for a popup that was ALLOWED and then failed (`cef_life_span_handler.h`), and
  /// nothing here is ever allowed.
  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
                     CefRefPtr<CefFrame> frame,
                     int popup_id,
                     const CefString &target_url,
                     const CefString &target_frame_name,
                     WindowOpenDisposition target_disposition,
                     bool user_gesture,
                     const CefPopupFeatures &popupFeatures,
                     CefWindowInfo &windowInfo,
                     CefRefPtr<CefClient> &client,
                     CefBrowserSettings &settings,
                     CefRefPtr<CefDictionaryValue> &extra_info,
                     bool *no_javascript_access) override {
    CEF_REQUIRE_UI_THREAD();
    NSString *url = [NSString stringWithUTF8String:target_url.ToString().c_str()] ?: @"";
    NormaCEFTabBridge *bridge = Tab();
    // `target_url` "may be empty if not specified with the request" (`cef_life_span_handler.h`) —
    // `window.open()` with no argument. There is no address to open a tab at, so it is cancelled
    // like any other unroutable popup rather than opening a blank one.
    const BOOL routable = user_gesture && url.length > 0 && bridge != nil &&
                          bridge.popupObserver != nil;
    if (routable) {
#if DEBUG
      // Same privacy split as OnLoadEnd: a shipped build never writes the page's address anywhere.
      // The literal is the needle `CEFRuntimeTests
      // .testTheBrowserClientROUTESPopupsIntoPanelTabsRatherThanBlockingThem` scans the built
      // product for — change this message and change that needle with it.
      Log("popup-routed-to-panel-tab %s", target_url.ToString().c_str());
#else
      Log("popup-routed-to-panel-tab");
#endif
      // SYNCHRONOUS, no thread hop — matching `navigationObserver`'s own call in `OnLoadEnd` and
      // `NotifyState`, both of which rely on the same read fact: CEF's UI thread IS the main thread
      // under the external pump, so the block is already where AppKit and the main actor want it.
      // What it runs is a policy check and an RPC enqueue (`Task { @MainActor }`) — no published
      // state is written before this returns, so nothing can tear this browser's view down inside
      // CEF's own callback frame.
      bridge.popupObserver(url);
    } else {
#if DEBUG
      Log("popup-blocked (gesture=%d, observer=%d) %s", user_gesture ? 1 : 0,
          (bridge != nil && bridge.popupObserver != nil) ? 1 : 0, target_url.ToString().c_str());
#else
      Log("popup-blocked (gesture=%d, observer=%d)", user_gesture ? 1 : 0,
          (bridge != nil && bridge.popupObserver != nil) ? 1 : 0);
#endif
    }
    return NormaCEFPopupsAreCancelledSoCEFNeverCreatesAWindow();  // YES = cancel the popup
  }

  // MARK: CefRequestHandler — ⌘-click and middle-click

  /// **⌘-click, middle-click and shift-click open a NEW PANEL TAB.** Until this, they performed an
  /// ordinary click.
  ///
  /// The gap was a missing handler, not a bug in a present one — the third instance of the class
  /// `OnBeforePopup` was, and it is worth naming precisely because nothing fails when a
  /// `CefClient` returns no `CefRequestHandler`: those clicks arrive here, and the DOCUMENTED
  /// DEFAULT is `false`, which `cef_request_handler.h` spells out as "allow the navigation to
  /// proceed in the source browser's TOP-LEVEL FRAME" — i.e. exactly the normal-click behaviour the
  /// user reported. The same header says which clicks these are: "user-initiated navigation that
  /// might open in a special way (e.g. links clicked via middle-click or ctrl + left-click)".
  ///
  /// **The disposition names the modifier, and `cef_types.h` states each one:**
  ///
  ///   * `CEF_WOD_NEW_BACKGROUND_TAB` — "Middle mouse button or meta/ctrl key while clicking",
  ///     i.e. plain ⌘-click and plain middle-click;
  ///   * `CEF_WOD_NEW_FOREGROUND_TAB` — "Shift key + Middle mouse button or meta/ctrl key while
  ///     clicking", i.e. ⌘⇧-click;
  ///   * `CEF_WOD_NEW_WINDOW` — "Shift key while clicking". Norma has no second browser window to
  ///     put it in and never will (a panel browser lives in the shell's window, which is why
  ///     `OnBeforePopup` cancels), so it becomes a tab. That is a real difference from Chrome,
  ///     stated rather than hidden;
  ///   * `CEF_WOD_NEW_POPUP` — included for completeness. A page-driven `window.open` does not come
  ///     through here (it goes to `OnBeforePopup`, via Chromium's window-creation path), so this is
  ///     not a second chance to double-open the same popup.
  ///
  /// **`CEF_WOD_CURRENT_TAB` and everything else return `false` and are untouched** — including
  /// `CEF_WOD_SAVE_TO_DISK` (alt-click), which needs a `CefDownloadHandler` this build does not
  /// have, `CEF_WOD_OFF_THE_RECORD`, `CEF_WOD_NEW_PICTURE_IN_PICTURE` and `CEF_WOD_NEW_SPLIT_VIEW`
  /// (Chrome-product surfaces with no Norma equivalent), and `CEF_WOD_SINGLETON_TAB` /
  /// `CEF_WOD_SWITCH_TO_TAB`, which mean "reuse the tab already showing this URL" — a lookup
  /// nothing here can do, and answering them with a NEW tab would be a wrong answer rather than a
  /// missing one.
  ///
  /// **Foreground vs. background does not survive, and pretending otherwise would be a lie in a
  /// comment.** A plain ⌘-click asks for a BACKGROUND tab; `panel.openTab` appends
  /// `panel_tab_activated` (`packages/core/src/ipc/server.ts`), so every tab this opens comes to
  /// the front. The daemon has no background-open today. `OnBeforePopup` records the same fact
  /// about its own routing.
  ///
  /// **Gated on `user_gesture`, for the reason `OnBeforePopup` is gated on it** — a panel tab is
  /// append-only session state in a log that is never auto-deleted, so an unwanted tab is permanent
  /// litter rather than a window the user closes and forgets. This case is narrower than the popup
  /// one: the header describes a second, non-click source of these callbacks ("certain types of
  /// cross-origin navigation initiated from the renderer process (e.g. navigating the top-level
  /// frame to/from a file URL)"), and an ungestured one of those must navigate, not mint a tab.
  ///
  /// **Returning `false` when the route is not taken is deliberate, not a fallback nobody thought
  /// about.** With no bridge or no observer — a tab already dismantled — `true` would cancel the
  /// navigation and the click would do nothing at all; `false` leaves today's behaviour, which is a
  /// navigation in place. A click that does the old thing beats a click that does nothing.
  bool OnOpenURLFromTab(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        const CefString &target_url,
                        WindowOpenDisposition target_disposition,
                        bool user_gesture) override {
    CEF_REQUIRE_UI_THREAD();
    const bool wantsItElsewhere = target_disposition == CEF_WOD_NEW_BACKGROUND_TAB ||
                                  target_disposition == CEF_WOD_NEW_FOREGROUND_TAB ||
                                  target_disposition == CEF_WOD_NEW_WINDOW ||
                                  target_disposition == CEF_WOD_NEW_POPUP;
    if (!wantsItElsewhere || !user_gesture) {
      return false;  // proceed in the source browser's top-level frame — CEF's own default
    }
    if (!RouteURLToNewPanelTab(Tab(), target_url.ToString())) {
      return false;
    }
    // The literal is the needle `CEFRuntimeTests
    // .testCommandAndMiddleClicksOPENANEWPANELTABInsteadOfNavigatingInPlace` scans the built
    // product for — change this message and change that needle with it. It sits INSIDE the branch
    // the route's own return value guards, so it cannot be reached without the call having
    // happened: a stronger coupling than the `popup-routed-to-panel-tab` needle beside it, which
    // is merely adjacent to its call.
#if DEBUG
    // Same privacy split as OnLoadEnd and OnBeforePopup: a shipped build never writes the page's
    // address anywhere.
    Log("click-routed-to-panel-tab (disposition=%d) %s", static_cast<int>(target_disposition),
        target_url.ToString().c_str());
#else
    Log("click-routed-to-panel-tab (disposition=%d)", static_cast<int>(target_disposition));
#endif
    return true;  // cancel the in-place navigation; the tab is where it went
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    g_browsers.push_back(browser);
    // Beside the line above, and drained beside its counterpart in `OnBeforeClose`: the ObjC side
    // of this browser — CEF's host view, retained here while it is provably alive, and the tab it
    // belongs to. Recorded BEFORE the abandoned check below, because the abandoned path closes the
    // browser and needs the host view like every other close path does.
    RememberOpenBrowser(browser, bridge_);

    // The creation is over, so CEF is done with the raw parent handle: `CreateHostWindow()` has
    // already run (it is a step of the very call that ends in this callback). Dropping the record
    // releases the retain that carried the view across the gap.
    NormaCEFBrowserCreation *creation = creation_;
    creation_ = nil;

    if (creation.abandoned) {
      // The panel tab was dismantled while this creation was still inside CEF's own queue, where
      // `NormaCEFCloseBrowser` had nothing it could cancel. Closing here is what keeps that from
      // leaving a live browser — and a live renderer process — parented into a detached view that
      // nothing will ever close again.
      //
      // Deferred by one main-queue turn, and the retain is deferred with it (the record goes into
      // the block). Two reasons, both about not tearing down what CEF is still holding: this
      // callback runs INSIDE the creation call, which is not finished with the browser it is
      // announcing — the initial navigation is started after this returns — and CEF's own host view
      // is a subview of the retained parent right now, so releasing the parent first could
      // deallocate that view out from under a live browser. `CloseAbandonedBrowser` does both, in
      // that order, once the creation frame has unwound.
      Log("creation-was-abandoned — closing the orphan browser (id=%d)", browser->GetIdentifier());
      CefRefPtr<CefBrowser> orphan = browser;
      dispatch_async(dispatch_get_main_queue(), ^{
        CloseAbandonedBrowser(orphan, creation);
      });
      return;
    }

    creation.parent = nil;
    // Task 6b: a browser that exists but has not navigated yet still has chrome to draw (both
    // arrows disabled, no address). Pushing the empty snapshot now means the chrome's state comes
    // from exactly one channel from the very first frame, instead of a default it invents itself.
    //
    // Read from the client's own tab, like every other callback: the bridge is the one
    // `CreateBrowserNow` attached to this creation's container, so the answer needs neither a view
    // walk nor the parent the record was carrying.
    NotifyState(Tab());
    Log("browser created (id=%d, live browsers=%zu)", browser->GetIdentifier(), g_browsers.size());
  }

  /// **`true` — and the default of `false` closes NORMA'S OWN WINDOW.**
  ///
  /// Found at the user's live gate: closing a panel tab, or clicking Cowork in the sidebar with a
  /// tab open, made the whole app window vanish. The process survived (menu-bar orb still working,
  /// no crash report) — it was the window dying, not the app, and both triggers are the same event:
  /// something calls `NormaCEFCloseBrowser`, which calls `CloseBrowser(true)`. (Then, SwiftUI
  /// dismantling the panel's `PanelCEFView`; since browser-runtime T4, `BrowserRuntime.stop` — the
  /// caller moved, the mechanism below did not.)
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
  /// runs; the close was initiated BY that tear-down. **The obligation is discharged by
  /// `CompleteCloseByReleasingHostView`, which RELEASES CEF's host view** — read that function,
  /// because everything about why this returns `true` safely lives there.
  ///
  /// The distinction is not pedantry, it is the whole bug this comment used to have. It said the
  /// obligation was discharged by "removing CEF's host view from the container", and detaching a
  /// view is not destroying it: `-removeFromSuperview` only drops the SUPERVIEW's retain. What
  /// completes the close is `-[CefBrowserHostView dealloc]`, which calls
  /// `AlloyBrowserHostImpl::WindowDestroyed()` — the only remaining route to `DestroyBrowser()`
  /// once this method has answered `true`. For as long as anything else held that view, the detach
  /// happened, the log lines printed, and the browser never closed at all
  /// (`docs/research/2026-08-10-cef-close-completion.md`).
  ///
  /// `OnBeforeClose` then fires (the header: "will be called after DoClose() ... and immediately
  /// before the browser object is destroyed"), which is what keeps `g_browsers` draining and the
  /// renderer process exiting. Verified by measurement, not assumed — returning `true` without
  /// completing the close trades a window-close bug for a renderer leak, and did exactly that for
  /// one shipped day.
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

  /// **The last callback CEF promises for this browser** — "immediately before the browser object is
  /// destroyed" (`cef_life_span_handler.h`) — so it is where both of this client's ObjC references
  /// end.
  ///
  /// **What late callbacks in the window BEFORE this one do, decided rather than left to chance:
  /// they update the tab normally.** Between `CloseBrowser` and here, a renderer's in-flight title,
  /// address and load-state messages still arrive, and every one of them lands on the container's
  /// bridge exactly as it would for an open browser.
  ///
  /// That is a real change and worth stating: before this fix they were dropped BY ACCIDENT on the
  /// lucky path (the walk started at a view the close had already detached, so it found no bridge)
  /// and crashed the app on the unlucky one (it started at a view the close had already freed).
  /// Landing them is the deliberate answer, for three reasons:
  ///
  ///   * On the panel-tab path there is nothing to land on. `BrowserRuntime.stop` clears all three
  ///     observers BEFORE it calls `NormaCEFCloseBrowser` (as `PanelCEFView.dismantleNSView` did
  ///     before browser-runtime T4 moved that sequence, in the same order and for the same reason),
  ///     so a late update writes to an object nobody is watching — precisely the "somewhere to land
  ///     harmlessly" the container-keyed bridge was designed for.
  ///   * On the shutdown path the observers are still wired, and what a late callback reports is a
  ///     navigation that genuinely committed. Reporting a true thing during a quit is not a defect;
  ///     inventing one would be, and nothing here invents anything.
  ///   * Dropping them needs a "closing" flag whose only effect is to discard information that is,
  ///     as far as anything here knows, correct.
  ///
  /// The dedupe memory (`lastReportedURL`/`lastReportedTitle`) is what keeps a late duplicate out of
  /// the session log, and none of this touches it. What the window must NOT do is find the bridge by
  /// messaging a view — that is the crash, and `Tab()` is why it no longer happens.
  ///
  /// Clearing here rather than at `CloseBrowser` also keeps the client from carrying a tab's
  /// observer blocks — which capture the SwiftUI model — for as long as CEF happens to hold the
  /// client alive after the browser is gone.
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    for (auto it = g_browsers.begin(); it != g_browsers.end(); ++it) {
      if ((*it)->IsSame(browser)) {
        g_browsers.erase(it);
        break;
      }
    }
    // Beside the erase above, exactly as `OnAfterCreated` fills both beside each other. By the time
    // this runs the record's `hostView` is already `nil` — releasing it is what BROUGHT us here
    // (`CompleteCloseByReleasingHostView`), so this drops the bridge and the empty record, not the
    // view. Reaching here with a view still attached would mean CEF destroyed a browser whose host
    // view outlived it, which the close paths make unreachable; the release is idempotent either
    // way.
    ForgetOpenBrowser(browser);
    bridge_ = nil;
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
    ApplyLoadingState(isLoading, canGoBack, canGoForward);
  }

  /// The body of the callback above, and **the seam its pin calls**
  /// (`NormaCEFTabAfterOneClientCallbackWithNoViewAnywhere`).
  ///
  /// The split is not decoration. The override itself is unreachable from any test in this repo,
  /// and not because of the arguments: `CEF_REQUIRE_UI_THREAD()` expands to `DCHECK(CefCurrentlyOn(
  /// TID_UI))`, `DCHECK_IS_ON()` is true in any build without `NDEBUG`, and `CefCurrentlyOn` reaches
  /// libcef through `libcef_dll_dylib.cc`'s function-pointer table — which is all zeroes until the
  /// framework is `dlopen`ed. The unit-test host never loads CEF, so calling any override there is
  /// a null call, not a test. Everything BELOW that line needs no browser, no frame and no view, so
  /// it is the part a test can run — and the part the zombie fix is about.
  void ApplyLoadingState(bool isLoading, bool canGoBack, bool canGoForward) {
    NormaCEFTabBridge *bridge = Tab();
    if (bridge == nil) {
      return;
    }
    bridge.isLoading = isLoading;
    bridge.canGoBack = canGoBack;
    bridge.canGoForward = canGoForward;
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
    NormaCEFTabBridge *bridge = Tab();
    if (bridge != nil) {
      bridge.url = url;
      // **Only a title that belongs to THIS document may be written down.** A page with no
      // `<title>` of its own never fires `OnTitleChange`, so an unqualified cache would attribute
      // the previous page's name to it — permanently, in an append-only log. The provenance check
      // is what makes the cache safe; see `titleURL`.
      NSString *title = [bridge.titleURL isEqualToString:url] ? (bridge.title ?: @"") : @"";
      // Consecutive-duplicate suppression, seeded across browser lifetimes by
      // `NormaCEFSeedTabState`. A reload, or a re-created browser landing back on the
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
    NormaCEFTabBridge *bridge = Tab();
    if (bridge == nil) {
      return;
    }
    bridge.url = [NSString stringWithUTF8String:url.ToString().c_str()] ?: @"";
    NotifyState(bridge);
  }

  /// A title arrives with no statement of which page it belongs to, so the page is recorded WITH
  /// it, from the main frame itself rather than from our own `url` cache (no dependency on whether
  /// `OnAddressChange` happens to have run first).
  ///
  /// **This provenance is not defensive tidiness — it was measured.** Reporting the cached title
  /// unqualified, with `OnLoadStart` clearing it at each commit, was the first shape of this code,
  /// and the live gate caught it in one run: reloading a page wrote a SECOND log entry with an
  /// EMPTY title, because Chromium fires no `OnTitleChange` when the title has not changed, so the
  /// clear was never undone. Dropping the clear alone would have swapped that for the opposite bug
  /// — an untitled page inheriting the previous page's name. Only the pairing fixes both.
  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString &title) override {
    CEF_REQUIRE_UI_THREAD();
    NormaCEFTabBridge *bridge = Tab();
    if (bridge == nil) {
      return;
    }
    bridge.title = [NSString stringWithUTF8String:title.ToString().c_str()] ?: @"";
    CefRefPtr<CefFrame> main = browser->GetMainFrame();
    bridge.titleURL = main ? ([NSString stringWithUTF8String:main->GetURL().ToString().c_str()] ?: @"")
                           : @"";
    NotifyState(bridge);
  }

  // MARK: CefContextMenuHandler — the two-finger click

  /// **The stock CEF menu, minus a dead verb, plus the link and image items Chrome has.**
  ///
  /// The fourth instance of the missing-handler class: with no `CefContextMenuHandler`, CEF builds
  /// `CefMenuManager::CreateDefaultModel`'s menu and shows it. That model adds **no link items at
  /// all** — for a page or frame it is exactly Back, Forward, separator, Print, View Page Source,
  /// which is verbatim what the user saw when they two-finger-clicked a link.
  ///
  /// **`MENU_ID_VIEW_SOURCE` is REMOVED because it does nothing on macOS.** Not "nothing useful" —
  /// nothing. Every hop is in CEF's own source on branch `7922`, the exact Chromium branch of the
  /// framework this repo vendors (`chromium-151.0.7922.109`):
  /// `CefMenuManager::ExecuteDefaultCommand` → `GetFocusedFrame()->ViewSource()` →
  /// `CefFrameHostImpl::ViewSource` (`SendCommandWithResponse("GetSource", ViewTextCallback)`) →
  /// `CefBrowserHostBase::ViewText` → `platform_delegate_->ViewText(text)` →
  /// `CefBrowserPlatformDelegateNativeMac::ViewText`, whose entire body is
  /// `// TODO(cef): Implement this functionality.` and `NOTIMPLEMENTED();`. The base
  /// `CefBrowserPlatformDelegate::ViewText` is also `NOTIMPLEMENTED()` and the Alloy delegate does
  /// not override it, so there is no macOS implementation anywhere; in a release framework
  /// `NOTIMPLEMENTED()` compiles to nothing at all. It never reaches a URL, a `view-source:`
  /// navigation or a popup — so this is not a scheme-policy question and the policy was not
  /// widened for it. Shipping a menu item that silently does nothing is worse than not shipping it.
  ///
  /// **The additions go at the TOP, above the stock items, with one separator between** — where
  /// Chrome puts them, and the only position where "Open Link in New Tab" reads as being about the
  /// thing under the cursor rather than about the page. `InsertItemAt`/`InsertSeparatorAt` rather
  /// than `AddItem`, which appends to the bottom.
  ///
  /// **"Open Link in New Tab" is offered for a link the scheme policy would refuse** (a
  /// `javascript:` href, which exists in the wild), and that is a decision rather than an
  /// oversight. The alternative — hiding the item when the URL is not `http`/`https` — needs an
  /// allowlist HERE, in C++, which is a second copy of `PanelURLPolicy` in a second language with
  /// no compile-time coupling to the first. This repo has been bitten by exactly that shape more
  /// than once (the `TRANSIENT_EVENT_TYPES` hand-copy; the field caps that agreed on the number and
  /// disagreed on the unit), and `NormaCEF.h` already states the rule for this file: scheme policy
  /// lives in Swift, in one place, because a C seam that second-guesses its caller makes the real
  /// policy impossible to locate. The cost is honest and small: the item appears, the door refuses
  /// it, nothing opens — the same outcome a `javascript:` popup already has, and the same one Chrome
  /// gives (it too offers the item and then declines to navigate).
  ///
  /// **"Copy Link Address" and "Copy Image Address" are PRESENTATION, not doors** — copying a
  /// string to the pasteboard loads nothing and persists nothing, so no policy applies to them, per
  /// `PanelURLPolicy`'s own "Not every caller of `isAllowed` is one of these doors".
  ///
  /// Everything else in the stock model is left alone: Back, Forward and Print all work.
  void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           CefRefPtr<CefContextMenuParams> params,
                           CefRefPtr<CefMenuModel> model) override {
    CEF_REQUIRE_UI_THREAD();

    // The log literal is the needle `CEFRuntimeTests
    // .testViewPageSourceIsREMOVEDFromTheMenuBecauseItDoesNothingOnMacOS` scans the built product
    // for, and it is INSIDE the branch the removal's own return value guards — so it cannot be
    // reached without the `Remove` having happened, and having found something to remove. Change
    // the message and change the needle with it.
    if (model->Remove(MENU_ID_VIEW_SOURCE)) {
      Log("context-menu-view-source-removed");
    }

    const std::string link = params->GetLinkUrl().ToString();
    // `HasImageContents()` and not merely a non-empty source URL: `GetSourceUrl` is also set for
    // `<audio>` and `<video>` (`cef_context_menu_handler.h`), and "Copy Image Address" on a video
    // would be a wrong label rather than a missing feature. Media items are out of scope.
    const std::string image = params->GetSourceUrl().ToString();
    const bool onALink = !link.empty();
    const bool onAnImage = params->HasImageContents() && !image.empty();
    if (!onALink && !onAnImage) {
      return;
    }

    // Read BEFORE inserting: the separator below belongs between our items and the stock ones, and
    // must not be added when there are no stock ones to separate from (an empty model happens — the
    // default model adds nothing at all for some node types).
    const size_t stockItems = model->GetCount();
    size_t at = 0;
    if (onALink) {
      // These two labels are `__cstring` literals in the built product and are what
      // `testTheContextMenuOFFERSNormasOwnLinkAndImageItems` scans for. They are the items
      // themselves, not a log beside them.
      model->InsertItemAt(at++, kMenuIdOpenLinkInNewTab, "Open Link in New Tab");
      model->InsertItemAt(at++, kMenuIdCopyLinkAddress, "Copy Link Address");
    }
    if (onAnImage) {
      model->InsertItemAt(at++, kMenuIdCopyImageAddress, "Copy Image Address");
    }
    if (stockItems > 0) {
      model->InsertSeparatorAt(at);
    }
  }

  /// Run one of the three commands above. `false` for every other id — including all of CEF's own —
  /// so Back, Forward and Print keep their default handling, which is the whole reason the ids live
  /// in the `MENU_ID_USER_FIRST` range.
  ///
  /// `true` for ours even when nothing happened (a link the Swift door refuses, a tab already
  /// dismantled): the command WAS handled here, and returning `false` would ask CEF to look for a
  /// default implementation of an id it has never heard of.
  bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefContextMenuParams> params,
                            int command_id,
                            EventFlags event_flags) override {
    CEF_REQUIRE_UI_THREAD();
    switch (command_id) {
      case kMenuIdOpenLinkInNewTab:
        // The same channel `OnBeforePopup` and `OnOpenURLFromTab` use — one route, three
        // producers. No gesture check: choosing an item from a context menu IS the gesture.
        RouteURLToNewPanelTab(Tab(), params->GetLinkUrl().ToString());
        return true;
      case kMenuIdCopyLinkAddress: {
        // `GetUnfilteredLinkUrl` exists for precisely this: "the link URL, if any, to be used ONLY
        // for 'copy link address'" (`cef_context_menu_handler.h`). It falls back to the filtered
        // one rather than copying nothing.
        std::string address = params->GetUnfilteredLinkUrl().ToString();
        if (address.empty()) {
          address = params->GetLinkUrl().ToString();
        }
        CopyToGeneralPasteboard(address);
        return true;
      }
      case kMenuIdCopyImageAddress:
        CopyToGeneralPasteboard(params->GetSourceUrl().ToString());
        return true;
      default:
        return false;
    }
  }

 private:
  /// The creation this client was built for, until `OnAfterCreated` ends it. **This is what owns
  /// the strong reference to the parent view** (the record holds it; the client holds the record),
  /// which is why the retain cannot outlive CEF's interest in the raw handle: CEF releases the
  /// client, ARC releases the record, the record releases the view. That covers the path no
  /// callback covers — a creation CEF abandons internally, for which no `OnAfterCreated` ever comes.
  NormaCEFBrowserCreation *creation_ = nil;

  /// The tab this browser belongs to — see `Tab()` for what it replaced and why. **Strong**, and an
  /// ObjC pointer member of a C++ class is exactly that under ARC, which is what `creation_` above
  /// has always relied on: ARC gives the class a destructor that releases it, and
  /// `IMPLEMENT_REFCOUNTING`'s `delete this` runs it when CEF drops the last reference to the
  /// client. Cleared in `OnBeforeClose` so it is released with the browser rather than with the
  /// client, which CEF may hold for longer.
  NormaCEFTabBridge *bridge_ = nil;

  IMPLEMENT_REFCOUNTING(NormaClient);
  DISALLOW_COPY_AND_ASSIGN(NormaClient);
};

class NormaApp : public CefApp, public CefBrowserProcessHandler {
 public:
  NormaApp() = default;

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }

  /// **Works around an upstream CEF/Chromium crash that killed the browser process deterministically
  /// on any single-page-app navigation.** Reproduced by the live gate as "searching on YouTube
  /// reliably kills it"; two crash reports, byte-identical top-22 frames, same faulting instruction.
  ///
  /// Symbolicated against CEF's own `release_symbols` dSYM (UUID matches the shipped framework):
  ///
  ///     0  tabs::TabInterface::GetFromContents(content::WebContents*)  +24   <- null deref, x0 = 0
  ///     1  ReadAnythingSoftNavigationObserver::OnSoftNavigation()      +44
  ///     2  page_load_metrics::PageLoadTracker::OnSoftNavigation()
  ///     3  PageLoadMetricsUpdateDispatcher::UpdateSoftNavigationMetrics(...)
  ///     8  page_load_metrics::mojom::PageLoadMetricsStubDispatch::Accept(...)   <- mojo, from the renderer
  ///
  /// `tabs::TabInterface::GetFromContents` is **Chrome's tab-strip abstraction**
  /// (`//chrome/browser/ui/tabs`). A CEF browser is not a Chrome `Tab`, so the lookup yields null
  /// and `OnSoftNavigation` dereferences it at `+0x10` — a Chrome-browser-only observer running in
  /// an embedding where the object it assumes cannot exist. Nothing in Norma is on that stack: the
  /// only frames of ours are the pump driving `CefDoMessageLoopWork`, which is how ALL CEF work runs.
  ///
  /// A "soft navigation" is the SPA case — `history.pushState` treated as a navigation for metrics.
  /// That is why it needs a real site to reproduce and never appeared in any test: YouTube's search
  /// box is a pushState navigation, so every search hit it.
  ///
  /// We cannot patch Chromium, so we remove the TRIGGER. Both flags are metrics/perf-timeline
  /// heuristics with no effect on what a page renders or how it navigates; disabling them costs a
  /// `soft-navigation` PerformanceEntry that nothing in Norma consumes. **Revisit on every CEF
  /// bump** — this is upstream's bug to fix, and the switch should come out when it is.
  ///
  /// Browser process only: the header (`cef_app.h:203-205`) warns that editing a non-browser
  /// process's command line is undefined behaviour "including crashes". CEF propagates
  /// `--disable-features` to the renderers itself.
  void OnBeforeCommandLineProcessing(const CefString &process_type,
                                     CefRefPtr<CefCommandLine> command_line) override {
    if (!process_type.empty() || !command_line) {
      return;
    }
    // Append rather than assign: a bare AppendSwitchWithValue would silently drop any value CEF or
    // a future caller had already put there.
    static const char kSwitch[] = "disable-features";
    static const char kFeatures[] = "SoftNavigationDetection,SoftNavigationHeuristics";
    std::string value = kFeatures;
    if (command_line->HasSwitch(kSwitch)) {
      const std::string existing = command_line->GetSwitchValue(kSwitch).ToString();
      if (!existing.empty()) {
        value = existing + "," + kFeatures;
      }
    }
    command_line->AppendSwitchWithValue(kSwitch, value);
    Log("disable-features=%s (upstream ReadAnythingSoftNavigationObserver null-deref)", value.c_str());
  }

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

  // **The handle above is RAW and the call below does not block.** The record holds the parent view
  // for the length of the creation — see `NormaCEFBrowserCreation` for the crash that happens when
  // nothing does. The container's bridge takes a weak handle to it so that a tab dismantled
  // mid-creation can still find this creation and mark it abandoned (`NormaCEFCloseBrowser`).
  NormaCEFBrowserCreation *creation = [[NormaCEFBrowserCreation alloc] init];
  creation.parent = parent;
  NormaCEFTabBridge *bridge = BridgeFor(parent);
  bridge.creation = creation;
  Log("creation-retains-parent-view (CreateBrowser does not block and its parent handle is raw)");

  // **A CLIENT PER BROWSER, and not as a matter of taste.** `OnAfterCreated` has to know which
  // creation it is ending — to drop the retain, and to close the browser if that creation was
  // abandoned — and the client is the only thing CEF hands back that answers without an inference.
  // The two alternatives are both guesses: the browser's own window handle is a subview of the
  // parent only once `CreateHostWindow()` has run, which is a timing claim nothing in this repo can
  // test (CEF never starts under XCTest), and matching by arrival order breaks the moment anything
  // else creates a browser. CEF calls this object's `OnAfterCreated`, and this object was
  // constructed with the parent, so there is nothing left to work out.
  //
  // The container's BRIDGE goes in with it, for the callback side of the same argument: every
  // display and load callback needs the tab, and the only other way to reach it from a callback is
  // to message the view behind CEF's window handle — the zombie crash `NormaClient::Tab()`
  // describes.
  CefBrowserSettings browser_settings;
  CefRefPtr<NormaClient> client = new NormaClient(creation, bridge);
  if (!CefBrowserHost::CreateBrowser(window_info, client, CefString(url), browser_settings, nullptr,
                                     nullptr)) {
    // Refused outright — CEF posted nothing, so no `OnAfterCreated` is coming and nothing else would
    // ever drop the retain.
    creation.parent = nil;
    Log("CreateBrowser refused the request");
  }
}

/// Close a browser whose panel tab was dismantled while CEF was still creating it, then release the
/// view the creation was holding — **in that order**. Reaching here means `NormaCEFCloseBrowser`
/// ran during the one window it cannot act in; see `NormaCEFBrowserCreation.abandoned`.
///
/// Same two-step close as `NormaCEFCloseBrowser`, for the same reason: `DoClose` answers `true`, so
/// completing the close is ours — read that function's comment. The `IsValid` guard covers the
/// browser having been closed already between `OnAfterCreated` and this turn, which
/// `NormaCEFCloseAllBrowsers` does on the shutdown path.
///
/// The host view comes from the browser's own record rather than from CEF's window handle, and that
/// matters precisely because of the case the `IsValid` guard does NOT cover: a shutdown sweep that
/// has already released this browser's view but whose `OnBeforeClose` has not landed yet leaves
/// `IsValid` true and the handle pointing at freed memory (`NormaCEFOpenBrowser`).
void CloseAbandonedBrowser(CefRefPtr<CefBrowser> browser, NormaCEFBrowserCreation *creation) {
  CEF_REQUIRE_UI_THREAD();
  if (browser && browser->IsValid() && browser->GetHost()) {
    browser->GetHost()->CloseBrowser(true);
    CompleteCloseByReleasingHostView(browser->GetIdentifier());
  }
  // Only now: until the line above, CEF's host view was a subview of this one, and dropping the last
  // reference to a superview takes its subviews with it.
  creation.parent = nil;
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

/// The browser hosted inside `parent`, if any — **matched by tab identity, not by walking views.**
///
/// A container's bridge is its identity here: `OnAfterCreated` files the bridge its client was built
/// with alongside the browser, so the question "which open browser belongs to this container" is two
/// live ObjC pointers compared. Nothing is messaged.
///
/// It used to ask CEF for every open browser's window handle and send `isDescendantOf:` to whatever
/// came back. That is the zombie hazard `NormaCEFOpenBrowser` describes, and this was its widest
/// exposure: every chrome verb — back, forward, reload, stop, load — walks this list, and the list
/// contains OTHER tabs' browsers, including ones already mid-close whose host view has been detached
/// and freed.
CefRefPtr<CefBrowser> BrowserForParent(NSView *parent) {
  NormaCEFTabBridge *bridge = ExistingBridgeFor(parent);
  if (bridge == nil) {
    return nullptr;
  }
  for (auto &browser : g_browsers) {
    NormaCEFOpenBrowser *open = OpenBrowserRecordFor(browser);
    if (open != nil && open.bridge == bridge) {
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

/// live-gate fix H. See `NormaCEFSetPreShutdownHook` in the header for what it is for and why it is
/// a hook rather than a second `willTerminate` observer.
static void (^g_pre_shutdown_hook)(void) = nil;

// ---------------------------------------------------------------------------
// The C entry points — the Swift-facing seam
// ---------------------------------------------------------------------------

// INTERNAL, not part of the header's surface (whole-branch review F9). It was exported with a
// caller obligation nobody had — "nothing else in this header may be called before this returns
// YES" — which is discharged here instead: `NormaCEFInitialize` below is its only caller, and
// every other entry point guards on `g_initialized`.
static BOOL NormaCEFLoadLibrary(void) {
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
  //
  // The handle is deliberately never destroyed — the framework stays loaded for the life of the
  // process. It was `static` until the whole-branch review (F9), which did nothing: the value is
  // overwritten on every call and the function early-returns on `g_library_loaded` anyway, so the
  // storage class only read as though it were load-bearing.
  void *loader = cef_scoped_library_loader_create(0 /* 0 = main process, not helper */);
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

  const bool ok = CefInitialize(main_args, settings, g_app.get(), nullptr);
  if (!ok) {
    g_last_error = "CefInitialize failed (exit code " + std::to_string(CefGetExitCode()) + ")";
    Log("FAILED: %s", g_last_error.c_str());
    g_app = nullptr;
    return NO;
  }
  g_initialized = true;
  Log("CefInitialize ok; context initialized synchronously = %s",
      g_context_initialized ? "yes" : "no");

  // The shutdown guarantee lives HERE, with the thing it guards, rather than in a line of
  // AppDelegate that could be deleted without anything failing to compile. It is registered only
  // once CEF is actually up, so a build that never starts CEF never arms it.
  //
  // **This block is now the WHOLE real-quit teardown guarantee.** The whole-branch review's F7 fix
  // deleted `NormaApplication`'s `-terminate:` override — it destroyed browsers on quit-cancel too,
  // blanking the panel permanently — which leaves exactly one path from a real quit to
  // `CefShutdown`: this subscription. Deleting these six lines compiles, links, and leaves the
  // suite green while the app quits without ever shutting CEF down.
  //
  // The `Log` below exists so that is no longer true: its literal lands in `__cstring`, survives
  // stripping, and `testTheTerminationObserverIsACTUALLYSUBSCRIBED` scans the built product for it
  // — the same technique, and the same reason, as the `CEF_USE_SANDBOX` and `DoClose` pins. It
  // pins that the registration EXISTS, not that the notification fires (a host that must never
  // start CEF cannot observe that). If you change this message, change that needle with it — the
  // coupling is deliberate and is written at both ends.
  if (g_termination_observer == nil) {
    g_termination_observer = [[NormaCEFTerminationObserver alloc] init];
    [[NSNotificationCenter defaultCenter] addObserver:g_termination_observer
                                             selector:@selector(applicationWillTerminate:)
                                                 name:NSApplicationWillTerminateNotification
                                               object:nil];
    Log("willTerminate-observer-armed (the only path from a real quit to CefShutdown)");
  }
  return YES;
}

BOOL NormaCEFIsInitialized(void) {
  return g_initialized ? YES : NO;
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
  // but that is timing, not contract, and `BrowserRuntime.startBrowser`'s create (one main-queue
  // hop after the engine's `.create`) can plausibly run before the context on a slower or busier
  // launch. The queue costs nothing and removes the ordering assumption.
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
  // Deliver the current snapshot immediately rather than waiting for the next CEF callback. A plain
  // tab switch does not re-register this any more — since browser-runtime T4 the observers stay
  // wired for the browser's whole life, cleared only in `stop` — so what re-registers against a
  // container whose state is already known is the rarer case: a session hop, a relaunch, or a tab
  // the lifecycle engine stopped and has now recreated. Without this the chrome would sit blank
  // until the page happened to change something.
  if (observer != nil) {
    NotifyState(bridge);
  }
}

void NormaCEFSetNavigationObserver(NSView *parent, void (^observer)(NSString *url, NSString *title)) {
  BridgeFor(parent).navigationObserver = observer;
}

void NormaCEFSetPopupObserver(NSView *parent, void (^observer)(NSString *url)) {
  BridgeFor(parent).popupObserver = observer;
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
  // The seeded title belongs to the seeded URL — without this the provenance check in `OnLoadEnd`
  // would reject it, the restore would report an EMPTY title, and the dedupe it exists to feed
  // would miss on its very first comparison. The two mechanisms have to agree about what a title
  // is attached to or neither works.
  bridge.titleURL = seedURL;
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

// ---------------------------------------------------------------------------
// B2 Task 3: the CDP door
// ---------------------------------------------------------------------------

void NormaCEFExecuteCDP(NSView *parent,
                        const char *method,
                        const char *paramsJSON,
                        NormaCEFCDPCompletion completion) {
  if (completion == nil) {
    // Nobody to answer. Deliberately NOT "run it anyway": every verb this door serves exists for its
    // reply, so a call with no completion is a caller bug, and running it would hide the bug behind a
    // side effect on a page the user is logged into.
    Log("cdp REFUSED: no completion block");
    return;
  }
  // Copied once, here, so every exit below hands back the same block — a stack block escaping into
  // the pending map is the classic ARC hazard on this shape.
  NormaCEFCDPCompletion answer = [completion copy];

  if (method == nullptr || *method == '\0') {
    answer(NO, CDPReasonJSON(@"no DevTools method was named"));
    return;
  }
  if (!g_initialized) {
    // The header's standing promise — every entry point is safe with CEF never loaded — and here it
    // is also the always-answers contract: the unit-test host and a failed `CefInitialize` both land
    // on this line, and both must produce a reply rather than a hang.
    answer(NO, CDPReasonJSON(@"the browser engine is not running"));
    return;
  }
  auto browser = BrowserForParent(parent);
  if (!browser || !browser->GetHost()) {
    answer(NO, CDPReasonJSON(@"this tab has no live browser"));
    return;
  }

  CefRefPtr<CefDictionaryValue> params;
  if (paramsJSON != nullptr && *paramsJSON != '\0') {
    CefRefPtr<CefValue> parsed = CefParseJSON(CefString(paramsJSON), JSON_PARSER_RFC);
    if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) {
      // `ExecuteDevToolsMethod` takes a dictionary, and CEF's own validation of a malformed one is
      // asynchronous and silent — "messages that fail due to formatting errors or missing parameters
      // may be discarded without notification" (`cef_browser.h`). Refusing here is what keeps that
      // documented silence from becoming this door's silence.
      answer(NO, CDPReasonJSON(@"the DevTools params were not a JSON object"));
      return;
    }
    params = parsed->GetDictionary();
  }

  // 0 = "assign the next id yourself". Passing our own would collide with the sequence CEF hands to
  // any other session on the same browser (a DevTools front-end the user opened), and the id is only
  // ever used to correlate — it is never chosen for meaning.
  const int messageId = browser->GetHost()->ExecuteDevToolsMethod(0, CefString(method), params);
  if (messageId <= 0) {
    // "will return the assigned message ID if called on the UI thread and the message was
    // successfully submitted for validation, otherwise 0" — so this is a submit that never happened,
    // and registering a pending entry for it would be registering one that can only ever be failed
    // by a later close.
    answer(NO, CDPReasonJSON(@"the browser refused to submit the DevTools method"));
    return;
  }
  // **The ordering assumption, stated rather than assumed.** A DevTools method result travels back
  // through the agent, never re-entrantly out of the call above, so registering after the submit is
  // safe — but if that were ever untrue the reply would find no pending entry and be dropped, and
  // this completion would never fire. That is the one hole in the always-answers contract that lives
  // on this line, and the caller's own deadline is what covers it (`PanelCommandConsumer`'s
  // abandonment timer, which exists for the app-is-wedged case anyway).
  RememberPendingCDP(browser->GetIdentifier(), messageId, answer);
}

NSString *NormaCEFPendingCDPTranscriptForOneBrowserWithNoCEFAnywhere(void) {
  // Ids far outside anything CEF hands out in this process, so a real browser cannot collide with
  // the fixture even if one is somehow open while a test runs.
  const int browserA = 910001;
  const int browserB = 910002;
  NSMutableArray<NSString *> *fired = [[NSMutableArray alloc] init];

  RememberPendingCDP(browserA, 1, ^(BOOL ok, NSString *payload) {
    [fired addObject:[NSString stringWithFormat:@"A1 ok=%d %@", ok ? 1 : 0, payload]];
  });
  RememberPendingCDP(browserA, 2, ^(BOOL ok, NSString *payload) {
    [fired addObject:[NSString stringWithFormat:@"A2 ok=%d %@", ok ? 1 : 0, payload]];
  });
  RememberPendingCDP(browserB, 1, ^(BOOL ok, NSString *payload) {
    [fired addObject:[NSString stringWithFormat:@"B1 ok=%d %@", ok ? 1 : 0, payload]];
  });

  // One reply settles exactly the call that asked — same id, other browser, must not move.
  SettlePendingCDP(browserA, 1, YES, @"{\"value\":1}");
  // The same id again: the entry is gone, so this fires nothing. (A duplicate reply, or a fail-all
  // racing a result, is the shape this guards.)
  SettlePendingCDP(browserA, 1, YES, @"{\"value\":2}");
  // The browser goes away with A2 still in flight: it must be FAILED, never stranded.
  FailAllPendingCDP(browserA, @"the tab's browser was closed");
  // And again, with nothing left — no second fire.
  FailAllPendingCDP(browserA, @"the tab's browser was closed");
  // B's own call is untouched by everything above; drained here so this seam leaves no state behind.
  FailAllPendingCDP(browserB, @"the tab's browser was closed");

  return [fired componentsJoinedByString:@";"];
}

BOOL NormaCEFPopupsAreCancelledSoCEFNeverCreatesAWindow(void) {
  // Flipping this to NO does NOT "let popups through to somewhere else" — it hands CEF a window
  // Norma has no handle on and, because `DoClose` says the host completes every close, nothing can
  // ever close it. Popups reach the user as PANEL TABS (see `OnBeforePopup`); this answer is what
  // keeps CEF out of the window business while they do.
  // `CEFRuntimeTests.testPopupsAreStillCANCELLEDSoCEFNeverCreatesAWindowOfItsOwn` reads this value.
  return YES;
}

BOOL NormaCEFDoCloseIsHandledByHost(void) {
  // Flipping this to NO re-opens the live-gate Critical: CEF would send `performClose:` to the
  // browser's top-level parent window, which is Norma's own app window. `CEFRuntimeTests
  // .testDoCloseAnswersThatTheHostHandlesTheCloseSoCEFNeverTouchesNormasWindow` reads this value.
  return YES;
}

BOOL NormaCEFClientInstallsTheClickAndMenuHandlers(void) {
  // **The two lines this asks about are the whole feature's on-switch, and a string scan cannot
  // see them.** Measured, not assumed: deleting only `GetRequestHandler` and
  // `GetContextMenuHandler` — leaving every override, every literal and every menu label in the
  // binary — makes ⌘-click and the whole context menu dead at runtime and left all 18 CEF pins
  // GREEN. That is the exact "passes with the thing it protects deleted" shape this file exists to
  // stop, so it is closed here rather than merely disclosed.
  //
  // A real instance is constructed and the real virtual methods are called THROUGH `CefClient`,
  // which is how CEF itself asks. That is what makes this different from the two constant answers
  // above: delete a getter and the base class's `nullptr` is what comes back.
  //
  // Safe with CEF down (the unit-test host, always). `NormaClient` and every CEF interface it
  // derives from are header-only, abstract and inline — the app already links without the
  // framework, which is `dlopen`ed — so nothing here reaches libcef, and the client is destroyed
  // by `CefRefPtr` on return without ever having been handed to a browser.
  CefRefPtr<CefClient> client = new NormaClient(nil, nil);
  return client->GetRequestHandler() != nullptr && client->GetContextMenuHandler() != nullptr;
}

NSObject *NormaCEFRecordAfterACloseHandsTheHostViewBack(NSView *hostView) {
  // A record filled the way `RememberOpenBrowser` fills one, minus the single line that needs a
  // `CefBrowser`: the cast of CEF's window handle. Everything the close reads — the dictionary, the
  // key, the strong `hostView` — is the production shape.
  if (g_open_browsers == nil) {
    g_open_browsers = [[NSMutableDictionary alloc] init];
  }
  // A synthetic id. CEF never starts in the unit-test host
  // (`testTheRuntimeRefusesToStartCEFUnderXCTest`), so no real browser can collide with it, and the
  // key is removed again below either way.
  const int kSeamBrowserId = -424242;
  NormaCEFOpenBrowser *record = [[NormaCEFOpenBrowser alloc] init];
  record.hostView = hostView;
  record.bridge = [[NormaCEFTabBridge alloc] init];
  g_open_browsers[@(kSeamBrowserId)] = record;

  // The production close's second half, verbatim — the same function all three close paths call.
  CompleteCloseByReleasingHostView(kSeamBrowserId);

  // What `OnBeforeClose` would do next, so the seam models the whole lifetime and leaves no
  // process-global state behind for the tests that run after it.
  [g_open_browsers removeObjectForKey:@(kSeamBrowserId)];
  return record;
}

NSObject *NormaCEFTabAfterOneClientCallbackWithNoViewAnywhere(void) {
  // A bridge with no container. That is the whole point: before this fix a callback could only
  // reach a tab THROUGH a view, so this object could not exist in a test at all.
  NormaCEFTabBridge *bridge = [[NormaCEFTabBridge alloc] init];
  CefRefPtr<NormaClient> client = new NormaClient(nil, bridge);
  // The real body of `CefLoadHandler::OnLoadingStateChange`, called exactly as the override calls
  // it. The override cannot be called here — `CEF_REQUIRE_UI_THREAD()` reaches libcef through a
  // function-pointer table that is all zeroes until the framework is `dlopen`ed, and this host never
  // loads it — which is why the body is a seam; see `NormaClient::ApplyLoadingState`.
  //
  // The three values are deliberately not all `true`: `canGoBack = false` is the control, so a
  // stub that wrote constants instead of arguments would fail this rather than satisfy it.
  client->ApplyLoadingState(/*isLoading=*/true, /*canGoBack=*/false, /*canGoForward=*/true);
  // The object handed back is the one the client was CONSTRUCTED with, so reading the flags off it
  // is what proves the callback found this tab and not one it made up.
  return bridge;
}

void NormaCEFCloseBrowser(NSView *parent) {
  if (parent == nil) {
    return;
  }
  // A creation for this parent can be waiting in either of two queues, and only the first of them
  // is ours.
  //
  // OURS — `g_pending`, everything asked for before `OnContextInitialized`. Pruned here, by parent.
  if (g_pending != nil) {
    NSMutableArray<NormaCEFPendingBrowser *> *survivors = [[NSMutableArray alloc] init];
    for (NormaCEFPendingBrowser *request in g_pending) {
      if (request.parent != nil && request.parent != parent) {
        [survivors addObject:request];
      }
    }
    g_pending = survivors;
  }
  // CEF'S — everything already handed to `CefBrowserHost::CreateBrowser`, which does not block and
  // exposes no way to cancel. There is nothing to prune and no browser to close yet, so the request
  // is MARKED instead: `OnAfterCreated` closes the browser the moment it arrives. Without this the
  // browser below finds nothing, this function returns having closed nothing, and the browser turns
  // up afterwards parented into a view the panel has already thrown away.
  if (NormaCEFBrowserCreation *creation = ExistingBridgeFor(parent).creation) {
    creation.abandoned = YES;
    Log("creation-abandoned-in-CEFs-queue (its browser is closed the moment it arrives)");
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
    //    hierarchy tear-down" (`cef_life_span_handler.h`). `CompleteCloseByReleasingHostView` IS
    //    that tear-down, and on macOS it is a single `-dealloc` — read its comment, because the
    //    whole close hangs off it.
    //
    // **CORRECTING A MEASUREMENT THAT WAS TRUE AND IS NOT ANY MORE.** This block used to say the
    // detach was optional on the panel-tab path, because B1 measured that with it deleted
    // `OnBeforeClose` still fired and `g_browsers` still drained — SwiftUI's release of the
    // container discharging the obligation. That was true, and it stopped being true the moment
    // `NormaCEFOpenBrowser` started holding CEF's host view strongly (`51a43124`): SwiftUI's
    // release no longer reaches the view, because the record outlives the container. What B1
    // actually measured was never the DETACH — it was the RELEASE that the detach happened to
    // cause. Re-measured on the shipped code, the close stalled for the whole 12.3 s run with the
    // renderer alive (`docs/research/2026-08-10-cef-close-completion.md`); with the release
    // restored the view was still alive at +0 ms and gone by the next sample at +290 ms — one
    // autorelease drain later, which is all the 250 ms poll can resolve. Not optional on any path.
    //
    // The view comes from this browser's own record, taken when CEF created it. Asking
    // `GetWindowHandle()` here instead is what the fetch-before-close ordering used to be about —
    // it "is not guaranteed to answer once the close is under way" — and the ordering was never the
    // real hazard: the handle answers with a pointer to a view that a previous close (a shutdown
    // sweep, or this tab closed twice) may already have released. See `NormaCEFOpenBrowser`.
    // B2 Task 3: **fail every in-flight CDP call BEFORE the close starts.** This is the
    // deterministic one of the three fail points — the app decided this close, so it knows here and
    // now that no reply is coming. `OnBeforeClose` is the belt behind it and lands later (a close
    // completes on an autorelease drain, measured at +290 ms), which for a caller holding a deadline
    // is the difference between an honest immediate failure and a timeout.
    FailAllPendingCDP(browser->GetIdentifier(), @"the tab's browser was closed");
    browser->GetHost()->CloseBrowser(true);
    CompleteCloseByReleasingHostView(browser->GetIdentifier());
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
    // completing the close is ours to do. See its comment — including why the view comes from the
    // browser's record. This sweep is where that mattered most: it runs over EVERY open browser,
    // and a tab the user closed a moment before quitting is still one of them — with a host view
    // `NormaCEFCloseBrowser` has already released, its `OnBeforeClose` still in flight. That record
    // now reads `nil`, so this sweep skips it: nil, never a pointer into freed memory.
    //
    // Nothing is skipped that shouldn't be: a browser whose `OnBeforeClose` has run is no longer in
    // `g_browsers` at all, and one whose close is genuinely still to be started still has its view.
    //
    // B2 Task 3: same fail-before-close as `NormaCEFCloseBrowser`, for the same reason. This sweep
    // runs from `NormaCEFShutdown`, where the completions are the last thing anything will hear.
    FailAllPendingCDP(browser->GetIdentifier(), @"the tab's browser was closed");
    browser->GetHost()->CloseBrowser(true);
    CompleteCloseByReleasingHostView(browser->GetIdentifier());
  }
}

void NormaCEFSetPreShutdownHook(void (^hook)(void)) {
  g_pre_shutdown_hook = [hook copy];
}

void NormaCEFShutdown(void) {
  if (!g_initialized) {
    // Never initialised: there is nothing to shut down, and calling CefShutdown would dispatch
    // through a dylib stub that was never resolved. This no-op is what makes the termination
    // wiring safe in every build — including the unit-test host, which never starts CEF.
    //
    // **And it does NOT set `g_did_shutdown`** (whole-branch review F10). That flag is what makes
    // `NormaCEFInitialize` refuse forever and `NormaCEFRuntime.isRetryable` answer false, so
    // latching it here would mean a call that did nothing at all permanently closed the door on
    // starting CEF. It is process-global and nothing resets it, so in the unit-test host the one
    // test that exercises this path was silently changing `isRetryable` for every test that ran
    // after it. A no-op that mutates state is not a no-op — and the header calls this one.
    return;
  }
  if (g_did_shutdown) {
    return;
  }
  g_did_shutdown = true;
  g_shutting_down = true;
  if (auto *pump = ExternalPump::Get()) {
    pump->KillTimer();
  }
  // **The pool is the point, and it must open before the sweep and close before the loop.**
  //
  // Completing a close means deallocating CEF's host view (`CompleteCloseByReleasingHostView`), and
  // `-removeFromSuperview` AUTORELEASES that view rather than releasing it. Every other close in
  // this app is on a normal run-loop turn, so AppKit's own pool pops a moment later and the dealloc
  // lands — measured at +290 ms on the panel-tab path. This one is not: the pool active during
  // `applicationWillTerminate:` never drains, because the process exits first, and there is no
  // other `@autoreleasepool` in the app (checked, zero). CEF turns cannot pop an AppKit pool, so
  // the loop below ran its full 50 iterations against a view that was never going to die — provably
  // all 50, since its only early exit is `g_browsers.empty()` and `g_browsers` was not empty at the
  // end.
  //
  // MEASURED on this exact code before the pool was added — a quit with one tab open printed
  // `shutting down (1 browser(s) still open, ...)`, with `browser closed (id=1)` arriving
  // AFTERWARDS, i.e. from inside `CefShutdown()`. The drain was not draining; process teardown was
  // doing its job for it. With the pool: `browser closed (id=1, live browsers=0)` first, then
  // `shutting down (0 browser(s) still open, ...)`.
  //
  // (The `DoWork calls` figure in that line counts the PUMP's turns, not this loop's — it is
  // unchanged across both runs and proves nothing either way. The browser count is the measurement.)
  //
  // Nesting it per-iteration inside the loop would do nothing: the autorelease has already been
  // registered in the enclosing pool by then. The sweep's own pool is the only one that can take it.
  //
  // **The pre-shutdown hook runs INSIDE it, and that placement is measured rather than tidy**
  // (live-gate fix H). The hook exists so the embedder can unparent CEF's host views before the
  // sweep releases them; unparenting is `-removeFromSuperview`/`-addSubview:`, which AUTORELEASES —
  // and a view moving between windows takes its whole subtree through
  // `viewWillMoveToWindow:`/`viewDidMoveToWindow`, autoreleasing as it goes. Run before this pool
  // opens, every one of those lands in the outer pool that never drains, so the hook was PINNING the
  // very host views it was supposed to free: measured at `2 browser(s) still open, 50/50` with the
  // hook outside, against `1 still open` with no hook at all. Inside, its autoreleases and the
  // sweep's pop together, which is the whole mechanism this pool was added for.
  @autoreleasepool {
    if (g_pre_shutdown_hook != nil) {
      g_pre_shutdown_hook();
    }
    NormaCEFCloseAllBrowsers();
  }
  // **MEASURED AT THE RUNTIME'S FULL WORLD (browser-runtime T7), not at one tab.** The 50×10 ms
  // bound was set when a quit meant one browser. The runtime's world was 8 browsers when this was
  // measured (`BrowserLifecycleEngine.maxLive`, since replaced by a memory budget with a count
  // backstop of 24 — live-gate fix G), and seven of
  // those are parked in `BrowserRuntime`'s hidden window with their containers held strongly by its
  // `containers` map — which nothing clears at quit. That is the same shape as the T6 deadlock one
  // layer up, and it costs nothing, because `CompleteCloseByReleasingHostView` does
  // `-removeFromSuperview` FIRST: the container's retain on CEF's view is severed whether or not the
  // container itself ever dies.
  //
  // Measured with 8 live browsers, 7 of them parked (`SpikeCloseLeak`,
  // `NORMA_SPIKE_CLOSE_BROWSERS=8`), and the parked pages' playback SAMPLED rather than assumed —
  // `PARK-AUDIO parked=7 playing=7 refused=0`, read off each tab's own model at quit, with
  // `--autoplay-policy=no-user-gesture-required` on the command line (without it a parked page in a
  // hidden window is the likeliest thing in the app to be refused autoplay, and the run says so
  // either way: nothing here depends on playback, which is why it is reported rather than required).
  // All eight closes completed —
  // `browser closed (id=1, live browsers=0)` ahead of `shutting down (0 browser(s) still open)` —
  // **in `0/50` drain turns.** Zero is not a rounding: `g_browsers` was already empty at the loop's
  // first check, because the `dealloc`s the pool pops run `WindowDestroyed()` → `DestroyBrowser()` →
  // `OnBeforeClose` synchronously, on this thread, before the loop is reached. So on a healthy quit
  // **the pool is the whole mechanism and the drain is unused margin** — which is precisely why the
  // bound is left at 50 rather than widened: nothing has ever consumed the first turn of it.
  //
  // CloseBrowser is asynchronous and the run loop is about to stop, so the pump can no longer
  // deliver the turns CEF needs. Drive them directly, bounded — CEF's own external-pump sample does
  // the same thing after `[NSApp run]` returns (`main_message_loop_external_pump_mac.mm:114-125`,
  // "run the message pump until it is idle... we don't have that information here so we run the
  // message loop 'for a while'").
  //
  // **What these turns are for, stated after the measurement rather than before it.** This block
  // used to say they "carry `DestroyBrowser()` through to `OnBeforeClose`" — T7 measured that they
  // carry nothing at all on a healthy quit, because the pool above already did (`0/50`). They are
  // the net for the case the pool cannot close: a browser whose host view is still retained by
  // something else when the pool pops, whose `dealloc` therefore lands later.
  //
  // **That case is no longer hypothetical — the user's real quit hit it, and the pre-shutdown hook
  // above is the fix** (live-gate fix H). T7's harness parked everything, so it never mounted a
  // container in an app window; the shipped app always does, for the shown tab. A container in a
  // window is reachable from that window's view hierarchy and its responder chain (the runtime makes
  // Chromium's `RenderWidgetHostViewCocoa` first responder on every attach), and those retains are
  // not the pool's to drop — so `CompleteCloseByReleasingHostView`'s release was not the last one,
  // the `dealloc` never ran, and the loop below spent all 50 turns for nothing. The hook unparents
  // every container before the sweep, which is what puts the pool back in the position T7 measured.
  int turns = 0;
  for (; turns < kShutdownDrainTurns && !g_browsers.empty(); turns++) {
    CefDoMessageLoopWork();
    usleep(10000);
  }
  // `turns` is the DRAIN's own count and is the bound's evidence: it says how much of the 50 a real
  // quit actually needed. (`DoWork calls` beside it counts the PUMP's turns for the whole process
  // lifetime and says nothing about this loop — it is left in because it is the pump's own
  // liveness figure.)
  //
  // ── **THE TRIPWIRE'S CONTRACT (browser-runtime T7, AMENDED BY THE USER'S REAL QUIT — live-gate
  //    fix H). `N > 0` HAS NO BENIGN CASE.** ────────────────────────────────────────────────────
  //
  //   * **The branch T7 called "reachable in principle, never observed" was OBSERVED**, and it was
  //     not the racing-create one it predicted. The user's ledger read `shutting down (2 browser(s)
  //     still open, 50/50 drain turns, 35807 DoWork calls)` followed by `browser closed (id=30, live
  //     browsers=0)` from inside `CefShutdown` — the pre-pool signature exactly, with the pool
  //     present. Cause: a browser whose container has been MOUNTED in a real window, which the
  //     harness's all-parked runs could not produce; reproduced at
  //     `NORMA_SPIKE_CLOSE_MOUNTED=1` as `1 browser(s) still open, 50/50`.
  //   * **The hook above is NOT what fixed it, and that is the sharp part.** Unparenting inside
  //     this function leaves CEF's host view at a retain count of 17 (against 5 for a
  //     never-mounted one) — measured — and 1.5 s of spun run loop here only reaches 14. Nothing
  //     *inside* the terminate sequence releases those references; they drop after an unparent
  //     followed by ORDINARY run-loop turns. So the fix lives in the app, one beat before
  //     `NSApp.terminate` is called at all (`AppDelegate.quitReleasingBrowserViews`, which carries
  //     the whole measured table): retain 5, **`0 browser(s) still open, 0/50 drain turns`** with a
  //     mounted browser at quit. The hook stays as the belt for a shutdown reached without that
  //     door.
  //   * **So `N > 0` still has a live cause, and it is named:** a quit that does not pass through
  //     `quitReleasingBrowserViews` — a system logout arrives straight at
  //     `applicationShouldTerminate` — with a browser that has been on screen. Its renderer is
  //     reclaimed by `CefShutdown` a moment later rather than leaked, and the cost is this loop's
  //     500 ms. Spec §10 gate 10 says to report it, not wave it through.
  //   * **What remains reachable and is still not reproduced:** a creation whose `OnAfterCreated`
  //     lands *after* the sweep, i.e. inside this loop — which requires the loop to run at all.
  //
  // The T7 measurements below stand as taken, and are what a healthy quit still looks like:
  //
  //   * **Healthy quit, any number of browsers: N = 0.** Measured at 8 (7 parked, all with a live
  //     media element).
  //   * **Quit racing an in-flight create: N = 0, measured.** `NORMA_SPIKE_CLOSE_RACE` puts K
  //     creations into CEF's own queue in the same run-loop turn as the quit (K = 3, 3, 8 — with
  //     nothing in between that spins the run loop, which is a real hazard: the spike's own `ps`
  //     census defeated the first attempt by delivering the pump turns the creations were waiting
  //     for). `OnAfterCreated` never fired for any of them, so they never reached `g_browsers` and
  //     never counted; `CefShutdown` took them. No crash, exit 0.
  //   * **The T3 abandon path at quit: N = 0, by construction.** If `OnAfterCreated` DID land before
  //     the sweep, the browser is in `g_browsers` and the sweep closes it like any other — the
  //     `dispatch_async` that would have run `CloseAbandonedBrowser` never gets its turn (this loop
  //     drives CEF's queue, not GCD's), and it does not need one: the close it owed was already
  //     performed, and the only other thing it does is drop a retain the process is about to lose.
  //   * (T7's fourth bullet — "the one reachable nonzero, NOT reproduced" — is superseded by the
  //     amendment above: the case it named is still not reproduced, but it was no longer the *only*
  //     reachable one by the time the user quit a real app.)
  //
  // So `N > 0` means a close that did not complete. It is not a race artefact to be waved through.
  Log("shutting down (%zu browser(s) still open, %d/%d drain turns, %ld DoWork calls)",
      g_browsers.size(), turns, kShutdownDrainTurns, g_do_work_count);
  // B2 Task 3: let go of every DevTools observer registration BEFORE `CefShutdown`, and never after.
  // `g_cdp_registrations` is a file-static `std::map` of `CefRefPtr`s, so anything still in it at
  // process exit would be Released by a static destructor running after CEF is finished. It is
  // normally already empty — `ForgetOpenBrowser` erases each entry at `OnBeforeClose` — so this is
  // the same shape as the drain loop above: a bound on the case the tripwire is about (`N > 0`
  // means some browser's close did not complete, and its registration is exactly what would be left).
  g_cdp_registrations.clear();
  CefShutdown();
}

BOOL NormaCEFDidShutdown(void) {
  return g_did_shutdown ? YES : NO;
}
