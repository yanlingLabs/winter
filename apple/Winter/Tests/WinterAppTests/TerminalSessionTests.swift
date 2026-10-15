import AppKit
import XCTest
@testable import Winter

/// A pill run is a terminal tab: the OSC 133 marks its shell writes, how the run reads them (the line's own
/// status while the shell lives on), and what "Add to transcript" carries. Runs here are built WITHOUT a process.
@MainActor
final class TerminalSessionTests: XCTestCase {
    private func bytes(_ text: String) -> [UInt8] { Array(text.utf8) }

    func testTheScannerFindsCAndDMarksAndTheirStatus() {
        var scanner = TerminalSemanticMarkScanner()
        let stream = bytes("motd\u{1B}]133;C\u{07}out\r\n\u{1B}]133;D;3\u{07}prompt% ")
        let found = scanner.feed(stream[...])
        XCTAssertEqual(found.map(\.mark), [.commandStart, .commandEnd(3)])
        XCTAssertEqual(found.map(\.end), [12, 27], "each just past its terminator")
    }

    func testAMarkSplitAcrossReadsIsStillFound() {
        let stream = bytes("x\u{1B}]133;D;127\u{1B}\\y")
        for cut in 1..<stream.count {
            var scanner = TerminalSemanticMarkScanner()
            let first = scanner.feed(stream[0..<cut]).map(\.mark)
            let second = scanner.feed(stream[cut...]).map(\.mark)
            XCTAssertEqual(first + second, [.commandEnd(127)], "split at \(cut) (an ST terminator)")
        }
    }

    func testOtherSequencesAreNotMarks() {
        var scanner = TerminalSemanticMarkScanner()
        let stream = bytes("\u{1B}]0;title\u{07}\u{1B}]133;A\u{07}\u{1B}]133;B\u{07}\u{1B}[1mbold\u{1B}]1330;C\u{07}\u{1B}]133;D\u{07}")
        XCTAssertEqual(scanner.feed(stream[...]).map(\.mark), [.commandEnd(nil)], "a title, prompt marks, CSI: none")
        XCTAssertEqual(TerminalSemanticMarkScanner.mark(bytes("133;D;0;aid=7")), .commandEnd(0))
        XCTAssertEqual(TerminalSemanticMarkScanner.mark(bytes("133;D;x")), .commandEnd(nil), "an unreadable status is no status")
        var runaway = TerminalSemanticMarkScanner()
        let long = bytes("\u{1B}]133;D;" + String(repeating: "9", count: 400) + "\u{07}")
        XCTAssertTrue(runaway.feed(long[...]).isEmpty, "a runaway OSC is dropped")
    }

    private func makeRun(sessionId: String? = nil) -> CommandRun {
        let environment = CommandLineEnvironment.fixed(pathDirectories: ["/usr/bin"], commandNames: ["ls"],
                                                       homeDirectory: "/Users/u",
                                                       fileSystem: ShellCommandLineTests.fileSystem)
        return CommandRun(command: "open /tmp/x.png", workingDirectory: "/Users/u/proj", environment: environment,
                          sessionId: sessionId, launch: false)
    }

    func testTheLineEndsAtItsMarkWhileTheShellLivesOn() {
        let run = makeRun()
        run.feedForTesting(bytes("Last login: today\r\n% open /tmp/x.png\r\n\u{1B}]133;C\u{07}"))
        XCTAssertEqual(run.commandOutcome, .running)
        XCTAssertFalse(run.shellIsLive)
        run.feedForTesting(bytes("opened\r\n\u{1B}]13"))
        run.feedForTesting(bytes("3;D;1\u{07}\u{1B}]133;A\u{07}% "))
        XCTAssertEqual(run.commandOutcome, .exited(1), "the line's own status")
        XCTAssertEqual(run.outcome, .running, "the shell is still there")
        XCTAssertTrue(run.shellIsLive)
        XCTAssertEqual(CommandPillStatus(run.commandOutcome), .failed)
        // Only the line's own output: not the startup, not the next prompt.
        XCTAssertEqual(run.transcriptScope, .command)
        XCTAssertEqual(run.transcriptMessage(), "I ran this in my terminal in ~/proj (exit 1):\n```\n$ open /tmp/x.png\nopened\n```")
        // A later command's marks (the user's own shell integration) change nothing.
        run.feedForTesting(bytes("\u{1B}]133;C\u{07}\u{1B}]133;D;0\u{07}"))
        XCTAssertEqual(run.commandOutcome, .exited(1))
        run.finishForTesting(waitStatus: 0)
        XCTAssertEqual(run.outcome, .exited(0))
        XCTAssertEqual(run.commandOutcome, .exited(1), "the shell's end does not rewrite the line's")
        XCTAssertFalse(run.shellIsLive)
    }

    func testTypingMoreInTheShellSendsTheSessionTail() {
        let run = makeRun()
        run.feedForTesting(bytes("motd\r\n\u{1B}]133;C\u{07}first\r\n\u{1B}]133;D;0\u{07}% "))
        run.typeForTesting("l")
        XCTAssertEqual(run.transcriptScope, .command, "no Return yet")
        run.typeForTesting("s\r")
        XCTAssertEqual(run.transcriptScope, .session)
        run.feedForTesting(bytes("ls\r\nnotes.md\r\n% "))
        let message = run.transcriptMessage()
        XCTAssertTrue(message.hasPrefix("I ran this in my terminal in ~/proj (exit 0), then kept working in that shell:"))
        XCTAssertTrue(message.contains("$ open /tmp/x.png\nfirst\n% ls\nnotes.md\n%"), message)
        XCTAssertFalse(message.contains("motd"), "the startup files' output is not the session's")
    }

    func testTypingBeforeTheLineEndsIsTheLinesInput() {
        let run = makeRun()
        run.feedForTesting(bytes("\u{1B}]133;C\u{07}Password: "))
        run.typeForTesting("hunter\r")
        run.feedForTesting(bytes("\r\nok\r\n\u{1B}]133;D;0\u{07}"))
        XCTAssertEqual(run.transcriptScope, .command, "input to the running line is not more typing in the shell")
    }

    func testAShellThatEndsBeforeTheMarkEndsTheLineToo() {
        let run = makeRun()
        run.feedForTesting(bytes("\u{1B}]133;C\u{07}bye\r\n"))
        run.finishForTesting(waitStatus: 2 << 8)
        XCTAssertEqual(run.commandOutcome, .exited(2))
        XCTAssertFalse(run.shellIsLive)
    }
}

/// Real shells (`/bin/zsh`, `/bin/bash`) in a real pty, through `CommandRun` itself — with a throwaway HOME
/// holding synthetic startup files, so none of the user's own run. The line runs ONCE, after the startup files;
/// its status arrives through the `D` mark; and the shell stays alive at its prompt for more typing.
@MainActor
final class TerminalSessionIntegrationTests: XCTestCase {
    private var home: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("winter-session-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        home = (base as NSString).resolvingSymlinksInPath
    }

    override func tearDownWithError() throws {
        if let home { try? FileManager.default.removeItem(atPath: home) }
        try super.tearDownWithError()
    }

    private func write(_ name: String, _ contents: String) throws {
        try contents.write(toFile: home + "/" + name, atomically: true, encoding: .utf8)
    }

    private func environment(shell: String) -> CommandLineEnvironment {
        var run = loginShellEnvironment(from: [:], home: home, user: NSUserName(), shell: shell)
        run["BASH_SILENCE_DEPRECATION_WARNING"] = "1"
        return CommandLineEnvironment.fixed(pathDirectories: ["/usr/bin", "/bin"], commandNames: [],
                                            homeDirectory: home, fileSystem: LiveShellFileSystem(),
                                            shell: shell, runEnvironment: run)
    }

    /// Spins the main run loop (the pty's reads land there) until `condition` holds or `timeout` passes.
    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return false }
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return true
    }

    private func linesRun() -> [String] {
        ((try? String(contentsOfFile: home + "/runs", encoding: .utf8)) ?? "")
            .split(separator: "\n").map(String.init)
    }

    private func exercise(shell: String, line: String, expectedStatus: Int32, expectedRecord: String,
                          more: String, moreOutput: String) throws {
        let run = CommandRun(command: line, workingDirectory: home, environment: environment(shell: shell))
        defer {
            run.endShell()
            _ = waitUntil(5) { run.outcome != .running }
        }
        XCTAssertEqual(run.outcome, .running, "the shell started")
        XCTAssertTrue(waitUntil(15) { run.commandOutcome != .running }, "the line reported its end")
        XCTAssertEqual(run.commandOutcome, .exited(expectedStatus), "its status, through the D mark")
        XCTAssertEqual(run.outcome, .running, "the shell stays")
        XCTAssertTrue(run.shellIsLive)
        XCTAssertEqual(linesRun(), [expectedRecord], "the line ran once, after the user's startup files")
        XCTAssertTrue(run.transcriptMessage().contains("hello-from-line"), "the line's output is captured")

        // Keep typing: the shell answers.
        _ = waitUntil(1) { false } // let the prompt draw
        run.typeForTesting(more + "\r")
        XCTAssertTrue(waitUntil(10) { run.transcriptMessage().contains(moreOutput) }, "the shell is interactive")
        XCTAssertEqual(run.transcriptScope, .session)
        XCTAssertEqual(linesRun(), [expectedRecord], "and the line did not run again")
        XCTAssertEqual(run.outcome, .running)

        run.endShell()
        XCTAssertTrue(waitUntil(5) { run.outcome != .running }, "End ends the shell")
    }

    func testZshRunsTheLineOnceThenStaysAtItsPrompt() throws {
        try write(".zshenv", "export WINTER_TEST_ENV=env\n")
        try write(".zshrc", "export WINTER_TEST_RC=rc\nalias hi='print -r -- hello-from-line'\n")
        let line = #"print -r -- "env=$WINTER_TEST_ENV rc=$WINTER_TEST_RC zd=${ZDOTDIR-unset}" >> $HOME/runs; hi; (exit 3)"#
        try exercise(shell: "/bin/zsh", line: line, expectedStatus: 3, expectedRecord: "env=env rc=rc zd=unset",
                     more: "print -r -- again-$((40+2))", moreOutput: "again-42")
    }

    func testBashRunsTheLineOnceThenStaysAtItsPrompt() throws {
        try write(".bash_profile", "export WINTER_TEST_RC=profile\n")
        let line = #"echo "rc=$WINTER_TEST_RC" >> "$HOME/runs"; echo hello-from-line; (exit 4)"#
        try exercise(shell: "/bin/bash", line: line, expectedStatus: 4, expectedRecord: "rc=profile",
                     more: "echo again-$((40+2))", moreOutput: "again-42")
    }

    func testCtrlCStopsTheLineButNotTheShell() throws {
        let run = CommandRun(command: "sleep 30", workingDirectory: home, environment: environment(shell: "/bin/zsh"))
        defer {
            run.endShell()
            _ = waitUntil(5) { run.outcome != .running }
        }
        XCTAssertTrue(waitUntil(15) {
            run.phase == .command && run.foregroundGroup() != nil && run.foregroundGroup() != run.processGroup
        }, "the line is running in the foreground, as a job of its own")
        run.interrupt()
        XCTAssertTrue(waitUntil(10) { run.commandOutcome != .running })
        XCTAssertEqual(run.commandOutcome, .exited(130), "interrupted")
        XCTAssertEqual(run.outcome, .running, "the shell stays")
    }
}
