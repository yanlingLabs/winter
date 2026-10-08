import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// `target.act`: every action walks the input ladder (spec §8) —
/// 1. AX actions and attribute writes (`AXPress`, `AXValue`, `AXSelectedText`, menu items), no focus needed;
/// 2. events posted to the target pid, with public synthetic focus;
/// 3. SkyLight events plus focus-without-raise for Chromium/Electron (`privatePath`);
/// 4. the foreground and the real pointer, only with `allowForeground`, hit-testing every event.
/// The floors (§2.4) run before anything reaches the app, and text input re-checks them per character.
extension CUCore {
    struct ActOutcome {
        var rung: CUInputLadder.Rung
        var detail: String?

        /// Puts `note` (what was done to reach the window) in front of the rung's own detail.
        func noting(_ note: String?) -> ActOutcome {
            guard let note else { return self }
            return ActOutcome(rung: rung, detail: [note, detail].compactMap { $0 }.joined(separator: "; "))
        }
    }

    public func targetAct(_ p: TargetActParams) async throws -> TargetActResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        try ensureAlive(t)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        try token.check()
        do {
            try Self.checkAccess(p.action, access: p.access, appName: t.appName)
        } catch {
            cursor(t, "refused")
            throw error
        }
        if case .key(let k) = p.action, (try? CUKeyChord.parse(k.combo))?.isEscape == true {
            await MainActor.run { [weak self] in self?.events?.willSendEscape() }
        }
        let outcome = try await queues.run(t.pid) { [self] () -> ActOutcome in
            do {
                // A cancel that arrived while this act waited behind others stops it here.
                try token.check()
                try floorCheckPrivacy(t)
                try saveFloorBeforeAct(p, t)
                do {
                    let o = try perform(p, on: t, token: token)
                    t.lastActionMs = clock.nowMs()
                    return o
                } catch let e as CUError where e.code == "stale_element" {
                    if let ref = Self.primaryRef(p.action) { t.refs.forget(ref); throw CUError.staleRef(ref) }
                    // The target is still bound; only the element moved under the action.
                    throw CUError.busy("the \(t.appName) UI changed under the action — call state() and retry")
                }
            } catch {
                // A refusal or a failure: a gentle "no" where the act was aimed. Not for a cancel (the user
                // or the script stopped it) or a target that is gone (its cursor goes with it).
                if Self.showsRefusal(error) { cursor(t, "refused", at: attemptPoint(p.action, t)) }
                throw error
            }
        }
        return TargetActResult(rung: outcome.rung.rawValue, detail: outcome.detail)
    }

    static func showsRefusal(_ error: Error) -> Bool {
        guard let e = error as? CUError else { return true }
        return e.code != "cancelled" && e.code != "target_lost"
    }

    /// Where a failed act was aimed: its element's centre, else its point, else the cursor's last place.
    func attemptPoint(_ a: CUAction, _ t: CUTarget) -> CGPoint? {
        if let ref = Self.primaryRef(a), let key = t.refs.key(for: ref), let c = ElementInfo(key.element, ax).center {
            return c
        }
        let pixel: (point: [Double]?, shot: String?)? = {
            switch a {
            case .click(let x): return (x.point, x.shotId)
            case .scroll(let x): return (x.point, x.shotId)
            case .drag(let x): return (x.from.point, x.shotId)
            default: return nil
            }
        }()
        if let pixel, let px = try? cuPoint(pixel.point), let pt = try? screenPoint(for: t, shotId: pixel.shot, pixel: px) {
            return pt
        }
        return nil
    }

    /// The user's click-only restriction (R17): clicks, scrolls and AX actions only. Pure.
    static func checkAccess(_ action: CUAction, access: CUAccess, appName: String) throws {
        guard access == .click else { return }
        switch action {
        case .click, .scroll, .action: return
        default:
            throw CUError.notAllowed("click_only",
                                     "\(appName) is set to click only in Settings — it allows clicks, scrolls and actions")
        }
    }

    static func primaryRef(_ a: CUAction) -> Int? {
        switch a {
        case .click(let x): return x.ref
        case .setValue(let x): return x.ref
        case .type(let x): return x.into
        case .paste(let x): return x.into
        case .key(let x): return x.into
        case .scroll(let x): return x.ref
        case .drag(let x): return x.from.ref ?? x.to.ref
        case .select(let x): return x.ref
        case .action(let x): return x.ref
        case .menu: return nil
        }
    }

    /// An open save panel pointing at a protected destination blocks every act on the app — a click on Save,
    /// Space on a focused Save button, AXConfirm on the name field all save — except cancelling it (Escape)
    /// and renaming the file to something harmless.
    func saveFloorBeforeAct(_ p: TargetActParams, _ t: CUTarget) throws {
        let panels = CUFloorScan.openSavePanels(pid: t.pid, ax: ax)
        guard panels.contains(where: { CUFloorScan.panelIsProtected($0, ax: ax) }) else { return }
        if case .key(let k) = p.action, (try? CUKeyChord.parse(k.combo))?.isEscape == true { return }
        let rename: (ref: Int?, text: String)? = {
            switch p.action {
            case .setValue(let a): return (a.ref, a.value)
            case .type(let a): return (a.into, a.text)
            case .paste(let a): return (a.into, a.text)
            default: return nil
            }
        }()
        if let rename, !CUFloors.typedSavePathIsProtected(rename.text) {
            let field = try rename.ref.map { try element($0, in: t) } ?? reportedFocus(t)
            if let field, let id = ax.string(field, kAXIdentifierAttribute), CUFloorScan.saveNameFieldIdentifiers.contains(id) {
                return
            }
        }
        throw CUFloorScan.savePathRefusal
    }

    // MARK: dispatch (pid queue)

    func perform(_ p: TargetActParams, on t: CUTarget, token: CUCancellation.Token) throws -> ActOutcome {
        switch p.action {
        case .click(let a): return try click(a, p, t, token)
        case .setValue(let a): return try setValue(a, p, t, token)
        case .type(let a): return try type(a, p, t, token)
        case .paste(let a): return try paste(a, p, t, token)
        case .key(let a): return try key(a, p, t, token)
        case .scroll(let a): return try scroll(a, p, t, token)
        case .drag(let a): return try drag(a, p, t, token)
        case .select(let a): return try select(a, p, t, token)
        case .action(let a): return try axAction(a, p, t, token)
        case .menu(let a): return try menu(a, p, t, token)
        }
    }

    /// An AX action or write that timed out may still run later: never follow it with events (that would do
    /// it twice). The script observes and decides.
    static func deliveryUncertain(_ e: Error) -> Bool { (e as? CUError)?.code == "busy" }

    func busyAfterSend(_ t: CUTarget) -> CUError {
        CUError.busy("\(t.appName) did not confirm the action in time — it may still happen; call state() before retrying")
    }

    // MARK: click

    private func click(_ a: CUClickAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let button = a.button ?? .left
        let count = a.count ?? 1
        guard (1...3).contains(count) else { throw CUError.invalidParams("count must be 1, 2 or 3") }
        let flags = try cuModifierFlags(a.modifiers)
        if let ref = a.ref {
            guard a.point == nil else { throw CUError.invalidParams("click takes a ref or a point, not both") }
            let e = try element(ref, in: t)
            let info = ElementInfo(e, ax)
            try pasteMenuGuard(e, info, p, t)
            t.noteTargeted(e, at: clock.nowMs())
            announceTarget(t, info, pressing: button == .left)
            var announced = false
            if count == 1, flags.isEmpty {
                let axAction: String? = button == .left && info.actions.contains(kAXPressAction) ? kAXPressAction
                    : button == .right && info.actions.contains(kAXShowMenuAction) ? kAXShowMenuAction : nil
                if let axAction {
                    cursor(t, "press", at: info.center, count: 1, button: button.rawValue)
                    announced = true
                    try token.check()
                    do {
                        try ax.perform(e, axAction)
                        return ActOutcome(rung: .accessibility)
                    } catch let error where Self.deliveryUncertain(error) {
                        throw busyAfterSend(t)
                    } catch let err as CUError where err.code == "stale_element" || err.code == "permission_missing" {
                        throw err
                    } catch {
                        // The element refused the action outright: fall through to events at its centre.
                    }
                }
            }
            guard let center = info.center else {
                throw CUError.unsupported("[\(ref)] has no position on screen — try action() or a screenshot point")
            }
            return try pointerClick(p, t, at: center, button: button, count: count, flags: flags, token, announced: announced)
        }
        guard let px = try cuPoint(a.point) else { throw CUError.invalidParams("click needs a ref or a point") }
        let pt = try screenPoint(for: t, shotId: a.shotId, pixel: px)
        return try pointerClick(p, t, at: pt, button: button, count: count, flags: flags, token)
    }

    /// `announced`: the cursor already showed this press (an AX attempt that fell back to events).
    private func pointerClick(_ p: TargetActParams, _ t: CUTarget, at pt: CGPoint, button: CUMouseButton, count: Int,
                              flags: CGEventFlags, _ token: CUCancellation.Token, announced: Bool = false) throws -> ActOutcome {
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: true))
        let moved = try bringToThisDesktop(p, t)
        let synth = self.synth
        let windowFor = self.windowFor(t)
        let event = announced ? nil : CursorEvent(kind: "press", point: pt, count: count, button: button.rawValue)
        return try runEvents(p, t, d, focus: true, token, cursor: event) { route, check in
            try synth.click(pid: t.pid, windowFor: windowFor, at: pt, button: button, count: count, flags: flags,
                            route: route, check: check)
        }.noting(moved)
    }

    /// A screenshot pixel of this target (`shotId`, else its latest shot) → global screen points.
    func screenPoint(for t: CUTarget, shotId: String?, pixel: CGPoint) throws -> CGPoint {
        let shot = try t.shot(shotId)
        switch shot.anchor {
        case .window(let wid, _):
            guard let w = sys.window(id: wid) else { throw CUError.targetLost("that screenshot's window is gone") }
            return try shot.screenPoint(pixel: pixel, windowOrigin: w.frame.origin)
        case .screen:
            return try shot.screenPoint(pixel: pixel)
        }
    }

    /// Events are routed to the target pid's front-most window under the point (a sheet, popover or panel),
    /// falling back to the bound window. One window-list read per action.
    func windowFor(_ t: CUTarget) -> (CGPoint) -> UInt32 {
        let stack = sys.windowStack().filter { $0.pid == t.pid && $0.alpha > 0 }
        let bound = t.windowID
        return { point in stack.first { $0.frame.contains(point) }?.id ?? bound }
    }

    // MARK: text

    /// How long an element the script clicked by ref (or aimed at with `into`) stands in for a focus the app
    /// won't report.
    static let targetedFocusMs: Double = 60_000

    /// The typing guard of one act (C1), shared by its every check so the window is scanned at most once.
    final class TypingFocus {
        /// The window scan, once one was needed.
        var scan: CUFloorScan.SensitiveScan?
        /// The field `into` named for this act (already checked not to be sensitive).
        var explicit: AXUIElement?
        /// A tab or return was typed since: the named field may no longer have the focus.
        var focusMayHaveMoved = false
        init(explicit: AXUIElement? = nil) { self.explicit = explicit }
    }

    /// The focus the app reports, else the one the bound window reports.
    func reportedFocus(_ t: CUTarget) -> AXUIElement? {
        if let f = ax.focusedElement(pid: t.pid) { return f }
        if let w = try? windowElement(t), let f = ax.element(w, kAXFocusedUIElementAttribute) { return f }
        return nil
    }

    /// Where typed text goes, or a refusal (C1). A focus the app or window reports is refused only when it is
    /// a password or payment field (`secure_field`). An unreported focus (Electron apps often report none) is
    /// allowed when a scan of the window finds no such field — the text then goes to whatever has the focus,
    /// best known as the window's one `AXFocused` element or the element the script just clicked or named;
    /// otherwise it is refused as `focus_unknown`, unless `into` named the field and no tab or return has
    /// been typed since. Returns nil when the focus is unknown but allowed.
    @discardableResult
    func requireTypableFocus(_ t: CUTarget, _ g: TypingFocus = TypingFocus()) throws -> AXUIElement? {
        if let f = reportedFocus(t) {
            if ElementInfo(f, ax).secure { throw secureRefusal() }
            return f
        }
        let scan = g.scan ?? sensitiveScan(t)
        g.scan = scan
        if scan.clear {
            if scan.focused.count == 1 { return scan.focused[0] }
            return g.explicit ?? recentlyTargeted(t)
        }
        if let e = g.explicit, !g.focusMayHaveMoved { return e }
        throw focusUnknownRefusal(t, scan)
    }

    func recentlyTargeted(_ t: CUTarget) -> AXUIElement? {
        guard let last = t.lastTargeted, clock.nowMs() - last.atMs <= Self.targetedFocusMs, ax.isAlive(last.element)
        else { return nil }
        return last.element
    }

    /// The bound window, plus the app's focused window when that is another one.
    func sensitiveScan(_ t: CUTarget) -> CUFloorScan.SensitiveScan {
        var roots: [AXUIElement] = []
        if let w = try? windowElement(t) { roots.append(w) }
        if let f = ax.element(ax.application(t.pid), kAXFocusedWindowAttribute), !roots.contains(where: { CFEqual($0, f) }) {
            roots.append(f)
        }
        guard !roots.isEmpty else { return CUFloorScan.SensitiveScan(sensitive: false, complete: false, focused: []) }
        return CUFloorScan.sensitiveScan(roots: roots, ax: ax)
    }

    func focusUnknownRefusal(_ t: CUTarget, _ scan: CUFloorScan.SensitiveScan) -> CUError {
        let why = scan.sensitive
            ? "and this window has a secure input (a password or card field), so typing without knowing where it goes is refused"
            : "and its window is too large to check for secure inputs in time"
        return CUError.refused(.focusUnknown,
                               "\(t.appName) doesn't report which field has keyboard focus, \(why) — pass `into` with the ref of the field to type into")
    }

    private func setValue(_ a: CUSetValueAction, _ p: TargetActParams, _ t: CUTarget,
                          _ token: CUCancellation.Token) throws -> ActOutcome {
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e, ax)
        if info.secure { throw secureRefusal() }
        try CUFloorScan.checkTypedIntoSavePanel(e, text: a.value, pid: t.pid, ax: ax)
        t.noteTargeted(e, at: clock.nowMs())
        announceTarget(t, info, pressing: false)
        cursor(t, "type", at: info.center)
        try token.check()
        if ax.isSettable(e, kAXValueAttribute) {
            do {
                try ax.set(e, kAXValueAttribute, a.value as CFString)
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
            }
            return ActOutcome(rung: .accessibility)
        }
        // Not settable: focus it, select everything, and type over it.
        let g = TypingFocus(explicit: e)
        try? ax.set(e, kAXFocusedAttribute, kCFBooleanTrue)
        if let len = ax.string(e, kAXValueAttribute)?.utf16.count, ax.isSettable(e, kAXSelectedTextRangeAttribute),
           let r = AX.makeRange(location: 0, length: len) {
            try? ax.set(e, kAXSelectedTextRangeAttribute, r)
        } else {
            try requireTypableFocus(t, g)
            _ = try sendChord(CUKeyChord(key: .character("a"), modifiers: [.command]), p, t, token, g)
        }
        return try typeText(a.value, into: e, p, t, token, g)
    }

    private func type(_ a: CUTypeAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let (e, g) = try textTarget(into: a.into, t, text: a.text)
        cursor(t, "type", at: e.flatMap { ElementInfo($0, ax).center })
        return try typeText(a.text, into: e, p, t, token, g)
    }

    private func paste(_ a: CUPasteAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let (e, g) = try textTarget(into: a.into, t, text: a.text)
        cursor(t, "type", at: e.flatMap { ElementInfo($0, ax).center })
        return try pasteText(a.text, format: a.format ?? .text, p, t, token, g)
    }

    /// The element text goes into: `into` (focused first), else the focus (see `requireTypableFocus`; nil
    /// when unknown but allowed). Sensitive-field and save-path floors applied.
    private func textTarget(into: Int?, _ t: CUTarget, text: String) throws -> (AXUIElement?, TypingFocus) {
        let g = TypingFocus()
        let e: AXUIElement?
        if let into {
            let el = try element(into, in: t)
            let info = ElementInfo(el, ax)
            if info.secure { throw secureRefusal() }
            announceTarget(t, info, pressing: false)
            try? ax.set(el, kAXFocusedAttribute, kCFBooleanTrue)
            t.noteTargeted(el, at: clock.nowMs())
            g.explicit = el
            e = el
        } else {
            e = try requireTypableFocus(t, g)
        }
        try CUFloorScan.checkTypedIntoSavePanel(e, text: text, pid: t.pid, ax: ax)
        return (e, g)
    }

    /// AX insert at the selection (confirmed by polling) → paste for long or multi-line text → per-key events.
    private func typeText(_ text: String, into e: AXUIElement?, _ p: TargetActParams, _ t: CUTarget,
                          _ token: CUCancellation.Token, _ g: TypingFocus) throws -> ActOutcome {
        guard !text.isEmpty else { return ActOutcome(rung: .accessibility, detail: "nothing to type") }
        try token.check()
        if let e, ax.isSettable(e, kAXSelectedTextAttribute) {
            let before = ax.string(e, kAXValueAttribute)
            let since = clock.nowMs()
            var applied = false
            do {
                try ax.set(e, kAXSelectedTextAttribute, text as CFString)
                applied = true
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
            } catch {
                // Refused outright: nothing was inserted, so the fallbacks below can't double it.
            }
            if applied {
                // Chromium applies the edit asynchronously: wait for it before deciding it failed, or the
                // fallback would type it a second time.
                if before == nil { return ActOutcome(rung: .accessibility) }
                if waitForEdit(t, e, before: before, since: since, capMs: t.isChromium ? 300 : 150) {
                    return ActOutcome(rung: .accessibility)
                }
            }
        }
        if text.contains("\n") || text.count > 64 {
            return try pasteText(text, format: .text, p, t, token, g)
        }
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: false))
        let synth = self.synth
        let chars = Array(text)
        var next = 0
        return try runEvents(p, t, d, focus: true, token) { [self] route, _ in
            try synth.type(pid: t.pid, text: text, route: route) {
                // Before EVERY character: not cancelled, still running, and focus still on a typable,
                // non-sensitive field — a tab or return may just have moved it to a password field.
                try token.check()
                guard sys.appRunning(t.pid) else { throw CUError.targetLost("\(t.appName) quit while typing") }
                if next > 0, chars[next - 1] == "\t" || chars[next - 1].isNewline { g.focusMayHaveMoved = true }
                next += 1
                try requireTypableFocus(t, g)
            }
        }
    }

    /// Polls for evidence that an edit landed: the value changed, or a value-change notification arrived.
    func waitForEdit(_ t: CUTarget, _ e: AXUIElement?, before: String?, since: Double, capMs: Double) -> Bool {
        let ax = self.ax, monitor = self.monitor, clock = self.clock
        return CUEditEvidence(readValue: { e.flatMap { ax.string($0, kAXValueAttribute) } },
                              lastValueChangeMs: { monitor.lastValueChangeMs(pid: t.pid) },
                              nowMs: { clock.nowMs() },
                              sleepMs: { usleep(useconds_t($0 * 1000)) })
            .wait(before: before, since: since, capMs: capMs)
    }

    private func pasteText(_ text: String, format: CUPasteFormat, _ p: TargetActParams, _ t: CUTarget,
                           _ token: CUCancellation.Token, _ g: TypingFocus) throws -> ActOutcome {
        try token.check()
        let focus = try requireTypableFocus(t, g)
        let before = focus.flatMap { ax.string($0, kAXValueAttribute) }
        var sent: ActOutcome?
        var since = clock.nowMs()
        let seq = CUPasteSequence(
            pasteboard: pasteboard(),
            sendPaste: {
                since = self.clock.nowMs()
                sent = try self.sendChord(CUKeyChord(key: .character("v"), modifiers: [.command]), p, t, token, g)
            },
            // Restore only once the paste visibly happened (or 1.5 s passed): an app that reads the
            // clipboard late must not get the user's own contents instead.
            waitForEvidence: { self.waitForEdit(t, focus, before: before, since: since, capMs: 1500) })
        let result = try seq.run(items: CUPasteSequence.items(text: text, format: format),
                                 plain: CUPasteSequence.plain(text: text, format: format))
        var o = sent ?? ActOutcome(rung: .processEvents)
        switch result {
        case .leftAlone:
            o.detail = [o.detail, "the clipboard changed meanwhile, so it was not restored"].compactMap { $0 }.joined(separator: "; ")
        case .restored(let evidence) where !evidence:
            o.detail = [o.detail, "the paste was not confirmed within 1.5 s"].compactMap { $0 }.joined(separator: "; ")
        default: break
        }
        return o
    }

    // MARK: keys

    private func key(_ a: CUKeyAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let chord = try CUKeyChord.parse(a.combo)
        let rep = a.repeat ?? 1
        guard (1...100).contains(rep) else { throw CUError.invalidParams("repeat must be 1–100") }
        var e: AXUIElement?
        let g = TypingFocus()
        if let into = a.into {
            let el = try element(into, in: t)
            let info = ElementInfo(el, ax)
            if Self.producesText(chord), info.secure { throw secureRefusal() }
            announceTarget(t, info, pressing: false)
            try? ax.set(el, kAXFocusedAttribute, kCFBooleanTrue)
            t.noteTargeted(el, at: clock.nowMs())
            g.explicit = el
            e = el
        } else {
            e = reportedFocus(t)
        }
        let textual = Self.producesText(chord)
        // Characters (and cmd+V) are text input: never into a password or payment field (C1).
        if textual { e = try requireTypableFocus(t, g) ?? e }
        cursor(t, "key", at: e.flatMap { ElementInfo($0, ax).center }, text: a.combo)
        // Resolve the route once (the menu lookup walks the menu bar), then press it `repeat` times.
        let plan = try chordPlan(chord, p, t, g)
        var out = ActOutcome(rung: .accessibility)
        for _ in 0..<rep {
            try token.check()
            if textual { try requireTypableFocus(t, g) }
            out = try execute(plan, p, t, token)
        }
        return out
    }

    static func producesText(_ c: CUKeyChord) -> Bool {
        guard case .character(let ch) = c.key else { return c.key == .named(.space) }
        if c.modifiers.contains(.command) { return ch == "v" }
        return !c.modifiers.contains(.control)
    }

    /// How a chord reaches the app: a menu item with that key equivalent (rung 1), else key events.
    enum ChordPlan {
        case menuItem(AXUIElement, title: String)
        case events(code: CGKeyCode, flags: CGEventFlags, decision: CUInputLadder.Decision)
    }

    func chordPlan(_ chord: CUKeyChord, _ p: TargetActParams, _ t: CUTarget, _ g: TypingFocus = TypingFocus()) throws -> ChordPlan {
        if chord.modifiers.contains(.command), case .character(let ch) = chord.key,
           let item = menuItem(forKey: ch, modifiers: chord.modifiers, pid: t.pid) {
            if ch == "v" || CUPasteMenu.isPasteTitle(item.title) {
                try requirePasteSafe(p, t, g)
            }
            return .menuItem(item.element, title: item.title)
        }
        let code: CGKeyCode
        switch chord.key {
        case .named(let n): code = CUKeyCodes.code(for: n)
        case .character(let ch):
            guard let c = CUKeyCodes.code(for: ch) else { throw CUError.unsupported("no key for “\(ch)” on this keyboard") }
            code = c
        }
        return .events(code: code, flags: chord.modifiers.cgFlags,
                       decision: try CUInputLadder.decideEvents(context(p, t, pointer: false)))
    }

    func execute(_ plan: ChordPlan, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        switch plan {
        case .menuItem(let element, let title):
            do {
                try ax.perform(element, kAXPressAction)
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
            }
            return ActOutcome(rung: .accessibility, detail: "used the menu item “\(title)”")
        case .events(let code, let flags, let d):
            let synth = self.synth
            return try runEvents(p, t, d, focus: true, token) { route, _ in
                synth.key(pid: t.pid, code: code, flags: flags, route: route)
            }
        }
    }

    /// One chord, start to finish.
    func sendChord(_ chord: CUKeyChord, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token,
                   _ g: TypingFocus = TypingFocus()) throws -> ActOutcome {
        try execute(try chordPlan(chord, p, t, g), p, t, token)
    }

    /// A menu-bar item whose key equivalent is `key` with `modifiers` (command implied). The walk is bounded
    /// in items and time.
    func menuItem(forKey key: Character, modifiers: CUKeyChord.Modifiers, pid: pid_t) -> (element: AXUIElement, title: String)? {
        guard let roots = try? CUAXMenuNode.menuBar(pid: pid, ax: ax) else { return nil }
        let want = String(key).uppercased()
        var wantMods = 0
        if modifiers.contains(.shift) { wantMods |= 1 }
        if modifiers.contains(.option) { wantMods |= 2 }
        if modifiers.contains(.control) { wantMods |= 4 }
        var queue = Array(roots.dropFirst())  // skip the Apple menu
        var seen = 0
        let deadline = CUFloorScan.Deadline(ms: 250)
        while !queue.isEmpty, seen < 1500, !deadline.passed {
            let n = queue.removeFirst()
            seen += 1
            if let attrs = ax.copyMultiple(n.element, [kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute,
                                                        kAXEnabledAttribute, kAXTitleAttribute]),
               let ch = attrs[kAXMenuItemCmdCharAttribute].flatMap(AX.stringValue), ch.uppercased() == want {
                let mods = attrs[kAXMenuItemCmdModifiersAttribute].flatMap { ($0 as? NSNumber)?.intValue } ?? 0
                let enabled = attrs[kAXEnabledAttribute].flatMap(AX.boolValue) ?? true
                if mods == wantMods, enabled {
                    return (n.element, attrs[kAXTitleAttribute].flatMap(AX.stringValue) ?? want)
                }
            }
            queue.append(contentsOf: n.menuChildren)
        }
        return nil
    }

    // MARK: paste safety (I5)

    /// Pasting puts the clipboard into whatever has focus: refused under click-only, and while the focus is
    /// unknown or a password field — however the paste is reached (`menu`, a menu-item ref, cmd+V).
    func requirePasteSafe(_ p: TargetActParams, _ t: CUTarget, _ g: TypingFocus = TypingFocus()) throws {
        if p.access == .click {
            throw CUError.notAllowed("click_only", "\(t.appName) is set to click only in Settings — pasting is typing")
        }
        try requireTypableFocus(t, g)
    }

    /// A menu item (open menu, by ref) that pastes.
    func pasteMenuGuard(_ e: AXUIElement, _ info: ElementInfo, _ p: TargetActParams, _ t: CUTarget) throws {
        guard info.role == kAXMenuItemRole else { return }
        let a = ax.copyMultiple(e, [kAXTitleAttribute, kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute]) ?? [:]
        if CUPasteMenu.isPasteItem(title: a[kAXTitleAttribute].flatMap(AX.stringValue),
                                   cmdChar: a[kAXMenuItemCmdCharAttribute].flatMap(AX.stringValue),
                                   cmdModifiers: a[kAXMenuItemCmdModifiersAttribute].flatMap { ($0 as? NSNumber)?.intValue }) {
            try requirePasteSafe(p, t)
        }
    }

    // MARK: scroll and drag

    private func scroll(_ a: CUScrollAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let pages = a.pages ?? 1
        guard pages > 0, pages <= 50 else { throw CUError.invalidParams("pages must be between 0 and 50") }
        var point: CGPoint
        var viewport: CGSize
        if let ref = a.ref {
            let e = try element(ref, in: t)
            let info = ElementInfo(e, ax)
            announceTarget(t, info, pressing: false)
            try token.check()
            if let area = scrollArea(from: e) {
                do {
                    if try axScroll(area: area, direction: a.direction, pages: pages) {
                        cursor(t, "scroll", at: info.center, text: a.direction.rawValue)
                        return ActOutcome(rung: .accessibility)
                    }
                } catch let error where Self.deliveryUncertain(error) {
                    throw busyAfterSend(t)
                }
            }
            guard let c = info.center else { throw CUError.unsupported("[\(ref)] has no position on screen") }
            point = c
            viewport = (scrollArea(from: e).flatMap { ax.frame($0) } ?? info.frame)?.size ?? CGSize(width: 400, height: 400)
        } else {
            guard let px = try cuPoint(a.point) else { throw CUError.invalidParams("scroll needs a ref or a point") }
            point = try screenPoint(for: t, shotId: a.shotId, pixel: px)
            viewport = sys.window(id: t.windowID)?.frame.size ?? CGSize(width: 400, height: 400)
        }
        let vertical = a.direction == .up || a.direction == .down
        let amount = (vertical ? viewport.height : viewport.width) * 0.9 * pages
        // Wheel deltas: positive moves the content down/right, i.e. scrolls up/left.
        let dy = a.direction == .down ? -amount : a.direction == .up ? amount : 0
        let dx = a.direction == .right ? -amount : a.direction == .left ? amount : 0
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: true))
        let moved = try bringToThisDesktop(p, t)
        let synth = self.synth
        let windowFor = self.windowFor(t)
        let event = CursorEvent(kind: "scroll", point: point, text: a.direction.rawValue)
        return try runEvents(p, t, d, focus: false, token, cursor: event) { route, check in
            try synth.scroll(pid: t.pid, windowFor: windowFor, at: point, deltaX: dx, deltaY: dy, route: route, check: check)
        }.noting(moved)
    }

    /// The element itself when it is a scroll area, else its nearest scroll-area ancestor.
    func scrollArea(from e: AXUIElement) -> AXUIElement? {
        var cur: AXUIElement? = e
        for _ in 0..<10 {
            guard let c = cur else { return nil }
            if ax.string(c, kAXRoleAttribute) == kAXScrollAreaRole { return c }
            cur = ax.element(c, kAXParentAttribute)
        }
        return nil
    }

    /// Rung 1 scrolling: move the scroll bar's value by `pages` viewports. False when the bar can't be set;
    /// throws `busy` when the write may have happened.
    func axScroll(area: AXUIElement, direction: CUScrollDirection, pages: Double) throws -> Bool {
        let vertical = direction == .up || direction == .down
        guard let bar = ax.element(area, vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute),
              ax.isSettable(bar, kAXValueAttribute),
              let raw = ax.attribute(bar, kAXValueAttribute), let value = (raw as? NSNumber)?.doubleValue,
              let viewport = ax.frame(area)
        else { return false }
        let content = ax.elements(area, kAXChildrenAttribute).first { ax.string($0, kAXRoleAttribute) != kAXScrollBarRole }
            .flatMap { ax.frame($0) }
        guard let content else { return false }
        let view = vertical ? viewport.height : viewport.width
        let total = vertical ? content.height : content.width
        guard total > view + 1 else { return true }  // nothing to scroll: done
        let step = pages * 0.9 * view / (total - view)
        let sign: Double = (direction == .down || direction == .right) ? 1 : -1
        let next = min(1, max(0, value + sign * step))
        do {
            try ax.set(bar, kAXValueAttribute, NSNumber(value: next))
            return true
        } catch let error where Self.deliveryUncertain(error) {
            throw error
        } catch {
            return false
        }
    }

    private func drag(_ a: CUDragAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        var fromInfo: ElementInfo?
        func point(_ end: CUDragEnd, _ what: String) throws -> CGPoint {
            if let ref = end.ref {
                guard end.point == nil else { throw CUError.invalidParams("drag \(what) takes a ref or a point, not both") }
                let info = ElementInfo(try element(ref, in: t), ax)
                guard let c = info.center else {
                    throw CUError.unsupported("[\(ref)] has no position on screen")
                }
                if what == "from" { fromInfo = info }
                return c
            }
            guard let px = try cuPoint(end.point, "drag \(what)") else { throw CUError.invalidParams("drag \(what) needs a ref or a point") }
            return try screenPoint(for: t, shotId: a.shotId, pixel: px)
        }
        let from = try point(a.from, "from")
        let to = try point(a.to, "to")
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: true))
        let moved = try bringToThisDesktop(p, t)
        if let fromInfo { announceTarget(t, fromInfo, pressing: false) }
        let synth = self.synth
        let windowFor = self.windowFor(t)
        let event = CursorEvent(kind: "drag", point: from, dragTo: to)
        return try runEvents(p, t, d, focus: true, token, cursor: event) { route, check in
            try synth.drag(pid: t.pid, windowFor: windowFor, from: from, to: to, route: route, check: check)
        }.noting(moved)
    }

    // MARK: select, action, menu

    private func select(_ a: CUSelectAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e, ax)
        if info.secure { throw secureRefusal() }
        guard let value = ax.string(e, kAXValueAttribute) else { throw CUError.unsupported("[\(a.ref)] has no text to select") }
        guard let range = Self.selectionRange(in: value, text: a.text, before: a.before, after: a.after, caret: a.caret) else {
            throw CUError.invalidParams("“\(a.text)” is not in [\(a.ref)]\(a.before != nil || a.after != nil ? " with that context" : "")")
        }
        guard ax.isSettable(e, kAXSelectedTextRangeAttribute), let r = AX.makeRange(location: range.location, length: range.length)
        else { throw CUError.unsupported("[\(a.ref)] does not support selecting text") }
        announceTarget(t, info, pressing: false)
        cursor(t, "press", at: info.center, count: 1, button: "left")
        try token.check()
        try? ax.set(e, kAXFocusedAttribute, kCFBooleanTrue)
        do {
            try ax.set(e, kAXSelectedTextRangeAttribute, r)
        } catch let error where Self.deliveryUncertain(error) {
            throw busyAfterSend(t)
        }
        return ActOutcome(rung: .accessibility)
    }

    /// The UTF-16 range `select` sets: the first occurrence of `text` whose surroundings match `before` /
    /// `after`; a caret collapses it to its start or end. Pure.
    static func selectionRange(in value: String, text: String, before: String?, after: String?,
                               caret: CUCaret?) -> NSRange? {
        guard !text.isEmpty else { return nil }
        let ns = value as NSString
        var search = NSRange(location: 0, length: ns.length)
        while true {
            let r = ns.range(of: text, options: [], range: search)
            guard r.location != NSNotFound else { return nil }
            let head = ns.substring(to: r.location)
            let tail = ns.substring(from: r.location + r.length)
            if (before.map { head.hasSuffix($0) } ?? true) && (after.map { tail.hasPrefix($0) } ?? true) {
                switch caret {
                case .start?: return NSRange(location: r.location, length: 0)
                case .end?: return NSRange(location: r.location + r.length, length: 0)
                case nil: return r
                }
            }
            let next = r.location + 1
            guard next < ns.length else { return nil }
            search = NSRange(location: next, length: ns.length - next)
        }
    }

    private func axAction(_ a: CUAXAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e, ax)
        guard let name = CURoleWords.resolveAction(a.name, among: info.actions) else {
            let have = info.actions.map(CURoleWords.actionWords).joined(separator: ", ")
            throw CUError.invalidParams("[\(a.ref)] has no action “\(a.name)” — it has: \(have.isEmpty ? "none" : have)")
        }
        try pasteMenuGuard(e, info, p, t)
        let role = info.role ?? ""
        let words = CURoleWords.actionWords(name)
        let button = name == kAXShowMenuAction ? "right" : "left"
        announceTarget(t, info, pressing: Self.pressLike.contains(name))
        var shown: (count: Int, button: String)?
        // An app may list an action it then refuses (Finder lists AXOpen on its icons): once refused, the
        // action's pointer equivalent is used straight away, and one without an equivalent leaves state.
        if t.refusedActions[role]?.contains(name) != true {
            cursor(t, "press", at: info.center, count: 1, button: button)
            shown = (1, button)
            try token.check()
            do {
                try ax.perform(e, name)
                return ActOutcome(rung: .accessibility)
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
            } catch let err as CUError where Self.refusedAction(err) {
                t.noteRefused(action: name, role: role)
            }
        }
        guard let pointer = CUCore.pointerEquivalent(name) else {
            throw CUError.unsupported("\(t.appName) lists “\(words)” for [\(a.ref)] but refuses to perform it — it is no longer listed for this kind of element; try click() or a menu")
        }
        guard let center = info.center else {
            throw CUError.unsupported("\(t.appName) refused “\(words)” for [\(a.ref)], and it has no position on screen to \(pointer.verb == "double-clicked" ? "double-click" : "click")")
        }
        t.noteTargeted(e, at: clock.nowMs())
        let same = shown.map { $0.count == pointer.count && $0.button == pointer.button.rawValue } ?? false
        return try pointerClick(p, t, at: center, button: pointer.button, count: pointer.count, flags: [], token, announced: same)
            .noting("\(t.appName) refused “\(words)” over accessibility, so [\(a.ref)] was \(pointer.verb) instead")
    }

    /// The app answered that the element does not support the action (not a timeout or a dead element).
    static func refusedAction(_ e: CUError) -> Bool {
        guard e.code == "unsupported", case .number(let n)? = e.data?["axError"] else { return false }
        return [AXError.actionUnsupported.rawValue, AXError.notImplemented.rawValue].contains(Int32(n))
    }

    private func menu(_ a: CUMenuAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let item = try CUMenuWalker.resolve(a.path, in: try CUAXMenuNode.menuBar(pid: t.pid, ax: ax))
        let attrs = ax.copyMultiple(item.element, [kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute]) ?? [:]
        if CUPasteMenu.isPasteItem(title: item.menuTitle, cmdChar: attrs[kAXMenuItemCmdCharAttribute].flatMap(AX.stringValue),
                                   cmdModifiers: attrs[kAXMenuItemCmdModifiersAttribute].flatMap { ($0 as? NSNumber)?.intValue }) {
            try requirePasteSafe(p, t)
        }
        // A menu command has no on-screen point in the background: a caption only, no press.
        cursor(t, "caption", text: Self.caption("Choosing", a.path.joined(separator: " › ")))
        try token.check()
        do {
            try ax.perform(item.element, kAXPressAction)
        } catch let error where Self.deliveryUncertain(error) {
            throw busyAfterSend(t)
        }
        return ActOutcome(rung: .accessibility)
    }

    // MARK: rungs 2–4

    /// `pointer`: pointer input delivered as events (a coordinate, or a ref without a usable AX action).
    func context(_ p: TargetActParams, _ t: CUTarget, pointer: Bool) -> CUInputLadder.Context {
        CUInputLadder.Context(appName: t.appName, bundleId: t.bundleId, isChromium: t.isChromium,
                              privatePath: p.privatePath, skyLightAvailable: skyLight.isAvailable,
                              allowForeground: p.allowForeground, pointerAtPoint: pointer)
    }

    /// Runs `body` on the decided route, with the focus handling each rung needs. `body` gets the route and
    /// the per-event check: cancellation always, plus the hit test on rung 4.
    /// `cursor`: the act's own cursor event, sent just before its input — after "foreground on" on rung 4, so
    /// the arrow gives way to the real pointer first.
    func runEvents(_ p: TargetActParams, _ t: CUTarget, _ d: CUInputLadder.Decision, focus: Bool,
                   _ token: CUCancellation.Token, cursor event: CursorEvent? = nil,
                   _ body: (CURoute, CUEventSynth.PointerCheck) throws -> CURoute) throws -> ActOutcome {
        try token.check()
        switch d.rung {
        case .foreground:
            let check: CUEventSynth.PointerCheck = { [self] _, point in
                try token.check()
                try hitTest(point, t)
            }
            cursor(t, "foreground", at: sys.cursorLocation(), text: "on", remember: false)
            defer { cursor(t, "foreground", at: sys.cursorLocation(), text: "off", remember: false) }
            send(event, t)
            return try inForeground(t) {
                _ = try body(.hid, check)
                return ActOutcome(rung: .foreground, detail: d.detail)
            }
        case .privatePath:
            send(event, t)
            CUUserInputGuard.waitForQuiet()
            let restore = focus ? focusWithoutRaise(t) : nil
            defer { restore?() }
            let used = try body(.skyLight) { _, _ in try token.check() }
            if used != .skyLight {
                logOnce("skylight-fallback", "SkyLight posting unavailable; falling back to public pid events")
                return ActOutcome(rung: .processEvents, detail: "the private event path failed, so public events were used")
            }
            return ActOutcome(rung: .privatePath, detail: d.detail)
        case .accessibility, .processEvents:
            send(event, t)
            if focus { syntheticFocus(t) }
            _ = try body(.publicPid) { _, _ in try token.check() }
            return ActOutcome(rung: .processEvents, detail: d.detail)
        }
    }

    /// Rung 4: the window under `point` must be the target's (I1).
    func hitTest(_ point: CGPoint, _ t: CUTarget) throws {
        let sys = self.sys
        try CUHitTest.check(point: point, targetPid: t.pid, appName: t.appName, stack: sys.windowStack(), ownPid: getpid(),
                            bundleId: { sys.bundleId(pid: $0) }, processName: { sys.processName(pid: $0) })
    }

    /// Rung 2's public focus: make the bound window the app's main window (no activation, no raise).
    private func syntheticFocus(_ t: CUTarget) {
        if let w = try? windowElement(t), ax.bool(w, kAXMainAttribute) != true {
            try? ax.set(w, kAXMainAttribute, kCFBooleanTrue)
        }
    }

    /// Rung 3: key focus to the target window without raising it; returns how to hand it back.
    private func focusWithoutRaise(_ t: CUTarget) -> (() -> Void)? {
        guard skyLight.canFocusWithoutRaise else { return nil }
        let frontPid = sys.frontmostPid()
        let frontWid = frontPid.flatMap { ax.element(ax.application($0), kAXFocusedWindowAttribute) }.flatMap { ax.windowID($0) }
        guard skyLight.focusWithoutRaise(pid: t.pid, windowID: t.windowID) else { return nil }
        usleep(50_000)
        guard let fp = frontPid, let fw = frontWid, fp != t.pid else { return nil }
        let sky = skyLight
        let (tp, tw) = (t.pid, t.windowID)
        return { sky.restoreFocus(previousPid: fp, previousWindowID: fw, targetPid: tp, targetWindowID: tw) }
    }

    /// Rung 4: bring the app forward, act with the real pointer, then put the pointer and the user's app back.
    /// Every press, drag step and release is hit-tested by the caller's check.
    private func inForeground<T>(_ t: CUTarget, _ body: () throws -> T) throws -> T {
        let previous = sys.frontmostPid()
        let cursor = sys.cursorLocation()
        _ = sys.activate(pid: t.pid)
        if let w = try? windowElement(t) { try? ax.perform(w, kAXRaiseAction) }
        var front = false
        for _ in 0..<50 {
            if sys.frontmostPid() == t.pid { front = true; break }
            usleep(20_000)
        }
        defer {
            if let c = cursor { sys.warpCursor(to: c) }
            if let prev = previous, prev != t.pid { _ = sys.activate(pid: prev) }
        }
        guard front else { throw CUError.unsupported("could not bring \(t.appName) to the front") }
        return try body()
    }

    // MARK: helpers

    /// An act's own cursor event, held until its input is about to go out.
    struct CursorEvent {
        var kind: String
        var point: CGPoint
        var dragTo: CGPoint? = nil
        var text: String? = nil
        var count: Int? = nil
        var button: String? = nil
    }

    func send(_ e: CursorEvent?, _ t: CUTarget) {
        guard let e else { return }
        cursor(t, e.kind, at: e.point, dragTo: e.dragTo, text: e.text, count: e.count, button: e.button)
    }

    /// Just before an act on a ref: a caption first when the act is a consequential press ("Clicking “Send”"),
    /// then the reticle on the element's frame.
    func announceTarget(_ t: CUTarget, _ info: ElementInfo, pressing: Bool) {
        if pressing, let label = Self.consequentialLabel(info) {
            cursor(t, "caption", at: info.center, text: Self.caption("Clicking", "“\(label)”"))
        }
        guard let frame = info.frame, frame.width > 0 || frame.height > 0 else { return }
        cursor(t, "target", at: info.center ?? CGPoint(x: frame.midX, y: frame.midY), frame: frame)
    }

    /// AX actions that read as a click.
    static let pressLike: Set<String> = [kAXPressAction, "AXOpen", kAXConfirmAction, "AXPick"]

    /// Words that make a press worth a caption (DESIGN-cursor.md, Captions).
    static let consequentialWords: Set<String> = ["send", "delete", "save", "submit", "buy", "pay", "publish", "post"]

    /// The element's own label (title, else description) when it names a consequential action.
    static func consequentialLabel(_ info: ElementInfo) -> String? {
        let label = (info.labels.first ?? nil).flatMap { $0.isEmpty ? nil : $0 } ?? (info.labels.dropFirst().first ?? nil)
        guard let label = label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { return nil }
        let words = label.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .split { !$0.isLetter }.map(String.init)
        return words.contains(where: consequentialWords.contains) ? label : nil
    }

    /// "Clicking “Save”": at most 40 characters, the object cut with an ellipsis.
    static func caption(_ verb: String, _ object: String) -> String {
        let full = "\(verb) \(object)"
        guard full.count > 40 else { return full }
        let room = max(1, 40 - verb.count - 2)
        let quoted = object.hasPrefix("“") && object.hasSuffix("”")
        let inner = quoted ? String(object.dropFirst().dropLast()) : object
        let cut = String(inner.prefix(max(1, room - (quoted ? 2 : 0)))) + "…"
        return "\(verb) \(quoted ? "“\(cut)”" : cut)"
    }

    func secureRefusal() -> CUError {
        CUError.refused(.secureField, "that is a password field — Winter never reads or types into it; ask the user")
    }
}

/// What actions need to know about one element, in one AX round trip plus its action names.
struct ElementInfo {
    var role: String?
    var subrole: String?
    var frame: CGRect?
    var actions: [String]

    /// The field's label, description, placeholder and identifiers (for the payment-field floor).
    var labels: [String?]

    static let attributes: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXTitleAttribute,
        kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXIdentifierAttribute, "AXDOMIdentifier",
    ]

    init(_ e: AXUIElement, _ ax: CUAXBackend) {
        let a = ax.copyMultiple(e, Self.attributes) ?? [:]
        role = a[kAXRoleAttribute].flatMap(AX.stringValue)
        subrole = a[kAXSubroleAttribute].flatMap(AX.stringValue)
        if let p = a[kAXPositionAttribute].flatMap(AX.pointValue), let s = a[kAXSizeAttribute].flatMap(AX.sizeValue) {
            frame = CGRect(origin: p, size: s)
        }
        labels = [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXIdentifierAttribute,
                  "AXDOMIdentifier"].map { a[$0].flatMap(AX.stringValue) }
        actions = ax.actions(e)
    }

    /// A password or payment field (never read, never typed into).
    var secure: Bool { CUFloors.isSensitiveField(role: role ?? "", subrole: subrole, texts: labels) }
    var center: CGPoint? {
        guard let f = frame, f.width > 0 || f.height > 0 else { return nil }
        return CGPoint(x: f.midX, y: f.midY)
    }
}
