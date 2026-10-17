import AppKit
import XCTest
@testable import Winter

/// Whole-command validation on zsh's completion system: the captured-completion parser, the per-position
/// decision and the prose guard against INJECTED candidate lists; then one integration class against the real
/// system zsh (skipped when zsh or zsh/zpty is unavailable). No test sources anyone's `.zshrc`: the engine is
/// `zsh -f`, on a temp HOME.
final class ZshCompletionTests: XCTestCase {
    /// Candidates by buffer, completion functions by command — what zsh would have said.
    final class FakeCompletionSource: ShellCompletionSource {
        var captures: [String: ZshCompletionCapture]
        var functions: [String: Bool]
        /// Buffers asked about, in order.
        private(set) var asked: [String] = []
        var unavailable = false

        init(captures: [String: ZshCompletionCapture], functions: [String: Bool]) {
            self.captures = captures
            self.functions = functions
        }

        func capture(buffer: String, directory: String, deadline: Date) -> ZshCompletionCapture? {
            asked.append(buffer)
            return unavailable ? nil : (captures[buffer] ?? .empty)
        }

        func hasCompletionFunction(_ command: String, deadline: Date) -> Bool? {
            unavailable ? nil : (functions[command] ?? false)
        }
    }

    private static func hits(_ hits: [String], _ kinds: Set<ZshCompletionCapture.Kind> = []) -> ZshCompletionCapture {
        ZshCompletionCapture(hits: hits, kinds: kinds)
    }

    private let source = FakeCompletionSource(captures: [
        "git status": hits(["status"]),
        "git sta": hits(["stash", "status"]),
        "git stat": hits(["status"]),
        "git is": hits([]),
        "git commit": hits(["commit"]),
        "git commit -m": hits(["-m"]),
        #"git commit -m "fix the bug""#: hits([], [.message]),
        "git checkout": hits(["checkout"]),
        "git checkout ma": hits(["main", "master"]),
        "which one": hits([]),
        "ls -la": hits([]),
        "ls -": hits(["-a", "-l", "-h"]),
        "ls -la /tmp": hits(["/tmp/"], [.files]),
        "ls /tmp/x/no": hits(["/tmp/x/notes.md"], [.files]),
        "open notes.md": hits([], [.files]),
        "open the": hits([], [.files]),
        "make sure": hits(["build", "clean"]),
        "make build": hits(["build"]),
        "cd ..": hits(["../"], [.files]),
    ], functions: ["git": true, "ls": true, "which": true, "open": true, "make": true, "cd": true, "echo": false])

    private func context() -> ShellCommandContext {
        var nodes = ShellCommandLineTests.fileSystem.nodes
        nodes["/Users/u/proj/notes.md"] = .file
        return ShellCommandContext(pathDirectories: ["/usr/bin", "/bin"], aliases: [], homeDirectory: "/Users/u",
                                   workingDirectory: "/Users/u/proj",
                                   fileSystem: ShellCommandLineTests.FakeShellFileSystem(nodes: nodes))
    }

    private func passes(_ line: String, _ source: ShellCompletionSource? = nil) -> Bool {
        shellCompletionCheckPasses(line, context: context(), source: source ?? self.source,
                                   deadline: Date().addingTimeInterval(5))
    }

    // MARK: - Parsing a capture

    func testTheReplyParses() {
        let capture = ZshCompletionCapture.parse(["K", "Hstash", "Hstatus", "Kf", "H/tmp/", "Km", "garbage", "H"])
        XCTAssertEqual(capture.hits, ["stash", "status", "/tmp/"])
        XCTAssertEqual(capture.kinds, [.files, .message])
        XCTAssertEqual(ZshCompletionCapture.parse([]), .empty)
        XCTAssertEqual(ZshCompletionCapture.parse(["K", "K"]).kinds, [], "a call with no kind flags adds none")
    }

    func testExactMatchIgnoresADirectorysTrailingSlash() {
        let capture = Self.hits(["/tmp/", "status", "../"])
        XCTAssertTrue(capture.contains("/tmp"))
        XCTAssertTrue(capture.contains("/tmp/"))
        XCTAssertTrue(capture.contains("status"))
        XCTAssertTrue(capture.contains(".."))
        XCTAssertFalse(capture.contains("stat"), "a prefix is not a match")
        XCTAssertTrue(Self.hits(["-a"]).offersOptions)
        XCTAssertFalse(Self.hits(["main"]).offersOptions)
    }

    func testTheEngineQuotingRefusesControlCharacters() {
        XCTAssertEqual(zshEngineQuoted("git status"), "$'git status'")
        XCTAssertEqual(zshEngineQuoted(#"echo 'a' \x"#), #"$'echo \'a\' \\x'"#)
        XCTAssertEqual(zshEngineQuoted("é"), #"$'\xc3\xa9'"#)
        XCTAssertNil(zshEngineQuoted("ls\nrm -rf x"), "a newline would be Return in the inner shell")
        XCTAssertNil(zshEngineQuoted("ls\t"))
        XCTAssertNil(zshEngineQuoted("ls\u{1B}"))
    }

    // MARK: - The decision

    func testWordsTheCommandTakesPass() {
        XCTAssertTrue(passes("git status"))
        XCTAssertTrue(passes("ls -la /tmp"), "a flag where options are offered, an existing path where files are")
        XCTAssertTrue(passes(#"git commit -m "fix the bug""#), "a message position takes anything")
        XCTAssertTrue(passes("open notes.md"), "a file position and an existing file")
        XCTAssertTrue(passes("make build"))
        XCTAssertTrue(passes("cd .."))
        XCTAssertTrue(passes("git status | grep x"), "every simple command is judged on its own")
    }

    func testProseThePositionsDoNotTakeFails() {
        XCTAssertFalse(passes("git is confusing"))
        XCTAssertFalse(passes("which one is better"))
        XCTAssertFalse(passes("open the file please"), "a file position, but no such file")
        XCTAssertFalse(passes("make sure the tests pass"), "not a make target")
    }

    func testAPositionTheEngineCouldNotAnswerFallsBackToTheProseGuard() {
        let down = FakeCompletionSource(captures: [:], functions: [:])
        down.unavailable = true
        XCTAssertFalse(passes("make sure the tests pass", down), "four plain words")
        XCTAssertTrue(passes("git status", down), "one plain word")
        XCTAssertTrue(passes("git is confusing", down), "two plain words — the guard is the weaker test")
        XCTAssertFalse(passes("git is it?", down), "a sentence's last character")
    }

    func testCommandsWithNoCompletionFunctionMeetTheProseGuard() {
        XCTAssertTrue(passes("echo hello world"), "two plain words")
        XCTAssertFalse(passes("echo this is a test"), "four plain words")
        XCTAssertFalse(passes("echo done."), "ends like a sentence")
        XCTAssertFalse(passes("echo hi there,"), "ends like a sentence")
        XCTAssertTrue(passes(#"echo "this is a test" -n notes.md https://x.org/a b=c /tmp"#),
                      "quoted strings, flags, existing files, URLs, assignments and paths are not plain words")
        XCTAssertTrue(passes("echo one two > /tmp/x/out.txt"), "a redirection target is not a word")
    }

    func testCompoundLinesAndExpansionsAreLeftToTheStructuralRules() {
        XCTAssertTrue(passes("(git is confusing)"))
        XCTAssertTrue(passes("if true; then echo this is a test; fi"))
        XCTAssertTrue(passes("git $SUBCOMMAND"),
                      "a line zsh may not see meets the prose guard; the expansion counts as one plain word")
        XCTAssertFalse(passes("git $a $b $c"), "three of them are prose")
    }

    func testOnlyAllowlistedCharactersAreShownToZsh() {
        for line in ["ls $(id)/", "ls `id`/", "ls $HOME/", "echo $((1+1))", "ls !!", "diff =(ls) x", "cat <(ls)",
                     "ls *(e:'id':)", "ls ${x::=1}", "rsync ';touch A B;#':", "scp 'x;mkdir STRAY':",
                     #"git commit -m "fix""#, #"ls a\ b"#, "ls a;b", "ls a&", "ls a|b", "ls >x", "ls {a,b}",
                     "ls *.md", "ls ?", "ls [ab]", "ls #x", "ls\tx", "ls é", "ls 😛"] {
            XCTAssertFalse(zshBufferIsSafe(line), line)
        }
        for line in ["git status", "ls -la ~/proj/x.md", "git checkout feature/x", "make build", "a=b c",
                     "cp x@host:/tmp/y .", "printf 100%", "git log -n 1,2 +3"] {
            XCTAssertTrue(zshBufferIsSafe(line), line)
        }
        XCTAssertFalse(zshLineMayBeShown("rsync -e touch host:"), "a remote-shell command never reaches zsh")
        XCTAssertFalse(zshLineMayBeShown("ls && scp host:/x ."))
        XCTAssertFalse(zshLineMayBeShown("/usr/bin/ssh host"))
        XCTAssertTrue(zshLineMayBeShown("git status"))
    }

    func testOnlyAllowlistedCommandsAndNeverWrappersReachZsh() {
        for line in ["nice rsync host:", "command scp host:", "env ssh host", "sudo ls", "xargs ls", "exec ls",
                     "nohup ls", "time ls", "watch ls", "nice git status", "FOO=1 env git status",
                     "/usr/bin/git status", "git status && rsync host:", "unknowncmd x"] {
            XCTAssertFalse(zshLineMayBeShown(line), line)
        }
        for line in ["git status", "FOO=1 make build", "ls -la /tmp", "cd ~/proj", "brew info x"] {
            XCTAssertTrue(zshLineMayBeShown(line), line)
        }
        XCTAssertFalse(zshLineMayBeShown("ls | grep x"), "a pipe is not an allowed character either")
        for wrapper in ["nice", "command", "env", "sudo", "xargs", "exec", "nohup", "time", "watch", "rsync", "scp", "ssh"] {
            XCTAssertFalse(shellCommandsShownToZsh.contains(wrapper), wrapper)
        }
        // A wrapped line meets the prose guard; zsh is never asked.
        let watcher = FakeCompletionSource(captures: [:], functions: ["make": true, "nice": true])
        XCTAssertFalse(passes("nice make sure the tests pass", watcher))
        XCTAssertTrue(passes("nice make build", watcher), "two plain words: the guard lets it through")
        XCTAssertEqual(watcher.asked, [], "the engine was never shown a wrapped line")
    }

    private func isWholeCommand(_ line: String) -> Bool {
        shellLineIsCommand(line, context: context()) && passes(line)
    }

    func testRepliesAreNeverCommands() {
        for reply in ["yes", "true", "wait", "continue", "say", "sure", "ok"] {
            XCTAssertFalse(isWholeCommand(reply), "\(reply) alone is a reply")
        }
        XCTAssertFalse(isWholeCommand("say thanks"))
        XCTAssertFalse(isWholeCommand("yes please"))
        XCTAssertTrue(isWholeCommand(#"say "thanks""#), "quoted text is meant for the command")
        XCTAssertTrue(isWholeCommand("echo hi"), "one plain word is fine")
        XCTAssertFalse(isWholeCommand("echo this is prose"), "three or more is prose")
        XCTAssertFalse(isWholeCommand("echo hi."), "and it ends like a sentence")
        for bare in ["ls", "pwd", "top", "make"] {
            XCTAssertTrue(isWholeCommand(bare), "\(bare) is run bare")
            XCTAssertTrue(shellBareCommandAllowlist.contains(bare))
        }
        XCTAssertTrue(isWholeCommand("./build.sh"), "a path to a program is a command alone")
    }

    func testUnquotedWordsAtAFreeTextPositionCountAsProse() {
        let source = FakeCompletionSource(captures: [
            "git commit": Self.hits(["commit"]),
            "git commit -m": Self.hits(["-m"]),
            "git commit -m fix": Self.hits([], [.message]),
            "git commit -m fix the": Self.hits([], [.message]),
            "git commit -m fix the bug": Self.hits([], [.message]),
        ], functions: ["git": true])
        XCTAssertTrue(passes("git commit -m fix", source))
        XCTAssertFalse(passes("git commit -m fix the bug", source), "three unquoted free-text words")
    }

    func testCapturedOutputKeepsTheTailWithoutCopyingIt() {
        var output = CapturedOutput(limit: 10)
        for chunk in ["abc", "defg", "hij", "klmno"] { output.append(Array(chunk.utf8)[...]) }
        XCTAssertEqual(String(decoding: output.bytes(), as: UTF8.self), "fghijklmno", "the last 10 bytes, in order")
        var small = CapturedOutput(limit: 100)
        small.append(Array("short".utf8)[...])
        XCTAssertEqual(String(decoding: small.bytes(), as: UTF8.self), "short")
    }

    func testMultibyteTextSurvivesStripping() {
        let text = "\u{1B}[1mś ě 😛\u{1B}[0m — ąę ok\u{1B}]0;title\u{07}"
        XCTAssertEqual(terminalPlainText(Array(text.utf8)), "ś ě 😛 — ąę ok",
                       "0x9B inside UTF-8 is a continuation byte, never a CSI")
    }

    func testTheProseGuardItself() {
        let exists: (ShellWord) -> Bool = { $0.text == "notes.md" }
        func words(_ list: [String], quoted: Bool = false) -> [ShellWord] { list.map { ShellWord(text: $0, wasQuoted: quoted) } }
        XCTAssertTrue(shellProseGuardRejects(lineEndsSimpleCommand: true, line: "x a b c", arguments: words(["a", "b", "c"]), pathExists: exists))
        XCTAssertFalse(shellProseGuardRejects(lineEndsSimpleCommand: true, line: "x a b", arguments: words(["a", "b"]), pathExists: exists))
        XCTAssertFalse(shellProseGuardRejects(lineEndsSimpleCommand: true, line: "x -a notes.md c", arguments: words(["-a", "notes.md", "c"]), pathExists: exists))
        XCTAssertTrue(shellProseGuardRejects(lineEndsSimpleCommand: true, line: "x a!", arguments: words(["a!"]), pathExists: exists))
        XCTAssertFalse(shellProseGuardRejects(lineEndsSimpleCommand: false, line: "x a!", arguments: words(["a"]), pathExists: exists),
                       "only the line's last command answers for how the line ends")
        XCTAssertFalse(shellProseGuardRejects(lineEndsSimpleCommand: true, line: "x 'a b c d'", arguments: words(["a b c d"], quoted: true), pathExists: exists))
    }

    // MARK: - The ghost from the same engine

    func testTheGhostCompletesFromZshForArguments() {
        let ctx = context()
        func ghost(_ line: String) -> String? {
            shellCompletion(for: line, context: ctx, commandNames: ["git", "ls"], source: source,
                            deadline: Date().addingTimeInterval(5))
        }
        XCTAssertEqual(ghost("git stat"), "us")
        XCTAssertNil(ghost("git sta"), "stash and status share nothing more")
        XCTAssertEqual(ghost("git checkout ma"), nil, "main and master share only `ma`")
        XCTAssertEqual(ghost("ls /tmp/x/no"), "tes.md", "files come from zsh too")
        XCTAssertNil(ghost("git status"), "typed in full")
        let down = FakeCompletionSource(captures: [:], functions: [:])
        down.unavailable = true
        XCTAssertEqual(shellCompletion(for: "ls /tmp/x/no", context: ctx, commandNames: [], source: down,
                                       deadline: Date().addingTimeInterval(5)), "tes.md",
                       "zsh cannot answer: the directory listing does")
    }
}

/// The real system zsh: one engine, a temp HOME and a temp working directory with a Makefile. Skipped when
/// zsh or its zpty module is unavailable. Reports the per-check latency it measures.
final class ZshCompletionIntegrationTests: XCTestCase {
    private var root: URL!
    private var engine: ZshCompletionEngine!

    override func setUpWithError() throws {
        guard FileManager.default.isExecutableFile(atPath: "/bin/zsh") else { throw XCTSkip("no /bin/zsh") }
        root = FileManager.default.temporaryDirectory.appendingPathComponent("zsh-completion-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        let home = root.appendingPathComponent("home"), work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try "build:\n\techo built\n\nclean:\n\techo cleaned\n".write(to: work.appendingPathComponent("Makefile"),
                                                                     atomically: true, encoding: .utf8)
        engine = ZshCompletionEngine(environment: [
            "HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8", "GIT_OPTIONAL_LOCKS": "0",
        ])
        guard engine.waitUntilAvailable() else { throw XCTSkip("zsh/zpty/sandbox-exec unavailable — the engine did not start") }
    }

    override func tearDownWithError() throws {
        engine = nil
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private var workDirectory: String { root.appendingPathComponent("work").path }

    private func isCommand(_ line: String) -> Bool {
        let context = ShellCommandContext(pathDirectories: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"],
                                          homeDirectory: root.appendingPathComponent("home").path,
                                          workingDirectory: workDirectory, fileSystem: LiveShellFileSystem())
        return shellLineIsCommand(line, context: context)
            && shellCompletionCheckPasses(line, context: context, source: engine,
                                          deadline: Date().addingTimeInterval(shellCompletionCheckBudget))
    }

    func testTheRealZshTellsCommandsFromProse() {
        // Warm the engine's first query (directory change, first completion function load) outside the budget.
        _ = engine.capture(buffer: "git status", directory: workDirectory, deadline: Date().addingTimeInterval(3))
        _ = engine.capture(buffer: "make b", directory: workDirectory, deadline: Date().addingTimeInterval(3))
        let cases: [(String, Bool)] = [
            ("git status", true),
            ("git is confusing", false),
            ("which one is better", false),
            ("make sure the tests pass", false),
            ("make build", true),
            ("ls -la /tmp", true),
            ("open the file please", false),
            ("cat Makefile", true),
        ]
        var timings: [String] = []
        for (line, expected) in cases {
            let started = Date()
            XCTAssertEqual(isCommand(line), expected, line)
            timings.append(String(format: "%@ %.1f ms", line, Date().timeIntervalSince(started) * 1000))
        }
        // The measurement, for the report (uncached checks; memoized repeats are near zero).
        print("[ZshCompletionIntegrationTests] per-check latency (uncached): " + timings.joined(separator: "; "))
    }

    func testAnEngineThatTimesOutIsRestartedInTheBackground() {
        XCTAssertNotNil(engine.capture(buffer: "git sta", directory: workDirectory, deadline: Date().addingTimeInterval(3)))
        // A query that cannot answer in time stops the engine.
        XCTAssertNil(engine.capture(buffer: "git stas", directory: workDirectory, deadline: Date()))
        // The next query never waits for a restart: it answers nil at once, and the restart happens off its thread.
        let started = Date()
        XCTAssertNil(engine.capture(buffer: "git stat", directory: workDirectory, deadline: Date().addingTimeInterval(3)))
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.1, "no restart on the caller's thread")
        XCTAssertTrue(engine.waitUntilAvailable(timeout: 6), "…and it comes back after its backoff")
        XCTAssertNotNil(engine.capture(buffer: "git stat", directory: workDirectory, deadline: Date().addingTimeInterval(3)))
    }

    /// The reviewer's cases: typing them must never run their `$(…)`. Each is put through the engine (refused),
    /// the full validator and the ghost — and then, bypassing the refusal, through the SANDBOXED engine — and no
    /// file may appear.
    func testTypedSubstitutionsNeverRunWhileBeingChecked() throws {
        let cases = ["ls $(touch pw1)/", "cd $(touch pw2)/", "ls ~$(touch pw3)/", "echo $(($(touch pw4)))/",
                     "ls ${x::=$(touch pw5)}/", "cat $(touch pw6)/x",
                     // The re-review's: `_rsync`/`_scp` build `ssh … <host>` and eval it.
                     "rsync ';touch A B;#':", "scp 'x;mkdir STRAY':"]
        let home = root.appendingPathComponent("home").path
        let context = ShellCommandContext(pathDirectories: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"], homeDirectory: home,
                                          workingDirectory: workDirectory, fileSystem: LiveShellFileSystem())
        let environment = CommandLineEnvironment.fixed(pathDirectories: context.pathDirectories, commandNames: ["ls", "cat"],
                                                       homeDirectory: home, fileSystem: LiveShellFileSystem(),
                                                       completion: engine)
        // Anywhere: the working directory, HOME, and the engine's own (writable) private folder.
        let planted: Set<String> = ["pw1", "pw2", "pw3", "pw4", "pw5", "pw6", "A", "B", "STRAY"]
        func created() -> [String] {
            var found = ((try? FileManager.default.contentsOfDirectory(atPath: workDirectory)) ?? []).filter { $0 != "Makefile" }
                + ((try? FileManager.default.contentsOfDirectory(atPath: home)) ?? [])
            let enumerator = FileManager.default.enumerator(atPath: engine.privateDirectory)
            while let path = enumerator?.nextObject() as? String {
                if planted.contains((path as NSString).lastPathComponent) { found.append("private/" + path) }
            }
            return found
        }
        for line in cases {
            XCTAssertFalse(zshBufferIsSafe(line), line)
            XCTAssertNil(engine.capture(buffer: line, directory: workDirectory, deadline: Date().addingTimeInterval(2)),
                         "the engine refuses \(line)")
            _ = shellLineIsCommand(line, context: context)
            _ = shellCompletionCheckPasses(line, context: context, source: engine, deadline: Date().addingTimeInterval(2))
            _ = shellCompletion(for: line, context: context, commandNames: ["ls"], source: engine,
                                deadline: Date().addingTimeInterval(2))
            _ = DispatchPillCommandMode.evaluate(line, environment: environment, workingDirectory: workDirectory)
            XCTAssertEqual(created(), [], "checking \(line) created a file")
        }
        // Defense in depth: even shown to zsh, the sandbox denies the write.
        for line in cases {
            _ = engine.captureBypassingSafetyForTesting(buffer: line, directory: workDirectory,
                                                        deadline: Date().addingTimeInterval(3))
            XCTAssertEqual(created(), [], "the sandboxed engine let \(line) write a file")
        }
    }

    /// The engine's sandbox, on its own: no write outside its private folder.
    func testTheSandboxProfileDeniesWritesOutsideThePrivateFolder() throws {
        let profile = zshCompletionSandboxProfile(privateDirectory: engine.privateDirectory, terminal: "/dev/ttys999")
        func touch(_ path: String) -> Int32 {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            process.arguments = ["-p", profile, "/usr/bin/touch", path]
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
            return process.terminationStatus
        }
        let outside = (workDirectory as NSString).appendingPathComponent("outside.txt")
        XCTAssertNotEqual(touch(outside), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside))
        let inside = (engine.privateDirectory as NSString).appendingPathComponent("inside.txt")
        XCTAssertEqual(touch(inside), 0, "the private folder stays writable")
    }

    /// The completing shell may write only its OWN terminal: from inside a sandbox naming one fresh pty, a write to
    /// another fresh pty is denied (and nothing arrives there) — no real terminal is touched.
    func testTheSandboxWritesOnlyItsOwnTerminal() throws {
        func freshPty() throws -> (master: Int32, slave: Int32, name: String) {
            var master: Int32 = -1, slave: Int32 = -1
            var name = [CChar](repeating: 0, count: 128)
            guard openpty(&master, &slave, &name, nil, nil) == 0 else { throw XCTSkip("no pty available") }
            return (master, slave, String(cString: name))
        }
        let own = try freshPty(), other = try freshPty()
        defer { [own.master, own.slave, other.master, other.slave].forEach { close($0) } }
        let profile = zshCompletionSandboxProfile(privateDirectory: engine.privateDirectory, terminal: own.name)
        func inside(_ command: String) -> Int32 {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            process.arguments = ["-p", profile, "/bin/zsh", "-f", "-c", command]
            process.environment = ["PATH": "/usr/bin:/bin"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
            return process.terminationStatus
        }
        XCTAssertNotEqual(inside("print -n probe > \(other.name)"), 0, "another terminal is not writable")
        var poller = pollfd(fd: other.master, events: Int16(POLLIN), revents: 0)
        XCTAssertEqual(poll(&poller, 1, 200), 0, "nothing reached the other terminal")
        XCTAssertEqual(inside("print -n probe > \(own.name)"), 0, "its own terminal is")
    }

    /// From INSIDE the engine's sandbox (a zsh under the same profile, as injected code would be): no signal to
    /// another of the user's processes, no pasteboard, no Apple Events, no LaunchServices. Harmless probes —
    /// and `pbcopy` is refused before it can write: neither pasteboard's change count may move.
    func testTheSandboxDeniesSignalsPasteboardAppleEventsAndLaunchServices() throws {
        let profile = zshCompletionSandboxProfile(privateDirectory: engine.privateDirectory, terminal: "/dev/ttys999")
        let bystander = Process()
        bystander.executableURL = URL(fileURLWithPath: "/bin/sleep")
        bystander.arguments = ["30"]
        try bystander.run()
        defer { bystander.terminate() }
        func inside(_ command: String) -> Int32 {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            process.arguments = ["-p", profile, "/bin/zsh", "-f", "-c", command]
            process.environment = ["PATH": "/usr/bin:/bin", "HOME": root.appendingPathComponent("home").path,
                                   "TMPDIR": engine.privateDirectory]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
            return process.terminationStatus
        }
        XCTAssertNotEqual(inside("kill -0 \(bystander.processIdentifier)"), 0, "signalling another process")
        XCTAssertTrue(bystander.isRunning)
        XCTAssertEqual(inside("kill -0 $$"), 0, "…while its own processes stay reachable (the probe works)")
        let general = NSPasteboard.general.changeCount
        let ruler = NSPasteboard(name: .ruler).changeCount
        XCTAssertNotEqual(inside("print -n probe | pbcopy -pboard ruler"), 0, "pbcopy")
        XCTAssertEqual(NSPasteboard.general.changeCount, general, "the clipboard was not touched")
        XCTAssertEqual(NSPasteboard(name: .ruler).changeCount, ruler)
        XCTAssertNotEqual(inside("osascript -e 1"), 0, "osascript")
        XCTAssertNotEqual(inside("open -g /tmp"), 0, "open (LaunchServices)")
    }
}

/// The engine's breaker, on a "zsh" that never answers: after a few failures it stops trying for a while, and a
/// query never waits.
final class ZshCompletionEngineBreakerTests: XCTestCase {
    func testRepeatedFailuresOpenTheBreaker() {
        let engine = ZshCompletionEngine(zshPath: "/usr/bin/false", environment: ["HOME": NSTemporaryDirectory()],
                                         backoffBase: 0.01)
        XCTAssertFalse(engine.waitUntilAvailable(timeout: 1.5))
        XCTAssertTrue(engine.breakerIsOpenForTesting, "three failures in a row: prose guard only for a while")
        let started = Date()
        XCTAssertNil(engine.capture(buffer: "git sta", directory: "/tmp", deadline: Date().addingTimeInterval(2)))
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.05, "an open breaker answers at once")
    }
}
