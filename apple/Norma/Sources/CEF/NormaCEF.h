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

/// `CefInitialize` with `external_message_pump = true`, plus the pump this file owns.
///
/// **It `dlopen`s the framework itself**, from `Contents/Frameworks` via
/// `CefScopedLibraryLoader::LoadInMain()` — the framework is NEVER linked directly, which
/// `include/wrapper/cef_library_loader.h` documents as a requirement of the macOS sandbox
/// implementation rather than a style choice. The loader used to be exported here as
/// `NormaCEFLoadLibrary`, with a caller obligation ("nothing else in this header may be called
/// before this returns YES") that nobody had and nobody needed: every other entry point guards on
/// initialisation, and this one loads the library on its own. It is `static` in the implementation
/// now (whole-branch review F9).
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

/// The last failure reason, for the placeholder the panel shows instead of a page. Never NULL.
const char *NormaCEFLastError(void);

/// Create a browser as a child of `parent` and navigate it to `url`. If the CEF context is not up
/// yet the request is QUEUED and replayed from `OnContextInitialized`; `parent` is held weakly, so
/// a view torn down before then simply drops out.
///
/// The queue is a CONTRACT, not a workaround: Task 1 measured
/// `CefBrowserProcessHandler::OnContextInitialized` firing SYNCHRONOUSLY inside `CefInitialize` on
/// every run, contrary to expectation — but that is timing, and creation is queued behind it
/// anyway. (A `NormaCEFIsContextInitialized` predicate was exported for that finding and never
/// called by anything; removed by whole-branch review F9, the state itself is read here.)
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
/// `OnContextInitialized` — so a registration made at create time (`BrowserRuntime.wire`, before
/// the create is even queued) is already in place whenever the browser finally arrives.
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

/// Observe URLS THIS BROWSER WANTS OPENED IN A NEW PANEL TAB. Pass `nil` to stop observing.
///
/// **THREE producers, one route** — the name says "popup" because that was the first of them and it
/// is an exported C symbol other code and one test name it by:
///
///   1. `OnBeforePopup` — `window.open`, a clicked `target="_blank"`;
///   2. `OnOpenURLFromTab` — ⌘-click, middle-click and shift-click, whose "open somewhere else"
///      dispositions CEF would otherwise navigate in place;
///   3. `OnContextMenuCommand` — the menu's "Open Link in New Tab".
///
/// They are deliberately not three channels: the observer is what carries the tab's own session and
/// the Swift-side scheme policy, and a second route would be a second place for either to be
/// missing from. Every one of them is gated on a real user gesture (for 3, choosing the item IS the
/// gesture) — see `OnBeforePopup` for the whole ruling on why, which is Norma-specific.
///
/// **This does not make CEF create anything.** `OnBeforePopup` still cancels every popup
/// unconditionally (`NormaCEFPopupsAreCancelledSoCEFNeverCreatesAWindow` below is that answer, and
/// says what a `false` there would cost); this observer fires immediately BEFORE the cancel. So the
/// popup CEF was asked for never exists, and what the user gets instead is an ordinary panel tab
/// minted by the daemon — which is the only kind of tab that persists and the only kind the tab
/// strip can close.
///
/// **Only GESTURED popups are reported.** `OnBeforePopup` receives `user_gesture`, and an
/// automatic `window.open` (a timer, `DOMContentLoaded`) is reported to nobody and simply
/// cancelled, exactly as before. The reason is stronger here than in an ordinary browser: a panel
/// tab is written to an append-only session log that is never auto-deleted, so an unwanted popup
/// tab is permanent, not merely an annoying window. See `OnBeforePopup` for the whole ruling and
/// for the residual it does NOT bound.
///
/// Registered against the CONTAINER VIEW, like the two observers above and for the same reason —
/// and here it carries a second meaning: the container is what identifies WHICH panel tab (and so
/// which session) the request came from, so none of the three producers can open a tab in a session
/// other than the one whose browser asked for it.
///
/// Called on the MAIN thread, synchronously from inside CEF's own callback — CEF's UI thread IS
/// the main thread under the external pump, which is what lets `NotifyState` and the navigation
/// observer do the same.
void NormaCEFSetPopupObserver(NSView *parent, void (^observer)(NSString *url));

/// Prime a tab with what the daemon ALREADY knows about it, before its browser is created. Two
/// effects, both of which exist because **a tab's browser can be created more than once over that
/// tab's life, each time with an empty dedupe memory**. Until browser-runtime T4 that happened on
/// every tab SWITCH (the panel's content view was `.id`'d by tab and owned the browser); since T4
/// the runtime owns it and a switch is a container swap, so the re-creations left are the ones that
/// matter longest — a session hop, a relaunch, and a tab whose browser the lifecycle engine stopped
/// coming back:
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

/// Back / forward / reload / stop, and "go to what the user typed **or the agent authored**". All
/// are no-ops when `parent` hosts no browser, and none of them validate `url` — **scheme policy
/// lives in Swift** (`PanelURLPolicy`), in one place, applied before anything reaches here. A C seam
/// that silently second-guessed its caller would make the real policy impossible to locate.
///
/// Two doors reach `NormaCEFLoadURL` since b2-agent-browser Task 3 — the panel's URL field and the
/// `panel_command` consumer — and they call the SAME policy function, which is what keeps "one
/// place" true with two producers. `NormaCEFGoBack` likewise serves the back button and the agent's
/// `back` verb; it carries no url and so no policy.
void NormaCEFGoBack(NSView *parent);
void NormaCEFGoForward(NSView *parent);
void NormaCEFReload(NSView *parent);
void NormaCEFStopLoad(NSView *parent);
void NormaCEFLoadURL(NSView *parent, const char *url);

#pragma mark - B2 Task 3: the CDP door

/// How `NormaCEFExecuteCDP` answers. **`payloadJSON` is ALWAYS a JSON OBJECT**, both ways round, so
/// the Swift side has exactly one parse to write:
///
///   * `ok == YES` — the DevTools method's `"result"` dictionary, verbatim (`{}` when it has none);
///   * `ok == NO`  — a `{"message": …}`-shaped object. For a failure CEF reported it is the
///     protocol's own `"error"` dictionary (which carries `code` and `message`,
///     `cef_devtools_message_observer.h`); for a failure this bridge decided — no live browser, CEF
///     down, unparseable params, a submit CEF refused, a browser that closed with the call still in
///     flight — it is a synthesised object carrying only `message`.
///
/// Called on the MAIN thread, like every other observer in this header (CEF's UI thread IS the main
/// thread under the external pump).
typedef void (^NormaCEFCDPCompletion)(BOOL ok, NSString *payloadJSON);

/// **Run one Chrome DevTools Protocol method against the browser hosted by `parent`** — B2's read
/// verbs (`Runtime.evaluate` for page text, `Page.captureScreenshot` for a PNG) and, from Task 5,
/// its interaction verbs.
///
/// `method` is a protocol method name (`"Runtime.evaluate"`); `paramsJSON` is that method's params
/// as a UTF-8 JSON **object** (`NULL` or empty for none). Wraps
/// `CefBrowserHost::ExecuteDevToolsMethod` and correlates the reply through a
/// `CefDevToolsMessageObserver` registered per browser, keyed by the message id CEF assigns
/// (`cef_browser.h`) — which is why nothing here needs an active DevTools front-end or a
/// remote-debugging port.
///
/// **THE COMPLETION ALWAYS FIRES — error, never silence.** That is this function's whole contract,
/// and it is shaped by the daemon's: `PanelCommandRegistry`'s promise always settles
/// (`packages/core/src/panel/commands.ts`), and a Mac app that goes quiet turns an answerable verb
/// into a `deadlineMs` timeout the agent cannot tell from a crashed app. So every refusal answers
/// synchronously before returning, and a call still in flight when its browser goes away is failed
/// at three points rather than dropped: the close this app initiates, `OnBeforeClose`, and
/// `OnDevToolsAgentDetached` (whose own header states that pending results are never delivered
/// after it).
///
/// **One reply is delivered per call, exactly once** — the pending entry is erased before its
/// completion runs, so a duplicate id, a re-entrant close and a detach racing a result cannot
/// double-answer. `NormaCEFPendingCDPTranscriptForOneBrowserWithNoCEFAnywhere` produces that
/// property rather than asserting it from a log line.
///
/// Safe to call with CEF never loaded, like everything else in this header: it answers
/// `ok = NO` with a reason and touches no framework symbol.
///
/// **What it deliberately does NOT do:** validate `method` or `paramsJSON` against any policy. The
/// URL allowlist is `PanelURLPolicy`'s (Swift), the verb set is `PanelCommandConsumer`'s, and a C
/// seam that second-guessed either would make the real policy impossible to locate — the same
/// ruling `NormaCEFLoadURL` carries.
///
/// **THIS IS ITSELF A NAVIGATION DOOR, contained by PRODUCER DISCIPLINE rather than by policy — said
/// out loud because the scheme allowlist does not reach it.** `Page.navigate` loads any URL, and so
/// does a `Runtime.evaluate` that assigns `location.href`; neither is refused here or anywhere else.
/// The containment is exactly this: **every `method` string and every expression this app sends is a
/// LITERAL written in `PanelCommandConsumer`** — `Runtime.evaluate` over one fixed text-extraction
/// expression, and `Page.captureScreenshot` — never assembled from a command's fields.
/// `panel_command.args`, the one model-authored payload on the wire, is deliberately **not read at
/// all** until Task 5 builds the interaction verbs. When it is, whatever reaches a CDP method name,
/// expression or params value must be treated as the untrusted input it is: a verb that interpolated
/// a model string into any of the three would open a navigation path door 5 cannot see.
void NormaCEFExecuteCDP(NSView *parent,
                        const char *method,
                        const char *paramsJSON,
                        NormaCEFCDPCompletion completion);

/// **Test seam.** Drive the pending-CDP registry — the half of the CDP door that decides *which*
/// completion a reply belongs to — with **no browser, no observer and no CEF anywhere**, and hand
/// back a transcript of what fired.
///
/// The question it answers is the one no needle can: does a reply settle exactly ONE call, and does
/// a browser going away still fire every completion it stranded? Neither is visible in the built
/// product (the correlation is a dictionary lookup; the fail-all is a loop) and neither is reachable
/// from XCTest through the real path, because registering an observer needs a `CefBrowser` this host
/// can never create (spec §9's standing constraint).
///
/// So the answer is produced. Two calls are registered against browser 1 and one against browser 2;
/// browser 1's first call is settled by its message id, then settled AGAIN with the same id, then
/// browser 1 is failed wholesale, then browser 2. The returned transcript is a `;`-separated list of
/// what each completion actually received, in order — a second fire for one id, a cross-talk between
/// the two browsers, or a stranded call that never fired all change it.
///
/// Never `nil`, leaves no process-global state behind (it drains what it registered), and reaches no
/// framework symbol.
NSString *NormaCEFPendingCDPTranscriptForOneBrowserWithNoCEFAnywhere(void);

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

/// The ONE answer `CefLifeSpanHandler::OnBeforePopup` gives, exported for exactly the reason the
/// function above is: a test can read the VALUE instead of inferring it from a log string, and no
/// test can call a C++ virtual method it cannot construct a `CefBrowser` for.
///
/// It must be YES — `true` from `OnBeforePopup` is "cancel the popup" (`cef_life_span_handler.h`).
/// Routing popups into panel tabs did NOT change this and must never change it: with `false`, and
/// a native-hosted Alloy parent, CEF "creates a native popup window" of its own — a top-level
/// Chromium window outside the panel, outside every chrome verb, and outside Norma's window
/// management. `DoClose` answers `true`, i.e. the HOST completes every close, so for a window the
/// host does not know exists nothing ever does: one `target="_blank"` would strand a window and its
/// renderer process for the life of the app. The tab route is the popup's destination; the cancel
/// is what keeps CEF out of the window business, and the two are independent.
BOOL NormaCEFPopupsAreCancelledSoCEFNeverCreatesAWindow(void);

/// YES when the browser client actually INSTALLS the two handlers behind ⌘-click / middle-click
/// (`CefRequestHandler`) and the context menu (`CefContextMenuHandler`).
///
/// **This is not a constant, and that is the point.** It constructs a real client and calls
/// `GetRequestHandler()` / `GetContextMenuHandler()` through `CefClient` — the same two calls CEF
/// makes — so the answer comes from the overrides themselves. The two functions above answer
/// questions about a VALUE; this one answers a question about whether code EXISTS, which no string
/// scan of the built product can: deleting the two one-line getters leaves every override, every log
/// literal and every menu label in the binary while making both features completely dead at runtime.
/// That was measured, and it left all 18 CEF pins green until this existed.
///
/// Safe to call with CEF down — see the implementation for why nothing here reaches the framework.
BOOL NormaCEFClientInstallsTheClickAndMenuHandlers(void);

/// Run ONE real browser-client callback against a tab that has **no view behind it at all**, and
/// hand the tab back for the caller to read.
///
/// The question it answers is the callback-side half of the zombie crash: does a client callback
/// find its tab through the reference it was BUILT with, or by casting CEF's window handle to an
/// `NSView` and messaging it? The second answer is what killed the app at the user's live gate
/// (`Norma-2026-08-10-152114.ips` — a late `OnTitleChange` for a browser whose panel tab had already
/// been torn down), and it cannot be distinguished by any string scan of the built product: the
/// callback, its log lines and every symbol around it are identical either way.
///
/// So the answer is produced rather than inferred. A tab object is created with no container view
/// anywhere, a client is constructed with it, and the body of `OnLoadingStateChange` is run: with
/// the fix the tab comes back carrying `isLoading = YES`, `canGoBack = NO`, `canGoForward = YES`;
/// with a lookup that needs a view — or with the reference no longer stored — it comes back
/// untouched. Read the values through KVC (`NormaCEFTabBridge` is internal to the implementation),
/// as `CEFRuntimeTests` does.
///
/// Never `nil`. Safe to call with CEF down — nothing on this path reaches the framework, which is
/// itself a load-bearing property; see the implementation.
NSObject *NormaCEFTabAfterOneClientCallbackWithNoViewAnywhere(void);

/// **Test seam.** Run the second half of a close — the half that actually completes it — against a
/// real open-browser record, and hand the record back.
///
/// The question it answers is the one the audio leak turned on: **does closing a browser RELEASE
/// CEF's host view, or only detach it?** `-[CefBrowserHostView dealloc]` is what calls
/// `AlloyBrowserHostImpl::WindowDestroyed()`, and once `DoClose` has answered `true` that is the
/// only remaining route to `OnBeforeClose`. Holding the view past the close is therefore not a leak
/// with a tidy-up cost — it is a browser that never closes, a renderer that never exits, and audio
/// the user cannot stop without quitting the app.
///
/// No string scan can ask this: the close paths, their log lines and every symbol around them are
/// identical whether the record lets go or keeps holding. So the answer is produced. `hostView` is
/// filed in a record exactly as `RememberOpenBrowser` files one, the production
/// `CompleteCloseByReleasingHostView` is run against it, and the record comes back for the caller
/// to read `hostView` through KVC (`NormaCEFOpenBrowser` is internal to the implementation). It
/// must be `nil` — and since the seam holds no other reference, a caller whose own `weak` reference
/// also went `nil` has watched the view actually deallocate, which is the event CEF is waiting for.
/// Pass a view that is a subview of something to also exercise the detach.
///
/// **What it does NOT cover, stated rather than implied.** The nil-before-release ORDERING inside
/// `CompleteCloseByReleasingHostView` (which keeps a re-entrant `OnBeforeClose` from releasing a
/// view that is already inside its own `dealloc`) is not observable from here — nothing in this host
/// can make `OnBeforeClose` fire. Neither is `RememberOpenBrowser`'s window-handle cast, nor the
/// three call sites, which need a `CefBrowser`; the call sites are covered by the weaker
/// built-product needle in `testTheZombieFixesTwoCallSitesAreCompiledIntoTheProduct`'s sibling.
///
/// Never `nil`. Safe to call with CEF down — nothing on this path reaches the framework — and it
/// leaves no process-global state, because it also does what `OnBeforeClose` would do next.
NSObject *NormaCEFRecordAfterACloseHandsTheHostViewBack(NSView *hostView);

/// Close the browser hosted by `parent`, and cancel any creation still on its way to becoming one.
/// Called from `BrowserRuntime.stop` (via `CEFDriver.closeBrowser`) — the ONLY production caller
/// since the T4 viewport rewire; `dismantleNSView` now detaches the viewport and closes nothing.
///
/// A creation can be waiting in either of two queues when this is called, and the second is why the
/// implementation is more than a close: requests made before the CEF context came up are ours to
/// drop, but a request already handed to `CefBrowserHost::CreateBrowser` is inside CEF's own queue,
/// which does not block and offers no cancel. That one is MARKED, and the browser is closed the
/// instant it is created — see `NormaCEFBrowserCreation` in the implementation for both halves and
/// for the crash the same window produced before the parent view was retained across it.
void NormaCEFCloseBrowser(NSView *parent);

/// Close every live browser. REVERSIBLE — nothing here forecloses running CEF afterwards.
///
/// **Called only from `NormaCEFShutdown` below.** Task 6a also called it from an
/// `NSApplication -terminate:` override, on the reasoning that closing browsers is the harmless
/// half of a quit; the whole-branch review (F7) found it is not. A terminate can be CANCELLED
/// (⌘Q and a dock-tile quit both answer `.terminateCancel`), and the cancel path does NOT tear the
/// panel's SwiftUI tree down when nothing is attached — so the browser was destroyed and its view
/// never rebuilt, leaving a permanently blank panel. The override is gone; see
/// `Sources/App/NormaApplication.mm` for the full ruling. Kept exported because it is one half of
/// the lifecycle this header describes and a future embedder-side caller is plausible; it has no
/// caller outside this file today.
void NormaCEFCloseAllBrowsers(void);

/// **Run this immediately before the shutdown sweep — browser-runtime live-gate fix H.**
///
/// The embedder's chance to let go of CEF's host views before the sweep releases them.
/// `NormaCEFShutdown` completes each close by RELEASING the browser's host view, and that release
/// only finishes the close if it is the LAST one; anything else still retaining the view turns the
/// close into a stall the drain loop cannot fix.
///
/// **It is the BELT, not the fix, and the difference was measured** (live-gate fix H). A browser
/// whose container has been mounted in a real window holds references that unparenting *here* does
/// not drop — retain count 17 against 5 for a never-mounted one, and 14 even with 1.5 s of run loop
/// spun inside this function. They drop after an unparent followed by ORDINARY run-loop turns, so
/// the embedder's real fix is to unparent one beat before it calls `NSApp.terminate`
/// (`AppDelegate.quitReleasingBrowserViews`, which carries the whole table). This covers a shutdown
/// reached without passing through that door — a system logout, or any future embedder-side call.
///
/// **A hook and not a notification observer, deliberately.** `NormaCEFInitialize` registers its own
/// `NSApplicationWillTerminateNotification` observer (that is what calls `NormaCEFShutdown` at all),
/// and the order in which two observers of the same notification run is undefined — so an embedder
/// that "also observed willTerminate" would be relying on registration order to be correct. This is
/// an explicit call at a defined point instead.
///
/// Called on the main thread, at most once per process, and only on a real shutdown: a
/// never-initialised or already-shut-down `NormaCEFShutdown` returns before reaching it. Passing
/// `nil` clears it. Replacing an existing hook replaces it outright — there is one embedder.
void NormaCEFSetPreShutdownHook(void (^hook)(void));

/// `CefShutdown`, preceded by closing every browser and draining the pump. The POINT OF NO RETURN —
/// CEF cannot be initialised again in this process, which is exactly why nothing calls it from
/// `-terminate:` (a terminate can be cancelled). `NormaCEFInitialize` registers this against
/// `NSApplicationWillTerminateNotification` itself, so the guarantee lives with the thing it
/// guards rather than in a line of `AppDelegate` that could be dropped — and AppKit posts that
/// notification from inside `[NSApplication terminate:]` once the delegate has answered
/// `.terminateNow`, which is what makes this the whole of the real-quit path.
///
/// **The sweep runs inside an `@autoreleasepool`, and that is load-bearing rather than tidy.** A
/// close completes when CEF's host view DEALLOCATES, and `-removeFromSuperview` autoreleases it.
/// Every other close in this app is on a normal run-loop turn, where AppKit's own pool pops a
/// moment later; this one is not — the pool active during `applicationWillTerminate:` never drains,
/// because the process exits first — and CEF's message-loop turns cannot pop an AppKit pool. Before
/// the pool was added, a measured quit with ONE TAB OPEN printed `shutting down (1 browser(s) still
/// open)`, reporting the close only afterwards, from inside `CefShutdown` itself; with it, `browser
/// closed (live browsers=0)` arrives first. **So `shutting down (N…)` with N > 0 is a genuine
/// tripwire now and was not before** — before, on any quit with a tab open, it was the normal
/// outcome and the renderer was reclaimed by process exit rather than by the close.
///
/// browser-runtime T7 measured that at the runtime's full world — 8 browsers, 7 of them parked with
/// their containers still held by `BrowserRuntime.containers` (and playing: `playing=7 refused=0`,
/// sampled per tab, under `--autoplay-policy=no-user-gesture-required`) — and at a quit racing
/// creations still inside CEF's queue. **N = 0 in both, and the drain used `0/50` of its
/// turns in both**, because the pool's `dealloc`s complete the closes synchronously before the loop
/// is reached. The implementation states the whole contract, including the one nonzero that is
/// reachable in principle and has never been observed; expect 0 on every healthy quit.
///
/// **A TRUE no-op if CEF was never initialised**: it does not run, and it does not record itself as
/// having run — `NormaCEFDidShutdown` stays NO, so a process that merely passed through this call
/// (a unit-test host; a quit before any web tab existed) is not latched into "CEF is finished" and
/// `NormaCEFInitialize` will still start. Safe to call twice.
void NormaCEFShutdown(void);

/// YES once `NormaCEFShutdown` has actually shut CEF down. Never YES for the never-initialised
/// no-op above — that asymmetry is what keeps this from being process-global state a test can
/// leak into every test that runs after it (`CEFRuntimeTests`), and what keeps
/// `NormaCEFRuntime.isRetryable` honest.
BOOL NormaCEFDidShutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* NormaCEF_h */
