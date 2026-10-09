import AppKit
import WebKit

// The fixture's windows. Each controller builds its window programmatically (no nib) and logs the events the
// contract lists — nothing else.

// MARK: - Native fields

final class FocusTextField: NSTextField, FocusIdentifiable {
    let focusID: String

    init(id: String, label: String, placeholder: String? = nil, frame: NSRect) {
        self.focusID = id
        super.init(frame: frame)
        isEditable = true
        isSelectable = true
        isBordered = true
        isBezeled = true
        drawsBackground = true
        placeholderString = placeholder
        identifier = NSUserInterfaceItemIdentifier(id)
        setAccessibilityIdentifier(id)
        setAccessibilityLabel(label)
        delegate = FieldChangeLogger.shared
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

final class NotesTextView: NSTextView, FocusIdentifiable {
    var focusID: String { "notes" }
}

/// Logs `field.change` for every EDIT of the native fields (typing, paste, undo, menu actions that call
/// didChangeText). Programmatic resets do not fire these delegate methods, so `reset` is silent by construction.
@MainActor
final class FieldChangeLogger: NSObject, NSTextFieldDelegate, NSTextViewDelegate {
    static let shared = FieldChangeLogger()

    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? FocusTextField else { return }
        // The field editor holds the live text while editing; stringValue can lag until editing ends.
        let editor = obj.userInfo?["NSFieldEditor"] as? NSText
        Fixture.shared.emit("field.change", [("id", .str(field.focusID)), ("value", .str(editor?.string ?? field.stringValue))])
    }

    func textDidChange(_ obj: Notification) {
        guard let view = obj.object as? NotesTextView else { return }
        Fixture.shared.emit("field.change", [("id", .str(view.focusID)), ("value", .str(view.string))])
    }
}

/// A plain-text view for typing, with every smart substitution off so what is typed is what is logged.
@MainActor
private func plainTextConfigured(_ view: NSTextView) {
    view.isRichText = false
    view.importsGraphics = false
    view.allowsUndo = true
    view.isAutomaticQuoteSubstitutionEnabled = false
    view.isAutomaticDashSubstitutionEnabled = false
    view.isAutomaticTextReplacementEnabled = false
    view.isAutomaticSpellingCorrectionEnabled = false
    view.isAutomaticLinkDetectionEnabled = false
    view.isAutomaticDataDetectionEnabled = false
    view.isContinuousSpellCheckingEnabled = false
    view.isGrammarCheckingEnabled = false
    view.smartInsertDeleteEnabled = false
    view.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
}

/// The sentinel as a view (Form, Offspace): opaque, drawn with exactly #FF00FF, and invisible to hit-testing and
/// accessibility so it changes nothing about how the window is driven. See `Sentinel`.
final class SentinelView: NSView {
    override var isOpaque: Bool { true }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) { Sentinel.fill(bounds) }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }
}

/// The notes text view's scroll view. It logs `scroller {id:"notes", value, byWheel}` whenever the vertical
/// position changes (the clip view's bounds-changed notification), so the suite can tell a wheel scroll from a
/// scroll made through the scroller itself (accessibility increment/value set, a click on the track, the keyboard).
/// `value` is the vertical scroller's doubleValue (0 top .. 1 bottom), computed from the geometry so it does not
/// depend on whether the scroller has caught up yet. At most 10 lines a second; the last value of a burst is
/// always logged.
final class NotesScrollView: NSScrollView {
    private var wheel = WheelWindow()
    private var throttle = Throttle<ScrollerSample>(minInterval: 0.1)
    private var report = ScrollerReport()
    private var silentUntil = 0.0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // The initial position is the top; creating the view is not a scroll.
        report.rebase(0)
        contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(clipBoundsChanged(_:)),
                                               name: NSView.boundsDidChangeNotification, object: contentView)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var uptime: Double { ProcessInfo.processInfo.systemUptime }

    /// The text system hands wheel events up the responder chain to here. The flag covers the event's own handling
    /// and the 300 ms after it (see `WheelWindow`).
    override func scrollWheel(with event: NSEvent) {
        wheel.begin()
        super.scrollWheel(with: event)
        wheel.end(now: uptime)
    }

    /// A programmatic reset moves the position without it being a scroll the suite should see: ignored for a
    /// moment (text-driven scrolling can land a little after the assignment), with the position re-based.
    func silence(for seconds: Double = 0.5) { silentUntil = uptime + seconds }

    @objc private func clipBoundsChanged(_ note: Notification) {
        guard let document = documentView else { return }
        let now = uptime
        let value = ScrollerMath.rounded(ScrollerMath.value(offset: Double(contentView.bounds.origin.y),
                                                            contentHeight: Double(document.frame.height),
                                                            viewportHeight: Double(contentView.bounds.height)))
        if now < silentUntil {
            report.rebase(value)
            return
        }
        guard report.changed(value) else { return }
        let sample = ScrollerSample(value: value, byWheel: wheel.isWheel(now: now))
        switch throttle.offer(sample, now: now) {
        case .emit(let sample):
            emit(sample)
        case .flushAt(let due):
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, due - now)) { [weak self] in
                MainActor.assumeIsolated { self?.flush() }
            }
        case .absorbed:
            break
        }
    }

    private func flush() {
        if let sample = throttle.flush(now: uptime) { emit(sample) }
    }

    private func emit(_ sample: ScrollerSample) {
        Fixture.shared.emit("scroller", [("id", .str("notes")), ("value", .num(sample.value)), ("byWheel", .bool(sample.byWheel))])
    }
}

@MainActor
private func scrollContaining(_ textView: NSTextView, frame: NSRect) -> NSScrollView {
    scrollContaining(textView, in: NSScrollView(frame: frame))
}

@MainActor
private func scrollContaining(_ textView: NSTextView, in scroll: NSScrollView) -> NSScrollView {
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    scroll.autoresizingMask = [.width, .height]
    let size = scroll.contentSize
    textView.frame = NSRect(origin: .zero, size: size)
    textView.minSize = NSSize(width: 0, height: size.height)
    textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.autoresizingMask = [.width]
    textView.textContainer?.containerSize = NSSize(width: size.width, height: CGFloat.greatestFiniteMagnitude)
    textView.textContainer?.widthTracksTextView = true
    scroll.documentView = textView
    return scroll
}

// MARK: - (a) Fixture Form

@MainActor
final class FormController: NSObject {
    let window: FixtureWindow
    let name: FocusTextField
    let email: FocusTextField
    let notes: NotesTextView
    let notesScroll: NotesScrollView
    let agree: NSButton
    private let openDocument: () -> Void

    init(slot: Int, openDocument: @escaping () -> Void) {
        self.openDocument = openDocument
        window = makeFixtureWindow(title: "Fixture Form", slot: slot)
        let root = FlippedView(frame: NSRect(origin: .zero, size: WindowGrid.contentSize))

        // Everything starts at x = 72: the top-left 8..56 pt square belongs to the sentinel (see `Sentinel`).
        let left: CGFloat = 72
        func caption(_ text: String, y: CGFloat) {
            let label = NSTextField(labelWithString: text)
            label.frame = NSRect(x: left, y: y, width: 200, height: 18)
            root.addSubview(label)
        }
        caption("Name", y: 16)
        name = FocusTextField(id: "name", label: "Name", placeholder: "Name", frame: NSRect(x: left, y: 36, width: 300, height: 24))
        caption("Email", y: 70)
        email = FocusTextField(id: "email", label: "Email", placeholder: "Email", frame: NSRect(x: left, y: 90, width: 300, height: 24))
        caption("Notes", y: 124)
        notes = NotesTextView(frame: .zero)
        plainTextConfigured(notes)
        notes.delegate = FieldChangeLogger.shared
        notes.setAccessibilityIdentifier("notes")
        notes.setAccessibilityLabel("Notes")
        notes.identifier = NSUserInterfaceItemIdentifier("notes")
        let scroll = NotesScrollView(frame: NSRect(x: left, y: 144, width: 548, height: 150))
        _ = scrollContaining(notes, in: scroll)
        notesScroll = scroll
        agree = NSButton(checkboxWithTitle: "Agree", target: nil, action: nil)
        super.init()

        let submit = NSButton(title: "Submit", target: self, action: #selector(submitPressed(_:)))
        submit.frame = NSRect(x: left, y: 312, width: 90, height: 28)
        submit.identifier = NSUserInterfaceItemIdentifier("submit")
        submit.setAccessibilityIdentifier("submit")
        let open = NSButton(title: "Open Document", target: self, action: #selector(openDocumentPressed(_:)))
        open.frame = NSRect(x: left + 100, y: 312, width: 140, height: 28)
        open.identifier = NSUserInterfaceItemIdentifier("open-document")
        open.setAccessibilityIdentifier("open-document")
        agree.target = self
        agree.action = #selector(agreeToggled(_:))
        agree.frame = NSRect(x: left + 260, y: 314, width: 100, height: 24)
        agree.identifier = NSUserInterfaceItemIdentifier("agree")
        agree.setAccessibilityIdentifier("agree")

        for view in [name, email, notesScroll, submit, open, agree] as [NSView] { root.addSubview(view) }
        // Added last, so it is topmost.
        root.addSubview(SentinelView(frame: Sentinel.rect))
        window.contentView = root
    }

    @objc private func submitPressed(_ sender: NSButton) {
        Fixture.shared.emit("button", [("id", .str("submit"))])
    }

    @objc private func openDocumentPressed(_ sender: NSButton) {
        Fixture.shared.emit("button", [("id", .str("open-document"))])
        openDocument()
    }

    @objc private func agreeToggled(_ sender: NSButton) {
        Fixture.shared.emit("button", [("id", .str("agree")), ("checked", .bool(sender.state == .on))])
    }

    /// Silent: assigning programmatically fires no delegate callbacks.
    func reset() {
        name.stringValue = ""
        email.stringValue = ""
        notesScroll.silence()
        notes.string = ""
        notes.setSelectedRange(NSRange(location: 0, length: 0))
        notes.undoManager?.removeAllActions()
        agree.state = .off
    }
}

// MARK: - (b) Fixture Web

/// A press anywhere in the page is the "mousedown" steal trigger. Done natively, in one place, rather than from
/// the page, so a click is counted once.
final class FixtureWebView: WKWebView {
    override func mouseDown(with event: NSEvent) {
        MainActor.assumeIsolated { Fixture.shared.fire(.mouseDown) }
        super.mouseDown(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        MainActor.assumeIsolated { Fixture.shared.fire(.mouseDown) }
        super.rightMouseDown(with: event)
    }
}

/// Makes sure a completion runs once even if two paths (the result and a timeout) race to call it.
final class OneShot {
    private var fired = false
    func run(_ body: () -> Void) {
        guard !fired else { return }
        fired = true
        body()
    }
}

@MainActor
final class WebController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let window: FixtureWindow
    let webView: FixtureWebView
    var onLoaded: (() -> Void)?
    private var throttle = ScrollThrottle()

    init(slot: Int) {
        window = makeFixtureWindow(title: "Fixture Web", slot: slot)
        let configuration = WKWebViewConfiguration()
        webView = FixtureWebView(frame: NSRect(origin: .zero, size: WindowGrid.contentSize), configuration: configuration)
        super.init()
        configuration.userContentController.add(self, name: "fixture")
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
    }

    func start() {
        if let page = Bundle.main.url(forResource: "page", withExtension: "html") {
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        } else {
            webView.loadHTMLString("<!doctype html><title>Fixture Web</title><p>page.html is missing from the bundle.</p>", baseURL: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The runner waits for this before a web scenario: a page still loading has no fields yet.
        Fixture.shared.emit("web.didFinish", [("url", .str(webView.url?.lastPathComponent ?? ""))])
        onLoaded?()
        onLoaded = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Fixture.shared.emit("web.didFail", [("error", .str(error.localizedDescription))])
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Fixture.shared.emit("web.didFail", [("error", .str(error.localizedDescription))])
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let fixture = Fixture.shared!
        func number(_ key: String) -> Double? { (body[key] as? NSNumber)?.doubleValue }
        switch type {
        case "input":
            guard let id = body["id"] as? String else { return }
            fixture.emit("web.input", [("id", .str(id)), ("value", .str(body["value"] as? String ?? ""))])
        case "doc":
            fixture.emit("web.doc", [("text", .str(body["text"] as? String ?? ""))])
        case "click":
            guard let id = body["id"] as? String, let x = number("x"), let y = number("y") else { return }
            fixture.emit("web.click", [("id", .str(id)), ("x", .num(Rounding.half(x))), ("y", .num(Rounding.half(y)))])
        case "canvas":
            guard let x = number("x"), let y = number("y") else { return }
            fixture.emit("web.canvas", [("x", .num(Rounding.half(x))), ("y", .num(Rounding.half(y))),
                                        ("button", .str(body["button"] as? String ?? "left"))])
        case "link":
            fixture.emit("web.link", [("href", .str(body["href"] as? String ?? ""))])
        case "scroll":
            guard let y = number("y") else { return }
            offerScroll(y)
        case "focus":
            guard let id = body["id"] as? String else { return }
            // Both events: `web.focus` is the page-level fact, `focus` the cross-surface one the rig watches.
            fixture.emit("web.focus", [("id", .str(id))])
            fixture.focusGained(id: id, steals: (body["field"] as? Bool) ?? false)
        default:
            break
        }
    }

    // MARK: Scroll throttle (<= 4 per second)

    private func offerScroll(_ y: Double) {
        let now = ProcessInfo.processInfo.systemUptime
        switch throttle.offer(y, now: now) {
        case .emit(let value):
            emitScroll(value)
        case .flushAt(let due):
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, due - now)) { [weak self] in
                MainActor.assumeIsolated { self?.flushScroll() }
            }
        case .absorbed:
            break
        }
    }

    private func flushScroll() {
        if let y = throttle.flush(now: ProcessInfo.processInfo.systemUptime) { emitScroll(y) }
    }

    private func emitScroll(_ y: Double) {
        Fixture.shared.emit("web.scroll", [("y", .num(y))])
    }

    // MARK: Commands

    /// The page's `fixtureState()` as JSON, or null when the page has not loaded / the script fails.
    func state(completion: @escaping (JV) -> Void) {
        let once = OneShot()
        webView.evaluateJavaScript("JSON.stringify(window.fixtureState())") { result, _ in
            once.run {
                if let text = result as? String, let data = text.data(using: .utf8),
                   let object = try? JSONSerialization.jsonObject(with: data, options: []) {
                    completion(JV.from(any: object))
                } else {
                    completion(.null)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { once.run { completion(.null) } }
    }

    func reset(completion: @escaping () -> Void) {
        let once = OneShot()
        webView.evaluateJavaScript("window.fixtureReset && window.fixtureReset()") { _, _ in once.run(completion) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { once.run(completion) }
    }
}

// MARK: - (c) Fixture Canvas

/// A custom-drawn view with NO accessibility children: to the accessibility tree it is one empty group, which
/// is exactly what makes it a pixel-and-coordinate target for the computer-use stack.
final class CanvasView: NSView {
    private var tinted = false
    private var timer: Timer?
    private var animationStart = 0.0
    private(set) var animating = false

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // Accessibility: one group, no children, no actions.
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { "Fixture Canvas" }
    override func accessibilityIdentifier() -> String { "canvas" }
    override func accessibilityChildren() -> [Any]? { [] }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let menu = NSMenu(title: "Canvas")
        for title in ["Canvas Red", "Canvas Clear"] {
            let item = NSMenuItem(title: title, action: #selector(contextItem(_:)), keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        self.menu = menu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: Drawing — varied colour so a screenshot is never blank

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
        bounds.fill()
        let cell: CGFloat = 40
        let columns = Int(ceil(bounds.width / cell))
        let rows = Int(ceil(bounds.height / cell))
        for row in 0..<rows {
            for column in 0..<columns where (row + column) % 2 == 0 {
                NSColor(calibratedHue: CGFloat((row * 7 + column * 3) % 12) / 12, saturation: 0.3, brightness: 0.95, alpha: 1).setFill()
                NSRect(x: CGFloat(column) * cell, y: CGFloat(row) * cell, width: cell, height: cell).fill()
            }
        }
        NSColor(calibratedWhite: 0.55, alpha: 1).setStroke()
        let grid = NSBezierPath()
        for column in 0...columns {
            grid.move(to: NSPoint(x: CGFloat(column) * cell, y: 0))
            grid.line(to: NSPoint(x: CGFloat(column) * cell, y: bounds.height))
        }
        for row in 0...rows {
            grid.move(to: NSPoint(x: 0, y: CGFloat(row) * cell))
            grid.line(to: NSPoint(x: bounds.width, y: CGFloat(row) * cell))
        }
        grid.lineWidth = 0.5
        grid.stroke()

        let title = "Fixture Canvas" as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 28), .foregroundColor: NSColor(calibratedWhite: 0.15, alpha: 1)]
        let size = title.size(withAttributes: attributes)
        title.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attributes)

        if tinted {
            NSColor(calibratedRed: 0.9, green: 0.1, blue: 0.1, alpha: 0.35).setFill()
            bounds.fill()
        }
        if animating {
            let x = Animation.squareX(elapsed: ProcessInfo.processInfo.systemUptime - animationStart, width: Double(bounds.width))
            NSColor.systemPink.setFill()
            NSRect(x: x, y: (bounds.height - Animation.squareSize) / 2 + 60, width: Animation.squareSize, height: Animation.squareSize).fill()
        }
        // Last of all, so neither the tint nor the moving square can touch it. See `Sentinel`.
        Sentinel.fill(Sentinel.rect)
    }

    // MARK: Animation

    func setAnimating(_ on: Bool) {
        guard on != animating else { return }
        animating = on
        timer?.invalidate()
        timer = nil
        if on {
            animationStart = ProcessInfo.processInfo.systemUptime
            let tick = Timer(timeInterval: 1.0 / Animation.framesPerSecond, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.needsDisplay = true }
            }
            // .common: the animation keeps running while a menu is being tracked.
            RunLoop.main.add(tick, forMode: .common)
            timer = tick
        }
        needsDisplay = true
    }

    func clearTint() {
        tinted = false
        needsDisplay = true
    }

    // MARK: Events

    private func logMouse(_ event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        Fixture.shared.emit("canvas.mouse", [("button", .str(MouseButton.name(for: event.type))),
                                             ("x", .num(Rounding.half(Double(point.x)))),
                                             ("y", .num(Rounding.half(Double(point.y)))),
                                             ("clicks", .int(event.clickCount))])
    }

    override func mouseDown(with event: NSEvent) {
        _ = window?.makeFirstResponder(self)
        logMouse(event)
        Fixture.shared.fire(.mouseDown)
    }

    override func rightMouseDown(with event: NSEvent) {
        logMouse(event)
        Fixture.shared.fire(.mouseDown)
        // super shows the context menu and blocks until it is dismissed, so everything above comes first.
        super.rightMouseDown(with: event)
    }

    override func otherMouseDown(with event: NSEvent) {
        logMouse(event)
        Fixture.shared.fire(.mouseDown)
    }

    override func scrollWheel(with event: NSEvent) {
        func rounded(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }
        Fixture.shared.emit("canvas.scroll", [("dx", .num(rounded(event.scrollingDeltaX))), ("dy", .num(rounded(event.scrollingDeltaY)))])
    }

    override func keyDown(with event: NSEvent) {
        // Not forwarded to super: an unhandled key would beep, and the canvas is the end of the chain by design.
        Fixture.shared.emit("canvas.key", [("chars", .str(event.characters ?? "")), ("keyCode", .int(Int(event.keyCode))),
                                           ("mods", .arr(Mods.names(event.modifierFlags).map { JV.str($0) }))])
    }

    @objc private func contextItem(_ sender: NSMenuItem) {
        Fixture.shared.emit("context", [("item", .str(sender.title))])
        tinted = sender.title == "Canvas Red"
        needsDisplay = true
    }
}

@MainActor
final class CanvasController {
    let window: FixtureWindow
    let canvas: CanvasView

    init(slot: Int) {
        window = makeFixtureWindow(title: "Fixture Canvas", slot: slot)
        canvas = CanvasView(frame: NSRect(origin: .zero, size: WindowGrid.contentSize))
        canvas.autoresizingMask = [.width, .height]
        window.contentView = canvas
    }
}

// MARK: - (g) Document windows

@MainActor
func makeDocumentWindow(url: URL, slot: Int) -> FixtureWindow {
    let window = makeFixtureWindow(title: DocTitle.make(path: url.path), slot: slot)
    let text = (try? String(contentsOf: url, encoding: .utf8)) ?? "(this document could not be read)"
    let textView = NSTextView(frame: .zero)
    textView.isEditable = false
    textView.isSelectable = true
    textView.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    textView.string = text
    textView.setAccessibilityIdentifier("document-text")
    textView.setAccessibilityLabel("Document")
    window.contentView = scrollContaining(textView, frame: NSRect(origin: .zero, size: WindowGrid.contentSize))
    return window
}

// MARK: - Off-Space window

final class RainbowView: NSView {
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let colors = (0..<7).map { NSColor(calibratedHue: CGFloat($0) / 7, saturation: 0.65, brightness: 0.95, alpha: 1) }
        NSGradient(colors: colors)?.draw(in: bounds, angle: 20)
    }
}

@MainActor
final class OffspaceController {
    let window: FixtureWindow
    let field: FocusTextField

    init(slot: Int) {
        window = makeFixtureWindow(title: "Fixture Offspace", slot: slot, fullScreenPrimary: true)
        let root = RainbowView(frame: NSRect(origin: .zero, size: WindowGrid.contentSize))
        let caption = NSTextField(labelWithString: "Offspace")
        caption.font = NSFont.boldSystemFont(ofSize: 24)
        caption.frame = NSRect(x: 72, y: 40, width: 300, height: 32)
        field = FocusTextField(id: "offspace", label: "Offspace Field", placeholder: "Offspace", frame: NSRect(x: 72, y: 100, width: 320, height: 24))
        root.addSubview(caption)
        root.addSubview(field)
        // Topmost, at the top-left of the content area — also in full screen. See `Sentinel`.
        root.addSubview(SentinelView(frame: Sentinel.rect))
        window.contentView = root
    }

    var isFullScreen: Bool { window.styleMask.contains(.fullScreen) }
}

// MARK: - Role user: "the user's app"

@MainActor
final class UserController {
    let window: UserWindow
    let field: NSTextField

    init() {
        window = UserWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 220),
                            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "User's App"
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        // A plain field: the only log line it produces is `user.key` (from the window), never `field.change`.
        field = NSTextField(frame: NSRect(x: 20, y: 90, width: 480, height: 24))
        field.placeholderString = "User notes"
        field.identifier = NSUserInterfaceItemIdentifier("user-notes")
        field.setAccessibilityIdentifier("user-notes")
        field.setAccessibilityLabel("User Notes")
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 220))
        root.addSubview(field)
        window.contentView = root
        // Bottom-right cell: Fixture Form (slot 0, the main typing target) and the other fixture windows stay
        // unobstructed. Offset inside the cell so Offspace's top-left corner (and its sentinel) stays uncovered.
        place(window, slot: 3, offset: CGPoint(x: 100, y: -60))
    }
}
