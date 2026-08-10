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
//      That override was OWED TO THE TASK THAT CALLS `CefInitialize` — Task 6a took it, and the
//      whole-branch review took it back out. **This file still has no `-terminate:` override, now
//      as a RULING rather than a deferral**; see the block at the bottom for why, and for the test
//      that keeps it that way.
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

// **THERE IS DELIBERATELY NO `-terminate:` OVERRIDE, and re-adding one is a regression.**
// `CEFRuntimeTests.testTerminateIsNotOverriddenBecauseAQuitHereCanBeCANCELLED` is the tripwire.
//
// Task 6a added one — `NormaCEFCloseAllBrowsers(); [super terminate:sender];` — reasoning that
// cefsimple overrides `-terminate:` because Cocoa's default calls `exit()` and skips the rest of
// the run loop, so an embedder needs a hook there. Two-thirds of that reasoning survives and the
// conclusion does not:
//
//   1. `CefShutdown` genuinely must not be called from here. **A terminate can be CANCELLED.**
//      `AppDelegate.applicationShouldTerminate` answers `.terminateCancel` for ⌘Q and for a
//      dock-tile quit — only the menu bar's "Quit Norma", a Sparkle install and a system-initiated
//      logout/shutdown are real quits (`terminateDecision`, Lifecycle T3). `CefShutdown` is TERMINAL
//      for a process, so calling it here would leave a perfectly alive Norma whose browser panel can
//      never work again, after a keystroke the user expects to be harmless.
//
//   2. So the shutdown lives at the actual point of no return: `NSApplicationWillTerminateNotification`,
//      which `NormaCEFInitialize` subscribes to itself (`NormaCEF.mm`), so the guarantee cannot be
//      deleted from `AppDelegate` without deleting CEF's startup with it. AppKit posts that
//      notification from inside `[NSApplication terminate:]` once the delegate has answered
//      `.terminateNow` — the override was never what carried it.
//
//   3. **Closing the browsers here was NOT the harmless reversible half it was documented as.**
//      That claim rested on "every cancel path already runs `closeMainWindows()`, which tears the
//      panel down and closes those same browsers anyway". It does not: `closeMainWindows()` ends in
//      `AppWindowController.hide()`, which is `window.orderOut(nil)` — the `NSHostingView` and its
//      whole SwiftUI tree, `PanelCEFView`'s container included, survive it. The teardown that does
//      happen comes from a different chain (hide -> `setShellVisible(false)` -> `applyPolicy` ->
//      `.detach` -> `panelStore.detach()` -> `tabs = []` -> SwiftUI dismantles the view), and that
//      chain requires something to be ATTACHED: `shellAttachmentAction` returns `.none`, not
//      `.detach`, when `attached == nil`. On the new-chat page with a panel tab bound but no
//      session attached (T15's `openPanelTabForNewChatPage`), ⌘Q therefore closed the live browser
//      and removed CEF's host view while nothing ever rebuilt it — a permanently blank rectangle,
//      no placeholder, no Try again, for the life of the process.
//
//      **browser-runtime T4 retired the mechanism this point turns on, and left the conclusion
//      standing.** The container belongs to `BrowserRuntime` now, not to the SwiftUI tree, and
//      dismantling the panel's viewport only DETACHES it (`PanelViewport.dismantleNSView`) — so the
//      teardown chain above closes no browser on any path, attached or not, and the blank-rectangle
//      failure it describes is no longer reachable from here. Where browsers are actually closed at
//      a real quit is unchanged: `NormaCEFShutdown`'s own `NormaCEFCloseAllBrowsers`, inside an
//      `@autoreleasepool` before the bounded pump drain (`NormaCEF.mm`, Task 6).
//
// Dropping the call rather than making the unattached case tear down on hide, because the call was
// redundant on the one path where it worked (`NormaCEFShutdown` calls `NormaCEFCloseAllBrowsers`
// itself, then drives the pump bounded, which is CEF's own external-pump sample shape) and harmful
// on the path where it did not. Whole-branch review F7.

@end
