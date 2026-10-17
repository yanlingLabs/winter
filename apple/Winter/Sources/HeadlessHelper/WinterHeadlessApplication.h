#ifndef WinterHeadlessApplication_h
#define WinterHeadlessApplication_h

#import <AppKit/AppKit.h>

/// ComputerV2 Phase 4 — **Winter Headless's `NSApplication`**: the one CEF needs (it must conform to
/// `CefAppProtocol`, as Winter's own `WinterApplication` does), and the last line of the "never move the user's
/// view" rule for a process that should have no UI at all.
///
/// The helper is `LSBackgroundOnly` and runs only windowless browsers, so nothing in it ever means to show a
/// window or come forward. This class makes that hold even if something inside CEF or Chromium tries:
///  * it refuses to activate (`activate`, `activateIgnoringOtherApps:`) and keeps the activation policy
///    `prohibited` whatever anything asks for;
///  * `installWindowGuard` makes every `NSWindow` (and every subclass that does not draw its own ordering) refuse
///    to be ordered in — a colour panel a page's script opened, a crash alert, anything — and logs it.
///
/// This header stays CEF-free (it reaches Swift through the helper's bridging header).
@interface WinterHeadlessApplication : NSApplication

/// Refuse every window ordering-in in this process, for good. Call once, before CEF starts.
+ (void)installWindowGuard;

/// How many times a window was refused (for the helper's logs).
+ (NSInteger)refusedWindowCount;

@end

#endif /* WinterHeadlessApplication_h */
