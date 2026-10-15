import Foundation

// A command run's OUTPUT as text, and the message "Add to transcript" sends — pure (`ShellCommandLineTests`).
//
// The terminal window shows the run through a real emulator; the transcript gets plain text: the raw bytes
// the PTY produced, escape sequences stripped, carriage-return overwrites resolved (a progress bar leaves its
// last state, not every frame), capped to the tail.

/// The most of a run's output a message carries: the last `maxLines` lines and `maxCharacters` characters.
enum TerminalTranscriptLimits {
    static let maxLines = 400
    static let maxCharacters = 30_000
    /// How many raw bytes a run keeps for this (its tail) — far more than the cap needs after stripping.
    static let maxCapturedBytes = 1_048_576
}

/// PURE: terminal output bytes → plain text. Decodes UTF-8 FIRST (invalid bytes become U+FFFD) — a UTF-8
/// continuation byte such as 0x9B is part of "ś" or "😛", never an 8-bit CSI, so there is no C1 handling at all —
/// then strips, on the decoded text, CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), DCS/SOS/PM/APC strings and the
/// other two- and three-character escapes; resolves `\r\n` to a line break, a lone `\r` to "back to the start of
/// the line" (what follows overwrites it), backspace to deleting the previous character; drops the remaining C0
/// controls except tab and newline.
func terminalPlainText(_ bytes: [UInt8]) -> String {
    let scalars = Array(String(decoding: bytes, as: UTF8.self).unicodeScalars)
    var cleaned = String.UnicodeScalarView()
    var i = 0
    let n = scalars.count
    func value(_ k: Int) -> UInt32 { scalars[k].value }
    while i < n {
        guard value(i) == 0x1B else {
            cleaned.append(scalars[i])
            i += 1
            continue
        }
        guard i + 1 < n else { break }
        switch value(i + 1) {
        case 0x5B: // CSI: parameters/intermediates 0x20–0x3F, final 0x40–0x7E
            var j = i + 2
            while j < n, !(0x40...0x7E).contains(value(j)) { j += 1 }
            i = j + 1
        case 0x5D, 0x50, 0x58, 0x5E, 0x5F: // OSC, DCS, SOS, PM, APC: to BEL or ST (ESC \)
            var j = i + 2
            while j < n {
                if value(j) == 0x07 { j += 1; break }
                if value(j) == 0x1B, j + 1 < n, value(j + 1) == 0x5C { j += 2; break }
                j += 1
            }
            i = j
        case 0x20...0x2F: // ESC + intermediate(s) + final (`ESC ( B`)
            var j = i + 1
            while j < n, (0x20...0x2F).contains(value(j)) { j += 1 }
            i = j + 1
        default: // ESC + one final (`ESC =`, `ESC 7`, `ESC M` …)
            i += 2
        }
    }

    // Lines: \r\n → \n; a lone \r returns to the line's start; \b deletes back.
    var lines: [String] = []
    var line: [Character] = []
    var column = 0
    let text = String(cleaned)
    var characters = Array(text)
    // `\r\n` arrives as ONE grapheme in Swift; split it back so the rules below see both.
    characters = characters.flatMap { $0 == "\r\n" ? ["\n"] : [$0] }
    func put(_ c: Character) {
        if column < line.count { line[column] = c } else { line.append(c) }
        column += 1
    }
    for c in characters {
        switch c {
        case "\n":
            lines.append(String(line))
            line = []
            column = 0
        case "\r":
            column = 0
        case "\u{08}":
            if column > 0 { column -= 1 }
        case "\t":
            put("\t")
        default:
            if let scalar = c.unicodeScalars.first, c.unicodeScalars.count == 1,
               scalar.value < 0x20 || scalar.value == 0x7F {
                continue // the rest of C0, and DEL
            }
            put(c)
        }
    }
    lines.append(String(line))
    // Trailing spaces on each line, and trailing empty lines, carry nothing.
    var result = lines.map { String($0.reversed().drop(while: { $0 == " " }).reversed()) }
    while let last = result.last, last.isEmpty { result.removeLast() }
    return result.joined(separator: "\n")
}

/// PURE: the tail of `text` within `maxLines` lines and `maxCharacters` characters, with a
/// "… N earlier lines omitted" first line when anything was dropped.
func terminalCappedOutput(_ text: String, maxLines: Int = TerminalTranscriptLimits.maxLines,
                          maxCharacters: Int = TerminalTranscriptLimits.maxCharacters) -> String {
    guard !text.isEmpty else { return "" }
    let all = text.components(separatedBy: "\n")
    var kept = Array(all.suffix(maxLines))
    var characters = kept.reduce(0) { $0 + $1.count } + max(0, kept.count - 1)
    while characters > maxCharacters, kept.count > 1 {
        characters -= kept.removeFirst().count + 1
    }
    var clippedHead = false
    if characters > maxCharacters, let only = kept.first {
        kept = [String(only.suffix(maxCharacters))]
        clippedHead = true
    }
    let omitted = all.count - kept.count
    var body = kept.joined(separator: "\n")
    if omitted > 0 {
        body = "… \(omitted) earlier line\(omitted == 1 ? "" : "s") omitted\n" + body
    } else if clippedHead {
        body = "… earlier output omitted\n" + body
    }
    return body
}

/// How a run ended, for the pill and the message.
enum CommandRunOutcome: Equatable {
    case running
    case exited(Int32)
    /// Ended by a signal (the window's Stop, the app quitting, or anything else that killed it).
    case signaled(Int32)
    /// The process could not be started.
    case failedToStart

    var isFinished: Bool { self != .running }
    var succeeded: Bool { self == .exited(0) }
}

/// PURE: a `waitpid` status → the outcome. (SwiftTerm's `LocalProcess` reports the raw status word.)
func commandRunOutcome(waitStatus status: Int32) -> CommandRunOutcome {
    let signal = status & 0x7F
    if signal == 0 { return .exited((status >> 8) & 0xFF) }
    if signal != 0x7F { return .signaled(signal) }
    return .exited(status)
}

/// PURE: `path` with the home directory written `~`.
func terminalDisplayPath(_ path: String, home: String) -> String {
    guard !home.isEmpty else { return path }
    if path == home { return "~" }
    let prefix = home.hasSuffix("/") ? home : home + "/"
    return path.hasPrefix(prefix) ? "~/" + path.dropFirst(prefix.count) : path
}

/// PURE: the user's message "Add to transcript" sends: a short header line, then a fenced block holding
/// `$ <command>` and the output, stripped and capped. The fence is longer than any backtick run inside it.
func terminalTranscriptMessage(command: String, workingDirectory: String, home: String,
                               outcome: CommandRunOutcome, output: String) -> String {
    let state: String
    switch outcome {
    case .running: state = "still running"
    case .exited(let code): state = "exit \(code)"
    case .signaled(let signal): state = "stopped by signal \(signal)"
    case .failedToStart: state = "could not start"
    }
    let header = "I ran this in my terminal in \(terminalDisplayPath(workingDirectory, home: home)) (\(state)):"
    let body = output.isEmpty ? "$ \(command)" : "$ \(command)\n\(output)"
    var longest = 0, run = 0
    for c in body {
        if c == "`" { run += 1; longest = max(longest, run) } else { run = 0 }
    }
    let fence = String(repeating: "`", count: max(3, longest + 1))
    return "\(header)\n\(fence)\n\(body)\n\(fence)"
}
