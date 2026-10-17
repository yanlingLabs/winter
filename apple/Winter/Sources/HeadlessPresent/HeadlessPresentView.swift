import AppKit
import QuartzCore
import SwiftUI
import WinterKit

/// ComputerV2 Phase 4 (lane H3) — **the live page in Winter's panel**: a viewport onto a `HeadlessPresentation`.
///
/// It draws nothing itself: its backing layer is a `CAMetalLayer` the presentation's renderer draws the producer's
/// frames into. It asks for the page to be laid out in its own size — its bounds in points at its screen's backing scale,
/// following a resize, the panel's expand button and a move to another display — so the page reflows to the panel and
/// is drawn one CSS pixel per point, crisp (`HeadlessPresentGeometry`). What it owns is the person's side:
///
/// - **Input, only while they hold control** (a watch-only view shows the page and its cursor and sends nothing):
///   mouse moves, presses and drags in CSS pixels through the inverse of the fit (outside the page ignored, a drag
///   that started on it pinned to its edge), clicks with their count, right and middle buttons, scrolling, the mouse
///   leaving; keys the way CEF's own macOS off-screen sample does it (`tests/cefclient`, adapted — its
///   `CefBrowserHost` calls are messages to the helper here): a raw key down carrying the Windows key code, the
///   native key code, the character and the unmodified character, then whatever the input method made of it — one
///   character as a char event, more as committed text, a composition as IME messages — and a key up.
/// - **The input method** (`NSTextInputClient`): marked text → setComposition, a commit → commitText, unmark →
///   finishComposing; the candidate window placed from the producer's latest character rects.
/// - **Edit commands** from the responder chain (copy, cut, paste, select all, undo, redo, delete) → the helper's own
///   edit commands; a paste carries the plain text Winter read from the pasteboard on the person's ⌘V — text only.
/// - **The page's cursor** over the page.
/// - **Accessibility**: one element naming the page and whether the person has control. The page's own content is
///   not exposed (that would need the helper's accessibility tree).
final class HeadlessPresentView: NSView, NSTextInputClient {
    private(set) var presentation: HeadlessPresentation?
    private let metalLayer = CAMetalLayer()
    private var tracking: NSTrackingArea?
    /// The mouse is over the page (not the letterbox) — for the leave event.
    private var mouseOnPage = false
    /// Buttons pressed on the page and not yet released (a drag keeps reaching the page).
    private var pressed: Set<Int32> = []
    /// The window's occlusion observer: a window nobody can see draws nothing (its layer would hold the renderer's
    /// queue waiting for a drawable).
    private var occlusionObserver: NSObjectProtocol?
    /// The label and value VoiceOver was last told of.
    private var lastSpoken: [String] = []

    // The key-down state machine (cefclient's `HandleKeyEventBefore/AfterTextInputClient`).
    private var handlingKeyDown = false
    private var oldHasMarkedText = false
    private var textToInsert = ""
    private var compositionUpdated = false
    private var unmarkCalled = false
    private var hasMarked = false
    private var markedText = ""
    private var markedSelection = NSRange(location: NSNotFound, length: 0)
    private var markedReplacement = NSRange(location: NSNotFound, length: 0)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override var isFlipped: Bool { true }
    override func makeBackingLayer() -> CALayer { metalLayer }
    override var isOpaque: Bool { true }
    override var acceptsFirstResponder: Bool { presentation?.acceptsInput ?? false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { presentation?.acceptsInput ?? false }

    // MARK: - The presentation

    /// Show `presentation` (nil: none). The previous one's renderer lets this view's layer go — only this view's: a
    /// newer view showing it keeps drawing.
    func attach(_ presentation: HeadlessPresentation?) {
        guard presentation !== self.presentation else { return }
        if let old = self.presentation {
            old.renderer.detach(metalLayer)
            if old.view === self { old.view = nil }
            resetInputState()
        }
        self.presentation = presentation
        if let presentation {
            presentation.renderer.attach(metalLayer)
            presentation.view = self
        }
        updateViewport()
        presentationChanged()
    }

    /// The view is going away (SwiftUI dismantled it): the presentation keeps running without it.
    func detach() { attach(nil) }

    /// The presentation's state changed (welcomed, control, ended, the page's title).
    func presentationChanged() {
        if presentation?.acceptsInput != true {
            if hasMarked { inputContext?.discardMarkedText() }
            resetInputState()
            if window?.firstResponder === self { window?.makeFirstResponder(nil) }
        }
        updateViewport()
        window?.invalidateCursorRects(for: self)
        // VoiceOver hears a change only when there is one (SwiftUI updates this view far more often).
        let spoken = [accessibilityLabel() ?? "", accessibilityValue() as? String ?? ""]
        if spoken != lastSpoken {
            lastSpoken = spoken
            NSAccessibility.post(element: self, notification: .valueChanged)
        }
    }

    /// The page's cursor changed.
    func cursorChanged() {
        window?.invalidateCursorRects(for: self)
        guard let presentation, let window else { return }
        let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        if pageRect.contains(point) { presentation.cursor.cursor.set() }
    }

    private func resetInputState() {
        pressed = []
        mouseOnPage = false
        hasMarked = false
        markedText = ""
        handlingKeyDown = false
    }

    // MARK: - Geometry

    private var cssSize: CGSize { presentation?.cssSize ?? CGSize(width: 1280, height: 800) }
    /// Where the page is drawn (top-left, one point per CSS pixel; `HeadlessPresentGeometry.pageRect`).
    private var pageRect: CGRect { HeadlessPresentGeometry.pageRect(content: cssSize, in: bounds.size) }

    override func layout() {
        super.layout()
        updateViewport()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateViewport()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateViewport()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateViewport()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
        occlusionObserver = nil
        if let window {
            occlusionObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.updateViewport() }
            }
        }
        updateViewport()
        if window != nil, let presentation, presentation.view === self {
            presentation.view = self // a prompt waiting for a window can show now
        }
    }

    private func updateViewport() {
        // Only the view showing it sizes its pictures (an older view still being torn down never does).
        guard let presentation, presentation.view === self else { return }
        let backing = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        metalLayer.contentsScale = backing
        // Off screen (no window, a miniaturised or fully covered one): nothing is drawn — the renderer keeps copying
        // frames, and draws the newest as soon as the window can be seen again.
        let visible = window?.occlusionState.contains(.visible) == true
        presentation.renderer.setViewport(.init(
            drawableSize: visible ? CGSize(width: (bounds.width * backing).rounded(), height: (bounds.height * backing).rounded()) : .zero,
            bounds: bounds.size, backingScale: backing, clear: letterboxColor()))
        // The page is laid out in this view's own size at its screen's backing scale, following it live: a resize, the
        // panel's expand button, a move to another display. Only from a view in a window (a view being torn down, or not
        // yet placed, asks nothing).
        if window != nil, let wish = HeadlessPresentGeometry.viewWish(bounds: bounds.size, backingScale: Double(backing)) {
            presentation.viewWants(wish)
        }
    }

    /// The panel's card surface, resolved for this view's appearance (brand: named colours only).
    private func letterboxColor() -> MTLClearColor {
        var color = MTLClearColor(red: 1, green: 1, blue: 1, alpha: 1)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            if let resolved = NSColor(named: "CardSurface")?.usingColorSpace(.sRGB) {
                color = MTLClearColor(red: Double(resolved.redComponent), green: Double(resolved.greenComponent),
                                      blue: Double(resolved.blueComponent), alpha: 1)
            }
        }
        return color
    }

    // MARK: - Cursor

    override func resetCursorRects() {
        guard let presentation else { return }
        addCursorRect(pageRect, cursor: presentation.cursor.cursor)
    }

    // MARK: - Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    private func viewPoint(_ event: NSEvent) -> CGPoint { convert(event.locationInWindow, from: nil) }

    private func message(_ kind: Int, _ event: NSEvent, at css: CGPoint, button: HeadlessPresentKeys.MouseButton) -> WinterPresentInputMsg {
        var m = WinterPresentInputMsg()
        m.kind = UInt32(kind)
        m.modifiers = HeadlessPresentKeys.modifiers(event.modifierFlags, button: button)
        m.x = Int32(css.x)
        m.y = Int32(css.y)
        return m
    }

    private func buttonIndex(_ button: HeadlessPresentKeys.MouseButton) -> Int32 {
        switch button {
        case .middle: return 1
        case .right: return 2
        default: return 0
        }
    }

    private func press(_ event: NSEvent, button: HeadlessPresentKeys.MouseButton, down: Bool) {
        guard let presentation, presentation.acceptsInput else { return }
        let index = buttonIndex(button)
        let point = viewPoint(event)
        let css: CGPoint
        if down {
            guard let onPage = HeadlessPresentGeometry.cssPoint(point, fit: pageRect, content: cssSize) else { return }
            css = onPage
            pressed.insert(index)
            if window?.firstResponder !== self { window?.makeFirstResponder(self) }
        } else {
            // A release only for a press the page saw, wherever the mouse is now (pinned to the page).
            guard pressed.remove(index) != nil,
                  let pinned = HeadlessPresentGeometry.cssPoint(point, fit: pageRect, content: cssSize, clamp: true) else { return }
            css = pinned
        }
        var m = message(down ? WinterPresentInputMouseDown : WinterPresentInputMouseUp, event, at: css, button: button)
        m.button = index
        m.clickCount = Int32(max(1, event.clickCount))
        presentation.send(m)
    }

    private func move(_ event: NSEvent, button: HeadlessPresentKeys.MouseButton = .none) {
        guard let presentation, presentation.acceptsInput else { return }
        let point = viewPoint(event)
        let dragging = !pressed.isEmpty
        guard let css = HeadlessPresentGeometry.cssPoint(point, fit: pageRect, content: cssSize, clamp: dragging) else {
            leavePage(event)
            return
        }
        mouseOnPage = true
        presentation.send(message(WinterPresentInputMouseMove, event, at: css, button: button))
    }

    private func leavePage(_ event: NSEvent) {
        guard mouseOnPage, let presentation, presentation.acceptsInput else { return }
        mouseOnPage = false
        let css = HeadlessPresentGeometry.cssPoint(viewPoint(event), fit: pageRect, content: cssSize, clamp: true) ?? .zero
        presentation.send(message(WinterPresentInputMouseLeave, event, at: css, button: .none))
    }

    override func mouseDown(with event: NSEvent) { press(event, button: .left, down: true) }
    override func mouseUp(with event: NSEvent) { press(event, button: .left, down: false) }
    override func rightMouseDown(with event: NSEvent) { press(event, button: .right, down: true) }
    override func rightMouseUp(with event: NSEvent) { press(event, button: .right, down: false) }
    override func otherMouseDown(with event: NSEvent) {
        guard event.buttonNumber == 2 else { return super.otherMouseDown(with: event) }
        press(event, button: .middle, down: true)
    }
    override func otherMouseUp(with event: NSEvent) {
        guard event.buttonNumber == 2 else { return super.otherMouseUp(with: event) }
        press(event, button: .middle, down: false)
    }
    override func mouseMoved(with event: NSEvent) { move(event) }
    override func mouseDragged(with event: NSEvent) { move(event, button: .left) }
    override func rightMouseDragged(with event: NSEvent) { move(event, button: .right) }
    override func otherMouseDragged(with event: NSEvent) { move(event, button: .middle) }
    override func mouseEntered(with event: NSEvent) { move(event) }
    override func mouseExited(with event: NSEvent) {
        guard pressed.isEmpty else { return } // a drag that left the view keeps going until its release
        leavePage(event)
    }

    override func scrollWheel(with event: NSEvent) {
        guard let presentation, presentation.acceptsInput,
              let css = HeadlessPresentGeometry.cssPoint(viewPoint(event), fit: pageRect, content: cssSize) else {
            return super.scrollWheel(with: event)
        }
        let fitScale = HeadlessPresentGeometry.fitScale(fit: pageRect, content: cssSize)
        let delta = HeadlessPresentGeometry.wheelDelta(dx: Double(event.scrollingDeltaX), dy: Double(event.scrollingDeltaY),
                                                       precise: event.hasPreciseScrollingDeltas, fitScale: Double(fitScale))
        guard delta.dx != 0 || delta.dy != 0 else { return }
        var m = message(WinterPresentInputWheel, event, at: css, button: .none)
        // A trackpad's deltas are pixels to scroll by as they are (no smooth-scroll animation on top).
        if event.hasPreciseScrollingDeltas { m.modifiers |= HeadlessPresentKeys.precisionScrollingDelta }
        m.dx = delta.dx
        m.dy = delta.dy
        presentation.send(m)
    }

    // MARK: - Keys

    private func keyMessage(_ kind: Int, _ event: NSEvent) -> WinterPresentInputMsg {
        var m = WinterPresentInputMsg()
        m.kind = UInt32(kind)
        m.modifiers = HeadlessPresentKeys.modifiers(event.modifierFlags, keyCode: event.keyCode,
                                                    repeating: event.type == .keyDown && event.isARepeat)
        m.nativeKeyCode = Int32(event.keyCode)
        if event.type == .flagsChanged {
            m.windowsKeyCode = HeadlessPresentKeys.windowsKeyCode(keyCode: event.keyCode)
        } else {
            m.windowsKeyCode = HeadlessPresentKeys.windowsKeyCode(keyCode: event.keyCode, characters: event.characters,
                                                                  charactersIgnoringModifiers: event.charactersIgnoringModifiers)
            m.character = HeadlessPresentKeys.firstUnit(event.characters)
            m.unmodifiedCharacter = HeadlessPresentKeys.firstUnit(event.charactersIgnoringModifiers)
        }
        return m
    }

    override func keyDown(with event: NSEvent) {
        guard let presentation, presentation.acceptsInput else { return super.keyDown(with: event) }
        // Before: the input method may insert text, set or clear marked text while it handles the key.
        oldHasMarkedText = hasMarked
        handlingKeyDown = true
        textToInsert = ""
        compositionUpdated = false
        unmarkCalled = false
        markedReplacement = NSRange(location: NSNotFound, length: 0)
        interpretKeyEvents([event])
        handlingKeyDown = false

        // After: what the key amounted to.
        let composing = hasMarked || oldHasMarkedText
        let inserted = textToInsert.utf16.count
        if !composing, inserted <= 1 {
            let down = keyMessage(WinterPresentInputKeyDown, event)
            presentation.send(down)
            var unit: UInt16? = textToInsert.utf16.first
            if unit == nil, !event.modifierFlags.contains(.command) {
                // Return and keypad Enter produce no inserted text, yet a page expects their character.
                let c = HeadlessPresentKeys.firstUnit(event.characters)
                if c == 0x0D || c == 0x03 { unit = 0x0D }
            }
            if let unit, !HeadlessPresentKeys.isFunctionKeyCharacter(unit), !(event.keyCode == 71) {
                var char = down
                char.kind = UInt32(WinterPresentInputChar)
                char.character = unit
                presentation.send(char)
            }
        }
        var textInserted = false
        if inserted > (composing ? 0 : 1) {
            presentation.commitText(textToInsert, replacement: NSRange(location: NSNotFound, length: 0))
            textInserted = true
        }
        textToInsert = ""
        if hasMarked, !markedText.isEmpty {
            if compositionUpdated {
                presentation.setComposition(markedText, selection: markedSelection, replacement: markedReplacement)
            }
        } else if oldHasMarkedText, !hasMarked, !textInserted {
            if unmarkCalled { presentation.finishComposing() } else { presentation.cancelComposition() }
        }
    }

    override func keyUp(with event: NSEvent) {
        guard let presentation, presentation.acceptsInput else { return super.keyUp(with: event) }
        presentation.send(keyMessage(WinterPresentInputKeyUp, event))
    }

    override func flagsChanged(with event: NSEvent) {
        guard let presentation, presentation.acceptsInput else { return super.flagsChanged(with: event) }
        let up = HeadlessPresentKeys.isModifierKeyUp(keyCode: event.keyCode, flags: event.modifierFlags)
        presentation.send(keyMessage(up ? WinterPresentInputKeyUp : WinterPresentInputKeyDown, event))
    }

    /// ⌘C/⌘X/⌘V/⌘A/⌘Z/⇧⌘Z reach the page as its own edit commands even where the menu bar has no Edit item for
    /// them — asked of the view hierarchy before the menu bar, and only when this view is the one typing.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard let presentation, presentation.acceptsInput, window?.firstResponder === self, event.type == .keyDown,
              event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.shift, .capsLock, .numericPad, .function]) == .command,
              let key = event.charactersIgnoringModifiers?.lowercased() else {
            return super.performKeyEquivalent(with: event)
        }
        let shift = event.modifierFlags.contains(.shift)
        switch key {
        case "c" where !shift: copy(nil)
        case "x" where !shift: cut(nil)
        case "v" where !shift: paste(nil)
        case "a" where !shift: selectAll(nil)
        case "z": shift ? redo(nil) : undo(nil)
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }

    // MARK: - Edit commands

    private static let editSelectors: Set<Selector> = [
        #selector(copy(_:)), #selector(cut(_:)), #selector(paste(_:)), #selector(selectAll(_:)),
        #selector(undo(_:)), #selector(redo(_:)), #selector(delete(_:)),
    ]

    /// The edit actions are this view's only while the person holds control — otherwise the responder chain goes
    /// on past it (the window's own undo, say).
    override func responds(to aSelector: Selector!) -> Bool {
        if let aSelector, Self.editSelectors.contains(aSelector) { return presentation?.acceptsInput ?? false }
        return super.responds(to: aSelector)
    }

    @objc func copy(_ sender: Any?) { presentation?.edit(UInt32(WinterPresentEditCopy)) }
    @objc func cut(_ sender: Any?) { presentation?.edit(UInt32(WinterPresentEditCut)) }
    @objc override func selectAll(_ sender: Any?) { presentation?.edit(UInt32(WinterPresentEditSelectAll)) }
    @objc func undo(_ sender: Any?) { presentation?.edit(UInt32(WinterPresentEditUndo)) }
    @objc func redo(_ sender: Any?) { presentation?.edit(UInt32(WinterPresentEditRedo)) }
    @objc func delete(_ sender: Any?) { presentation?.edit(UInt32(WinterPresentEditDelete)) }

    /// The person's ⌘V: the pasteboard's PLAIN TEXT, read here and carried to the page (the helper never reads the
    /// pasteboard). Anything else on it — an image, a file — is not pasted.
    @objc func paste(_ sender: Any?) {
        guard let presentation, presentation.acceptsInput else { return }
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else {
            presentation.showNotice("Only text can be pasted into the page")
            return
        }
        presentation.edit(UInt32(WinterPresentEditPaste), text: text)
    }

    // MARK: - NSTextInputClient (the input method)

    func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        if handlingKeyDown {
            textToInsert += text
        } else {
            presentation?.commitText(text, replacement: replacementRange)
        }
        // Inserting text ends the composition.
        hasMarked = false
        markedText = ""
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        markedText = text
        markedSelection = selectedRange
        hasMarked = !text.isEmpty
        if handlingKeyDown {
            compositionUpdated = true
            markedReplacement = replacementRange
        } else if text.isEmpty {
            presentation?.cancelComposition()
        } else {
            presentation?.setComposition(text, selection: selectedRange, replacement: replacementRange)
        }
    }

    func unmarkText() {
        hasMarked = false
        markedText = ""
        if handlingKeyDown { unmarkCalled = true } else { presentation?.finishComposing() }
    }

    /// In the same coordinates as `markedRange()` (the field's, once the producer said where the composition is):
    /// the input method asks `firstRect` for ranges it read from either.
    func selectedRange() -> NSRange {
        guard hasMarked, markedSelection.location != NSNotFound else { return NSRange(location: NSNotFound, length: 0) }
        if let range = presentation?.imeRange, range.location != NSNotFound {
            return NSRange(location: range.location + markedSelection.location, length: markedSelection.length)
        }
        return markedSelection
    }

    func markedRange() -> NSRange {
        guard hasMarked else { return NSRange(location: NSNotFound, length: 0) }
        if let range = presentation?.imeRange, range.location != NSNotFound { return range }
        return NSRange(location: 0, length: markedText.utf16.count)
    }

    func hasMarkedText() -> Bool { hasMarked }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] {
        [.underlineStyle, .underlineColor, .markedClauseSegment]
    }

    /// Where the candidate window goes: the composed character's rect (CSS) → this view → the screen.
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        actualRange?.pointee = range
        guard let presentation, let window else { return .zero }
        let start = presentation.imeRange.location == NSNotFound ? 0 : presentation.imeRange.location
        let css = HeadlessPresentGeometry.compositionRect(location: range.location, compositionStart: start,
                                                          rects: presentation.imeRects)
            ?? CGRect(x: 0, y: 0, width: 0, height: 16)
        let inView = HeadlessPresentGeometry.viewRect(css, fit: pageRect, content: cssSize)
        return window.convertToScreen(convert(inView, to: nil))
    }

    func characterIndex(for point: NSPoint) -> Int { NSNotFound }

    /// Editing commands the input method resolves a key to are the page's own business: the raw key down that
    /// carried the key already reached it.
    override func doCommand(by selector: Selector) {}

    // MARK: - Accessibility

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityRoleDescription() -> String? { "live page" }
    override func accessibilityLabel() -> String? {
        guard let presentation else { return "Live page from Winter's headless browser" }
        return HeadlessPresentChromeState.accessibilityLabel(title: presentation.title, url: presentation.url)
    }
    override func accessibilityValue() -> Any? {
        HeadlessPresentChromeState.accessibilityValue(control: presentation?.acceptsInput ?? false)
    }
}

/// The view in SwiftUI. The presentation outlives it: dismantling only detaches the layer.
struct HeadlessPresentSurface: NSViewRepresentable {
    @ObservedObject var presentation: HeadlessPresentation

    func makeNSView(context: Context) -> HeadlessPresentView {
        let view = HeadlessPresentView(frame: .zero)
        view.attach(presentation)
        return view
    }

    func updateNSView(_ view: HeadlessPresentView, context: Context) {
        view.attach(presentation)
        view.presentationChanged()
    }

    static func dismantleNSView(_ view: HeadlessPresentView, coordinator: ()) {
        view.detach()
    }
}
