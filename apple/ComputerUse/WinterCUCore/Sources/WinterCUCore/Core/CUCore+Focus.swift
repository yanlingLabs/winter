import ApplicationServices
import CoreGraphics
import Foundation

/// Where keyboard input goes in the BOUND window. An app answers `AXFocusedUIElement` for its KEY window only
/// (live: a background Google Docs window read as "focus unknown", or Safari's address bar after a reload), so:
/// the app's answer when it lies in the bound window (that is where its keys go — the address bar after ⌘R
/// included); else, when the bound window is NOT its app's key window, the element WebKit marks `AXFocused`
/// inside the window's web areas (it keeps the DOM focus even when the window is not key), found by a bounded
/// walk, or the window's own `AXFocusedUIElement`. An app that reports no focus for its key window: unknown.
extension CUCore {
    enum FocusSource: String { case app = "the app", webArea = "the window's web content", window = "the window" }

    struct WindowFocus {
        var element: AXUIElement?
        var source: FocusSource?
        /// The app reports a focused element, but in another of its windows.
        var elsewhere: AXUIElement?
    }

    /// The bound window's focus (`WindowFocus`), cached for the act it was read in and at most 250 ms; `fresh`
    /// reads it again (after the act moved it). Logs which source answered.
    func windowFocus(_ t: CUTarget, fresh: Bool = false) -> WindowFocus {
        let now = clock.nowMs()
        if !fresh, let c = t.focusCache, c.act == t.actSeq, now - c.atMs <= 250 { return c.focus }
        var f = WindowFocus()
        if t.accessible, let win = try? windowElement(t) {
            let appFocus = ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute)
            // The app's answer, unless it is PROVABLY in another window (an element whose window can't be told is
            // taken as the bound one's: a guess elsewhere could type past a field the app really focuses).
            if let a = appFocus, inBoundWindow(a, t, win) != false {
                f.element = a
                f.source = .app
            } else if appFocus == nil, boundWindowIsKeyInApp(t) != false {
                // The app reports no focus for the window that is (or may be) its key window: the window's own
                // answer if it gives one, else unknown — an element still marked focused in its content would be a
                // guess, and the floors decide on unknowns.
                if let w = ax.element(win, kAXFocusedUIElementAttribute), inBoundWindow(w, t, win) != false {
                    f.element = w
                    f.source = .window
                }
            } else if let w = focusedInWebAreas(of: win), inBoundWindow(w, t, win) != false {
                // The page's own focus (the DOM focus WebKit marks): where the keys go once the window holds the
                // key focus (the focus blip) — not where the system routes them now.
                f.element = w
                f.source = .webArea
            } else if let w = ax.element(win, kAXFocusedUIElementAttribute), inBoundWindow(w, t, win) == true {
                f.element = w
                f.source = .window
            }
            if f.element == nil, let a = appFocus { f.elsewhere = a }
            CULog.act.debug("focus in \(t.appName, privacy: .public): \(f.source?.rawValue ?? (f.elsewhere != nil ? "in another window" : "none"), privacy: .public)")
        }
        t.focusCache = (t.actSeq, now, f)
        return f
    }

    /// Whether `e` lies in the bound window: its `AXWindow`, else its ancestors; nil when neither tells.
    func inBoundWindow(_ e: AXUIElement, _ t: CUTarget, _ win: AXUIElement) -> Bool? {
        if let w = ax.element(e, kAXWindowAttribute) {
            if let id = ax.windowID(w) { return id == t.windowID }
            return CFEqual(w, win)
        }
        var cur: AXUIElement? = e
        for _ in 0..<60 {
            guard let c = cur else { return nil }
            if CFEqual(c, win) { return true }
            if ax.string(c, kAXRoleAttribute) == kAXWindowRole { return ax.windowID(c).map { $0 == t.windowID } ?? false }
            cur = ax.element(c, kAXParentAttribute)
        }
        return nil
    }

    /// The element marked focused inside the window's web areas — bounded (nodes and time), the web areas first.
    func focusedInWebAreas(of win: AXUIElement, maxNodes: Int = 4000, maxMs: Double = 150) -> AXUIElement? {
        let deadline = clock.nowMs() + maxMs
        var seen = 0
        // The web areas: a breadth-first walk of the window, not into a web area's own content yet.
        var queue: [AXUIElement] = [win]
        var areas: [AXUIElement] = []
        while !queue.isEmpty, seen < maxNodes, clock.nowMs() < deadline {
            let n = queue.removeFirst()
            seen += 1
            if ax.string(n, kAXRoleAttribute) == "AXWebArea" { areas.append(n); continue }
            queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
        }
        // Inside them: the element marked focused (WebKit's own answer first).
        for area in areas {
            if let f = ax.element(area, kAXFocusedUIElementAttribute), ax.bool(f, kAXFocusedAttribute) == true { return f }
            var inner: [AXUIElement] = [area]
            while !inner.isEmpty, seen < maxNodes, clock.nowMs() < deadline {
                let n = inner.removeFirst()
                seen += 1
                if !CFEqual(n, area), ax.bool(n, kAXFocusedAttribute) == true { return n }
                inner.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
            }
        }
        return nil
    }

    /// A web page's hidden text input — an editable element of no size, or outside the window, inside a web
    /// area (Google Docs: an off-screen contenteditable takes the keys while the text is drawn on a canvas).
    func hiddenInputWords(_ e: AXUIElement, _ t: CUTarget) -> String? {
        guard isWebContent(e), editableElement(e) else { return nil }
        let frame = ax.frame(e)
        let window = sys.window(id: t.windowID)?.frame
        let tiny = frame.map { $0.width < 2 || $0.height < 2 } ?? true
        let outside = frame.flatMap { f in window.map { !$0.intersects(f) } } ?? false
        guard tiny || outside else { return nil }
        return "the page's hidden text input (it types into the document)"
    }

    /// A text field, text area, combo box, search field, or an editable web element.
    func editableElement(_ e: AXUIElement) -> Bool {
        let role = ax.string(e, kAXRoleAttribute)
        if [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField"].contains(role ?? "") { return true }
        if ax.bool(e, "AXEditable") == true { return true }
        return ax.attribute(e, "AXEditableAncestor") != nil
    }

    /// A field that holds one line: a text field, search field or combo box (not a text area, not web content
    /// that edits like a document).
    func singleLineField(_ e: AXUIElement) -> Bool {
        let role = ax.string(e, kAXRoleAttribute) ?? ""
        if role == kAXTextAreaRole { return false }
        if role == kAXComboBoxRole || role == "AXSearchField" || ax.string(e, kAXSubroleAttribute) == "AXSearchField" { return true }
        return role == kAXTextFieldRole && ax.bool(e, "AXMultiLine") != true
    }

    /// `[226] text field “smart search field”` — name and role only, never a value (a secure field included).
    func focusWords(_ e: AXUIElement, _ t: CUTarget) -> String {
        if let hidden = hiddenInputWords(e, t) { return hidden }
        let info = ElementInfo(e, ax)
        let ref = t.refs.ref(for: AXIdentity(element: e))
        let role = CURoleWords.words(role: info.role ?? "AXUnknown", subrole: info.subrole)
        let name = info.labels.compactMap { $0 }.first { !$0.isEmpty }.map { $0.count <= 40 ? $0 : String($0.prefix(40)) + "…" }
        return "[\(ref)] \(role)" + (name.map { " " + formatter.quote($0) } ?? "")
    }

    // MARK: guards for text with no `into`

    /// type()/paste() with no `into` go where the focus is — so it must be a place for that text (live: a paste
    /// landed in Google Docs' menu bar, and ~3,000 characters in Safari's address bar after ⌘R left the focus
    /// there). Refused, naming the focus: not editable; several lines (or more than 200 characters) for a
    /// single-line field; or for the browser's own chrome rather than the page.
    func guardUnnamedTarget(_ e: AXUIElement?, _ wf: WindowFocus, text: String, _ t: CUTarget) throws {
        guard let e, t.accessible, hiddenInputWords(e, t) == nil else { return }  // unknown: the floors decide; a page's hidden input is its document
        guard editableElement(e) else {
            throw CUError.refused(.focusNotEditable, "the focus is \(focusWords(e, t)), not a text field — click the field or pass { into }")
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
        guard text.contains("\n") || text.count > Self.typeKeysMax else { return }
        let size = lines > 1 ? "the text has \(lines) lines" : "the text is \(text.count) characters long"
        if !isWebContent(e), let win = try? windowElement(t), let page = pageEditable(win) {
            throw CUError.refused(.wrongFieldShape, "the focus is in \(t.appName)'s own \(focusWords(e, t)), not the page, and \(size) — the page's editable element is \(focusWords(page, t)); pass { into } for the field you mean")
        }
        if singleLineField(e) {
            let info = ElementInfo(e, ax)
            let ref = t.refs.ref(for: AXIdentity(element: e))
            let name = info.labels.compactMap { $0 }.first { !$0.isEmpty }.map { " (\(formatter.quote(String($0.prefix(40)))))" } ?? ""
            throw CUError.refused(.wrongFieldShape, "the focus is [\(ref)] a single-line field\(name) but \(size) — pass { into } for the field you mean")
        }
    }

    /// The page's editable element: the one WebKit marks focused, else the first editable one (bounded); nil
    /// when the window has no web area.
    func pageEditable(_ win: AXUIElement, maxNodes: Int = 4000, maxMs: Double = 150) -> AXUIElement? {
        if let f = focusedInWebAreas(of: win, maxNodes: maxNodes, maxMs: maxMs), editableElement(f) { return f }
        let deadline = clock.nowMs() + maxMs
        var seen = 0
        var queue: [AXUIElement] = [win]
        var inWeb: [AXUIElement] = []
        while !queue.isEmpty, seen < maxNodes, clock.nowMs() < deadline {
            let n = queue.removeFirst()
            seen += 1
            if ax.string(n, kAXRoleAttribute) == "AXWebArea" { inWeb.append(n); continue }
            queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
        }
        while !inWeb.isEmpty, seen < maxNodes, clock.nowMs() < deadline {
            let n = inWeb.removeFirst()
            seen += 1
            if ax.string(n, kAXRoleAttribute) != "AXWebArea", editableElement(n) { return n }
            inWeb.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
        }
        return nil
    }
}
