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
    /// The browsers whose `AXEnhancedUserInterface` WINTER turned on (it was off before), by pid → launch key: turned
    /// off again when the last target in that process is released (`releaseEnhanced`).
    private static var enhancedByUs: [pid_t: String] = [:]

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
                                      enhancedAlreadyOn: { AX.attribute(element, "AXEnhancedUserInterface").flatMap(AX.boolValue) == true },
                                      set: { name in try? AX.set(element, name, kCFBooleanTrue) },
                                      pageReady: {
                                          guard let win = AX.element(element, kAXFocusedWindowAttribute) ?? AX.elements(element, kAXWindowsAttribute).first else { return false }
                                          return hasWebArea(win, depth: 0)
                                      },
                                      pause: { usleep(useconds_t($0) * 1000) })
        if set.contains("AXEnhancedUserInterface") {
            lock.lock(); enhancedByUs[app.processIdentifier] = key; lock.unlock()
            CULog.bind.notice("\(app.localizedName ?? "a Chromium browser", privacy: .public): no page after AXManualAccessibility — AXEnhancedUserInterface set (turned off again when its last target is released)")
        }
    }

    /// The last target in `pid` was released: the `AXEnhancedUserInterface` Winter turned on there is turned off again —
    /// never one that was on before Winter's (another client's: VoiceOver, a window manager), and never while VoiceOver
    /// runs (it may have asked for it since). The next bind turns it on again. Returns whether it was turned off.
    @discardableResult
    static func releaseEnhanced(pid: pid_t, voiceOverOn: Bool = NSWorkspace.shared.isVoiceOverEnabled,
                                set: (Bool) -> Void = { _ in }) -> Bool {
        lock.lock()
        guard let key = enhancedByUs.removeValue(forKey: pid) else { lock.unlock(); return false }
        enabled.remove(key)   // the next bind switches it on again
        lock.unlock()
        guard !voiceOverOn else { return false }
        set(false)
        return true
    }

    /// The live release: `AXEnhancedUserInterface` false on the app element.
    static func releaseEnhancedLive(pid: pid_t) {
        if releaseEnhanced(pid: pid, set: { on in try? AX.set(AX.app(pid), "AXEnhancedUserInterface", on ? kCFBooleanTrue : kCFBooleanFalse) }) {
            CULog.bind.notice("pid \(pid, privacy: .public): its last target released — AXEnhancedUserInterface turned off again")
        }
    }

    /// Tests: what Winter turned on, as if `enableAccessibilityOnce` had (`pid` → a launch key), and a reset.
    static func noteEnhancedForTesting(pid: pid_t, key: String) { lock.lock(); enhancedByUs[pid] = key; enabled.insert(key); lock.unlock() }
    static func isEnabledForTesting(_ key: String) -> Bool { lock.lock(); defer { lock.unlock() }; return enabled.contains(key) }

    /// The switches set, in order: `AXManualAccessibility` (Electron's and CEF's; Chrome answers it as unsupported),
    /// then — for a Chromium BROWSER whose page did not appear within ~1 s — `AXEnhancedUserInterface`, the one Chrome
    /// builds its web tree on (what VoiceOver sets). The leftover probes (2026-10-13): Chrome for Testing 156, windowed
    /// behind the user's app, answered AXManualAccessibility with kAXErrorAttributeUnsupported and showed no page —
    /// before, in front, behind again — until AXEnhancedUserInterface, after which its page was there within 3 s.
    /// Pure but for its effects: `set`, `pageReady` and `pause` are the world's.
    /// `enhancedAlreadyOn`: another client (VoiceOver, a window manager) has it on — then it is not set (nor later
    /// turned off) by Winter.
    static func enableAccessibility(browser: Bool, enhancedAlreadyOn: () -> Bool = { false }, set: (String) -> Void, pageReady: () -> Bool,
                                    pause: (Int) -> Void) -> [String] {
        var done = ["AXManualAccessibility"]
        set("AXManualAccessibility")
        for _ in 0..<10 {
            pause(100)
            if pageReady() { return done }
        }
        guard browser, !enhancedAlreadyOn() else { return done }
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
