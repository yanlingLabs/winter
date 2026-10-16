import XCTest
@testable import Winter

/// The tty → frontmost terminal window/tab matcher, with fake process tables and window titles.
final class TerminalWindowMatcherTests: XCTestCase {
    /// Terminal.app (pid 100) with two tabs: ttys004 runs the Winter TUI, ttys005 runs vim.
    private let terminal: [TerminalProcess] = [
        TerminalProcess(pid: 1, ppid: 0, tty: nil, command: "launchd"),
        TerminalProcess(pid: 100, ppid: 1, tty: nil, command: "Terminal"),
        TerminalProcess(pid: 200, ppid: 100, tty: "ttys004", command: "login"),
        TerminalProcess(pid: 201, ppid: 200, tty: "ttys004", command: "zsh"),
        TerminalProcess(pid: 202, ppid: 201, tty: "ttys004", command: "winter"),
        TerminalProcess(pid: 300, ppid: 100, tty: "ttys005", command: "login"),
        TerminalProcess(pid: 301, ppid: 300, tty: "ttys005", command: "zsh"),
        TerminalProcess(pid: 302, ppid: 301, tty: "ttys005", command: "vim"),
        // Another app (pid 400) with its own terminal.
        TerminalProcess(pid: 400, ppid: 1, tty: nil, command: "Ghostty"),
        TerminalProcess(pid: 401, ppid: 400, tty: "ttys009", command: "zsh"),
    ]

    private func snapshot(front: Int32? = 100, bundle: String? = "com.apple.Terminal", window: String? = nil, tab: String? = nil,
                          processes: [TerminalProcess]? = nil) -> FrontTerminalSnapshot {
        FrontTerminalSnapshot(frontPid: front, frontBundleId: bundle, processes: processes ?? terminal, windowTitle: window, tabTitle: tab)
    }

    func testATitleNamingTheTtyIsAnExactMatch() {
        let s = snapshot(window: "user — ttys004 — 80×24")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: s), .front)
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys005", in: s), .notFront)
    }

    func testTheSelectedTabsTitleNamesTheProgramRunningInExactlyOneTerminal() {
        let winterTab = snapshot(window: "user — winter — 80×24", tab: "winter")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: winterTab), .front)
        let vimTab = snapshot(window: "user — vim — 80×24")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: vimTab), .notFront)
    }

    func testAShellTitleTellsNothingWhenSeveralTerminalsAreOpen() {
        let s = snapshot(window: "user — -zsh — 80×24")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: s), .unknown, "no exact match: the card shows")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: snapshot(window: nil)), .unknown)
    }

    func testAnAppWithOneTerminalIsThatTerminal() {
        let s = snapshot(front: 400, bundle: "com.mitchellh.ghostty", window: "~")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys009", in: s), .front)
    }

    func testATerminalTheFrontAppDoesNotHostIsNotInFront() {
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys009", in: snapshot(window: "user — winter — 80×24")), .notFront)
        // Another app entirely (Safari) in front.
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: snapshot(front: 999, bundle: "com.apple.Safari")), .notFront)
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: snapshot(front: nil)), .unknown)
    }

    func testAnEditorsIntegratedTerminalNeedsTheTtyItselfInATitle() {
        // VS Code (pid 500) hosts ONE terminal running winter, but the editor may have the focus.
        let code: [TerminalProcess] = [
            TerminalProcess(pid: 500, ppid: 1, tty: nil, command: "Electron"),
            TerminalProcess(pid: 501, ppid: 500, tty: nil, command: "Code Helper"),
            TerminalProcess(pid: 502, ppid: 501, tty: "ttys012", command: "zsh"),
            TerminalProcess(pid: 503, ppid: 502, tty: "ttys012", command: "winter"),
        ]
        let editing = snapshot(front: 500, bundle: "com.microsoft.VSCode", window: "main.swift — winter", processes: code)
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys012", in: editing), .unknown,
                       "one terminal and a title mentioning winter prove nothing in an editor")
        let named = snapshot(front: 500, bundle: "com.microsoft.VSCode", window: "ttys012 — zsh", processes: code)
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys012", in: named), .front)
    }

    func testTmuxsServerPtyIsNotTheFrontAppsSoTheCardShows() {
        // The CLI runs inside tmux: its pty (ttys020) belongs to the tmux server, a child of launchd.
        var procs = terminal
        procs.append(TerminalProcess(pid: 600, ppid: 1, tty: nil, command: "tmux"))
        procs.append(TerminalProcess(pid: 601, ppid: 600, tty: "ttys020", command: "winter"))
        XCTAssertNotEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys020", in: snapshot(window: "tmux", processes: procs)), .front)
    }

    func testTitleWordsAreWholeWords() {
        XCTAssertTrue(TerminalWindowMatcher.title("user — winter — 80×24", mentions: "winter"))
        XCTAssertFalse(TerminalWindowMatcher.title("winterfell", mentions: "winter"))
        XCTAssertFalse(TerminalWindowMatcher.title("ttys0041", mentions: "ttys004"))
        XCTAssertTrue(TerminalWindowMatcher.title("(ttys004)", mentions: "ttys004"))
        XCTAssertEqual(TerminalWindowMatcher.deviceName("/dev/ttys004"), "ttys004")
    }

    func testNoFocusedWindowProvesNothing() {
        var s = snapshot(front: 400, bundle: "com.mitchellh.ghostty", window: nil)
        s.hasFocusedWindow = false // minimised, or on another Space
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys009", in: s), .unknown, "the card shows")
        s.hasFocusedWindow = true
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys009", in: s), .front)
    }

    func testOnlyTheTitlesProcessSegmentNamesTheProgram() {
        // The FOLDER is called "winter" while the tab sits at a shell prompt: not proof the TUI is in front.
        let folder = snapshot(window: "winter — -zsh — 80×24")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: folder), .unknown)
        XCTAssertEqual(TerminalWindowMatcher.processSegment(of: "winter — vim — 120×40"), "vim")
        XCTAssertEqual(TerminalWindowMatcher.processSegment(of: "winter"), "winter")
        XCTAssertNil(TerminalWindowMatcher.processSegment(of: "a — b"), "segments with no size: which is the process is unknown")
        XCTAssertEqual(TerminalWindowMatcher.frontness(of: "/dev/ttys004", in: snapshot(window: "projects — vim — 80×24")), .notFront)
    }
}
