import SwiftUI

/// panel-cef Task 3: `@main` is deliberately ABSENT — the entry point is `main.swift`, which
/// claims the `NSApplication` singleton as a `NormaApplication` (the `CefAppProtocol` subclass
/// CEF needs) and only then calls `NormaApp.main()`. The two are mutually exclusive: `swiftc`
/// rejects the `@main` attribute in any module that contains top-level code. Read `main.swift`
/// before restoring it.
struct NormaApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // LSUIElement app: no windows from the Scene graph in 2b. The orb panel and
        // menu bar are AppKit-owned (AppDelegate). Settings scene keeps SwiftUI happy
        // without showing anything.
        Settings { EmptyView() }
    }
}
