import AppKit
import Darwin
import Foundation

// WHOLE-COMMAND validation on zsh's own completion system. The structural checks (`shellLineIsCommand`) say
// a line COULD run; this says each word is something the command actually takes — so "make sure the tests
// pass", "which one is better" and "open the file please" stay messages while "git status" turns purple.
//
// The engine is ONE quiet background `zsh -f`, owned by the app, started lazily and restarted when it dies.
// It loads `zsh/zpty`, runs `compinit -C -D` on the system fpath (never the user's `.zshrc` — slow, and it may
// print), and drives an interactive inner `zsh -f -i` in a pty the way zsh-capture-completion does: a widget
// around `complete-word`, and a `compadd` override that, instead of adding matches, prints them — with what
// kind of position asked for them (files? a free-text message?). Nothing it is fed can run: Return and
// line-feed are unbound in the inner shell, control characters never reach it, and a directory change is a
// widget of its own.
//
// A word after the command is VALID when it is one of the completion candidates at its position (exact; a
// directory's trailing `/` ignored), or the position takes it: a file position and an existing path; a flag
// position (options are offered there) and a `-word`; a free-text position (`git commit -m`'s message), which
// takes anything. A command with NO completion function falls back to the PROSE GUARD.

// MARK: - What one completion query captured (pure — `ZshCompletionTests`)

struct ZshCompletionCapture: Equatable {
    enum Kind: Hashable { case files, message }
    /// The candidates, as the command line would hold them (prefixes included; directories end in `/`).
    var hits: [String]
    /// What kinds of position asked: a `_files`/`_path_files`/`_directories`/`_default` call, a `_message`.
    var kinds: Set<Kind>

    static let empty = ZshCompletionCapture(hits: [], kinds: [])

    /// PURE: the engine's reply lines → a capture. `K<flags>` opens one `compadd` call (`f` files, `m` message),
    /// `H<candidate>` is one candidate; anything else is ignored.
    static func parse(_ lines: [String]) -> ZshCompletionCapture {
        var capture = ZshCompletionCapture.empty
        for line in lines {
            guard let tag = line.first else { continue }
            let body = String(line.dropFirst())
            switch tag {
            case "K":
                if body.contains("f") { capture.kinds.insert(.files) }
                if body.contains("m") { capture.kinds.insert(.message) }
            case "H":
                if !body.isEmpty { capture.hits.append(body) }
            default:
                break
            }
        }
        return capture
    }

    /// The candidate list holds `word` exactly — a directory's trailing `/` on either side ignored.
    func contains(_ word: String) -> Bool {
        let bare = word.hasSuffix("/") && word.count > 1 ? String(word.dropLast()) : word
        return hits.contains { hit in
            hit == word || (hit.hasSuffix("/") && hit.count > 1 && String(hit.dropLast()) == bare)
        }
    }

    /// Options are offered here.
    var offersOptions: Bool { hits.contains { $0.hasPrefix("-") } }
}

/// How a position took a word (or did not).
enum ZshPositionVerdict: Equatable {
    /// One of the completion candidates there.
    case candidate
    /// A free-text (`_message`) position — it takes anything; unquoted words there still count as prose.
    case freeText
    /// A file position and an existing path.
    case existingPath
    /// A `-word` where options are offered.
    case flag
    case rejected
}

/// PURE: does the position whose completion is `capture` take `word`? `optionsHere` answers whether options
/// are offered at the position (asked only for a `-word` that is not itself a candidate). A word holding an
/// expansion never gets here — such lines are never shown to zsh (`zshBufferIsSafe`).
func zshPositionVerdict(_ word: ShellWord, capture: ZshCompletionCapture, pathExists: Bool,
                        optionsHere: () -> Bool) -> ZshPositionVerdict {
    if word.hasExpansion { return .rejected }
    if capture.contains(word.text) { return .candidate }
    if capture.kinds.contains(.message) { return .freeText }
    if capture.kinds.contains(.files), pathExists { return .existingPath }
    if word.text.hasPrefix("-"), !word.wasQuoted, optionsHere() { return .flag }
    return .rejected
}

// MARK: - The prose guard (pure)

/// PURE: the PLAIN words among `arguments` — not flags, paths, existing files, URLs, quoted strings or `=`
/// assignments. A word holding an expansion is never an existing path: it counts as plain.
func shellPlainWords(_ arguments: [ShellWord], pathExists: (ShellWord) -> Bool) -> [ShellWord] {
    arguments.filter { word in
        if word.hasExpansion { return true }
        return !(word.wasQuoted || word.text.hasPrefix("-") || shellLooksLikePath(word)
                 || word.text.contains("://") || word.text.contains("=") || pathExists(word))
    }
}

/// PURE: a command zsh cannot vouch for (no completion function, a line zsh may not see, no answer in time) is
/// NOT one when its line ends like a sentence (`?`, `.`, `!`, `,`) or it has three or more plain words.
func shellProseGuardRejects(lineEndsSimpleCommand: Bool, line: String, arguments: [ShellWord],
                            pathExists: (ShellWord) -> Bool) -> Bool {
    if lineEndsSimpleCommand,
       let last = line.trimmingCharacters(in: .whitespacesAndNewlines).last, "?.!,".contains(last) {
        return true
    }
    return shellPlainWords(arguments, pathExists: pathExists).count >= 3
}

// MARK: - The source the validator asks

/// What the whole-command check asks zsh. The live one is `ZshCompletionEngine`; tests hand in a dictionary.
protocol ShellCompletionSource: AnyObject {
    /// The completion for the line `buffer` with the cursor at its end, run in `directory`. Nil when it could
    /// not be had before `deadline`, the engine is unavailable, or the buffer may not be shown to zsh.
    func capture(buffer: String, directory: String, deadline: Date) -> ZshCompletionCapture?
    /// Whether `command` has a completion function. Nil when unknown before `deadline`.
    func hasCompletionFunction(_ command: String, deadline: Date) -> Bool?
}

/// How long one whole-command check may take before it falls back to the prose guard.
let shellCompletionCheckBudget: TimeInterval = 0.3

/// PURE (given its source): the whole-command check, run AFTER `shellLineIsCommand` said yes. For every simple
/// command:
/// - a FREE-TEXT command (`say`, `yes`, `echo`… — `shellFreeTextCommands`) is prose once enough unquoted plain
///   words follow it;
/// - with a completion function, every word after the command must be taken by its position
///   (`zshPositionVerdict`), and unquoted words at free-text positions count as prose
///   (`shellFreeTextPositionLimit`);
/// - without one, for a line zsh may not see (`zshBufferIsSafe`), or when zsh cannot answer in time — the
///   prose guard decides.
/// Lines with compound structure (`if`/`for`/`{`/`(`, several lines) are left to the structural rules.
func shellCompletionCheckPasses(_ line: String, context: ShellCommandContext, source: ShellCompletionSource?,
                                deadline: Date) -> Bool {
    guard case .complete(let tokens) = shellTokenize(line) else { return false }
    let chars = Array(line)
    // Nothing that zsh could evaluate while completing is ever shown to it.
    let engine = zshLineMayBeShown(line) ? source : nil

    // Simple commands: words, with redirection targets set apart (they were judged structurally already).
    var commands: [[ShellWord]] = [[]]
    var index = 0
    while index < tokens.count {
        switch tokens[index] {
        case .op(let op):
            if op == "\n" || op == "(" || op == ")" { return true } // compound: structural rules only
            if shellCommandSeparators.contains(op) {
                commands.append([])
            } else {
                index += 1 // a redirection: skip its target
            }
        case .word(let word):
            commands[commands.count - 1].append(word)
        }
        index += 1
    }
    commands = commands.filter { !$0.isEmpty }

    func exists(_ word: ShellWord) -> Bool {
        guard !word.hasExpansion,
              let path = shellExpandedPath(word.text, tildeUnquoted: word.leadingTildeUnquoted || !word.text.hasPrefix("~"),
                                           context: context) else { return false }
        return context.fileSystem.exists(path)
    }

    for (position, words) in commands.enumerated() {
        var rest = words[...]
        while let first = rest.first, !first.wasQuoted, first.text.contains("="), !first.text.hasPrefix("=") {
            rest = rest.dropFirst()
        }
        guard let head = rest.first else { continue }
        if !head.wasQuoted, shellReservedWords.contains(head.text) || head.text == "[" { return true }
        let arguments = Array(rest.dropFirst())
        let isLast = position == commands.count - 1
        let guardRejects = {
            shellProseGuardRejects(lineEndsSimpleCommand: isLast, line: line, arguments: arguments, pathExists: exists)
        }
        if !head.wasQuoted, let limit = shellFreeTextCommands[head.text] {
            if shellPlainWords(arguments, pathExists: exists).count >= limit || guardRejects() { return false }
            continue
        }
        guard !arguments.isEmpty else { continue }
        guard let engine, !head.hasExpansion,
              let hasFunction = engine.hasCompletionFunction(head.text, deadline: deadline), hasFunction else {
            if guardRejects() { return false }
            continue
        }
        var freeTextWords = 0
        for word in arguments {
            let buffer = String(chars[0..<min(word.end, chars.count)])
            guard let capture = engine.capture(buffer: buffer, directory: context.workingDirectory, deadline: deadline) else {
                // zsh could not answer in time: the prose guard decides this command.
                if guardRejects() { return false }
                break
            }
            let verdict = zshPositionVerdict(word, capture: capture, pathExists: exists(word)) {
                let optionBuffer = String(chars[0..<min(word.start, chars.count)]) + "-"
                return engine.capture(buffer: optionBuffer, directory: context.workingDirectory,
                                      deadline: deadline)?.offersOptions ?? true
            }
            switch verdict {
            case .rejected: return false
            case .freeText: if !word.wasQuoted { freeTextWords += 1 }
            case .candidate, .existingPath, .flag: break
            }
        }
        if freeTextWords >= shellFreeTextPositionLimit { return false }
    }
    return true
}

// MARK: - The engine

/// The zsh that answers: see this file's header. Thread-safe and never blocking for long: a query waits for
/// the lock only until its deadline, a stopped engine is restarted IN THE BACKGROUND (the query that found it
/// stopped answers nil — the prose guard decides meanwhile), restarts back off exponentially, and after
/// `breakerThreshold` consecutive timeouts the breaker opens for `breakerCooldown`: no zsh at all, prose guard
/// only. Every reply is memoized per (directory, buffer), so typing a line asks zsh about each new prefix once.
///
/// It runs under `sandbox-exec` (`zshCompletionSandboxProfile`): no file writes outside its private temp folder
/// and the terminal devices, no network — defense in depth behind `zshBufferIsSafe`. Completion functions
/// still read, and still run the tools they need (`git`, `make`…).
final class ZshCompletionEngine: ShellCompletionSource, @unchecked Sendable {
    let zshPath: String
    private let environment: [String: String]
    /// The engine's own temp folder — the one place it may write.
    let privateDirectory: String
    private let backoffBase: TimeInterval
    private var quitObserver: NSObjectProtocol?

    private let lock = NSLock()
    private var process: Process?
    private var input: FileHandle?
    private var outputDescriptor: Int32 = -1
    private var pending = Data()
    private var directory: String?
    private var starting = false
    private var unavailable = false
    private var nextStartAllowed = Date.distantPast
    private var consecutiveFailures = 0
    private var breakerOpenUntil = Date.distantPast
    private var captures: [String: ZshCompletionCapture] = [:]
    private var functions: [String: Bool] = [:]
    private let startQueue = DispatchQueue(label: "winter.dispatch-pill.zsh-engine-start", qos: .utility)

    static let memoLimit = 2048
    /// How long a cold start (zsh, compinit, the inner shell) may take.
    static let startTimeout: TimeInterval = 3
    static let breakerThreshold = 3
    static let breakerCooldown: TimeInterval = 60
    static let maxBackoff: TimeInterval = 30

    /// - Parameter environment: what the background zsh sees — the PATH completion functions run tools from
    ///   (`git`, `make`…), HOME. Never the app's own variables. Its TMPDIR is replaced by the private folder.
    /// - Parameter backoffBase: the first restart delay (doubling per consecutive failure, up to `maxBackoff`).
    init(zshPath: String = "/bin/zsh", environment: [String: String], backoffBase: TimeInterval = 0.5) {
        self.zshPath = zshPath
        self.backoffBase = backoffBase
        let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("winter-zsh-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        // realpath, not `resolvingSymlinksInPath` (which strips `/private`): the sandbox matches the kernel's path.
        privateDirectory = base.withCString { pointer in
            guard let resolved = realpath(pointer, nil) else { return base }
            defer { free(resolved) }
            return String(cString: resolved)
        }
        var environment = environment
        environment["TMPDIR"] = privateDirectory
        environment["TMPPREFIX"] = (privateDirectory as NSString).appendingPathComponent("zsh") // here-documents
        self.environment = environment
        // The app quitting takes the engine with it (its inner shell gets the pty's hang-up).
        quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification,
                                                              object: nil, queue: nil) { [weak self] _ in
            self?.shutDown()
        }
    }

    /// Stops the engine for good (app quit).
    func shutDown() {
        lock.lock(); defer { lock.unlock() }
        unavailable = true
        stopLocked()
    }

    deinit {
        if let quitObserver { NotificationCenter.default.removeObserver(quitObserver) }
        stopLocked()
        try? FileManager.default.removeItem(atPath: privateDirectory)
    }

    /// Starts the engine in the background now (it is otherwise started by the first query that finds it stopped).
    func warmUp() {
        lock.lock()
        startInBackgroundLocked()
        lock.unlock()
    }

    /// Starts the engine and waits up to `timeout` for it to answer — tests only (it blocks).
    func waitUntilAvailable(timeout: TimeInterval = startTimeout + 1) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            lock.lock()
            let running = process?.isRunning == true
            let gaveUp = unavailable
            if !running { startInBackgroundLocked() }
            lock.unlock()
            if running { return true }
            if gaveUp { return false }
            usleep(20_000)
        }
        return false
    }

    func capture(buffer: String, directory: String, deadline: Date) -> ZshCompletionCapture? {
        guard zshBufferIsSafe(buffer), let escaped = zshEngineQuoted(buffer) else { return nil }
        guard lock.lock(before: deadline) else { return nil }
        defer { lock.unlock() }
        let key = directory + "\u{0}" + buffer
        if let cached = captures[key] { return cached }
        guard runningLocked() else { return nil }
        if self.directory != directory {
            guard let quotedDirectory = zshEngineQuoted(directory),
                  requestLocked("D" + quotedDirectory, deadline: deadline) != nil else { return nil }
            self.directory = directory
        }
        guard let lines = requestLocked("Q" + escaped, deadline: deadline) else { return nil }
        let capture = ZshCompletionCapture.parse(lines)
        if captures.count >= Self.memoLimit { captures.removeAll(keepingCapacity: true) }
        captures[key] = capture
        return capture
    }

    func hasCompletionFunction(_ command: String, deadline: Date) -> Bool? {
        guard zshBufferIsSafe(command), let escaped = zshEngineQuoted(command) else { return nil }
        guard lock.lock(before: deadline) else { return nil }
        defer { lock.unlock() }
        if let cached = functions[command] { return cached }
        guard runningLocked(), let lines = requestLocked("C" + escaped, deadline: deadline) else { return nil }
        let has = lines.contains { $0.hasPrefix("C1") }
        functions[command] = has
        return has
    }

    // MARK: Process

    /// Running and answering — or, if not, a background start is asked for (never waited on here).
    private func runningLocked() -> Bool {
        if let process, process.isRunning { return true }
        if process != nil { noteFailureLocked() }
        startInBackgroundLocked()
        return false
    }

    private func startInBackgroundLocked() {
        guard !starting, !unavailable, process?.isRunning != true else { return }
        let now = Date()
        guard now >= nextStartAllowed, now >= breakerOpenUntil else { return }
        starting = true
        startQueue.async { [weak self] in self?.start() }
    }

    /// Off every caller's thread: launch, wait for the ready line, then install under the lock.
    private func start() {
        guard FileManager.default.isExecutableFile(atPath: zshPath),
              FileManager.default.isExecutableFile(atPath: "/usr/bin/sandbox-exec") else {
            finishStart(nil, error: "zsh or sandbox-exec missing", permanent: true)
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        process.arguments = ["-p", zshCompletionSandboxProfile(privateDirectory: privateDirectory),
                             zshPath, "-f", "-c", zshCompletionEngineScript]
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: environment["HOME"] ?? NSHomeDirectory())
        let stdin = Pipe(), stdout = Pipe()
        for descriptor in [stdin.fileHandleForReading.fileDescriptor, stdin.fileHandleForWriting.fileDescriptor,
                           stdout.fileHandleForReading.fileDescriptor, stdout.fileHandleForWriting.fileDescriptor] {
            shellSetCloseOnExec(descriptor)
        }
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch {
            finishStart(nil, error: "could not launch", permanent: false)
            return
        }
        // A write to an engine that died must fail, never SIGPIPE the app.
        _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        let output = stdout.fileHandleForReading.fileDescriptor
        var buffer = Data()
        let ready = zshReadLine(output, pending: &buffer, deadline: Date().addingTimeInterval(Self.startTimeout))
        guard ready == "R" else {
            process.terminate()
            finishStart(nil, error: ready == "X" ? "zsh/zpty unavailable" : "no answer in time", permanent: ready == "X")
            return
        }
        finishStart((process, stdin.fileHandleForWriting, output, buffer), error: nil, permanent: false)
    }

    private func finishStart(_ started: (Process, FileHandle, Int32, Data)?, error: String?, permanent: Bool) {
        lock.lock(); defer { lock.unlock() }
        starting = false
        if let (process, input, output, buffer) = started {
            self.process = process
            self.input = input
            outputDescriptor = output
            pending = buffer
            directory = nil
            NSLog("[DispatchPill] completion engine: started")
        } else {
            if permanent { unavailable = true }
            noteFailureLocked()
            NSLog("[DispatchPill] completion engine: %@", error ?? "failed")
        }
    }

    /// A timeout or a death: stop, back off, and open the breaker after too many in a row.
    private func noteFailureLocked() {
        stopLocked()
        consecutiveFailures += 1
        let backoff = min(Self.maxBackoff, backoffBase * pow(2, Double(consecutiveFailures - 1)))
        nextStartAllowed = Date().addingTimeInterval(backoff)
        if consecutiveFailures >= Self.breakerThreshold {
            breakerOpenUntil = Date().addingTimeInterval(Self.breakerCooldown)
            consecutiveFailures = 0
            NSLog("[DispatchPill] completion engine: breaker open — prose guard only for %.0f s", Self.breakerCooldown)
        }
    }

    private func stopLocked() {
        if let process, process.isRunning { process.terminate() }
        try? input?.close()
        process = nil
        input = nil
        outputDescriptor = -1
        pending = Data()
        directory = nil
    }

    /// One request → its reply lines up to `E`. A timeout or a dead engine counts as a failure and answers nil.
    private func requestLocked(_ request: String, deadline: Date) -> [String]? {
        guard let input, let data = (request + "\n").data(using: .utf8) else { return nil }
        let wrote: Bool = data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(input.fileDescriptor, raw.baseAddress! + offset, raw.count - offset)
                if n <= 0 { return false }
                offset += n
            }
            return true
        }
        guard wrote else { noteFailureLocked(); return nil }
        var lines: [String] = []
        while true {
            guard let line = zshReadLine(outputDescriptor, pending: &pending, deadline: deadline) else {
                noteFailureLocked()
                return nil
            }
            if line == "E" {
                consecutiveFailures = 0
                return lines
            }
            lines.append(line)
        }
    }

    // MARK: Test seams

    var cachedCaptureCountForTesting: Int {
        lock.lock(); defer { lock.unlock() }
        return captures.count
    }

    var breakerIsOpenForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return Date() < breakerOpenUntil
    }

    /// Sends `buffer` to the engine WITHOUT the `zshBufferIsSafe` refusal — only to prove the sandbox holds.
    func captureBypassingSafetyForTesting(buffer: String, directory: String, deadline: Date) -> ZshCompletionCapture? {
        guard let escaped = zshEngineQuoted(buffer), lock.lock(before: deadline) else { return nil }
        defer { lock.unlock() }
        guard runningLocked() else { return nil }
        if self.directory != directory {
            guard let quotedDirectory = zshEngineQuoted(directory),
                  requestLocked("D" + quotedDirectory, deadline: deadline) != nil else { return nil }
            self.directory = directory
        }
        return requestLocked("Q" + escaped, deadline: deadline).map(ZshCompletionCapture.parse)
    }
}

/// Reads one line from `descriptor` (buffering in `pending`), or nil at the deadline or EOF.
private func zshReadLine(_ descriptor: Int32, pending: inout Data, deadline: Date) -> String? {
    while true {
        if let newline = pending.firstIndex(of: 0x0A) {
            let line = pending[pending.startIndex..<newline]
            pending.removeSubrange(pending.startIndex...newline)
            return String(decoding: line, as: UTF8.self)
        }
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0, descriptor >= 0 else { return nil }
        var poller = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let ready = poll(&poller, 1, Int32(max(1, remaining * 1000)))
        if ready < 0, errno == EINTR { continue }
        guard ready > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: 16_384)
        let count = read(descriptor, &buffer, buffer.count)
        guard count > 0 else { return nil }
        pending.append(buffer, count: count)
    }
}

/// Marks a descriptor close-on-exec, so no child the app starts (a terminal run, a helper) inherits it.
func shellSetCloseOnExec(_ descriptor: Int32) {
    guard descriptor >= 0 else { return }
    let flags = fcntl(descriptor, F_GETFD)
    if flags >= 0 { _ = fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) }
}

/// PURE: the engine's sandbox — everything zsh's completion needs to READ and RUN, nothing it could WRITE
/// except its private folder and the terminal devices zpty uses, and no network.
///
/// DENY by default. Allowed: forking and running programs (completion functions run `git`, `make`, `xcrun`…);
/// READING files — all of them, because path completion lists whatever directory the user types (reads cannot
/// leave the sandbox: no network, no writes, no pasteboard); ioctls and ptys (zpty); signals only within the
/// sandbox (never another of the user's processes — not the Winter daemon, not the app); writes only to its
/// private folder and the tty/pty devices; three Mach services libc needs (user lookup, notify, logging).
/// Explicitly denied on top: Apple Events, the pasteboard, LaunchServices, the window server, and running
/// `osascript`, `open`, `pbcopy`, `pbpaste`.
func zshCompletionSandboxProfile(privateDirectory: String) -> String {
    let quoted = privateDirectory.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    return """
    (version 1)
    (deny default)
    (allow process-fork)
    (allow process-exec)
    (allow file-read*)
    (allow file-ioctl)
    (allow sysctl-read)
    (allow pseudo-tty)
    (allow signal (target same-sandbox))
    (allow file-write*
      (literal "/dev/null")
      (literal "/dev/ptmx")
      (literal "/dev/dtracehelper")
      (regex #"^/dev/tty")
      (regex #"^/dev/pty")
      (subpath "\(quoted)"))
    (allow mach-lookup
      (global-name "com.apple.system.opendirectoryd.libinfo")
      (global-name "com.apple.system.notification_center")
      (global-name "com.apple.system.logger"))
    (allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))
    (deny network*)
    (deny appleevent-send)
    (deny mach-lookup
      (global-name "com.apple.pasteboard.1")
      (global-name "com.apple.coreservices.launchservicesd")
      (global-name-regex #"^com\\.apple\\.lsd\\.")
      (global-name "com.apple.windowserver.active"))
    (deny process-exec
      (literal "/usr/bin/osascript")
      (literal "/usr/bin/open")
      (literal "/usr/bin/pbcopy")
      (literal "/usr/bin/pbpaste"))
    """
}

/// PURE: `text` as a zsh `$'…'` literal the engine `eval`s — or nil when it holds a control character, which must
/// never reach the inner shell's line editor (a newline there would be Return).
func zshEngineQuoted(_ text: String) -> String? {
    var out = "$'"
    for scalar in text.unicodeScalars {
        if scalar.value < 0x20 || scalar.value == 0x7F { return nil }
        switch scalar {
        case "'": out += "\\'"
        case "\\": out += "\\\\"
        default:
            if scalar.isASCII {
                out.unicodeScalars.append(scalar)
            } else {
                for byte in String(scalar).utf8 { out += String(format: "\\x%02x", byte) }
            }
        }
    }
    return out + "'"
}

/// The background zsh's program. Outer `zsh -f`: `compinit` (for `_comps`, the "has a completion function"
/// question), then an interactive inner `zsh -f -i` in a pty, set up by a sourced init file, then a request
/// loop on stdin: `Q<$'buffer'>` completes, `C<$'command'>` asks for a completion function, `D<$'dir'>` moves
/// both shells. Replies end with a line `E`.
let zshCompletionEngineScript = #"""
{ for __fd in /dev/fd/<3->(N:t); do exec {__fd}>&-; done } 2>/dev/null
zmodload zsh/zpty 2>/dev/null || { print -r -- X; exit 1 }
autoload -Uz compinit && compinit -C -D 2>/dev/null
zpty __w /bin/zsh -f -i || { print -r -- X; exit 1 }
__winit=$(mktemp "${TMPDIR:-/tmp}/winter-compcap.XXXXXX") || exit 1
cat > $__winit <<'INIT'
PROMPT= RPROMPT= PS2=
unsetopt beep
bindkey -e
autoload -Uz compinit && compinit -C -D
bindkey '^M' undefined-key
bindkey '^J' undefined-key
zstyle ':completion:*' list-grouped false
zstyle ':completion:*' insert-tab false
zstyle ':completion:*' list-separator ''
zstyle ':completion:*' menu no
zmodload zsh/zutil
_w_complete() { print -rn -- $'\x01WBEGIN\n'; zle complete-word; print -rn -- $'\x01WEND\n' }
zle -N _w_complete
bindkey '^I' _w_complete
compadd () {
  if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then builtin compadd "$@"; return $?; fi
  typeset -a __hits
  builtin compadd -A __hits "$@"
  setopt localoptions norcexpandparam extendedglob
  typeset -A apre hpre hsuf asuf
  zparseopts -E P:=apre p:=hpre S:=asuf s:=hsuf
  local __k=
  (( ${funcstack[(I)_message]} )) && __k+=m
  (( ${funcstack[(I)(_files|_path_files|_directories|_cd|_default)]} )) && __k+=f
  print -rn -- $'\x01'"K${__k}"$'\n'
  integer dirsuf=0
  [[ -z $hsuf && "${${@//-default-/}% -# *}" == *-[[:alnum:]]#f* ]] && dirsuf=1
  local __h __d
  for __h in $__hits; do
    (( dirsuf )) && [[ -d $__h ]] && __d=/ || __d=
    print -rn -- $'\x01'"H$IPREFIX$apre$hpre$__h$__d$hsuf$asuf"$'\n'
  done
}
_w_cd() { builtin cd -q -- $BUFFER 2>/dev/null; BUFFER=; print -rn -- $'\x01WDONE\n' }
zle -N _w_cd
bindkey '^X^D' _w_cd
print -rn -- $'\x01WREADY\n'
INIT
zpty -w __w "source ${(q)__winit}"
zpty -r __w __o $'*\x01WREADY*' || { print -r -- X; exit 1 }
rm -f $__winit
print -r -- R
__req= __buf= __out= __line=
while IFS= read -r __req; do
  case $__req in
    (Q*)
      eval "__buf=${__req#Q}"
      zpty -w -n __w "$__buf"$'\t'
      zpty -r __w __out $'*\x01WEND*'
      zpty -w -n __w $'\x15'
      for __line in ${(f)__out}; do
        __line=${__line%$'\r'}
        [[ $__line == $'\x01'(H|K)* ]] && print -r -- ${__line#$'\x01'}
      done
      print -r -- E ;;
    (C*)
      eval "__buf=${__req#C}"
      (( $+_comps[$__buf] )) && print -r -- C1 || print -r -- C0
      print -r -- E ;;
    (D*)
      eval "__buf=${__req#D}"
      builtin cd -q -- $__buf 2>/dev/null
      zpty -w -n __w "$__buf"$'\x18\x04'
      zpty -r __w __out $'*\x01WDONE*'
      print -r -- E ;;
  esac
done
zpty -d __w
"""#

/// How long the ghost completion may wait on zsh before the directory listing answers instead.
let shellCompletionGhostBudget: TimeInterval = 0.15
