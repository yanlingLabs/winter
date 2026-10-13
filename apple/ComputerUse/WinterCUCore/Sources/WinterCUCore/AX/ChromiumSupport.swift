import AppKit
import ApplicationServices
import Foundation

/// Chromium and Electron apps: their accessibility tree stays an empty shell until a client asks for it,
/// and their renderers drop public pid-routed events as untrusted (hence ladder rung 3).
enum CUChromium {
    static let bundleIds: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
        "com.google.chrome.for.testing",
        "org.chromium.Chromium", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev",
        "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser",
        "company.thebrowser.dia", "com.openai.atlas",
    ]
    static let frameworkNames = ["Electron Framework.framework", "Chromium Embedded Framework.framework"]

    /// Pure classification from what is known about the app.
    static func isChromiumFamily(bundleId: String?, frameworkNames present: [String]) -> Bool {
        if let b = bundleId, bundleIds.contains(b) { return true }
        return present.contains { frameworkNames.contains($0) }
    }

    /// Looks at the bundle on disk (cached per bundle URL).
    static func isChromiumFamily(_ app: NSRunningApplication) -> Bool {
        let url = app.bundleURL
        let key = url?.path ?? "pid:\(app.processIdentifier)"
        lock.lock()
        if let c = cache[key] { lock.unlock(); return c }
        lock.unlock()
        var present: [String] = []
        if let url {
            let fw = url.appendingPathComponent("Contents/Frameworks")
            present = (try? FileManager.default.contentsOfDirectory(atPath: fw.path)) ?? []
        }
        let result = isChromiumFamily(bundleId: app.bundleIdentifier, frameworkNames: present)
        lock.lock(); cache[key] = result; lock.unlock()
        return result
    }

    private static let lock = NSLock()
    private static var cache: [String: Bool] = [:]
    private static var enabled: Set<String> = []

    /// Switches the app's accessibility tree on once per process launch, then gives the renderer a moment to build it
    /// (polling for any web area). Runs on the pid queue.
    static func enableAccessibilityOnce(_ app: NSRunningApplication) {
        let key = "\(app.processIdentifier):\(app.launchDate?.timeIntervalSince1970 ?? 0)"
        lock.lock()
        if enabled.contains(key) { lock.unlock(); return }
        enabled.insert(key)
        lock.unlock()
        let element = AX.app(app.processIdentifier)
        let set = enableAccessibility(browser: app.bundleIdentifier.map(bundleIds.contains) ?? false,
                                      set: { name in try? AX.set(element, name, kCFBooleanTrue) },
                                      pageReady: {
                                          guard let win = AX.element(element, kAXFocusedWindowAttribute) ?? AX.elements(element, kAXWindowsAttribute).first else { return false }
                                          return hasWebArea(win, depth: 0)
                                      },
                                      pause: { usleep(useconds_t($0) * 1000) })
        if set.count > 1 {
            CULog.bind.notice("\(app.localizedName ?? "a Chromium browser", privacy: .public): no page after AXManualAccessibility — AXEnhancedUserInterface set")
        }
    }

    /// The switches set, in order: `AXManualAccessibility` (Electron's and CEF's; Chrome answers it as unsupported),
    /// then — for a Chromium BROWSER whose page did not appear within ~1 s — `AXEnhancedUserInterface`, the one Chrome
    /// builds its web tree on (what VoiceOver sets). The leftover probes (2026-10-13): Chrome for Testing 156, windowed
    /// behind the user's app, answered AXManualAccessibility with kAXErrorAttributeUnsupported and showed no page —
    /// before, in front, behind again — until AXEnhancedUserInterface, after which its page was there within 3 s.
    /// Pure but for its effects: `set`, `pageReady` and `pause` are the world's.
    static func enableAccessibility(browser: Bool, set: (String) -> Void, pageReady: () -> Bool, pause: (Int) -> Void) -> [String] {
        var done = ["AXManualAccessibility"]
        set("AXManualAccessibility")
        for _ in 0..<10 {
            pause(100)
            if pageReady() { return done }
        }
        guard browser else { return done }
        done.append("AXEnhancedUserInterface")
        set("AXEnhancedUserInterface")
        for _ in 0..<20 {
            pause(100)
            if pageReady() { return done }
        }
        return done
    }

    private static func hasWebArea(_ e: AXUIElement, depth: Int) -> Bool {
        if AX.string(e, kAXRoleAttribute) == "AXWebArea" { return true }
        guard depth < 6 else { return false }
        return AX.elements(e, kAXChildrenAttribute).prefix(12).contains { hasWebArea($0, depth: depth + 1) }
    }
}
