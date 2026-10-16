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

    var symbol: String {
        switch self {
        case .waiting: return "hand.raised.fill"
        case .working: return "bolt.fill"
        case .idle: return "moon.zzz.fill"
        case .finished: return "checkmark.circle.fill"
        }
    }
}

/// Where a session is.
enum IslandSessionHostKind: Equatable {
    case winterWindow
    case detachedWindow
    /// A terminal (the CLI/TUI), by its tty.
    case terminal(tty: String)
    case phone
    case nowhere

    var label: String {
        switch self {
        case .winterWindow: return "Winter window"
        case .detachedWindow: return "Detached window"
        case .terminal(let tty): return "Terminal · \(TerminalWindowMatcher.deviceName(tty))"
        case .phone: return "Phone"
        case .nowhere: return "Not open"
        }
    }

    var symbol: String {
        switch self {
        case .winterWindow: return "macwindow"
        case .detachedWindow: return "macwindow.on.rectangle"
        case .terminal: return "terminal"
        case .phone: return "iphone"
        case .nowhere: return "circle.dashed"
        }
    }
}

struct IslandSessionRow: Identifiable, Equatable {
    let sessionId: String
    let title: String
    let mode: String
    let state: IslandSessionLiveState
    let host: IslandSessionHostKind
    var id: String { sessionId }
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

    /// PURE: where the session is. The app's own windows first (they are certain), then a terminal client with a tty,
    /// then a phone.
    static func host(of sessionId: String, hosts: [IslandHost], windows: IslandWindowFacts) -> IslandSessionHostKind {
        if windows.detachedSessionIds.contains(sessionId) { return .detachedWindow }
        if windows.appWindowSessionId == sessionId { return .winterWindow }
        if let tty = terminalTTY(hosts) { return .terminal(tty: tty) }
        if hosts.contains(where: { $0.role == "remote" }) { return .phone }
        return .nowhere
    }

    /// PURE: a terminal client's tty among the hosts (a `cli-` client, never a remote one).
    static func terminalTTY(_ hosts: [IslandHost]) -> String? {
        hosts.first { $0.role != "remote" && $0.clientName.hasPrefix("cli-") && !($0.tty ?? "").isEmpty }?.tty
    }

    /// PURE: what a click on the row does.
    static func target(of sessionId: String, hosts: [IslandHost], windows: IslandWindowFacts) -> IslandSessionTarget {
        if windows.detachedSessionIds.contains(sessionId) { return .detachedWindow(sessionId: sessionId) }
        if windows.appWindowSessionId == sessionId { return .appWindow(sessionId: sessionId) }
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
                     childStatuses: [String: String], windows: IslandWindowFacts) -> [IslandSessionRow] {
        var out: [(IslandSessionRow, Int)] = []
        for row in directory {
            if row.archived == true || row.activity == "archived" { continue }
            if isRunningDispatchChild(row, childStatuses: childStatuses) { continue }
            let state = state(of: row, waiting: waiting, childStatuses: childStatuses)
            let host = host(of: row.sessionId, hosts: hosts[row.sessionId] ?? [], windows: windows)
            let live = state != .idle || host != .nowhere || row.activity == "active" || row.activity == "background"
                || childStatuses[row.sessionId] != nil
            guard live else { continue }
            let title = row.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Untitled \(modeLabel(row).lowercased())"
            out.append((IslandSessionRow(sessionId: row.sessionId, title: title, mode: modeLabel(row), state: state, host: host),
                        row.createdAt))
        }
        out.sort { a, b in a.0.state != b.0.state ? a.0.state < b.0.state : a.1 > b.1 }
        return Array(out.prefix(limit).map(\.0))
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
                                              childStatuses: childStatuses(), windows: windows())
        if next != rows { rows = next }
    }

    /// Test and gallery seam: hosts as `island.hosts` would give them.
    func setHostsForTesting(_ hosts: [String: [IslandHost]]) { self.hosts = hosts }

    func open(_ row: IslandSessionRow) {
        perform(IslandSessionsBuilder.target(of: row.sessionId, hosts: hosts[row.sessionId] ?? [], windows: windows()))
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
        } else if scrolls {
            ScrollView(.vertical) { list }.scrollIndicators(.never)
        } else {
            list
            Spacer(minLength: 0)
        }
    }

    private var list: some View {
        VStack(spacing: 6) {
            ForEach(model.rows) { row in
                IslandSessionRowView(row: row) { onOpen(row) }
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
    }
}

struct IslandSessionRowView: View {
    let row: IslandSessionRow
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IslandHoverSurface { hovered in
                HStack(spacing: 10) {
                    Image(systemName: row.state.symbol)
                        .font(Typography.label(.semibold))
                        .foregroundStyle(islandSessionStateColor(row.state))
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title)
                            .font(Typography.body(.light))
                            .foregroundStyle(Color.white)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        HStack(spacing: 5) {
                            Text(row.mode)
                            Text("·")
                            Image(systemName: row.host.symbol)
                            Text(row.host.label)
                        }
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(row.state.label)
                        .font(Typography.caption(.medium))
                        .foregroundStyle(row.state == .waiting ? Color.black : Color.white)
                        .padding(.horizontal, 8)
                        .frame(height: 20)
                        .background(Capsule().fill(row.state == .waiting ? pillReviewAmber : Color.white.opacity(hovered ? 0.16 : 0.1)))
                    Image(systemName: "arrow.up.right")
                        .font(Typography.caption(.semibold))
                        .foregroundStyle(hovered ? Color.white : Theme.textMuted)
                }
                .padding(.horizontal, 12)
                .frame(height: 50)
            }
        }
        .buttonStyle(IslandPressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.title), \(row.mode), \(row.state.label), \(row.host.label). Show it.")
    }
}

func islandSessionStateColor(_ state: IslandSessionLiveState) -> Color {
    switch state {
    case .waiting: return pillReviewAmber
    case .working: return Theme.accent
    case .idle: return Theme.textMuted
    case .finished: return Color.white
    }
}
