import AppKit
import SwiftUI
import WinterCUPresentation

// The Winter island's computer-use MIRROR (phase 2, `docs/claude/island.md`): a click on the computer-use pill opens it
// into a small live view of what the agent works in — the bound target WINDOW, as the helper captures it — and its
// detach button makes a small floating window of it. The pictures are the Winter Computer Use helper's own (`view.subscribe`
// with frames, through `MirrorCoordinator`): the helper holds the Screen Recording grant and captures only the bound
// window; Winter.app captures nothing. Frames flow ONLY while a mirror is on screen — the in-island one while it shows,
// each detached window while it is open — and stop the instant the last one closes (`IslandMirrorLifecycle`). Without
// pictures (the helper lacks Screen Recording, the window is on another Space) the mirror shows the calm placeholder
// `CUMirrorView` draws until a first frame.

/// Starts and stops a session's pictures. The app's is `MirrorCoordinator` (the helper's frames at the island's caps); the
/// tests' is a fake that records the calls.
@MainActor
protocol IslandMirrorCapture: AnyObject {
    func startCapture(sessionId: String)
    func stopCapture(sessionId: String)
}

/// Who holds a session's pictures: the in-island mirror while it is visible, and each detached window while it is open.
/// The capture starts when the first holder of a session appears and stops when its last goes — a detach hands over
/// WITHOUT stopping (the window holds before the island lets go), so the helper's capture is never torn down and re-made.
@MainActor
final class IslandMirrorLifecycle {
    let capture: IslandMirrorCapture
    /// The session the in-island mirror shows while it is visible.
    private(set) var islandSession: String?
    /// Each detached window's session, by window id.
    private(set) var detached: [String: String] = [:]

    init(capture: IslandMirrorCapture) { self.capture = capture }

    /// How many holders a session has.
    func holders(of sessionId: String) -> Int {
        (islandSession == sessionId ? 1 : 0) + detached.values.filter { $0 == sessionId }.count
    }

    /// The in-island mirror shows `sessionId` (nil: it is not visible — closed, yielded to a card, the island open).
    func setIslandMirror(_ sessionId: String?) {
        guard sessionId != islandSession else { return }
        let old = islandSession
        if let sessionId { hold(sessionId) { self.islandSession = sessionId } } else { islandSession = nil }
        if let old, old != sessionId { release(old) }
    }

    /// The detach button: a window takes the in-island mirror's session over, then the island lets go.
    @discardableResult
    func detach(windowId: String) -> String? {
        guard let sessionId = islandSession else { return nil }
        detached[windowId] = sessionId
        islandSession = nil
        return sessionId
    }

    /// A detached window opened on `sessionId` (outside a handover).
    func openDetached(windowId: String, sessionId: String) {
        guard detached[windowId] == nil else { return }
        hold(sessionId) { self.detached[windowId] = sessionId }
    }

    /// A detached window closed.
    func closeDetached(windowId: String) {
        guard let sessionId = detached.removeValue(forKey: windowId) else { return }
        if holders(of: sessionId) == 0 { capture.stopCapture(sessionId: sessionId) }
    }

    /// Everything closes (the island stops).
    func closeAll() {
        let sessions = Set(detached.values).union([islandSession].compactMap { $0 })
        detached = [:]
        islandSession = nil
        for s in sessions { capture.stopCapture(sessionId: s) }
    }

    private func hold(_ sessionId: String, _ add: () -> Void) {
        let first = holders(of: sessionId) == 0
        add()
        if first { capture.startCapture(sessionId: sessionId) }
    }

    private func release(_ sessionId: String) {
        if holders(of: sessionId) == 0 { capture.stopCapture(sessionId: sessionId) }
    }
}

// MARK: - The live capture

extension MirrorCoordinator: IslandMirrorCapture {
    func startCapture(sessionId: String) { addIslandFrames(sessionId) }
    func stopCapture(sessionId: String) { removeIslandFrames(sessionId) }
}

// MARK: - The detached window

/// The detached mirror: a borderless, custom-chrome floating panel — movable by its background, resizable within limits,
/// closed by its ✕ or when the session's computer use ends. Never key, never in a capture (computer use never sees
/// itself), on every Space.
final class IslandDetachedMirrorPanel: NSPanel {
    static let defaultSize = CGSize(width: 420, height: 300)
    static let minSize = CGSize(width: 260, height: 190)
    static let maxSize = CGSize(width: 960, height: 720)

    let windowId = UUID().uuidString
    let sessionId: String
    var onClose: (() -> Void)?

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(sessionId: String) {
        self.sessionId = sessionId
        super.init(contentRect: CGRect(origin: .zero, size: Self.defaultSize),
                   styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovableByWindowBackground = true
        becomesKeyOnlyIfNeeded = true
        level = .floating
        sharingType = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        contentMinSize = Self.minSize
        contentMaxSize = Self.maxSize
        appearance = NSAppearance(named: .darkAqua)
        title = "Winter computer use — live view"
    }

    /// Where a new detached window goes: the bottom-right corner of the island's screen (its visible frame, clear of the
    /// Dock and menu bar) — away from the top centre, where the work the agent watches (and the island) usually is.
    static let inset: CGFloat = 20
    static func initialFrame(visible: CGRect) -> CGRect {
        CGRect(x: visible.maxX - inset - defaultSize.width, y: visible.minY + inset,
               width: defaultSize.width, height: defaultSize.height)
    }
}

/// The detached window's content: a black rounded panel, a header (the session, ✕) and the live view filling the rest.
struct IslandDetachedMirrorView: View {
    let title: String
    let model: CUMirrorModel?
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "cursorarrow.motionlines")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(IslandCUColors.accent)
                Text(title)
                    .font(Typography.label(.medium))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 6)
                IslandSmallCircleButton(symbol: "xmark", action: onClose)
                    .accessibilityLabel("Close the live view")
            }
            IslandMirrorPicture(model: model)
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.black))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
        .environment(\.colorScheme, .dark)
    }
}

/// The live picture: the session's own mirror model (the helper's frames and the agent cursor), else the placeholder.
struct IslandMirrorPicture: View {
    let model: CUMirrorModel?
    /// The gallery's stand-in picture (`ImageRenderer` cannot draw the live canvas).
    var placeholder: Image?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.05))
            if let placeholder {
                placeholder.resizable().aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            } else if let model, model.isActive {
                CUMirrorView(model: model)
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "rectangle.dashed")
                        .font(Typography.heading(.light))
                        .foregroundStyle(Theme.textMuted)
                    Text("Waiting for the first picture")
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
