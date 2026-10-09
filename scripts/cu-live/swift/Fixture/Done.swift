import AppKit
import Foundation

// `--done <json>`: the end-of-run completion window. The runner launches this bundle with `open -n -g` AFTER its
// cleanup, so the user knows the live run ended: a small floating, non-activating panel on the current Space (and
// over a full-screen app), never key, never activating the app — the user's frontmost app keeps its focus. It stays
// until Close, or `DoneModel.lifetime` at most, then the process exits by itself.

/// What the window says — pure, so `--self-test` checks it without showing anything.
struct DoneModel: Equatable {
    enum Status: String { case pass, fail, aborted }
    enum Tone: Equatable { case green, amber, red }

    var status: Status
    var passed: Int
    var failed: Int
    var skipped: Int
    var durationMs: Int
    /// Epoch milliseconds.
    var finishedAt: Double
    /// The report (or log) to read.
    var path: String

    static let title = "Winter computer-use live test finished"
    /// The window's longest life: it exits by itself after this.
    static let lifetime: TimeInterval = 30 * 60

    /// `{"status","passed","failed","skipped","durationMs","finishedAt","path"}` → a model; nil when malformed.
    static func parse(_ json: String) -> DoneModel? {
        guard let data = json.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let raw = o["status"] as? String, let status = Status(rawValue: raw),
              let passed = o["passed"] as? Int, let failed = o["failed"] as? Int, let skipped = o["skipped"] as? Int,
              let durationMs = o["durationMs"] as? Int, let finishedAt = (o["finishedAt"] as? NSNumber)?.doubleValue,
              let path = o["path"] as? String,
              passed >= 0, failed >= 0, skipped >= 0, durationMs >= 0 else { return nil }
        return DoneModel(status: status, passed: passed, failed: failed, skipped: skipped, durationMs: durationMs, finishedAt: finishedAt, path: path)
    }

    /// ✓ green when everything passed, ! amber when anything failed, ✕ red when the run was aborted or errored.
    var glyph: String {
        switch status {
        case .pass: return "✓"
        case .fail: return "!"
        case .aborted: return "✕"
        }
    }

    var tone: Tone {
        switch status {
        case .pass: return .green
        case .fail: return .amber
        case .aborted: return .red
        }
    }

    var subtitle: String {
        switch status {
        case .pass: return "Everything passed."
        case .fail: return failed == 1 ? "1 test failed." : "\(failed) tests failed."
        case .aborted: return "The run was stopped before it finished."
        }
    }

    var countsLine: String { "\(passed) passed · \(failed) failed · \(skipped) skipped" }

    var durationText: String {
        let seconds = (durationMs + 500) / 1000
        if seconds < 60 { return "\(seconds) s" }
        let minutes = seconds / 60, rest = seconds % 60
        return rest == 0 ? "\(minutes) min" : "\(minutes) min \(rest) s"
    }

    func finishedText(timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "HH:mm:ss"
        return f.string(from: Date(timeIntervalSince1970: finishedAt / 1000))
    }

    func timingLine(timeZone: TimeZone = .current) -> String { "Took \(durationText) · finished at \(finishedText(timeZone: timeZone))" }
}

extension DoneModel.Tone {
    var color: NSColor {
        switch self {
        case .green: return .systemGreen
        case .amber: return .systemOrange
        case .red: return .systemRed
        }
    }
}

/// Never key (keyboard focus stays in the user's app); a click on Close still lands.
private final class DonePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class DoneController: NSObject {
    let panel: DonePanel
    init(model: DoneModel) {
        let size = NSSize(width: 440, height: 176)
        panel = DonePanel(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .fullSizeContentView],
                          backing: .buffered, defer: false)
        super.init()
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.contentView = content(model, size: size)
        if let screen = NSScreen.main {
            let v = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: v.maxX - size.width - 20, y: v.maxY - size.height - 20))
        }
    }

    private func content(_ model: DoneModel, size: NSSize) -> NSView {
        let root = NSView(frame: NSRect(origin: .zero, size: size))
        let badge = NSTextField(labelWithString: model.glyph)
        badge.font = .systemFont(ofSize: 44, weight: .bold)
        badge.textColor = model.tone.color
        badge.alignment = .center
        badge.frame = NSRect(x: 16, y: size.height - 92, width: 64, height: 64)
        let title = label(DoneModel.title, size: 14, weight: .semibold)
        title.frame = NSRect(x: 92, y: size.height - 50, width: size.width - 108, height: 20)
        let subtitle = label(model.subtitle, size: 12, weight: .regular)
        subtitle.textColor = model.tone.color
        subtitle.frame = NSRect(x: 92, y: size.height - 70, width: size.width - 108, height: 18)
        let counts = label(model.countsLine, size: 12, weight: .medium)
        counts.frame = NSRect(x: 92, y: size.height - 90, width: size.width - 108, height: 18)
        let timing = label(model.timingLine(), size: 11, weight: .regular)
        timing.textColor = .secondaryLabelColor
        timing.frame = NSRect(x: 92, y: size.height - 108, width: size.width - 108, height: 16)
        let path = label(model.path, size: 10, weight: .regular)
        path.textColor = .secondaryLabelColor
        path.lineBreakMode = .byTruncatingMiddle
        path.isSelectable = true
        path.toolTip = model.path
        path.frame = NSRect(x: 16, y: 46, width: size.width - 32, height: 16)
        let close = NSButton(title: "Close", target: self, action: #selector(closePressed))
        close.bezelStyle = .rounded
        close.frame = NSRect(x: size.width - 100, y: 10, width: 84, height: 28)
        for v in [badge, title, subtitle, counts, timing, path, close] as [NSView] { root.addSubview(v) }
        return root
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .systemFont(ofSize: size, weight: weight)
        l.lineBreakMode = .byTruncatingTail
        return l
    }

    @objc private func closePressed() { NSApp.terminate(nil) }
}

/// Shows the panel and runs until Close or `DoneModel.lifetime`. Never activates the app.
@MainActor
func runDoneWindow(_ model: DoneModel) -> Never {
    let app = NSApplication.shared
    // No Dock icon, no menu bar, never the active app.
    app.setActivationPolicy(.accessory)
    let controller = DoneController(model: model)
    controller.panel.orderFrontRegardless()
    Timer.scheduledTimer(withTimeInterval: DoneModel.lifetime, repeats: false) { _ in exit(0) }
    withExtendedLifetime(controller) { app.run() }
    exit(0)
}
