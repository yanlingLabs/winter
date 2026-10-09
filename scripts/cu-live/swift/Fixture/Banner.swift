import AppKit
import Foundation

// `--banner <json>`: the live run's own notices, in the result bundle (Winter CU Live Result, an agent app):
//   countdown — after the idle gate: "… will take over the screen in N s — move the mouse or press a key to
//               postpone"; the runner watches for input and closes it (postponed) or lets it run out (the run starts);
//   running   — for the whole run: "Winter test running — don't touch the Mac (stops on any input)".
// A floating, non-activating panel on every Space (over full screen too), never key, and left out of every screen
// capture (sharingType .none) — the run's own screenshots never see it. It exits when the runner (`watchPid`) is
// gone, or at `BannerModel.maxLifetime`, whichever comes first; the runner closes it normally.

struct BannerModel: Equatable {
    enum Kind: String { case countdown, running }
    var kind: Kind
    /// The countdown's length (countdown only).
    var seconds: Int
    /// The runner's pid: the banner goes when it does.
    var watchPid: Int32

    /// A banner never outlives this, whatever happens to the runner.
    static let maxLifetime: TimeInterval = 4 * 3600

    static func parse(_ json: String) -> BannerModel? {
        guard let data = json.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let raw = o["kind"] as? String, let kind = Kind(rawValue: raw),
              let watch = o["watchPid"] as? Int, watch > 0 else { return nil }
        let seconds = o["seconds"] as? Int ?? 0
        if kind == .countdown && seconds <= 0 { return nil }
        return BannerModel(kind: kind, seconds: seconds, watchPid: Int32(watch))
    }

    /// The banner's line with `remaining` whole seconds left (countdown), or the running notice.
    func text(remaining: Int) -> String {
        switch kind {
        case .countdown:
            return "Winter's computer-use test will take over the screen in \(max(0, remaining)) s — move the mouse or press a key to postpone"
        case .running:
            return "Winter test running — don't touch the Mac (stops on any input)"
        }
    }

    var glyph: String { kind == .countdown ? "⏳" : "●" }
    var tone: DoneModel.Tone { kind == .countdown ? .amber : .red }
}

private final class BannerPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
func runBanner(_ model: BannerModel) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let size = NSSize(width: model.kind == .countdown ? 520 : 400, height: model.kind == .countdown ? 64 : 40)
    let panel = BannerPanel(contentRect: NSRect(origin: .zero, size: size),
                            styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.hidesOnDeactivate = false
    panel.isFloatingPanel = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.ignoresMouseEvents = true          // never in the way: input meant for the Mac is what postpones/stops
    panel.sharingType = .none                // excluded from every screen capture
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true

    let root = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
    root.material = .hudWindow
    root.blendingMode = .behindWindow
    root.state = .active
    root.wantsLayer = true
    root.layer?.cornerRadius = 12
    let glyph = NSTextField(labelWithString: model.glyph)
    glyph.font = .systemFont(ofSize: model.kind == .countdown ? 22 : 12, weight: .bold)
    glyph.textColor = model.tone.color
    glyph.frame = NSRect(x: 12, y: (size.height - 28) / 2, width: 28, height: 28)
    let label = NSTextField(wrappingLabelWithString: model.text(remaining: model.seconds))
    label.font = .systemFont(ofSize: 12, weight: .medium)
    label.frame = NSRect(x: 44, y: 6, width: size.width - 56, height: size.height - 12)
    root.addSubview(glyph)
    root.addSubview(label)
    panel.contentView = root
    if let screen = NSScreen.main {
        let v = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: v.midX - size.width / 2, y: v.maxY - size.height - 12))
    }
    panel.orderFrontRegardless()

    let started = Date()
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
        // The runner gone (crashed, killed): nothing must stay on screen.
        if kill(model.watchPid, 0) != 0 && errno == ESRCH { exit(0) }
        let elapsed = Date().timeIntervalSince(started)
        if elapsed > BannerModel.maxLifetime { exit(0) }
        if model.kind == .countdown {
            let remaining = Int((Double(model.seconds) - elapsed).rounded(.up))
            label.stringValue = model.text(remaining: remaining)
            // The runner decides; a countdown left behind goes a little after its end.
            if elapsed > Double(model.seconds) + 15 { exit(0) }
        }
    }
    withExtendedLifetime(panel) { app.run() }
    exit(0)
}
