import Foundation
import WinterKit

// The Winter island's computer-use pill (phase 2, `docs/claude/island.md`): while any session drives ComputerV2, a pill
// born from the housing says what is being done NOW — "Clicking “Publish” in Chrome", "Typing in Notes", "Waiting for
// “Status: Published”" — and retreats a moment after the work stops. Pure state with an injected clock
// (`IslandCUPillTests`).
//
//   - WHO: the daemon's `island.activity` lists the sessions using the computer (a turn's first ComputerV2 call to the
//     turn's end). With several, the pill shows the most recently active one and a small count of them all.
//   - WHAT: the newest of (a) the agent cursor's own words for its latest action — the bubble beside Winter's cursor,
//     the helper's `view.cursor` stream (`islandCUActionLine`), so both say the same thing — and (b) the latest
//     script's title, else the apps it opens, else "Using the computer" (`islandCUScriptLine`).
//   - WHEN IT GOES: the last session leaves the list → the pill lingers `linger`, then retreats (ONE wake-up, armed only
//     then). A session coming back within the linger takes the pill back at once.

/// PURE: what the computer-use pill says for one agent-cursor event — the cursor's own caption, or a short line for the
/// act itself, naming the app; nil for an event that says nothing new (a move, a reticle, an idle, a fade).
func islandCUActionLine(kind: String, text: String?, appName: String?) -> String? {
    let text = text?.trimmingCharacters(in: .whitespacesAndNewlines)
    let app = appName?.trimmingCharacters(in: .whitespacesAndNewlines).islandNonEmpty
    func inApp(_ verb: String) -> String { app.map { "\(verb) in \($0)" } ?? verb }
    switch kind {
    case "caption":
        guard let text, !text.isEmpty else { return nil }
        // "Clicking “Publish”" → "Clicking “Publish” in Chrome" — unless the caption already names the app.
        if let app, !text.localizedCaseInsensitiveContains(app) { return "\(text) in \(app)" }
        return text
    case "waitBegin":
        // The cursor's own wait caption (`CursorTimeline`): "Waiting for “Saved”".
        if let text, !text.isEmpty { return "Waiting for “\(text)”" }
        return inApp("Waiting")
    case "type", "paste", "setValue": return inApp("Typing")
    case "key":
        guard let text, !text.isEmpty else { return inApp("Pressing keys") }
        return inApp("Pressing \(islandKeyComboLabel(text))")
    case "press", "click", "doubleClick", "rightClick": return inApp("Clicking")
    case "scroll": return inApp("Scrolling")
    case "drag": return inApp("Dragging")
    case "foreground": return text == "off" ? nil : "Using your mouse"
    default: return nil
    }
}

/// PURE: "cmd+shift+s" → "⌘⇧S"; anything else as it came.
func islandKeyComboLabel(_ combo: String) -> String {
    let symbols: [String: String] = ["cmd": "⌘", "command": "⌘", "shift": "⇧", "alt": "⌥", "option": "⌥", "opt": "⌥",
                                     "ctrl": "⌃", "control": "⌃", "fn": "fn ", "return": "↩", "enter": "↩", "tab": "⇥",
                                     "escape": "⎋", "esc": "⎋", "delete": "⌫", "backspace": "⌫", "space": "Space",
                                     "up": "↑", "down": "↓", "left": "←", "right": "→"]
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard !parts.isEmpty, parts.count <= 5 else { return combo }
    return parts.map { symbols[$0] ?? ($0.count == 1 ? $0.uppercased() : $0) }.joined()
}

/// PURE: the line for a session's latest script, from the daemon: its title, else the apps it opens, else the plain words.
func islandCUScriptLine(_ item: IslandComputerUseItem) -> String {
    if let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
    if !item.apps.isEmpty { return "Using \(item.apps.prefix(2).joined(separator: ", "))" }
    return computerV2FallbackLabel
}

/// The computer-use pill's state across sessions. Pure; the clock is passed in (monotonic seconds).
struct IslandCUState: Equatable {
    /// After the last session stops, the pill stays this long before it retreats.
    static let linger: TimeInterval = 2.5
    /// A plain press right after a caption ("Clicking “Publish”") keeps the caption: it is the same act, better said.
    static let captionHold: TimeInterval = 1.5

    struct Session: Equatable {
        var item: IslandComputerUseItem
        /// Bumped whenever the session does something: the most recent one is shown.
        var recency: Int
        /// The line now, and whether it came from a caption (and when).
        var line: String
        var lineFromCaptionAt: TimeInterval?
        /// Rung 4: the agent uses the REAL mouse now (the cursor's `foreground` on, until off) — the island gets out of
        /// the way, so no click of it can land on Winter's own windows.
        var usingMouse = false
    }

    /// Some session uses the real mouse now.
    var usingRealMouse: Bool { sessions.values.contains { $0.usingMouse } }

    /// The sessions using the computer now, by id.
    private(set) var sessions: [String: Session] = [:]
    /// The session shown when the last one stopped, until `lingerUntil`.
    private(set) var lingering: Session?
    private(set) var lingerUntil: TimeInterval?
    private var counter = 0

    /// The sessions whose agent cursor the pill listens to (the app subscribes to their `view.cursor`).
    var activeSessionIds: Set<String> { Set(sessions.keys) }

    /// When the state next changes by itself (the linger's end), nil when nothing is due.
    var nextDeadline: TimeInterval? { lingerUntil }

    /// The daemon's list (`island.activity`'s `computerUse`).
    mutating func apply(_ items: [IslandComputerUseItem], now: TimeInterval) {
        let byId = Dictionary(items.map { ($0.sessionId, $0) }, uniquingKeysWith: { _, b in b })
        // Gone: the session's turn ended.
        let leaving = sessions.keys.filter { byId[$0] == nil }
        // A session that leaves holds the real mouse no more (its turn ended, and with it rung 4).
        var mostRecentLeaving = leaving.compactMap { sessions[$0] }.max { $0.recency < $1.recency }
        mostRecentLeaving?.usingMouse = false
        for id in leaving { sessions[id] = nil }
        for item in items {
            if var s = sessions[item.sessionId] {
                // A new script (a later event while running, or another title/apps): its words are the news.
                let newScript = item.running && (item.lastAt > s.item.lastAt && !s.item.running
                                                  || item.title != s.item.title || item.apps != s.item.apps)
                s.item = item
                if newScript {
                    s.line = islandCUScriptLine(item)
                    s.lineFromCaptionAt = nil
                    s.recency = bump()
                }
                sessions[item.sessionId] = s
            } else if let back = lingering, back.item.sessionId == item.sessionId {
                // Back within the linger: it keeps its words until it says something new.
                var s = back
                s.item = item
                s.recency = bump()
                sessions[item.sessionId] = s
            } else {
                sessions[item.sessionId] = Session(item: item, recency: bump(), line: islandCUScriptLine(item))
            }
        }
        if sessions.isEmpty {
            if let mostRecentLeaving, lingering == nil || lingering?.item.sessionId != mostRecentLeaving.item.sessionId {
                lingering = mostRecentLeaving
                lingerUntil = now + Self.linger
            }
        } else {
            lingering = nil
            lingerUntil = nil
        }
    }

    /// The agent cursor did something in `sessionId` (in the app `appName`).
    mutating func cursor(sessionId: String, kind: String, text: String?, appName: String?, now: TimeInterval) {
        guard var s = sessions[sessionId] else { return }
        if kind == "foreground" {
            s.usingMouse = text != "off"
            sessions[sessionId] = s
        }
        if kind == "waitEnd" {
            // The wait is over: back to the script's own words until the next act.
            if s.line.hasPrefix("Waiting") { s.line = islandCUScriptLine(s.item); s.lineFromCaptionAt = nil }
            sessions[sessionId] = s
            return
        }
        guard let line = islandCUActionLine(kind: kind, text: text, appName: appName) else { return }
        let isPress = ["press", "click", "doubleClick", "rightClick"].contains(kind)
        if isPress, let at = s.lineFromCaptionAt, now - at < Self.captionHold {
            s.recency = bump()
            sessions[sessionId] = s
            return
        }
        s.line = line
        s.lineFromCaptionAt = kind == "caption" ? now : nil
        s.recency = bump()
        sessions[sessionId] = s
    }

    /// The helper's connection was lost: no rung 4 is running through it any more.
    mutating func helperConnectionLost() {
        for id in sessions.keys { sessions[id]?.usingMouse = false }
        lingering?.usingMouse = false
    }

    /// The clock: the linger ends.
    mutating func tick(now: TimeInterval) {
        guard let until = lingerUntil, now >= until else { return }
        lingering = nil
        lingerUntil = nil
    }

    /// What the pill shows, leaving out the sessions whose host is in front (`hidden`): the most recent session's line
    /// and how many are working (nil: no pill). A lingering one shows only while nothing is active.
    func presentation(hidden: Set<String> = []) -> IslandCUPresentation? {
        let visible = sessions.values.filter { !hidden.contains($0.item.sessionId) }
        if let top = visible.max(by: { $0.recency < $1.recency }) {
            return IslandCUPresentation(sessionId: top.item.sessionId, line: top.line, count: visible.count,
                                        title: top.item.session.title, lingering: false)
        }
        guard sessions.isEmpty, let l = lingering, !hidden.contains(l.item.sessionId) else { return nil }
        return IslandCUPresentation(sessionId: l.item.sessionId, line: l.line, count: 1, title: l.item.session.title, lingering: true)
    }

    private mutating func bump() -> Int {
        counter += 1
        return counter
    }
}

/// What the computer-use pill draws.
struct IslandCUPresentation: Equatable {
    let sessionId: String
    let line: String
    /// Sessions using the computer (the small count shows from 2).
    let count: Int
    /// The session's title (the mirror's header).
    let title: String?
    /// The work stopped: the pill is on its way out.
    let lingering: Bool

    var countLabel: String? { count > 1 ? "\(count)" : nil }
    var accessibilityLabel: String {
        count > 1 ? "Computer use, \(count) sessions: \(line). Show the live view."
                  : "Computer use: \(line). Show the live view."
    }
}

extension String {
    fileprivate var islandNonEmpty: String? { isEmpty ? nil : self }
}
