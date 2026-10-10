import AppKit

/// The desktop-switch prompt's panel: never key or main, never activates the helper, never in a capture
/// (`sharingType = .none`), on every Space — so it is on the user's CURRENT desktop, a full-screen app's
/// included — above ordinary windows, at the top centre of the screen the user is on.
final class DesktopPromptPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(contentRect: CGRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovable = false
        becomesKeyOnlyIfNeeded = true
        ignoresMouseEvents = false
        level = .statusBar
        animationBehavior = .none
        sharingType = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
    }
}

/// A button that takes the first click on a panel that is never key, without activating the helper.
final class FirstClickButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor struct AppKitDesktopPromptFactory: DesktopPromptSurfaceFactory {
    func make(_ model: CUDesktopPromptModel) -> DesktopPromptSurface { AppKitDesktopPrompt(model) }
}

@MainActor final class AppKitDesktopPrompt: NSObject, DesktopPromptSurface {
    var onSwitch: (() -> Void)?
    var onRefuse: (() -> Void)?

    static let width: CGFloat = 400
    static let margin: CGFloat = 12
    static let gap: CGFloat = 10

    private let panel: DesktopPromptPanel
    private let countdownLabel = NSTextField(labelWithString: "")
    private var shown = false
    private var slot = -1

    init(_ model: CUDesktopPromptModel) {
        panel = DesktopPromptPanel(contentRect: CGRect(x: 0, y: 0, width: Self.width, height: 160))
        super.init()
        let effect = NSVisualEffectView()
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 14
        effect.layer?.masksToBounds = true

        let title = NSTextField(labelWithString: model.title)
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        let appLine = NSTextField(labelWithString: model.appLine)
        appLine.font = .systemFont(ofSize: 11)
        appLine.textColor = .secondaryLabelColor
        appLine.lineBreakMode = .byTruncatingMiddle
        let reason = NSTextField(wrappingLabelWithString: model.reason)
        reason.font = .systemFont(ofSize: 12)
        reason.maximumNumberOfLines = 4
        reason.preferredMaxLayoutWidth = Self.width - 32
        reason.isHidden = model.reason.isEmpty
        let back = NSTextField(labelWithString: model.backLine)
        back.font = .systemFont(ofSize: 12)
        back.textColor = .secondaryLabelColor
        countdownLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)

        let refuse = FirstClickButton(title: "Don't switch", target: self, action: #selector(refuseClicked))
        refuse.bezelStyle = .rounded
        let go = FirstClickButton(title: "Switch now", target: self, action: #selector(switchClicked))
        go.bezelStyle = .rounded
        go.bezelColor = .controlAccentColor
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [countdownLabel, spacer, refuse, go])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [title, appLine, reason, back, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        buttons.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            stack.topAnchor.constraint(equalTo: effect.topAnchor),
            stack.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: Self.width),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
        ])
        panel.contentView = effect
        // Its window name (the window list's), so a reader of the list can tell this panel from the helper's others.
        panel.title = model.title
        panel.setAccessibilityLabel(model.title)
    }

    @objc private func switchClicked() { onSwitch?() }
    @objc private func refuseClicked() { onRefuse?() }

    func show(countdown: String, slot: Int) {
        countdownLabel.stringValue = countdown
        guard !shown || slot != self.slot else { return }
        self.slot = slot
        place(slot: slot)
        if !shown {
            shown = true
            if NSApp.isHidden { NSApp.unhideWithoutActivation() }
            panel.orderFrontRegardless()
        }
    }

    /// Closed, not merely hidden: the window leaves the window list's on-screen set at once, and goes with this
    /// object (the controller drops it).
    func close() {
        shown = false
        panel.orderOut(nil)
        panel.close()
    }

    /// Top centre of the screen the pointer is on (where the user is), below the menu bar, `slot` panels down.
    private func place(slot: Int) {
        panel.contentView?.layoutSubtreeIfNeeded()
        let size = panel.contentView?.fittingSize ?? CGSize(width: Self.width, height: 160)
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let top = visible.maxY - Self.margin - CGFloat(slot) * (size.height + Self.gap)
        let frame = CGRect(x: visible.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height)
        panel.setFrame(frame, display: true)
    }
}
