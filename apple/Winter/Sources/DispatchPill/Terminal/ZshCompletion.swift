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

/// PURE: does the position whose completion is `capture` take `word`? `optionsHere` answers whether options
/// are offered at the position (asked only for a `-word` that is not itself a candidate).
func zshPositionAccepts(_ word: ShellWord, capture: ZshCompletionCapture, pathExists: Bool,
                        optionsHere: () -> Bool) -> Bool {
    if word.hasExpansion { return true } // its value is unknown until run time — not judged
    if capture.contains(word.text) { return true }
    if capture.kinds.contains(.message) { return true }
    if capture.kinds.contains(.files), pathExists { return true }
    if word.text.hasPrefix("-"), !word.wasQuoted, optionsHere() { return true }
    return false
}

// MARK: - The prose guard (pure)

/// PURE: a command with no completion function is NOT one when its line ends like a sentence (`?`, `.`, `!`,
/// `,`) or it has three or more PLAIN words after the command — words that are not flags, paths, existing
/// files, URLs, quoted strings or `=` assignments (pipes and redirections are not words at all).
func shellProseGuardRejects(lineEndsSimpleCommand: Bool, line: String, arguments: [ShellWord],
                            pathExists: (ShellWord) -> Bool) -> Bool {
    if lineEndsSimpleCommand,
       let last = line.trimmingCharacters(in: .whitespacesAndNewlines).last, "?.!,".contains(last) {
        return true
    }
    let plain = arguments.filter { word in
        !(word.wasQuoted || word.hasExpansion || word.text.hasPrefix("-") || shellLooksLikePath(word)
          || word.text.contains("://") || word.text.contains("=") || pathExists(word))
    }
    return plain.count >= 3
}

// MARK: - The source the validator asks

/// What the whole-command check asks zsh. The live one is `ZshCompletionEngine`; tests hand in a dictionary.
protocol ShellCompletionSource: AnyObject {
    /// The completion for the line `buffer` with the cursor at its end, run in `directory`. Nil when it could
    /// not be had before `deadline` (or the engine is unavailable).
    func capture(buffer: String, directory: String, deadline: Date) -> ZshCompletionCapture?
    /// Whether `command` has a completion function. Nil when unknown before `deadline`.
    func hasCompletionFunction(_ command: String, deadline: Date) -> Bool?
}

/// How long one whole-command check may take before it falls back to the prose guard.
let shellCompletionCheckBudget: TimeInterval = 0.3

/// PURE (given its source): the whole-command check, run AFTER `shellLineIsCommand` said yes. For every simple
/// command: with a completion function, every word after the command must be taken by its position
/// (`zshPositionAccepts`); without one — or when zsh cannot answer in time — the prose guard decides.
/// Lines with compound structure (`if`/`for`/`{`/`(`, several lines) are left to the structural rules.
func shellCompletionCheckPasses(_ line: String, context: ShellCommandContext, source: ShellCompletionSource?,
                                deadline: Date) -> Bool {
    guard case .complete(let tokens) = shellTokenize(line) else { return false }
    let chars = Array(line)

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
        guard !arguments.isEmpty else { continue }
        guard let source, !head.hasExpansion,
              let hasFunction = source.hasCompletionFunction(head.text, deadline: deadline) else {
            if guardRejects() { return false }
            continue
        }
        guard hasFunction else {
            if guardRejects() { return false }
            continue
        }
        for word in arguments {
            let buffer = String(chars[0..<min(word.end, chars.count)])
            guard let capture = source.capture(buffer: buffer, directory: context.workingDirectory, deadline: deadline) else {
                // zsh could not answer in time: the prose guard decides this command.
                if guardRejects() { return false }
                break
            }
            let accepted = zshPositionAccepts(word, capture: capture, pathExists: exists(word)) {
                let optionBuffer = String(chars[0..<min(word.start, chars.count)]) + "-"
                return source.capture(buffer: optionBuffer, directory: context.workingDirectory,
                                      deadline: deadline)?.offersOptions ?? true
            }
            if !accepted { return false }
        }
    }
    return true
}

// MARK: - The engine

/// The zsh that answers: see this file's header. Thread-safe — one query at a time, under a lock; every reply
/// is memoized per (directory, buffer), so typing a line asks zsh about each new prefix once.
final class ZshCompletionEngine: ShellCompletionSource, @unchecked Sendable {
    let zshPath: String
    private let environment: [String: String]

    private let lock = NSLock()
    private var process: Process?
    private var input: FileHandle?
    private var outputDescriptor: Int32 = -1
    private var pending = Data()
    private var directory: String?
    /// After a failed start, when to try again (a missing zsh/zpty is not retried on every keystroke).
    private var retryAfter = Date.distantPast
    private var captures: [String: ZshCompletionCapture] = [:]
    private var functions: [String: Bool] = [:]
    static let memoLimit = 2048
    /// How long a cold start (zsh, compinit, the inner shell) may take.
    static let startTimeout: TimeInterval = 3

    /// - Parameter environment: what the background zsh sees — the PATH completion functions run tools from
    ///   (`git`, `make`…), HOME. Never the app's own variables.
    init(zshPath: String = "/bin/zsh", environment: [String: String]) {
        self.zshPath = zshPath
        self.environment = environment
    }

    deinit { stopLocked() }

    /// Starts the engine in the background now (it is otherwise started by the first query).
    func warmUp() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            _ = self.ensureRunningLocked()
        }
    }

    /// True once the engine has started and answered (tests skip on false).
    func isAvailable() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return ensureRunningLocked()
    }

    func capture(buffer: String, directory: String, deadline: Date) -> ZshCompletionCapture? {
        guard let escaped = zshEngineQuoted(buffer) else { return nil }
        lock.lock(); defer { lock.unlock() }
        let key = directory + "\u{0}" + buffer
        if let cached = captures[key] { return cached }
        guard ensureRunningLocked() else { return nil }
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
        guard let escaped = zshEngineQuoted(command) else { return nil }
        lock.lock(); defer { lock.unlock() }
        if let cached = functions[command] { return cached }
        guard ensureRunningLocked(), let lines = requestLocked("C" + escaped, deadline: deadline) else { return nil }
        let has = lines.contains { $0.hasPrefix("C1") }
        functions[command] = has
        return has
    }

    // MARK: Process

    private func ensureRunningLocked() -> Bool {
        if let process, process.isRunning { return true }
        stopLocked()
        guard Date() >= retryAfter, FileManager.default.isExecutableFile(atPath: zshPath) else { return false }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: zshPath)
        process.arguments = ["-f", "-c", zshCompletionEngineScript]
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: environment["HOME"] ?? NSHomeDirectory())
        let stdin = Pipe(), stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch {
            retryAfter = Date().addingTimeInterval(60)
            NSLog("[DispatchPill] completion engine: could not start zsh")
            return false
        }
        // A write to an engine that died must fail, never SIGPIPE the app.
        _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        self.process = process
        input = stdin.fileHandleForWriting
        outputDescriptor = stdout.fileHandleForReading.fileDescriptor
        pending = Data()
        directory = nil
        guard let ready = readLineLocked(deadline: Date().addingTimeInterval(Self.startTimeout)), ready == "R" else {
            stopLocked()
            retryAfter = Date().addingTimeInterval(60)
            NSLog("[DispatchPill] completion engine: unavailable (no zsh/zpty, or it did not start in time)")
            return false
        }
        NSLog("[DispatchPill] completion engine: started")
        return true
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

    /// One request → its reply lines up to `E`. A timeout or a dead engine stops it (the next query starts a
    /// fresh one) and answers nil.
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
        guard wrote else { stopLocked(); return nil }
        var lines: [String] = []
        while true {
            guard let line = readLineLocked(deadline: deadline) else {
                stopLocked()
                return nil
            }
            if line == "E" { return lines }
            lines.append(line)
        }
    }

    private func readLineLocked(deadline: Date) -> String? {
        while true {
            if let newline = pending.firstIndex(of: 0x0A) {
                let line = pending[pending.startIndex..<newline]
                pending.removeSubrange(pending.startIndex...newline)
                return String(decoding: line, as: UTF8.self)
            }
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0, outputDescriptor >= 0 else { return nil }
            var descriptor = pollfd(fd: outputDescriptor, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, Int32(max(1, remaining * 1000)))
            if ready < 0, errno == EINTR { continue }
            guard ready > 0 else { return nil }
            var buffer = [UInt8](repeating: 0, count: 16_384)
            let count = read(outputDescriptor, &buffer, buffer.count)
            guard count > 0 else { return nil }
            pending.append(buffer, count: count)
        }
    }

    // MARK: Test seams

    var cachedCaptureCountForTesting: Int {
        lock.lock(); defer { lock.unlock() }
        return captures.count
    }
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
zmodload zsh/zpty 2>/dev/null || { print -r -- X; exit 1 }
autoload -Uz compinit && compinit -C -D 2>/dev/null
zpty __w /bin/zsh -f -i || { print -r -- X; exit 1 }
__winit=$(mktemp -t winter-compcap) || exit 1
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
