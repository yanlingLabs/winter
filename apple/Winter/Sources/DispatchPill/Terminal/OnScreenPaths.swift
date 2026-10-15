import Foundation

// ON-SCREEN PATHS, the pure half: the file paths the user can SEE in the app they are in (a terminal's
// scrollback, a chat transcript, an editor), offered as command mode's argument ghost — type `open ` and the
// path that was just printed is suggested. The text comes from the front window's accessibility tree
// (`OnScreenTextReader.swift`); here it becomes a short list of paths, most recent first, and the ghost ranks
// them above plain filesystem completion. Everything here is pure (`OnScreenPathTests`).
//
// Privacy: the captured text is never kept — only the paths drawn from it, in memory, while the pill is up.

/// How many on-screen paths are kept.
let onScreenPathLimit = 30

// MARK: - Extraction

/// Characters that may come right before a path starts: the line's start, whitespace, an opening quote or
/// bracket, `=` (`--file=/x`), `,`. Never `:` — `https://host/x` is not a path.
private let onScreenPathOpeners: Set<Character> = [" ", "\t", "\"", "'", "`", "(", "[", "{", "<", "=", ","]
/// Characters that end an unquoted path.
private let onScreenPathEnders: Set<Character> = [" ", "\t", "\"", "'", "`", "<", ">", "|"]
/// What is trimmed off a path's end: sentence punctuation and closing brackets/quotes (a `.ext` survives — only a
/// trailing dot goes).
private let onScreenPathTrailing: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "\"", "'", "`"]
/// The longest path considered.
private let onScreenPathMaxLength = 1024

/// PURE: the path-like tokens in `text` — absolute `/…`, `~/…`, and `file://` URLs (decoded) — most RECENT first
/// (later in the text is more recent, as in a terminal or a chat transcript), de-duplicated (the same file
/// spelled `~/x` and `/Users/u/x` counts once, the most recent spelling kept), at most `limit`.
///
/// Surrounding quotes, backticks and brackets are trimmed, and trailing punctuation (`.,;:)` …, but never a
/// `.ext`), and a compiler's `:line:column`. A quoted path may hold spaces; an unquoted one may hold `\ `. A path
/// cut by a line wrap is joined where that is obvious: the line ends in `/`, or the line was filled to the text's
/// wrap width (the longest line, at least 40 characters) and the next line goes on without a space.
func onScreenPathCandidates(in text: String, home: String, limit: Int = onScreenPathLimit) -> [String] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        .components(separatedBy: "\n").map { Array($0) }
    let wrapWidth = lines.map(\.count).max() ?? 0
    var found: [String] = []
    for (index, line) in lines.enumerated() {
        for token in onScreenPathTokens(in: line) {
            var raw = token.text
            if token.endsAtLineEnd, index + 1 < lines.count, !token.quoted {
                let next = lines[index + 1]
                let filled = wrapWidth >= 40 && line.count == wrapWidth
                if raw.hasSuffix("/") || filled, let first = next.first, !first.isWhitespace, first != "/", first != "~" {
                    raw += String(next.prefix { !onScreenPathEnders.contains($0) })
                }
            }
            if let path = onScreenCleanPath(raw) { found.append(path) }
        }
    }
    var seen = Set<String>()
    var ranked: [String] = []
    for path in found.reversed() {
        guard seen.insert(onScreenPathKey(path, home: home)).inserted else { continue }
        ranked.append(path)
        if ranked.count == limit { break }
    }
    return ranked
}

/// One path-like token found in a line, as it stands (before cleaning).
private struct OnScreenPathToken {
    var text: String
    var quoted: Bool
    var endsAtLineEnd: Bool
}

private func onScreenPathTokens(in line: [Character]) -> [OnScreenPathToken] {
    var tokens: [OnScreenPathToken] = []
    var i = 0
    while i < line.count {
        let atBoundary = i == 0 || onScreenPathOpeners.contains(line[i - 1])
        guard atBoundary, onScreenPathStarts(line, at: i) else { i += 1; continue }
        let quote: Character? = i > 0 && ["\"", "'", "`"].contains(line[i - 1]) ? line[i - 1] : nil
        var j = i
        var text = ""
        var closedQuote = false
        if let quote, let close = line[i...].firstIndex(of: quote), close - i <= onScreenPathMaxLength {
            text = String(line[i..<close])
            j = close
            closedQuote = true
        } else {
            while j < line.count, text.count < onScreenPathMaxLength {
                let c = line[j]
                if c == "\\", j + 1 < line.count, line[j + 1] == " " { text.append(" "); j += 2; continue }
                if onScreenPathEnders.contains(c) { break }
                text.append(c)
                j += 1
            }
        }
        tokens.append(OnScreenPathToken(text: text, quoted: closedQuote, endsAtLineEnd: j >= line.count))
        i = max(j, i + 1)
    }
    return tokens
}

private func onScreenPathStarts(_ line: [Character], at i: Int) -> Bool {
    func has(_ prefix: String) -> Bool {
        let p = Array(prefix)
        return i + p.count <= line.count && Array(line[i..<(i + p.count)]) == p
    }
    return has("file://") || has("~/") || (line[i] == "/" && !has("//"))
}

/// PURE: a raw token → the path it names, or nil when it is not one: `file://` decoded, the trailing
/// punctuation and a `:line:column` trimmed, and at least one name after the leading `/` or `~/`.
func onScreenCleanPath(_ raw: String) -> String? {
    var text = raw
    if text.hasPrefix("file://") {
        if let url = URL(string: text), url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" {
            text = url.path
        } else {
            let rest = text.dropFirst("file://".count)
            let path = rest.hasPrefix("localhost/") ? rest.dropFirst("localhost".count) : rest
            guard path.hasPrefix("/"), let decoded = String(path).removingPercentEncoding else { return nil }
            text = decoded
        }
    }
    func trimTrailing() {
        while let last = text.last, onScreenPathTrailing.contains(last), text.count > 1 { text.removeLast() }
    }
    trimTrailing()
    // A compiler's `path:12:5` (after its own punctuation went).
    if let range = text.range(of: #":\d+(:\d+)?$"#, options: .regularExpression) {
        text.removeSubrange(range)
        trimTrailing()
    }
    guard text.hasPrefix("/") || text.hasPrefix("~/") else { return nil }
    guard !text.hasPrefix("//"), !text.contains("://"), text.count <= onScreenPathMaxLength,
          !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else { return nil }
    let body = text.hasPrefix("~/") ? text.dropFirst(2) : text.dropFirst()
    // At least one name: something other than slashes and dots.
    guard body.contains(where: { $0 != "/" && $0 != "." }) else { return nil }
    return text
}

/// The absolute path a candidate names (`~/` against `home`).
func onScreenExpandedPath(_ path: String, home: String) -> String {
    path.hasPrefix("~/") ? (home.hasSuffix("/") ? home : home + "/") + path.dropFirst(2) : path
}

/// What makes two spellings the same path: expanded, normalized, no trailing slash.
private func onScreenPathKey(_ path: String, home: String) -> String {
    shellNormalizedPath(onScreenExpandedPath(path, home: home))
}

// MARK: - Existence (never under a gated folder)

/// PURE (given its filesystem): the candidates that exist, in order. A path under a privacy-gated folder
/// (`shellPathIsTCCGated`) is kept by NAME — `fileSystem` is never asked about it, so reading the screen can never
/// cause a privacy prompt.
func onScreenPathsThatExist(_ paths: [String], home: String, fileSystem: ShellFileSystem) -> [String] {
    let gated = TCCGatedFileSystem(inner: fileSystem, home: home)
    return paths.filter { gated.exists(onScreenExpandedPath($0, home: home)) }
}

// MARK: - The ghost: on-screen paths at a file argument

/// Commands whose arguments are files — an on-screen path is offered at any of their arguments. Others get one
/// only where zsh's completion says the position takes files.
let shellFileTakingCommands: Set<String> = [
    "open", "cd", "pushd", "cat", "less", "more", "bat", "code", "subl", "vim", "vi", "nvim", "nano", "emacs", "ls",
    "cp", "mv", "rm", "head", "tail", "touch", "mkdir", "rmdir", "ln", "file", "stat", "du", "wc", "diff", "chmod",
    "chown", "tar", "zip", "unzip", "gzip", "gunzip", "xattr", "qlmanage", "source", ".", "python3", "node", "bun",
    "swift", "tree", "grep", "rg", "find", "fd", "trash", "md5", "shasum",
]

/// The on-screen candidates the ghost offers for an argument, and which one it shows.
struct OnScreenPathOffer: Equatable {
    /// The line up to the argument.
    var head: String
    /// The argument as typed so far (may be empty).
    var typed: String
    /// Candidates as they would be inserted (escaped), most recent first; each starts with `typed`.
    var candidates: [String]
    var index: Int = 0

    /// What the ghost draws after the caret.
    var ghost: String { String(candidates[index].dropFirst(typed.count)) }
}

/// PURE (given its source): the on-screen offer for the argument at the end of `line`, or nil. Offered when the
/// argument sits where files go — a command in `shellFileTakingCommands`, a redirection's target, or (asked of
/// zsh, within `deadline`) a position whose completion lists files — and the argument is EMPTY (every on-screen
/// path) or a prefix of an on-screen path. `~/…` and `/Users/u/…` spellings match either way. `cd`/`pushd` get
/// directories only.
func onScreenPathOffer(for line: String, onScreenPaths: [String], context: ShellCommandContext,
                       source: ShellCompletionSource? = nil, deadline: Date = .distantFuture) -> OnScreenPathOffer? {
    guard !onScreenPaths.isEmpty, !line.isEmpty, line.count <= 1000 else { return nil }
    // The argument: after the last UNESCAPED break.
    let chars = Array(line)
    let breakers: Set<Character> = [" ", "\t", "\n", "|", "&", ";", "(", ")", "<", ">"]
    var argumentStart = 0
    var k = 0
    while k < chars.count {
        if chars[k] == "\\" { k += 2; continue }
        if breakers.contains(chars[k]) { argumentStart = k + 1 }
        k += 1
    }
    guard argumentStart <= chars.count else { return nil }
    let typed = String(chars[argumentStart...])
    guard !typed.hasPrefix("-"), !typed.contains(where: { "'\"$`".contains($0) }) else { return nil }
    let head = String(chars[..<argumentStart])
    guard case .complete(let tokens) = shellTokenize(head) else { return nil }

    // The simple command the argument belongs to.
    var current: [ShellToken] = []
    for token in tokens {
        if case .op(let op) = token, shellCommandSeparators.contains(op) { current = [] } else { current.append(token) }
    }
    let afterRedirection: Bool = {
        if case .op(let op) = current.last { return shellRedirectionOperators.contains(op.drop(while: \.isNumber).description) }
        return false
    }()
    let command = current.lazy.compactMap { token -> ShellWord? in
        if case .word(let word) = token { return word } else { return nil }
    }.first { $0.wasQuoted || !shellIsAssignment($0.text) }
    guard let command, shellFirstWordResolves(head, context: context) else { return nil }

    var takesFiles = afterRedirection || shellFileTakingCommands.contains(command.text)
    if !takesFiles, let source, zshLineMayBeShown(line), !shellLineTouchesGatedPath(line, context: context),
       let capture = source.capture(buffer: line, directory: context.workingDirectory, deadline: deadline) {
        takesFiles = capture.kinds.contains(.files)
    }
    guard takesFiles else { return nil }
    let directoriesOnly = command.text == "cd" || command.text == "pushd"

    let home = context.homeDirectory
    let homePrefix = home.hasSuffix("/") ? home : home + "/"
    var candidates: [String] = []
    for path in onScreenPaths {
        // The spelling that matches what is typed: as shown, or `~/` ↔ the home folder.
        var spelling = path
        if typed.hasPrefix("~"), path.hasPrefix(homePrefix) { spelling = "~/" + path.dropFirst(homePrefix.count) }
        if typed.hasPrefix("/"), path.hasPrefix("~/") { spelling = onScreenExpandedPath(path, home: home) }
        let insertion = shellEscapedForInsertion(spelling)
        guard insertion.hasPrefix(typed), insertion.count > typed.count, !candidates.contains(insertion) else { continue }
        if directoriesOnly {
            let absolute = onScreenExpandedPath(path, home: home)
            guard path.hasSuffix("/") || context.fileSystem.isDirectory(absolute) else { continue }
        }
        candidates.append(insertion)
    }
    guard !candidates.isEmpty else { return nil }
    return OnScreenPathOffer(head: head, typed: typed, candidates: candidates)
}

// MARK: - Tab, and Tab again

/// An edit Tab makes at the end of the composer: the text's last `replacingSuffix` is replaced by `insert`.
/// (`replacingSuffix` empty = a plain insertion; both empty = Tab consumed, nothing changed.)
struct ComposerTabEdit: Equatable {
    var replacingSuffix: String
    var insert: String
}

/// PURE: Tab accepted an on-screen ghost; pressing Tab again with the text UNCHANGED since cycles to the next
/// on-screen candidate (and round), replacing the one accepted.
struct OnScreenPathCycle: Equatable {
    /// The text right after the last accept — Tab cycles only while the composer still holds exactly this.
    private(set) var acceptedText: String
    let head: String
    let candidates: [String]
    private(set) var index: Int

    /// Tab took `offer`'s ghost.
    init(accepting offer: OnScreenPathOffer) {
        head = offer.head
        candidates = offer.candidates
        index = offer.index
        acceptedText = offer.head + offer.candidates[offer.index]
    }

    /// Tab again on `text`: the edit to the next candidate, or nil when `text` changed since the accept. With
    /// one candidate Tab is consumed and changes nothing.
    mutating func next(for text: String) -> ComposerTabEdit? {
        guard text == acceptedText else { return nil }
        guard candidates.count > 1 else { return ComposerTabEdit(replacingSuffix: "", insert: "") }
        let current = candidates[index]
        index = (index + 1) % candidates.count
        acceptedText = head + candidates[index]
        return ComposerTabEdit(replacingSuffix: current, insert: candidates[index])
    }
}

// MARK: - The ghost, all told

/// The composer's ghost and, when it is an on-screen path, the offer it came from (for Tab again).
struct ShellGhost: Equatable {
    var suffix: String
    var offer: OnScreenPathOffer?
}

/// PURE (given its source): the ghost for `line` — an on-screen path first (`onScreenPathOffer`), else
/// `shellCompletion`'s.
func shellGhost(for line: String, context: ShellCommandContext, commandNames: [String], onScreenPaths: [String],
                source: ShellCompletionSource? = nil, deadline: Date = .distantFuture) -> ShellGhost? {
    if let offer = onScreenPathOffer(for: line, onScreenPaths: onScreenPaths, context: context, source: source,
                                     deadline: deadline) {
        return ShellGhost(suffix: offer.ghost, offer: offer)
    }
    return shellCompletion(for: line, context: context, commandNames: commandNames, source: source, deadline: deadline)
        .map { ShellGhost(suffix: $0, offer: nil) }
}
