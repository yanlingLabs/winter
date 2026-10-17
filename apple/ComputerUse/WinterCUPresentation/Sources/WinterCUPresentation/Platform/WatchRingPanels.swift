import AppKit
import QuartzCore

/// A watch's ring and pill: two click-through panels (`PassivePanel`: never key or main, never activating, on every
/// Space, floating, `sharingType = .none` — never in a capture). The ring is Winter's ice blue drawn twice (a dark
/// under-stroke, the light over-stroke) so it reads on any background; the pill is the cursor's near-black pill with
/// its faint rim.
@MainActor struct AppKitWatchRingFactory: WatchRingSurfaceFactory {
    func make() -> WatchRingSurface { AppKitWatchRing() }
}

@MainActor final class AppKitWatchRing: WatchRingSurface {
    private let ringPanel = PassivePanel(contentRect: CGRect(x: 0, y: 0, width: 10, height: 10), role: .cursorOverlay)
    private let pillPanel = PassivePanel(contentRect: CGRect(x: 0, y: 0, width: 10, height: 10), role: .cursorOverlay)
    private let ringView = FlippedLayerView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    private let pillView = FlippedLayerView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    private let under = CAShapeLayer()
    private let over = CAShapeLayer()
    private let pillFace = CALayer()
    private let text = CATextLayer()
    private var ringShown = false
    private var pillShown = false
    private static let font = NSFont.systemFont(ofSize: 12, weight: .medium)

    init() {
        for p in [ringPanel, pillPanel] {
            p.hasShadow = false
            p.title = "Winter watch"
        }
        ringPanel.contentView = ringView
        pillPanel.contentView = pillView
        let style = CursorStyle()
        under.fillColor = nil
        under.strokeColor = CursorStyle.black.cg(style.underAlpha)
        under.lineWidth = style.underWidth
        over.fillColor = nil
        over.strokeColor = CursorStyle.ice.cg()
        over.lineWidth = style.overWidth
        ringView.canvas.addSublayer(under)
        ringView.canvas.addSublayer(over)
        pillFace.backgroundColor = CursorStyle.ink.cg(style.pillFaceAlpha)
        pillFace.borderColor = CursorStyle.white.cg(style.pillRimAlpha)
        pillFace.borderWidth = 1
        pillFace.cornerCurve = .continuous
        pillView.canvas.addSublayer(pillFace)
        text.font = Self.font
        text.fontSize = Self.font.pointSize
        text.foregroundColor = CursorStyle.white.cg(0.92)
        text.alignmentMode = .center
        text.truncationMode = .end
        pillView.canvas.addSublayer(text)
    }

    func pillWidth(for sentence: String) -> CGFloat {
        let w = (sentence as NSString).size(withAttributes: [.font: Self.font]).width
        return ceil(w) + 28
    }

    func place(ring: CGRect?, pill: CGRect, sentence: String) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let ring {
            let pad: CGFloat = 4
            let frame = ring.insetBy(dx: -pad, dy: -pad)
            ringPanel.setFrame(AppKitScreens.appKitFrame(frame), display: false)
            let path = CGPath(roundedRect: CGRect(x: pad, y: pad, width: ring.width, height: ring.height),
                              cornerWidth: CUWatchRingModel.ringRadius, cornerHeight: CUWatchRingModel.ringRadius, transform: nil)
            for l in [under, over] {
                l.frame = CGRect(origin: .zero, size: frame.size)
                l.path = path
                l.contentsScale = AppKitScreens.backingScale(for: frame)
            }
        }
        pillPanel.setFrame(AppKitScreens.appKitFrame(pill), display: false)
        pillFace.frame = CGRect(origin: .zero, size: pill.size)
        pillFace.cornerRadius = pill.height / 2
        let lineHeight = ceil(Self.font.ascender - Self.font.descender)
        text.frame = CGRect(x: 12, y: (pill.height - lineHeight) / 2, width: pill.width - 24, height: lineHeight)
        text.string = sentence
        text.contentsScale = AppKitScreens.backingScale(for: pill)
        CATransaction.commit()
        if ring != nil, !ringShown { ringPanel.orderFrontShowingApp(); ringShown = true }
        if ring == nil, ringShown { ringPanel.orderOut(nil); ringShown = false }
        if !pillShown { pillPanel.orderFrontShowingApp(); pillShown = true }
    }

    func close() {
        ringPanel.orderOut(nil)
        pillPanel.orderOut(nil)
        ringPanel.close()
        pillPanel.close()
        ringShown = false
        pillShown = false
    }
}
