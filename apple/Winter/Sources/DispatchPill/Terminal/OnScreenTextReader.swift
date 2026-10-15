import AppKit
import ApplicationServices
import Foundation

// ON-SCREEN PATHS, the reading half: the text of the FOCUSED window of the app the user is in — the pill is a
// non-activating panel, so the frontmost app stays theirs; Winter's own windows are never read — through
// accessibility, in-process, only when Winter is already trusted (`AXIsProcessTrusted()`; it never prompts).
// Off the main thread and bounded: at most `OnScreenReadBudget.maxElements` elements and `maxDuration`, every
// accessibility call under a messaging timeout. Text areas and fields give their value (a big one — a terminal's
// scrollback — only its TAIL), static texts their value and title; a secure field (or anything whose role or
// subrole says secure) is never read, nor anything inside it.
//
// PRIVACY: the text is turned into paths at once and dropped — never stored, logged or sent to the daemon or a
// session. The paths live only in memory, only while the pill is up (`OnScreenPathStore.deactivate`).

/// How much one read may cost.
struct OnScreenReadBudget: Equatable {
    var maxElements = 2000
    var maxDuration: TimeInterval = 0.15
    /// A text area's tail, in characters.
    var tailCharacters = 65_536
    /// The whole read's text, in characters (the most recent kept).
    var maxTotalCharacters = 262_144
    /// Every accessibility call's timeout.
    var messagingTimeout: Float = 0.1

    static let standard = OnScreenReadBudget()
}

/// One accessibility element, as the reader asks it (the live one wraps `AXUIElement`; tests hand in a tree).
protocol OnScreenAXElement {
    /// Role, subrole and children — one round trip.
    func basics() -> (role: String?, subrole: String?, children: [OnScreenAXElement])
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
    static let textRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"]
    static let staticTextRole = "AXStaticText"

    /// PURE (given its source): the window's text, depth-first in reading order (later = more recent), within the
    /// budget — or nil when there is no window.
    static func read(from source: OnScreenAXSource, budget: OnScreenReadBudget = .standard,
                     now: () -> Date = Date.init) -> String? {
        let deadline = now().addingTimeInterval(budget.maxDuration)
        guard let window = source.focusedWindow() else { return nil }
        var pieces: [String] = []
        var total = 0
        var stack: [OnScreenAXElement] = [window]
        var visited = 0
        while let element = stack.popLast(), visited < budget.maxElements, now() < deadline {
            visited += 1
            let basics = element.basics()
            if isSecure(role: basics.role, subrole: basics.subrole) { continue } // never read, nor what it holds
            if let role = basics.role {
                var text: String?
                if role == "AXTextArea" {
                    text = tail(of: element, characters: budget.tailCharacters)
                } else if textRoles.contains(role) {
                    text = element.value()
                } else if role == staticTextRole {
                    text = [element.value(), element.title()].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
                }
                if let text, !text.isEmpty {
                    let kept = text.count > budget.tailCharacters ? String(text.suffix(budget.tailCharacters)) : text
                    pieces.append(kept)
                    total += kept.count + 1
                    // Over the total: the oldest pieces go.
                    while total > budget.maxTotalCharacters, pieces.count > 1 { total -= pieces.removeFirst().count + 1 }
                }
            }
            // Children in reverse onto the stack, so the first child is read next (reading order).
            stack.append(contentsOf: basics.children.reversed())
        }
        return pieces.joined(separator: "\n")
    }

    /// A secure field, by role or subrole (`AXSecureTextField`, or anything else that says secure).
    static func isSecure(role: String?, subrole: String?) -> Bool {
        [role, subrole].contains { $0?.localizedCaseInsensitiveContains("secure") == true }
    }

    /// A text area's last `characters` — asked for as a range when the element can say how long it is, so a huge
    /// scrollback is never copied whole.
    private static func tail(of element: OnScreenAXElement, characters: Int) -> String? {
        if let count = element.characterCount(), count > characters,
           let tail = element.string(in: NSRange(location: count - characters, length: characters)) {
            return tail
        }
        guard let value = element.value() else { return nil }
        return value.count > characters ? String(value.suffix(characters)) : value
    }
}

// MARK: - The live accessibility tree

/// An `AXUIElement`, every call under the budget's messaging timeout.
struct LiveAXElement: OnScreenAXElement {
    let element: AXUIElement
    let timeout: Float

    init(_ element: AXUIElement, timeout: Float) {
        self.element = element
        self.timeout = timeout
        AXUIElementSetMessagingTimeout(element, timeout)
    }

    func basics() -> (role: String?, subrole: String?, children: [OnScreenAXElement]) {
        let attributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXChildrenAttribute] as CFArray
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, attributes, AXCopyMultipleAttributeOptions(), &values) == .success,
              let list = values as? [AnyObject], list.count == 3 else { return (nil, nil, []) }
        let children = (list[2] as? [AXUIElement] ?? []).map { LiveAXElement($0, timeout: timeout) as OnScreenAXElement }
        return (list[0] as? String, list[1] as? String, children)
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

/// The focused window of the app with `pid`.
struct LiveAXSource: OnScreenAXSource {
    let pid: pid_t
    let timeout: Float

    /// Chromium/Electron apps build their accessibility tree only when asked (`AXManualAccessibility`) — asked once
    /// per process, never `AXEnhancedUserInterface` (which disturbs some apps' windows).
    private static let askedLock = NSLock()
    nonisolated(unsafe) private static var asked: Set<pid_t> = []

    func focusedWindow() -> OnScreenAXElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, timeout)
        Self.askedLock.lock()
        let first = Self.asked.insert(pid).inserted
        Self.askedLock.unlock()
        if first { AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) }
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
    private let frontmostProcess: () -> pid_t?
    /// Reads `pid`'s focused window and turns it into existing paths — called OFF the main thread.
    private let read: @Sendable (pid_t) -> [String]
    private let now: () -> Date
    private var active = false
    private var generation = 0
    private var lastStarted = Date.distantPast
    private var inFlightSince: Date?

    init(frontmostProcess: @escaping () -> pid_t?, read: @escaping @Sendable (pid_t) -> [String],
         now: @escaping () -> Date = Date.init) {
        self.frontmostProcess = frontmostProcess
        self.read = read
        self.now = now
    }

    /// Reads nothing (tests, and every pill built under unit tests).
    static var inert: OnScreenPathStore { OnScreenPathStore(frontmostProcess: { nil }, read: { _ in [] }) }

    /// The user's screen: the frontmost app (never Winter itself), through accessibility when already trusted.
    static func live(home: String = NSHomeDirectory()) -> OnScreenPathStore {
        OnScreenPathStore(
            frontmostProcess: {
                guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
                return app.processIdentifier
            },
            read: { pid in
                guard AXIsProcessTrusted() else { return [] } // never prompts
                let budget = OnScreenReadBudget.standard
                guard let text = OnScreenTextReader.read(from: LiveAXSource(pid: pid, timeout: budget.messagingTimeout),
                                                         budget: budget) else { return [] }
                return onScreenPathsThatExist(onScreenPathCandidates(in: text, home: home), home: home,
                                              fileSystem: LiveShellFileSystem())
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
