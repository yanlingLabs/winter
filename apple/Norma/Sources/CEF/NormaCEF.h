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
