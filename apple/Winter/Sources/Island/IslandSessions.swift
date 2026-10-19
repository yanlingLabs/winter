import AppKit
import Combine
import SwiftUI
import WinterKit

// The Winter island's Sessions tab (`docs/claude/island.md`): background and active sessions of every mode, each with
// its live state (waiting for you / working / idle / finished) and where it is (a Winter window, a detached window, a
// terminal, a phone). A click moves the user's view to WHERE THE SESSION IS: its Winter window (brought front, the
// session selected), its exact terminal window or tab (`TerminalRaiser`), or — when it is nowhere — a detached window
// opened on it. Dispatch children still RUNNING stay above the Dispatch pill and are not listed; finished or idle ones
// are.
//
// Data: the app's session directory (`session.list`, kept live by the pushed lifecycle events), the island's own
// pending cards (waiting for you), `island.hosts` (who is attached, a terminal's tty included), the Dispatch pill's
// children, and the app's own windows. Pure parts in `IslandSessionsBuilder` (`IslandSessionsTests`).

enum IslandSessionLiveState: Int, Equatable, Comparable {
    case waiting = 0, working, idle, finished

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    var label: String {
        switch self {
        case .waiting: return "Waiting for you"
        case .working: return "Working"
        case .idle: return "Idle"
        case .finished: return "Finished"
        }
    }
}

/// Where a session is.
enum IslandSessionHostKind: Equatable {
    case winterWindow
    case detachedWindow
    /// A terminal (the CLI/TUI), by its tty.
    case terminal(tty: String)
    /// The Dispatch session: the Dispatch pill holds it.
    case dispatchPill
    case phone
    case nowhere

    var label: String {
        switch self {
        case .winterWindow: return "Winter window"
        case .detachedWindow: return "Detached window"
        case .terminal(let tty): return "Terminal · \(TerminalWindowMatcher.deviceName(tty))"
        case .dispatchPill: return "Dispatch pill"
        case .phone: return "Phone"
        case .nowhere: return "Not open"
        }
    }
}

struct IslandSessionRow: Identifiable, Equatable {
    let sessionId: String
    let title: String
    /// The mode as the row says it ("Code", "Chat", "Dispatch", "Dispatch task").
    let mode: String
    let state: IslandSessionLiveState
    let host: IslandSessionHostKind
    /// What the row reveals under the pointer: its model (the session's pinned tag), the provider that served it, the
    /// working folder's last component and when it was created (epoch seconds or ms, as the directory has it).
    var model: String? = nil
    var providerId: String? = nil
    var folder: String? = nil
    var createdAt: Int = 0
    /// What it waits for you on (its oldest card) and since when — nil when it waits on nothing the island holds.
    var wait: IslandSessionWait? = nil
    /// A Dispatch child that ended with an error (its state is `finished`).
    var failed = false
    var id: String { sessionId }
}

/// What a session waits for you on: its oldest card's kind, and when that card was issued.
struct IslandSessionWait: Equatable {
    let kind: IslandCard.Kind
    var since: Date? = nil
}

/// A line under a row's title that is worth scanning at rest — what a session needs from you, or its error.
struct IslandRowNote: Equatable {
    let text: String
    let color: Color
}

/// A session's model family — the colour its status line wears (`UsagePlanColor`: Codex green for OpenAI's models,
/// Claude Code clay for Anthropic's, Antigravity blue for Google's; Winter's own accent for any other).
enum IslandModelFamily: Equatable {
    case openai, anthropic, google, other

    /// PURE: from the session's model tag ("anthropic/claude-sonnet-4.5", "gpt-5-codex") and the provider that served it
    /// ("anthropic", "codex-oauth", "openai", "google"…); the model's own words win, an unknown one is `other`.
    static func of(model: String?, provider: String?) -> IslandModelFamily {
        for raw in [model, provider] {
            guard let s = raw?.lowercased(), !s.isEmpty else { continue }
            if s.contains("claude") || s.contains("anthropic") || s.contains("opus") || s.contains("sonnet") || s.contains("haiku") {
                return .anthropic
            }
            if s.contains("gpt") || s.contains("openai") || s.contains("codex") || s.hasPrefix("o3") || s.hasPrefix("o4")
                || s.contains("/o3") || s.contains("/o4") {
                return .openai
            }
            if s.contains("gemini") || s.contains("google") || s.contains("antigravity") { return .google }
        }
        return .other
    }

    var color: Color {
        switch self {
        case .openai: return UsagePlanColor.codex
        case .anthropic: return UsagePlanColor.claudeCode
        case .google: return UsagePlanColor.antigravity
        case .other: return Theme.accent
        }
    }
}

/// What the app's own windows show.
struct IslandWindowFacts: Equatable {
    /// The session the app window shows (nil: none, or the window is closed).
    var appWindowSessionId: String?
    /// The sessions the detached windows show.
    var detachedSessionIds: Set<String> = []
}

/// Where a click on a row takes the user's view.
enum IslandSessionTarget: Equatable {
    case appWindow(sessionId: String)
    case detachedWindow(sessionId: String)
    case terminal(tty: String, sessionId: String)
    /// The Dispatch session: Winter's Dispatch view (the pill already holds it).
    case dispatch(sessionId: String)
    /// Nowhere: open a detached window on it.
    case openDetached(sessionId: String)
}

enum IslandSessionsBuilder {
    /// The most rows shown.
    static let limit = 40

    /// PURE: is this a Dispatch child that is still running (the Dispatch pill shows it, so the tab does not)?
    static func isRunningDispatchChild(_ row: SessionSummary, childStatuses: [String: String]) -> Bool {
        if let status = childStatuses[row.sessionId] { return ChildPillStatus(wireStatus: status).isStoppable }
        let isChild = row.parentSessionId != nil && row.mode != "dispatch"
        return isChild && row.signals?.working == true
    }

    /// PURE: the row's live state.
    static func state(of row: SessionSummary, waiting: Set<String>, childStatuses: [String: String]) -> IslandSessionLiveState {
        if waiting.contains(row.sessionId) || (row.wakesArmed ?? 0) > 0 { return .waiting }
        if row.signals?.working == true { return .working }
        if let status = childStatuses[row.sessionId] {
            switch ChildPillStatus(wireStatus: status) {
            case .done, .failed: return .finished
            case .working: return .working
            case .needsYou: return .waiting
            }
        }
        if row.archived == true || row.activity == "archived" { return .finished }
        return .idle
    }

    /// PURE: where the session is. The app's own windows first (they are certain), then the Dispatch pill for the
    /// Dispatch session, a terminal client with a tty, then a phone.
    static func host(of sessionId: String, hosts: [IslandHost], windows: IslandWindowFacts,
                     isDispatch: Bool = false) -> IslandSessionHostKind {
        if windows.detachedSessionIds.contains(sessionId) { return .detachedWindow }
        if windows.appWindowSessionId == sessionId { return .winterWindow }
        if isDispatch { return .dispatchPill }
        if let tty = terminalTTY(hosts) { return .terminal(tty: tty) }
        if hosts.contains(where: { $0.role == "remote" }) { return .phone }
        return .nowhere
    }

    /// PURE: a terminal client's tty among the hosts (a `cli-` client, never a remote one).
    static func terminalTTY(_ hosts: [IslandHost]) -> String? {
        hosts.first { $0.role != "remote" && $0.clientName.hasPrefix("cli-") && !($0.tty ?? "").isEmpty }?.tty
    }

    /// PURE: what a click on the row does.
    static func target(of sessionId: String, hosts: [IslandHost], windows: IslandWindowFacts,
                       isDispatch: Bool = false) -> IslandSessionTarget {
        if windows.detachedSessionIds.contains(sessionId) { return .detachedWindow(sessionId: sessionId) }
        if windows.appWindowSessionId == sessionId { return .appWindow(sessionId: sessionId) }
        if isDispatch { return .dispatch(sessionId: sessionId) }
        if let tty = terminalTTY(hosts) { return .terminal(tty: tty, sessionId: sessionId) }
        return .openDetached(sessionId: sessionId)
    }

    /// PURE: the mode as the row says it.
    static func modeLabel(_ row: SessionSummary) -> String {
        switch row.mode {
        case "chat": return "Chat"
        case "dispatch": return "Dispatch"
        default: return row.parentSessionId != nil ? "Dispatch task" : "Code"
        }
    }

    /// PURE: the rows — every session not archived that is waiting, working, attached somewhere (a window, a terminal,
    /// a phone), marked active or background by the daemon, or a Dispatch child that finished; never a running
    /// Dispatch child. Waiting first, then working, idle, finished; newest first within each.
    static func rows(directory: [SessionSummary], hosts: [String: [IslandHost]], waiting: Set<String>,
                     childStatuses: [String: String], windows: IslandWindowFacts,
                     waits: [String: IslandSessionWait] = [:]) -> [IslandSessionRow] {
        var out: [(IslandSessionRow, Int)] = []
        for row in directory {
            if row.archived == true || row.activity == "archived" { continue }
            if isRunningDispatchChild(row, childStatuses: childStatuses) { continue }
            let state = state(of: row, waiting: waiting, childStatuses: childStatuses)
            let host = host(of: row.sessionId, hosts: hosts[row.sessionId] ?? [], windows: windows, isDispatch: row.mode == "dispatch")
            let live = state != .idle || host != .nowhere || row.activity == "active" || row.activity == "background"
                || childStatuses[row.sessionId] != nil
            guard live else { continue }
            let title = row.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Untitled \(modeLabel(row).lowercased())"
            let failed = childStatuses[row.sessionId].map { ChildPillStatus(wireStatus: $0) == .failed } ?? false
            out.append((IslandSessionRow(sessionId: row.sessionId, title: title, mode: modeLabel(row), state: state, host: host,
                                         model: row.model, providerId: row.providerId, folder: folderName(row.cwd),
                                         createdAt: row.createdAt, wait: state == .waiting ? waits[row.sessionId] : nil,
                                         failed: state == .finished && failed),
                        row.createdAt))
        }
        out.sort { a, b in a.0.state != b.0.state ? a.0.state < b.0.state : a.1 > b.1 }
        return Array(out.prefix(limit).map(\.0))
    }

    /// PURE: a working folder as the row names it — its last component ("winter"); nil without one.
    static func folderName(_ cwd: String?) -> String? {
        guard let cwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cwd.isEmpty else { return nil }
        let last = URL(fileURLWithPath: cwd).lastPathComponent
        return last.isEmpty || last == "/" ? nil : last
    }

    /// PURE: what each session waits for you on — the kind of its OLDEST card (by the session an answer goes to) and
    /// when that card was issued.
    static func waits(_ cards: [IslandCard]) -> [String: IslandSessionWait] {
        var oldest: [String: (card: IslandCard, at: Int)] = [:]
        for card in cards {
            let at = card.issuedAt ?? Int.max
            if let held = oldest[card.answerSessionId], held.at <= at { continue }
            oldest[card.answerSessionId] = (card, at)
        }
        return oldest.mapValues { held in
            IslandSessionWait(kind: held.card.kind,
                              since: held.card.issuedAt.map { Date(timeIntervalSince1970: Double($0) / 1000) })
        }
    }

    /// PURE: the row's mark — a dot in its model family's colour while it works, amber while it waits for you, the same
    /// family colour hollow while idle; a quiet check once finished, a red dot when it ended with an error.
    static func mark(_ row: IslandSessionRow) -> IslandStatusMark {
        let family = IslandModelFamily.of(model: row.model, provider: row.providerId).color
        switch row.state {
        case .waiting: return .dot(pillReviewAmber)
        case .working: return .dot(family)
        case .idle: return .ring(family)
        case .finished: return row.failed ? .dot(Color(nsColor: .systemRed)) : .glyph("checkmark", Color.white.opacity(0.55))
        }
    }

    /// PURE: what trails the title, muted — its mode and where it is ("Code · Winter window").
    static func whereWords(_ row: IslandSessionRow) -> String { "\(row.mode) · \(row.host.label)" }

    /// PURE: the line under the title at rest, only when it is worth scanning — what the session needs from you and for
    /// how long ("Needs your approval · 2 min"), or that it ended with an error. Nil: the row is one line.
    static func note(_ row: IslandSessionRow, now: Date) -> IslandRowNote? {
        if row.failed { return IslandRowNote(text: "Ended with an error", color: Color(nsColor: .systemRed)) }
        guard row.state == .waiting else { return nil }
        var words = waitWords(row.wait?.kind)
        if let since = row.wait?.since { words += " · " + waitedFor(since, now: now) }
        return IslandRowNote(text: words, color: pillReviewAmber)
    }

    /// PURE: what a card asks of you, as a session's note (no card the island holds: the state's own words).
    static func waitWords(_ kind: IslandCard.Kind?) -> String {
        switch kind {
        case .approval?: return "Needs your approval"
        case .question?: return "Has a question for you"
        case .elicitation?: return "Needs you to open a link"
        case .viewRequest?: return "Asks to switch desktops"
        case nil: return IslandSessionLiveState.waiting.label
        }
    }

    /// PURE: how long it has waited — "just now", "2 min", "1 h 5 min".
    static func waitedFor(_ since: Date, now: Date) -> String {
        let ms = Int(now.timeIntervalSince(since) * 1000)
        return ms < 60_000 ? "just now" : IslandWatchesPresentation.span(ms)
    }

    /// PURE: what the pointer reveals under the title — its model, how long ago it began and its folder ("gpt-5-codex ·
    /// 3 h ago · winter"); the state's own words when it knows none of them.
    static func details(_ row: IslandSessionRow, now: Date) -> String {
        var parts: [String] = []
        if let model = row.model?.trimmingCharacters(in: .whitespacesAndNewlines), !model.isEmpty {
            parts.append(UsagePresentation.modelName(model))
        }
        if row.createdAt > 0 { parts.append(islandRelativePast(IslandDevicesPresentation.date(row.createdAt), now: now)) }
        if let folder = row.folder { parts.append(folder) }
        return parts.isEmpty ? row.state.label : parts.joined(separator: " · ")
    }

    /// PURE: the strip's working count — sessions the daemon last said are working (not archived).
    static func workingCount(_ directory: [SessionSummary]) -> Int {
        directory.filter { $0.signals?.working == true && $0.archived != true }.count
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// The Sessions tab's state. Main-actor; every input is a seam (`IslandSessionsTests`).
@MainActor
final class IslandSessionsModel: ObservableObject {
    @Published private(set) var rows: [IslandSessionRow] = []
    @Published private(set) var hosts: [String: [IslandHost]] = [:]

    var directory: () -> [SessionSummary] = { [] }
    /// Re-lists the directory (`session.list`): `signals.working` has no push of its own.
    var refreshDirectory: () async -> Void = {}
    var fetchHosts: () async throws -> [String: [IslandHost]] = { [:] }
    var waiting: () -> Set<String> = { [] }
    /// What each waiting session waits on and since when (`IslandSessionsBuilder.waits` over the island's cards).
    var waits: () -> [String: IslandSessionWait] = { [:] }
    var childStatuses: () -> [String: String] = { [:] }
    var windows: () -> IslandWindowFacts = { IslandWindowFacts() }
    /// Moves the user's view (the app's windows, a terminal, a new detached window).
    var perform: (IslandSessionTarget) -> Void = { _ in }

    /// Re-reads everything (on open, on the tab showing, and the island's light refresh while open).
    func refresh() async {
        await refreshDirectory()
        if let fetched = try? await fetchHosts() { hosts = fetched }
        recompute()
    }

    /// Rebuilds the rows from what is known (a directory change, a card change).
    func recompute() {
        let next = IslandSessionsBuilder.rows(directory: directory(), hosts: hosts, waiting: waiting(),
                                              childStatuses: childStatuses(), windows: windows(), waits: waits())
        if next != rows { rows = next }
    }

    /// Test and gallery seam: hosts as `island.hosts` would give them.
    func setHostsForTesting(_ hosts: [String: [IslandHost]]) { self.hosts = hosts }

    /// Moves the user's view for a session opened from elsewhere on the island (a turn-result card's Open) — resolved
    /// exactly like a row's click, with the hosts the caller knows (else the tab's own).
    var reveal: (IslandSessionTarget) -> Void = { _ in }
    func openFromIsland(_ sessionId: String, hosts known: [IslandHost], isDispatch: Bool) {
        let hosts = known.isEmpty ? (self.hosts[sessionId] ?? []) : known
        reveal(IslandSessionsBuilder.target(of: sessionId, hosts: hosts, windows: windows(), isDispatch: isDispatch))
    }

    func open(_ row: IslandSessionRow) {
        perform(IslandSessionsBuilder.target(of: row.sessionId, hosts: hosts[row.sessionId] ?? [], windows: windows(),
                                             isDispatch: row.mode == "Dispatch"))
    }
}

// MARK: - The view

struct IslandSessionsList: View {
    @ObservedObject var model: IslandSessionsModel
    var scrolls = true
    var onOpen: (IslandSessionRow) -> Void

    var body: some View {
        if model.rows.isEmpty {
            IslandEmptyTab(symbol: "rectangle.stack", line: "No sessions running")
        } else {
            IslandTabScroll(scrolls: scrolls) { list }
        }
    }

    private var list: some View {
        VStack(spacing: IslandQuietRow.rowGap) {
            ForEach(model.rows) { row in
                IslandSessionRowView(row: row) { onOpen(row) }
            }
        }
        .padding(.horizontal, IslandQuietRow.inset)
        .padding(.top, 2)
        .padding(.bottom, IslandLayout.listInset)
    }
}

/// A session as a row in the island's language (`docs/claude/island.md`): a status dot in its model's colour (amber
/// while it waits for you, hollow while idle), its title, and its mode and where it is, muted — one line, unless it needs
/// you or ended with an error, which a second line says at rest. Under the pointer the row lifts: the title grows, and
/// its model, age and folder show under it with the ↗. A click goes where the session is.
struct IslandSessionRowView: View {
    let row: IslandSessionRow
    var now = Date()
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HoverLiftReader(id: "session:\(row.sessionId)") { hovered in
                IslandLiftRow(title: row.title, quiet: row.state == .finished, hovered: hovered) {
                    IslandStatusMarkView(mark: IslandSessionsBuilder.mark(row))
                } trailing: {
                    Text(IslandSessionsBuilder.whereWords(row))
                        .font(IslandQuietRow.wordsFont)
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                } below: {
                    if let note = IslandSessionsBuilder.note(row, now: now) {
                        IslandRowWords(text: note.text, color: note.color)
                    }
                    if hovered {
                        // Where a click goes, at the end of what the pointer reveals.
                        IslandRowWords(text: IslandSessionsBuilder.details(row, now: now)) {
                            Image(systemName: "arrow.up.right")
                                .font(Typography.tiny(.bold))
                                .foregroundStyle(Color.white)
                        }
                        .transition(.opacity)
                    }
                }
            }
        }
        .buttonStyle(IslandPressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.title), \(row.mode), \(row.state.label), \(row.host.label). Show it.")
    }
}

/// What one `island.changed` says (its params): the pending set changed (`{}`, phase 1's payload, or `pending: true`),
/// and/or a turn started or ended somewhere (`working: true`). An older daemon only ever sends `{}`.
struct IslandChangeKind: Equatable {
    let pending: Bool
    let working: Bool

    init(pending: Bool, working: Bool) {
        self.pending = pending
        self.working = working
    }

    init(_ params: JSONValue) {
        let working = params["working"]?.boolValue == true
        self.init(pending: !working || params["pending"]?.boolValue == true, working: working)
    }
}

/// Runs an async job at most once at a time: a request while it runs makes ONE more run after it (never a queue).
@MainActor
final class IslandCoalescedRun {
    private let job: () async -> Void
    private var running = false
    private var again = false

    init(_ job: @escaping () async -> Void) { self.job = job }

    func request() {
        guard !running else { again = true; return }
        running = true
        Task { @MainActor in
            repeat {
                again = false
                await job()
            } while again
            running = false
        }
    }
}
