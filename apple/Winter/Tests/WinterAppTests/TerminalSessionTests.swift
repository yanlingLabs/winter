import AppKit
import XCTest
@testable import Winter

/// A pill run is a terminal tab: the OSC 133 marks its shell writes, how the run reads them (the line's own
/// status while the shell lives on), and what "Add to transcript" carries. Runs here are built WITHOUT a process.
@MainActor
final class TerminalSessionTests: XCTestCase {
    private func bytes(_ text: String) -> [UInt8] { Array(text.utf8) }

    private let tag = "winter-0123456789abcdef"

    func testTheScannerFindsTheRunsCAndDMarksAndTheirStatus() {
        var scanner = TerminalSemanticMarkScanner(tag: tag)
        let stream = bytes("motd\u{1B}]133;C;\(tag)\u{07}out\r\n\u{1B}]133;D;3;\(tag)\u{07}prompt% ")
        let found = scanner.feed(stream[...])
        XCTAssertEqual(found.map(\.mark), [.commandStart, .commandEnd(3)])
        XCTAssertEqual(found.map(\.end), [12 + tag.count + 1, 27 + 2 * (tag.count + 1)], "each just past its terminator")
    }

    func testAMarkSplitAcrossReadsIsStillFound() {
        let stream = bytes("x\u{1B}]133;D;127;\(tag)\u{1B}\\y")
        for cut in 1..<stream.count {
            var scanner = TerminalSemanticMarkScanner(tag: tag)
            let first = scanner.feed(stream[0..<cut]).map(\.mark)
            let second = scanner.feed(stream[cut...]).map(\.mark)
            XCTAssertEqual(first + second, [.commandEnd(127)], "split at \(cut) (an ST terminator)")
        }
    }

    func testOnlyTheRunsOwnMarksCount() {
        var scanner = TerminalSemanticMarkScanner(tag: tag)
        let stream = bytes("\u{1B}]0;title\u{07}\u{1B}]133;A\u{07}\u{1B}]133;D;0\u{07}\u{1B}]133;C\u{07}"
                           + "\u{1B}]133;D;0;winter-ffffffffffffffff\u{07}\u{1B}[1mbold\u{1B}]1330;C;\(tag)\u{07}"
                           + "\u{1B}]133;D;;\(tag)\u{07}")
        XCTAssertEqual(scanner.feed(stream[...]).map(\.mark), [.commandEnd(nil)],
                       "untagged and other runs' marks, a title, CSI: none — only the run's own")
        XCTAssertEqual(TerminalSemanticMarkScanner.mark(bytes("133;D;0;aid=7;\(tag)"), tag: tag), .commandEnd(0))
        XCTAssertEqual(TerminalSemanticMarkScanner.mark(bytes("133;D;x;\(tag)"), tag: tag), .commandEnd(nil),
                       "an unreadable status is no status")
        var runaway = TerminalSemanticMarkScanner(tag: tag)
        let long = bytes("\u{1B}]133;D;" + String(repeating: "9", count: 400) + ";\(tag)\u{07}")
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
        run.feedForTesting(bytes("Last login: today\r\n% open /tmp/x.png\r\n" + run.startMarkForTesting()))
        XCTAssertEqual(run.commandOutcome, .running)
        XCTAssertFalse(run.shellIsLive)
        let end = run.endMarkForTesting(1)
        run.feedForTesting(bytes("opened\r\n" + String(end.prefix(4))))
        run.feedForTesting(bytes(String(end.dropFirst(4)) + "\u{1B}]133;A\u{07}% "))
        XCTAssertEqual(run.commandOutcome, .exited(1), "the line's own status")
        XCTAssertEqual(run.outcome, .running, "the shell is still there")
        XCTAssertTrue(run.shellIsLive)
        XCTAssertEqual(CommandPillStatus(run.commandOutcome), .failed)
        // Only the line's own output: not the startup, not the next prompt.
        XCTAssertEqual(run.transcriptScope, .command)
        XCTAssertEqual(run.transcriptMessage(), "I ran this in my terminal in ~/proj (exit 1):\n```\n$ open /tmp/x.png\nopened\n```")
        // A later command's marks (the user's own shell integration) change nothing — tagged or not.
        run.feedForTesting(bytes("\u{1B}]133;C\u{07}\u{1B}]133;D;0\u{07}" + run.endMarkForTesting(0)))
        XCTAssertEqual(run.commandOutcome, .exited(1))
        run.finishForTesting(waitStatus: 0)
        XCTAssertEqual(run.outcome, .exited(0))
        XCTAssertEqual(run.commandOutcome, .exited(1), "the shell's end does not rewrite the line's")
        XCTAssertFalse(run.shellIsLive)
    }

    func testTypingMoreInTheShellSendsTheSessionTail() {
        let run = makeRun()
        run.feedForTesting(bytes("motd\r\n" + run.startMarkForTesting() + "first\r\n" + run.endMarkForTesting(0) + "% "))
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
        run.feedForTesting(bytes(run.startMarkForTesting() + "Password: "))
        run.typeForTesting("hunter\r")
        run.feedForTesting(bytes("\r\nok\r\n" + run.endMarkForTesting(0)))
        XCTAssertEqual(run.transcriptScope, .command, "input to the running line is not more typing in the shell")
    }

    func testAShellThatEndsBeforeTheMarkEndsTheLineToo() {
        let run = makeRun()
        run.feedForTesting(bytes(run.startMarkForTesting() + "bye\r\n"))
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
        CommandRun.fallbackAfter = 3
        CommandRun.fallbackQuiet = 1
        CommandRun.fallbackGiveUp = 5
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
        // `!` is never history-expanded: the line runs exactly as validated.
        let line = #"print -r -- "env=$WINTER_TEST_ENV rc=$WINTER_TEST_RC zd=${ZDOTDIR-unset} bang=fix!it !!" >> $HOME/runs; hi; (exit 3)"#
        try exercise(shell: "/bin/zsh", line: line, expectedStatus: 3,
                     expectedRecord: "env=env rc=rc zd=unset bang=fix!it !!",
                     more: "print -r -- again-$((40+2))", moreOutput: "again-42")
    }

    func testBashRunsTheLineOnceThenStaysAtItsPrompt() throws {
        try write(".bash_profile", "export WINTER_TEST_RC=profile\n")
        let line = #"echo "rc=$WINTER_TEST_RC bang=fix!it !!" >> "$HOME/runs"; echo hello-from-line; (exit 4)"#
        try exercise(shell: "/bin/bash", line: line, expectedStatus: 4, expectedRecord: "rc=profile bang=fix!it !!",
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

    func testAMarkPrintedByTheLineItselfIsNotItsEnd() throws {
        let line = #"printf '\033]133;D;0\007'; printf '\033]133;D;0;winter-0000000000000000\007'; sleep 0.3; (exit 5)"#
        let run = CommandRun(command: line, workingDirectory: home, environment: environment(shell: "/bin/zsh"))
        defer { run.endShell(); _ = waitUntil(5) { run.outcome != .running } }
        XCTAssertTrue(waitUntil(15) { run.commandOutcome != .running })
        XCTAssertEqual(run.commandOutcome, .exited(5), "only the run's own tagged mark ends it")
    }

    func testTheFallbackRunsTheLineWhenThePromptHookNeverFires() throws {
        // A plugin (zsh-vi-mode does this) replaces zle-line-init at the first prompt: the shim's hook never fires.
        try write(".zshrc", """
            __t_noop() { : }
            __t_rebind() { zle -N zle-line-init __t_noop; precmd_functions=(${precmd_functions:#__t_rebind}) }
            precmd_functions+=(__t_rebind)

            """)
        CommandRun.fallbackAfter = 1
        CommandRun.fallbackQuiet = 0.5
        let run = CommandRun(command: #"print -r -- "fallback fix!it" >> $HOME/runs; (exit 6)"#, workingDirectory: home,
                             environment: environment(shell: "/bin/zsh"))
        defer { run.endShell(); _ = waitUntil(5) { run.outcome != .running } }
        XCTAssertTrue(waitUntil(15) { run.commandOutcome != .running })
        XCTAssertTrue(run.fallbackSentForTesting)
        XCTAssertEqual(run.commandOutcome, .exited(6))
        XCTAssertEqual(linesRun(), ["fallback fix!it"], "once, and never history-expanded")
        XCTAssertEqual(run.outcome, .running)
    }

    func testTheRunScriptRunsTheLineOnceFromItsFileWhenTheShimWasSkipped() throws {
        for shell in ["/bin/sh", "/bin/bash", "/bin/zsh"] {
            let shim = home + "/shim-" + (shell as NSString).lastPathComponent
            try FileManager.default.createDirectory(atPath: shim, withIntermediateDirectories: false)
            let invocation = loginShellSessionInvocation(shell: shell, line: #"echo "ran fix!it"; (exit 7)"#,
                                                         shimDirectory: shim, nonce: "feedfacefeedface")
            for name in [loginShellLineFile, "run"] {
                try invocation.files[name]!.write(toFile: shim + "/" + name, atomically: true, encoding: .utf8)
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: shell)
            process.arguments = ["-c", ". '\(shim)/run'; . '\(shim)/run'"]
            process.environment = ["HOME": home, "PATH": "/usr/bin:/bin"]
            let pipe = Pipe()
            process.standardOutput = pipe
            try process.run()
            process.waitUntilExit()
            let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            XCTAssertEqual(out.components(separatedBy: "ran fix!it").count - 1, 1, "\(shell): once")
            XCTAssertTrue(out.contains("\u{1B}]133;C;winter-feedfacefeedface\u{07}"), shell)
            XCTAssertTrue(out.contains("\u{1B}]133;D;7;winter-feedfacefeedface\u{07}"), shell)
            XCTAssertFalse(FileManager.default.fileExists(atPath: shim + "/" + loginShellLineFile), "\(shell): the line file is deleted")
        }
    }

    func testARunWhoseLineNeverStartsIsMarkedFailedNotLeftRunning() {
        let environment = CommandLineEnvironment.fixed(pathDirectories: ["/usr/bin"], commandNames: [], homeDirectory: home,
                                                       fileSystem: LiveShellFileSystem())
        let run = CommandRun(command: "ls", workingDirectory: home, environment: environment, launch: false)
        run.checkFallback(now: Date().addingTimeInterval(1))
        XCTAssertFalse(run.fallbackSentForTesting, "too early")
        run.checkFallback(now: Date().addingTimeInterval(4))
        XCTAssertTrue(run.fallbackSentForTesting)
        XCTAssertEqual(run.commandOutcome, .running)
        run.checkFallback(now: Date().addingTimeInterval(10))
        XCTAssertEqual(run.commandOutcome, .failedToStart)
        XCTAssertNotNil(run.failureNote)
    }

    func testEndKillsTheWholeSessionEvenAJobThatIgnoresHangUp() throws {
        let run = CommandRun(command: #"(trap '' HUP; exec sleep 300) & print -r -- $! > $HOME/bgpid"#,
                             workingDirectory: home, environment: environment(shell: "/bin/zsh"))
        XCTAssertTrue(waitUntil(15) { run.commandOutcome != .running })
        guard let text = try? String(contentsOfFile: home + "/bgpid", encoding: .utf8),
              let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return XCTFail("no job pid") }
        XCTAssertEqual(kill(pid, 0), 0, "the background job runs")
        XCTAssertEqual(getsid(pid), run.processGroup, "in the run's terminal session")
        run.endShell()
        XCTAssertTrue(waitUntil(5) { run.outcome != .running }, "the shell went")
        XCTAssertTrue(waitUntil(5) { kill(pid, 0) != 0 }, "and the job that ignored SIGHUP went too")
    }
}
