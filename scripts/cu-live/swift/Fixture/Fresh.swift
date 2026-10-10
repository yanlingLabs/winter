import AppKit
import WebKit

// MARK: - Fixture Fresh (the freshness measurement)

/// The content code every advancing region shows: the wall-clock counter `floor(ms / 100) & 0xFFFF` as 16 cells
/// (MSB first, black = 1) plus an odd-parity cell — decodable from pixels, so a capture tells which instant it
/// shows. Shared by the native view, `fresh.html` (the same rule in JS) and the runner's decoder.
enum FreshCode {
    static let cell: CGFloat = 28
    static let cells = 17
    /// The band's left edge and each region's top, in the window's content points (top-left).
    static let bandX: CGFloat = 72
    static let nativeY: CGFloat = 12
    /// The web view's top inside the content; its page draws the DOM band at 8, the canvas at 52, the CSS at 96.
    static let webY: CGFloat = 56

    static func value(atMs ms: Double) -> Int { Int((ms / 100).rounded(.down)) & 0xFFFF }

    /// 16 bits MSB first, then the parity cell (true when the count of ones is odd).
    static func bits(_ value: Int) -> [Bool] {
        let bits = (0..<16).map { (value >> (15 - $0)) & 1 == 1 }
        return bits + [bits.filter { $0 }.count % 2 == 1]
    }
}

/// A native (non-WebKit) region: redraws the code on a 100 ms timer.
final class FreshNativeView: NSView {
    private(set) var value = 0
    private var timer: Timer?
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }

    func start() {
        tick()
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() { timer?.invalidate(); timer = nil }

    private func tick() {
        value = FreshCode.value(atMs: Date().timeIntervalSince1970 * 1000)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        for (i, bit) in FreshCode.bits(value).enumerated() {
            (bit ? NSColor.black : NSColor.white).setFill()
            NSRect(x: CGFloat(i) * FreshCode.cell, y: 0, width: FreshCode.cell, height: FreshCode.cell).fill()
        }
    }
}

/// "Fixture Fresh": a native band and a WKWebView (`fresh.html`: a DOM counter on setInterval(100), a canvas on
/// requestAnimationFrame, a CSS animation), each in its own band, plus the sentinel that locates them in a
/// capture. Logs `fresh.tick` every 100 ms: the native value, and the page's DOM and canvas values with when the
/// page last posted each — what each region TRULY shows over time.
@MainActor
final class FreshController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let window: FixtureWindow
    let webView: WKWebView
    let native: FreshNativeView
    private var dom: (value: Int, at: Int)?
    private var canvas: (value: Int, at: Int)?
    private var ticker: Timer?
    private var occlusionObserver: NSObjectProtocol?
    /// Variant (a2): the owner-side WebKit switch that stops the view from following the window's occlusion state.
    let occlusionDetection: Bool

    init(slot: Int, occlusionDetection: Bool = true) {
        self.occlusionDetection = occlusionDetection
        window = makeFixtureWindow(title: "Fixture Fresh", slot: slot, fullScreenPrimary: true)
        let size = WindowGrid.contentSize
        let root = FlippedView(frame: NSRect(origin: .zero, size: size))
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.white.cgColor
        native = FreshNativeView(frame: NSRect(x: FreshCode.bandX, y: FreshCode.nativeY, width: FreshCode.cell * CGFloat(FreshCode.cells), height: FreshCode.cell))
        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(x: 0, y: FreshCode.webY, width: size.width, height: size.height - FreshCode.webY), configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        super.init()
        configuration.userContentController.add(self, name: "fresh")
        webView.navigationDelegate = self
        root.addSubview(webView)
        root.addSubview(native)
        root.addSubview(SentinelView(frame: Sentinel.rect)) // topmost: it locates everything in a capture
        window.contentView = root
    }

    /// `-[WKWebView _setWindowOcclusionDetectionEnabled:]` (owner-side, real: WebKitTestRunner disables it on the
    /// views it creates). Whether this WebKit has it is logged; it is never assumed.
    static func setOcclusionDetection(_ enabled: Bool, on webView: WKWebView) -> Bool {
        let selector = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        guard webView.responds(to: selector) else { return false }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(webView.method(for: selector), to: Setter.self)(webView, selector, enabled)
        return true
    }

    var isFullScreen: Bool { window.styleMask.contains(.fullScreen) }

    func start() {
        if !occlusionDetection {
            let supported = Self.setOcclusionDetection(false, on: webView)
            Fixture.shared.emit("fresh.occlusionDetection", [("enabled", .bool(false)), ("supported", .bool(supported))])
        }
        // What macOS tells the window: every occlusion-state change, logged.
        occlusionObserver = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                Fixture.shared.emit("fresh.occlusion", [("visible", .bool(self.window.occlusionState.contains(.visible)))])
            }
        }
        Fixture.shared.emit("fresh.occlusion", [("visible", .bool(window.occlusionState.contains(.visible))), ("initial", .bool(true))])
        native.start()
        if let page = Bundle.main.url(forResource: "fresh", withExtension: "html") {
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.logTick() } }
        RunLoop.main.add(t, forMode: .common)
        ticker = t
    }

    func stop() {
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
        occlusionObserver = nil
        ticker?.invalidate()
        ticker = nil
        native.stop()
        webView.stopLoading()
        window.orderOut(nil)
    }

    private func logTick() {
        var fields: [(String, JV)] = [("native", .int(native.value))]
        if let dom { fields += [("dom", .int(dom.value)), ("domAt", .int(dom.at))] }
        if let canvas { fields += [("canvas", .int(canvas.value)), ("canvasAt", .int(canvas.at))] }
        Fixture.shared.emit("fresh.tick", fields)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Fixture.shared.emit("fresh.ready", [("window", .int(window.windowNumber))])
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let kind = body["kind"] as? String,
              let value = (body["value"] as? NSNumber)?.intValue else { return }
        let at = Int((Date().timeIntervalSince1970 * 1000).rounded())
        if kind == "dom" { dom = (value, at) } else if kind == "canvas" { canvas = (value, at) }
    }
}
