#import "NormaApplication.h"

#import "include/cef_application_mac.h"

// panel-cef Task 3, commit 2 of 2 — the CEF conformance, and nothing else.
//
// Commit 1 landed the entry-point change on its own (`main.swift` claiming the `NSApplication`
// singleton in place of SwiftUI's private `AppKitApplication`) and proved the app's 1268-test
// lifecycle-sensitive suite green against it. Everything below is the delta Chromium is
// responsible for, so the two verdicts stay separable.
//
// The implementation is `cefsimple_mac.mm`'s verbatim, as quoted in
// `docs/research/2026-08-09-cef-pump.md`. `CefAppProtocol` (`include/cef_application_mac.h`) is
// only `-isHandlingSendEvent` + `-setHandlingSendEvent:`, inherited from Chromium's
// `CrAppControlProtocol`. CONFORMANCE is what CEF checks — not class identity — but the subclass
// is still required, because `sendEvent:` has to be wrapped.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO:
//
//   1. It does not touch `-terminate:`. The pump report's scratch subclass overrode it to call
//      `CefShutdown` first; there is no CEF to shut down yet, and Norma's termination path is
//      already non-trivial (`AppDelegate.applicationShouldTerminate`, the updater's idle gate).
//      That override is OWED TO THE TASK THAT CALLS `CefInitialize`, and belongs with it.
//
//   2. It does not require CEF to be present, loaded, or initialised. Verified rather than
//      assumed: `CefScopedSendingEvent` is defined inline in the header and compiles to nothing
//      but ObjC message sends against `[NSApplication sharedApplication]` — `nm -u` on this
//      translation unit shows zero CEF symbols, only AppKit, the ObjC runtime and libc++. So the
//      framework is neither linked nor `dlopen`ed by anything here, and `sendEvent:` behaves
//      exactly as before on every build, including the Debug builds that embed no CEF at all.
//
// Build requirement this adds (see `project.yml`): CEF 151's public headers need **C++20**, not
// C++17 — `cef_scoped_refptr.h:101` uses `std::same_as`.
@interface NormaApplication () <CefAppProtocol> {
 @private
  BOOL handlingSendEvent_;
}
@end

@implementation NormaApplication

- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}

- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  handlingSendEvent_ = handlingSendEvent;
}

- (void)sendEvent:(NSEvent *)event {
  CefScopedSendingEvent sendingEventScoper;
  [super sendEvent:event];
}

@end
