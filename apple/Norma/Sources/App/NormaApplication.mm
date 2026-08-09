#import "NormaApplication.h"

// panel-cef Task 3, commit 1 of 2 — the ENTRY-POINT CHANGE ALONE.
//
// This file is deliberately CEF-free and deliberately empty right now. The task is sequenced so
// that the app's 1268-test, lifecycle-sensitive suite runs against the entry-point swap by
// itself: `main.swift` claiming the `NSApplication` singleton in place of SwiftUI's private
// `AppKitApplication`. If the harness-wide teardown machinery (`HarnessTeardownObserver`) or the
// activation-policy pins regress, that must be attributable to THIS and not to Chromium.
//
// It is `.mm` rather than `.m` from the outset for the same reason: the next commit's diff is
// then purely the CEF lines (`CefAppProtocol` conformance + the `CefScopedSendingEvent` wrap),
// not an Objective-C-to-Objective-C++ language swap tangled up with them.
@implementation NormaApplication
@end
