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
    /// The line as the user typed it.
    let command: String
    let workingDirectory: String
    let homeDirectory: String
    /// The dispatch session the command was typed into, or nil when there was none — see
    /// `commandTranscriptTarget` for where "Add to transcript" goes.
    let sessionId: String?
    /// The SHELL's outcome: `.running` for as long as the session lives.
    @Published private(set) var outcome: CommandRunOutcome = .running
    /// The LINE's outcome: `.running` until the shell's `D` mark (or the shell's end, if that comes first).
    @Published private(set) var commandOutcome: CommandRunOutcome = .running
    let terminalView: WinterTerminalView
    /// The process group the run started (forkpty made the shell a session leader, so its pid is the group's) —
    /// kept after it finishes: background jobs it left behind are still that group.
    private(set) var processGroup: pid_t?
    private(set) var phase = CommandRunPhase.startup
    /// The user pressed Return in the shell after the line ended — "Add to transcript" then sends the session.
    private(set) var typedAfterCommand = false

    /// The line's output (between its `C` and `D` marks), and the session's tail from the line's start on.
    private var commandCapture = CapturedOutput(limit: TerminalTranscriptLimits.maxCapturedBytes)
    private var sessionCapture = CapturedOutput(limit: TerminalTranscriptLimits.maxCapturedBytes)
    private var scanner = TerminalSemanticMarkScanner()
    /// The startup shim's private folder — the shell deletes it itself; this is the backstop.
    private var shimDirectory: String?

    /// `launch: false` builds the run without starting a process (tests — no test runs the user's shell).
    init(command: String, workingDirectory: String, environment: CommandLineEnvironment, sessionId: String? = nil,
         launch: Bool = true) {
        self.command = command
        self.workingDirectory = workingDirectory
        self.homeDirectory = environment.homeDirectory
        self.sessionId = sessionId
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

        guard launch else { return }
        guard let shim = commandRunMakeShimDirectory() else {
            outcome = .failedToStart
            commandOutcome = .failedToStart
            return
        }
        shimDirectory = shim
        let invocation = loginShellSessionInvocation(shell: environment.shell, line: command, shimDirectory: shim)
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
        view.startProcess(executable: invocation.executable, args: invocation.arguments, environment: env,
                          execName: nil, currentDirectory: workingDirectory)
        guard view.process.running else {
            removeShim()
            outcome = .failedToStart
            commandOutcome = .failedToStart
            return
        }
        processGroup = view.process.shellPid > 0 ? view.process.shellPid : nil
        // This run's pty master must not leak into the NEXT run's (or any other) child.
        shellSetCloseOnExec(view.process.childfd)
    }

    /// The shell is still there after its line ended — the pill's "live shell" state.
    var shellIsLive: Bool { outcome == .running && commandOutcome.isFinished }

    /// Stop the LINE, as Ctrl-C would: an interrupt to whatever runs in the foreground. The shell stays.
    func interrupt() {
        guard outcome == .running, terminalView.process.running else { return }
        terminalView.process.send(data: [0x03][...])
    }

    /// End the SHELL: hang up its group and the terminal's foreground job, and kill them if they are still there
    /// a moment later. (An interactive shell ignores SIGTERM; it ends on SIGHUP, hanging up its jobs.)
    func endShell() {
        guard outcome == .running, let group = processGroup else { return }
        let foreground = foregroundGroup()
        for target in Set([group, foreground].compactMap { $0 }) {
            kill(-target, SIGHUP)
            kill(-target, SIGTERM)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.outcome == .running else { return }
            for target in Set([group, foreground].compactMap { $0 }) { kill(-target, SIGKILL) }
        }
    }

    /// The process group in the terminal's foreground (a job the shell started), when there is one.
    func foregroundGroup() -> pid_t? {
        let fd = terminalView.process.childfd
        guard fd >= 0 else { return nil }
        let group = tcgetpgrp(fd)
        return group > 0 ? group : nil
    }

    /// What "Add to transcript" sends: the line and its own output — or, once the user has gone on typing in the
    /// shell, the session's tail from the line's start (the later commands and their output included).
    var transcriptScope: TerminalTranscriptScope { typedAfterCommand ? .session : .command }

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
        case (.commandStart, .startup):
            phase = .command
            // What the startup files printed is not the line's — the session capture starts here.
            sessionCapture = CapturedOutput(limit: TerminalTranscriptLimits.maxCapturedBytes)
        case (.commandEnd(let status), .command):
            phase = .shell
            commandOutcome = .exited(status ?? 0)
            removeShim()
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

    private func removeShim() {
        guard let shimDirectory else { return }
        self.shimDirectory = nil
        try? FileManager.default.removeItem(atPath: shimDirectory)
    }

    // MARK: Test seams (a run built with `launch: false`)

    func feedForTesting(_ bytes: [UInt8]) { capture(bytes[...]) }
    func finishForTesting(waitStatus: Int32?) { finish(waitStatus) }
    /// Keys typed into the terminal, as the emulator hands them to the shell.
    func typeForTesting(_ text: String) {
        let bytes = Array(text.utf8)
        noteInput(bytes[...])
        if terminalView.process.running { terminalView.process.send(data: bytes[...]) }
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

    /// Sends a run's transcript message to the session it RECORDED — that session's own send path
    /// (`session.send`), never the focused session's. Wired by the app.
    var onSendToTranscript: ((_ sessionId: String, _ text: String) async -> Bool)?
    /// Sends a run's transcript message the way the pill's composer sends a message — to its current
    /// conversation, created if there is none. For a run that recorded no session. Wired by the pill.
    var onSendToCurrentConversation: ((_ text: String) async -> Bool)?
    /// Whether a session still exists (the app's directory). A recorded session that is gone disables the button.
    var sessionExists: ((String) -> Bool)?

    private var windows: [UUID: TerminalWindowController] = [:]
    private var outcomeWatch: [UUID: AnyCancellable] = [:]
    /// Every process group any run started — dismissed and pruned runs included: their background jobs are
    /// stopped on quit too.
    private var launchedGroups: Set<pid_t> = []
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
        if let group = run.processGroup { launchedGroups.insert(group) }
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
        commandTranscriptTarget(recordedSessionId: run.sessionId) { [sessionExists] in sessionExists?($0) ?? false }
    }

    /// "Add to transcript" is possible: there is a target, and a way to send to it.
    func canAddToTranscript(_ run: CommandRun) -> Bool {
        switch transcriptTarget(run) {
        case .recordedSession: return onSendToTranscript != nil
        case .currentConversation: return onSendToCurrentConversation != nil
        case .unavailable: return false
        }
    }

    /// Sends the run's command and output to its target. False when it cannot (its session is gone, refused).
    func addToTranscript(_ run: CommandRun) async -> Bool {
        switch transcriptTarget(run) {
        case .recordedSession(let sessionId):
            guard let send = onSendToTranscript else { return false }
            return await send(sessionId, run.transcriptMessage())
        case .currentConversation:
            guard let send = onSendToCurrentConversation else { return false }
            return await send(run.transcriptMessage())
        case .unavailable:
            return false
        }
    }

    /// A click on a command pill: its terminal window — brought forward when already open.
    func openWindow(_ id: UUID) {
        guard let run = run(id) else { return }
        if let open = windows[id] {
            open.bringToFront()
            return
        }
        let controller = TerminalWindowController(
            run: run,
            canAddToTranscript: { [weak self, weak run] in
                guard let self, let run else { return false }
                return self.canAddToTranscript(run)
            },
            onAddToTranscript: { [weak self, weak run] in
                guard let self, let run else { return false }
                return await self.addToTranscript(run)
            })
        controller.onClosed = { [weak self] in self?.windows[id] = nil }
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
        // A live shell's foreground job runs in a process group of its own (job control): it goes too.
        let foreground = runs.filter { $0.outcome == .running }.compactMap { $0.foregroundGroup() }
        let groups = launchedGroups.union(foreground).filter { kill(-$0, 0) == 0 }
        guard !groups.isEmpty else { return }
        for group in groups {
            kill(-group, SIGHUP)
            kill(-group, SIGTERM)
        }
        for _ in 0..<10 {
            if groups.allSatisfy({ kill(-$0, 0) != 0 }) { return }
            usleep(20_000)
        }
        for group in groups { kill(-group, SIGKILL) }
    }

    private func withAnimationIfVisible(_ change: () -> Void) {
        commandPillRowAnimated(change)
    }

    // MARK: Test seams

    var launchedGroupsForTesting: Set<pid_t> { launchedGroups }
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
