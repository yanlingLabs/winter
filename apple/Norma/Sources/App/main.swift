import AppKit
import SwiftUI

// panel-cef Task 3: Norma's entry point.
//
// This file exists so that `NSApp` is a `NormaApplication` — the `CefAppProtocol`-conforming
// subclass CEF requires — before SwiftUI has a chance to install its own. `NSApplication`'s
// singleton is first-come-first-served: `+[NSApplication sharedApplication]` returns the
// existing `NSApp` if one is already set, no matter which subclass receives the message. So the
// claim below wins, and SwiftUI's `App.main()` reuses the instance rather than constructing a
// `SwiftUI.AppKitApplication`. Measured working, and the delegate adaptor, the Scene graph and
// window creation all keep behaving normally: `docs/research/2026-08-09-cef-pump.md`.
//
// THE MECHANISM THIS REPLACES: `Info.plist`'s `NSPrincipalClass`, which every CEF sample uses
// and which SwiftUI's `App` lifecycle silently ignores — `App.main()` does not go through
// `NSApplicationMain`'s principal-class lookup at all. `project.yml` carried an inert
// `NSPrincipalClass: NSApplication` for the app's whole life; it has been removed, and
// `NormaApplicationTests` now pins this file's effect at runtime instead. (Unrelated, still
// live, and easy to confuse with it: the TEST BUNDLE's own `INFOPLIST_KEY_NSPrincipalClass`,
// which XCTest genuinely honours to install `HarnessTeardownObserver`.)
//
// TWO CONSTRAINTS COME WITH TOP-LEVEL CODE:
//   1. `NormaApp` must NOT carry `@main` — `swiftc` rejects "'main' attribute cannot be used in
//      a module that contains top-level code". The two are mutually exclusive.
//   2. The file must be named `main.swift`. Any other name makes these statements illegal
//      top-level expressions rather than the module's entry point.

_ = NormaApplication.shared
NormaApp.main()
