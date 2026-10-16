import XCTest
import WinterKit
@testable import Winter

/// The island's Sessions tab: each row's live state and host, which sessions are listed (never a running Dispatch
/// child), and where a click takes the user's view — with fakes for the app's windows and the terminal lookups.
@MainActor
final class IslandSessionsTests: XCTestCase {
    private func row(_ id: String, title: String? = nil, created: Int = 0, mode: String? = nil, parent: String? = nil,
                     activity: String? = nil, archived: Bool? = nil, working: Bool? = nil, wakes: Int? = nil) -> SessionSummary {
        SessionSummary(sessionId: id, title: title, createdAt: created, scope: "global", mode: mode, parentSessionId: parent,
                       activity: activity, archived: archived,
                       signals: working.map { SessionSignals(attachedElsewhere: false, working: $0) }, wakesArmed: wakes)
    }

    private let terminal = IslandHost(clientName: "cli-chat", role: "harness", tty: "/dev/ttys004")
    private let phone = IslandHost(clientName: "iphone-gateway", role: "remote")
    private let app = IslandHost(clientName: "orb", role: "harness")

    func testTheLiveStateIsWaitingThenWorkingThenFinishedElseIdle() {
        XCTAssertEqual(IslandSessionsBuilder.state(of: row("a", working: true), waiting: ["a"], childStatuses: [:]), .waiting,
                       "a card waiting beats working")
        XCTAssertEqual(IslandSessionsBuilder.state(of: row("a", wakes: 1), waiting: [], childStatuses: [:]), .waiting,
                       "an armed wake trigger is Winter waiting for the user")
        XCTAssertEqual(IslandSessionsBuilder.state(of: row("a", working: true), waiting: [], childStatuses: [:]), .working)
        XCTAssertEqual(IslandSessionsBuilder.state(of: row("c", parent: "d"), waiting: [], childStatuses: ["c": "completed"]), .finished)
        XCTAssertEqual(IslandSessionsBuilder.state(of: row("c", parent: "d"), waiting: [], childStatuses: ["c": "error"]), .finished)
        XCTAssertEqual(IslandSessionsBuilder.state(of: row("a", working: false), waiting: [], childStatuses: [:]), .idle)
        XCTAssertEqual(IslandSessionsBuilder.state(of: row("a"), waiting: [], childStatuses: [:]), .idle, "no signals: idle, never working")
    }

    func testTheHostIsTheAppsOwnWindowFirstThenATerminalThenAPhone() {
        let windows = IslandWindowFacts(appWindowSessionId: "w", detachedSessionIds: ["d"])
        XCTAssertEqual(IslandSessionsBuilder.host(of: "d", hosts: [terminal], windows: windows), .detachedWindow)
        XCTAssertEqual(IslandSessionsBuilder.host(of: "w", hosts: [terminal], windows: windows), .winterWindow)
        XCTAssertEqual(IslandSessionsBuilder.host(of: "t", hosts: [app, terminal], windows: windows), .terminal(tty: "/dev/ttys004"))
        XCTAssertEqual(IslandSessionsBuilder.host(of: "p", hosts: [phone], windows: windows), .phone)
        XCTAssertEqual(IslandSessionsBuilder.host(of: "n", hosts: [app], windows: windows), .nowhere,
                       "the app's own feed attached without a window showing it is not a place to go")
        XCTAssertEqual(IslandSessionsBuilder.host(of: "x", hosts: [IslandHost(clientName: "cli-chat", role: "remote", tty: "/dev/ttys1")],
                                                  windows: windows), .phone, "a remote client's tty is never a local terminal")
        XCTAssertEqual(IslandSessionHostKind.terminal(tty: "/dev/ttys004").label, "Terminal · ttys004")
    }

    func testAClickGoesToTheDetachedWindowTheAppWindowTheExactTerminalOrOpensADetachedWindow() {
        let windows = IslandWindowFacts(appWindowSessionId: "w", detachedSessionIds: ["d"])
        XCTAssertEqual(IslandSessionsBuilder.target(of: "d", hosts: [terminal], windows: windows), .detachedWindow(sessionId: "d"))
        XCTAssertEqual(IslandSessionsBuilder.target(of: "w", hosts: [], windows: windows), .appWindow(sessionId: "w"))
        XCTAssertEqual(IslandSessionsBuilder.target(of: "t", hosts: [terminal], windows: windows),
                       .terminal(tty: "/dev/ttys004", sessionId: "t"))
        XCTAssertEqual(IslandSessionsBuilder.target(of: "p", hosts: [phone], windows: windows), .openDetached(sessionId: "p"),
                       "a phone is not on this Mac: the session opens in a detached window")
        XCTAssertEqual(IslandSessionsBuilder.target(of: "n", hosts: [], windows: windows), .openDetached(sessionId: "n"))
        // The Dispatch session is the pill's: Winter's Dispatch view, never a second (detached) window on it.
        XCTAssertEqual(IslandSessionsBuilder.target(of: "disp", hosts: [app], windows: windows, isDispatch: true),
                       .dispatch(sessionId: "disp"))
        XCTAssertEqual(IslandSessionsBuilder.host(of: "disp", hosts: [app], windows: windows, isDispatch: true), .dispatchPill)
        XCTAssertEqual(IslandSessionsBuilder.target(of: "d", hosts: [], windows: windows, isDispatch: true),
                       .detachedWindow(sessionId: "d"), "a detached window showing it still wins")
    }

    func testRunningDispatchChildrenStayAboveThePillAndFinishedOrIdleOnesAreListed() {
        let directory = [
            row("running", title: "Running child", created: 5, parent: "d", working: true),
            row("waiting-child", title: "Child asking", created: 4, parent: "d"),
            row("done", title: "Done child", created: 3, parent: "d"),
            row("idle-child", title: "Idle child", created: 2, parent: "d", working: false),
        ]
        let statuses = ["running": "running", "waiting-child": "awaiting_approval", "done": "completed"]
        let rows = IslandSessionsBuilder.rows(directory: directory, hosts: ["idle-child": [terminal]], waiting: [],
                                              childStatuses: statuses, windows: IslandWindowFacts())
        XCTAssertEqual(rows.map(\.sessionId), ["idle-child", "done"])
        XCTAssertEqual(rows.first { $0.sessionId == "done" }?.state, .finished)
        XCTAssertEqual(rows.first { $0.sessionId == "done" }?.mode, "Dispatch task")
        XCTAssertTrue(IslandSessionsBuilder.isRunningDispatchChild(row("x", parent: "d", working: true), childStatuses: [:]),
                      "a working child the pill has not listed yet is still the pill's")
    }

    func testRowsListEveryLiveModeOrderedWaitingWorkingIdleFinishedNewestFirstAndSkipArchivedOrForgotten() {
        let directory = [
            row("old-idle", title: "Forgotten", created: 1, working: false),
            row("archived", title: "Archived", created: 9, archived: true, working: true),
            row("chat", title: "Planning", created: 2, mode: "chat", working: false),
            row("w1", title: "Working older", created: 3, working: true),
            row("w2", title: "Working newer", created: 8, working: true),
            row("ask", title: "Asking", created: 4, mode: "dispatch"),
            row("bg", title: "", created: 5, activity: "background"),
        ]
        let rows = IslandSessionsBuilder.rows(directory: directory, hosts: [:], waiting: ["ask"], childStatuses: [:],
                                              windows: IslandWindowFacts(appWindowSessionId: nil, detachedSessionIds: ["chat"]))
        XCTAssertEqual(rows.map(\.sessionId), ["ask", "w2", "w1", "bg", "chat"],
                       "an idle session open nowhere is not listed; archived never is")
        XCTAssertEqual(rows.first { $0.sessionId == "ask" }?.mode, "Dispatch")
        XCTAssertEqual(rows.first { $0.sessionId == "ask" }?.host, .dispatchPill)
        XCTAssertEqual(rows.first { $0.sessionId == "chat" }?.mode, "Chat")
        XCTAssertEqual(rows.first { $0.sessionId == "chat" }?.host, .detachedWindow)
        XCTAssertEqual(rows.first { $0.sessionId == "bg" }?.title, "Untitled code")
        XCTAssertEqual(IslandSessionsBuilder.workingCount(directory), 2, "archived sessions do not count as working")
    }

    func testTheModelFetchesHostsRecomputesAndPerformsTheResolvedTarget() async {
        let model = IslandSessionsModel()
        var directoryRefreshes = 0
        var performed: [IslandSessionTarget] = []
        model.directory = { [self] in [row("t", title: "Terminal job", created: 1, working: true)] }
        model.refreshDirectory = { directoryRefreshes += 1 }
        model.fetchHosts = { [terminal] in ["t": [terminal]] }
        model.perform = { performed.append($0) }
        await model.refresh()
        XCTAssertEqual(directoryRefreshes, 1)
        XCTAssertEqual(model.rows.map(\.host), [.terminal(tty: "/dev/ttys004")])
        model.open(model.rows[0])
        XCTAssertEqual(performed, [.terminal(tty: "/dev/ttys004", sessionId: "t")])
        // A failed hosts fetch keeps the last known hosts.
        model.fetchHosts = { throw URLError(.timedOut) }
        await model.refresh()
        XCTAssertEqual(model.rows.map(\.host), [.terminal(tty: "/dev/ttys004")])
    }

    // MARK: - The terminal (fakes for the process table and the windows)

    private let processes = [
        TerminalProcess(pid: 100, ppid: 1, tty: nil, command: "Terminal"),
        TerminalProcess(pid: 200, ppid: 100, tty: "ttys004", command: "login"),
        TerminalProcess(pid: 201, ppid: 200, tty: "ttys004", command: "zsh"),
        TerminalProcess(pid: 202, ppid: 201, tty: "ttys004", command: "winter"),
        TerminalProcess(pid: 300, ppid: 100, tty: "ttys005", command: "login"),
        TerminalProcess(pid: 301, ppid: 300, tty: "ttys005", command: "zsh"),
        TerminalProcess(pid: 302, ppid: 301, tty: "ttys005", command: "vim"),
    ]

    func testTheTerminalAppIsFoundUpTheTTYsProcessTree() {
        let chain = TerminalRaiser.ancestors(ofTTY: "/dev/ttys004", processes: processes)
        XCTAssertTrue(chain.contains(100), "the terminal app is an ancestor of the tty's processes")
        XCTAssertFalse(chain.contains(300))
        XCTAssertEqual(TerminalRaiser.ancestors(ofTTY: "/dev/ttys999", processes: processes), [])
    }

    func testTheWindowOrTabHoldingTheTTYIsPickedOnlyOnEvidence() {
        // Two windows of Terminal.app titled by their running program: the "winter" one is ttys004's.
        let windows = [TerminalWindowCandidate(title: "project — vim — 80×24", tabTitles: []),
                       TerminalWindowCandidate(title: "project — winter — 80×24", tabTitles: [])]
        let picked = TerminalRaiser.pick(tty: "/dev/ttys004", appPid: 100, bundleId: "com.apple.Terminal",
                                         processes: processes, windows: windows)
        XCTAssertEqual(picked?.window, 1)
        XCTAssertNil(picked?.tab)
        // One window with two tabs: the tab whose title names the program.
        let tabbed = [TerminalWindowCandidate(title: "project — vim — 80×24", tabTitles: ["vim", "winter"])]
        let tab = TerminalRaiser.pick(tty: "/dev/ttys004", appPid: 100, bundleId: "com.apple.Terminal",
                                      processes: processes, windows: tabbed)
        XCTAssertEqual(tab?.window, 0)
        XCTAssertEqual(tab?.tab, 1)
        // Titles that prove nothing (both at a shell prompt): no pick — the app is only activated.
        let vague = [TerminalWindowCandidate(title: "project — zsh — 80×24", tabTitles: []),
                     TerminalWindowCandidate(title: "project — zsh — 80×24", tabTitles: [])]
        XCTAssertNil(TerminalRaiser.pick(tty: "/dev/ttys004", appPid: 100, bundleId: "com.apple.Terminal",
                                         processes: processes, windows: vague))
        // Not a dedicated terminal app (an editor): only a title naming the tty itself counts.
        XCTAssertNil(TerminalRaiser.pick(tty: "/dev/ttys004", appPid: 100, bundleId: "com.example.editor",
                                         processes: processes, windows: windows))
        let named = [TerminalWindowCandidate(title: "editor — ttys005", tabTitles: []),
                     TerminalWindowCandidate(title: "editor — ttys004", tabTitles: [])]
        XCTAssertEqual(TerminalRaiser.pick(tty: "/dev/ttys004", appPid: 100, bundleId: "com.example.editor",
                                           processes: processes, windows: named)?.window, 1)
    }
}
