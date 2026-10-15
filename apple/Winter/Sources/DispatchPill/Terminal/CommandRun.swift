import AppKit
import Combine
import Darwin
import SwiftTerm

// A command the user ran from the Dispatch pill: a real PTY running their login shell, in the Mac app's own
// process (never the daemon's), with no Winter sandbox and no approval — it is the user's own action, as if
// typed in their terminal. Its terminal view belongs to the RUN, not to a window: closing the window keeps
// the process (and the scrollback) alive, and reopening it hosts the same view again.
//
// Nothing here logs the command line or its output.

/// The terminal emulator, with the output tap and the exit report the run needs.
final class WinterTerminalView: LocalProcessTerminalView {
    var onData: ((ArraySlice<UInt8>) -> Void)?
    var onExit: ((Int32?) -> Void)?

    override func dataReceived(slice: ArraySlice<UInt8>) {
        onData?(slice)
        super.dataReceived(slice: slice)
    }

    override func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
        super.processTerminated(source, exitCode: exitCode)
        onExit?(exitCode)
    }
}

@MainActor
final class CommandRun: ObservableObject, Identifiable {
    let id = UUID()
    /// The line as the user typed it.
    let command: String
    let workingDirectory: String
    let homeDirectory: String
    @Published private(set) var outcome: CommandRunOutcome = .running
    let terminalView: WinterTerminalView

    /// The tail of what the PTY produced, raw (`TerminalTranscriptLimits.maxCapturedBytes`).
    private var captured: [UInt8] = []

    /// `launch: false` builds the run without starting a process (tests — no test runs the user's shell).
    init(command: String, workingDirectory: String, environment: CommandLineEnvironment, launch: Bool = true) {
        self.command = command
        self.workingDirectory = workingDirectory
        self.homeDirectory = environment.homeDirectory
        let view = WinterTerminalView(frame: NSRect(x: 0, y: 0, width: 760, height: 420),
                                      font: Typography.terminalNS,
                                      options: TerminalOptions(scrollback: 10_000))
        TerminalStyle.apply(to: view)
        terminalView = view
        view.onData = { [weak self] slice in
            MainActor.assumeIsolated { self?.capture(slice) }
        }
        view.onExit = { [weak self] status in
            MainActor.assumeIsolated { self?.finish(status) }
        }

        guard launch else { return }
        let invocation = loginShellRunInvocation(shell: environment.shell, line: command)
        let env = environment.runEnvironment.map { "\($0.key)=\($0.value)" }
        view.startProcess(executable: invocation.executable, args: invocation.arguments, environment: env,
                          execName: "-" + (invocation.executable as NSString).lastPathComponent,
                          currentDirectory: workingDirectory)
        if !view.process.running { outcome = .failedToStart }
    }

    /// The whole process group — the shell and everything it started (forkpty made the shell a session
    /// leader, so its pid is the group's).
    private var processGroup: pid_t? {
        let pid = terminalView.process.shellPid
        return pid > 0 && outcome == .running ? pid : nil
    }

    /// The explicit Stop: hang up the group, and kill it if it is still there a moment later.
    func stop() {
        guard let group = processGroup else { return }
        kill(-group, SIGHUP)
        kill(-group, SIGTERM)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.outcome == .running else { return }
            kill(-group, SIGKILL)
        }
    }

    /// The app is quitting: nothing it started may outlive it.
    func stopForQuit() {
        guard let group = processGroup else { return }
        kill(-group, SIGHUP)
        kill(-group, SIGTERM)
        // A short grace for a clean exit, then the hard stop — the app is going either way.
        for _ in 0..<10 {
            if kill(group, 0) != 0 { return }
            usleep(20_000)
        }
        kill(-group, SIGKILL)
    }

    /// The message "Add to transcript" sends.
    func transcriptMessage() -> String {
        terminalTranscriptMessage(command: command, workingDirectory: workingDirectory, home: homeDirectory,
                                  outcome: outcome, output: terminalCappedOutput(terminalPlainText(captured)))
    }

    private func capture(_ slice: ArraySlice<UInt8>) {
        captured.append(contentsOf: slice)
        let overflow = captured.count - TerminalTranscriptLimits.maxCapturedBytes
        if overflow > 0 { captured.removeFirst(overflow) }
    }

    private func finish(_ status: Int32?) {
        guard outcome == .running else { return }
        outcome = status.map(commandRunOutcome(waitStatus:)) ?? .signaled(SIGKILL)
    }

    // MARK: Test seams (a run built with `launch: false`)

    func feedForTesting(_ bytes: [UInt8]) { capture(bytes[...]) }
    func finishForTesting(waitStatus: Int32?) { finish(waitStatus) }
}

/// Every command run from the pill, in the order they started. Owns their terminal windows too.
@MainActor
final class CommandRunStore: ObservableObject {
    @Published private(set) var runs: [CommandRun] = []
    /// Finished runs beyond this many are let go (oldest first, never one whose window is open).
    static let maxRuns = 8

    /// Test seam: false builds runs without starting their process.
    var launchesProcesses = true

    /// The send path the composer uses (`session.send`): "Add to transcript" hands its message here.
    var onSendToTranscript: ((String) async -> Bool)?

    private var windows: [UUID: TerminalWindowController] = [:]
    private var outcomeWatch: [UUID: AnyCancellable] = [:]
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

    /// Start `command` in `workingDirectory` as the user. Returns the run (its pill appears at once).
    @discardableResult
    func start(command: String, workingDirectory: String, environment: CommandLineEnvironment) -> CommandRun {
        let run = CommandRun(command: command, workingDirectory: workingDirectory, environment: environment,
                             launch: launchesProcesses)
        withAnimationIfVisible { runs.append(run) }
        // The pill's state follows the run; the store republishes only so the row re-lays out.
        outcomeWatch[run.id] = run.$outcome.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { self?.prune() }
        }
        prune()
        return run
    }

    func run(_ id: UUID) -> CommandRun? { runs.first { $0.id == id } }

    /// A click on a command pill: its terminal window — brought forward when already open.
    func openWindow(_ id: UUID) {
        guard let run = run(id) else { return }
        if let open = windows[id] {
            open.bringToFront()
            return
        }
        let controller = TerminalWindowController(run: run, onAddToTranscript: { [weak self] text in
            await self?.onSendToTranscript?(text) ?? false
        })
        controller.onClosed = { [weak self] in self?.windows[id] = nil }
        windows[id] = controller
        controller.show()
    }

    func isWindowOpen(_ id: UUID) -> Bool { windows[id] != nil }

    /// The pill's stop control and the window's.
    func stop(_ id: UUID) { run(id)?.stop() }

    /// The pill's × on a finished run: it leaves the row (and its window closes).
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

    private func stopAllForQuit() {
        runs.forEach { $0.stopForQuit() }
    }

    private func withAnimationIfVisible(_ change: () -> Void) {
        commandPillRowAnimated(change)
    }
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
