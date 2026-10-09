import AppKit
import ApplicationServices
import Foundation

/// Chromium and Electron apps: their accessibility tree stays an empty shell until a client asks for it,
/// and their renderers drop public pid-routed events as untrusted (hence ladder rung 3).
enum CUChromium {
    static let bundleIds: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
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

    /// Sets `AXManualAccessibility` once per process launch, then gives the renderer a moment to build its
    /// tree (polling for any web area, at most ~1 s). Runs on the pid queue.
    static func enableAccessibilityOnce(_ app: NSRunningApplication) {
        let key = "\(app.processIdentifier):\(app.launchDate?.timeIntervalSince1970 ?? 0)"
        lock.lock()
        if enabled.contains(key) { lock.unlock(); return }
        enabled.insert(key)
        lock.unlock()
        let element = AX.app(app.processIdentifier)
        try? AX.set(element, "AXManualAccessibility", kCFBooleanTrue)
        for _ in 0..<10 {
            usleep(100_000)
            if let win = AX.element(element, kAXFocusedWindowAttribute) ?? AX.elements(element, kAXWindowsAttribute).first,
               hasWebArea(win, depth: 0) { return }
        }
    }

    private static func hasWebArea(_ e: AXUIElement, depth: Int) -> Bool {
        if AX.string(e, kAXRoleAttribute) == "AXWebArea" { return true }
        guard depth < 6 else { return false }
        return AX.elements(e, kAXChildrenAttribute).prefix(12).contains { hasWebArea($0, depth: depth + 1) }
    }
}
