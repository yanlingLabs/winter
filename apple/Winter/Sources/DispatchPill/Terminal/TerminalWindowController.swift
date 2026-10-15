import AppKit
import SwiftUI

/// A command run's terminal window: drawn entirely by Winter in the dispatch pill's material, like a detached
/// session window (`PillChromeWindow`, its own traffic lights, drag band and resize grips) — no Terminal.app,
/// no system frame. The emulator inside is the RUN's (`CommandRun.terminalView`): closing the window only
/// unparents it, so the process keeps running and a reopened window shows the full scrollback.
@MainActor
final class TerminalWindowController: NSObject, NSWindowDelegate {
    let run: CommandRun
    let window: PillChromeWindow
    var onClosed: (() -> Void)?
    private let chrome = TerminalWindowChromeModel()

    static let defaultSize = NSSize(width: 780, height: 480)

    /// - Parameters:
    ///   - canAddToTranscript: whether the run's own session still exists (read live — the button disables).
    ///   - onAddToTranscript: sends the run's message to that session; true when it went.
    init(run: CommandRun, canAddToTranscript: @escaping () -> Bool, onAddToTranscript: @escaping () async -> Bool) {
        self.run = run
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = Self.defaultSize
        let frame = NSRect(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2 + 60,
                           width: size.width, height: size.height)
        window = PillChromeWindow(contentRect: frame)
        window.title = "Terminal"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 440, height: 240)
        window.appearance = NSAppearance(named: .darkAqua)
        super.init()
        window.delegate = self

        let chrome = chrome
        let hosting = FirstClickHostingView(rootView: TerminalWindowRootView(
            run: run, chrome: chrome,
            onClose: { [weak window] in window?.performClose(nil) },
            onMinimize: { [weak window] in window?.performMiniaturize(nil) },
            onZoom: { [weak window] in window?.performZoom(nil) },
            onStop: { [weak run] in run?.stop() },
            canAddToTranscript: canAddToTranscript,
            onAddToTranscript: {
                guard chrome.sendState != .sending, canAddToTranscript() else { return }
                chrome.sendState = .sending
                Task { @MainActor in
                    let ok = await onAddToTranscript()
                    chrome.sendState = ok ? .sent : .failed
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    if chrome.sendState != .sending { chrome.sendState = .idle }
                }
            }))
        let container = NSView(frame: NSRect(origin: .zero, size: frame.size))
        hosting.frame = container.bounds
        hosting.autoresizingMask = [.width, .height]
        hosting.sizingOptions = []
        container.addSubview(hosting)
        let grips = PillWindowResizeHandles(frame: container.bounds)
        grips.autoresizingMask = [.width, .height]
        container.addSubview(grips)
        window.contentView = container
        window.setFrame(frame, display: true)
    }

    /// Ordered in front of whatever app the user is in, keyboard to the terminal — without activating Winter
    /// (a non-activating panel, like every pill-chrome window).
    func show() {
        window.orderFrontRegardless()
        window.makeKey()
        focusTerminal()
    }

    func bringToFront() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        show()
    }

    func close() { window.close() }

    /// Keyboard to the emulator. It joins the window on SwiftUI's layout pass, which can take more than one hop, so
    /// this retries briefly (every 50 ms, up to 1 s) instead of giving up when the first hop finds it not attached yet.
    private func focusTerminal(attempt: Int = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 0 : 0.05)) { [weak self] in
            guard let self else { return }
            let terminal = self.run.terminalView
            if terminal.window === self.window {
                if self.window.firstResponder !== terminal { self.window.makeFirstResponder(terminal) }
            } else if attempt < 20 {
                self.focusTerminal(attempt: attempt + 1)
            }
        }
    }

    /// Back to the window (a click on it, Cmd-` …): the keyboard goes to the emulator again.
    func windowDidBecomeKey(_ notification: Notification) {
        focusTerminal()
    }

    func windowWillClose(_ notification: Notification) {
        // The process and its scrollback stay with the run; only this window goes.
        run.terminalView.removeFromSuperview()
        onClosed?()
        onClosed = nil
    }
}

/// The window chrome's own state: the "Add to transcript" confirmation.
@MainActor
final class TerminalWindowChromeModel: ObservableObject {
    enum SendState: Equatable { case idle, sending, sent, failed }
    @Published var sendState: SendState = .idle
}

/// The window: a header band (the lights, the command and where it runs, its state, Stop, Add to transcript)
/// over the emulator, all on the pill's black, clipped to the pill's corner radius.
struct TerminalWindowRootView: View {
    @ObservedObject var run: CommandRun
    @ObservedObject var chrome: TerminalWindowChromeModel
    let onClose: () -> Void
    let onMinimize: () -> Void
    let onZoom: () -> Void
    let onStop: () -> Void
    let canAddToTranscript: () -> Bool
    let onAddToTranscript: () -> Void

    static let headerBand: CGFloat = 56

    var body: some View {
        VStack(spacing: 0) {
            header
            TerminalHost(view: run.terminalView)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: PillChromeWindow.cornerRadius, style: .continuous))
        .environment(\.colorScheme, .dark)
        .ignoresSafeArea()
    }

    private var header: some View {
        ZStack {
            // A frameless window has no titlebar to drag: the band moves it, a double-click zooms it.
            Color.clear
                .contentShape(Rectangle())
                .gesture(WindowDragGesture())
                .onTapGesture(count: 2, perform: onZoom)
            HStack(spacing: 14) {
                MacTrafficLights(onClose: onClose, onMinimize: onMinimize, onZoom: onZoom)
                    .padding(.leading, 20)
                title
                    .frame(maxWidth: .infinity)
                    .allowsHitTesting(false)
                controls
                    .padding(.trailing, 14)
            }
        }
        .frame(height: Self.headerBand)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1)
        }
    }

    private var title: some View {
        VStack(spacing: 2) {
            HStack(spacing: 6) {
                Text("$")
                    .font(Typography.labelMono(.semibold))
                    .foregroundStyle(Theme.commandPurple)
                Text(run.command)
                    .font(Typography.labelMono(.medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Text(terminalDisplayPath(run.workingDirectory, home: run.homeDirectory))
                .font(Typography.captionMono())
                .foregroundStyle(Color.white.opacity(0.45))
                .lineLimit(1)
                .truncationMode(.head)
        }
        .help(run.command)
    }

    private var controls: some View {
        HStack(spacing: 8) {
            TerminalRunStateBadge(outcome: run.outcome)
            if run.outcome == .running {
                TerminalChromeButton(symbol: "stop.fill", label: "Stop", help: "Stop this command", action: onStop)
            }
            addToTranscriptButton
        }
    }

    /// Re-asked every couple of seconds: the run's session can go away while the window is open.
    private var addToTranscriptButton: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            addToTranscriptControl(available: canAddToTranscript())
        }
    }

    @ViewBuilder
    private func addToTranscriptControl(available: Bool) -> some View {
        if !available, chrome.sendState != .sent {
            TerminalChromeButton(symbol: "text.bubble", label: "Add to transcript",
                                 help: run.sessionId == nil
                                    ? "This command was not run from a Dispatch session"
                                    : "The Dispatch session this command was run from is gone",
                                 action: {})
                .opacity(0.4)
                .disabled(true)
        } else {
            addToTranscriptState
        }
    }

    @ViewBuilder
    private var addToTranscriptState: some View {
        switch chrome.sendState {
        case .sent:
            Label("Added", systemImage: "checkmark")
                .font(Typography.caption(.medium))
                .foregroundStyle(Color.white.opacity(0.6))
                .padding(.horizontal, 10)
                .frame(height: 26)
                .transition(.opacity)
        case .failed:
            TerminalChromeButton(symbol: "exclamationmark.triangle", label: "Couldn’t send — retry",
                                 help: "Send the command and its output to its Dispatch session again", tint: .orange,
                                 action: onAddToTranscript)
        case .idle, .sending:
            TerminalChromeButton(symbol: "text.bubble", label: "Add to transcript",
                                 help: "Send the command and its output to the Dispatch session it was run from, as your message",
                                 action: onAddToTranscript)
                .opacity(chrome.sendState == .sending ? 0.5 : 1)
                .disabled(chrome.sendState == .sending)
        }
    }
}

/// A small capsule control in the terminal window's header — the pill family's quiet chrome: no fill at rest
/// beyond a faint wash, a brighter one under the pointer.
private struct TerminalChromeButton: View {
    let symbol: String
    let label: String
    let help: String
    var tint: Color = .white
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(Typography.caption(.semibold))
                Text(label)
                    .font(Typography.caption(.medium))
                    .lineLimit(1)
            }
            .foregroundStyle(tint.opacity(0.85))
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Capsule().fill(Color.white.opacity(hovering ? 0.14 : 0.08)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help(help)
    }
}

/// The run's state in the header: a breathing purple dot while it runs, then how it ended.
private struct TerminalRunStateBadge: View {
    let outcome: CommandRunOutcome

    var body: some View {
        HStack(spacing: 5) {
            switch outcome {
            case .running:
                TimelineView(.animation(minimumInterval: 1.0 / 20)) { context in
                    let phase = (sin(context.date.timeIntervalSinceReferenceDate * 3) + 1) / 2
                    Circle().fill(Theme.commandPurple).frame(width: 7, height: 7).opacity(0.45 + 0.55 * phase)
                }
                .frame(width: 7, height: 7)
                Text("Running")
            case .exited(0):
                Image(systemName: "checkmark").font(Typography.caption(.semibold))
                Text("Done")
            case .exited(let code):
                Circle().fill(Color.red).frame(width: 7, height: 7)
                Text("Exit \(code)")
            case .signaled:
                Circle().fill(Color.red).frame(width: 7, height: 7)
                Text("Stopped")
            case .failedToStart:
                Circle().fill(Color.red).frame(width: 7, height: 7)
                Text("Couldn’t start")
            }
        }
        .font(Typography.caption(.medium))
        .foregroundStyle(Color.white.opacity(0.55))
        .fixedSize()
    }
}

/// Hosts the run's emulator inside SwiftUI, with the terminal's padding. The emulator is re-parented here on
/// every (re)open, and unparented when the window closes (`TerminalWindowController.windowWillClose`).
private struct TerminalHost: NSViewRepresentable {
    let view: WinterTerminalView

    func makeNSView(context: Context) -> TerminalPaddingView {
        let container = TerminalPaddingView()
        view.removeFromSuperview()
        container.terminal = view
        container.addSubview(view)
        return container
    }

    func updateNSView(_ nsView: TerminalPaddingView, context: Context) {
        if view.superview !== nsView {
            view.removeFromSuperview()
            nsView.terminal = view
            nsView.addSubview(view)
            nsView.needsLayout = true
        }
    }

    static func dismantleNSView(_ nsView: TerminalPaddingView, coordinator: ()) {
        if let terminal = nsView.terminal, terminal.superview === nsView { terminal.removeFromSuperview() }
    }
}

/// Lays the emulator out inside `TerminalStyle.padding` — on a layout pass and on every resize (a frame change
/// alone does not promise a layout pass to a view with no constraints).
final class TerminalPaddingView: NSView {
    weak var terminal: NSView? {
        didSet { layoutTerminal() }
    }

    override func layout() {
        super.layout()
        layoutTerminal()
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        layoutTerminal()
    }

    private func layoutTerminal() {
        let p = TerminalStyle.padding
        let width = bounds.width - p.left - p.right, height = bounds.height - p.top - p.bottom
        // Not before the window has given this view a real size: a running program would be told its terminal
        // shrank to nothing (a SIGWINCH to a 1×1 grid) on the way to its real size.
        guard width >= 40, height >= 40 else { return }
        terminal?.frame = NSRect(x: p.left, y: p.bottom, width: width, height: height)
    }
}
