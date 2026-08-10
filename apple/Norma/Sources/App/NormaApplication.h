#ifndef NormaApplication_h
#define NormaApplication_h

#import <AppKit/AppKit.h>

/// panel-cef Task 3: the `NSApplication` instance Norma actually runs on.
///
/// WHY THIS EXISTS, and why it is NOT an `Info.plist` key. CEF requires its host's
/// `NSApplication` to conform to `CefAppProtocol`: `CefScopedSendingEvent` messages
/// `[NSApp setHandlingSendEvent:]` on whatever `NSApp` happens to be, and a stock
/// `NSApplication` does not answer that. Every CEF sample installs its subclass through
/// `Info.plist`'s `NSPrincipalClass`.
///
/// **That mechanism does not work under SwiftUI's `App` lifecycle** — measured, not inferred
/// (`docs/research/2026-08-09-cef-pump.md`): `SwiftUI.App.main()` never routes through
/// `NSApplicationMain`'s principal-class lookup. It constructs its own private
/// `SwiftUI.AppKitApplication` and silently ignores the key. Norma carried
/// `NSPrincipalClass: NSApplication` in `project.yml` for its entire life and it never once did
/// anything — which is also why nothing would have warned us that pointing it at a CEF subclass
/// does nothing at all.
///
/// The shape that DOES work: `+[NSApplication sharedApplication]` returns the existing `NSApp`
/// if one is already set, whichever subclass receives the message — so this class simply has to
/// get there first. `Sources/App/main.swift` claims the singleton before calling
/// `NormaApp.main()`, and SwiftUI then reuses this instance for the rest of the process's life.
/// `NormaApplicationTests` pins that at runtime, because nothing about it fails to compile.
///
/// **This header stays CEF-free on purpose.** It is dragged into every Swift compile through the
/// bridging header (`Support/NormaBridge.h`); the `CefAppProtocol` conformance lives in a class
/// extension inside `NormaApplication.mm`, so no CEF type ever reaches Swift.
@interface NormaApplication : NSApplication
@end

#endif /* NormaApplication_h */
