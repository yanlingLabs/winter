import AppKit
import SwiftUI

// MARK: - app-shell T9 (spec §3): the floating corner panel — the TUI-outputs idea's landing spot.
//
// Same SEAM SPLIT as T8's `OutputsWatcher`/`FileViewer`: everything down to (not including)
// `OutputsPanelWindowController` is PURE or driven by injected closures, unit-tested with no real
// NSPanel involved. `OutputsPanelWindowController` itself (screen placement, `orderFrontRegardless`)
// is LIVE-GATED — presence-only, same posture as `FileViewer`'s own doc comment (T8's report).

// MARK: - The trigger matrix (PURE — the plan's own bullet)

/// The three shapes `outputsPanelAction` below can answer.
enum OutputsPanelAction: Equatable {
    /// One of the two T3-established display-state sources already shows this session — never show.
    case none
    /// Neither shows it, and the panel isn't up yet — a fresh non-activating present.
    case present
    /// Neither shows it, and the panel is ALREADY visible — fold into what's already showing.
    case update
}

/// PURE: {shell-shown, detached-shown, neither} × {panel already visible} — the plan's own bullet,
/// as a function. Only "neither" ever triggers anything (`shellShown`/`detachedShown` are read off
/// the app's own display state — `ShellSessionHost.attachedSessionId` and the `detachedWindows`
/// registry, T3's own sources, never a daemon signal); `panelVisible` never widens or narrows THAT
/// gate, it only decides HOW the panel reacts once the gate has already passed (present vs fold-in).
func outputsPanelAction(shellShown: Bool, detachedShown: Bool, panelVisible: Bool) -> OutputsPanelAction {
    guard !shellShown, !detachedShown else { return .none }
    return panelVisible ? .update : .present
}

// MARK: - The fail-quiet diff (PURE)

/// PURE: which of `current`'s files are NEW relative to `previous`. `OutputsWatcher.onChange`
/// reports a FULL listing every tick, never a patch (its own doc comment) — T9 derives its own
/// additions by keeping the last-seen set per session (`OutputsPanelController.lastSeenFiles`) and
/// diffing against it here. A batch that only lost files (deletions, or the vanish-tolerant watcher's
/// empty re-list of a removed session dir) returns empty — the "deleted-only diffs never show the
/// panel" fail-quiet rule falls out of this for free, at the caller's `guard !additions.isEmpty`.
/// Order preserved from `current` (`listOutputFiles` already sorts it).
func outputsPanelAdditions(previous: Set<String>, current: [String]) -> [String] {
    current.filter { !previous.contains($0) }
}

// MARK: - Display title (PURE)

/// PURE: "a session with no title shows the id" (the fail-quiet rule, verbatim). Deliberately NOT
/// `sessionDisplayTitle`'s "New session" fallback (`ShellNavigation.swift`) — that copy reads right
/// for a landing row the user is about to open by choice; a corner notification about a session the
/// user ISN'T looking at needs something that actually distinguishes it if two untitled sessions
/// both drop files at once, and the id is the one thing guaranteed to.
func outputsPanelDisplayTitle(title: String?, sessionId: String) -> String {
    let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? sessionId : trimmed
}

// MARK: - The panel's own state (PURE)

/// One session's card in the panel. `Identifiable` off `sessionId` so SwiftUI's `ForEach` (and a
/// test's own lookups) never need a second key.
struct OutputsPanelEntry: Identifiable, Equatable {
    let sessionId: String
    var title: String
    var files: [String]
    var id: String { sessionId }
}

/// PURE: folds a batch of NEW files into the entries stack — the "second session while visible"
/// shape (the brief's own call for a judgment call). JUDGMENT: a session already showing a card is
/// updated IN PLACE (its files UNION'd, position unchanged — the user may be mid-reading the first
/// card, so a live update must never reshuffle it out from under them); a session with no card yet
/// is APPENDED to the end (oldest-first, newest-last) rather than jumping to the top, for the same
/// reason. This is a STACK, not a replace-with-latest: every session that has dropped something new
/// since the panel's own last dismiss keeps its own card until the panel is dismissed or its file is
/// clicked (`OutputsPanelController.dismiss()`/`openFile(sessionId:path:)`).
func upsertOutputsPanelEntry(_ entries: [OutputsPanelEntry], sessionId: String, title: String, additions: [String]) -> [OutputsPanelEntry] {
    guard !additions.isEmpty else { return entries }
    var entries = entries
    if let idx = entries.firstIndex(where: { $0.sessionId == sessionId }) {
        var existing = entries[idx]
        let newOnes = additions.filter { !existing.files.contains($0) }
        existing.files.append(contentsOf: newOnes)
        existing.title = title // a title can arrive/change between the first and a later card
        entries[idx] = existing
    } else {
        entries.append(OutputsPanelEntry(sessionId: sessionId, title: title, files: additions))
    }
    return entries
}

// MARK: - Screen placement (PURE)

/// The panel's fixed CONTENT width — height is content-driven (`OutputsPanelWindowController.sync()`
/// measures the hosted SwiftUI content and resizes around this width). Tune-at-gate constant, same
/// posture as `ShellSessionView`'s own `topInset: 8`.
let outputsPanelDefaultSize = CGSize(width: 320, height: 40)

/// PURE: screen TOP-RIGHT placement, `margin` in from both edges — the corner the spec pins
/// (deliberately NOT tracking the Terminal window's position — the spec's own recorded decision).
/// No `NSScreen` dependency, same posture as `centeredAppWindowFrame`/`summonFrame`
/// (`AppWindowController.swift`) — the geometry is unit-tested directly.
func outputsPanelFrame(size: CGSize, visibleFrame: CGRect, margin: CGFloat = 16) -> CGRect {
    CGRect(
        x: visibleFrame.maxX - size.width - margin,
        y: visibleFrame.maxY - size.height - margin,
        width: size.width,
        height: size.height
    )
}

// MARK: - The controller (the pure/injected-closure half — directly unit-testable)

/// AppShell T9: owns the panel's DECISION state — which sessions/files are pending, whether the
/// panel is up — with NO AppKit dependency of its own. `OutputsPanelWindowController` (below) is the
/// one live consumer; a unit test constructs this class alone, wires the three closures, and drives
/// `handleOutputsChange` directly, the same "orchestration seam a test CAN drive" posture
/// `OutputsWatcher.handleRawPaths`/`ShellSessionHost.applyOutputsChange` already established in T8.
@MainActor
final class OutputsPanelController: ObservableObject {
    @Published private(set) var entries: [OutputsPanelEntry] = []
    @Published private(set) var isVisible = false

    /// The trigger matrix's two live inputs — `AppDelegate` wires these to `appWindow?.host?.
    /// attachedSessionId == sessionId` and `detachedWindows.contains { $0.sessionId == sessionId }`
    /// (the T3-established display-state sources named in the brief; no daemon signal). `nil` (every
    /// test that doesn't inject one) reads as "not shown" — fail-toward-showing-the-panel, matching
    /// how a not-yet-wired shell genuinely shows nothing.
    var isShellShowing: ((String) -> Bool)?
    var isDetachedShowing: ((String) -> Bool)?
    /// The session's current title, looked up fresh (`AppModel.directory.rows`) — never cached here.
    var titleForSession: ((String) -> String?)?
    /// The click-through door: `AppDelegate.openOutputFileFromPanel(sessionId:path:)` in production.
    var onOpenFile: ((String, String) -> Void)?
    /// Fires whenever `entries`/`isVisible` change in a way the AppKit half must react to (a fresh
    /// show, a content update while already showing, or a dismiss). Deliberately carries no
    /// payload — `OutputsPanelWindowController` reads BOTH published properties fresh off `self` at
    /// that point, the same "read fresh at call time" convention `ShellSessionHost.sidebarWiring`
    /// and every hop-callback in this app already keep, rather than risk a stale snapshot.
    var onStateChange: (() -> Void)?

    /// Per-session last-seen listing — `outputsPanelAdditions`'s own `previous` argument.
    private var lastSeenFiles: [String: Set<String>] = [:]
    private let dismissAfter: @Sendable () async -> Void
    private var dismissTask: Task<Void, Never>?

    /// `outputsWatcher` — `nil` in every test that drives `handleOutputsChange` directly. When
    /// present, `init` COMPOSES onto whatever `onChange` already holds rather than replacing it —
    /// the exact "compose, never replace" discipline `OutputsWatcher.onChange`'s own doc comment
    /// demands of a second consumer, mirroring `ShellSessionHost.init`'s identical composition.
    /// `dismissAfter` is the auto-dismiss clock, injectable the same `sleepTick` shape
    /// `SessionDirectory`'s poll uses — defaults to a real 8s sleep (tune-at-gate constant).
    init(
        outputsWatcher: OutputsWatcher? = nil,
        dismissAfter: @escaping @Sendable () async -> Void = { try? await Task.sleep(for: .seconds(8)) }
    ) {
        self.dismissAfter = dismissAfter
        let previousOnChange = outputsWatcher?.onChange
        outputsWatcher?.onChange = { [weak self] sessionId, files in
            previousOnChange?(sessionId, files)
            self?.handleOutputsChange(sessionId: sessionId, files: files)
        }
    }

    /// The orchestration seam a test drives directly — mirrors `OutputsWatcher.handleRawPaths`'s own
    /// role for its file. Diffs against the last-seen listing, applies the trigger matrix, and (only
    /// on an actual show/update) folds the addition into `entries` and (re)arms the auto-dismiss
    /// clock.
    func handleOutputsChange(sessionId: String, files: [String]) {
        let previous = lastSeenFiles[sessionId] ?? []
        lastSeenFiles[sessionId] = Set(files)
        let additions = outputsPanelAdditions(previous: previous, current: files)
        guard !additions.isEmpty else { return } // deletions-only, or an empty re-list: never show

        let shellShown = isShellShowing?(sessionId) ?? false
        let detachedShown = isDetachedShowing?(sessionId) ?? false
        guard outputsPanelAction(shellShown: shellShown, detachedShown: detachedShown, panelVisible: isVisible) != .none else { return }

        let title = outputsPanelDisplayTitle(title: titleForSession?(sessionId), sessionId: sessionId)
        entries = upsertOutputsPanelEntry(entries, sessionId: sessionId, title: title, additions: additions)
        isVisible = true
        armAutoDismiss()
        onStateChange?()
    }

    /// The panel's click door (mirrors `ShellSessionHost.showOutputFile`'s own T8 role): fires the
    /// click-through, then dismisses the WHOLE panel — once the user has acted on one notification,
    /// there is nothing left worth holding it open for (a single-card panel with several files acts
    /// the same way: clicking any one of them clears the card).
    func openFile(sessionId: String, path: String) {
        onOpenFile?(sessionId, path)
        dismiss()
    }

    /// Clears every card and hides the panel — the auto-dismiss clock's own target, and the click
    /// door's post-action step above. Idempotent.
    func dismiss() {
        dismissTask?.cancel()
        dismissTask = nil
        guard isVisible || !entries.isEmpty else { return }
        entries = []
        isVisible = false
        onStateChange?()
    }

    private func armAutoDismiss() {
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            await self?.dismissAfter()
            guard let self, !Task.isCancelled else { return }
            self.dismiss()
        }
    }
}

// MARK: - The AppKit half (LIVE-GATED — presence-only, same posture as T8's `FileViewer`)

/// The orb's `KeyableNonActivatingPanel` precedent (`OrbWindowController.swift`'s own doc comment),
/// narrowed: this panel has no composer, no typed input at all — it only ever needs to receive mouse
/// clicks on its rows, which a borderless `.nonactivatingPanel` can do without ever becoming key.
/// `canBecomeKey`/`canBecomeMain` are hard-pinned `false` (never toggled, unlike the orb's
/// `acceptsKeyInput` — there is no expanded/collapsed distinction here to gate) — the non-activating
/// contract the spec pins ("never steals focus") holds unconditionally for this panel's whole life.
private final class OutputsPanelWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// AppShell T9: the one app-lifetime floating panel — constructed once in `AppDelegate.boot()`
/// (same posture as `OrbWindowController`'s own construction: a plain `NSPanel` init touches nothing
/// real until ordered front, so this is safe to build unconditionally, including under unit tests).
/// Owns NOTHING but AppKit presentation: screen placement (`outputsPanelFrame`, content-sized via
/// the hosted view's `fittingSize`) and order-front/order-out, driven ENTIRELY by
/// `OutputsPanelController.onStateChange` — this class never mutates `entries`/`isVisible` itself.
@MainActor
final class OutputsPanelWindowController {
    private let panel: NSPanel
    private let hostingView: NSHostingView<OutputsPanelContentView>
    let controller: OutputsPanelController

    init(controller: OutputsPanelController) {
        self.controller = controller
        let panel = OutputsPanelWindow(
            contentRect: NSRect(origin: .zero, size: outputsPanelDefaultSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = false // rows must be clickable — the whole point of the panel
        let hostingView = NSHostingView(rootView: OutputsPanelContentView(controller: controller))
        panel.contentView = hostingView
        self.panel = panel
        self.hostingView = hostingView

        controller.onStateChange = { [weak self] in self?.sync() }
    }

    /// Reads `controller`'s published state FRESH (never handed a payload — see `onStateChange`'s
    /// own doc comment). Never-hollow belt: an empty `entries` (shouldn't reach here — the controller
    /// never sets `isVisible` without a non-empty fold — but defended anyway, the same posture
    /// `dirsMenuIsVisible`-style guards keep elsewhere in this app) orders out rather than showing an
    /// empty card.
    private func sync() {
        guard controller.isVisible, !controller.entries.isEmpty else {
            panel.orderOut(nil)
            return
        }
        let visibleFrame = (panel.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
        let fitted = hostingView.fittingSize
        let size = CGSize(width: outputsPanelDefaultSize.width, height: max(fitted.height, outputsPanelDefaultSize.height))
        panel.setFrame(outputsPanelFrame(size: size, visibleFrame: visibleFrame), display: true)
        // NEVER makeKey, NEVER NSApp.activate — the non-activating contract (spec §3). Same
        // `orderFrontRegardless()`-only discipline the orb's own collapsed state keeps.
        panel.orderFrontRegardless()
    }
}

// MARK: - The panel's content (presence-only pinned — no first-party pattern; GALLERY EXTENSION
// POINT, per the brief: the nearest precedent is the orb panel's own glass/rounded-card idiom and
// `OutputsBox`'s row styling, `doc` glyph + last-path-component + middle truncation, reused here.)

struct OutputsPanelContentView: View {
    @ObservedObject var controller: OutputsPanelController

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(controller.entries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.title)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    ForEach(entry.files, id: \.self) { path in
                        Button {
                            controller.openFile(sessionId: entry.sessionId, path: path)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "doc")
                                    .foregroundStyle(.secondary)
                                Text((path as NSString).lastPathComponent)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .font(.system(size: 11))
        .padding(12)
        .frame(width: outputsPanelDefaultSize.width, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        // chatgpt-ui T3 clash sweep (spec §4 names this panel by name: "the corner outputs panel
        // … gets the minimal touch to not clash — flat backgrounds"): the glass card becomes a
        // flat `windowBackgroundColor` card with the shell's 1 pt quaternary stroke vocabulary;
        // radius and shadow unchanged — the full panel restyle is explicitly NOT this pass. Both
        // appearances follow the system colors by construction.
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.quaternary, lineWidth: 1))
        .shadow(radius: 10)
    }
}
