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

    // MARK: AXEnhancedUserInterface — Winter's, and only Winter's, turned off again

    /// One browser process whose `AXEnhancedUserInterface` WINTER turned on, proven off just before: its pid and its
    /// start time (`launchDate`, seconds since 1970) — a pid alone may be reused by another process.
    public struct EnhancedRecord: Codable, Equatable, Sendable {
        public var pid: Int32
        public var start: Double
        public init(pid: Int32, start: Double) { self.pid = pid; self.start = start }
    }

    /// The records of the flags Winter set, by pid. Mirrored to `recordPath` (0600) so a helper that ends without
    /// clearing them (a crash, a kill) lets the next one clear them at its start (`reconcileAtStart`).
    private static var enhancedByUs: [pid_t: EnhancedRecord] = [:]
    /// Where the records are kept: `<home>/run/computer-use-ax-flags.json`, set by the helper shell at its start.
    /// Nil (tests, no home): memory only.
    nonisolated(unsafe) public static var recordPath: String?

    static func launchKey(pid: pid_t, start: Double) -> String { "\(pid):\(start)" }

    /// Switches the app's accessibility tree on once per process launch, then gives the renderer a moment to build it
    /// (polling for any web area). `browser`: a Chromium BROWSER (`isBrowser`) — only then `AXEnhancedUserInterface`.
    /// Runs on the pid queue.
    static func enableAccessibilityOnce(_ app: NSRunningApplication, browser: Bool) {
        let start = app.launchDate?.timeIntervalSince1970 ?? 0
        let key = launchKey(pid: app.processIdentifier, start: start)
        lock.lock()
        if enabled.contains(key) { lock.unlock(); return }
        enabled.insert(key)
        lock.unlock()
        let element = AX.app(app.processIdentifier)
        let r = enableAccessibility(browser: browser,
                                    enhancedBefore: { readEnhanced(element) },
                                    set: { name in try? AX.set(element, name, kCFBooleanTrue) },
                                    pageReady: {
                                        guard let win = AX.element(element, kAXFocusedWindowAttribute) ?? AX.elements(element, kAXWindowsAttribute).first else { return false }
                                        return hasWebArea(win, depth: 0)
                                    },
                                    pause: { usleep(useconds_t($0) * 1000) })
        guard r.set.contains("AXEnhancedUserInterface") else { return }
        if r.ours { noteOurs(EnhancedRecord(pid: app.processIdentifier, start: start)) }
        CULog.bind.notice("\(app.localizedName ?? "a Chromium browser", privacy: .public): no page after AXManualAccessibility — AXEnhancedUserInterface set\(r.ours ? " (Winter's: turned off again when its last target is released)" : " (it could not be read as off first: never turned off by Winter)", privacy: .public)")
    }

    /// The flag as the app answers it: nil when it does not answer (unsupported, no reply) — never taken for "off".
    static func readEnhanced(_ element: AXUIElement) -> Bool? {
        AX.attribute(element, "AXEnhancedUserInterface").flatMap(AX.boolValue)
    }

    /// The switches set, in order, and whether `AXEnhancedUserInterface` is WINTER's to turn off: `AXManualAccessibility`
    /// (Electron's and CEF's; Chrome answers it as unsupported), then — for a Chromium BROWSER whose page did not appear
    /// within ~1 s — `AXEnhancedUserInterface`, the one Chrome builds its web tree on (what VoiceOver sets). The leftover
    /// probes (2026-10-13): Chrome for Testing 156, windowed behind the user's app, answered AXManualAccessibility with
    /// kAXErrorAttributeUnsupported and showed no page — before, in front, behind again — until AXEnhancedUserInterface,
    /// after which its page was there within 3 s; it ANSWERED the read of AXEnhancedUserInterface (false, then true).
    /// `enhancedBefore`: the flag read just before — on (another client's: VoiceOver, a window manager) → not set; off →
    /// set and Winter's; unanswered → set (the page needs it) but never Winter's (it can't be proven it was off).
    /// Pure but for its effects: `set`, `pageReady` and `pause` are the world's.
    static func enableAccessibility(browser: Bool, enhancedBefore: () -> Bool? = { false }, set: (String) -> Void, pageReady: () -> Bool,
                                    pause: (Int) -> Void) -> (set: [String], ours: Bool) {
        var done = ["AXManualAccessibility"]
        set("AXManualAccessibility")
        for _ in 0..<10 {
            pause(100)
            if pageReady() { return (done, false) }
        }
        guard browser else { return (done, false) }
        let before = enhancedBefore()
        guard before != true else { return (done, false) }
        done.append("AXEnhancedUserInterface")
        set("AXEnhancedUserInterface")
        for _ in 0..<20 {
            pause(100)
            if pageReady() { break }
        }
        return (done, before == false)
    }

    /// A Chromium BROWSER — the one test Floor F and the accessibility switch share: a known browser bundle, or a
    /// Chromium-family app that declares http(s) (Brave Beta, Opera GX, Comet…; never an Electron or CEF app). Pure.
    static func isBrowser(bundleId: String?, chromium: Bool, declaresWeb: () -> Bool) -> Bool {
        bundleId.map(bundleIds.contains) == true || (chromium && declaresWeb())
    }

    /// Is any assistive client on that may rely on the flag (VoiceOver, Switch Control, Full Keyboard Access, Voice
    /// Control)? macOS names the first three; Voice Control only as its running process. Then Winter never clears it.
    static func assistiveClientOn() -> Bool {
        let ws = NSWorkspace.shared
        if ws.isVoiceOverEnabled || ws.isSwitchControlEnabled { return true }
        if UserDefaults(suiteName: "com.apple.universalaccess")?.bool(forKey: "FullKeyboardAccessEnabled") == true { return true }
        return ws.runningApplications.contains { ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains("VoiceControl") }
    }

    private static func noteOurs(_ r: EnhancedRecord) {
        lock.lock()
        enhancedByUs[r.pid] = r
        let all = Array(enhancedByUs.values)
        lock.unlock()
        persist(all)
    }

    /// The records to `recordPath`, atomically, 0600 (an empty list removes the file).
    static func persist(_ records: [EnhancedRecord], path: String? = recordPath) {
        guard let path else { return }
        if records.isEmpty { try? FileManager.default.removeItem(atPath: path); return }
        guard let data = try? JSONEncoder().encode(records.sorted { $0.pid < $1.pid }) else { return }
        let tmp = path + ".tmp"
        guard FileManager.default.createFile(atPath: tmp, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        _ = rename(tmp, path)
    }

    static func loadRecords(path: String? = recordPath) -> [EnhancedRecord] {
        guard let path, let data = FileManager.default.contents(atPath: path) else { return [] }
        return (try? JSONDecoder().decode([EnhancedRecord].self, from: data)) ?? []
    }

    /// Whether Winter may turn a flag it set off NOW: no assistive client is on, and the app ANSWERS that the flag is on
    /// (unanswered or off: left as it is — an answer that can't be read is never trusted). Pure.
    static func mayClear(assistiveOn: Bool, readNow: Bool?) -> Bool { !assistiveOn && readNow == true }

    /// The last target in `pid` was released: the flag Winter set there is turned off — re-read just before, never while
    /// an assistive client is on (`mayClear`). Its record goes either way; the next bind turns it on again (as Winter's
    /// only if it reads off then). Returns whether it was turned off.
    @discardableResult
    static func releaseEnhanced(pid: pid_t, assistiveOn: Bool, readNow: () -> Bool?, set: (Bool) -> Void) -> Bool {
        lock.lock()
        guard let r = enhancedByUs.removeValue(forKey: pid) else { lock.unlock(); return false }
        enabled.remove(launchKey(pid: r.pid, start: r.start))
        let all = Array(enhancedByUs.values)
        lock.unlock()
        persist(all)
        guard mayClear(assistiveOn: assistiveOn, readNow: readNow()) else { return false }
        set(false)
        return true
    }

    /// The helper is ending (quit, idle quit, SIGTERM): every flag Winter set, released.
    static func releaseAll(assistiveOn: Bool, readNow: (pid_t) -> Bool?, set: (pid_t, Bool) -> Void) -> [pid_t] {
        lock.lock()
        let pids = Array(enhancedByUs.keys)
        lock.unlock()
        return pids.filter { pid in releaseEnhanced(pid: pid, assistiveOn: assistiveOn, readNow: { readNow(pid) }, set: { set(pid, $0) }) }
    }

    /// At the helper's start: the records a helper that ended without clearing left. A flag is turned off only when
    /// THAT process (pid AND start time) still runs, answers that it is on, and no assistive client is on; every record
    /// is then dropped (a process gone, or one left on: never Winter's to track again). Returns the pids turned off.
    static func reconcile(_ records: [EnhancedRecord], startOf: (pid_t) -> Double?, assistiveOn: Bool, readNow: (pid_t) -> Bool?,
                          set: (pid_t, Bool) -> Void) -> [pid_t] {
        records.compactMap { r in
            guard let start = startOf(r.pid), abs(start - r.start) < 0.001 else { return nil }
            guard mayClear(assistiveOn: assistiveOn, readNow: readNow(r.pid)) else { return nil }
            set(r.pid, false)
            return r.pid
        }
    }

    // The live forms (the shell and the engine call these).

    static func liveSet(_ pid: pid_t, _ on: Bool) { try? AX.set(AX.app(pid), "AXEnhancedUserInterface", on ? kCFBooleanTrue : kCFBooleanFalse) }
    static func liveRead(_ pid: pid_t) -> Bool? { readEnhanced(AX.app(pid)) }

    static func releaseEnhancedLive(pid: pid_t) {
        if releaseEnhanced(pid: pid, assistiveOn: assistiveClientOn(), readNow: { liveRead(pid) }, set: { liveSet(pid, $0) }) {
            CULog.bind.notice("pid \(pid, privacy: .public): its last target released — AXEnhancedUserInterface turned off again")
        }
    }

    /// The helper ends: release every flag Winter set (called from the shell's `applicationWillTerminate`).
    static func releaseAllLive() {
        let off = releaseAll(assistiveOn: assistiveClientOn(), readNow: liveRead, set: liveSet)
        if !off.isEmpty { CULog.bind.notice("helper ending — AXEnhancedUserInterface turned off again in \(off.count, privacy: .public) browser(s)") }
    }

    /// The helper starts: `path` set as the record file, and what an earlier helper left reconciled.
    static func startRecording(at path: String) {
        recordPath = path
        let left = loadRecords(path: path)
        guard !left.isEmpty else { return }
        let off = reconcile(left, startOf: { NSRunningApplication(processIdentifier: $0)?.launchDate?.timeIntervalSince1970 },
                            assistiveOn: assistiveClientOn(), readNow: liveRead, set: liveSet)
        persist([], path: path)
        CULog.bind.notice("helper start: \(left.count, privacy: .public) AXEnhancedUserInterface record(s) left by an earlier helper — \(off.count, privacy: .public) turned off")
    }

    /// Tests: a flag recorded as Winter's, as `enableAccessibilityOnce` records it.
    static func noteEnhancedForTesting(pid: pid_t, start: Double) {
        lock.lock(); enabled.insert(launchKey(pid: pid, start: start)); lock.unlock()
        noteOurs(EnhancedRecord(pid: pid, start: start))
    }
    static func isEnabledForTesting(_ key: String) -> Bool { lock.lock(); defer { lock.unlock() }; return enabled.contains(key) }

    private static func hasWebArea(_ e: AXUIElement, depth: Int) -> Bool {
        if AX.string(e, kAXRoleAttribute) == "AXWebArea" { return true }
        guard depth < 6 else { return false }
        return AX.elements(e, kAXChildrenAttribute).prefix(12).contains { hasWebArea($0, depth: depth + 1) }
    }
}
