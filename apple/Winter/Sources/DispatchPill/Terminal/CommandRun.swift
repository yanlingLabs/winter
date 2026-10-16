import AppKit
import Combine
import Darwin
import SwiftTerm

// A command the user ran from the Dispatch pill: a real PTY running their login shell, in the Mac app's own
// process (never the daemon's), with no Winter sandbox and no approval — it is the user's own action, as if
// typed in their terminal. The run is a TERMINAL TAB: an interactive login shell that runs the typed line first
// and then stays at its prompt (`loginShellSessionInvocation`), so the window is a terminal the user can keep
// typing in. The shell marks where the line's output starts and ends (OSC 133 `C`/`D;<status>`), which is how
// the pill knows the line's own exit status while the shell lives on. The terminal view belongs to the RUN, not
// to a window: closing the window keeps the shell (and the scrollback), and reopening it hosts the same view.
//
// Nothing here logs the command line or its output.

/// The terminal emulator, with the output tap, the keyboard tap and the exit report the run needs.
final class WinterTerminalView: LocalProcessTerminalView {
    var onData: ((ArraySlice<UInt8>) -> Void)?
    var onInput: ((ArraySlice<UInt8>) -> Void)?
    var onExit: ((Int32?) -> Void)?

    // The keyboard: a click anywhere in the terminal makes it the window's first responder (SwiftUI's hosting view
    // around it would otherwise keep it), and it takes the first click of a window that isn't key yet.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if window?.firstResponder !== self { window?.makeFirstResponder(self) }
        super.mouseDown(with: event)
    }

    override func dataReceived(slice: ArraySlice<UInt8>) {
        onData?(slice)
        super.dataReceived(slice: slice)
    }

    /// What the user types (and what the emulator answers to queries) on its way to the shell.
    override func send(source: TerminalView, data: ArraySlice<UInt8>) {
        onInput?(data)
        super.send(source: source, data: data)
    }

    override func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
        super.processTerminated(source, exitCode: exitCode)
        onExit?(exitCode)
    }
}

/// Where a run's line is: before it started (the shell's startup), running, or done with the shell still there.
enum CommandRunPhase: Equatable {
    case startup, command, shell
}

@MainActor
final class CommandRun: ObservableObject, Identifiable {
    let id = UUID()
    /// The line as the user typed it — EMPTY for a terminal opened with no line of its own (`/terminal`).
    let command: String
    /// A terminal opened with no line (`/terminal`): a plain interactive login shell.
    var isTerminal: Bool { command.isEmpty }
    /// The shell's name (`zsh`), for a terminal's label.
    let shellName: String
    /// What the pill and the window call the run: `$ line`, or "Terminal" for a terminal.
    var displayTitle: String { isTerminal ? "Terminal" : "$ " + command }
    let workingDirectory: String
    let homeDirectory: String
    /// The dispatch session the command was typed into, or nil when there was none — see
    /// `commandTranscriptTarget` for where "Add to transcript" goes.
    let sessionId: String?
    /// For a run that recorded none: the conversation its FIRST "Add to transcript" went to (or created) — every
    /// later click goes there too.
    var pinnedSessionId: String?
    /// The line has not started `waitingNoticeAfter` into the run: the shell's startup may have bypassed Winter's
    /// shim. The terminal window then says so and offers "Type it"; NOTHING is typed for the user.
    @Published private(set) var needsManualStart = false
    /// The user clicked "Type it": the line went in as typed keys, so its own status is not known.
    @Published private(set) var typedByHand = false
    /// The run's mark tag (`loginShellMarkTag`).
    let nonce: String
    /// The SHELL's outcome: `.running` for as long as the session lives.
    @Published private(set) var outcome: CommandRunOutcome = .running
    /// The LINE's outcome: `.running` until the shell's `D` mark (or the shell's end, if that comes first).
    @Published private(set) var commandOutcome: CommandRunOutcome = .running
    let terminalView: WinterTerminalView
    /// The process group the run started — forkpty made the shell a SESSION leader, so its pid is also the
    /// session's id: every job the shell starts (each in a process group of its own) stays in that session, and End
    /// and quit kill the whole session (`CommandRunSession`).
    private(set) var processGroup: pid_t?
    /// The run's terminal session, pinned to its leader's start time (a pid alone may be reused).
    private(set) var session: CommandRunSession?
    private(set) var phase = CommandRunPhase.startup
    /// The user pressed Return in the shell after the line ended — "Add to transcript" then sends the session.
    private(set) var typedAfterCommand = false

    /// The line's output (between its `C` and `D` marks), and the session's tail from the line's start on.
    private var commandCapture = CapturedOutput(limit: TerminalTranscriptLimits.maxCapturedBytes)
    private var sessionCapture = CapturedOutput(limit: TerminalTranscriptLimits.maxCapturedBytes)
    private var scanner: TerminalSemanticMarkScanner
    /// The startup shim's private folder — kept until the run ends (the line may still start late), removed then
    /// or on quit.
    private(set) var shimDirectory: String?
    private var launchedAt = Date()
    /// Every write the app itself made into the terminal (only ever "Type it"'s) — counted for the tests.
    private(set) var appWrites = 0

    /// How long into the run, with no start mark, before the window offers "Type it".
    static var waitingNoticeAfter: TimeInterval = 5

    /// `launch: false` builds the run without starting a process (tests — no test runs the user's shell).
    init(command: String, workingDirectory: String, environment: CommandLineEnvironment, sessionId: String? = nil,
         launch: Bool = true) {
        self.command = command
        self.workingDirectory = workingDirectory
        self.homeDirectory = environment.homeDirectory
        self.sessionId = sessionId
        self.shellName = (environment.shell as NSString).lastPathComponent
        let nonce = loginShellRunNonce()
        self.nonce = nonce
        scanner = TerminalSemanticMarkScanner(tag: loginShellMarkTag(nonce))
        let view = WinterTerminalView(frame: NSRect(x: 0, y: 0, width: 760, height: 420),
                                      font: Typography.terminalNS,
                                      options: TerminalOptions(scrollback: 10_000))
        TerminalStyle.apply(to: view)
        terminalView = view
        view.onData = { [weak self] slice in
            MainActor.assumeIsolated { self?.capture(slice) }
        }
        view.onInput = { [weak self] data in
            MainActor.assumeIsolated { self?.noteInput(data) }
        }
        view.onExit = { [weak self] status in
            MainActor.assumeIsolated { self?.finish(status) }
        }

        if command.isEmpty {
            // No line to wait for: the shell is the whole thing from the start.
            phase = .shell
            commandOutcome = .interactive
        }
        guard launch else { return }
        guard let shim = commandRunMakeShimDirectory() else {
            outcome = .failedToStart
            commandOutcome = .failedToStart
            return
        }
        shimDirectory = shim
        let invocation = loginShellSessionInvocation(shell: environment.shell, line: command, shimDirectory: shim,
                                                     nonce: nonce)
        for (name, contents) in invocation.files {
            let path = shim + "/" + name
            guard FileManager.default.createFile(atPath: path, contents: Data(contents.utf8),
                                                 attributes: [.posixPermissions: 0o600]) else {
                removeShim()
                outcome = .failedToStart
                commandOutcome = .failedToStart
                return
            }
        }
        let env = environment.runEnvironment.merging(invocation.environment) { _, new in new }
            .map { "\($0.key)=\($0.value)" }
        let startedAt = commandRunNowMicros()
        view.startProcess(executable: invocation.executable, args: invocation.arguments, environment: env,
                          execName: nil, currentDirectory: workingDirectory)
        guard view.process.running else {
            removeShim()
            outcome = .failedToStart
            commandOutcome = .failedToStart
            return
        }
        processGroup = view.process.shellPid > 0 ? view.process.shellPid : nil
        if let leader = processGroup {
            session = CommandRunSession(leader: leader, leaderStart: CommandRunProcessTable.live.startMicros(leader),
                                        runStart: startedAt)
        }
        // This run's pty master must not leak into the NEXT run's (or any other) child.
        shellSetCloseOnExec(view.process.childfd)
        launchedAt = Date()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.waitingNoticeAfter + 0.1) { [weak self] in
            self?.checkStarted(now: Date())
        }
    }

    // MARK: A line the shell did not start

    /// No start mark `waitingNoticeAfter` into the run: say so (the window offers "Type it"). Nothing is typed,
    /// nothing fails, the shim stays — the line may still start late, and then the notice goes.
    func checkStarted(now: Date) {
        guard phase == .startup, outcome == .running, !typedByHand,
              now.timeIntervalSince(launchedAt) >= Self.waitingNoticeAfter else { return }
        needsManualStart = true
    }

    /// "Type it": the USER's click puts the line itself, and Return, into the terminal — once. The shim is told
    /// (`loginShellTypedMarkerFile`), so it never runs the line as well.
    func typeLineByHand() {
        guard needsManualStart, !typedByHand, phase == .startup, outcome == .running else { return }
        if let shimDirectory {
            FileManager.default.createFile(atPath: shimDirectory + "/" + loginShellTypedMarkerFile, contents: Data(),
                                           attributes: [.posixPermissions: 0o600])
            try? FileManager.default.removeItem(atPath: shimDirectory + "/" + loginShellLineFile)
        }
        typedByHand = true
        needsManualStart = false
        commandOutcome = .typedByHand
        appWrites += 1
        if terminalView.process.running { terminalView.process.send(data: Array((command + "\r").utf8)[...]) }
    }

    /// Still no `C` mark: once the shell has been up `fallbackAfter` since its first output and quiet for
    /// `fallbackQuiet`, type the fallback (it runs the line unless it already started); if THAT has not started it
    /// within `fallbackGiveUp`, the line failed — never left `.running`.


    /// The shell is still there after its line ended — the pill's "live shell" state.
    var shellIsLive: Bool { outcome == .running && commandOutcome.isFinished }

    /// Stop the LINE, as Ctrl-C would: an interrupt to whatever runs in the foreground. The shell stays.
    func interrupt() {
        guard outcome == .running, terminalView.process.running else { return }
        terminalView.process.send(data: [0x03][...])
    }

    /// End the SHELL and everything it started: every process in its terminal SESSION — the shell, the foreground
    /// job, background jobs in process groups of their own, ones that ignore SIGHUP — is hung up now and killed a
    /// moment later, whether or not the shell has gone by then. (An interactive shell ignores SIGTERM; it ends on
    /// SIGHUP.)
    func endShell() {
        guard let session else { return }
        session.signal(SIGHUP)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.5) {
            session.signal(SIGKILL)
        }
    }

    /// The process group in the terminal's foreground (a job the shell started), when there is one.
    func foregroundGroup() -> pid_t? {
        let fd = terminalView.process.childfd
        guard fd >= 0 else { return nil }
        let group = tcgetpgrp(fd)
        return group > 0 ? group : nil
    }

    /// The terminal has printed anything at all (the session capture is never empty once it has).
    var hasOutput: Bool { sessionCapture.count > 0 || commandCapture.count > 0 }

    /// What "Add to transcript" sends: the line and its own output — or, once the user has gone on typing in the
    /// shell, the session's tail from the line's start (the later commands and their output included).
    var transcriptScope: TerminalTranscriptScope { typedAfterCommand || isTerminal ? .session : .command }

    /// The paths on screen in the app the user is in, for the shell's autosuggestions: written — the PATHS only,
    /// never the screen's text — to `paths` (0600) in the run's private shim folder, which goes with the run.
    func writeOnScreenPaths(_ paths: [String]) {
        guard let shimDirectory, outcome == .running else { return }
        let clean = paths.filter { !$0.contains("\n") && !$0.contains("\0") }
        let target = shimDirectory + "/" + loginShellOnScreenPathsFile
        let staging = target + ".new"
        guard FileManager.default.createFile(atPath: staging, contents: Data(clean.joined(separator: "\n").utf8),
                                             attributes: [.posixPermissions: 0o600]) else { return }
        _ = rename(staging, target)
    }

    /// The message "Add to transcript" sends.
    func transcriptMessage() -> String {
        // A shell that never marked the line's start (an old fish, a startup that died) gets everything it printed.
        let bytes = phase == .startup || transcriptScope == .session ? sessionCapture.bytes() : commandCapture.bytes()
        return terminalTranscriptMessage(command: command, workingDirectory: workingDirectory, home: homeDirectory,
                                         outcome: commandOutcome, output: terminalCappedOutput(terminalPlainText(bytes)),
                                         scope: transcriptScope)
    }

    private func capture(_ slice: ArraySlice<UInt8>) {
        var start = slice.startIndex
        for (end, mark) in scanner.feed(slice) {
            route(slice[start..<end])
            handle(mark)
            start = end
        }
        route(slice[start...])
    }

    private func route(_ bytes: ArraySlice<UInt8>) {
        guard !bytes.isEmpty else { return }
        sessionCapture.append(bytes)
        if phase == .command { commandCapture.append(bytes) }
    }

    private func handle(_ mark: TerminalSemanticMark) {
        switch (mark, phase) {
        case (.commandStart, .startup) where !typedByHand:
            phase = .command
            needsManualStart = false
            // What the startup files printed is not the line's — the session capture starts here.
            sessionCapture = CapturedOutput(limit: TerminalTranscriptLimits.maxCapturedBytes)
        case (.commandEnd(let status), .command):
            phase = .shell
            commandOutcome = .exited(status ?? 0)
        default:
            break // a later command's marks (the user's own shell integration) are not the line's
        }
    }

    private func noteInput(_ data: ArraySlice<UInt8>) {
        guard phase == .shell, !typedAfterCommand, data.contains(0x0D) || data.contains(0x0A) else { return }
        typedAfterCommand = true
    }

    private func finish(_ status: Int32?) {
        guard outcome == .running else { return }
        removeShim()
        let ended = status.map(commandRunOutcome(waitStatus:)) ?? .signaled(SIGKILL)
        outcome = ended
        // The shell went before the line reported (it ran `exit`, or something killed it): the shell's end is the line's.
        if commandOutcome == .running { commandOutcome = ended }
    }

    /// The app is quitting: the shim folder goes now.
    func cleanUpForQuit() { removeShim() }

    private func removeShim() {
        guard let shimDirectory else { return }
        self.shimDirectory = nil
        try? FileManager.default.removeItem(atPath: shimDirectory)
    }

    // MARK: Test seams (a run built with `launch: false`)

    func feedForTesting(_ bytes: [UInt8]) { capture(bytes[...]) }
    /// The session's tail as plain text.
    var sessionTextForTesting: String { terminalPlainText(sessionCapture.bytes()) }
    /// The screen's rows around the cursor's — `rows` up to it and `after` past it (a suggestion may wrap on) —
    /// as the emulator holds them, joined (a wrapped line reads whole).
    func screenTailForTesting(rows: Int = 3, after: Int = 0) -> String {
        let terminal = terminalView.getTerminal()
        let y = terminal.getCursorLocation().y
        return (max(0, y - rows + 1)...(y + after)).compactMap { terminal.getLine(row: $0)?.translateToString(trimRight: true) }
            .joined()
    }
    /// A run's own marks, as its shell writes them.
    func startMarkForTesting() -> String { "\u{1B}]133;C;\(loginShellMarkTag(nonce))\u{07}" }
    func endMarkForTesting(_ status: Int32) -> String { "\u{1B}]133;D;\(status);\(loginShellMarkTag(nonce))\u{07}" }
    func finishForTesting(waitStatus: Int32?) { finish(waitStatus) }
    /// Keys typed into the terminal, as the emulator hands them to the shell.
    func typeForTesting(_ text: String) {
        let bytes = Array(text.utf8)
        noteInput(bytes[...])
        if terminalView.process.running { terminalView.process.send(data: bytes[...]) }
    }
}

/// Microseconds since 1970, now.
func commandRunNowMicros() -> UInt64 {
    var now = timeval()
    gettimeofday(&now, nil)
    return UInt64(now.tv_sec) * 1_000_000 + UInt64(now.tv_usec)
}

/// What the session killer may ask about processes — the live one is libproc; tests hand in a table.
struct CommandRunProcessTable: Sendable {
    var allPids: @Sendable () -> [pid_t]
    var sessionId: @Sendable (pid_t) -> pid_t?
    /// A process's start time, in microseconds since 1970, or nil when it is gone.
    var startMicros: @Sendable (pid_t) -> UInt64?
    var send: @Sendable (pid_t, Int32) -> Void

    static let live = CommandRunProcessTable(
        allPids: {
            let count = proc_listallpids(nil, 0)
            guard count > 0 else { return [] }
            var pids = [pid_t](repeating: 0, count: Int(count) + 64)
            let got = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
            return got > 0 ? Array(pids.prefix(Int(got))) : []
        },
        sessionId: { pid in
            let sid = getsid(pid)
            return sid > 0 ? sid : nil
        },
        startMicros: { pid in
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
            return UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
        },
        send: { pid, signal in kill(pid, signal) })
}

/// A run's terminal SESSION: its leader's pid (the session id), when the leader started, and when the run began.
/// A pid can be reused once its process is gone — by another terminal's, tmux's or ssh's session leader — so the
/// session is only ever signalled while it is provably the run's (`targets`).
struct CommandRunSession: Hashable, Sendable {
    let leader: pid_t
    /// The leader's own start time (µs since 1970), as read right after it started; nil if it could not be read.
    let leaderStart: UInt64?
    /// When the run began (µs since 1970) — every process of the session started at or after it.
    let runStart: UInt64

    /// PURE (given the table): the processes to signal. The leader still the run's (its pid AND start time
    /// match): every process in the session. The leader gone: only processes still in that session that started
    /// AFTER the run began (the run's orphans) — and nothing at all when another process now holds the leader's
    /// pid (a reused pid: someone else's session).
    func targets(in table: CommandRunProcessTable) -> [pid_t] {
        guard leader > 1 else { return [] }
        let me = getpid()
        let members = table.allPids().filter { $0 > 1 && $0 != me && table.sessionId($0) == leader }
        if let start = table.startMicros(leader) {
            guard let leaderStart, start == leaderStart else { return [] } // the pid is someone else's now
            return members
        }
        return members.filter { pid in (table.startMicros(pid) ?? 0) >= runStart }
    }

    /// `signal` to the session's targets; true when there were any.
    @discardableResult
    func signal(_ signal: Int32, table: CommandRunProcessTable = .live) -> Bool {
        let targets = targets(in: table)
        for pid in targets { table.send(pid, signal) }
        return !targets.isEmpty
    }
}

/// A fresh private folder (0700) for one run's startup shim, in the user's temp directory.
private func commandRunMakeShimDirectory() -> String? {
    let template = (NSTemporaryDirectory() as NSString).appendingPathComponent("winter-shell.XXXXXX")
    var buffer = Array(template.utf8CString)
    guard mkdtemp(&buffer) != nil else { return nil }
    return String(cString: buffer)
}

/// The tail of a byte stream within `limit`, kept as chunks: appending never copies what is already held,
/// and the oldest whole chunks are dropped once the total passes the limit (the kept tail may start a little
/// before it — never less than `limit` bytes are kept while that many arrived).
struct CapturedOutput {
    let limit: Int
    private var chunks: [[UInt8]] = []
    private var head = 0
    private(set) var count = 0

    init(limit: Int) { self.limit = limit }

    mutating func append(_ slice: ArraySlice<UInt8>) {
        guard !slice.isEmpty else { return }
        chunks.append(Array(slice))
        count += slice.count
        while head < chunks.count - 1, count - chunks[head].count >= limit {
            count -= chunks[head].count
            chunks[head] = []
            head += 1
        }
        // Compact the dropped slots now and then, so the array does not grow without bound.
        if head > 64 {
            chunks.removeFirst(head)
            head = 0
        }
    }

    /// The kept bytes, oldest first, trimmed to at most `limit`.
    func bytes() -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(count)
        for chunk in chunks[head...] { out.append(contentsOf: chunk) }
        return out.count > limit ? Array(out.suffix(limit)) : out
    }
}

/// Where "Add to transcript" sends a run's message.
enum CommandTranscriptTarget: Equatable {
    /// The dispatch session the line was typed into — it still exists.
    case recordedSession(String)
    /// No session existed when the line ran: the pill's CURRENT conversation at click time, through the pill's
    /// own send path (which creates the conversation the way a first message from the pill does).
    case currentConversation
    /// The session the line was typed into has since been deleted.
    case unavailable
}

/// PURE: the rule. A recorded session that still exists gets it; a run that recorded NONE goes to the pill's
/// current conversation; only a recorded session that is gone disables the button.
func commandTranscriptTarget(recordedSessionId: String?, recordedSessionExists: (String) -> Bool) -> CommandTranscriptTarget {
    guard let recordedSessionId else { return .currentConversation }
    return recordedSessionExists(recordedSessionId) ? .recordedSession(recordedSessionId) : .unavailable
}

/// Every command run from the pill, in the order they started. Owns their terminal windows too.
@MainActor
final class CommandRunStore: ObservableObject {
    @Published private(set) var runs: [CommandRun] = []
    /// Finished runs beyond this many are let go (oldest first, never one whose window is open).
    static let maxRuns = 8

    /// Test seam: false builds runs without starting their process.
    var launchesProcesses = true
    /// Test seam: false records the windows it would open instead (no test puts a window on screen).
    var presentsWindows = true
    private(set) var openedWindowsForTesting: [UUID] = []

    /// The on-screen paths the pill holds now (a new run's shell starts with them). Wired by the pill.
    var currentOnScreenPaths: (() -> [String])?
    /// Reads the on-screen paths afresh, then hands them over (a terminal window became key). Wired by the pill.
    var readOnScreenPaths: ((@escaping ([String]) -> Void) -> Void)?

    /// `/terminal`: a plain interactive login shell — no line of its own — in `workingDirectory`, with its window
    /// open at once.
    @discardableResult
    func startTerminal(workingDirectory: String, environment: CommandLineEnvironment, sessionId: String? = nil) -> CommandRun {
        let run = start(command: "", workingDirectory: workingDirectory, environment: environment, sessionId: sessionId)
        openWindow(run.id)
        return run
    }

    /// Sends a run's transcript message to the session it RECORDED — that session's own send path
    /// (`session.send`), never the focused session's. Wired by the app.
    var onSendToTranscript: ((_ sessionId: String, _ text: String) async -> Bool)?
    /// Sends a run's transcript message the way the pill's composer sends a message — to its current
    /// conversation, created if there is none. For a run that recorded no session. Wired by the pill.
    var onSendToCurrentConversation: ((_ text: String) async -> (sent: Bool, sessionId: String?))?
    /// Asked only after a send to a session FAILED: has that session been deleted? (The app re-lists its sessions
    /// to find out.) A yes disables the button for every run that targets it. Being merely absent from the app's
    /// session list is never taken as deleted: that list is refreshed only now and then, and a run's session is
    /// often newer than its last refresh — which is what greyed the button out before.
    var sessionIsGone: ((String) async -> Bool)?
    /// Sessions a failed send proved deleted.
    private(set) var goneSessions: Set<String> = []

    private var windows: [UUID: TerminalWindowController] = [:]
    private var outcomeWatch: [UUID: AnyCancellable] = [:]
    /// Every process group any run started — dismissed and pruned runs included: their background jobs are
    /// stopped on quit too.
    private var launchedSessions: Set<CommandRunSession> = []
    private var quitObserver: NSObjectProtocol?

    init() {
        quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification,
                                                              object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopAllForQuit() }
        }
    }

    deinit {
        if let quitObserver { NotificationCenter.default.removeObserver(quitObserver) }
    }

    /// Start `command` in `workingDirectory` as the user, remembering the dispatch session it came from.
    @discardableResult
    func start(command: String, workingDirectory: String, environment: CommandLineEnvironment,
               sessionId: String? = nil) -> CommandRun {
        let run = CommandRun(command: command, workingDirectory: workingDirectory, environment: environment,
                             sessionId: sessionId, launch: launchesProcesses)
        // The shell's autosuggestions start from what is on screen now.
        run.writeOnScreenPaths(currentOnScreenPaths?() ?? [])
        if let session = run.session { launchedSessions.insert(session) }
        pruneEndedSessions()
        withAnimationIfVisible { runs.append(run) }
        // The pill's state follows the run; the store republishes only so the row re-lays out.
        outcomeWatch[run.id] = run.$outcome.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { self?.prune() }
        }
        prune()
        return run
    }

    func run(_ id: UUID) -> CommandRun? { runs.first { $0.id == id } }

    /// Where the run's "Add to transcript" would go now (`commandTranscriptTarget`).
    func transcriptTarget(_ run: CommandRun) -> CommandTranscriptTarget {
        commandTranscriptTarget(recordedSessionId: run.sessionId ?? run.pinnedSessionId) { [goneSessions] in
            !goneSessions.contains($0)
        }
    }

    /// Why "Add to transcript" cannot be used right now — the disabled button's tooltip — or nil when it can.
    func transcriptUnavailableReason(_ run: CommandRun) -> String? {
        switch transcriptTarget(run) {
        case .unavailable:
            return "The Dispatch session this terminal belongs to has been deleted"
        case .recordedSession where onSendToTranscript == nil, .currentConversation where onSendToCurrentConversation == nil:
            return "Winter isn’t connected to Dispatch yet"
        default:
            break
        }
        return run.hasOutput ? nil : "Nothing to add yet — the terminal has no output"
    }

    /// "Add to transcript" is possible: there is output, a target that is not known to be deleted, and a way to send.
    func canAddToTranscript(_ run: CommandRun) -> Bool { transcriptUnavailableReason(run) == nil }

    /// Sends the run's command and output to its target. False when it cannot (its session is gone, refused).
    func addToTranscript(_ run: CommandRun) async -> Bool {
        switch transcriptTarget(run) {
        case .recordedSession(let sessionId):
            guard let send = onSendToTranscript, run.hasOutput else { return false }
            if await send(sessionId, run.transcriptMessage()) { return true }
            // The send failed: deleted, or just a hiccup? Only a re-list that no longer has it says deleted.
            if await sessionIsGone?(sessionId) == true { goneSessions.insert(sessionId) }
            return false
        case .currentConversation:
            guard let send = onSendToCurrentConversation, run.hasOutput else { return false }
            let result = await send(run.transcriptMessage())
            // The first click's conversation is the run's from now on: later clicks go there, wherever focus is.
            if result.sent, let sessionId = result.sessionId { run.pinnedSessionId = sessionId }
            return result.sent
        case .unavailable:
            return false
        }
    }

    /// A click on a command pill: its terminal window — brought forward when already open.
    func openWindow(_ id: UUID) {
        guard let run = run(id) else { return }
        guard presentsWindows else {
            openedWindowsForTesting.append(id)
            return
        }
        if let open = windows[id] {
            open.bringToFront()
            return
        }
        let controller = TerminalWindowController(
            run: run,
            transcriptUnavailableReason: { [weak self, weak run] in
                guard let self, let run else { return "This terminal has closed" }
                return self.transcriptUnavailableReason(run)
            },
            onAddToTranscript: { [weak self, weak run] in
                guard let self, let run else { return false }
                return await self.addToTranscript(run)
            })
        controller.onClosed = { [weak self] in self?.windows[id] = nil }
        // Back to the terminal: its shell's autosuggestions get the paths on screen in the app the user came from.
        controller.onBecameKey = { [weak self, weak run] in
            guard let self, let run, let read = self.readOnScreenPaths else { return }
            read { [weak run] paths in run?.writeOnScreenPaths(paths) }
        }
        windows[id] = controller
        controller.show()
    }

    func isWindowOpen(_ id: UUID) -> Bool { windows[id] != nil }

    /// The pill's stop control and the window's: Ctrl-C to the running line; the shell stays.
    func stop(_ id: UUID) { run(id)?.interrupt() }

    /// The pill's end control and the window's: the shell goes.
    func endShell(_ id: UUID) { run(id)?.endShell() }

    /// The pill's × on a run whose shell has ended: it leaves the row (and its window closes).
    func dismiss(_ id: UUID) {
        guard let run = run(id), run.outcome.isFinished else { return }
        windows[id]?.close()
        windows[id] = nil
        outcomeWatch[id] = nil
        withAnimationIfVisible { runs.removeAll { $0.id == id } }
    }

    /// Too many runs: the oldest finished ones with no window open go.
    private func prune() {
        while runs.count > Self.maxRuns,
              let oldest = runs.first(where: { $0.outcome.isFinished && windows[$0.id] == nil }) {
            outcomeWatch[oldest.id] = nil
            withAnimationIfVisible { runs.removeAll { $0.id == oldest.id } }
        }
    }

    /// The app is quitting: nothing any run started may outlive it — running or finished, its whole process
    /// group (background jobs included) is hung up, then killed after a short grace.
    private func stopAllForQuit() {
        runs.forEach { $0.cleanUpForQuit() }
        Self.stopSessions(&launchedSessions, table: .live)
    }

    /// Quit: every session any run started that is still provably its own (`CommandRunSession.targets`) — running
    /// or finished, dismissed included — is hung up, then killed after a short grace. Sessions with nothing left
    /// are forgotten.
    static func stopSessions(_ sessions: inout Set<CommandRunSession>, table: CommandRunProcessTable,
                             grace: TimeInterval = 0.2) {
        sessions = sessions.filter { !$0.targets(in: table).isEmpty }
        guard !sessions.isEmpty else { return }
        for session in sessions { session.signal(SIGHUP, table: table) }
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline {
            if sessions.allSatisfy({ $0.targets(in: table).isEmpty }) { sessions.removeAll(); return }
            usleep(20_000)
        }
        for session in sessions { session.signal(SIGKILL, table: table) }
        sessions = sessions.filter { !$0.targets(in: table).isEmpty }
    }

    /// Sessions with no process left are forgotten — their leader's pid may be reused by anyone.
    private func pruneEndedSessions() {
        launchedSessions = launchedSessions.filter { !$0.targets(in: .live).isEmpty }
    }

    private func withAnimationIfVisible(_ change: () -> Void) {
        commandPillRowAnimated(change)
    }

    // MARK: Test seams

    var launchedSessionsForTesting: Set<CommandRunSession> { launchedSessions }
}

/// The terminal's look: Winter's brand tokens, resolved in the dark appearance (the window is dark whatever
/// the system says, and SwiftTerm reads colour components when they are set).
enum TerminalStyle {
    /// The sixteen ANSI colours, in order (black … bright white) — `docs/brand.md` § 3.9.
    static let ansiColorNames = [
        "TerminalBlack", "TerminalRed", "TerminalGreen", "TerminalYellow",
        "TerminalBlue", "TerminalMagenta", "TerminalCyan", "TerminalWhite",
        "TerminalBrightBlack", "TerminalBrightRed", "TerminalBrightGreen", "TerminalBrightYellow",
        "TerminalBrightBlue", "TerminalBrightMagenta", "TerminalBrightCyan", "TerminalBrightWhite",
    ]
    /// Inside the window's black, around the text grid.
    static let padding = NSEdgeInsets(top: 4, left: 14, bottom: 12, right: 8)

    @MainActor
    static func apply(to view: TerminalView) {
        let colors = ansiColorNames.map { name -> SwiftTerm.Color in
            let rgb = resolved(name)
            return SwiftTerm.Color(red: UInt16(rgb.redComponent * 65535), green: UInt16(rgb.greenComponent * 65535),
                                   blue: UInt16(rgb.blueComponent * 65535))
        }
        view.installColors(colors)
        view.nativeBackgroundColor = .black
        view.nativeForegroundColor = resolved("TextSecondary")
        view.caretColor = resolved("AccentColor")
        view.selectedTextBackgroundColor = resolved("SelectionPill")
        view.optionAsMetaKey = true
    }

    /// A catalog colour's dark half, as concrete sRGB components.
    static func resolved(_ name: String) -> NSColor {
        var color = NSColor.white
        NSAppearance(named: .darkAqua)?.performAsCurrentDrawingAppearance {
            color = (NSColor(named: name) ?? .white).usingColorSpace(.sRGB) ?? .white
        }
        return color
    }
}
