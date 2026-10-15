import Foundation

// The Dispatch pill's COMMAND MODE, the pure half: is what the user typed a shell line they mean to run?
//
// There is no prefix. The composer's whole text is a command only when ALL of these hold:
//   1. it tokenizes as a complete shell line — balanced quotes and substitutions, no trailing operator, no
//      dangling continuation, every compound opener (`if`, `for`, `{`, `[[` …) closed;
//   2. the first word of every simple command resolves: an executable on the user's login-shell PATH, a
//      path to an executable, a shell builtin or keyword, or an alias;
//   3. every argument that LOOKS like a path (starts with `/`, `~`, `./`, `../`) exists.
// So `open /tmp/x/notes.md` turns into a command only once the file exists — a half-typed path is not one.
//
// Everything here is pure: the filesystem, the PATH, the home and working directories are handed in
// (`ShellCommandContext`), so `ShellCommandLineTests` runs it against a synthetic tree. Nothing here imports
// SwiftTerm or AppKit.

// MARK: - The filesystem seam

/// What the validator and the completer may ask the filesystem. The live one (`LiveShellFileSystem`) is
/// stat calls; the tests hand in a dictionary.
protocol ShellFileSystem {
    /// Anything at `path` — a file, a directory, a symlink that resolves.
    func exists(_ path: String) -> Bool
    /// A directory at `path`.
    func isDirectory(_ path: String) -> Bool
    /// A regular file the user may execute at `path`.
    func isExecutableFile(_ path: String) -> Bool
    /// The names in the directory at `path`, or nil when it cannot be read.
    func entries(ofDirectory path: String) -> [String]?
}

/// The real filesystem: `FileManager`'s stat-backed checks. Cheap per call; the caller runs it off the main
/// thread and memoizes the verdict (`DispatchPillCommandMode`).
struct LiveShellFileSystem: ShellFileSystem {
    func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

    func isDirectory(_ path: String) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
    }

    func isExecutableFile(_ path: String) -> Bool {
        !isDirectory(path) && FileManager.default.isExecutableFile(atPath: path)
    }

    func entries(ofDirectory path: String) -> [String]? {
        try? FileManager.default.contentsOfDirectory(atPath: path)
    }
}

// MARK: - The context

/// Everything outside the text that decides whether it is a command.
struct ShellCommandContext {
    /// The login shell's PATH, in order.
    var pathDirectories: [String]
    /// Alias names the login shell defines (optional — empty when unknown).
    var aliases: Set<String> = []
    /// `~` expands to this.
    var homeDirectory: String
    /// Where the line would run — `./` and `../` resolve against it.
    var workingDirectory: String
    var fileSystem: ShellFileSystem
}

// MARK: - Tokens

/// One shell word after quote removal, with what the quoting said about it.
struct ShellWord: Equatable {
    /// The word as the shell would see it (quotes removed, escapes resolved). Substitutions are kept verbatim.
    var text: String
    /// The word began with an UNQUOTED `~` (only that one is expanded by the shell).
    var leadingTildeUnquoted: Bool
    /// The word holds an unquoted glob character (`*`, `?`, `[`).
    var hasUnquotedGlob: Bool
    /// Any part of the word was quoted or escaped — never an assignment or a reserved word then.
    var wasQuoted: Bool
    /// The word holds a `$`/backtick expansion — its value is unknown until run time.
    var hasExpansion: Bool
    /// Where the word sits in the line as typed, in characters: `line.prefix(end)` is the line up to and including
    /// it — what the completion engine is asked about.
    var start: Int
    var end: Int

    init(text: String, leadingTildeUnquoted: Bool = false, hasUnquotedGlob: Bool = false,
         wasQuoted: Bool = false, hasExpansion: Bool = false, start: Int = 0, end: Int = 0) {
        self.text = text
        self.leadingTildeUnquoted = leadingTildeUnquoted
        self.hasUnquotedGlob = hasUnquotedGlob
        self.wasQuoted = wasQuoted
        self.hasExpansion = hasExpansion
        self.start = start
        self.end = end
    }
}

enum ShellToken: Equatable {
    case word(ShellWord)
    /// A control or redirection operator (`|`, `&&`, `;`, `>`, `2>`, `(` …), or a line break (`"\n"`).
    case op(String)
}

/// Why a line does not tokenize as a complete shell line.
enum ShellIncompleteReason: Equatable {
    case unbalancedQuote
    case unbalancedSubstitution
    case danglingEscape
    case unbalancedParenthesis
}

enum ShellTokenization: Equatable {
    case complete([ShellToken])
    case incomplete(ShellIncompleteReason)
}

/// Operators a line can never END on: the shell would wait for more.
let shellContinuationOperators: Set<String> = ["|", "||", "&&", "|&"]
/// Redirections: the word after one is its target, never an argument or a command.
let shellRedirectionOperators: Set<String> = [">", ">>", "<", "<<", "<<<", ">&", "<&", "&>", "&>>", ">|", "<>"]
/// Operators that end one simple command and start the next.
let shellCommandSeparators: Set<String> = ["|", "||", "&&", "|&", "&", ";", ";;", "\n", "(", ")"]

/// PURE: split `line` into shell words and operators, or say why it is not a complete line.
func shellTokenize(_ line: String) -> ShellTokenization {
    let chars = Array(line)
    var tokens: [ShellToken] = []
    var i = 0
    var parenDepth = 0

    var current = ""
    var inWord = false
    var tildeUnquoted = false
    var glob = false
    var quoted = false
    var expansion = false
    var wordStart = 0

    func flushWord() {
        guard inWord else { return }
        tokens.append(.word(ShellWord(text: current, leadingTildeUnquoted: tildeUnquoted, hasUnquotedGlob: glob,
                                      wasQuoted: quoted, hasExpansion: expansion, start: wordStart, end: i)))
        current = ""
        inWord = false
        tildeUnquoted = false
        glob = false
        quoted = false
        expansion = false
    }

    func startWord() {
        if !inWord {
            inWord = true
            wordStart = i
        }
    }

    while i < chars.count {
        let c = chars[i]
        switch c {
        case " ", "\t":
            flushWord()
            i += 1
        case "\n":
            flushWord()
            tokens.append(.op("\n"))
            i += 1
        case "\\":
            guard i + 1 < chars.count else { return .incomplete(.danglingEscape) }
            if chars[i + 1] == "\n" { i += 2; continue } // a line continuation joins the lines
            startWord()
            quoted = true
            current.append(chars[i + 1])
            i += 2
        case "'":
            startWord()
            quoted = true
            guard let close = chars[(i + 1)...].firstIndex(of: "'") else { return .incomplete(.unbalancedQuote) }
            current.append(contentsOf: chars[(i + 1)..<close])
            i = close + 1
        case "\"":
            startWord()
            quoted = true
            var j = i + 1
            var closed = false
            while j < chars.count {
                let d = chars[j]
                if d == "\\", j + 1 < chars.count {
                    let next = chars[j + 1]
                    if ["\"", "\\", "$", "`", "\n"].contains(next) {
                        if next != "\n" { current.append(next) }
                    } else {
                        current.append(d)
                        current.append(next)
                    }
                    j += 2
                    continue
                }
                if d == "\"" { closed = true; break }
                if d == "$" || d == "`" {
                    guard let end = shellSkipExpansion(chars, from: j) else { return .incomplete(.unbalancedSubstitution) }
                    expansion = true
                    current.append(contentsOf: chars[j..<end])
                    j = end
                    continue
                }
                current.append(d)
                j += 1
            }
            guard closed else { return .incomplete(.unbalancedQuote) }
            i = j + 1
        case "$", "`":
            startWord()
            guard let end = shellSkipExpansion(chars, from: i) else { return .incomplete(.unbalancedSubstitution) }
            expansion = true
            current.append(contentsOf: chars[i..<end])
            i = end
        case "#" where !inWord:
            // A comment runs to the end of the line.
            while i < chars.count, chars[i] != "\n" { i += 1 }
        case "|", "&", ";", "<", ">", "(", ")":
            // A word of digits right before a redirection is its file descriptor (`2>`), part of the operator.
            var prefix = ""
            if (c == "<" || c == ">"), inWord, !quoted, !expansion, !current.isEmpty, current.allSatisfy(\.isNumber) {
                prefix = current
                current = ""
                inWord = false
            } else {
                flushWord()
            }
            let op = shellOperator(chars, at: i)
            if op == "(" { parenDepth += 1 }
            if op == ")" {
                parenDepth -= 1
                if parenDepth < 0 { return .incomplete(.unbalancedParenthesis) }
            }
            tokens.append(.op(prefix.isEmpty ? op : prefix + op))
            i += op.count
        default:
            if !inWord, c == "~" { tildeUnquoted = true }
            startWord()
            if c == "*" || c == "?" || c == "[" { glob = true }
            current.append(c)
            i += 1
        }
    }
    flushWord()
    if parenDepth != 0 { return .incomplete(.unbalancedParenthesis) }
    return .complete(tokens)
}

/// The longest operator at `i`.
private func shellOperator(_ chars: [Character], at i: Int) -> String {
    let candidates = ["&>>", "<<<", ";;", "||", "&&", "|&", ">>", "<<", ">&", "<&", "&>", ">|", "<>"]
    for candidate in candidates {
        let op = Array(candidate)
        if i + op.count <= chars.count, Array(chars[i..<(i + op.count)]) == op { return candidate }
    }
    return String(chars[i])
}

/// The index just past the `$…`/backtick expansion starting at `i` (`$(…)`, `$((…))`, `${…}`, `` `…` ``,
/// `$name`, or a lone `$`), or nil when it never closes.
private func shellSkipExpansion(_ chars: [Character], from i: Int) -> Int? {
    if chars[i] == "`" {
        var j = i + 1
        while j < chars.count {
            if chars[j] == "\\" { j += 2; continue }
            if chars[j] == "`" { return j + 1 }
            j += 1
        }
        return nil
    }
    // chars[i] == "$"
    guard i + 1 < chars.count else { return i + 1 }
    let next = chars[i + 1]
    if next == "(" || next == "{" {
        let open = next, close: Character = next == "(" ? ")" : "}"
        var depth = 0
        var j = i + 1
        while j < chars.count {
            let d = chars[j]
            switch d {
            case "\\": j += 2; continue
            case "'":
                guard let end = chars[(j + 1)...].firstIndex(of: "'") else { return nil }
                j = end + 1; continue
            case "\"":
                var k = j + 1
                var closed = false
                while k < chars.count {
                    if chars[k] == "\\" { k += 2; continue }
                    if chars[k] == "\"" { closed = true; break }
                    k += 1
                }
                guard closed else { return nil }
                j = k + 1; continue
            case open: depth += 1
            case close:
                depth -= 1
                if depth == 0 { return j + 1 }
            default: break
            }
            j += 1
        }
        return nil
    }
    // `$name`, `$1`, `$?` … — the name runs while it is a name.
    var j = i + 1
    if next.isLetter || next == "_" {
        while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" { j += 1 }
        return j
    }
    return i + 2
}

// MARK: - Shell vocabulary

/// Builtins that are commands in their own right (most also exist on PATH; the rest only in the shell).
let shellBuiltins: Set<String> = [
    ".", ":", "[", "alias", "autoload", "bg", "bindkey", "break", "builtin", "cd", "chdir", "command", "compdef",
    "continue", "declare", "dirs", "disown", "echo", "emulate", "enable", "eval", "exec", "exit", "export",
    "false", "fc", "fg", "functions", "getopts", "hash", "history", "jobs", "kill", "let", "local", "logout",
    "popd", "print", "printf", "pushd", "pwd", "read", "readonly", "rehash", "return", "set", "setopt", "shift",
    "source", "suspend", "test", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias",
    "unfunction", "unhash", "unset", "unsetopt", "wait", "whence", "where", "which", "zmodload", "zstyle",
]

/// Reserved words that PREFIX a command: the word after them must itself be a command (`time make`, `! grep`).
private let shellPrecommandWords: Set<String> = ["time", "!", "noglob", "nocorrect"]
/// Reserved words that sit in a command position and hand the rest of the simple command on as a command.
private let shellCommandIntroducers: Set<String> = ["if", "then", "else", "elif", "do", "while", "until", "{"]
/// Openers whose remaining words are NOT a command (a loop variable and a list, a case word, a test).
private let shellListOpeners: Set<String> = ["for", "select", "case", "foreach", "repeat", "[[", "function"]
/// Words that close a compound command, alone in their command position.
private let shellClosers: Set<String> = ["fi", "done", "esac", "}", "]]", "end"]
/// Reserved words, all told — what the completer offers alongside builtins.
let shellReservedWords: Set<String> = shellPrecommandWords.union(shellCommandIntroducers).union(shellListOpeners)
    .union(shellClosers).union(["in"])

/// Each opener and the closer that must follow it for the line to be complete.
private let shellCompoundPairs: [(openers: Set<String>, closer: String)] = [
    (["if"], "fi"),
    (["do"], "done"),
    (["case"], "esac"),
    (["{"], "}"),
    (["[["], "]]"),
]

// MARK: - Words that are commands only sometimes (one place — `ShellCommandLineTests`)

/// A LONE word — no arguments — is a command only when it is one people run bare. Everything else typed alone
/// (`yes`, `true`, `wait`, `continue`, `say`, `sure`, `ok` …) is a reply, never a run.
let shellBareCommandAllowlist: Set<String> = [
    "ls", "l", "la", "ll", "pwd", "top", "htop", "btop", "clear", "reset", "date", "cal", "uptime", "whoami", "who",
    "w", "id", "groups", "df", "du", "ps", "history", "jobs", "env", "printenv", "hostname", "uname", "ifconfig",
    "vim", "vi", "nvim", "nano", "emacs", "micro", "hx", "python", "python3", "ipython", "node", "bun", "deno", "irb",
    "ghci", "lua", "sqlite3", "psql", "make", "ninja", "tmux", "screen", "zsh", "bash", "fish", "lazygit", "tig",
    "ranger", "nnn", "k9s", "caffeinate",
]

/// Commands whose arguments are FREE TEXT, and how many unquoted plain words there make the line prose rather
/// than a command. `say thanks` and `yes please` are replies (one is enough); `echo hi` runs, `echo this is it`
/// is prose. Quoted text never counts: `say "thanks"` runs.
let shellFreeTextCommands: [String: Int] = [
    "say": 1, "yes": 1, "true": 1, "false": 1, "wait": 1, "continue": 1, "break": 1,
    "echo": 3, "printf": 3, "print": 3,
]

/// How many unquoted words at a free-text position of a command WITH a completion function (`git commit -m`'s
/// message, unquoted) make the line prose.
let shellFreeTextPositionLimit = 3

/// The only characters a line may hold to be shown to zsh's completion system — an ALLOWLIST: letters, digits,
/// space and `. _ / : @ % + , = - ~`. Completion functions EVALUATE parts of the line (`_path_files` expands the
/// word under the cursor; `_rsync`/`_scp` build an `ssh … <host>` command and `eval` it, so a quoted host splices
/// commands), so any quote, backslash, `; & | < > { } * ? [ ] # $`, backtick, `! ( )`, tab or non-ASCII
/// character keeps the line away from zsh — the prose guard decides it instead.
let zshEngineAllowedCharacters: Set<Character> = Set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._/:@%+,=-~")

/// PURE: may `text` be shown to zsh's completion system (`zshEngineAllowedCharacters`)?
func zshBufferIsSafe(_ text: String) -> Bool {
    text.allSatisfy { zshEngineAllowedCharacters.contains($0) }
}

/// The ONLY commands whose completion may reach the engine — local tools whose completion functions list
/// subcommands, targets, branches, files, processes. A line is shown to zsh only when the FIRST word (after
/// assignments) of every simple command in it is one of these, exactly as typed: never a path to one, and never
/// a wrapper (`nice`, `command`, `env`, `sudo`, `xargs`, `exec`, `nohup`, `time`, `watch` — each would hand its
/// own arguments to another command's completion, `nice rsync …` to `_rsync`'s remote shell). Everything else
/// meets the prose guard.
let shellCommandsShownToZsh: Set<String> = [
    "git", "make", "ls", "cd", "open", "cat", "less", "more", "head", "tail", "cp", "mv", "rm", "mkdir", "rmdir",
    "touch", "ln", "code", "vim", "vi", "nvim", "nano", "grep", "rg", "find", "fd", "npm", "npx", "bun", "yarn",
    "pnpm", "brew", "swift", "xcodebuild", "xcrun", "python3", "pip3", "node", "deno", "cargo", "go", "kill",
    "killall", "ps", "du", "df", "tar", "zip", "unzip", "gzip", "gunzip", "chmod", "chown", "diff", "wc", "sort",
    "uniq", "file", "stat", "which", "man", "say", "echo", "printf", "pwd", "tree", "bat", "jq", "docker", "gh",
]

/// PURE: may this line, as tokenized, be shown to zsh? Its characters (`zshBufferIsSafe`) and its commands
/// (`shellCommandsShownToZsh`).
func zshLineMayBeShown(_ line: String) -> Bool {
    guard zshBufferIsSafe(line), case .complete(let tokens) = shellTokenize(line) else { return false }
    var commandPosition = true
    for token in tokens {
        switch token {
        case .op(let op):
            if shellCommandSeparators.contains(op) { commandPosition = true }
        case .word(let word):
            guard commandPosition else { continue }
            if shellIsAssignment(word.text) { continue }
            guard shellCommandsShownToZsh.contains(word.text) else { return false }
            commandPosition = false
        }
    }
    return true
}

// MARK: - The validator

/// PURE: is `line` a shell line the user means to run? See this file's header for the three rules.
func shellLineIsCommand(_ line: String, context: ShellCommandContext) -> Bool {
    guard line.count <= 4000, !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    guard case .complete(let tokens) = shellTokenize(line), !tokens.isEmpty else { return false }

    // A lone word is a command only if people run it bare (or it is a path to one).
    if tokens.count == 1, case .word(let only) = tokens[0], !only.text.contains("/"),
       !shellBareCommandAllowlist.contains(only.text) {
        return false
    }

    // No trailing continuation or dangling redirection — the shell would wait for more.
    if let last = tokens.last(where: { $0 != .op("\n") }), case .op(let op) = last,
       shellContinuationOperators.contains(op) || shellIsRedirection(op) {
        return false
    }

    // Split into simple commands, keeping the separator on each side of every one.
    var commands: [[ShellToken]] = [[]]
    var separators: [String] = []
    for token in tokens {
        if case .op(let op) = token, shellCommandSeparators.contains(op) {
            commands.append([])
            separators.append(op)
        } else {
            commands[commands.count - 1].append(token)
        }
    }
    // An empty command (`ls && && x`, `| grep`, `ls ; ; ls`) is not a line — except beside a parenthesis or a
    // line break, and the empty end after a trailing `;` or `&`.
    let loose: Set<String> = ["(", ")", "\n"]
    for (index, command) in commands.enumerated() where command.isEmpty {
        let before = index > 0 ? separators[index - 1] : nil
        let after = index < separators.count ? separators[index] : nil
        if let before, loose.contains(before) { continue }
        if let after, loose.contains(after) { continue }
        if after == nil, before == ";" || before == "&" { continue }
        if before == nil, after == nil { continue }
        return false
    }

    // Compound commands must be closed: count the reserved words standing in a command position.
    var heads: [String] = []
    var sawCommand = false
    for command in commands where !command.isEmpty {
        guard let result = shellValidateSimpleCommand(command, context: context, heads: &heads) else { return false }
        if result { sawCommand = true }
    }
    for pair in shellCompoundPairs {
        let opened = heads.filter { pair.openers.contains($0) }.count
        let closed = heads.filter { $0 == pair.closer }.count
        if opened != closed { return false }
    }
    // `for`/`while`/`until`/`select` need their `do … done`.
    let loops = heads.filter { ["for", "while", "until", "select"].contains($0) }.count
    if loops > heads.filter({ $0 == "do" }).count { return false }
    return sawCommand
}

private func shellIsRedirection(_ op: String) -> Bool {
    shellRedirectionOperators.contains(op.drop(while: \.isNumber).description)
}

/// Validates one simple command. Returns nil when it disqualifies the line, else whether it names a command.
/// Appends every reserved word found in a command position to `heads` (for the compound balance check).
private func shellValidateSimpleCommand(_ tokens: [ShellToken], context: ShellCommandContext,
                                        heads: inout [String]) -> Bool? {
    // Separate the words from the redirections, checking each redirection's target as we go.
    var words: [ShellWord] = []
    var i = 0
    while i < tokens.count {
        switch tokens[i] {
        case .op(let op):
            guard shellIsRedirection(op) else { return nil }
            guard i + 1 < tokens.count, case .word(let target) = tokens[i + 1] else { return nil }
            // An input's target must exist when it looks like a path; an output's need not (it is created).
            let isInput = op.contains("<") && !op.contains("<<")
            if isInput, shellLooksLikePath(target), !shellPathExists(target, context: context) { return nil }
            i += 2
        case .word(let word):
            words.append(word)
            i += 1
        }
    }
    return shellValidateWords(words[...], context: context, heads: &heads)
}

private func shellValidateWords(_ words: ArraySlice<ShellWord>, context: ShellCommandContext,
                                heads: inout [String]) -> Bool? {
    var rest = words
    // Leading assignments (`FOO=1 make`).
    while let first = rest.first, !first.wasQuoted, shellIsAssignment(first.text) { rest = rest.dropFirst() }
    guard let head = rest.first else { return false } // assignments alone run nothing

    let name = head.text
    let reserved = !head.wasQuoted && !head.hasExpansion

    if reserved, shellClosers.contains(name) {
        heads.append(name)
        return shellValidateArguments(rest.dropFirst(), context: context) ? false : nil
    }
    if reserved, shellPrecommandWords.contains(name) {
        let remainder = rest.dropFirst()
        guard !remainder.isEmpty else { return nil }
        return shellValidateWords(remainder, context: context, heads: &heads)
    }
    if reserved, shellCommandIntroducers.contains(name) {
        heads.append(name)
        let remainder = rest.dropFirst()
        // `then`/`do`/`else`/`{` may stand alone on their segment; `if`/`while`/`until` need their condition.
        if remainder.isEmpty { return ["if", "while", "until", "elif"].contains(name) ? nil : false }
        return shellValidateWords(remainder, context: context, heads: &heads)
    }
    if reserved, shellListOpeners.contains(name) {
        heads.append(name)
        // A test closes on its own segment: `[[ -d /tmp ]]`.
        if name == "[[", rest.dropFirst().contains(where: { !$0.wasQuoted && $0.text == "]]" }) { heads.append("]]") }
        return shellValidateArguments(rest.dropFirst(), context: context) ? true : nil
    }

    guard shellResolvesCommand(head, context: context) else { return nil }
    return shellValidateArguments(rest.dropFirst(), context: context) ? true : nil
}

/// Every argument that looks like a path must exist.
private func shellValidateArguments(_ words: ArraySlice<ShellWord>, context: ShellCommandContext) -> Bool {
    for word in words where shellLooksLikePath(word) {
        if !shellPathExists(word, context: context) { return false }
    }
    return true
}

func shellIsAssignment(_ text: String) -> Bool {
    guard let eq = text.firstIndex(of: "="), eq != text.startIndex else { return false }
    let name = text[..<eq]
    guard let first = name.first, first.isLetter || first == "_" else { return false }
    return name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }
}

/// A word that names a path, by the rule: it starts with `/`, `~`, `./` or `../`. A word whose value comes
/// from an expansion is unknown until run time and never judged.
func shellLooksLikePath(_ word: ShellWord) -> Bool {
    guard !word.hasExpansion else { return false }
    return shellTextLooksLikePath(word.text)
}

func shellTextLooksLikePath(_ text: String) -> Bool {
    text.hasPrefix("/") || text.hasPrefix("~") || text.hasPrefix("./") || text.hasPrefix("../")
}

/// The absolute path a path-like word names, or nil when it cannot be expanded here (`~otheruser`, a quoted
/// `~`, which the shell would not expand either).
func shellExpandedPath(_ text: String, tildeUnquoted: Bool, context: ShellCommandContext) -> String? {
    if text.hasPrefix("~") {
        guard tildeUnquoted else { return nil }
        if text == "~" { return context.homeDirectory }
        guard text.hasPrefix("~/") else { return nil }
        return shellJoin(context.homeDirectory, String(text.dropFirst(2)))
    }
    if text.hasPrefix("/") { return text }
    return shellJoin(context.workingDirectory, text)
}

private func shellJoin(_ base: String, _ rest: String) -> String {
    if rest.isEmpty { return base }
    return base.hasSuffix("/") ? base + rest : base + "/" + rest
}

private func shellPathExists(_ word: ShellWord, context: ShellCommandContext) -> Bool {
    guard let path = shellExpandedPath(word.text, tildeUnquoted: word.leadingTildeUnquoted, context: context) else {
        return false
    }
    guard word.hasUnquotedGlob else { return context.fileSystem.exists(path) }
    // A glob: judge the directory it ranges over — the components before the first one holding a glob.
    var kept: [Substring] = []
    for component in path.split(separator: "/", omittingEmptySubsequences: false) {
        if component.contains(where: { "*?[".contains($0) }) { break }
        kept.append(component)
    }
    let directory = kept.joined(separator: "/")
    return context.fileSystem.isDirectory(directory.isEmpty ? "/" : directory)
}

/// Does the command word name something the shell can run?
private func shellResolvesCommand(_ word: ShellWord, context: ShellCommandContext) -> Bool {
    guard !word.hasExpansion else { return false } // `$EDITOR x` — unknown; not judged a command
    let name = word.text
    guard !name.isEmpty else { return false }
    if name.contains("/") {
        guard let path = shellExpandedPath(name, tildeUnquoted: word.leadingTildeUnquoted, context: context) else {
            return false
        }
        return context.fileSystem.isExecutableFile(path)
    }
    if shellBuiltins.contains(name) || context.aliases.contains(name) { return true }
    return context.pathDirectories.contains { context.fileSystem.isExecutableFile(shellJoin($0, name)) }
}

/// PURE: does the FIRST word of `line` name a command (the cheap half of the rule, for the completer's
/// "plausibly a command" gate)?
func shellFirstWordResolves(_ line: String, context: ShellCommandContext) -> Bool {
    guard case .complete(let tokens) = shellTokenize(line) else { return false }
    for token in tokens {
        guard case .word(let word) = token else { return false }
        if !word.wasQuoted, shellIsAssignment(word.text) { continue }
        if !word.wasQuoted, shellReservedWords.contains(word.text) { return true }
        return shellResolvesCommand(word, context: context)
    }
    return false
}

// MARK: - Autocomplete (the ghost text)

/// PURE: the ghost completion after the caret for `line` (caret at its end), or nil.
///
/// - The FIRST word (nothing typed after it yet): the executables, builtins, reserved words and aliases that
///   start with it, completed to their common prefix. Case-sensitive, at least two characters typed — so an
///   ordinary sentence's first word rarely ghosts.
/// - A PATH word at the end (`/`, `~`, `./`, `../`): the entries of its directory that start with what is
///   typed, completed to their common prefix; a single directory gains its `/`. Offered only while the line
///   is plausibly a command — its first word resolves (or is itself the path being typed).
///
/// What it returns is ready to insert: shell-special characters in it are backslash-escaped.
///
/// With a `source` (zsh's completion system), an ARGUMENT word completes from it instead — real subcommands,
/// branches, targets, files — falling back to the directory listing only when zsh cannot answer in time.
func shellCompletion(for line: String, context: ShellCommandContext, commandNames: [String],
                     source: ShellCompletionSource? = nil, deadline: Date = .distantFuture) -> String? {
    guard !line.isEmpty, line.count <= 1000, let lastChar = line.last, !lastChar.isWhitespace else { return nil }
    // The word being typed: everything after the last unquoted break. A word with quotes or escapes in it
    // is not completed (inserting into a quoted word needs the quote's own rules).
    let breakers: Set<Character> = [" ", "\t", "\n", "|", "&", ";", "(", ")", "<", ">"]
    let start = line.lastIndex(where: { breakers.contains($0) }).map { line.index(after: $0) } ?? line.startIndex
    let word = String(line[start...])
    guard !word.isEmpty, !word.contains(where: { "'\"\\$`".contains($0) }) else { return nil }
    let before = String(line[..<start])
    // The line up to the word must tokenize (no open quote swallowing it).
    guard case .complete(let tokensBefore) = shellTokenize(before) else { return nil }
    let isFirstWord = !tokensBefore.contains { if case .word = $0 { return true } else { return false } }

    if !isFirstWord, let source, zshLineMayBeShown(line), shellFirstWordResolves(before, context: context),
       let capture = source.capture(buffer: line, directory: context.workingDirectory, deadline: deadline) {
        let candidates = capture.hits.filter { $0.hasPrefix(word) && $0 != word }
        guard !candidates.isEmpty, !capture.hits.contains(word) else { return nil }
        let common = shellCommonPrefix(candidates)
        guard common.count > word.count else { return nil }
        return shellEscapedForInsertion(String(common.dropFirst(word.count)))
    }

    if shellTextLooksLikePath(word) {
        if !isFirstWord, !shellFirstWordResolves(before, context: context) { return nil }
        return shellPathCompletion(word, context: context)
    }
    guard isFirstWord, word.count >= 2 else { return nil }
    let matches = commandNames.filter { $0.hasPrefix(word) && $0 != word }
    guard !matches.isEmpty else { return nil }
    // A name typed in full that is also a prefix of longer ones (`git` vs `git-lfs`) gets no ghost.
    if commandNames.contains(word) { return nil }
    let common = shellCommonPrefix(matches)
    guard common.count > word.count else { return nil }
    return shellEscapedForInsertion(String(common.dropFirst(word.count)))
}

private func shellPathCompletion(_ word: String, context: ShellCommandContext) -> String? {
    let directoryPart: String, base: String
    if word.hasSuffix("/") {
        directoryPart = word
        base = ""
    } else if let slash = word.lastIndex(of: "/") {
        directoryPart = String(word[...slash])
        base = String(word[word.index(after: slash)...])
    } else {
        // `~` or `~name` with no slash yet: `~` alone completes to `~/`.
        return word == "~" ? "/" : nil
    }
    guard let directory = shellExpandedPath(directoryPart, tildeUnquoted: true, context: context),
          let entries = context.fileSystem.entries(ofDirectory: directory) else { return nil }
    let candidates = entries.filter { $0.hasPrefix(base) && (base.hasPrefix(".") || !$0.hasPrefix(".")) }
    guard !candidates.isEmpty else { return nil }
    var completed = shellCommonPrefix(candidates)
    if candidates.count == 1, context.fileSystem.isDirectory(shellJoin(directory, completed)) {
        completed += "/"
    }
    guard completed.count > base.count else { return nil }
    return shellEscapedForInsertion(String(completed.dropFirst(base.count)))
}

/// The longest prefix every string shares.
func shellCommonPrefix(_ strings: [String]) -> String {
    guard var prefix = strings.first else { return "" }
    for string in strings.dropFirst() {
        while !string.hasPrefix(prefix) { prefix.removeLast() }
        if prefix.isEmpty { break }
    }
    return prefix
}

/// Backslash-escapes the characters the shell would split or interpret.
func shellEscapedForInsertion(_ text: String) -> String {
    var out = ""
    for c in text {
        if " \t'\"\\$`|&;()<>*?[]#!{}".contains(c) { out.append("\\") }
        out.append(c)
    }
    return out
}
