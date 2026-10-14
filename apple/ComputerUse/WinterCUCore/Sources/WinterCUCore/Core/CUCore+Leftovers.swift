import ApplicationServices
import CoreGraphics
import Foundation

/// The Web Store dogfood's leftovers (a Material web app in a browser bound as an app, over accessibility): web selects
/// (a select-only combo box, read by Chromium as a pop-up button, beside its own hidden text input), check boxes and
/// radios named by their wrapper or label, honest answers for keys that changed nothing, a file-chooser hint, and an
/// off-desktop picture taken right after an act.
extension CUCore {
    // MARK: web selects

    /// A page's select: a combo box, or a pop-up button (Chromium's select-only combo box).
    static let webSelectRoles: Set<String> = [kAXComboBoxRole, kAXPopUpButtonRole]

    /// A web page's select: a pop-up button, or a combo box that takes no typed text — its value can't be written, or
    /// it has none of a text entry's attributes (an editable combo box — a search with suggestions — is typed into
    /// instead), in web content. (The leftover probes, 2026-10-13: Chrome reads a `<div role="combobox">` select as a
    /// combo box whose value it calls settable; the write did nothing and setValue said "set the value".)
    func isWebSelect(_ e: AXUIElement) -> Bool {
        let role = ax.string(e, kAXRoleAttribute) ?? ""
        guard Self.webSelectRoles.contains(role), isWebContent(e) else { return false }
        return role == kAXPopUpButtonRole || !ax.isSettable(e, kAXValueAttribute) || !takesTypedText(e)
    }

    /// The attributes only an element that takes typed text has: its editable ancestor (itself, for a field). Not the
    /// text attributes — Chrome gives `AXNumberOfCharacters`, `AXSelectedTextRange` and `AXInsertionPointLineNumber` to a
    /// select-only `<div role="combobox">` too (measured on Chrome for Testing 156, 2026-10-14: the Size select had all
    /// three, its value settable, and no editable ancestor; the Title field had `AXEditableAncestor` and
    /// `AXHighestEditableAncestor`).
    static let typedTextAttributes = ["AXEditableAncestor", "AXHighestEditableAncestor"]

    /// Does `e` take typed text (an editable ancestor — itself, for a field)?
    func takesTypedText(_ e: AXUIElement) -> Bool {
        Self.typedTextAttributes.contains { ax.attribute(e, $0) != nil }
    }

    /// `e`'s descendants, breadth first, `depth` levels and at most `max` of them (`e` itself not included).
    func boundedDescendants(of e: AXUIElement, depth: Int, max: Int) -> [AXUIElement] {
        var out: [AXUIElement] = []
        var level = ax.elements(e, kAXChildrenAttribute)
        var d = 1
        while !level.isEmpty, d <= depth, out.count < max {
            var next: [AXUIElement] = []
            for c in level {
                out.append(c)
                if out.count >= max { break }
                next += ax.elements(c, kAXChildrenAttribute)
            }
            level = next
            d += 1
        }
        return out
    }

    /// The select a page's hidden text input belongs to: the ONE select beside it in its own container, the input
    /// lying on it. Nil when there is none, or more than one.
    func selectBeside(_ e: AXUIElement) -> AXUIElement? {
        // Only the select's own stand-in: a ZERO-SIZE input (never one parked off the window — a document's input
        // target) in the SAME container as exactly one select, laid on (or at) that select.
        guard let f = ax.frame(e), f.width < 2 || f.height < 2, let c = ax.element(e, kAXParentAttribute) else { return nil }
        let found = ax.elements(c, kAXChildrenAttribute).filter { !CFEqual($0, e) && isWebSelect($0) }
        guard found.count == 1, let sf = ax.frame(found[0]) else { return nil }
        return sf.insetBy(dx: -4, dy: -4).contains(f.origin) ? found[0] : nil
    }

    /// The text a select shows: its value, else its title, else its description.
    func selectShows(_ e: AXUIElement) -> String? {
        for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            if let s = ax.string(e, name)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        }
        return nil
    }

    /// Lowercased, whitespace runs folded to one space, trimmed. Pure.
    static func optionKey(_ s: String) -> String {
        s.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// The option `want` names: the one equal to it (case and spacing aside), else the one it begins, else the one
    /// that contains it. Nil when none — or more than one at the first rung that finds any. Pure.
    static func matchOption(_ want: String, _ options: [String]) -> Int? {
        let w = optionKey(want)
        guard !w.isEmpty else { return nil }
        let keys = options.map(optionKey)
        for rule in [{ (k: String) in k == w }, { $0.hasPrefix(w) }, { $0.contains(w) }] {
            let hits = keys.indices.filter { rule(keys[$0]) }
            if hits.count == 1 { return hits[0] }
            if hits.count > 1 { return nil }
        }
        return nil
    }

    static let optionListRoles: Set<String> = [kAXListRole, kAXMenuRole, "AXListBox"]

    /// Every list or menu in the page (bounded): where a select's options appear once it is open.
    func pageLists(in area: AXUIElement) -> [AXUIElement] {
        boundedDescendants(of: area, depth: 60, max: Self.selectWalkMaxNodes)
            .filter { Self.optionListRoles.contains(ax.string($0, kAXRoleAttribute) ?? "") }
    }

    static let selectWalkMaxNodes = 1500

    /// The rows of a list that read as options, with their text (a row with no text of its own: its first child that
    /// has some).
    func optionRows(of list: AXUIElement) -> [(element: AXUIElement, text: String)] {
        var out: [(AXUIElement, String)] = []
        for c in ax.elements(list, kAXChildrenAttribute).prefix(200) {
            if let s = selectShows(c) { out.append((c, s)); continue }
            if let inner = ax.elements(c, kAXChildrenAttribute).first(where: { selectShows($0) != nil }) {
                out.append((inner, selectShows(inner)!))
            }
        }
        return out
    }

    /// The select's options once it is open: the lists it names as its own (`AXLinkedUIElements`), else the lists that
    /// appeared in the page since `before`.
    func openOptions(of select: AXUIElement, in area: AXUIElement, before: Set<AXIdentity>) -> [(element: AXUIElement, text: String)] {
        let linked = ax.elements(select, "AXLinkedUIElements").filter { Self.optionListRoles.contains(ax.string($0, kAXRoleAttribute) ?? "") }
        let lists = linked.isEmpty ? pageLists(in: area).filter { !before.contains(AXIdentity(element: $0)) } : linked
        return lists.flatMap { optionRows(of: $0) }
    }

    /// How long a select's list is waited for after its press, and its shown value after an option's.
    static let selectWaitMs: Double = 800

    /// `setValue(ref, "<option>")` on a web select (or on its hidden text input): opened by a click (every gate of a
    /// click kept), the option named pressed the same way, and the select's shown value checked. Nil when `ref` is no
    /// web select — the ordinary setValue.
    func setValueOfWebSelect(_ a: CUSetValueAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome? {
        guard t.accessible else { return nil }
        let named = try element(a.ref, in: t)
        let select: AXUIElement
        if isWebSelect(named) {
            select = named
        } else if hiddenInputWords(named, t) != nil, let s = selectBeside(named) {
            select = s
        } else {
            return nil
        }
        guard let area = webAreaAncestor(of: select) else { return nil }
        let ref = t.refs.ref(for: AXIdentity(element: select))
        let label = Self.elementLabel(ref, ElementInfo(select, ax))
        let want = Self.optionKey(a.value)
        if let shows = selectShows(select), Self.optionKey(shows) == want {
            return ActOutcome(rung: .accessibility, detail: "\(label) already shows \u{201C}\(shows.prefix(80))\u{201D} — nothing was pressed")
        }
        // A page's own <select> lists its options inside itself, closed (its pop-up is the browser's own menu, never
        // opened here): the option is pressed where it is.
        let own = boundedDescendants(of: select, depth: 2, max: 400)
            .filter { Self.optionListRoles.contains(ax.string($0, kAXRoleAttribute) ?? "") }.flatMap { optionRows(of: $0) }
        if !own.isEmpty {
            return try chooseOption(own, a.value, in: select, label: label, ref: ref, opened: false, p, t, token)
        }
        let before = Set(pageLists(in: area).map { AXIdentity(element: $0) })
        var notes: [String] = []
        if ax.bool(select, kAXExpandedAttribute) != true {
            let opened = try click(CUClickAction(ref: ref), p, t, token)
            if let d = opened.detail { notes.append(d) }
        }
        var options: [(element: AXUIElement, text: String)] = []
        let deadline = clock.nowMs() + Self.selectWaitMs
        repeat {
            try token.check()
            options = openOptions(of: select, in: area, before: before)
            if !options.isEmpty || clock.nowMs() >= deadline { break }
            clock.pause(ms: 50)
        } while true
        guard !options.isEmpty else {
            let how = notes.isEmpty ? "" : " (\(notes.joined(separator: "; ")))"
            throw CUError.unsupported("\(label)'s list of options did not appear after it was pressed\(how) — check state() for an open list and click(<option ref>) in it, or click(\(ref)) to open it")
        }
        return try chooseOption(options, a.value, in: select, label: label, ref: ref, opened: true, p, t, token)
    }

    /// Presses the option `value` names among `options` of `select` (through a click, every gate kept) and checks what
    /// the select shows after it.
    func chooseOption(_ options: [(element: AXUIElement, text: String)], _ value: String, in select: AXUIElement, label: String,
                      ref: Int, opened: Bool, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        guard let pick = Self.matchOption(value, options.map(\.text)) else {
            let names = options.prefix(20).map { "\u{201C}\($0.text.prefix(60))\u{201D}" }.joined(separator: ", ")
            let open = opened ? " (the list is open now; state() shows it)" : ""
            throw CUError.invalidParams("no single option of \(label) matches \u{201C}\(value.prefix(80))\u{201D} — its options: \(names)\(options.count > 20 ? ", … (\(options.count) in all)" : "")\(open)")
        }
        let option = options[pick]
        let optionRef = t.refs.ref(for: AXIdentity(element: option.element))
        let chosen = try click(CUClickAction(ref: optionRef), p, t, token)
        let end = clock.nowMs() + Self.selectWaitMs
        var shows = selectShows(select)
        // EQUAL to the option (case and spacing aside) — never merely containing it: "Extra Small" is not "Small".
        let isChosen = { (s: String?) in s.map { Self.optionKey($0) == Self.optionKey(option.text) } == true }
        while !isChosen(shows), clock.nowMs() < end {
            clock.pause(ms: 50)
            shows = selectShows(select)
        }
        CULog.act.notice("setValue in \(t.appName, privacy: .public): a web select — option pressed, \(isChosen(shows) ? "shown" : "NOT shown", privacy: .public)")
        if isChosen(shows) {
            return ActOutcome(rung: chosen.rung, detail: "chose \u{201C}\(option.text.prefix(80))\u{201D} in \(label) (\(opened ? "opened it, pressed the option" : "pressed its option"); it shows it now)")
        }
        let now = shows.map { "it reads \u{201C}\($0.prefix(80))\u{201D}" } ?? "it shows no value accessibility can read"
        return ActOutcome(rung: chosen.rung, detail: "pressed the option \u{201C}\(option.text.prefix(80))\u{201D} of \(label), but the select did not change to it (\(now)) — check state() before choosing again")
    }

    // MARK: check boxes and radios named by their wrapper or label

    static let toggleControlRoles: Set<String> = ["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle"]
    /// Anything else a click in a form field could mean: a wrapper holding one of these is no toggle's own.
    static let otherControlRoles: Set<String> = [
        "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXSlider", "AXMenuButton",
        "AXSearchField", "AXIncrementor",
    ]

    func isToggleControl(_ e: AXUIElement) -> Bool {
        Self.toggleControlRoles.contains(ax.string(e, kAXRoleAttribute) ?? "")
            || ["AXSwitch", "AXToggle"].contains(ax.string(e, kAXSubroleAttribute) ?? "")
    }

    /// The ONE check box, radio button or switch a click on a web wrapper or label means: `e` is a group or text in
    /// web content, not one itself, and it holds exactly one (a Material check box's wrapper) — or, a label, its parent
    /// holds exactly one — with no other control beside it, in a box no taller than a form field's row.
    func toggleFor(_ e: AXUIElement) -> AXUIElement? {
        let role = ax.string(e, kAXRoleAttribute) ?? ""
        guard ["AXGroup", "AXStaticText", "AXUnknown"].contains(role), !isToggleControl(e), isWebContent(e) else { return nil }
        // The text inside a check box (a web check box's own label text): the check box.
        var up = ax.element(e, kAXParentAttribute)
        for _ in 0..<2 {
            guard let u = up else { break }
            if isToggleControl(u) { return u }
            up = ax.element(u, kAXParentAttribute)
        }
        func one(in box: AXUIElement) -> AXUIElement? {
            let inside = boundedDescendants(of: box, depth: 3, max: 40)
            let toggles = inside.filter { isToggleControl($0) }
            guard toggles.count == 1,
                  !inside.contains(where: { Self.otherControlRoles.contains(ax.string($0, kAXRoleAttribute) ?? "") }) else { return nil }
            // A row, not a card: the box's height within a few of the toggle's (its label may run wide).
            if let b = ax.frame(box), let f = ax.frame(toggles[0]), b.height > max(3 * f.height, 64) { return nil }
            return toggles[0]
        }
        if let inside = one(in: e) { return inside }
        // A label beside its control: only the toggle's OWN label — the one it names as its title element, or one of
        // them links the other — never any text that merely sits in the same row.
        guard let parent = ax.element(e, kAXParentAttribute), let toggle = one(in: parent) else { return nil }
        return isOwnLabel(e, of: toggle) ? toggle : nil
    }

    /// `label` is `toggle`'s own label: its `AXTitleUIElement` (or that element's child), or either links the other.
    func isOwnLabel(_ label: AXUIElement, of toggle: AXUIElement) -> Bool {
        if let title = ax.element(toggle, kAXTitleUIElementAttribute) {
            if CFEqual(title, label) { return true }
            if ax.element(label, kAXParentAttribute).map({ CFEqual($0, title) }) == true { return true }
        }
        if ax.elements(toggle, "AXLinkedUIElements").contains(where: { CFEqual($0, label) }) { return true }
        return ax.elements(label, "AXLinkedUIElements").contains(where: { CFEqual($0, toggle) })
    }

    /// What a plain left click on `e` stands for, when not `e` itself: a select's hidden text input → the select; a
    /// check box's wrapper or label → the check box. Nil otherwise.
    func clickRedirect(_ e: AXUIElement, ref: Int, _ t: CUTarget) -> (ref: Int, note: String)? {
        guard t.accessible else { return nil }
        if hiddenInputWords(e, t) != nil, let select = selectBeside(e) {
            let r = t.refs.ref(for: AXIdentity(element: select))
            return (r, "[\(ref)] is the hidden text input of the select \(Self.elementLabel(r, ElementInfo(select, ax))) — the select was pressed; setValue(\(r), \"<option>\") chooses an option")
        }
        if let toggle = toggleFor(e) {
            let r = t.refs.ref(for: AXIdentity(element: toggle))
            let info = ElementInfo(toggle, ax)
            let kind = CURoleWords.words(role: info.role ?? "AXCheckBox", subrole: info.subrole)
            return (r, "[\(ref)] holds the \(kind) \(Self.elementLabel(r, info)) — that \(kind) was pressed")
        }
        return nil
    }

    // MARK: a file chooser's button

    /// A page button that opens a file chooser (or another system picker): by its name. Pure.
    static func opensPicker(_ labels: [String?]) -> Bool {
        let words = labels.compactMap { $0 }.joined(separator: " ").lowercased()
        let pattern = #"\b(upload|browse|attach)\b|\b(select|choose|pick|add|import|open)\b.{0,20}\b(file|files|image|images|photo|photos|picture|document|documents|folder|zip|icon|screenshot|screenshots)\b"#
        return words.range(of: pattern, options: .regularExpression) != nil
    }

    static let noEffectPhrases = ["no visible effect", "nothing changed that accessibility can see", "had no effect accessibility can see"]

    /// A click on a web button that opens a file chooser and showed no effect: said what may work — the chooser needs
    /// real keyboard input, which `key("return", { into })` gives a button that holds the focus.
    func pickerHinted(_ o: ActOutcome, _ a: CUClickAction, _ t: CUTarget) -> ActOutcome {
        guard let ref = a.ref, let d = o.detail, Self.noEffectPhrases.contains(where: { d.contains($0) }), t.accessible,
              let e = try? element(ref, in: t), isWebContent(e), Self.opensPicker(ElementInfo(e, ax).labels) else { return o }
        var out = o
        let hint = focusRelation(e, t) == .onIt
            ? "a page button that opens a file chooser or another system picker may need real keyboard input — [\(ref)] holds the keyboard focus now, so key(\"return\", { into: \(ref) }) sends it one"
            : "a page button that opens a file chooser or another system picker may need real keyboard input — once [\(ref)] holds the keyboard focus, key(\"return\", { into: \(ref) }) sends it one"
        out.detail = d + "; " + hint
        return out
    }

    // MARK: keys that changed nothing

    /// What a key could be seen to change, read before it.
    struct KeyWatch {
        enum Kind { case tab(AXUIElement, String?), toggle(AXUIElement, String?), selectAll(AXUIElement, NSRange, Int), panel(AXUIElement, Int, AXIdentity?, String?, PanelSelection) }
        var kind: Kind
        var focus: AXIdentity?
    }

    static let keyWatchMs: Double = 400

    /// Runs the key, then says so when it can tell the key changed nothing (never a refusal: the key was sent): Tab
    /// that left the page's focus where it was, Space that left the focused check box as it was, ⌘A that selected
    /// nothing more in a field it can read, and a key into a sheet or panel after which no sheet, window or field
    /// appeared and the focus stayed.
    func keyChecked(_ a: CUKeyAction, _ t: CUTarget, _ run: () throws -> ActOutcome) throws -> ActOutcome {
        let watch = t.accessible ? keyWatch(a, t) : nil
        let o = try run()
        guard let watch, let note = keyUnchanged(watch, a, t) else { return o }
        CULog.act.notice("key in \(t.appName, privacy: .public): \(a.combo, privacy: .public) — no change seen")
        return o.noting(note)
    }

    func keyWatch(_ a: CUKeyAction, _ t: CUTarget) -> KeyWatch? {
        guard let chord = try? CUKeyChord.parse(a.combo), (a.repeat ?? 1) == 1 else { return nil }
        if let into = a.into, let el = try? element(into, in: t), inSheetOrPanel(el, t) {
            let focusId = reportedFocus(t).map { AXIdentity(element: $0) }
            let app = ax.application(t.pid)
            return KeyWatch(kind: .panel(el, panelFingerprint(el, app: app), focusId, ax.string(el, kAXValueAttribute), panelSelection(el)),
                            focus: focusId)
        }
        let plain = chord.modifiers.isEmpty || chord.modifiers == [.shift]
        let watched = (plain && chord.key == .named(.tab)) || (chord.modifiers.isEmpty && chord.key == .named(.space))
            || (chord.modifiers == [.command] && chord.key == .character("a"))
        // With `into`, the element named is where the key goes once its focus is placed (the act refuses otherwise):
        // watched the same as a focus already there (the leftover probes, 2026-10-13: `key("tab", { into })` into a
        // real Chrome page left the focus where it was and the answer said only "pressed tab" — the watch was armed for
        // keys with no `into` alone).
        let named: AXUIElement? = a.into.flatMap { try? element($0, in: t) }
        guard watched, let f = a.into == nil ? reportedFocus(t) : named, isWebContent(f) else { return nil }
        let focusId: AXIdentity? = AXIdentity(element: f)
        if plain, chord.key == .named(.tab) { return KeyWatch(kind: .tab(f, ax.string(f, kAXValueAttribute)), focus: focusId) }
        if chord.modifiers.isEmpty, chord.key == .named(.space), isToggleControl(f) {
            return KeyWatch(kind: .toggle(f, ax.string(f, kAXValueAttribute)), focus: focusId)
        }
        if chord.modifiers == [.command], chord.key == .character("a"), editableElement(f),
           let r = selectionRange(f), let len = textLength(f, t), len > 0, r.length < len {
            return KeyWatch(kind: .selectAll(f, r, len), focus: focusId)
        }
        return nil
    }

    /// The panel's windows and sheets, counted (a sheet it opened — Go to folder — shows here).
    func panelFingerprint(_ e: AXUIElement, app: AXUIElement) -> Int {
        var n = ax.elements(app, kAXWindowsAttribute).count * 1000
        var cur: AXUIElement? = e
        for _ in 0..<60 {
            guard let c = cur else { break }
            let role = ax.string(c, kAXRoleAttribute)
            if role == kAXSheetRole || role == kAXWindowRole {
                n += ax.elements(c, kAXChildrenAttribute).filter { ax.string($0, kAXRoleAttribute) == kAXSheetRole }.count
                if role == kAXWindowRole { break }
            }
            cur = ax.element(c, kAXParentAttribute)
        }
        return n
    }

    /// What is selected in the panel `e` lies in, nearest first: the selected rows or children of `e` and its
    /// ancestors up to the sheet or window, and the selected text of `e`.
    func panelSelection(_ e: AXUIElement) -> PanelSelection {
        var out: [AXIdentity] = []
        var cur: AXUIElement? = e
        for _ in 0..<12 {
            guard let c = cur else { break }
            for name in [kAXSelectedRowsAttribute, kAXSelectedChildrenAttribute, kAXSelectedCellsAttribute] {
                out += ax.elements(c, name).map { AXIdentity(element: $0) }
            }
            let role = ax.string(c, kAXRoleAttribute)
            if role == kAXSheetRole || role == kAXWindowRole { break }
            cur = ax.element(c, kAXParentAttribute)
        }
        return PanelSelection(items: out, text: ax.string(e, kAXSelectedTextAttribute))
    }

    struct PanelSelection: Equatable {
        var items: [AXIdentity]
        var text: String?
    }

    func keyUnchanged(_ w: KeyWatch, _ a: CUKeyAction, _ t: CUTarget) -> String? {
        let deadline = clock.nowMs() + Self.keyWatchMs
        func changed() -> Bool {
            let focus = reportedFocus(t).map { AXIdentity(element: $0) }
            switch w.kind {
            case .tab: return focus != w.focus
            case .toggle(let e, let v): return ax.string(e, kAXValueAttribute) != v || focus != w.focus
            case .selectAll(let e, let r, let len):
                // With `into` the focusing press itself moves the caret: only the whole text selected counts then.
                guard a.into == nil else { return (selectionRange(e)?.length ?? 0) >= len || focus != w.focus }
                return selectionRange(e) != r || focus != w.focus
            case .panel(let e, let fp, let f, let v, let sel):
                return panelFingerprint(e, app: ax.application(t.pid)) != fp || focus != f || ax.string(e, kAXValueAttribute) != v
                    || panelSelection(e) != sel
            }
        }
        while !changed() {
            if clock.nowMs() >= deadline {
                switch w.kind {
                case .tab(let f, let v):
                    // The field took the key itself (a tab character, a field that indents): said as that — never as
                    // the page ignoring it.
                    if let now = ax.string(f, kAXValueAttribute), now != v {
                        return "the keyboard focus stayed in its field after \(a.combo), and the field's text changed (it took the key itself, as a tab character or an indent) — click the next field you mean\(a.into == nil ? ", or pass { into }" : "")"
                    }
                    return "the keyboard focus did not move after \(a.combo) (the page may not have taken the key) — click the field you mean\(a.into == nil ? ", or pass { into }" : "")"
                case .toggle:
                    return "the focused check box did not change after \(a.combo) (the page may not have taken the key) — click(ref) presses it"
                case .selectAll(_, _, let len):
                    return "the selection did not change after \(a.combo) (the field holds \(len) characters; the page may not have taken the key) — setValue(ref, text) replaces a field's text"
                case .panel(_, _, _, _, _):
                    return "nothing new appeared in the panel after \(a.combo) (no sheet or window opened, its focus did not move) — the panel may not take keys from here; set its fields with setValue (state({ within: <the panel> }) shows them — its search field, or the Go to folder field once open) or click a row"
                }
            }
            clock.pause(ms: 50)
        }
        return nil
    }

    // MARK: a Chromium page on another desktop (finding D)

    /// What says an act or key changed nothing (the helper's own words for it).
    static let nothingChangedClaims = ["nothing changed that accessibility can see", "had no effect accessibility can see", "no visible effect",
                                       "may not have taken the key", "did not change after", "did not move after", "still reads",
                                       "did not change to it"]

    /// The caveat a "nothing changed" answer gets when the window is a Chromium app's on ANOTHER desktop: such a page may
    /// not update its accessibility (nor its picture) until it is seen, so the claim may predate the act's effect (the
    /// leftover probes, 2026-10-13: Chrome full screen on its own Space — the page toggled while the answer said the
    /// press did nothing, and find() read the box unchecked). Nil when the detail claims no such thing. Pure.
    static func offDesktopLagCaveat(_ detail: String?, app: String) -> String? {
        guard let d = detail, nothingChangedClaims.contains(where: { d.contains($0) }) else { return nil }
        return offDesktopLagSentence(app)
    }

    /// How long after an act find() says its states may lag (a Chromium page on another desktop).
    static let offDesktopLagFindMs: Double = 10_000

    static func offDesktopLagSentence(_ app: String) -> String {
        "\(app)'s page is on another desktop, where it may not update its accessibility until it is seen — what it reads may predate the action, so this is unverified; screenshot({ live: true, reason }) shows the window now"
    }

    /// Does `t`'s page lag on another desktop (a Chromium-family window off this desktop)?
    func pageMayLagOffDesktop(_ t: CUTarget) -> Bool {
        t.isChromium && isOffThisDesktop(t)
    }

    // MARK: an off-desktop picture right after an act

    /// An act within this long before an off-screen picture: the picture is waited for, bounded.
    static let offScreenAfterActWindowMs: Double = 1500
    /// The least time after an act a first off-screen picture is taken at, and the longest a picture unchanged since
    /// before the act is waited on to change.
    static let offScreenAfterActMinMs: Double = 300
    static let offScreenAfterActWaitMs: Double = 700

    /// The window server's picture of a window that is not on screen, taken right after an act: an app may redraw such
    /// a window late (or not until it is seen). A first picture waits until a moment has passed since the act; one the
    /// same as the picture before the act is taken again, every 100 ms for up to `offScreenAfterActWaitMs`, until it
    /// changes. Never moves anything.
    func offScreenAfterAct(_ t: CUTarget, _ region: CGRect?, _ budget: CUImageBudget,
                           token: CUCancellation.Token? = nil) throws -> CUCapturedImage? {
        guard let acted = t.lastActionMs, let from = t.afterActFromMs, clock.nowMs() - from < Self.offScreenAfterActWindowMs else {
            return try offScreenStill(t, region, budget)
        }
        let previous = t.lastOffScreenShot
        guard let previous, previous.atMs < acted else {
            // No picture from before the act to compare with: a moment after the act, at least.
            let since = clock.nowMs() - from
            if since < Self.offScreenAfterActMinMs {
                // In steps, the call's cancel (Esc) checked between them.
                var left = Self.offScreenAfterActMinMs - since
                while left > 0 {
                    try token?.check()
                    clock.pause(ms: min(50, left))
                    left -= 50
                }
            }
            try token?.check()
            return try offScreenStill(t, region, budget)
        }
        guard var shot = try offScreenStill(t, region, budget) else { return nil }
        let deadline = clock.nowMs() + Self.offScreenAfterActWaitMs
        while Self.contentDigest(shot.jpeg) == previous.digest, clock.nowMs() < deadline {
            try token?.check()
            clock.pause(ms: 100)
            try token?.check()
            guard let again = try offScreenStill(t, region, budget) else { break }
            shot = again
        }
        return shot
    }

    /// The freshness label of a picture taken within moments of an act, extended: one unchanged since before the act
    /// may predate it (an app may not redraw a window on another desktop until it is seen) — said, with the way out;
    /// a first picture says how soon after the act it was taken. Any other label as it is. Pure.
    /// `returnedMs`: when the act's result was returned (the window runs from there; nil: from the act's input).
    static func afterActFreshness(_ label: String, app: String, previous: (digest: Int, atMs: Double, changedAtMs: Double)?,
                                  digest: Int, now: Double, actedMs: Double?, returnedMs: Double? = nil) -> String {
        guard let acted = actedMs else { return label }
        let from = max(acted, returnedMs ?? acted)
        guard now - from < offScreenAfterActWindowMs + offScreenAfterActWaitMs + 1000, now >= acted else { return label }
        let way = "screenshot({ live: true, reason }) takes one where the window is (the user is asked first)"
        if let previous, previous.atMs < acted, previous.digest == digest {
            return label + " — this picture may predate the last action: \(app) may not redraw a window on another desktop until it is seen; \(way)"
        }
        if previous == nil {
            return label + " — taken \(Int((now - from).rounded())) ms after the last action, with no earlier picture to compare: it may predate the action; \(way)"
        }
        return label
    }
}
