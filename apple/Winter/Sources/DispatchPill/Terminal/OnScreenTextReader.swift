import AppKit
import ApplicationServices
import Foundation

// ON-SCREEN PATHS, the reading half: the text of the FOCUSED window of the app the user is in — the pill is a
// non-activating panel, so the frontmost app stays theirs; Winter's own windows are never read — through
// accessibility, in-process, only when Winter is already trusted (`AXIsProcessTrusted()`; it never prompts).
// It reads ONLY what the app already exposes: it never sets `AXManualAccessibility` or `AXEnhancedUserInterface`
// on any app, and a Chromium-family app (Electron, CEF, the Chromium browsers — `onScreenAppIsChromiumFamily`),
// whose tree is empty until something sets those, gets no paths at all.
// Off the main thread and bounded: at most `OnScreenReadBudget.maxElements` elements, `maxChildren` children of
// any one element and `maxDuration` (checked before every read), every accessibility call under a messaging
// timeout. Text comes length-first (`AXNumberOfCharacters`): a long text is asked for as a range — its TAIL —
// never copied whole, and one past `maxElementCharacters` is skipped; static texts also give their title. A
// secure field (or anything whose role or subrole says secure) is never read, nor anything inside it.
//
// PRIVACY: the text is turned into paths at once and dropped — never stored, logged or sent to the daemon or a
// session. The paths live only in memory, only while the pill is up (`OnScreenPathStore.deactivate`).

/// How much one read may cost.
struct OnScreenReadBudget: Equatable {
    var maxElements = 2000
    var maxDuration: TimeInterval = 0.15
    /// The children read of any one element (the first ones, in order).
    var maxChildren = 200
    /// One element's tail, in characters.
    var tailCharacters = 65_536
    /// An element reporting more characters than this is skipped.
    var maxElementCharacters = 4_000_000
    /// The whole read's text, in characters (the most recent kept).
    var maxTotalCharacters = 262_144
    /// Every accessibility call's timeout.
    var messagingTimeout: Float = 0.1

    static let standard = OnScreenReadBudget()
}

/// One accessibility element, as the reader asks it (the live one wraps `AXUIElement`; tests hand in a tree).
protocol OnScreenAXElement {
    /// Role and subrole — one round trip.
    func roles() -> (role: String?, subrole: String?)
    /// The first `limit` children.
    func children(limit: Int) -> [OnScreenAXElement]
    func value() -> String?
    func title() -> String?
    /// `AXNumberOfCharacters`, when the element reports it.
    func characterCount() -> Int?
    /// `AXStringForRange`.
    func string(in range: NSRange) -> String?
}

/// Where the reader starts: the focused window of the app being read.
protocol OnScreenAXSource {
    func focusedWindow() -> OnScreenAXElement?
}

enum OnScreenTextReader {
    static let textRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField", "AXStaticText"]

    /// PURE (given its source): the window's text, depth-first in reading order (later = more recent), within the
    /// budget — or nil when there is no window.
    static func read(from source: OnScreenAXSource, budget: OnScreenReadBudget = .standard,
                     now: () -> Date = Date.init) -> String? {
        let deadline = now().addingTimeInterval(budget.maxDuration)
        func inTime() -> Bool { now() < deadline }
        guard let window = source.focusedWindow() else { return nil }
        var pieces: [String] = []
        var total = 0
        var stack: [OnScreenAXElement] = [window]
        var visited = 0
        while let element = stack.popLast(), visited < budget.maxElements, inTime() {
            visited += 1
            let roles = element.roles()
            if isSecure(role: roles.role, subrole: roles.subrole) { continue } // never read, nor what it holds
            if let role = roles.role, textRoles.contains(role), inTime() {
                var parts: [String] = []
                if let text = boundedText(of: element, budget: budget) { parts.append(text) }
                if role == "AXStaticText", inTime(), let title = element.title(), !title.isEmpty {
                    parts.append(String(title.suffix(budget.tailCharacters)))
                }
                let text = parts.joined(separator: " ")
                if !text.isEmpty {
                    pieces.append(text)
                    total += text.count + 1
                    // Over the total: the oldest pieces go.
                    while total > budget.maxTotalCharacters, pieces.count > 1 { total -= pieces.removeFirst().count + 1 }
                }
            }
            guard inTime() else { break }
            // Children in reverse onto the stack, so the first child is read next (reading order).
            stack.append(contentsOf: element.children(limit: budget.maxChildren).reversed())
        }
        return pieces.joined(separator: "\n")
    }

    /// A secure field, by role or subrole (`AXSecureTextField`, or anything else that says secure).
    static func isSecure(role: String?, subrole: String?) -> Bool {
        [role, subrole].contains { $0?.localizedCaseInsensitiveContains("secure") == true }
    }

    /// An element's text, length first: past `maxElementCharacters` nothing; past `tailCharacters` only the tail,
    /// asked for as a range (never the whole value — if the range cannot be had, nothing); else the value. An
    /// element that cannot say its length gives its value, cut to the tail.
    private static func boundedText(of element: OnScreenAXElement, budget: OnScreenReadBudget) -> String? {
        if let count = element.characterCount() {
            guard count > 0, count <= budget.maxElementCharacters else { return nil }
            if count > budget.tailCharacters {
                return element.string(in: NSRange(location: count - budget.tailCharacters, length: budget.tailCharacters))
            }
        }
        guard let value = element.value() else { return nil }
        return value.count > budget.tailCharacters ? String(value.suffix(budget.tailCharacters)) : value
    }
}

// MARK: - Chromium-family apps: no paths

/// The Chromium family, as the computer-use helper classifies it (`CUChromium` in WinterCUCore, mirrored here —
/// the app does not link that package): Chromium browsers by bundle id, and apps that ship Electron or CEF.
let onScreenChromiumBundleIds: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
    "com.google.chrome.for.testing",
    "org.chromium.Chromium", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev",
    "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser",
    "company.thebrowser.dia", "com.openai.atlas",
]
let onScreenChromiumFrameworks: Set<String> = ["Electron Framework.framework", "Chromium Embedded Framework.framework"]

/// PURE: is an app of the Chromium family?
func onScreenAppIsChromiumFamily(bundleId: String?, frameworkNames: [String]) -> Bool {
    if let bundleId, onScreenChromiumBundleIds.contains(bundleId) { return true }
    return frameworkNames.contains { onScreenChromiumFrameworks.contains($0) }
}

/// The same, for a running app: its bundle's `Contents/Frameworks` looked at once per bundle.
@MainActor
enum OnScreenChromiumDetector {
    private static var cache: [String: Bool] = [:]

    static func isChromiumFamily(_ app: NSRunningApplication) -> Bool {
        let key = app.bundleURL?.path ?? "pid:\(app.processIdentifier)"
        if let known = cache[key] { return known }
        var frameworks: [String] = []
        if let url = app.bundleURL {
            frameworks = (try? FileManager.default.contentsOfDirectory(atPath: url.appendingPathComponent("Contents/Frameworks").path)) ?? []
        }
        let result = onScreenAppIsChromiumFamily(bundleId: app.bundleIdentifier, frameworkNames: frameworks)
        cache[key] = result
        return result
    }
}

// MARK: - The live accessibility tree

/// An `AXUIElement`, every call under the budget's messaging timeout. It only READS.
struct LiveAXElement: OnScreenAXElement {
    let element: AXUIElement
    let timeout: Float

    init(_ element: AXUIElement, timeout: Float) {
        self.element = element
        self.timeout = timeout
        AXUIElementSetMessagingTimeout(element, timeout)
    }

    func roles() -> (role: String?, subrole: String?) {
        let attributes = [kAXRoleAttribute, kAXSubroleAttribute] as CFArray
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, attributes, AXCopyMultipleAttributeOptions(), &values) == .success,
              let list = values as? [AnyObject], list.count == 2 else { return (nil, nil) }
        return (list[0] as? String, list[1] as? String)
    }

    func children(limit: Int) -> [OnScreenAXElement] {
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, limit, &values) == .success,
              let list = values as? [AXUIElement] else { return [] }
        return list.map { LiveAXElement($0, timeout: timeout) }
    }

    func value() -> String? { string(kAXValueAttribute) }
    func title() -> String? { string(kAXTitleAttribute) }

    func characterCount() -> Int? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute as CFString, &value) == .success else { return nil }
        return (value as? NSNumber)?.intValue
    }

    func string(in range: NSRange) -> String? {
        var cfRange = CFRange(location: range.location, length: range.length)
        guard let parameter = AXValueCreate(.cfRange, &cfRange) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString,
                                                         parameter, &value) == .success else { return nil }
        return value as? String
    }

    private func string(_ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }
}

/// The focused window of the app with `pid` — read only, nothing set on the app.
struct LiveAXSource: OnScreenAXSource {
    let pid: pid_t
    let timeout: Float

    func focusedWindow() -> OnScreenAXElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, timeout)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window, CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
        return LiveAXElement(unsafeDowncast(window, to: AXUIElement.self), timeout: timeout)
    }
}

// MARK: - The store the pill reads

/// The on-screen paths while the pill is up: read when the pill is summoned and when command mode turns on
/// (at most once a second), and on demand when the argument ghost is computed and they are older than
/// `staleAfter`. Dropped when the pill goes (`deactivate`) — a read still in flight then is discarded.
@MainActor
final class OnScreenPathStore {
    /// Most recent first.
    private(set) var paths: [String] = []
    private(set) var capturedAt: Date?
    /// The paths changed (a read landed with different ones).
    var onChange: (() -> Void)?

    static let minimumInterval: TimeInterval = 1
    static let staleAfter: TimeInterval = 2
    /// A read still out after this long is given up (its result, if it ever comes, is dropped).
    static let abandonAfter: TimeInterval = 1

    /// The app to read: the frontmost one's pid, nil when there is none.
    private let frontmostProcess: @MainActor () -> pid_t?
    /// Reads `pid`'s focused window and turns it into existing paths — called OFF the main thread.
    private let read: @Sendable (pid_t) -> [String]
    private let now: () -> Date
    private var active = false
    private var generation = 0
    private var lastStarted = Date.distantPast
    private var inFlightSince: Date?

    init(frontmostProcess: @escaping @MainActor () -> pid_t?, read: @escaping @Sendable (pid_t) -> [String],
         now: @escaping () -> Date = Date.init) {
        self.frontmostProcess = frontmostProcess
        self.read = read
        self.now = now
    }

    /// Reads nothing (tests, and every pill built under unit tests).
    static var inert: OnScreenPathStore { OnScreenPathStore(frontmostProcess: { nil }, read: { _ in [] }) }

    /// The user's screen: the frontmost app (never Winter itself, never a Chromium-family app), through accessibility
    /// when already trusted.
    static func live(home: String = NSHomeDirectory()) -> OnScreenPathStore {
        let fileSystem = VolumeGuardedFileSystem(inner: LiveShellFileSystem())
        return OnScreenPathStore(
            frontmostProcess: {
                // A Chromium-family app exposes nothing unless asked to, and Winter never asks: no paths.
                guard let app = NSWorkspace.shared.frontmostApplication,
                      !OnScreenChromiumDetector.isChromiumFamily(app) else { return nil }
                return app.processIdentifier
            },
            read: { [fileSystem] pid in
                guard AXIsProcessTrusted() else { return [] } // never prompts
                let budget = OnScreenReadBudget.standard
                guard let text = OnScreenTextReader.read(from: LiveAXSource(pid: pid, timeout: budget.messagingTimeout),
                                                         budget: budget) else { return [] }
                return onScreenPathsThatExist(onScreenPathCandidates(in: text, home: home), home: home,
                                              fileSystem: fileSystem)
            })
    }

    /// The pill is up: read now.
    func activate() {
        active = true
        refresh()
    }

    /// The pill went: everything read is dropped, and a read in flight is discarded when it lands.
    func deactivate() {
        active = false
        generation += 1
        inFlightSince = nil
        paths = []
        capturedAt = nil
    }

    /// Read again — at most once every `minimumInterval`, one read at a time.
    func refresh() {
        guard active else { return }
        let started = now()
        guard started.timeIntervalSince(lastStarted) >= Self.minimumInterval else { return }
        if let inFlightSince {
            guard started.timeIntervalSince(inFlightSince) >= Self.abandonAfter else { return }
            generation += 1 // given up: whatever it brings back is dropped
            self.inFlightSince = nil
        }
        guard let pid = frontmostProcess(), pid != getpid() else {
            // Winter's own window (or none) is in front: nothing on screen to offer.
            set([])
            return
        }
        lastStarted = started
        inFlightSince = started
        let generation = generation
        let read = read
        DispatchQueue.global(qos: .userInitiated).async {
            let found = read(pid)
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.active, self.generation == generation else { return }
                    self.inFlightSince = nil
                    self.set(found)
                }
            }
        }
    }

    /// The ghost is about to use the paths: read again first when they are older than `staleAfter`.
    func refreshIfStale() {
        guard active else { return }
        if let capturedAt, now().timeIntervalSince(capturedAt) <= Self.staleAfter { return }
        refresh()
    }

    private func set(_ found: [String]) {
        capturedAt = now()
        guard found != paths else { return }
        paths = found
        onChange?()
    }
}
