import AppKit
import XCTest
@testable import Winter

/// The Dispatch pill's command mode and terminal, the PURE pieces: the shell tokenizer, the "is this a command"
/// validator, the ghost completion, the Delete opt-out state machine, ANSI stripping and capping, the
/// transcript message, the login-shell probe's parsing and the run's invocation. Everything runs against a
/// synthetic filesystem and PATH (`FakeShellFileSystem`) — no test touches the real disk's layout or runs a
/// shell.
final class ShellCommandLineTests: XCTestCase {
    // MARK: - A synthetic machine

    /// A dictionary filesystem: every path is a directory, an executable or a plain file.
    struct FakeShellFileSystem: ShellFileSystem {
        enum Kind { case directory, executable, file }
        var nodes: [String: Kind]

        func exists(_ path: String) -> Bool { nodes[normalized(path)] != nil }
        func isDirectory(_ path: String) -> Bool { nodes[normalized(path)] == .directory }
        func isExecutableFile(_ path: String) -> Bool { nodes[normalized(path)] == .executable }
        func entries(ofDirectory path: String) -> [String]? {
            let dir = normalized(path)
            guard nodes[dir] == .directory else { return nil }
            let prefix = dir == "/" ? "/" : dir + "/"
            return nodes.keys.filter { $0.hasPrefix(prefix) && $0 != dir && !$0.dropFirst(prefix.count).contains("/") }
                .map { String($0.dropFirst(prefix.count)) }.sorted()
        }

        /// Collapses `.`/`..` components and trailing slashes, as the kernel would.
        private func normalized(_ path: String) -> String {
            var parts: [Substring] = []
            for component in path.split(separator: "/") {
                if component == "." { continue }
                if component == ".." { _ = parts.popLast(); continue }
                parts.append(component)
            }
            return "/" + parts.joined(separator: "/")
        }
    }

    static let fileSystem = FakeShellFileSystem(nodes: [
        "/": .directory,
        "/usr": .directory, "/usr/bin": .directory, "/bin": .directory,
        "/usr/bin/ls": .executable, "/usr/bin/open": .executable, "/usr/bin/make": .executable,
        "/usr/bin/grep": .executable, "/usr/bin/git": .executable, "/usr/bin/gitk": .executable,
        "/usr/bin/README": .file,
        "/bin/cat": .executable, "/bin/sleep": .executable,
        "/usr/bin/yes": .executable, "/usr/bin/say": .executable, "/usr/bin/top": .executable, "/usr/bin/true": .executable,
        "/tmp": .directory, "/tmp/x": .directory, "/tmp/x/notes.md": .file, "/tmp/x/My Files": .directory,
        "/tmp/x/a.log": .file, "/tmp/x/b.log": .file,
        "/Users": .directory, "/Users/u": .directory, "/Users/u/proj": .directory,
        "/Users/u/proj/build.sh": .executable, "/Users/u/proj/src": .directory, "/Users/u/proj/.hidden": .file,
    ])

    private func context(aliases: Set<String> = [], cwd: String = "/Users/u/proj") -> ShellCommandContext {
        ShellCommandContext(pathDirectories: ["/usr/bin", "/bin"], aliases: aliases, homeDirectory: "/Users/u",
                            workingDirectory: cwd, fileSystem: Self.fileSystem)
    }

    private func isCommand(_ line: String, aliases: Set<String> = []) -> Bool {
        shellLineIsCommand(line, context: context(aliases: aliases))
    }

    // MARK: - Tokenizer

    func testTokenizerSplitsWordsAndRemovesQuotes() {
        guard case .complete(let tokens) = shellTokenize(#"echo 'a b' "c d" e\ f"#) else { return XCTFail("incomplete") }
        XCTAssertEqual(tokens.compactMap { if case .word(let w) = $0 { return w.text } else { return nil } },
                       ["echo", "a b", "c d", "e f"])
        if case .word(let quoted) = tokens[1] { XCTAssertTrue(quoted.wasQuoted) }
        if case .word(let plain) = tokens[0] { XCTAssertFalse(plain.wasQuoted) }
    }

    func testTokenizerReportsEveryIncompleteShape() {
        XCTAssertEqual(shellTokenize("echo 'abc"), .incomplete(.unbalancedQuote))
        XCTAssertEqual(shellTokenize(#"echo "abc"#), .incomplete(.unbalancedQuote))
        XCTAssertEqual(shellTokenize(#"echo abc\"#), .incomplete(.danglingEscape))
        XCTAssertEqual(shellTokenize("echo $(date"), .incomplete(.unbalancedSubstitution))
        XCTAssertEqual(shellTokenize("echo `date"), .incomplete(.unbalancedSubstitution))
        XCTAssertEqual(shellTokenize("(ls"), .incomplete(.unbalancedParenthesis))
        XCTAssertEqual(shellTokenize("ls)"), .incomplete(.unbalancedParenthesis))
    }

    func testTokenizerReadsOperatorsRedirectionsAndComments() {
        guard case .complete(let tokens) = shellTokenize("ls|wc -l && echo ok 2>&1 # trailing note") else {
            return XCTFail("incomplete")
        }
        let ops = tokens.compactMap { if case .op(let op) = $0 { return op } else { return nil } }
        XCTAssertEqual(ops, ["|", "&&", "2>&"])
        XCTAssertFalse(tokens.contains(.word(ShellWord(text: "note"))), "a comment runs to the end of the line")
    }

    func testTokenizerKeepsSubstitutionsInsideOneWord() {
        guard case .complete(let tokens) = shellTokenize(#"echo "$(date +%s) done" $HOME"#) else { return XCTFail() }
        XCTAssertEqual(tokens.count, 3)
        if case .word(let w) = tokens[1] {
            XCTAssertEqual(w.text, "$(date +%s) done")
            XCTAssertTrue(w.hasExpansion)
        }
    }

    // MARK: - Validator

    func testCommandsThatValidate() {
        for line in [
            "ls", "ls -la /tmp", "open /tmp/x/notes.md", "cd ~/proj", "cd ~", "export FOO=bar",
            "echo 'hello world'", "ls | grep foo", "./build.sh", "./build.sh --fast", "FOO=1 make",
            "time make", "make &", "ls; make", "ls && make || echo failed",
            "for f in /tmp/x/*.log; do echo $f; done", "if [ -d /tmp ]; then echo yes; fi",
            "while true; do sleep 1; done", "[[ -d /tmp ]] && echo yes", "{ ls; make; }",
            "ls > /tmp/x/new-file.txt", "cat < /tmp/x/notes.md", "ls 2>&1 | grep x",
            #"open "/tmp/x/notes.md""#, "ls /tmp/x/My\\ Files", "(cd /tmp && ls)", "ls ../proj", "ls # look",
            "git status", "ls\nmake",
        ] {
            XCTAssertTrue(isCommand(line), "should be a command: \(line)")
        }
    }

    func testLinesThatAreNotCommands() {
        for line in [
            "", "   ", "\n",
            // A half-typed or missing path is not a command — the spec's own example.
            "open /tmp/x/notes.m", "open /tmp/y", "cd ~/nowhere", "ls ./missing", "cat < /tmp/missing",
            // Unknown first words, plain prose.
            "hello there", "Please summarise this", "time to go", "README", "/permissions", "https://example.com/x",
            // Incomplete lines.
            "echo 'unbalanced", "ls |", "ls &&", "| grep x", "ls && && make", "ls ; ; make", "make >",
            "if true; then echo yes", "for i in 1 2", "while true; do sleep 1",
            // Nothing to run, or nothing knowable.
            "FOO=bar", "$EDITOR /tmp", #"open "~/proj""#,
        ] {
            XCTAssertFalse(isCommand(line), "should NOT be a command: \(line.debugDescription)")
        }
    }

    func testBuiltinsKeywordsAndAliases() {
        XCTAssertTrue(isCommand("cd /tmp"), "a builtin")
        XCTAssertTrue(isCommand("export PATH=/tmp"), "a builtin with an assignment argument")
        XCTAssertTrue(isCommand("source ~/proj/build.sh"))
        XCTAssertFalse(isCommand("ll"), "an alias the shell does not define")
        XCTAssertTrue(isCommand("ll", aliases: ["ll"]), "an alias it does")
        XCTAssertTrue(isCommand("ll /tmp", aliases: ["ll"]))
        XCTAssertFalse(isCommand("ll /nope", aliases: ["ll"]), "an alias still needs its paths to exist")
    }

    func testRelativePathsResolveAgainstTheWorkingDirectory() {
        XCTAssertTrue(shellLineIsCommand("ls ./src", context: context(cwd: "/Users/u/proj")))
        XCTAssertFalse(shellLineIsCommand("ls ./src", context: context(cwd: "/tmp")))
        XCTAssertTrue(shellLineIsCommand("ls ../x", context: context(cwd: "/tmp/x")))
    }

    // MARK: - Ghost completion

    private let names = ["git", "gitk", "grep", "ls", "make", "open", "export"]

    private func ghost(_ line: String) -> String? {
        shellCompletion(for: line, context: context(), commandNames: names)
    }

    func testTheFirstWordCompletesToTheCommonPrefixOfExecutables() {
        XCTAssertEqual(ghost("gr"), "ep")
        XCTAssertEqual(ghost("op"), "en")
        XCTAssertEqual(ghost("ex"), "port")
        XCTAssertNil(ghost("g"), "one character is too little to guess from")
        XCTAssertEqual(ghost("gi"), "t", "git and gitk share `git`")
        XCTAssertNil(ghost("git"), "typed in full: no ghost even though gitk extends it")
        XCTAssertNil(ghost("Gr"), "case-sensitive: a sentence's capitalised first word never ghosts")
        XCTAssertNil(ghost("xyz"))
    }

    func testPathArgumentsCompleteFromTheirDirectory() {
        XCTAssertEqual(ghost("open /tmp/x/no"), "tes.md")
        XCTAssertEqual(ghost("cd ~/pr"), "oj/", "a single directory gains its slash")
        XCTAssertEqual(ghost("ls /tm"), "p/")
        XCTAssertEqual(ghost("ls ./s"), "rc/")
        XCTAssertEqual(ghost("ls /tmp/x/My"), #"\ Files/"#, "shell-special characters are escaped")
        XCTAssertEqual(ghost("ls /tmp/x/"), nil, "several entries with no common prefix: nothing to add")
        XCTAssertEqual(ghost("cat /tmp/x/a"), ".log")
        XCTAssertEqual(ghost("ls ./."), "hidden", "hidden entries once a `.` asks for them")
        XCTAssertEqual(ghost("ls ./.h"), "idden")
        XCTAssertEqual(ghost("ls /tmp/"), "x/", "a lone entry completes in full")
        XCTAssertEqual(ghost("ls ./b"), "uild.sh", "a lone file completes without a slash")
        XCTAssertEqual(ghost("cd ~"), "/")
    }

    func testCompletionOnlyWhileTheLineIsPlausiblyACommand() {
        XCTAssertNil(ghost("hello /tmp/x/no"), "the first word does not resolve")
        XCTAssertNil(ghost("ls "), "nothing being typed")
        XCTAssertNil(ghost("echo 'ab /tmp/x/no"), "inside an open quote")
        XCTAssertNil(ghost("ls -l"), "an option is not completed")
        XCTAssertNil(shellCompletion(for: "gr", context: context(), commandNames: []), "no names known yet")
    }

    // MARK: - Delete to opt out

    func testDeleteOptsOutOfCommandModeForThatExactText() {
        var s = CommandModeSuppression()
        // Command mode ON: Delete at the end with nothing selected deletes nothing and records the text.
        XCTAssertTrue(s.isCommandMode(text: "ls /tmp", isValid: true))
        XCTAssertTrue(s.deleteBackward(text: "ls /tmp", isValid: true, caretAtEnd: true, hasSelection: false))
        XCTAssertEqual(s.suppressedText, "ls /tmp")
        XCTAssertFalse(s.isCommandMode(text: "ls /tmp", isValid: true), "that exact text is a message now")
        // The next Delete deletes normally.
        XCTAssertFalse(s.deleteBackward(text: "ls /tmp", isValid: true, caretAtEnd: true, hasSelection: false))
        XCTAssertEqual(s.suppressedText, "ls /tmp")
    }

    func testCommandModeResumesWhenTheTextDiffersAndIsValidAgain() {
        var s = CommandModeSuppression()
        _ = s.deleteBackward(text: "ls /tmp", isValid: true, caretAtEnd: true, hasSelection: false)
        // Typing more valid command.
        XCTAssertTrue(s.isCommandMode(text: "ls /tmp/x", isValid: true))
        // Deleting a bit (invalid on the way) and retyping something valid.
        XCTAssertFalse(s.isCommandMode(text: "ls /tm", isValid: false), "different but not valid: still off")
        XCTAssertTrue(s.isCommandMode(text: "ls /tmp/x/", isValid: true))
        // Back to the recorded text exactly: off again.
        XCTAssertFalse(s.isCommandMode(text: "ls /tmp", isValid: true))
        // A new opt-out moves the record.
        XCTAssertTrue(s.deleteBackward(text: "ls /tmp/x", isValid: true, caretAtEnd: true, hasSelection: false))
        XCTAssertEqual(s.suppressedText, "ls /tmp/x")
        XCTAssertTrue(s.isCommandMode(text: "ls /tmp", isValid: true), "the old record is gone")
    }

    func testDeleteIsOrdinaryWhenNotAtTheEndOrWithASelectionOrNotACommand() {
        var s = CommandModeSuppression()
        XCTAssertFalse(s.deleteBackward(text: "ls /tmp", isValid: true, caretAtEnd: false, hasSelection: false))
        XCTAssertFalse(s.deleteBackward(text: "ls /tmp", isValid: true, caretAtEnd: true, hasSelection: true))
        XCTAssertFalse(s.deleteBackward(text: "hello", isValid: false, caretAtEnd: true, hasSelection: false))
        XCTAssertNil(s.suppressedText)
    }

    func testResetClearsTheRecord() {
        var s = CommandModeSuppression()
        _ = s.deleteBackward(text: "make", isValid: true, caretAtEnd: true, hasSelection: false)
        s.reset()
        XCTAssertNil(s.suppressedText)
        XCTAssertTrue(s.isCommandMode(text: "make", isValid: true))
    }

    // MARK: - ANSI stripping and capping

    func testStripsEscapeSequencesAndResolvesCarriageReturns() {
        func plain(_ s: String) -> String { terminalPlainText(Array(s.utf8)) }
        XCTAssertEqual(plain("\u{1B}[1;31mred\u{1B}[0m plain"), "red plain")
        XCTAssertEqual(plain("\u{1B}]0;window title\u{07}hello"), "hello", "OSC to BEL")
        XCTAssertEqual(plain("\u{1B}]8;;https://x\u{1B}\\link\u{1B}]8;;\u{1B}\\"), "link", "OSC to ST")
        XCTAssertEqual(plain("\u{1B}(Bok\u{1B}=\u{1B}7"), "ok", "charset and one-byte escapes")
        XCTAssertEqual(plain("a\r\nb\r\n"), "a\nb")
        XCTAssertEqual(plain("10%\r50%\r100%\ndone"), "100%\ndone", "a progress line keeps its last state")
        XCTAssertEqual(plain("abc\u{08}d"), "abd")
        XCTAssertEqual(plain("bell\u{07} \t tab"), "bell \t tab")
        XCTAssertEqual(plain("trailing   \n\n\n"), "trailing")
        XCTAssertEqual(plain("\u{1B}[?1049h\u{1B}[2J\u{1B}[Hscreen"), "screen")
    }

    func testCappingKeepsTheTailAndSaysWhatWasOmitted() {
        let lines = (1...500).map { "line \($0)" }.joined(separator: "\n")
        let capped = terminalCappedOutput(lines)
        let out = capped.components(separatedBy: "\n")
        XCTAssertEqual(out.first, "… 100 earlier lines omitted")
        XCTAssertEqual(out.count, 401)
        XCTAssertEqual(out.last, "line 500")

        let wide = (1...10).map { _ in String(repeating: "x", count: 5000) }.joined(separator: "\n")
        let cappedWide = terminalCappedOutput(wide)
        XCTAssertTrue(cappedWide.hasPrefix("… 5 earlier lines omitted\n"))
        XCTAssertLessThanOrEqual(cappedWide.count, TerminalTranscriptLimits.maxCharacters + 40)

        XCTAssertEqual(terminalCappedOutput("short\noutput"), "short\noutput")
        XCTAssertEqual(terminalCappedOutput(""), "")
        let oneHugeLine = String(repeating: "y", count: 40_000)
        XCTAssertTrue(terminalCappedOutput(oneHugeLine).hasPrefix("… earlier output omitted\n"))
    }

    // MARK: - The transcript message

    func testTheTranscriptMessageFormat() {
        let message = terminalTranscriptMessage(command: "ls /tmp", workingDirectory: "/Users/u/proj", home: "/Users/u",
                                                outcome: .exited(0), output: "a\nb")
        XCTAssertEqual(message, "I ran this in my terminal in ~/proj (exit 0):\n```\n$ ls /tmp\na\nb\n```")
        let failed = terminalTranscriptMessage(command: "make", workingDirectory: "/tmp", home: "/Users/u",
                                               outcome: .exited(2), output: "")
        XCTAssertEqual(failed, "I ran this in my terminal in /tmp (exit 2):\n```\n$ make\n```")
        XCTAssertTrue(terminalTranscriptMessage(command: "top", workingDirectory: "/Users/u", home: "/Users/u",
                                                outcome: .running, output: "").hasPrefix("I ran this in my terminal in ~ (still running):"))
        XCTAssertTrue(terminalTranscriptMessage(command: "x", workingDirectory: "/tmp", home: "/Users/u",
                                                outcome: .signaled(15), output: "").contains("(stopped by signal 15)"))
    }

    func testTheFenceOutgrowsBackticksInTheOutput() {
        let message = terminalTranscriptMessage(command: "cat README.md", workingDirectory: "/tmp", home: "/Users/u",
                                                outcome: .exited(0), output: "```swift\nlet x = 1\n```")
        XCTAssertTrue(message.contains("\n````\n$ cat README.md\n"))
        XCTAssertTrue(message.hasSuffix("\n````"))
    }

    func testWaitStatusesDecode() {
        XCTAssertEqual(commandRunOutcome(waitStatus: 0), .exited(0))
        XCTAssertEqual(commandRunOutcome(waitStatus: 1 << 8), .exited(1))
        XCTAssertEqual(commandRunOutcome(waitStatus: 127 << 8), .exited(127))
        XCTAssertEqual(commandRunOutcome(waitStatus: 9), .signaled(9))
        XCTAssertEqual(commandRunOutcome(waitStatus: 15), .signaled(15))
        XCTAssertEqual(CommandPillStatus(.running), .running)
        XCTAssertEqual(CommandPillStatus(.exited(0)), .succeeded)
        XCTAssertEqual(CommandPillStatus(.exited(1)), .failed)
        XCTAssertEqual(CommandPillStatus(.signaled(9)), .failed)
        XCTAssertEqual(CommandPillStatus(.running, waiting: true), .waiting, "a line not started yet is never 'failed'")
        XCTAssertEqual(CommandPillStatus(.typedByHand), .handedOver)
    }

    func testDisplayPathsAbbreviateHome() {
        XCTAssertEqual(terminalDisplayPath("/Users/u", home: "/Users/u"), "~")
        XCTAssertEqual(terminalDisplayPath("/Users/u/proj", home: "/Users/u"), "~/proj")
        XCTAssertEqual(terminalDisplayPath("/Users/uu/proj", home: "/Users/u"), "/Users/uu/proj")
        XCTAssertEqual(terminalDisplayPath("/tmp", home: "/Users/u"), "/tmp")
    }

    // MARK: - The login shell

    func testTheShellChoiceFallsBackToZsh() {
        XCTAssertEqual(loginShellPath(accountShell: "/opt/homebrew/bin/bash", environmentShell: "/bin/zsh"),
                       "/opt/homebrew/bin/bash", "the account record wins")
        XCTAssertEqual(loginShellPath(accountShell: nil, environmentShell: "/bin/bash"), "/bin/bash")
        XCTAssertEqual(loginShellPath(accountShell: "/usr/bin/false", environmentShell: nil), "/bin/zsh")
        XCTAssertEqual(loginShellPath(accountShell: "zsh", environmentShell: "nu"), "/bin/zsh")
    }

    func testTheProbeOutputParses() {
        let out = "motd banner\n\(loginShellPathStart)/opt/homebrew/bin:/usr/bin:/bin:/usr/bin\(loginShellPathEnd)"
            + "\(loginShellAliasesStart)\nll\ngst\n\(loginShellAliasesEnd)"
        let parsed = loginShellParseProbe(out)
        XCTAssertEqual(parsed?.path, ["/opt/homebrew/bin", "/usr/bin", "/bin"], "de-duplicated, in order")
        XCTAssertEqual(parsed?.aliases, ["ll", "gst"])
        XCTAssertNil(loginShellParseProbe("no markers at all"))
        XCTAssertNil(loginShellParseProbe("\(loginShellPathStart)\(loginShellPathEnd)"), "an empty PATH is no PATH")
    }

    func testARunIsAnInteractiveLoginShellThatReadsTheLineFromAPrivateFileNeverTheEnvironment() {
        let line = #"echo "it's"; rm -rf "$HOME/x" `whoami`"#
        let zsh = loginShellSessionInvocation(shell: "/opt/homebrew/bin/zsh", line: line, shimDirectory: "/tmp/shim",
                                              nonce: "abc123")
        // The fd-closing trampoline first, then the user's own shell — interactive, login.
        XCTAssertEqual(zsh.executable, "/bin/zsh")
        XCTAssertEqual(Array(zsh.arguments.prefix(5)), ["-f", "-c", loginShellRunTrampoline, "winter-run", "/opt/homebrew/bin/zsh"])
        XCTAssertTrue(loginShellRunTrampoline.contains("<3->"), "every descriptor above 2 is closed")
        XCTAssertEqual(Array(zsh.arguments.dropFirst(5)), ["-l", "-i"])
        XCTAssertEqual(zsh.environment, ["ZDOTDIR": "/tmp/shim"], "the startup shim — and no variable carries the line")
        XCTAssertEqual(zsh.files[loginShellLineFile], line, "the line travels in its own file, verbatim")
        XCTAssertEqual(Set(zsh.files.keys), [".zshenv", ".zprofile", ".zshrc", ".zlogin", "run", loginShellLineFile,
                                             loginShellZshAutosuggestFile])
        XCTAssertNil(loginShellSessionInvocation(shell: "/bin/zsh", line: "", shimDirectory: "/tmp/shim", nonce: "n")
            .files[loginShellLineFile], "a terminal with no line has no line file")
        for (name, contents) in zsh.files where name != loginShellLineFile {
            XCTAssertFalse(contents.contains("whoami"), "\(name): the line is never spliced into a script")
        }
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            XCTAssertTrue(zsh.files[name]!.contains("builtin source ${ZDOTDIR:-$HOME}/\(name)"), "\(name) sources the user's own")
        }
        XCTAssertFalse(zsh.arguments.contains { $0.contains("whoami") })
        XCTAssertTrue(zsh.files[".zshenv"]!.contains("command rm -f -- $__winter_shim/\(loginShellLineFile)"),
                      "read and deleted as the shell starts")
        let zlogin = zsh.files[".zlogin"]!
        XCTAssertTrue(zlogin.contains("add-zle-hook-widget line-init __winter_run_line"), "typed in at the first prompt")
        XCTAssertTrue(zlogin.contains("histchars=''"), "with history expansion off for it")
        XCTAssertTrue(zlogin.contains("133;C;winter-abc123") && zlogin.contains("133;D;%d;winter-abc123"), "marks carry the tag")
        XCTAssertTrue(zsh.files["run"]!.contains(#"eval "$__winter_line""#), "the fallback evals: no history expansion")

        let bash = loginShellSessionInvocation(shell: "/bin/bash", line: line, shimDirectory: "/tmp/shim", nonce: "n")
        XCTAssertEqual(Array(bash.arguments.dropFirst(5)), ["--rcfile", "/tmp/shim/bashrc", "-i"])
        XCTAssertEqual(bash.environment, [:])
        XCTAssertTrue(bash.files["bashrc"]!.contains(".bash_profile"), "what a login shell reads")
        XCTAssertTrue(bash.files["bashrc"]!.hasSuffix("builtin source '/tmp/shim/run'\n"))

        let sh = loginShellSessionInvocation(shell: "/bin/sh", line: "ls", shimDirectory: "/tmp/shim", nonce: "n")
        XCTAssertEqual(sh.environment, ["ENV": "/tmp/shim/env.sh"])

        let fish = loginShellSessionInvocation(shell: "/opt/homebrew/bin/fish", line: "ls", shimDirectory: "/tmp/shim", nonce: "n")
        XCTAssertEqual(Array(fish.arguments.dropFirst(4)),
                       ["/opt/homebrew/bin/fish", "-l", "-i", "--init-command", "source '/tmp/shim/run.fish'"])
        XCTAssertEqual(fish.environment, [:])
        XCTAssertEqual(loginShellSingleQuoted("a'b"), #"'a'\''b'"#)
        XCTAssertNotEqual(loginShellRunNonce(), loginShellRunNonce())
    }

    func testTheRunEnvironmentIsTheLoginShellsNotTheApps() {
        let env = loginShellEnvironment(from: ["WINTER_HOME": "/tmp/w", "PATH": "/app/only", "SSH_AUTH_SOCK": "/tmp/agent",
                                               "LANG": "fr_FR.UTF-8"],
                                        home: "/Users/u", user: "u", shell: "/bin/zsh")
        XCTAssertNil(env["WINTER_HOME"], "Winter's own variables never reach the user's shell")
        XCTAssertEqual(env["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin", "the login profile builds the real PATH")
        XCTAssertEqual(env["SSH_AUTH_SOCK"], "/tmp/agent")
        XCTAssertEqual(env["HOME"], "/Users/u")
        XCTAssertEqual(env["SHELL"], "/bin/zsh")
        XCTAssertEqual(env["TERM"], "xterm-256color")
        XCTAssertEqual(env["LANG"], "fr_FR.UTF-8")
    }
}

/// The command-mode model the pill reads, on a synthetic shell: the debounced verdict, the sticky display,
/// the ghost, and Delete's opt-out end to end.
@MainActor
final class DispatchPillCommandModeTests: XCTestCase {
    private func makeMode() -> DispatchPillCommandMode {
        let environment = CommandLineEnvironment.fixed(pathDirectories: ["/usr/bin", "/bin"],
                                                       commandNames: ["ls", "make", "open", "grep"],
                                                       homeDirectory: "/Users/u",
                                                       fileSystem: ShellCommandLineTests.fileSystem)
        return DispatchPillCommandMode(environment: environment, workingDirectory: { "/Users/u/proj" })
    }

    func testTheInertEnvironmentNeverMakesACommand() {
        let mode = DispatchPillCommandMode(environment: .inert, workingDirectory: { "/tmp" })
        mode.evaluateNowForTesting("ls /tmp")
        XCTAssertFalse(mode.isActive(for: "ls /tmp"))
        XCTAssertFalse(mode.shouldRunOnReturn("ls"))
        XCTAssertNil(mode.ghost(for: "ls /tmp"))
    }

    func testAValidLineIsActiveAndAHalfTypedPathIsNot() {
        let mode = makeMode()
        mode.evaluateNowForTesting("open /tmp/x/notes.m")
        XCTAssertFalse(mode.isActive(for: "open /tmp/x/notes.m"))
        XCTAssertEqual(mode.ghost(for: "open /tmp/x/notes.m"), "d", "the path completes")
        mode.evaluateNowForTesting("open /tmp/x/notes.md")
        XCTAssertTrue(mode.isActive(for: "open /tmp/x/notes.md"))
        XCTAssertTrue(mode.displaysCommand("open /tmp/x/notes.md"))
        XCTAssertNil(mode.ghost(for: "open /tmp/x/notes.m"), "a ghost belongs to the text it was computed for")
    }

    func testTheDisplayIsStickyUntilTheNextVerdictLands() {
        let mode = makeMode()
        mode.evaluateNowForTesting("ls /tmp")
        XCTAssertTrue(mode.displaysCommand("ls /tmp/"), "not judged yet: the last verdict stands (no flicker)")
        mode.evaluateNowForTesting("hello")
        XCTAssertFalse(mode.displaysCommand("hello there"), "…both ways")
    }

    func testReturnNeverUpgradesAndNeverTouchesTheFilesystem() {
        var nodes = ShellCommandLineTests.fileSystem.nodes
        let fileSystem = MutableFileSystem(nodes: nodes)
        let environment = CommandLineEnvironment.fixed(pathDirectories: ["/usr/bin"], commandNames: ["open"],
                                                       homeDirectory: "/Users/u", fileSystem: fileSystem)
        let mode = DispatchPillCommandMode(environment: environment, workingDirectory: { "/tmp" })
        // White (no file yet), then the file appears: Return still sends — it never upgrades to a run.
        mode.evaluateNowForTesting("open /tmp/later.md")
        nodes["/tmp/later.md"] = .file
        fileSystem.nodes = nodes
        XCTAssertFalse(mode.shouldRunOnReturn("open /tmp/later.md"), "white text never runs")
        // Purple: Return runs on the shown verdict alone — no stat on the main thread.
        mode.evaluateNowForTesting("open /tmp/later.md")
        let asked = fileSystem.questions
        XCTAssertTrue(mode.shouldRunOnReturn("open /tmp/later.md"))
        XCTAssertEqual(fileSystem.questions, asked, "Return asked the filesystem nothing")
    }

    func testReturnAndDeleteActOnlyOnAFreshVerdictForTheExactText() {
        let mode = makeMode()
        XCTAssertFalse(mode.shouldRunOnReturn("ls /tmp"), "no verdict shown yet (typed within the debounce)")
        XCTAssertFalse(mode.deleteBackward(text: "ls /tmp", caretAtEnd: true, hasSelection: false))
        mode.evaluateNowForTesting("ls /tmp")
        XCTAssertTrue(mode.displaysCommand("ls /tmp/"), "the purple is still showing from the last keystroke…")
        XCTAssertFalse(mode.shouldRunOnReturn("ls /tmp/"), "…but it is stale: Return sends")
        XCTAssertFalse(mode.deleteBackward(text: "ls /tmp/", caretAtEnd: true, hasSelection: false),
                       "…and Delete deletes")
        XCTAssertTrue(mode.shouldRunOnReturn("ls /tmp"))
    }

    /// A filesystem a test can change between two questions.
    private final class MutableFileSystem: ShellFileSystem {
        var nodes: [String: ShellCommandLineTests.FakeShellFileSystem.Kind]
        private(set) var questions = 0
        init(nodes: [String: ShellCommandLineTests.FakeShellFileSystem.Kind]) { self.nodes = nodes }
        private var fake: ShellCommandLineTests.FakeShellFileSystem { questions += 1; return .init(nodes: nodes) }
        func exists(_ path: String) -> Bool { fake.exists(path) }
        func isDirectory(_ path: String) -> Bool { fake.isDirectory(path) }
        func isExecutableFile(_ path: String) -> Bool { fake.isExecutableFile(path) }
        func entries(ofDirectory path: String) -> [String]? { fake.entries(ofDirectory: path) }
    }

    func testTheGhostStaysStableBetweenVerdictsAndTrimsOnMatchingKeystrokes() {
        XCTAssertEqual(commandGhostContinuation(evaluatedText: "open /tmp/x/no", ghost: "tes.md", text: "open /tmp/x/not"), "es.md")
        XCTAssertEqual(commandGhostContinuation(evaluatedText: "open /tmp/x/no", ghost: "tes.md", text: "open /tmp/x/n"), "otes.md")
        XCTAssertNil(commandGhostContinuation(evaluatedText: "open /tmp/x/no", ghost: "tes.md", text: "open /tmp/x/noq"))
        XCTAssertNil(commandGhostContinuation(evaluatedText: "open /tmp/x/no", ghost: "tes.md", text: "open /tmp/x/notes.md"),
                     "typed to its end: nothing left")

        let mode = makeMode()
        mode.evaluateNowForTesting("open /tmp/x/no")
        var published = 0
        let watch = mode.$ghost.dropFirst().sink { _ in published += 1 }
        // Typing the ghost's own next characters: trimmed at once, never blank, before any verdict lands…
        var shown: [String?] = []
        var draft = "open /tmp/x/no"
        for c in "tes.m" {
            draft.append(c)
            shown.append(mode.ghost(for: draft))
            mode.evaluateNowForTesting(draft) // …and the verdict that lands says the same
            shown.append(mode.ghost(for: draft))
        }
        XCTAssertEqual(shown, ["es.md", "es.md", "s.md", "s.md", ".md", ".md", "md", "md", "d", "d"])
        // The same result recomputed: the ghost state does not change.
        let before = published
        mode.evaluateNowForTesting(draft)
        mode.evaluateNowForTesting(draft)
        XCTAssertEqual(published, before, "a same-result recompute never touches the ghost")
        watch.cancel()
    }

    func testTheDebouncedPathPublishesTheVerdict() {
        let mode = makeMode()
        mode.draftChanged("ls /tmp")
        let landed = expectation(description: "verdict")
        let watch = mode.$evaluatedValid.dropFirst().sink { if $0 { landed.fulfill() } }
        wait(for: [landed], timeout: 2)
        watch.cancel()
        XCTAssertTrue(mode.isActive(for: "ls /tmp"))
    }

    func testDeleteAtTheEndOptsOutThenDeletesNormally() {
        let mode = makeMode()
        mode.evaluateNowForTesting("make")
        XCTAssertTrue(mode.deleteBackward(text: "make", caretAtEnd: true, hasSelection: false), "consumed")
        XCTAssertFalse(mode.isActive(for: "make"))
        XCTAssertFalse(mode.displaysCommand("make"))
        XCTAssertFalse(mode.shouldRunOnReturn("make"), "Return sends it as a message now")
        XCTAssertFalse(mode.deleteBackward(text: "make", caretAtEnd: true, hasSelection: false), "the next Delete deletes")
        mode.evaluateNowForTesting("make ")
        XCTAssertTrue(mode.isActive(for: "make "), "different and valid: command mode is back")
        mode.reset()
        mode.evaluateNowForTesting("make")
        XCTAssertTrue(mode.isActive(for: "make"), "a run or send clears the record")
    }
}

/// Command mode inside the real pill controller: Return runs a command (never sends it), a message still
/// sends, Delete's opt-out turns a command back into a message, and a run's pill, outcome and transcript
/// message. Runs are built WITHOUT a process (`CommandRunStore.launchesProcesses = false`).
@MainActor
final class DispatchPillCommandRunTests: XCTestCase {
    private var suites: [String] = []

    override func tearDown() async throws {
        suites.forEach { UserDefaults().removePersistentDomain(forName: $0) }
        suites.removeAll()
        try await super.tearDown()
    }

    private func makePill() -> (DispatchPillController, () -> [String]) {
        let suite = "WinterTests.DispatchPillCommand.\(UUID().uuidString)"
        suites.append(suite)
        let environment = CommandLineEnvironment.fixed(pathDirectories: ["/usr/bin", "/bin"],
                                                       commandNames: ["ls", "make", "open"],
                                                       homeDirectory: "/Users/u",
                                                       fileSystem: ShellCommandLineTests.fileSystem)
        let pill = DispatchPillController(session: SessionModel(),
                                          settings: DispatchPillSettings(defaults: UserDefaults(suiteName: suite)!),
                                          commandEnvironment: environment)
        pill.commandRuns.launchesProcesses = false
        var sent: [String] = []
        pill.onSubmit = { text in sent.append(text); return true }
        return (pill, { sent })
    }

    func testReturnRunsACommandInsteadOfSendingIt() async {
        let (pill, sent) = makePill()
        pill.commandWorkingDirectory = { "/tmp" }
        pill.adapter.composerDraft = "ls /tmp"
        pill.commandMode.evaluateNowForTesting("ls /tmp") // shown purple
        pill.submit("ls /tmp")
        XCTAssertEqual(pill.commandRuns.runs.count, 1)
        XCTAssertEqual(pill.commandRuns.runs.first?.command, "ls /tmp")
        XCTAssertEqual(pill.commandRuns.runs.first?.workingDirectory, "/tmp", "the session's directory when it has one")
        XCTAssertEqual(pill.adapter.composerDraft, "", "the composer clears")
        await Task.yield()
        XCTAssertEqual(sent(), [], "a command is never sent to Dispatch")
    }

    func testReturnBeforeAnyVerdictSendsAMessage() async {
        let (pill, sent) = makePill()
        pill.adapter.composerDraft = "ls /tmp"
        pill.submit("ls /tmp") // within the debounce: it was never shown purple
        for _ in 0..<20 where sent().isEmpty { await Task.yield() }
        XCTAssertEqual(sent(), ["ls /tmp"])
        XCTAssertTrue(pill.commandRuns.runs.isEmpty, "Return never turns white text into a run")
    }

    func testAddToTranscriptGoesToTheRunsOwnSessionOnly() async {
        let (pill, sent) = makePill()
        var focused = "session-a"
        pill.currentSessionId = { focused }
        var delivered: [(String, String)] = []
        var alive: Set<String> = ["session-a", "session-b"]
        pill.commandRuns.onSendToTranscript = { sessionId, text in
            guard alive.contains(sessionId) else { return false }
            delivered.append((sessionId, text))
            return true
        }
        pill.commandRuns.sessionIsGone = { !alive.contains($0) }
        pill.adapter.composerDraft = "ls /tmp"
        pill.commandMode.evaluateNowForTesting("ls /tmp")
        pill.submit("ls /tmp")
        guard let run = pill.commandRuns.runs.first else { return XCTFail("no run") }
        XCTAssertEqual(run.sessionId, "session-a", "recorded at RUN time")
        focused = "session-b"
        XCTAssertFalse(pill.commandRuns.canAddToTranscript(run), "no output yet")
        XCTAssertEqual(pill.commandRuns.transcriptUnavailableReason(run), "Nothing to add yet — the terminal has no output")
        run.feedForTesting(Array("x\r\n".utf8))
        XCTAssertTrue(pill.commandRuns.canAddToTranscript(run))
        let ok = await pill.commandRuns.addToTranscript(run)
        XCTAssertTrue(ok)
        XCTAssertEqual(delivered.map(\.0), ["session-a"], "never the focused session")
        XCTAssertEqual(sent(), [], "and never the composer's send-or-create path")
        alive.remove("session-a")
        XCTAssertTrue(pill.commandRuns.canAddToTranscript(run), "missing from a list is never taken as deleted")
        let refused = await pill.commandRuns.addToTranscript(run)
        XCTAssertFalse(refused, "the send failed…")
        XCTAssertFalse(pill.commandRuns.canAddToTranscript(run), "…and a re-list proved it deleted: the button disables")
        XCTAssertEqual(pill.commandRuns.transcriptUnavailableReason(run),
                       "The Dispatch session this terminal belongs to has been deleted")
        XCTAssertEqual(delivered.count, 1)

        let orphan = pill.commandRuns.start(command: "ls", workingDirectory: "/tmp",
                                            environment: pill.commandMode.environment, sessionId: nil)
        XCTAssertEqual(pill.commandRuns.transcriptTarget(orphan), .currentConversation)
        orphan.feedForTesting(Array("x\r\n".utf8))
        XCTAssertTrue(pill.commandRuns.canAddToTranscript(orphan), "no session at run time: the current conversation")
        let viaComposer = await pill.commandRuns.addToTranscript(orphan)
        XCTAssertTrue(viaComposer)
        XCTAssertEqual(sent().count, 1, "through the pill's own send — which creates the conversation if need be")
        XCTAssertTrue(sent().first?.hasPrefix("I ran this in my terminal in /tmp") == true)
        XCTAssertEqual(delivered.count, 1, "never a session's own send")
        // The first click's conversation is pinned: a later click goes there, whatever is focused then.
        XCTAssertEqual(orphan.pinnedSessionId, "session-b")
        focused = "session-c"
        let again = await pill.commandRuns.addToTranscript(orphan)
        XCTAssertTrue(again)
        XCTAssertEqual(delivered.map(\.0), ["session-a", "session-b"])
        XCTAssertEqual(sent().count, 1)
    }

    func testATerminalWithOutputCanAddItsSessionTail() async {
        let (pill, _) = makePill()
        pill.commandRuns.presentsWindows = false
        pill.currentSessionId = { "dispatch-1" } // a session the app's list may well not show (yet)
        var delivered: [(String, String)] = []
        pill.commandRuns.onSendToTranscript = { sessionId, text in delivered.append((sessionId, text)); return true }
        pill.commandRuns.sessionIsGone = { _ in true } // never asked: nothing failed
        pill.adapter.composerDraft = "/terminal"
        pill.submit("/terminal")
        guard let run = pill.commandRuns.runs.first, run.isTerminal else { return XCTFail("no terminal") }
        XCTAssertEqual(pill.commandRuns.transcriptUnavailableReason(run), "Nothing to add yet — the terminal has no output")
        run.feedForTesting(Array("% open --help\r\nUsage: open [-e] files\r\n% ".utf8))
        XCTAssertNil(pill.commandRuns.transcriptUnavailableReason(run))
        XCTAssertTrue(pill.commandRuns.canAddToTranscript(run), "a terminal with output: enabled")
        let ok = await pill.commandRuns.addToTranscript(run)
        XCTAssertTrue(ok)
        XCTAssertEqual(delivered.first?.0, "dispatch-1")
        XCTAssertEqual(delivered.first?.1, "This is from my terminal in ~:\n```\n% open --help\nUsage: open [-e] files\n%\n```",
                       "its session tail")
    }

    func testTheTranscriptTargetRule() {
        XCTAssertEqual(commandTranscriptTarget(recordedSessionId: "s1", recordedSessionExists: { _ in true }),
                       .recordedSession("s1"))
        XCTAssertEqual(commandTranscriptTarget(recordedSessionId: "s1", recordedSessionExists: { _ in false }),
                       .unavailable, "only a recorded session that is gone disables the button")
        XCTAssertEqual(commandTranscriptTarget(recordedSessionId: nil, recordedSessionExists: { _ in false }),
                       .currentConversation)
    }

    func testAMessageStillSends() async {
        let (pill, sent) = makePill()
        pill.adapter.composerDraft = "please list /tmp"
        pill.submit("please list /tmp")
        for _ in 0..<20 where sent().isEmpty { await Task.yield() }
        XCTAssertEqual(sent(), ["please list /tmp"])
        XCTAssertTrue(pill.commandRuns.runs.isEmpty)
    }

    func testTheOptOutSendsTheCommandAsAMessage() async {
        let (pill, sent) = makePill()
        pill.adapter.composerDraft = "make"
        XCTAssertFalse(pill.handleDeleteBackwardAtEnd(), "not shown as a command yet: an ordinary delete")
        pill.commandMode.evaluateNowForTesting("make")
        XCTAssertTrue(pill.handleDeleteBackwardAtEnd(), "Delete at the end opts out instead of deleting")
        pill.submit("make")
        for _ in 0..<20 where sent().isEmpty { await Task.yield() }
        XCTAssertEqual(sent(), ["make"])
        XCTAssertTrue(pill.commandRuns.runs.isEmpty)
    }

    func testAMissingWorkingDirectoryFallsBackToHome() {
        let (pill, _) = makePill()
        pill.commandWorkingDirectory = { nil }
        XCTAssertEqual(pill.commandDirectory(), "/Users/u")
        pill.commandWorkingDirectory = { "/definitely/not/here" }
        XCTAssertEqual(pill.commandDirectory(), "/Users/u")
    }

    func testARunsOutcomeAndItsTranscriptMessage() {
        let (pill, _) = makePill()
        pill.commandWorkingDirectory = { "/tmp" }
        pill.adapter.composerDraft = "ls /tmp"
        pill.commandMode.evaluateNowForTesting("ls /tmp")
        pill.submit("ls /tmp")
        guard let run = pill.commandRuns.runs.first else { return XCTFail("no run") }
        XCTAssertEqual(run.outcome, .running)
        run.feedForTesting(Array("\u{1B}[1mx\u{1B}[0m\r\nnotes.md\r\n".utf8))
        run.finishForTesting(waitStatus: 0)
        XCTAssertEqual(run.outcome, .exited(0))
        XCTAssertEqual(run.transcriptMessage(), "I ran this in my terminal in /tmp (exit 0):\n```\n$ ls /tmp\nx\nnotes.md\n```")
        // A finished run's × lets it go.
        pill.commandRuns.dismiss(run.id)
        XCTAssertTrue(pill.commandRuns.runs.isEmpty)
    }

    func testARunningRunCannotBeDismissedAndOldFinishedOnesArePruned() {
        let (pill, _) = makePill()
        let store = pill.commandRuns
        let environment = pill.commandMode.environment
        let first = store.start(command: "make", workingDirectory: "/tmp", environment: environment)
        store.dismiss(first.id)
        XCTAssertEqual(store.runs.count, 1, "still running: it stays")
        first.finishForTesting(waitStatus: 0)
        for i in 0..<CommandRunStore.maxRuns {
            store.start(command: "ls \(i)", workingDirectory: "/tmp", environment: environment)
        }
        XCTAssertEqual(store.runs.count, CommandRunStore.maxRuns, "the oldest finished run made room")
        XCTAssertFalse(store.runs.contains { $0.id == first.id })
    }
}

/// The composer's two command-mode hooks on the real text view: Tab inserts the ghost, Delete at the end asks
/// first — and both are AppKit's own when unwired or out of place.
@MainActor
final class ComposerCommandHooksTests: XCTestCase {
    private func makeTextView(_ text: String) -> CommandTextView {
        let view = CommandTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
        view.string = text
        view.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        return view
    }

    func testTabInsertsTheGhostAtTheEndAndOnlyThere() {
        let view = makeTextView("open /tmp/x/no")
        view.ghostSuffix = "tes.md"
        view.doCommand(by: #selector(NSResponder.insertTab(_:)))
        XCTAssertEqual(view.string, "open /tmp/x/notes.md")

        let middle = makeTextView("ls /tm")
        middle.ghostSuffix = "p/"
        middle.setSelectedRange(NSRange(location: 2, length: 0))
        middle.doCommand(by: #selector(NSResponder.insertTab(_:)))
        XCTAssertFalse(middle.string.contains("p/"), "a caret away from the end never takes the ghost")

        let none = makeTextView("ls")
        none.doCommand(by: #selector(NSResponder.insertTab(_:)))
        XCTAssertEqual(none.string, "ls\t", "no ghost: Tab is AppKit's")
    }

    func testDeleteAtTheEndAsksFirst() {
        let view = makeTextView("make")
        var asked = 0
        view.onDeleteBackwardAtEnd = { asked += 1; return true }
        view.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        XCTAssertEqual(view.string, "make", "consumed: nothing deleted")
        XCTAssertEqual(asked, 1)

        view.onDeleteBackwardAtEnd = { false }
        view.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        XCTAssertEqual(view.string, "mak", "declined: an ordinary delete")

        view.onDeleteBackwardAtEnd = { XCTFail("not asked away from the end"); return true }
        view.setSelectedRange(NSRange(location: 1, length: 0))
        view.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        XCTAssertEqual(view.string, "ak")
        view.setSelectedRange(NSRange(location: 0, length: 2))
        view.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        XCTAssertEqual(view.string, "", "a selection deletes as ever")
    }
}

/// The terminal window's emulator is laid out inside the terminal's padding on every resize — never left at
/// zero size.
@MainActor
final class TerminalPaddingViewTests: XCTestCase {
    func testTheEmulatorFillsThePaddedArea() {
        let container = TerminalPaddingView(frame: NSRect(x: 0, y: 0, width: 600, height: 300))
        let terminal = NSView()
        container.terminal = terminal
        container.addSubview(terminal)
        container.needsLayout = true
        container.layoutSubtreeIfNeeded()
        let p = TerminalStyle.padding
        XCTAssertEqual(terminal.frame, NSRect(x: p.left, y: p.bottom, width: 600 - p.left - p.right,
                                              height: 300 - p.top - p.bottom))
        container.setFrameSize(NSSize(width: 800, height: 500))
        XCTAssertEqual(terminal.frame.width, 800 - p.left - p.right, "a resize re-lays it out")
    }
}
