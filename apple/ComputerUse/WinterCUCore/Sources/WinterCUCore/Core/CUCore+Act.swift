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
        /// Paths to open in the background once the act has released the target's queue (Finder's Open):
        /// resolved under the queue, opened after it, so a slow launch never holds the target.
        var pendingOpen: [String]? = nil
        /// What the open stands for in the result ("“File › Open”"), when it came from a menu.
        var openWhat: String? = nil
        /// For type, paste, key and setValue: the element that received the input (`[14] text area "Comment"`),
        /// or `inputUnknown` when the app reported no focused element.
        var input: String? = nil
        var inputUnknown = false
        /// The focus moved during the act: where to (`[226] text field “smart search field”`), or lost
        /// (`focusLost`: the app reports none now).
        var focusNow: String? = nil
        var focusLost = false
        /// The act changed the bound window's page: its title now (or URL).
        var pageNow: String? = nil

        /// Puts `note` (what was done to reach the window) in front of the rung's own detail.
        func noting(_ note: String?) -> ActOutcome {
            guard let note else { return self }
            var o = self
            o.detail = [note, detail].compactMap { $0 }.joined(separator: "; ")
            return o
        }
    }

    public func targetAct(_ p: TargetActParams) async throws -> TargetActResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        // Held in front for this script (the user agreed): the foreground rung needs no second asking.
        var p = p
        if holdsForeground(t) { p.allowForeground = true }
        // The call's cancel first: a window watched through a transition (`ensureAlive`) is waited for under it.
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        try await ensureAlive(t, token: token)
        try token.check()
        noteGuardianPrivatePath(p.privatePath)
        noteGuardianActed(t.pid)
        do {
            try Self.checkAccess(p.action, access: p.access, appName: t.appName)
        } catch {
            cursor(t, "refused")
            logAct(p, t, failed: error)
            throw error
        }
        if case .key(let k) = p.action, (try? CUKeyChord.parse(k.combo))?.isEscape == true {
            await MainActor.run { [weak self] in self?.events?.willSendEscape() }
        }
        let acted = try await actWithVisits(p, t, token)
        var outcome = acted.0
        let inVisit = acted.1
        if let paths = outcome.pendingOpen {
            // The queue is released: open now, bounded, and say what happened.
            do {
                let said = try await finishBackgroundOpen(paths, what: outcome.openWhat, t)
                outcome.detail = [outcome.detail, said].compactMap { $0 }.joined(separator: "; ")
            } catch {
                cursor(t, "refused")
                logAct(p, t, failed: error)
                throw error
            }
        }
        noteGuardianActed(t.pid)  // an activation in the next seconds may be this act's doing
        CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): \(Self.routeName(outcome.rung), privacy: .public)\(outcome.detail.map { " — " + $0 } ?? "", privacy: .public)")
        let notes = takeGuardianNotes()
        let detail = (notes + [outcome.detail].compactMap { $0 }).isEmpty ? nil
            : (notes + [outcome.detail].compactMap { $0 }).joined(separator: "; ")
        return TargetActResult(rung: outcome.rung.rawValue, detail: detail, input: outcome.input,
                               inputUnknown: outcome.inputUnknown ? true : nil, focusNow: outcome.focusNow,
                               focusLost: outcome.focusLost ? true : nil, pageNow: outcome.pageNow, inVisit: inVisit ? true : nil)
    }

    /// The act, with desktop visits (CUCore+Visit): inside the session's open visit when its window is on the
    /// visited desktop; else in the background; and when that needs its window's desktop — the session's open visit
    /// (another desktop) is closed first and the act tried again where the user is now (its window may be there:
    /// no prompt), then, still needing it, a visit opened with the user's say (`desktopVisit`) or
    /// `needs_desktop_visit` without it. Returns whether it ran inside a visit.
    func actWithVisits(_ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) async throws -> (ActOutcome, Bool) {
        // Inside the visit the foreground is implied (the app is in front on its own desktop).
        var inner = p
        inner.allowForeground = true
        if let v = openVisit(of: p.sessionId), onVisitedDesktop(v, t),
           let id = beginVisitActivity(v, t, callId: p.callId, maxMs: p.visitMaxMs) {
            defer { endVisitActivity(v, id) }
            do { return (try await queues.run(t.pid) { [self] in try actOnce(inner, t, token, inVisit: true) }, true) }
            catch { throw Self.markedInVisit(error) }
        }
        var lastNeed: Error
        do {
            return (try await queues.run(t.pid) { [self] in try actOnce(p, t, token, inVisit: false) }, false)
        } catch where Self.needsItsDesktop(error) {
            lastNeed = error
        }
        // It needs its window's desktop: never asked for (nor answered) while the session sits on another one.
        if await closeVisit(of: p.sessionId, reason: .otherDesktop) {
            do {
                return (try await queues.run(t.pid) { [self] in try actOnce(p, t, token, inVisit: false) }, false)
            } catch where Self.needsItsDesktop(error) {
                lastNeed = error
            }
        }
        guard p.desktopVisit == true else {
            throw lastNeed is CUVisitNeeded ? CUError.needsDesktopVisit(t.appName, why: .act) : lastNeed
        }
        try token.check()
        let v = try await openDesktopVisit(t, why: .act, privatePath: p.privatePath, sessionId: p.sessionId, callId: p.callId,
                                           maxMs: p.visitMaxMs)
        let id = beginVisitActivity(v, t, callId: p.callId, maxMs: p.visitMaxMs)
        defer { endVisitActivity(v, id) }
        do { return (try await queues.run(t.pid) { [self] in try actOnce(inner, t, token, inVisit: true) }, true) }
        catch { throw Self.markedInVisit(error) }
    }

    /// One attempt at the act on the target's pid queue: the floors, the act under the user-view guard, what it
    /// changed. When it can't land from here and its window is on ANOTHER DESKTOP (it needs the foreground, the
    /// window can't be reached, or the foreground rung found it elsewhere), the user's say decides: without it
    /// `needs_desktop_visit` (nothing was moved); with it (`desktopVisit`), `CUVisitNeeded` — the caller does it
    /// once more inside a visit. `inVisit`: this IS that once more.
    func actOnce(_ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token, inVisit: Bool) throws -> ActOutcome {
        do {
            // A cancel that arrived while this act waited behind others stops it here.
            try token.check()
            try floorCheckPrivacy(t)
            try saveFloorBeforeAct(p, t)
            do {
                let focusBefore = t.accessible ? focusBeforeAct(t) : nil
                let pageBefore = pageBeforeAct(t)
                var o: ActOutcome
                do {
                    o = try guardingUserView(p, t) { try perform(p, on: t, token: token) }
                } catch let e as CUError where !inVisit && Self.visitCouldHelp(e) && isOffThisDesktop(t) {
                    if p.desktopVisit == true {
                        CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): can't land from this desktop (\(e.code, privacy: .public)) — once more inside a desktop visit, as the user allowed")
                        throw CUVisitNeeded()
                    }
                    CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): can't land from this desktop (\(e.code, privacy: .public)) — needs the user's say for a desktop visit")
                    throw e.code == "needs_desktop_visit" ? e : CUError.needsDesktopVisit(
                        t.appName, why: .act, "\(e.message) — a desktop visit would do it (the user taken to that desktop for a moment and brought back)")
                }
                t.lastActionMs = clock.nowMs()
                if let focusBefore { o = noteFocusChange(from: focusBefore, t, o) }
                o = notePageChange(from: pageBefore, t, o)
                return o
            } catch let e as CUError where e.code == "stale_element" {
                if let ref = Self.primaryRef(p.action) { t.refs.forget(ref); throw CUError.staleRef(ref) }
                // The target is still bound; only the element moved under the action.
                throw CUError.busy("the \(t.appName) UI changed under the action — call state() and retry")
            }
        } catch is CUVisitNeeded {
            throw CUVisitNeeded()
        } catch {
            // A refusal or a failure: a gentle "no" where the act was aimed. Not for a cancel (the user
            // or the script stopped it), a target that is gone (its cursor goes with it), or a desktop visit to
            // ask for (nothing was refused).
            if Self.showsRefusal(error) { cursor(t, "refused", at: attemptPoint(p.action, t)) }
            logAct(p, t, failed: error)
            throw error
        }
    }

    /// The focus before an act: the one read after the last act when that is recent (one read per act), else a
    /// fresh read.
    func focusBeforeAct(_ t: CUTarget) -> WindowFocus {
        if let last = t.focusAfterLastAct, clock.nowMs() - last.atMs < 5_000 { return last.focus }
        return windowFocus(t, fresh: true)
    }

    /// After an act: when the bound window's focus changed (⌘R moves it to the address bar, a click into
    /// another field, Tab), the result says where it is now — name and role only — or that it is unknown now.
    func noteFocusChange(from before: WindowFocus, _ t: CUTarget, _ o: ActOutcome) -> ActOutcome {
        var after = windowFocus(t, fresh: true)
        // Not the app's own answer now (its focus handed back with the blip's key focus): the one it gave inside the
        // act's last keyboard blip, after the keys were taken — where they left it (round 4: Tab moved Docs' focus
        // Find → Replace and the result said "unknown").
        if after.source != .app, let seen = blipFocusRead(t, start: false) { after = seen }
        t.focusAfterLastAct = (clock.nowMs(), after)
        var o = o
        switch (before.element, after.element) {
        case (let b?, let a?) where CFEqual(b, a):
            return o
        case (_, let a?):
            o.focusNow = focusWords(a, t)
        case (.some, nil):
            if after.elsewhere != nil { o.focusNow = "outside this window (in another of \(t.appName)'s windows)" } else { o.focusLost = true }
        case (nil, nil):
            return o
        }
        CULog.act.notice("focus in \(t.appName, privacy: .public) moved during the act")
        return o
    }

    /// The act's outcome, naming the element that received its input (type, paste, key, setValue): the model
    /// never has to guess where text went. Nil `e`: the app reported no focused element.
    func receiving(_ e: AXUIElement?, _ t: CUTarget, _ o: ActOutcome) -> ActOutcome {
        var o = o
        guard t.accessible else {
            o.input = "the window (it has no accessibility here)"
            return o
        }
        var e = e
        // The focus the act's first keyboard blip found, before its first key — the app's own answer for the bound
        // window while it held the key focus — when the read before the act had none, or named an element of another
        // window (a native window that is not key answers none of its own; live: "pressed y in [5] B field" for a key
        // that went into Doc A).
        if let seen = blipFocusRead(t, start: true)?.element,
           e == nil || (try? windowElement(t)).map({ inBoundWindow(e!, t, $0) == false }) == true {
            e = seen
        }
        guard let e else {
            o.inputUnknown = true
            return o
        }
        o.input = focusWords(e, t)
        return o
    }

    static func actionName(_ a: CUAction) -> String {
        switch a {
        case .click: return "click"
        case .setValue: return "setValue"
        case .type: return "type"
        case .paste: return "paste"
        case .key: return "key"
        case .scroll: return "scroll"
        case .drag: return "drag"
        case .select: return "select"
        case .action: return "action"
        case .menu: return "menu"
        case .hover: return "hover"
        }
    }

    static func routeName(_ r: CUInputLadder.Rung) -> String {
        switch r {
        case .accessibility: return "AX"
        case .processEvents: return "pid events"
        case .privatePath: return "private path (SkyLight pid events)"
        case .foreground: return "foreground (the real pointer)"
        }
    }

    /// A failed act, by code (and floor reason). The message is left out where it may echo the script's own
    /// text (`invalid_params` quotes what it searched for).
    func logAct(_ p: TargetActParams, _ t: CUTarget, failed error: Error) {
        let e = error as? CUError
        let code = e?.code ?? "error"
        let reason: String = { if case .string(let r)? = e?.data?["reason"] { return " (\(r))" }; return "" }()
        let message = code == "invalid_params" ? "" : " — " + String((e?.message ?? "\(error)").prefix(240))
        CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public) failed: \(code, privacy: .public)\(reason, privacy: .public)\(message, privacy: .public)")
    }

    static func showsRefusal(_ error: Error) -> Bool {
        guard let e = error as? CUError else { return true }
        return e.code != "cancelled" && e.code != "target_lost" && e.code != "needs_desktop_visit"
    }

    /// Where a failed act was aimed: its element's centre, else its point, else the cursor's last place.
    func attemptPoint(_ a: CUAction, _ t: CUTarget) -> CGPoint? {
        if let ref = Self.primaryRef(a), let key = t.refs.key(for: ref), let c = ElementInfo(key.element, ax).center {
            return c
        }
        let pixel: (point: [Double]?, shot: String?)? = {
            switch a {
            case .click(let x): return (x.point, x.shotId)
            case .hover(let x): return (x.point, x.shotId)
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
        case .click, .scroll, .action, .hover: return
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
        case .hover(let x): return x.ref
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
        case .hover(let a): return try hover(a, p, t, token)
        }
    }

    /// The pointer moved onto an element or a point and left there (`ms`, default 600, at most 5 s): the hover
    /// path, window-targeted — the user's cursor never moves — so hover-only UI (menus, tooltips, buttons that
    /// appear or arm on hover) shows; state() then shows what appeared.
    private func hover(_ a: CUHoverAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let ms = Double(min(max(a.ms ?? 600, 0), 5_000))
        let pt: CGPoint
        var label: String?
        if let ref = a.ref {
            guard a.point == nil else { throw CUError.invalidParams("hover takes a ref or a point, not both") }
            let e = try element(ref, in: t)
            let info = ElementInfo(e, ax)
            guard info.center != nil, let c = clickablePoint(e, info, t) else {
                throw CUError.unsupported("[\(ref)] has no position in the window to hover — scroll to it first")
            }
            pt = c
            label = Self.elementLabel(ref, info)
        } else {
            guard let px = try cuPoint(a.point) else { throw CUError.invalidParams("hover needs a ref or a point") }
            pt = try screenPoint(for: t, shotId: a.shotId, pixel: px)
        }
        cursor(t, "caption", text: "Hovering")
        try token.check()
        let rested = "the pointer rested \(label.map { "on \($0)" } ?? "there") for \(Int(ms)) ms (window-targeted — the user's cursor did not move); state() shows what appeared"
        if let subject = offScreenSubject(t) {
            return try eventsElsewhere(p, t, token, cursor: nil, what: "the hover", subject: subject) { synth, route in
                try synth.hover(pid: t.pid, windowFor: { _ in t.windowID }, at: pt, route: route, dwellMs: ms)
            }.noting(rested)
        }
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: true))
        let synth = self.synth(p)
        let windowFor = self.windowFor(t)
        // A WebKit page (not Chromium) never takes a synthetic pointer's hover: measured on 2026-10-10, posted
        // moves reached its window — and a plain AppKit view's tracking areas in the same state — but no
        // mouseenter reached the page, in the background or with its app in front and the window key. Watched
        // here, so the answer says when nothing appeared instead of leaving the model to look.
        let webKit = d.rung == .processEvents && !t.isChromium && t.accessible
            && (a.ref.flatMap { try? element($0, in: t) } ?? elementAt(pt, in: t)).map(isWebContent) == true
        let before = webKit ? webElementCount(t) : nil
        let out = try runEvents(p, t, d, focus: false, token) { route, check in
            try synth.hover(pid: t.pid, windowFor: windowFor, at: pt, route: route, dwellMs: ms, check: check)
        }
        if let before, let after = webElementCount(t), after == before {
            CULog.act.notice("hover in \(t.appName, privacy: .public): nothing new appeared in the page (\(before, privacy: .public) elements)")
            return out.noting("the pointer rested \(label.map { "on \($0)" } ?? "there") for \(Int(ms)) ms, and nothing new appeared in the page — \(t.appName)'s web page takes no hover from a pointer that isn't the real one: if the menu or item also opens on a click, click it; else app.requestForeground(reason) for a real hover")
        }
        return out.noting(rested)
    }

    /// How many elements accessibility shows in the bound window's web page — the cheap "did anything appear"
    /// fingerprint around a hover. Nil when it has none, or when the walk was cut short (`hoverFingerprintMaxNodes`,
    /// or 200 ms): a capped count is the same before and after whatever appeared, so it proves nothing either way.
    func webElementCount(_ t: CUTarget, maxMs: Double = 200) -> Int? {
        guard let win = try? windowElement(t), let area = firstWebArea(win) else { return nil }
        let deadline = clock.nowMs() + maxMs
        var queue = [area]
        var next = 0
        while next < queue.count {
            guard next < hoverFingerprintMaxNodes, clock.nowMs() < deadline else { return nil }
            queue.append(contentsOf: ax.elements(queue[next], kAXChildrenAttribute))
            next += 1
        }
        return next
    }

    /// An AX action or write that timed out may still run later: never follow it with events (that would do
    /// it twice). The script observes and decides.
    static func deliveryUncertain(_ e: Error) -> Bool { (e as? CUError)?.code == "busy" }

    func busyAfterSend(_ t: CUTarget) -> CUError {
        CUError.uncertain("\(t.appName) did not confirm the action in time — it may still happen; call state() before retrying")
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
            // A page's hidden text input (zero-size or off the window, standing in for a document drawn on a
            // canvas): there is nothing there to click — said, with what does work, instead of "scroll to it".
            if hiddenInputWords(e, t) != nil {
                CULog.act.notice("click in \(t.appName, privacy: .public): [\(ref, privacy: .public)] is the page's hidden text input — not clicked")
                throw CUError.unsupported("[\(ref)] is the page's hidden text input (it types into the document): it has no place on screen to click — type or paste into it with type(text, { into: \(ref) }) or paste(text, { into: \(ref) }); to put the caret somewhere in the document, click the document's text where you want it")
            }
            // A disabled control does nothing when PRESSED; its context menu (a right click) may still open.
            if button == .left { try requireEnabled(info, ref: ref, t) }
            try pasteMenuGuard(e, info, p, t)
            t.noteTargeted(e, at: clock.nowMs())
            announceTarget(t, info, pressing: button == .left)
            var announced = false
            let webPress = button == .left && count == 1 && flags.isEmpty && isWebContent(e)
            // An app whose web content ignored accessibility presses twice: its web buttons are clicked.
            if webPress, info.actions.contains(kAXPressAction), prefersWebClicks(t) {
                cursor(t, "press", at: info.center, count: 1, button: button.rawValue)
                CULog.act.notice("click in \(t.appName, privacy: .public): its web content ignores accessibility presses — a window-targeted click")
                return try clickWebElement(e, info, ref: ref, p, t, token, pressIgnored: false,
                                           why: "\(t.appName)'s web page ignores accessibility presses")
            }
            if count == 1, flags.isEmpty {
                let axAction: String? = button == .left && info.actions.contains(kAXPressAction) ? kAXPressAction
                    : button == .left && info.actions.contains(kAXPickAction) ? kAXPickAction
                    : button == .right && info.actions.contains(kAXShowMenuAction) ? kAXShowMenuAction : nil
                if let axAction {
                    cursor(t, "press", at: info.center, count: 1, button: button.rawValue)
                    announced = true
                    try token.check()
                    let before = pressEvidence(e, t)
                    let webBefore = webPress && axAction == kAXPressAction ? webPressEvidence(e, t) : nil
                    // Its pixels before the press (on screen only): a press whose effect accessibility can't see may
                    // still show it, and a click after it would do it twice.
                    let crop = webBefore != nil ? pressCrop(e, info, t) : nil
                    let shotBefore = crop.flatMap { pressShot($0, t) }
                    do {
                        try ax.perform(e, axAction)
                        if let webBefore {
                            return try verifyWebPress(e, info, ref: ref, before: webBefore, crop: crop, shotBefore: shotBefore, p, t, token)
                        }
                        return ActOutcome(rung: .accessibility)
                    } catch let error where Self.pressMayHaveActed(error) != nil {
                        // Never fall through to a click here: the press may have acted, and a click would repeat it.
                        let note = try judgeErroredPress(e, t, before: before, code: Self.pressMayHaveActed(error)!,
                                                         what: "the press on [\(ref)]")
                        return ActOutcome(rung: .accessibility, detail: note)
                    } catch let err as CUError where err.code == "stale_element" || err.code == "permission_missing" {
                        throw err
                    } catch {
                        // The element refused the action outright: fall through to events at its centre.
                    }
                }
            }
            guard info.center != nil else {
                throw CUError.unsupported("[\(ref)] has no position on screen — try action() or a screenshot point")
            }
            guard let center = clickablePoint(e, info, t) else {
                throw CUError.unsupported("[\(ref)] is outside the window and could not be scrolled into view — scroll to it first")
            }
            return try pointerClick(p, t, at: center, button: button, count: count, flags: flags, token, announced: announced,
                                    element: e, axTried: announced)
        }
        guard let px = try cuPoint(a.point) else { throw CUError.invalidParams("click needs a ref or a point") }
        let pt = try screenPoint(for: t, shotId: a.shotId, pixel: px)
        return try pointerClick(p, t, at: pt, button: button, count: count, flags: flags, token)
    }

    /// `announced`: the cursor already showed this press (an AX attempt that fell back to events). `element`:
    /// the element the click is for, when a ref named it.
    /// `axTried`: the caller already tried the AX action and the app refused it.
    private func pointerClick(_ p: TargetActParams, _ t: CUTarget, at pt: CGPoint, button: CUMouseButton, count: Int,
                              flags: CGEventFlags, _ token: CUCancellation.Token, announced: Bool = false,
                              element: AXUIElement? = nil, axTried: Bool = false) throws -> ActOutcome {
        if let subject = offScreenSubject(t) {
            return try clickElsewhere(p, t, at: pt, button: button, count: count, flags: flags, token,
                                      announced: announced, element: element, axTried: axTried, subject: subject)
        }
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: true))
        let synth = self.synth(p)
        let windowFor = self.windowFor(t)
        let event = announced ? nil : CursorEvent(kind: "press", point: pt, count: count, button: button.rawValue)
        // Pid events in the background: the window made its app's key window first, so the click is not taken
        // as the one that makes it key.
        if d.rung == .processEvents, keyForClick(t, privatePath: p.privatePath, clickWindow: windowFor(pt)) == .appInFront {
            throw clickRefusal(t)
        }
        return try runEvents(p, t, d, focus: true, token, cursor: event) { route, check in
            try synth.click(pid: t.pid, windowFor: windowFor, at: pt, button: button, count: count, flags: flags,
                            route: route, check: check)
        }
    }

    /// The bound window is not on screen: "X's window is on another desktop" (another Space, full screen) or
    /// "… is off screen" (minimized, or off stage in Stage Manager) — the subject of the act's words. Pointer
    /// input there takes the same routes either way: AX first, window-targeted events last. It is never brought
    /// on screen for an act (un-minimizing or adding it to the stage activates the app and moves the user's
    /// view); nil when it is on screen.
    func offScreenSubject(_ t: CUTarget) -> String? {
        guard sys.window(id: t.windowID)?.onScreen == false else { return nil }
        return isOffThisDesktop(t) ? "\(t.appName)'s window is on another desktop"
            : "\(t.appName)'s window is off screen (minimized, or off stage in Stage Manager)"
    }

    /// How a click reaches a window on another desktop (another Space or display). AX first:
    /// helper can only do there too: a LISTED action (press, show menu, open); else, for a plain left or right
    /// click on an element, the action unlisted (web content often leaves press out), then the nearest
    /// ancestor that lists it. Window-targeted pid events are the last attempt — for a canvas (no element),
    /// modifier and middle clicks, a double click with no open, or an element that refused every AX try.
    /// Off screen, window-targeted events may or may not land: nothing confirms them. Pure.
    enum ElsewhereClick: Equatable {
        case ax(String)
        case axUnlisted(String)
        case events
    }

    static func elsewhereClickRoute(button: CUMouseButton, count: Int, modified: Bool, actions: [String]?) -> ElsewhereClick {
        guard !modified, button != .middle, let actions else { return .events }
        switch (button, count) {
        case (.right, _): return actions.contains(kAXShowMenuAction) ? .ax(kAXShowMenuAction) : .axUnlisted(kAXShowMenuAction)
        case (.left, let n) where n >= 2: return actions.contains("AXOpen") ? .ax("AXOpen") : .events
        default:
            if actions.contains(kAXPressAction) { return .ax(kAXPressAction) }
            if actions.contains(kAXPickAction) { return .ax(kAXPickAction) }
            return .axUnlisted(kAXPressAction)
        }
    }

    private func clickElsewhere(_ p: TargetActParams, _ t: CUTarget, at pt: CGPoint, button: CUMouseButton, count: Int,
                                flags: CGEventFlags, _ token: CUCancellation.Token, announced: Bool,
                                element: AXUIElement?, axTried: Bool, subject: String) throws -> ActOutcome {
        let modified = !flags.isEmpty
        let target = element ?? (modified || button == .middle ? nil : elementAt(pt, in: t))
        let route = axTried ? .events
            : Self.elsewhereClickRoute(button: button, count: count, modified: modified, actions: target.map { ax.actions($0) })
        if !announced { cursor(t, "press", at: pt, count: count, button: button.rawValue) }
        try token.check()
        if let target {
            let tries: [AXUIElement]
            let action: String?
            switch route {
            case .ax(let a): (tries, action) = ([target], a)
            case .axUnlisted(let a): (tries, action) = (Self.selfThenListingAncestors(target, a, ax), a)
            case .events: (tries, action) = ([], nil)
            }
            if let action {
                for el in tries {
                    let before = pressEvidence(el, t)
                    let webBefore = action == kAXPressAction && isWebContent(el) ? webPressEvidence(el, t) : nil
                    do {
                        try ax.perform(el, action)
                        CULog.act.notice("click in \(t.appName, privacy: .public) (off screen): AX \(action, privacy: .public)")
                        if let webBefore, !webPressChanged(el, t, since: webBefore) {
                            // Web content that acts on a real mouse press (Google Docs' widgets) ignores the
                            // accessibility press. Off screen its pixels may be stale, so the window-targeted click
                            // below only for an app LEARNED to ignore presses (a click there once had an effect
                            // accessibility saw), and never where a repeat could do harm.
                            let info = ElementInfo(el, ax)
                            if Self.mayActUnseen(info.labels) {
                                return ActOutcome(rung: .accessibility, detail: "\(subject), so the element was sent a press over accessibility; \(Self.unseenPressNote(Self.elementLabel(nil, info)))")
                            }
                            if !prefersWebClicks(t) || statefulWithoutReadableState(el, info) {
                                CULog.act.notice("click in \(t.appName, privacy: .public) (off screen): no visible effect — not clicked as well")
                                return ActOutcome(rung: .accessibility, detail: "\(subject), so the element was sent a press over accessibility; \(Self.noEffectNote(Self.elementLabel(nil, info)))")
                            }
                            CULog.act.notice("click in \(t.appName, privacy: .public) (off screen): the accessibility press changed nothing — clicking instead")
                            return try webClickVerified(el, t, pressIgnored: true, why: "the accessibility press did nothing", label: Self.elementLabel(nil, info)) {
                                try eventsElsewhere(p, t, token, cursor: nil, what: "the click", subject: subject) { synth, route in
                                    try synth.click(pid: t.pid, windowFor: { _ in t.windowID }, at: pt, button: button, count: count, flags: flags, route: route)
                                }
                            }
                        }
                        return ActOutcome(rung: .accessibility,
                                          detail: "\(subject), so the element was sent \(CURoleWords.actionWords(action)) over accessibility")
                    } catch let error where Self.pressMayHaveActed(error) != nil {
                        // Not the next ancestor, not events: the press may have acted.
                        let note = try judgeErroredPress(el, t, before: before, code: Self.pressMayHaveActed(error)!,
                                                         what: CURoleWords.actionWords(action))
                        return ActOutcome(rung: .accessibility, detail: "\(subject), so the element was sent \(CURoleWords.actionWords(action)) over accessibility; \(note)")
                    } catch let err as CUError where err.code == "stale_element" || err.code == "permission_missing" {
                        throw err
                    } catch {
                        continue  // refused: the next, then the events below
                    }
                }
            }
        }
        return try eventsElsewhere(p, t, token, cursor: nil, what: "the click", subject: subject) { synth, route in
            try synth.click(pid: t.pid, windowFor: { _ in t.windowID }, at: pt, button: button, count: count, flags: flags, route: route)
        }
    }

    /// `e`, then up to four ancestors that list `action`.
    static func selfThenListingAncestors(_ e: AXUIElement, _ action: String, _ ax: CUAXBackend) -> [AXUIElement] {
        var out = [e]
        var cur = ax.element(e, kAXParentAttribute)
        for _ in 0..<4 {
            guard let c = cur else { break }
            if ax.actions(c).contains(action) { out.append(c) }
            cur = ax.element(c, kAXParentAttribute)
        }
        return out
    }

    /// Input to a window on another desktop as window-targeted pid events (fields 91
    /// and 92 and the window-local location; SkyLight's post for Chromium-class apps, whose renderers drop
    /// the public route's events). No focus change, no activation, no pointer. Nothing confirms the events
    /// landed on a window that is not on screen, so the outcome says so: the state after the act shows it.
    func eventsElsewhere(_ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token, cursor event: CursorEvent?,
                         what: String, subject: String, _ body: (CUEventSynth, CURoute) throws -> CURoute) throws -> ActOutcome {
        // Addressing a window that is not on screen takes its local point (CGEventSetWindowLocation): with the
        // private event path off, or the setter missing, there is nothing to try.
        guard p.privatePath, skyLight.canSetWindowLocation else {
            CULog.act.notice("\(what, privacy: .public) in \(t.appName, privacy: .public) (off screen): refused — no window-targeted route")
            throw CUError.windowElsewhere(t.appName, sending: what, subject: subject)
        }
        let route: CURoute = t.isChromium && skyLight.isAvailable ? .skyLight : .publicPid
        let isClick = what == "the click"
        let wasKey = isClick ? keyFocusPidForTarget(t) == t.pid : true
        enforceFocus(p, t)  // believe-active first: an inactive window takes a click as activation only
        send(event, t)
        try token.check()
        let used = try body(synth(p), route)
        // A first click on an inactive window can be swallowed as "activate the window" and never reach the UI.
        // If the window was not key before and is key now, the first click only made it key: resend it once.
        var resent = false
        if isClick, !wasKey, keyFocusPidForTarget(t) == t.pid {
            CULog.act.notice("click in \(t.appName, privacy: .public) (off screen): the window was not key — it likely took the first click as activation; resending once")
            _ = try body(synth(p), route)
            resent = true
        }
        let routeName = used == .skyLight ? "window-targeted SkyLight pid events" : "window-targeted pid events"
        CULog.act.notice("\(what, privacy: .public) in \(t.appName, privacy: .public) (off screen): \(routeName, privacy: .public)")
        return ActOutcome(rung: used == .skyLight ? .privatePath : .processEvents,
                          detail: "\(subject): \(what) was sent to that window as \(routeName)\(resent ? " (resent once — the first click only made the window key)" : ""); whether it landed can't be confirmed there — check the state")
    }

    /// Where a pointer click on `e` goes: its centre, or — when that lies outside the window (scrolled out
    /// of view) — its centre after `AXScrollToVisible`; nil when it stays outside (the
    /// `cannotClickOffscreenElement`). An event aimed outside the window would land on something else.
    func clickablePoint(_ e: AXUIElement, _ info: ElementInfo, _ t: CUTarget) -> CGPoint? {
        guard let c = info.center else { return nil }
        guard let window = sys.window(id: t.windowID)?.frame, !window.contains(c) else { return c }
        guard (try? ax.perform(e, "AXScrollToVisible")) != nil else { return nil }
        let deadline = clock.nowMs() + 300
        repeat {
            if let moved = ElementInfo(e, ax).center, window.contains(moved) { return moved }
            usleep(30_000)
        } while clock.nowMs() < deadline
        return nil
    }

    /// Roles that take a click: the hit test climbs from the deepest element at the point to the first of these
    /// (or anything listing press / open / show menu).
    static let clickableRoles: Set<String> = [
        "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuButton", "AXPopUpButton", "AXCell",
        "AXRow", "AXTab", "AXDisclosureTriangle", "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
        "AXImage", "AXSwitch", "AXToggle", "AXIncrementor", "AXSlider", "AXColorWell", "AXDateField",
    ]

    /// The element a click at `point` (screen points) lands on, from a fresh read of the bound window's AX tree
    /// (a cached state may be stale after a scroll): the deepest element whose frame holds the point, climbing to
    /// the nearest one that takes a click. Pure over the tree; nil when nothing there does.
    static func clickTarget(at point: CGPoint, in roots: [CUNode]) -> CUNode? {
        func path(_ n: CUNode) -> [CUNode]? {
            guard let f = n.frame, f.width > 0, f.height > 0, f.contains(point) else {
                // A node without geometry (a group) may still hold children that have it.
                if n.frame == nil || n.frame?.isEmpty == true {
                    for c in n.children.reversed() { if let sub = path(c) { return [n] + sub } }
                }
                return nil
            }
            for c in n.children.reversed() { if let sub = path(c) { return [n] + sub } }  // last drawn is on top
            return [n]
        }
        for r in roots.reversed() {
            guard let chain = path(r) else { continue }
            return chain.reversed().first { n in
                !n.states.contains(.disabled) && (clickableRoles.contains(n.role)
                    || n.actions.contains(kAXPressAction) || n.actions.contains("AXOpen") || n.actions.contains(kAXShowMenuAction))
            }
        }
        return nil
    }

    /// `clickTarget` over a fresh, bounded read of the bound window (refs are kept: nothing ages out).
    func elementAt(_ point: CGPoint, in t: CUTarget) -> AXUIElement? {
        let roots: [CUNode]
        if let read = treeReadOverride {
            roots = read(t)
        } else {
            guard let win = try? windowElement(t) else { return nil }
            var reader = AXTreeReader()
            reader.timeBudgetMs = 1500
            roots = reader.read(roots: [win], cache: t.refs, now: clock.nowMs).roots
        }
        guard let node = Self.clickTarget(at: point, in: roots), let key = t.refs.key(for: node.ref) else { return nil }
        return key.element
    }

    /// A screenshot pixel of this target (`shotId`, else its latest shot) → global screen points.
    func screenPoint(for t: CUTarget, shotId: String?, pixel: CGPoint) throws -> CGPoint {
        let shot = try t.shot(shotId)
        switch shot.anchor {
        case .window(let wid, _):
            guard let w = sys.window(id: wid) else { throw CUError.targetLost("that screenshot's window is gone", reason: lostReason(t)) }
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
        /// The last reported focus found not sensitive: the per-character check reads the focus again but
        /// re-inspects only a different element.
        var checkedClear: AXUIElement?
        init(explicit: AXUIElement? = nil) { self.explicit = explicit }
    }

    /// The focus the app reports, else the one the bound window reports.
    /// The ONE focus resolver every keyboard path uses: the bound window's own focus (`windowFocus` — an app
    /// answers its focused element for its KEY window only, so an app-global read could name another window's
    /// field: live, find() and type() disagreed). A capture-only window has no tree of its own: the app's answer.
    func reportedFocus(_ t: CUTarget) -> AXUIElement? {
        guard t.accessible else { return ax.focusedElement(pid: t.pid) }
        return windowFocus(t, fresh: true).element
    }

    /// Where typed text goes, or a refusal (C1). A focus the app or window reports is refused only when it is
    /// a password or payment field (`secure_field`). An unreported focus (Electron apps often report none) is
    /// allowed when a scan of the window finds no such field — the text then goes to whatever has the focus,
    /// best known as the window's one `AXFocused` element or the element the script just clicked or named;
    /// otherwise it is refused as `focus_unknown`, unless `into` named the field and no tab or return has
    /// been typed since. Returns nil when the focus is unknown but allowed.
    @discardableResult
    func requireTypableFocus(_ t: CUTarget, _ g: TypingFocus = TypingFocus()) throws -> AXUIElement? {
        let f = try typableFocusChecked(t, g)
        // Capture-only: the app's reported focus may be an element of ANOTHER window — checked (a password
        // field still refuses), never typed or inserted into.
        return t.accessible ? f : nil
    }

    private func typableFocusChecked(_ t: CUTarget, _ g: TypingFocus) throws -> AXUIElement? {
        if let f = reportedFocus(t) {
            if let c = g.checkedClear, CFEqual(c, f) { return f }
            if ElementInfo(f, ax).secure { throw secureRefusal() }
            g.checkedClear = f
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
        enforceFocus(p, t)
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e, ax)
        if info.secure { throw secureRefusal() }
        try CUFloorScan.checkTypedIntoSavePanel(e, text: a.value, pid: t.pid, ax: ax)
        t.noteTargeted(e, at: clock.nowMs())
        announceTarget(t, info, pressing: false)
        cursor(t, "type", at: info.center)
        try token.check()
        if ax.isSettable(e, kAXValueAttribute) {
            // A scroll bar, slider or stepper holds a NUMBER: the text "0.5" is an illegal argument to it.
            let current = ax.attribute(e, kAXValueAttribute)
            let numeric = current.map { CFGetTypeID($0) == CFNumberGetTypeID() } ?? false
                || [kAXScrollBarRole, kAXSliderRole, kAXIncrementorRole].contains(info.role ?? "")
            let value: CFTypeRef
            if numeric {
                guard let n = Double(a.value.trimmingCharacters(in: .whitespaces)) else {
                    throw CUError.invalidParams("[\(a.ref)] holds a number — pass one, e.g. setValue(\(a.ref), \"0.5\")")
                }
                if info.role == kAXScrollBarRole, !(0...1).contains(n) {
                    throw CUError.invalidParams("a scroll bar's value runs from 0 (top or left) to 1 (bottom or right) — got \(a.value)")
                }
                value = NSNumber(value: n)
            } else {
                value = a.value as CFString
            }
            do {
                try ax.set(e, kAXValueAttribute, value)
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
            } catch let error as CUError where info.role == kAXScrollBarRole && error.code == "invalid_params" {
                throw CUError.unsupported("\(t.appName)'s scroll bar [\(a.ref)] won't take a value — scroll its area with scroll() instead")
            }
            return receiving(e, t, ActOutcome(rung: .accessibility))
        }
        // Not settable: focus it, select everything, and type over it — never over another field.
        let g = TypingFocus(explicit: e)
        try placeFocus(e, t, ref: a.ref)
        if let len = textLength(e, t), ax.isSettable(e, kAXSelectedTextRangeAttribute),
           let r = AX.makeRange(location: 0, length: len) {
            try? ax.set(e, kAXSelectedTextRangeAttribute, r)
        } else {
            try requireTypableFocus(t, g)
            _ = try sendChord(CUKeyChord(key: .character("a"), modifiers: [.command]), p, t, token, g)
        }
        return receiving(e, t, try typeText(a.value, into: e, p, t, token, g))
    }

    private func type(_ a: CUTypeAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        enforceFocus(p, t)  // believe-active before any focus write, so the app does not activate itself
        let (e, g) = try textTarget(into: a.into, t, text: a.text)
        cursor(t, "type", at: e.flatMap { ElementInfo($0, ax).center })
        return receiving(e, t, try typeText(a.text, into: e, p, t, token, g))
    }

    private func paste(_ a: CUPasteAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        enforceFocus(p, t)
        let (e, g) = try textTarget(into: a.into, t, text: a.text)
        cursor(t, "type", at: e.flatMap { ElementInfo($0, ax).center })
        return receiving(e, t, try pasteText(a.text, format: a.format ?? .text, p, t, token, g))
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
            try placeFocus(el, t, ref: into)
            t.noteTargeted(el, at: clock.nowMs())
            g.explicit = el
            e = el
        } else {
            // The bound window's own focus (an app answers for its key window only): where the keys go once its
            // window holds the key focus. The floors as for any focus; then the guards for unnamed targets.
            let wf = windowFocus(t, fresh: true)
            if let w = wf.element, wf.source != .app {
                if ElementInfo(w, ax).secure { throw secureRefusal() }
                e = w
            } else {
                e = try requireTypableFocus(t, g)
            }
            // Never into another window of the app (live: an insert went to the user's window's address field).
            if let e, t.accessible, let win = try? windowElement(t), inBoundWindow(e, t, win) == false {
                CULog.act.notice("type in \(t.appName, privacy: .public): the focus is in another of its windows — refused")
                throw CUError.refused(.focusUnknown, "the focus in \(t.appName) is in another of its windows, not the bound one, so nothing was typed — click the field in the bound window first, or pass { into }")
            }
            try guardUnnamedTarget(e, wf, text: text, t)
        }
        try CUFloorScan.checkTypedIntoSavePanel(e, text: text, pid: t.pid, ax: ax)
        return (e, g)
    }

    /// AX insert at the selection (confirmed by polling) → paste for long or multi-line text → per-key events.
    private func typeText(_ text: String, into e: AXUIElement?, _ p: TargetActParams, _ t: CUTarget,
                          _ token: CUCancellation.Token, _ g: TypingFocus) throws -> ActOutcome {
        guard !text.isEmpty else { return ActOutcome(rung: .accessibility, detail: "nothing to type") }
        try token.check()
        // A Tab in the text moves the focus as a person's would: keys, never an insert (measured 2026-10-11 on a
        // probe app of ours: an insert of "hi\t" put a literal tab into the field and left the focus where it was).
        if let e, !text.contains("\t"), ax.isSettable(e, kAXSelectedTextAttribute) {
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
                // Chromium and WebKit apply the edit asynchronously: wait for it before deciding it failed, or
                // the fallback would type it a second time. The proof is the TEXT in the value read back — a
                // value-change notification alone is not (Google Docs' title took the insert, notified, and
                // reverted it).
                let web = t.isChromium || isWebContent(e)
                // Web content applies an edit late: watched for longer, since typing after an insert that did land
                // would put the text in twice.
                let verdict = waitForInsert(e, text, before: before, capMs: web ? 800 : 150)
                CULog.act.notice("type in \(t.appName, privacy: .public): AX insert \(verdict == .landed ? "landed" : verdict == .missing ? "missing" : "unreadable", privacy: .public) (web \(web, privacy: .public))")
                switch verdict {
                case .landed:
                    return ActOutcome(rung: .accessibility, detail: "received: verified (inserted over accessibility; the field holds it)")
                case .unreadable where !web:
                    // Nothing to read it back by: not typed again, and said so.
                    return ActOutcome(rung: .accessibility, detail: "received: unverifiable — inserted over accessibility, and the field can't be read back")
                case .unreadable:
                    // Applied, and nothing to read it back by: typing it as well could put it in twice. Said, not
                    // repeated.
                    CULog.act.notice("type in \(t.appName, privacy: .public): the accessibility insert can't be read back — not typed again")
                    return ActOutcome(rung: .accessibility, detail: "received: unverifiable — inserted over accessibility, but the field can't be read back, so it was not typed again; check state() before typing it again")
                default:
                    _ = since
                    CULog.act.notice("type in \(t.appName, privacy: .public): the accessibility insert did not stick — typing keys")
                }
            }
        }
        // Long or multi-line text: no SILENT switch to a paste (live: a 2,000-character type() became a paste that
        // never landed, and the result said "typed"). Into a field that shows its text, a paste — and the result
        // says "sent as a paste"; into an editor that can't be read back, keys (Return for each newline), so what is
        // sent is what a person types.
        let readable = e.map { readsBack($0, t) } ?? false
        if text.contains("\n") || text.count > Self.typeKeysMax, readable || !text.contains("\n") {
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
            CULog.act.notice("type in \(t.appName, privacy: .public): \(text.count, privacy: .public) characters sent as a paste")
            let why = lines > 1 ? "several lines go as a paste into a field that reads them back"
                : readable ? "more than \(Self.typeKeysMax) characters go as a paste into a field that reads them back"
                : "more than \(Self.typeKeysMax) characters go as a paste; this field can't be read back"
            return try pasteText(text, format: .text, p, t, token, g).noting("as a paste (\(why))")
        }
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: false))
        let synth = self.synth(p)
        let chars = Array(text)
        var sent = 0
        let keyPid = keyboardTarget(t, focused: e)
        let valueBefore = e.flatMap { ax.string($0, kAXValueAttribute) }
        // Watched for the focus leaving the field: only when it starts in it, and until a Tab (or a Return that
        // moves it) — those move the focus on purpose.
        var watchFocus = e.flatMap { e in reportedFocus(t).map { sameFocus($0, e) } } ?? false
        // The keys reach the app only while its window holds the key focus: the focus blip, per burst.
        let blips = CUKeyBlips(self, p, t, why: "typing")
        defer { blips.end() }
        let started = clock.nowMs()
        let typed = try typingProgress(chars.count, sent: { sent }, t) {
            try runEvents(p, t, d, focus: true, token) { [self] route, _ in
                try synth.type(pid: keyPid, text: text, route: route, between: {
                    // Before EVERY character: not cancelled, still running, and focus still on a typable,
                    // non-sensitive field — a tab or return may just have moved it to a password field.
                    try token.check()
                    try blips.before()
                    guard sys.appRunning(t.pid) else { throw CUError.targetLost("\(t.appName) quit while typing", reason: .appQuit) }
                    if sent > 0, chars[sent - 1] == "\t" || chars[sent - 1].isNewline { g.focusMayHaveMoved = true }
                    let now = try requireTypableFocus(t, g)
                    // The focus left the field it was typing into (a page that takes a chord as its shortcut, a field
                    // that commits and blurs partway): nothing more goes out — the rest would land elsewhere.
                    if watchFocus, let e, let now, !sameFocus(now, e) {
                        let last = sent > 0 ? chars[sent - 1] : nil
                        if last == "\t" || last?.isNewline == true {
                            watchFocus = false  // moved on purpose
                        } else {
                            throw focusMovedRefusal(from: e, to: now, chars: chars, sent: sent, t)
                        }
                    }
                }, posted: { sent = $0 })
            }
        }
        logTypingRate(t, chars: chars.count, since: started, what: "type")
        // An editor that hides its text (Google Docs' canvas: its input target reads as zero-width filler, and a
        // window on another Space may not be redrawn, so a screenshot is no proof either): say so, with what the
        // input target's before/after does show — never leave the model to guess from a stale picture.
        if let e, !readsBack(e, t, value: valueBefore) {
            let after = ax.string(e, kAXValueAttribute)
            let moved = after != nil && after != valueBefore
            CULog.act.notice("type in \(t.appName, privacy: .public): the editor hides its text — input target \(moved ? "changed" : "unchanged", privacy: .public)")
            return typed.noting("received: unverifiable — \(t.appName) doesn't expose this editor's text to accessibility, so it can't be read back here\(moved ? " (its input target changed, so keys arrived)" : "") — check with something the app shows, such as its word count, or a screenshot while its window is on screen")
        }
        // A field that shows its text is ALWAYS read back: what was sent vs what it now holds.
        if let e, let before = valueBefore {
            let received = receivedVerdict(e, typed: text, before: before, capMs: keyPid != t.pid || isWebContent(e) ? 400 : 150)
            CULog.act.notice("type in \(t.appName, privacy: .public): sent \(chars.count, privacy: .public), received \(received.word, privacy: .public)")
            return typed.noting("received: \(received.words)")
        }
        return typed.noting("received: unverifiable (no field to read it back from)")
    }

    /// "typed N of M characters; then the focus moved to [x] (after “…”)" — the counts in the sentence itself.
    func focusMovedRefusal(from e: AXUIElement, to now: AXUIElement, chars: [Character], sent: Int, _ t: CUTarget) -> CUError {
        let after = sent > 0 ? String(chars[max(0, sent - 12)..<sent]) : ""
        CULog.act.notice("type in \(t.appName, privacy: .public): the focus left the field after \(sent, privacy: .public) of \(chars.count, privacy: .public) characters")
        var err = CUError.refused(.focusMoved, "typed \(sent) of \(chars.count) characters; then the focus moved from \(focusWords(e, t)) to \(focusWords(now, t))\(after.isEmpty ? "" : " (after \u{201C}\(after)\u{201D})"), so the rest was not sent — check state(), then type the rest with { into }")
        var data = err.data ?? [:]
        data["typed"] = .number(Double(sent))
        data["total"] = .number(Double(chars.count))
        err.data = data
        return err
    }

    struct Received { var word: String; var words: String }

    /// What a readable field received of `typed`: verified (it holds all of it, once more than before), partly (the
    /// longest leading part of it now there, M of N), or nothing.
    func receivedVerdict(_ e: AXUIElement, typed: String, before: String, capMs: Double) -> Received {
        let want = CUEditEvidence.normalized(typed)
        if want.isEmpty { return Received(word: "unverifiable", words: "unverifiable (only whitespace was typed, which can't be told apart in the field)") }
        let was = CUEditEvidence.normalized(before)
        let deadline = clock.nowMs() + capMs
        var now = was
        repeat {
            now = CUEditEvidence.normalized(ax.string(e, kAXValueAttribute) ?? "")
            if CUEditEvidence.occurrences(of: want, in: now) > CUEditEvidence.occurrences(of: want, in: was) {
                return Received(word: "verified", words: "verified (the field holds it)")
            }
            if clock.nowMs() >= deadline { break }
            usleep(30_000)
        } while true
        // The longest leading part that arrived, counted in the characters that were sent (binary search over its
        // length; a part that is only whitespace counts as there).
        let chars = Array(typed)
        func arrived(_ k: Int) -> Bool {
            let part = CUEditEvidence.normalized(String(chars[0..<k]))
            return part.isEmpty || CUEditEvidence.occurrences(of: part, in: now) > CUEditEvidence.occurrences(of: part, in: was)
        }
        var lo = 0, hi = chars.count
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if arrived(mid) { lo = mid } else { hi = mid - 1 }
        }
        if lo > 0, CUEditEvidence.normalized(String(chars[0..<lo])).isEmpty { lo = 0 }
        if lo == 0 { return Received(word: "nothing", words: "none of it — the field does not show it; check state() before typing again") }
        return Received(word: "partly", words: "partly (the field holds the first \(lo) of \(chars.count) characters; the rest differs or is missing) — check state() before typing again")
    }

    /// `a` and `b` are the same element, one lies inside the other (a contenteditable's own children), or both
    /// lie in the same editable element (a web editor re-reports its focused leaf as the caret moves).
    func sameFocus(_ a: AXUIElement, _ b: AXUIElement) -> Bool {
        if CFEqual(a, b) { return true }
        if let ea = ax.element(a, "AXEditableAncestor"), let eb = ax.element(b, "AXEditableAncestor"), CFEqual(ea, eb) { return true }
        for (x, y) in [(a, b), (b, a)] {
            var cur = ax.element(x, kAXParentAttribute)
            for _ in 0..<12 {
                guard let c = cur else { break }
                if CFEqual(c, y) { return true }
                cur = ax.element(c, kAXParentAttribute)
            }
        }
        return false
    }

    /// A value that shows text: not nil-like zero-width filler (Google Docs' body reads as "\u{200B}\u{200B}"
    /// whatever it holds). An empty value shows text — a paste into it changes it.
    /// The element shows its text, so what was typed or pasted into it can be read back: it has a value that is
    /// not only zero-width filler, and it is not a page's hidden input standing in for a document (one that
    /// empties itself after every input reads as an empty field, but its text goes elsewhere).
    func readsBack(_ e: AXUIElement, _ t: CUTarget, value: String?? = .none) -> Bool {
        let v: String? = value ?? ax.string(e, kAXValueAttribute)
        guard let v, Self.showsText(v) else { return false }
        return hiddenInputWords(e, t) == nil
    }

    static func showsText(_ value: String) -> Bool {
        value.isEmpty || value.unicodeScalars.contains { !["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}", "\u{2060}", "\u{00AD}"].contains($0) }
    }

    /// Up to this many characters are typed as keys (one real key per character); longer or multi-line text is
    /// pasted. A paste needs evidence that can be missing (Google Docs' title took no cmd+V from the
    /// background), and keys are what a person types.
    static let typeKeysMax = 200

    enum InsertEvidence { case landed, missing, unreadable }

    /// Polls the element's value for the inserted text: `landed` when the value now differs from `before` and
    /// contains `text`, `unreadable` when there is no value to read.
    func waitForInsert(_ e: AXUIElement, _ text: String, before: String?, capMs: Double) -> InsertEvidence {
        let deadline = clock.nowMs() + capMs
        var readAny = before != nil
        repeat {
            if let now = ax.string(e, kAXValueAttribute) {
                readAny = true
                if now != before, now.contains(text) { return .landed }
            }
            if clock.nowMs() >= deadline { break }
            usleep(25_000)
        } while true
        return readAny ? .missing : .unreadable
    }

    /// The element is web content (inside an `AXWebArea`): WebKit and Chromium page fields.
    func isWebContent(_ e: AXUIElement?) -> Bool {
        var cur = e
        for _ in 0..<40 {
            guard let c = cur else { return false }
            if ax.string(c, kAXRoleAttribute) == "AXWebArea" { return true }
            cur = ax.element(c, kAXParentAttribute)
        }
        return false
    }

    /// Finder's Open routed to a background open: when the bound app is Finder and the menu path is an Open
    /// command, resolve the selected items' POSIX paths and open them (activates:false). Nil otherwise.
    func finderOpenRoute(_ path: [String], _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome? {
        guard t.bundleId == "com.apple.finder", path.last.map(CUMenuWalker.normalize) == "open" else { return nil }
        return try openFinderSelection(p, t, what: "“\(path.joined(separator: " › "))”")
    }

    /// A Finder item's file path from its `AXURL` (a file URL), or nil.
    func finderItemPath(_ e: AXUIElement) -> String? {
        guard let s = ax.string(e, "AXURL") ?? ax.string(e, kAXURLAttribute as String), let url = URL(string: s), url.isFileURL else { return nil }
        return url.path
    }

    /// Opens Finder's current selection in the background (never a Finder open event). The paths come from a
    /// guarded AppleScript read of the selection (an app the policy allows for the bound Finder).
    func openFinderSelection(_ p: TargetActParams, _ t: CUTarget, what: String) throws -> ActOutcome {
        let script = """
        tell application "Finder"
            set out to ""
            repeat with i in (selection as list)
                try
                    set out to out & POSIX path of (i as alias) & linefeed
                end try
            end repeat
            return out
        end tell
        """
        let result = (try? runAppleScript(script, t, timeoutMs: 6000)) ?? nil
        let paths = (result ?? "").split(whereSeparator: \.isNewline).map(String.init).filter { !$0.isEmpty }
        guard !paths.isEmpty else {
            throw CUError.unsupported("nothing is selected in \(t.appName) to open — select a file first, or use apps.open(path)")
        }
        return try pendingBackgroundOpen(paths, what: what)
    }

    /// An outcome that opens `paths` after the act releases the target's queue. The protected-path floor is
    /// checked here, under the queue, so a refusal is an ordinary refused act.
    func pendingBackgroundOpen(_ paths: [String], what: String?) throws -> ActOutcome {
        if let bad = paths.first(where: { CUFloors.isProtectedSavePath($0) }) {
            throw CUError.refused(.privacyPane, "opening \((bad as NSString).lastPathComponent) is off limits — it is a protected location")
        }
        return ActOutcome(rung: .accessibility, detail: nil, pendingOpen: paths, openWhat: what)
    }

    /// Opens `paths` in the background, waiting at most `openTimeoutMs` (NSWorkspace's open can't be
    /// cancelled: past the bound it keeps going and the result says so). Throws what the open threw.
    func finishBackgroundOpen(_ paths: [String], what: String?, _ t: CUTarget) async throws -> String {
        let label = paths.count == 1 ? (paths[0] as NSString).lastPathComponent : "\(paths.count) items"
        let prefix = what.map { "\($0): " } ?? ""
        enum Result { case opened(String), failed(Error), timedOut }
        let gate = CUResumeOnce()
        let timeoutMs = openTimeoutMs
        let result: Result = await withCheckedContinuation { (cont: CheckedContinuation<Result, Never>) in
            Task { [self] in
                let r: Result
                do { r = .opened(try await openInBackground(paths)) } catch { r = .failed(error) }
                if gate.claim() { cont.resume(returning: r) }
            }
            Task { [clock] in
                try? await clock.sleep(ms: timeoutMs)
                if gate.claim() { cont.resume(returning: .timedOut) }
            }
        }
        switch result {
        case .opened(let app):
            return "\(prefix)opened \(label) in \(app) in the background (not through Finder, so nothing came to the front)"
        case .failed(let error):
            throw error
        case .timedOut:
            CULog.act.notice("open from \(t.appName, privacy: .public): still opening after \(Int(timeoutMs), privacy: .public) ms")
            return "\(prefix)asked macOS to open \(label) in the background, but it had not finished after \(Int(timeoutMs / 1000)) s — it may still open; check with screenshot() or apps.list()"
        }
    }

    /// Makes the target believe it is active before keys go to it, so it does not activate itself and pull the
    /// user to its Space (the user-view guard around the act is the backstop). Logs that the enforcer acted;
    /// if the app still activates, the guard's note says it had to be undone.
    func enforceFocus(_ p: TargetActParams, _ t: CUTarget) {
        guard let enforcer = focusEnforcer(for: t, privatePath: p.privatePath) else { return }
        noteSyntheticActivation()  // the guardian must not read the activation this posts as the user's
        // Advisory now that focus no longer uses the AXFocused write: if the guard still logs a fault on this
        // act the synthetic activation did not help, and we can drop it; if the enforcer ran and no fault
        // follows, it was unneeded or it held. The guard is authoritative either way.
        if enforcer.enforce(windowID: t.windowID) {
            CULog.act.notice("focus in \(t.appName, privacy: .public): posted a synthetic active state (advisory; the user-view guard is authoritative)")
        }
    }

    /// The window server's key-focus pid (which window takes keys), for the swallowed-click retry; nil when
    /// it can't be read.
    func keyFocusPidForTarget(_ t: CUTarget) -> pid_t? {
        if let o = keyFocusPidOverride { return o() }
        return skyLight.keyFocusPid()
    }

    /// Where key events go: the focused element's OWN process when it isn't the app's — Safari's web content
    /// lives in a WebContent process (an out-of-process target). Keys posted to Safari's UI process for
    /// a web field made Safari activate itself and pull the user to its desktop; the content process takes
    /// them without that. The app's pid otherwise.
    func keyboardTarget(_ t: CUTarget, focused: AXUIElement?) -> pid_t {
        guard t.accessible, let f = focused ?? reportedFocus(t) else { return t.pid }
        var pid: pid_t = 0
        guard AXUIElementGetPid(f, &pid) == .success, pid != t.pid, sys.isContentProcess(pid, of: t.pid) else { return t.pid }
        CULog.act.notice("keys in \(t.appName, privacy: .public): pid events → \(self.sys.processName(pid: pid) ?? "content process", privacy: .public) \(pid, privacy: .public)")
        return pid
    }

    /// Whether the app's focused UI element is `e` now (its own, or its focused window's).
    func isFocused(_ e: AXUIElement, _ t: CUTarget) -> Bool { focusRelation(e, t) == .onIt }

    /// Makes the bound window its app's key window before a menu command is validated: a window-targeted click
    /// on the element that holds the selection (the one just worked on, else the window's own focused
    /// element), its selection put back, verified, and once more if the window still isn't key. Also when the
    /// key window can't be read — the click is what makes it certain.
    func keyForMenu(_ t: CUTarget) {
        guard t.accessible else { return }
        guard boundWindowIsKeyInApp(t) != true else {
            CULog.act.notice("menu in \(t.appName, privacy: .public): the bound window is key in its app — no click to make it key")
            return
        }
        guard let e = selectionHolder(t), let c = ElementInfo(e, ax).center else {
            CULog.act.notice("menu in \(t.appName, privacy: .public): the bound window is not key and nothing in it to click")
            return
        }
        for attempt in 1...2 {
            guard clickKeepingSelection(e, at: c, t) else { return }
            let key = boundWindowIsKeyInApp(t)
            CULog.act.notice("menu in \(t.appName, privacy: .public): clicked the selection's element to make its window key (try \(attempt, privacy: .public)) — key now: \(Self.yesNo(key), privacy: .public)")
            if key != false { return }
        }
    }

    /// The element a selection-dependent command acts on: the one just worked on, else the window's focused one.
    func selectionHolder(_ t: CUTarget) -> AXUIElement? {
        recentlyTargeted(t) ?? (try? windowElement(t)).flatMap { ax.element($0, kAXFocusedUIElementAttribute) }
    }

    static func yesNo(_ b: Bool?) -> String { b.map { $0 ? "yes" : "no" } ?? "unknown" }

    /// A window-targeted click on `e` with its text selection kept: the click moves the caret, so the selection
    /// is put back — after the click has landed (the caret moved, or `selectionHoldMs` passed), since a restore
    /// the app handles before the click is undone by it — and then held. False when no route reaches the window.
    func clickKeepingSelection(_ e: AXUIElement, at c: CGPoint, _ t: CUTarget) -> Bool {
        let range = selectionRange(e)
        guard windowClick(at: c, t) else { return false }
        guard let range, ax.isSettable(e, kAXSelectedTextRangeAttribute),
              let r = AX.makeRange(location: range.location, length: range.length) else { return true }
        let deadline = clock.nowMs() + selectionHoldMs
        while clock.nowMs() < deadline, let now = selectionRange(e), now == range { usleep(20_000) }
        try? ax.set(e, kAXSelectedTextRangeAttribute, r)
        holdSelection(e, range, t, what: "menu")
        return true
    }

    /// An element's selected text range, when it reports one.
    func selectionRange(_ e: AXUIElement) -> NSRange? {
        guard let v = ax.attribute(e, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        return AXValueGetValue(v as! AXValue, .cfRange, &r) ? NSRange(location: r.location, length: r.length) : nil
    }

    /// A window-targeted click posted for the focus may be handled AFTER the accessibility write that follows
    /// it (the app takes its events and accessibility requests in its own order) and its mouse-down moves the
    /// caret: the selection just set is lost, and a selection-dependent menu command then reads disabled. When
    /// such a click went out in the last 1.5 s, the selection is read for `selectionHoldMs` and set again (at
    /// most twice) if it moved.
    func holdSelection(_ e: AXUIElement, _ want: NSRange, _ t: CUTarget, what: String) {
        guard selectionHoldMs > 0, let clicked = t.lastFocusClickMs, clock.nowMs() - clicked < 1_500,
              let r = AX.makeRange(location: want.location, length: want.length) else { return }
        let deadline = clock.nowMs() + selectionHoldMs
        var resets = 0
        while clock.nowMs() < deadline {
            usleep(30_000)
            guard let now = selectionRange(e), now != want else { continue }
            guard resets < 2 else { break }
            resets += 1
            try? ax.set(e, kAXSelectedTextRangeAttribute, r)
            CULog.act.notice("\(what, privacy: .public) in \(t.appName, privacy: .public): a late click moved the selection to \(now.location, privacy: .public)+\(now.length, privacy: .public) — set it again to \(want.location, privacy: .public)+\(want.length, privacy: .public)")
        }
    }

    /// Before a background menu command is validated: the selection `select` set, put back if something (a
    /// late click) moved it while the text stayed the same. Returns what was found, for the log.
    func putSelectionBack(_ t: CUTarget) -> String {
        guard let s = t.lastSelection, clock.nowMs() - s.atMs <= Self.targetedFocusMs, ax.isAlive(s.element) else {
            return "no selection set by select() in this window"
        }
        let want = NSRange(location: s.location, length: s.length)
        let now = selectionRange(s.element)
        let nowText = now.map { "\($0.location)+\($0.length)" } ?? "unreadable"
        if now == want { return "the selection select() set (\(s.location)+\(s.length)) holds" }
        guard ax.string(s.element, kAXValueAttribute) == s.value, let r = AX.makeRange(location: s.location, length: s.length) else {
            return "the text changed since select() — the selection is the app's (\(nowText))"
        }
        let put = (try? ax.set(s.element, kAXSelectedTextRangeAttribute, r)) != nil
        return "the selection select() set (\(s.location)+\(s.length)) had moved to \(nowText) — \(put ? "put back" : "putting it back was refused")"
    }

    /// The synthetic activation before a selection-dependent command is validated, posted whatever the app was
    /// believed to be (the app re-validates its menu on an activation it handles). Logged either way.
    func activateForMenu(_ p: TargetActParams, _ t: CUTarget) {
        guard let enforcer = focusEnforcer(for: t, privatePath: p.privatePath) else {
            CULog.act.notice("menu in \(t.appName, privacy: .public): no synthetic activation (the private path is off)")
            return
        }
        noteSyntheticActivation()  // the guardian must not read the activation this posts as the user's
        let posted = enforcer.forceActivation(windowID: t.windowID)
        CULog.act.notice("menu in \(t.appName, privacy: .public): \(posted ? "posted the synthetic activation before validating (whatever the app was believed to be)" : "no synthetic activation: the app is in front", privacy: .public)")
    }

    /// `resolveMenu`, but a command that reads DISABLED is read again for up to `menuSettleMs`: the app
    /// re-validates its menu after its key window changes, not at once. Each outcome is logged.
    func resolveMenuSettled(_ a: CUMenuAction, _ p: TargetActParams, _ t: CUTarget) throws -> CUAXMenuNode {
        let start = clock.nowMs()
        let deadline = start + menuSettleMs
        let title = a.path.last ?? ""
        var reads = 0
        while true {
            reads += 1
            do {
                let item = try resolveMenu(a, p, t)
                CULog.act.notice("menu in \(t.appName, privacy: .public): “\(title, privacy: .public)” read enabled (read \(reads, privacy: .public), \(Int(self.clock.nowMs() - start), privacy: .public) ms)")
                return item
            } catch let e as CUError where e.data?["disabled"] != nil {
                if clock.nowMs() >= deadline {
                    CULog.act.notice("menu in \(t.appName, privacy: .public): “\(title, privacy: .public)” still disabled after \(reads, privacy: .public) reads (\(Int(self.clock.nowMs() - start), privacy: .public) ms)")
                    throw e
                }
                usleep(40_000)
            }
        }
    }

    /// A menu command in the background, validated and pressed: the selection checked (put back if something
    /// moved it), the window made key in its app (a click, when it isn't), the synthetic activation posted
    /// whatever the app was believed to be, and the item read. Enabled → pressed, no focus blip. Disabled →
    /// re-validated in the focus blip (at most twice) and pressed there; with no blip possible, read for
    /// `menuSettleMs` after another activation. Still disabled → the disabled error. Every step logged.
    /// `blipped`: whether a blip ran.
    func pressBackgroundMenu(_ a: CUMenuAction, _ p: TargetActParams, _ t: CUTarget, blipped: inout Bool) throws -> String? {
        let title = a.path.last ?? ""
        CULog.act.notice("menu in \(t.appName, privacy: .public): validating “\(title, privacy: .public)” in the background — window key in its app: \(Self.yesNo(self.boundWindowIsKeyInApp(t)), privacy: .public); \(self.putSelectionBack(t), privacy: .public)")
        keyForMenu(t)
        activateForMenu(p, t)
        func enabledItem() throws -> CUAXMenuNode? {
            do { return try resolveMenu(a, p, t) } catch let e as CUError where e.data?["disabled"] != nil { return nil }
        }
        if let item = try enabledItem() {
            CULog.act.notice("menu in \(t.appName, privacy: .public): “\(title, privacy: .public)” reads enabled — no focus blip")
            return try pressMenu(item, t)
        }
        // In front: disabled for what it applies to (the disabled error).
        guard sys.frontmostPid() != t.pid else { return try pressMenu(try resolveMenu(a, p, t), t) }
        switch try pressInBlip(p, t, title: title, read: enabledItem, press: { try pressMenu($0, t) }) {
        case .pressed(let note):
            blipped = true
            return note
        case .stillDisabled:
            blipped = true
            return try pressMenu(try resolveMenu(a, p, t), t)  // the disabled error (or enabled at last)
        case .unavailable:
            CULog.act.notice("menu in \(t.appName, privacy: .public): “\(title, privacy: .public)” reads disabled and no focus blip is possible — the activation again, read for \(Int(self.menuSettleMs), privacy: .public) ms")
            activateForMenu(p, t)
            return try pressMenu(try resolveMenuSettled(a, p, t), t)
        }
    }

    /// Keys go to the app's KEY window: with another window key they are lost there (live: WebKit focus was in
    /// the fixture's web field, its Canvas window stayed key, and no key reached the field; an AXMain write did
    /// not change that). So when the field's window is not its app's key window, it is made key the way a user
    /// does — a window-targeted click on the field, after the synthetic activation, once more if the first only
    /// activated — and the field's selection is put back (the click moved the caret).
    func makeWindowKeyForField(_ e: AXUIElement, _ t: CUTarget) {
        guard t.accessible, boundWindowIsKeyInApp(t) == false, let c = ElementInfo(e, ax).center else { return }
        let selection = ax.attribute(e, kAXSelectedTextRangeAttribute)
        guard windowClick(at: c, t) else { return }
        // The first click may only have made the window key (then the window's default responder has the focus):
        // once more, now that it is key.
        if boundWindowIsKeyInApp(t) != true || focusRelation(e, t) == .elsewhere { _ = windowClick(at: c, t) }
        if let selection, ax.isSettable(e, kAXSelectedTextRangeAttribute) { try? ax.set(e, kAXSelectedTextRangeAttribute, selection) }
        // The click must have left the focus in the field; if it moved it, place it again (press or caret).
        if focusRelation(e, t) != .onIt {
            let web = isWebContent(e) || keyboardTarget(t, focused: e) != t.pid
            if ax.actions(e).contains(kAXPressAction) { try? ax.perform(e, kAXPressAction) }
            if !waitFocused(e, t, web: web), let selection, ax.isSettable(e, kAXSelectedTextRangeAttribute) {
                try? ax.set(e, kAXSelectedTextRangeAttribute, selection)
            }
            CULog.act.notice("keys in \(t.appName, privacy: .public): the click moved the focus; placed again → focus \(Self.relationWord(self.focusRelation(e, t)), privacy: .public)")
        }
        let now = boundWindowIsKeyInApp(t)
        CULog.act.notice("keys in \(t.appName, privacy: .public): the field's window was not key in its app — clicked the field; key now: \(now.map { $0 ? "yes" : "no" } ?? "unknown", privacy: .public)")
    }

    /// A window-targeted left click at `c` in the bound window — on this desktop, or (private path) on another
    /// Space — after the synthetic activation. False when no route reaches the window.
    @discardableResult
    func windowClick(at c: CGPoint, _ t: CUTarget) -> Bool {
        let onScreen = sys.window(id: t.windowID)?.onScreen == true
        let elsewhere = !onScreen && t.privatePath && skyLight.canSetWindowLocation
        guard onScreen || elsewhere else { return false }
        let route: CURoute = elsewhere && t.isChromium && skyLight.isAvailable ? .skyLight : .publicPid
        var s = synth
        s.windowSPI = t.privatePath
        let windowFor = self.windowFor(t)
        switch keyForClick(t, privatePath: t.privatePath, clickWindow: windowFor(c)) {
        case .notApplied: postSyntheticActivation(t, privatePath: t.privatePath)
        case .prepared: break
        case .appInFront: return false  // the user may be using it now: no click
        }
        try? s.click(pid: t.pid, windowFor: windowFor, at: c, button: .left, count: 1, flags: [], route: route)
        t.lastFocusClickMs = clock.nowMs()
        return true
    }

    /// Whether the bound window is its app's key (focused) window, as the app tells accessibility; nil when it
    /// can't be read.
    func boundWindowIsKeyInApp(_ t: CUTarget) -> Bool? {
        guard let w = try? windowElement(t) else { return nil }
        if let f = ax.element(ax.application(t.pid), kAXFocusedWindowAttribute) {
            // By window id: two element objects for one window need not compare equal.
            if let id = ax.windowID(f) { return id == t.windowID }
            return CFEqual(f, w)
        }
        return ax.bool(w, kAXFocusedAttribute)
    }

    enum FocusRelation { case onIt, elsewhere, unknown }

    static func relationWord(_ r: FocusRelation) -> String {
        switch r { case .onIt: return "on the field"; case .elsewhere: return "elsewhere"; case .unknown: return "not reported" }
    }

    /// Where the keyboard focus is relative to `e`: on it (the focused element is `e` or inside it, or `e`
    /// says it is focused), elsewhere (the app reports another element), or unknown (the app reports none —
    /// Electron apps often don't).
    func focusRelation(_ e: AXUIElement, _ t: CUTarget) -> FocusRelation {
        // What the app or window REPORTS wins: a web field can hold DOM focus (its own AXFocused reads true)
        // while the window's first responder is another control (live: Safari's address bar took the keys).
        let reported = ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute)
            ?? (try? windowElement(t)).flatMap { ax.element($0, kAXFocusedUIElementAttribute) }
        guard var f = reported else { return ax.bool(e, kAXFocusedAttribute) == true ? .onIt : .unknown }
        for _ in 0..<12 {
            if CFEqual(f, e) { return .onIt }
            guard let parent = ax.element(f, kAXParentAttribute) else { break }
            f = parent
        }
        return .elsewhere
    }

    /// Puts the focus in the field an act named, or refuses: when it lands elsewhere — the app reports
    /// another element focused — nothing is typed, because the keys would go there. When the app reports no
    /// focus at all there is nothing to check against: the focus-unknown floor still governs the typing.
    func placeFocus(_ e: AXUIElement, _ t: CUTarget, ref: Int?) throws {
        if focusField(e, t) { return }
        guard t.accessible else { return }
        if focusRelation(e, t) == .elsewhere { throw focusNotPlacedRefusal(t, ref: ref) }
        CULog.act.notice("focus in \(t.appName, privacy: .public): not confirmed (the app reports no focused element)")
    }

    /// Focuses `e` for typing WITHOUT the `AXFocused` write where that write would steal the user's view: on a
    /// WebKit/Chromium web element, or in an app remembered as activating itself on the write (the live gate:
    /// writing AXFocused on a Safari web field made Safari come forward and switch the user's Space; AXPress
    /// and key events did not). The order (the controller's ruling): already focused → nothing; else press it
    /// (AXPress/AXConfirm, or a window-targeted click at its centre when it is on screen) and verify; only for
    /// a plain native field in an app not known to activate does the `AXFocused` write remain, under the
    /// user-view guard — and if that write trips the guard, the app is remembered so its native fields use the
    /// press route first too, for the helper's lifetime. Returns whether focus is on `e` now.
    @discardableResult
    func focusField(_ e: AXUIElement, _ t: CUTarget) -> Bool {
        // A capture-only window has no element of its own to focus: never a write (its "window" element is the
        // application's). Keys reach it after the synthetic activation, in the window a point click made key.
        guard t.accessible else { return false }
        if isFocused(e, t) || pressToFocus(e, t) {
            makeWindowKeyForField(e, t)
            // Whatever the click did, keys go nowhere but the field: elsewhere now means not placed.
            return focusRelation(e, t) != .elsewhere
        }
        // The write is forbidden for web content and apps known to activate on it: focus is not placed, and
        // the caller refuses rather than typing into whatever has it.
        let web = isWebContent(e) || keyboardTarget(t, focused: e) != t.pid
        if web || appActivatesOnFocusWrite(t) {
            CULog.act.notice("focus in \(t.appName, privacy: .public): neither a press nor a click placed it, and the AXFocused write is not used here")
            return false
        }
        // A plain native field, no history of activating: the write, under the guard.
        let before = userView()
        try? ax.set(e, kAXFocusedAttribute, kCFBooleanTrue)
        let after = view(after: before, settleMs: stepSettleMs)
        if after != before {
            rememberFocusWriteActivates(t)  // use the press route first for this app from now on
            t.addViewNote(viewMoved(before, after, t, route: "focusing the field over accessibility", late: false))
        }
        return waitFocused(e, t, web: false)
    }

    /// The refusal when focus can't be placed on the field the act named: nothing is typed, because the keys
    /// would go to whatever has the focus (a live run put a comment into the page's search field).
    func focusNotPlacedRefusal(_ t: CUTarget, ref: Int?) -> CUError {
        let which = ref.map { "[\($0)]" } ?? "that field"
        return CUError.refused(.focusNotPlaced,
                               "couldn't put the keyboard focus in \(which) of \(t.appName) from the background, so nothing was typed (the keys would have gone to whatever field has focus) — use setValue(\(ref.map(String.init) ?? "ref"), text) if the field takes a value, or click it first and retry")
    }

    /// Polls whether `e` has the focus: WebKit moves `AXFocusedUIElement` asynchronously after a press or a
    /// click, so an immediate read misses a focus that did land.
    func waitFocused(_ e: AXUIElement, _ t: CUTarget, web: Bool) -> Bool {
        let deadline = clock.nowMs() + (web ? focusWaitWebMs : focusWaitNativeMs)
        repeat {
            if isFocused(e, t) { return true }
            if clock.nowMs() >= deadline { return false }
            usleep(30_000)
        } while true
    }

    /// The synthetic "you are active" state for the bound window, before a click that must not be swallowed as
    /// activation (only with the private path, like the rest of the enforcer).
    func postSyntheticActivation(_ t: CUTarget, privatePath: Bool) {
        guard let enforcer = focusEnforcer(for: t, privatePath: privatePath) else { return }
        noteSyntheticActivation()  // the guardian must not read the activation this posts as the user's
        _ = enforcer.enforce(windowID: t.windowID)
    }

    /// Focuses `e` by pressing it, never by the `AXFocused` write: a listed `AXPress`/`AXConfirm`, else a
    /// window-targeted click at its centre when the window is on screen. Verified against the focused element.
    /// False when nothing placed focus on it.
    func pressToFocus(_ e: AXUIElement, _ t: CUTarget) -> Bool {
        let web = isWebContent(e) || keyboardTarget(t, focused: e) != t.pid
        let actions = ax.actions(e)
        for a in [kAXPressAction, "AXConfirm"] where actions.contains(a) {
            let done = (try? ax.perform(e, a)) != nil
            let placed = done && waitFocused(e, t, web: web)
            CULog.act.notice("focus in \(t.appName, privacy: .public): \(a, privacy: .public) \(done ? "sent" : "refused", privacy: .public) → focus \(Self.relationWord(self.focusRelation(e, t)), privacy: .public)")
            if placed { return true }
        }
        // A selection write puts the caret in a text control (WebKit focuses the control it selects in) — an AX
        // write of the selection, never of AXFocused. At the end, so nothing is replaced.
        if ax.isSettable(e, kAXSelectedTextRangeAttribute), let end = textLength(e, t) {
            if let r = AX.makeRange(location: end, length: 0) {
                let done = (try? ax.set(e, kAXSelectedTextRangeAttribute, r)) != nil
                let placed = done && waitFocused(e, t, web: web)
                CULog.act.notice("focus in \(t.appName, privacy: .public): caret placed by a selection write \(done ? "sent" : "refused", privacy: .public) → focus \(Self.relationWord(self.focusRelation(e, t)), privacy: .public)")
                if placed { return true }
            }
        }
        // AXPress may not focus a web textarea: a window-targeted click at its centre, on this desktop or (with
        // the private path) on another Space, after the synthetic activation so it isn't taken as activation.
        guard let c = ElementInfo(e, ax).center else { return false }
        let onScreen = sys.window(id: t.windowID)?.onScreen == true
        let elsewhere = !onScreen && t.privatePath && skyLight.canSetWindowLocation
        guard onScreen || elsewhere else { return false }
        let route: CURoute = elsewhere && t.isChromium && skyLight.isAvailable ? .skyLight : .publicPid
        var s = synth
        s.windowSPI = t.privatePath
        let windowFor = self.windowFor(t)
        // Key IN ITS APP (the app's focused window): in the background the system-wide key focus is the user's
        // app, always, so it can't tell whether the click only made the window key.
        let wasKey = boundWindowIsKeyInApp(t)
        switch keyForClick(t, privatePath: t.privatePath, clickWindow: windowFor(c)) {
        case .notApplied: postSyntheticActivation(t, privatePath: t.privatePath)
        case .prepared: break
        case .appInFront: return false  // the user may be using it now: no click
        }
        try? s.click(pid: t.pid, windowFor: windowFor, at: c, button: .left, count: 1, flags: [], route: route)
        t.lastFocusClickMs = clock.nowMs()
        let clicked = waitFocused(e, t, web: web)
        CULog.act.notice("focus in \(t.appName, privacy: .public): window-targeted click (\(onScreen ? "on this desktop" : "elsewhere", privacy: .public), \(route == .skyLight ? "SkyLight" : "pid", privacy: .public), window was key in its app: \(wasKey.map { $0 ? "yes" : "no" } ?? "unknown", privacy: .public)) → focus \(Self.relationWord(self.focusRelation(e, t)), privacy: .public)")
        if clicked { return true }
        // The click only made the window key, or left the window's default responder (a new Safari window's
        // address bar) with the focus: once more.
        if (wasKey != true && boundWindowIsKeyInApp(t) != false) || focusRelation(e, t) == .elsewhere {
            CULog.act.notice("focus in \(t.appName, privacy: .public): the first click only made the window key — clicking the field once more")
            try? s.click(pid: t.pid, windowFor: windowFor, at: c, button: .left, count: 1, flags: [], route: route)
            t.lastFocusClickMs = clock.nowMs()
            if waitFocused(e, t, web: web) { return true }
        }
        return false
    }

    /// Polls for evidence that an edit landed: the value changed, or a value-change notification arrived.
    func waitForEdit(_ t: CUTarget, _ e: AXUIElement?, before: String?, expect: String?, capMs: Double) -> Bool {
        let ax = self.ax, clock = self.clock
        let evidence = CUEditEvidence(readValue: { e.flatMap { ax.string($0, kAXValueAttribute) } },
                                      nowMs: { clock.nowMs() },
                                      sleepMs: { usleep(useconds_t($0 * 1000)) })
        return evidence.wait(before: before, expect: expect, capMs: capMs)
    }

    /// An element's selected range as text ("12+0"), when it has one.
    static func selectionText(_ ax: CUAXBackend, _ e: AXUIElement) -> String? {
        guard let v = ax.attribute(e, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        return AXValueGetValue(v as! AXValue, .cfRange, &r) ? "\(r.location)+\(r.length)" : nil
    }

    private func pasteText(_ text: String, format: CUPasteFormat, _ p: TargetActParams, _ t: CUTarget,
                           _ token: CUCancellation.Token, _ g: TypingFocus) throws -> ActOutcome {
        try token.check()
        let focus = try requireTypableFocus(t, g)
        // Confirmable only where the focused element shows its text: then the proof is that text, normalized
        // before and after, now holding what was pasted. A web or canvas editor that shows only zero-width filler
        // (whatever it holds) can't be read back: no waiting for proof that never comes — "unconfirmed".
        let before = focus.flatMap { ax.string($0, kAXValueAttribute) }
        let confirmable = focus.map { readsBack($0, t, value: before) } ?? false
        let expect = CUPasteSequence.plain(text: text, format: format)
        // Web content takes a paste late, if at all (Docs' title took none from the background): a short look
        // at the value, then the answer — unconfirmed, the clipboard restored once the page has had time.
        let web = isWebContent(focus) || (focus.map { keyboardTarget(t, focused: $0) != t.pid } ?? false)
        var sent: ActOutcome?
        var since = clock.nowMs()
        let pb = pasteboard()
        var seq = CUPasteSequence(
            pasteboard: pb,
            sendPaste: {
                since = self.clock.nowMs()
                sent = try self.sendChord(CUKeyChord(key: .character("v"), modifiers: [.command]), p, t, token, g)
            },
            // Restore only once the paste visibly happened (or 1.5 s passed): an app that reads the
            // clipboard late must not get the user's own contents instead.
            waitForEvidence: {
                _ = since
                return self.waitForEdit(t, focus, before: before, expect: expect, capMs: web ? 800 : 1500)
            })
        // An earlier unconfirmed paste's restore still pending: its saved clipboard is the user's (what is on the
        // clipboard now is Winter's text), unless the user copied something since.
        if let pending = takePendingRestore(), pb.changeCount == pending.ours { seq.pendingSaved = pending.saved }
        if !confirmable {
            seq.deferRestore = { [self] saved, ours in scheduleRestore(pb, saved: saved, ours: ours) }
        } else if web {
            seq.deferIfUnconfirmed = { [self] saved, ours in scheduleRestore(pb, saved: saved, ours: ours) }
        }
        let result = try seq.run(items: CUPasteSequence.items(text: text, format: format),
                                 plain: CUPasteSequence.plain(text: text, format: format))
        var o = sent ?? ActOutcome(rung: .processEvents)
        switch result {
        case .leftAlone:
            o.detail = [o.detail, "the clipboard changed meanwhile, so it was not restored"].compactMap { $0 }.joined(separator: "; ")
        case .restored(let evidence) where !evidence:
            o.detail = [o.detail, "unconfirmed — the field does not show the pasted text (within 1.5 s); check state() before pasting again"].compactMap { $0 }.joined(separator: "; ")
        case .restored:
            o.detail = [o.detail, "the field shows the pasted text"].compactMap { $0 }.joined(separator: "; ")
        case .unconfirmed:
            o.detail = [o.detail, "unconfirmed — the field does not show the pasted text yet; check state() before pasting again; the clipboard is restored once \(t.appName) has had time to read it"]
                .compactMap { $0 }.joined(separator: "; ")
        case .deferred:
            o.detail = [o.detail, "unconfirmed — can't be read back: \(t.appName) doesn't show this editor's text to accessibility; check something the app shows (a word count) or a screenshot before pasting again; the clipboard is restored once \(t.appName) has had time to read it"]
                .compactMap { $0 }.joined(separator: "; ")
        default: break
        }
        return o
    }

    // MARK: keys

    private func key(_ a: CUKeyAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        enforceFocus(p, t)
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
            try placeFocus(el, t, ref: into)
            t.noteTargeted(el, at: clock.nowMs())
            g.explicit = el
            e = el
        } else {
            e = reportedFocus(t)
        }
        let textual = Self.producesText(chord)
        // Characters (and cmd+V) are text input: never into a password or payment field (C1).
        if textual { e = try requireTypableFocus(t, g) ?? e }
        if !t.accessible { e = nil }  // capture-only: keys go to the window, not to a reported element
        cursor(t, "key", at: e.flatMap { ElementInfo($0, ax).center }, text: a.combo)
        // Keys go to the app's key window: make it the bound one first (in the background, never the front).
        // Resolve the route once (the menu lookup walks the menu bar), then press it `repeat` times.
        let plan = try chordPlan(chord, p, t, g)
        var out = ActOutcome(rung: .accessibility)
        let keyPid = keyboardTarget(t, focused: e)
        let blips = CUKeyBlips(self, p, t, why: "keys")
        defer { blips.end() }
        // Return in a field of the window's toolbar (a browser's address field; not a find bar, where Return finds
        // the next match): the page as it was before the key.
        let returnInChrome = chord.key == .named(.returnKey) && chord.modifiers.isEmpty && t.accessible
            && e.map { !isWebContent($0) && editableElement($0) && inToolbar($0) } == true
        let pageBeforeReturn = returnInChrome ? pageSignature(t) : nil
        for _ in 0..<rep {
            try token.check()
            if textual { try requireTypableFocus(t, g) }
            out = try execute(plan, p, t, token, keyPid: keyPid, blips: blips)
        }
        // A chord that is a menu command went to the app's menu, not to an element (its detail says which item).
        switch plan {
        case .menuItem, .blipMenuItem, .keyedMenuItem: return out
        default: break
        }
        // Return in a field outside the page (a browser's address or search field): it should load a page. Watched
        // briefly; when nothing loaded, said — never a silent success (live: Return reached no field, and the
        // result read as done).
        if let before = pageBeforeReturn {
            blips.end()
            let loaded = waitForPageChange(from: before, t, ms: returnLoadWatchMs)
            if !loaded {
                let now = pageSignature(t)
                let page = now?.title.flatMap { $0.isEmpty ? nil : $0 } ?? now?.url ?? "the same page"
                CULog.act.notice("key in \(t.appName, privacy: .public): Return in a field outside the page — no page change")
                out = out.noting("the page did not change after Return (still \u{201C}\(page.prefix(80))\u{201D}) — if a page should load, check the field with state(), or waitFor({ title }) if it is slow")
            }
        }
        return receiving(e, t, out)
    }

    /// `e` lies in a toolbar (an `AXToolbar` ancestor, a few levels up).
    func inToolbar(_ e: AXUIElement) -> Bool {
        var cur = ax.element(e, kAXParentAttribute)
        for _ in 0..<8 {
            guard let c = cur else { return false }
            let role = ax.string(c, kAXRoleAttribute)
            if role == kAXToolbarRole { return true }
            if role == kAXWindowRole || role == "AXWebArea" { return false }
            cur = ax.element(c, kAXParentAttribute)
        }
        return false
    }

    /// Polls the bound window's page until it is another than `before` (an anchor jump aside), up to `ms`.
    func waitForPageChange(from before: PageSignature, _ t: CUTarget, ms: Double) -> Bool {
        let deadline = clock.nowMs() + ms
        repeat {
            if let now = pageSignature(t), !Self.isSamePage(before, now) { return true }
            if clock.nowMs() >= deadline { return false }
            usleep(100_000)
        } while true
    }

    static func producesText(_ c: CUKeyChord) -> Bool {
        guard case .character(let ch) = c.key else { return c.key == .named(.space) }
        if c.modifiers.contains(.command) { return ch == "v" }
        return !c.modifiers.contains(.control)
    }

    /// How a chord reaches the app: a menu item with that key equivalent (rung 1), else key events.
    indirect enum ChordPlan {
        case menuItem(AXUIElement, title: String)
        /// A menu shortcut whose item reads disabled with the app in the background: re-validated in the focus
        /// blip and pressed there, else the events plan.
        case blipMenuItem(AXUIElement, title: String, fallback: ChordPlan)
        /// A menu shortcut while ANOTHER of the app's windows is its key window: a menu action goes down the key
        /// window's responder chain first, so it is pressed only in the focus blip (the bound window key) — never
        /// sent where it would act on the other window.
        case keyedMenuItem(AXUIElement, title: String)
        case events(code: CGKeyCode, flags: CGEventFlags, decision: CUInputLadder.Decision)
        /// An editing shortcut carried out over accessibility in a background web field, with the events plan to
        /// fall back on when that is not possible.
        case emulated(EditCommand, field: AXUIElement, fallback: ChordPlan)
    }

    /// ⌘A ⌘C ⌘X ⌘V for a web field in an app that is not in front. Live: neither the key equivalents posted to
    /// the app nor its Edit menu items (unvalidated in the background) did anything in a WebKit view, while the
    /// selection, the selected text and plain typing all work there.
    enum EditCommand: String { case selectAll = "select all", copy, cut, paste, undo, redo }

    static func editCommand(_ chord: CUKeyChord) -> EditCommand? {
        guard case .character(let raw) = chord.key else { return nil }
        let ch = Character(String(raw).lowercased())
        if chord.modifiers == [.command, .shift] { return ch == "z" ? .redo : nil }
        guard chord.modifiers == [.command] else { return nil }
        switch ch {
        case "a": return .selectAll
        case "c": return .copy
        case "x": return .cut
        case "v": return .paste
        case "z": return .undo
        default: return nil
        }
    }

    func chordPlan(_ chord: CUKeyChord, _ p: TargetActParams, _ t: CUTarget, _ g: TypingFocus = TypingFocus()) throws -> ChordPlan {
        if chord.modifiers.contains(.command), case .character(let ch) = chord.key {
            // A paste however it is sent: never into a password field, never under click only.
            if Character(String(ch).lowercased()) == "v" { try requirePasteSafe(p, t, g) }
            // ⌘A ⌘C ⌘X ⌘V into a web field of an app that is not in front: over accessibility (see EditCommand) —
            // neither the key equivalents nor the app's Edit items reach a background WebKit view.
            if t.accessible, let command = Self.editCommand(chord), sys.frontmostPid() != t.pid,
               let f = g.explicit ?? reportedFocus(t), isWebContent(f) || keyboardTarget(t, focused: f) != t.pid,
               editableFocus(t, f) {
                let code = CUKeyCodes.code(for: ch) ?? 0
                return .emulated(command, field: f, fallback: .events(
                    code: code, flags: chord.modifiers.cgFlags, decision: try CUInputLadder.decideEvents(context(p, t, pointer: false))))
            }
            // An editing shortcut with the focus in an editable element or a content process goes to that
            // element as KEYS: the app's menu item acts on the app's responder, not the web field (Safari's
            // Select All selected nothing in Google Docs' title, so typing appended) — unless the field's window
            // is the app's KEY window: then the menu item's action goes down that window's responder chain.
            let editingShortcut = Self.isEditingShortcut(chord) && editableFocus(t, g.explicit ?? reportedFocus(t))
            let editing = editingShortcut && boundWindowIsKeyInApp(t) != true
            if !editing, t.accessible, let item = menuItem(forKey: ch, modifiers: chord.modifiers, pid: t.pid) {
                if CUPasteMenu.isPasteTitle(item.title) { try requirePasteSafe(p, t, g) }
                // Another of the app's windows is its key window (the user's, perhaps): the menu action would go
                // there (live: Open Location acted on another window). Pressed only with the bound window key.
                if boundWindowIsKeyInApp(t) == false {
                    CULog.act.notice("key in \(t.appName, privacy: .public): the chord's menu item “\(item.title, privacy: .public)” — another window is key: pressed in the focus blip only")
                    return .keyedMenuItem(item.element, title: item.title)
                }
                CULog.act.notice("key in \(t.appName, privacy: .public): the chord goes to its menu item")
                return .menuItem(item.element, title: item.title)
            }
            // Its menu item reads disabled with the app in the background: the app has not re-validated it (a
            // selection-dependent command). Re-validated in the focus blip, else the keys as before.
            if !editing, t.accessible, p.privatePath, sys.frontmostPid() != t.pid,
               let item = menuItem(forKey: ch, modifiers: chord.modifiers, pid: t.pid, includeDisabled: true) {
                if CUPasteMenu.isPasteTitle(item.title) { try requirePasteSafe(p, t, g) }
                guard let code = CUKeyCodes.code(for: ch) else { throw CUError.unsupported("no key for “\(ch)” on this keyboard") }
                CULog.act.notice("key in \(t.appName, privacy: .public): the chord's menu item “\(item.title, privacy: .public)” reads disabled in the background — re-validated in the focus blip")
                return .blipMenuItem(item.element, title: item.title, fallback: .events(
                    code: code, flags: chord.modifiers.cgFlags, decision: try CUInputLadder.decideEvents(context(p, t, pointer: false))))
            }
            CULog.act.notice("key in \(t.appName, privacy: .public): the chord goes as key events (editing shortcut into editable focus: \(editing, privacy: .public))")
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

    /// Select all, copy, cut, paste, undo and redo: the shortcuts that act on the focused text.
    static func isEditingShortcut(_ chord: CUKeyChord) -> Bool {
        guard case .character(let raw) = chord.key, chord.modifiers.contains(.command),
              !chord.modifiers.contains(.control), !chord.modifiers.contains(.option) else { return false }
        let ch = Character(String(raw).lowercased())
        if chord.modifiers.contains(.shift) { return ch == "z" }
        return ["a", "c", "x", "v", "z"].contains(ch)
    }

    /// The focus takes text itself — a text field or area, editable web content — or lives in a content
    /// process (Safari's WebContent): editing shortcuts go to it as keys.
    func editableFocus(_ t: CUTarget, _ e: AXUIElement?) -> Bool {
        guard let e else { return false }
        if keyboardTarget(t, focused: e) != t.pid { return true }
        let role = ax.string(e, kAXRoleAttribute)
        if role == kAXTextFieldRole || role == kAXTextAreaRole || role == kAXComboBoxRole || role == "AXSearchField" { return true }
        return ax.attribute(e, "AXEditableAncestor") != nil
    }

    /// `keyPid`: where key events go (`keyboardTarget`), the app's pid when nil.
    /// `blips`: the act's keyboard focus blips (one per burst); its own when nil.
    func execute(_ plan: ChordPlan, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token,
                 keyPid: pid_t? = nil, blips: CUKeyBlips? = nil) throws -> ActOutcome {
        switch plan {
        case .menuItem(let element, let title):
            aimMenuCommands(at: t)
            // A menu command acts on the app's MAIN window: if that is still another of its windows (the user's,
            // perhaps), pressing it would act there (live: Open Location went to another window). Checked after
            // aiming; nothing is done when it is not the bound one.
            if let other = mainWindowElsewhere(t) {
                CULog.act.notice("key in \(t.appName, privacy: .public): the menu item “\(title, privacy: .public)” would act on another window — not pressed")
                throw CUError.unsupported("\(t.appName)'s menu command “\(title)” acts on its main window, which is another of its windows\(other.isEmpty ? "" : " (\u{201C}\(other)\u{201D})"), and the bound window could not be made main — nothing was done; click what you need in the bound window (state() shows it), or app.requestForeground(reason)")
            }
            do {
                try ax.perform(element, kAXPressAction)
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
            }
            return ActOutcome(rung: .accessibility, detail: "used the menu item “\(title)”")
        case .keyedMenuItem(let element, let title):
            aimMenuCommands(at: t)
            let read: () throws -> AXUIElement? = { [ax] in ax.bool(element, kAXEnabledAttribute) != false ? element : nil }
            let outcome = try pressInBlip(p, t, title: title, read: read, press: { [self] (e: AXUIElement) throws -> String? in
                do {
                    try ax.perform(e, kAXPressAction)
                } catch let error where Self.deliveryUncertain(error) {
                    throw busyAfterSend(t)
                }
                return nil
            })
            if case .pressed = outcome {
                return ActOutcome(rung: .accessibility, detail: "used the menu item “\(title)” with \(t.appName)'s bound window key for a moment (your app kept the front)")
            }
            CULog.act.notice("key in \(t.appName, privacy: .public): “\(title, privacy: .public)” — the bound window could not be made key for it — not pressed")
            throw CUError.unsupported("\(t.appName)'s menu command “\(title)” acts on its key window, which is another of its windows, and the bound window could not be made key for it — nothing was done; click what you need in the bound window (state() shows it), or app.requestForeground(reason)")
        case .blipMenuItem(let element, let title, let fallback):
            aimMenuCommands(at: t)
            let read: () throws -> AXUIElement? = { [ax] in ax.bool(element, kAXEnabledAttribute) == true ? element : nil }
            let outcome = try pressInBlip(p, t, title: title, read: read, press: { [self] (e: AXUIElement) throws -> String? in
                do {
                    try ax.perform(e, kAXPressAction)
                } catch let error where Self.deliveryUncertain(error) {
                    throw busyAfterSend(t)
                }
                return nil
            })
            if case .pressed = outcome {
                return ActOutcome(rung: .accessibility, detail: "used the menu item “\(title)”, re-validated with \(t.appName)'s window key for a moment (your app kept the front)")
            }
            CULog.act.notice("key in \(t.appName, privacy: .public): “\(title, privacy: .public)” stayed disabled — the chord goes as key events")
            return try execute(fallback, p, t, token, keyPid: keyPid, blips: blips)
        case .events(let code, let flags, let d):
            let synth = self.synth(p)
            let pid = keyPid ?? t.pid
            let keys = blips ?? CUKeyBlips(self, p, t, why: "keys")
            defer { if blips == nil { keys.end() } }
            return try runEvents(p, t, d, focus: true, token) { route, _ in
                try keys.before()
                return synth.key(pid: pid, code: code, flags: flags, route: route)
            }
        case .emulated(let command, let f, let fallback):
            if let done = try emulate(command, f, p, t, token, keyPid: keyPid ?? t.pid, blips: blips) { return done }
            CULog.act.notice("key in \(t.appName, privacy: .public): \(command.rawValue, privacy: .public) could not be done over accessibility — sending the keys")
            return try execute(fallback, p, t, token, keyPid: keyPid, blips: blips)
        }
    }

    /// The length of the text a field SHOWS, for a selection or caret range; nil for a page's hidden input
    /// standing in for its document, or a value that is only zero-width filler — a range over the proxy's own
    /// characters selects nothing of the document (the real ⌘A, or a click, does that instead).
    func textLength(_ e: AXUIElement, _ t: CUTarget) -> Int? {
        let value = ax.string(e, kAXValueAttribute) ?? ""
        guard Self.showsText(value), hiddenInputWords(e, t) == nil else { return nil }
        return value.utf16.count
    }

    /// One editing shortcut over accessibility; nil when that can't be done here (the keys are sent instead).
    private func emulate(_ command: EditCommand, _ f: AXUIElement, _ p: TargetActParams, _ t: CUTarget,
                         _ token: CUCancellation.Token, keyPid: pid_t, blips: CUKeyBlips? = nil) throws -> ActOutcome? {
        let keys = blips ?? CUKeyBlips(self, p, t, why: "keys")
        defer { if blips == nil { keys.end() } }
        let note = "in the background \(t.appName)'s web view takes no editing shortcut, so"
        switch command {
        case .undo, .redo:
            // No accessibility equivalent. With the foreground agreed (the card, or the policy), the real
            // shortcut with the app in front; else its Edit item, verified by the field's value; else ask for
            // the foreground — never a silent no-op.
            if p.allowForeground {
                return try inForeground(t) { () -> ActOutcome in
                    let synth = self.synth(p)
                    let flags: CGEventFlags = command == .undo ? .maskCommand : [.maskCommand, .maskShift]
                    synth.key(pid: t.pid, code: CUKeyCodes.code(for: Character("z")) ?? 6, flags: flags, route: .publicPid)
                    return ActOutcome(rung: .foreground, detail: "\(t.appName) was brought forward for the \(command.rawValue), and the front given back after")
                }
            }
            let before = ax.string(f, kAXValueAttribute)
            let mods: CUKeyChord.Modifiers = command == .undo ? [.command] : [.command, .shift]
            if let item = menuItem(forKey: "z", modifiers: mods, pid: t.pid, includeDisabled: true) {
                postSyntheticActivation(t, privatePath: p.privatePath)
                try? ax.perform(item.element, kAXPressAction)
                let deadline = clock.nowMs() + (focusWaitWebMs > 0 ? 500 : 0)
                repeat {
                    if ax.string(f, kAXValueAttribute) != before {
                        CULog.act.notice("key in \(t.appName, privacy: .public): \(command.rawValue, privacy: .public) through its Edit menu item, verified")
                        return ActOutcome(rung: .accessibility, detail: "the \(command.rawValue) was done through \(t.appName)'s Edit › \(item.title) and the field changed")
                    }
                    if clock.nowMs() >= deadline { break }
                    usleep(30_000)
                } while true
            }
            CULog.act.notice("key in \(t.appName, privacy: .public): \(command.rawValue, privacy: .public) took no effect in the background — asking for the foreground")
            throw CUError(code: "needs_foreground",
                          message: "\(t.appName)'s web view takes no \(command == .undo ? "⌘Z" : "⇧⌘Z") in the background, and its Edit › \(command == .undo ? "Undo" : "Redo") changed nothing — that needs \(t.appName) in front")
        case .selectAll:
            guard let length = textLength(f, t), ax.isSettable(f, kAXSelectedTextRangeAttribute),
                  let r = AX.makeRange(location: 0, length: length),
                  (try? ax.set(f, kAXSelectedTextRangeAttribute, r)) != nil else { return nil }
            CULog.act.notice("key in \(t.appName, privacy: .public): select all over accessibility")
            return ActOutcome(rung: .accessibility, detail: "\(note) everything in the field was selected over accessibility")
        case .copy, .cut:
            guard !ElementInfo(f, ax).secure, let text = selectedText(f), !text.isEmpty else { return nil }
            _ = pasteboard().write([["public.utf8-plain-text": Data(text.utf8)]])
            CULog.act.notice("key in \(t.appName, privacy: .public): \(command.rawValue, privacy: .public) of the selection over accessibility")
            guard command == .cut else {
                return ActOutcome(rung: .accessibility, detail: "\(note) the selected text was copied (as plain text)")
            }
            let synth = self.synth(p)
            let d = try CUInputLadder.decideEvents(context(p, t, pointer: false))
            _ = try runEvents(p, t, d, focus: true, token) { route, _ in
                try keys.before()
                return synth.key(pid: keyPid, code: CUKeyCodes.code(for: .delete), flags: [], route: route)
            }
            return ActOutcome(rung: .accessibility, detail: "\(note) the selected text was copied (as plain text) and deleted")
        case .paste:
            return try backgroundWebPaste(f, p, t, token, keyPid: keyPid, keys: keys)
        }
    }

    /// ⌘V into a web field of an app in the background; the clipboard already holds the text (the paste sequence
    /// wrote it and restores it). Neither a key equivalent posted to the app nor its unvalidated Edit item reaches
    /// a background WebKit view, and typing the text as keys cost ~10 ms a character (live: a 3,000-character
    /// paste into Google Docs ran out the script's 30 s). So the REAL paste, in the focus blip: Edit › Paste once
    /// it validates, else ⌘V to the app while its window holds the key focus. Without it: short text is typed;
    /// longer text takes the foreground the user agreed to, or asks for it.
    private func backgroundWebPaste(_ f: AXUIElement, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token,
                                    keyPid: pid_t, keys: CUKeyBlips) throws -> ActOutcome? {
        guard let text = pasteboard().readString(), !text.isEmpty else { return nil }
        try token.check()
        let v = CUKeyCodes.code(for: Character("v")) ?? 9
        if p.allowForeground {
            return try inForeground(t) { () -> ActOutcome in
                self.synth(p).key(pid: t.pid, code: v, flags: .maskCommand, route: .publicPid)
                return ActOutcome(rung: .foreground, detail: "\(t.appName) was brought forward for the paste, and the front given back after")
            }
        }
        aimMenuCommands(at: t)
        keyForMenu(t)
        if let item = menuItem(forKey: "v", modifiers: [.command], pid: t.pid, includeDisabled: true),
           let how = try pasteInBlip(item, p, t) {
            return ActOutcome(rung: .accessibility, detail: how)
        }
        if text.count <= Self.typeKeysMax {
            CULog.act.notice("paste in \(t.appName, privacy: .public): the real paste was not possible — typing the \(text.count, privacy: .public) characters as keys")
            let synth = self.synth(p)
            let d = try CUInputLadder.decideEvents(context(p, t, pointer: false))
            var sent = 0
            let started = clock.nowMs()
            let typed = try typingProgress(text.count, sent: { sent }, t) {
                try runEvents(p, t, d, focus: true, token) { route, _ in
                    try synth.type(pid: keyPid, text: text, route: route, between: { try token.check(); try keys.before() },
                                   posted: { sent = $0 })
                }
            }
            logTypingRate(t, chars: text.count, since: started, what: "paste")
            return typed.noting("in the background \(t.appName)'s web view took no paste, so the clipboard's text was typed in (as plain text)")
        }
        CULog.act.notice("paste in \(t.appName, privacy: .public): the real paste was not possible and \(text.count, privacy: .public) characters are too many to type — asking for the foreground")
        throw CUError(code: "needs_foreground",
                      message: "\(t.appName)'s web page took no paste from the background (its Edit › Paste stayed disabled), and \(text.count) characters are too many to type — the paste needs \(t.appName) in front")
    }

    /// Edit › Paste in the focus blip (at most twice): pressed once it reads enabled; in the second blip, if it
    /// still reads disabled, ⌘V to the app while its window holds the key focus (the key equivalent is validated
    /// as it is handled). The detail for the result, or nil when no blip could run.
    private func pasteInBlip(_ item: (element: AXUIElement, title: String), _ p: TargetActParams, _ t: CUTarget) throws -> String? {
        // ONE blip, long enough for the page to take the paste: the window takes the key focus, then Edit › Paste
        // if it validates, else ⌘V (yesterday's only body paste that landed came by ⌘V) — and the window stays key
        // for `blipPasteHoldMs` while the page reads the clipboard. A desktop switch meanwhile stops it.
        let bound = blipKeySettleMs + blipReadMs + blipPasteHoldMs + 150
        guard let blip = try beginBlip(p, t, why: "“\(item.title)”", boundMs: max(Self.blipDeadlineMs, bound)) else { return nil }
        defer { blip.end() }
        if blipKeySettleMs > 0 { usleep(useconds_t(blipKeySettleMs * 1000)) }
        activateForMenu(p, t)
        var how: String
        let until = clock.nowMs() + blipReadMs
        var enabled = ax.bool(item.element, kAXEnabledAttribute) == true
        while !enabled, clock.nowMs() < until, !blip.isEnded {
            usleep(20_000)
            enabled = ax.bool(item.element, kAXEnabledAttribute) == true
        }
        if enabled {
            CULog.act.notice("paste in \(t.appName, privacy: .public): Edit › \(item.title, privacy: .public) enabled in the focus blip — pressed")
            do {
                try ax.perform(item.element, kAXPressAction)
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
            }
            how = "pasted through \(t.appName)'s Edit › \(item.title) with its window key for a moment (your app kept the front)"
        } else {
            CULog.act.notice("paste in \(t.appName, privacy: .public): Edit › \(item.title, privacy: .public) disabled in the focus blip — ⌘V while its window holds the key focus")
            synth(p).key(pid: t.pid, code: CUKeyCodes.code(for: Character("v")) ?? 9, flags: .maskCommand,
                         route: skyLight.isAvailable ? .skyLight : .publicPid)
            how = "pasted with ⌘V while \(t.appName)'s window held the key focus for a moment (your app kept the front)"
        }
        // Held while the page takes it; a desktop switch stops it at once.
        let hold = clock.nowMs() + blipPasteHoldMs
        repeat {
            if let space = blip.space, let now = sys.activeSpace(), now != space {
                blip.end("the desktop began to switch")
                CULog.act.fault("paste in \(t.appName, privacy: .public): macOS began switching desktops during the paste blip — stopped")
                throw CUError.uncertain("macOS began switching desktops during the paste into \(t.appName), so it was stopped (the user's desktop is being put back); the paste may have landed — check state() before pasting again")
            }
            if clock.nowMs() >= hold || blip.isEnded { break }
            usleep(15_000)
        } while true

        return how
    }

    /// Runs a typing loop. An error after some characters went out says how many (`data.typed`, `data.total`,
    /// and in the message unless it is a cancel, whose words are the daemon's): the field is partly filled.
    func typingProgress<T>(_ total: Int, sent: () -> Int, _ t: CUTarget, _ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch var e as CUError {
            let n = sent()
            guard n > 0 else { throw e }
            var data = e.data ?? [:]
            data["typed"] = .number(Double(n))
            data["total"] = .number(Double(total))
            e.data = data
            if e.code != "cancelled", e.data?["reason"] != .string(CUFloorReason.focusMoved.rawValue) {
                e.message += " — \(n) of \(total) characters had been typed before this"
            }
            CULog.act.notice("typing in \(t.appName, privacy: .public) stopped (\(e.code, privacy: .public)) after \(n, privacy: .public) of \(total, privacy: .public) characters")
            throw e
        }
    }

    /// The measured typing rate, for calibrating the pace (and the daemon's estimate).
    func logTypingRate(_ t: CUTarget, chars: Int, since: Double, what: String) {
        let ms = max(1, clock.nowMs() - since)
        CULog.act.notice("\(what, privacy: .public) in \(t.appName, privacy: .public): \(chars, privacy: .public) characters as keys in \(Int(ms), privacy: .public) ms (\(Int(Double(chars) * 1000 / ms), privacy: .public) chars/s)")
    }

    /// The field's selected text: AXSelectedText, else its value cut by the selected range.
    func selectedText(_ f: AXUIElement) -> String? {
        if let s = ax.string(f, kAXSelectedTextAttribute), !s.isEmpty { return s }
        guard let value = ax.string(f, kAXValueAttribute), let raw = ax.attribute(f, kAXSelectedTextRangeAttribute),
              CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        guard AXValueGetValue(raw as! AXValue, .cfRange, &r), r.length > 0 else { return nil }
        let u = Array(value.utf16)
        guard r.location >= 0, r.location + r.length <= u.count else { return nil }
        return String(utf16CodeUnits: Array(u[r.location..<(r.location + r.length)]), count: r.length)
    }

    /// One chord, start to finish.
    func sendChord(_ chord: CUKeyChord, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token,
                   _ g: TypingFocus = TypingFocus()) throws -> ActOutcome {
        let focused = g.explicit ?? reportedFocus(t)
        return try execute(try chordPlan(chord, p, t, g), p, t, token, keyPid: keyboardTarget(t, focused: focused))
    }

    /// A menu-bar item whose key equivalent is `key` with `modifiers` (command implied). The walk is bounded
    /// in items and time.
    func menuItem(forKey key: Character, modifiers: CUKeyChord.Modifiers, pid: pid_t,
                  includeDisabled: Bool = false) -> (element: AXUIElement, title: String)? {
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
                if mods == wantMods, enabled || includeDisabled {
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
        enforceFocus(p, t)
        let pages = a.pages ?? 1
        guard pages > 0, pages <= 50 else { throw CUError.invalidParams("pages must be between 0 and 50") }
        var point: CGPoint
        var viewport: CGSize
        if let ref = a.ref {
            let e = try element(ref, in: t)
            let info = ElementInfo(e, ax)
            announceTarget(t, info, pressing: false)
            try token.check()
            do {
                if let how = try axScroll(area: scrollArea(from: e), element: e, direction: a.direction, pages: pages) {
                    cursor(t, "scroll", at: info.center, text: a.direction.rawValue)
                    CULog.act.notice("scroll in \(t.appName, privacy: .public): AX \(how, privacy: .public)")
                    return ActOutcome(rung: .accessibility, detail: Self.scrollDetail(how, elsewhere: offScreenSubject(t)))
                }
            } catch let error where Self.deliveryUncertain(error) {
                throw busyAfterSend(t)
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
        if let subject = offScreenSubject(t) {
            let at = try a.ref.map { try element($0, in: t) } ?? elementAt(point, in: t)
            return try scrollElsewhere(at: at, point: point, a.direction, pages: pages, deltaX: dx, deltaY: dy, p, t, token,
                                       subject: subject)
        }
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: true))
        let synth = self.synth(p)
        let windowFor = self.windowFor(t)
        let event = CursorEvent(kind: "scroll", point: point, text: a.direction.rawValue)
        return try runEvents(p, t, d, focus: false, token, cursor: event) { route, check in
            try synth.scroll(pid: t.pid, windowFor: windowFor, at: point, deltaX: dx, deltaY: dy, route: route, check: check)
        }
    }

    /// Scrolling a window on another desktop, with no pointer: the scroll bar's value (AX); else window-
    /// targeted wheel events; and when those visibly moved nothing (the content under the point and the
    /// scroll area's content kept their frames), Page Down/Up (arrows sideways) sent to the app's pid after
    /// focusing the scrolled content — the keyboard needs no geometry.
    private func scrollElsewhere(at e: AXUIElement?, point: CGPoint, _ direction: CUScrollDirection, pages: Double,
                                 deltaX: Double, deltaY: Double,
                                 _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token,
                                 subject: String) throws -> ActOutcome {
        let area = e.flatMap { scrollArea(from: $0) } ?? largestScrollArea(in: t)
        do {
            if let how = try axScroll(area: area, element: e, direction: direction, pages: pages) {
                cursor(t, "scroll", at: point, text: direction.rawValue)
                CULog.act.notice("scroll in \(t.appName, privacy: .public) (off screen): AX \(how, privacy: .public)")
                return ActOutcome(rung: .accessibility, detail: Self.scrollDetail(how, elsewhere: subject))
            }
        } catch let error where Self.deliveryUncertain(error) {
            throw busyAfterSend(t)
        }
        // The wheel, addressed to the window (a last attempt: off screen it may not land). What moved
        // tells whether it landed.
        if p.privatePath, skyLight.canSetWindowLocation {
            let content = area.flatMap { a in ax.elements(a, kAXChildrenAttribute).first { ax.string($0, kAXRoleAttribute) != kAXScrollBarRole } }
            let probes = [e, content].compactMap { $0 }
            let before = probes.map { ax.frame($0) }
            let event = CursorEvent(kind: "scroll", point: point, text: direction.rawValue)
            let wheel = try eventsElsewhere(p, t, token, cursor: event, what: "the scroll", subject: subject) { synth, route in
                try synth.scroll(pid: t.pid, windowFor: { _ in t.windowID }, at: point, deltaX: deltaX, deltaY: deltaY, route: route)
            }
            if probes.isEmpty { return wheel }
            let deadline = clock.nowMs() + 300
            while clock.nowMs() < deadline {
                if probes.map({ ax.frame($0) }) != before {
                    return ActOutcome(rung: wheel.rung, detail: "\(subject): the scroll was sent to that window as wheel events, and its content moved")
                }
                usleep(30_000)
            }
            CULog.act.notice("scroll in \(t.appName, privacy: .public) (off screen): the wheel moved nothing — Page keys")
        }
        if let area {
            // Keys go to the focused element: make it the scrolled content, not a search field.
            let content = ax.elements(area, kAXChildrenAttribute).first { ax.string($0, kAXRoleAttribute) != kAXScrollBarRole }
            for target in [content, area].compactMap({ $0 }) where ax.isSettable(target, kAXFocusedAttribute) {
                focusField(target, t)
                break
            }
        }
        let vertical = direction == .up || direction == .down
        let key: CUNamedKey = direction == .down ? .pageDown : direction == .up ? .pageUp : direction == .left ? .left : .right
        let presses = vertical ? max(1, Int(pages.rounded(.up))) : max(1, Int((pages * 8).rounded(.up)))
        let code = CUKeyCodes.code(for: key)
        let keyPid = keyboardTarget(t, focused: reportedFocus(t))
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: false))
        let synth = self.synth(p)
        let event = p.privatePath && skyLight.canSetWindowLocation ? nil : CursorEvent(kind: "scroll", point: point, text: direction.rawValue)
        let o = try runEvents(p, t, d, focus: true, token, cursor: event) { route, _ in
            var used = route
            for _ in 0..<presses {
                try token.check()
                used = synth.key(pid: keyPid, code: code, flags: [], route: route)
            }
            return used
        }
        let what = vertical ? "\(presses)× \(direction == .down ? "Page Down" : "Page Up")" : "\(presses)× \(direction == .left ? "←" : "→")"
        let why = p.privatePath && skyLight.canSetWindowLocation ? "the wheel moved nothing there" : "wheel events can't be addressed to it"
        return o.noting("\(subject) and \(why), so \(what) was sent to the app")
    }

    /// The window's largest scroll area (the page in a browser), for a scroll with no element under it.
    func largestScrollArea(in t: CUTarget) -> AXUIElement? {
        guard let win = try? windowElement(t) else { return nil }
        var queue = [win]
        var best: (AXUIElement, CGFloat)?
        var seen = 0
        let deadline = CUFloorScan.Deadline(ms: 300)
        while !queue.isEmpty, seen < 800, !deadline.passed {
            let e = queue.removeFirst()
            seen += 1
            if ax.string(e, kAXRoleAttribute) == kAXScrollAreaRole, let f = ax.frame(e) {
                let size = f.width * f.height
                if size > (best?.1 ?? 0) { best = (e, size) }
                continue  // a page's own inner scrollers are not the page
            }
            queue += ax.elements(e, kAXChildrenAttribute)
        }
        return best?.0
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

    /// Rung 1 scrolling, every AX way there is, in order; the name of the one that worked, or nil:
    /// 1. the scroll bar's value, moved by `pages` viewports — when it is settable AND reads back moved;
    /// 2. the scroll bar's page buttons (subroles AXIncrementPage / AXDecrementPage) pressed once per page,
    ///    which needs no event at all;
    /// 3. the element's or the scroll area's own page action, when listed (`AXScrollDownByPage` …).
    /// Throws `busy` when a write or press may have happened.
    func axScroll(area: AXUIElement?, element: AXUIElement?, direction: CUScrollDirection, pages: Double) throws -> String? {
        let vertical = direction == .up || direction == .down
        let forward = direction == .down || direction == .right
        let presses = max(1, Int(pages.rounded(.up)))
        let bar = area.flatMap { ax.element($0, vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute) }
        if let area, let bar {
            switch try scrollBarValue(area: area, bar: bar, vertical: vertical, forward: forward, pages: pages) {
            case .moved: return "scroll bar value"
            case .nothingToScroll: return "nothing left to scroll"
            case .unmoved: break
            }
            let subrole = forward ? "AXIncrementPage" : "AXDecrementPage"
            if let button = ax.elements(bar, kAXChildrenAttribute).first(where: { ax.string($0, kAXSubroleAttribute) == subrole }),
               try pressTimes(button, kAXPressAction, presses) {
                return "the scroll bar's page button ×\(presses)"
            }
        }
        let action = "AXScroll" + (direction == .down ? "Down" : direction == .up ? "Up" : direction == .left ? "Left" : "Right") + "ByPage"
        for e in [element, area].compactMap({ $0 }) where ax.actions(e).contains(action) {
            if try pressTimes(e, action, presses) { return "\(action) ×\(presses)" }
        }
        return nil
    }

    enum ScrollBarResult { case moved, nothingToScroll, unmoved }

    /// The act's detail for an AX scroll (`elsewhere`: "X's window is on another desktop", when it is not on screen).
    static func scrollDetail(_ how: String, elsewhere app: String?) -> String? {
        let prefix = app.map { "\($0), so " } ?? ""
        switch how {
        case "nothing left to scroll": return "there was nothing left to scroll that way"
        case "scroll bar value": return app == nil ? nil : prefix + "its scroll bar was moved over accessibility"
        default: return prefix + "it was scrolled with \(how) over accessibility"
        }
    }

    /// The scroll bar's value moved by `pages` viewports, and read back to prove it moved.
    private func scrollBarValue(area: AXUIElement, bar: AXUIElement, vertical: Bool, forward: Bool,
                                pages: Double) throws -> ScrollBarResult {
        guard ax.isSettable(bar, kAXValueAttribute),
              let raw = ax.attribute(bar, kAXValueAttribute), let value = (raw as? NSNumber)?.doubleValue,
              let viewport = ax.frame(area),
              let content = ax.elements(area, kAXChildrenAttribute).first(where: { ax.string($0, kAXRoleAttribute) != kAXScrollBarRole })
                .flatMap({ ax.frame($0) })
        else { return .unmoved }
        let view = vertical ? viewport.height : viewport.width
        let total = vertical ? content.height : content.width
        guard total > view + 1 else { return .nothingToScroll }
        let step = pages * 0.9 * view / (total - view)
        let next = min(1, max(0, value + (forward ? step : -step)))
        if next == value { return .nothingToScroll }
        do {
            try ax.set(bar, kAXValueAttribute, NSNumber(value: next))
        } catch let error where Self.deliveryUncertain(error) {
            throw error
        } catch {
            return .unmoved
        }
        // Some apps accept the write and ignore it: only a value that changed counts.
        let after = ax.attribute(bar, kAXValueAttribute).flatMap { ($0 as? NSNumber)?.doubleValue }
        return after.map { abs($0 - value) > 0.000_1 } == true ? .moved : .unmoved
    }

    /// `action` on `e`, `times` times; false when the first is refused.
    private func pressTimes(_ e: AXUIElement, _ action: String, _ times: Int) throws -> Bool {
        for i in 0..<times {
            do {
                try ax.perform(e, action)
            } catch let error where Self.deliveryUncertain(error) {
                throw error
            } catch {
                if i == 0 { return false }
                return true
            }
        }
        return true
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
        if let subject = offScreenSubject(t) {
            if let fromInfo { announceTarget(t, fromInfo, pressing: false) }
            return try eventsElsewhere(p, t, token, cursor: CursorEvent(kind: "drag", point: from, dragTo: to), what: "the drag",
                                       subject: subject) { synth, route in
                try synth.drag(pid: t.pid, windowFor: { _ in t.windowID }, from: from, to: to, route: route)
            }
        }
        let d = try CUInputLadder.decideEvents(context(p, t, pointer: true))
        if let fromInfo { announceTarget(t, fromInfo, pressing: false) }
        let synth = self.synth(p)
        let windowFor = self.windowFor(t)
        let event = CursorEvent(kind: "drag", point: from, dragTo: to)
        return try runEvents(p, t, d, focus: true, token, cursor: event) { route, check in
            try synth.drag(pid: t.pid, windowFor: windowFor, from: from, to: to, route: route, check: check)
        }
    }

    // MARK: select, action, menu

    private func select(_ a: CUSelectAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        enforceFocus(p, t)
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e, ax)
        if info.secure { throw secureRefusal() }
        t.noteTargeted(e, at: clock.nowMs())  // the element holding the selection a menu command may act on
        guard let value = ax.string(e, kAXValueAttribute) else { throw CUError.unsupported("[\(a.ref)] has no text to select") }
        guard let range = Self.selectionRange(in: value, text: a.text, before: a.before, after: a.after, caret: a.caret) else {
            throw CUError.invalidParams("“\(a.text)” is not in [\(a.ref)]\(a.before != nil || a.after != nil ? " with that context" : "")")
        }
        guard ax.isSettable(e, kAXSelectedTextRangeAttribute), let r = AX.makeRange(location: range.location, length: range.length)
        else { throw CUError.unsupported("[\(a.ref)] does not support selecting text") }
        announceTarget(t, info, pressing: false)
        cursor(t, "press", at: info.center, count: 1, button: "left")
        try token.check()
        focusField(e, t)
        do {
            try ax.set(e, kAXSelectedTextRangeAttribute, r)
        } catch let error where Self.deliveryUncertain(error) {
            throw busyAfterSend(t)
        }
        // What a selection-dependent menu command will act on — checked again before one is validated.
        t.noteSelection(e, location: range.location, length: range.length, value: value, at: clock.nowMs())
        holdSelection(e, range, t, what: "select")
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
        // Opening a Finder item is a background NSWorkspace open of its file, never a Finder open event.
        if t.bundleId == "com.apple.finder", CUMenuWalker.normalize(a.name) == "open", let path = finderItemPath(e) {
            return try pendingBackgroundOpen([path], what: nil)
        }
        try requireEnabled(info, ref: a.ref, t)
        guard let name = CURoleWords.resolveAction(a.name, among: info.actions) else {
            let have = info.actions.map(CURoleWords.actionWords).joined(separator: ", ")
            throw CUError.invalidParams("[\(a.ref)] has no action “\(a.name)” — it has: \(have.isEmpty ? "none" : have)")
        }
        // Raising a window puts it in front of the user's work and can switch them to its desktop: never done.
        if name == kAXRaiseAction {
            throw CUError.unsupported("raising a window brings it in front of the user's work and can switch their desktop, so Winter doesn't — the window doesn't need to be in front: act on its elements by ref")
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
            let before = pressEvidence(e, t)
            do {
                try ax.perform(e, name)
                return ActOutcome(rung: .accessibility)
            } catch let error where Self.pressMayHaveActed(error) != nil {
                let note = try judgeErroredPress(e, t, before: before, code: Self.pressMayHaveActed(error)!, what: "“\(words)” on [\(a.ref)]")
                return ActOutcome(rung: .accessibility, detail: note)
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
        return try pointerClick(p, t, at: center, button: pointer.button, count: pointer.count, flags: [], token, announced: same,
                                element: e, axTried: true)
            .noting("\(t.appName) refused “\(words)” over accessibility, so [\(a.ref)] was \(pointer.verb) instead")
    }

    /// What a press can change, read before it so a press the app answered with an error can be judged.
    struct PressEvidence: Equatable {
        var windows: Set<UInt32>
        var focused: AXIdentity?
        var value: String?
        var alive: Bool
    }

    func pressEvidence(_ e: AXUIElement, _ t: CUTarget) -> PressEvidence {
        PressEvidence(windows: Set(sys.windows(pid: t.pid).filter { $0.layer == 0 }.map(\.id)),
                      focused: ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute).map { AXIdentity(element: $0) },
                      value: ax.string(e, kAXValueAttribute), alive: ax.isAlive(e))
    }

    /// The AX error of a press that may have acted anyway: -25200 (kAXErrorFailure) — a live fixture opened its
    /// document window and still answered it — and -25204 (cannot complete: no answer in time). Nil for an
    /// outright refusal (unsupported, not implemented), which did nothing.
    static func pressMayHaveActed(_ error: Error) -> Int? {
        guard let e = error as? CUError else { return nil }
        if e.code == "busy" { return Int(AXError.cannotComplete.rawValue) }
        if e.code == "unsupported", case .number(let n)? = e.data?["axError"], Int32(n) == AXError.failure.rawValue { return Int(n) }
        return nil
    }

    /// A press the app answered with -25200/-25204: did it act? Something changed (a new or closed window, the
    /// element's value, the focus, the element gone) → it took effect, said with a note so the model does not
    /// press again. Nothing changed → an error that says it may have acted — never a second press here.
    func judgeErroredPress(_ e: AXUIElement, _ t: CUTarget, before: PressEvidence, code: Int, what: String) throws -> String {
        let deadline = clock.nowMs() + pressSettleMs
        var after = pressEvidence(e, t)
        while after == before, clock.nowMs() < deadline {
            usleep(50_000)
            after = pressEvidence(e, t)
        }
        guard after != before else {
            CULog.act.notice("\(what, privacy: .public) in \(t.appName, privacy: .public): AXError \(code, privacy: .public), and nothing visibly changed")
            throw CUError.uncertain("\(t.appName) answered \(what) with an error (AXError \(code)) but may have acted — check state() before retrying",
                                    axError: code)
        }
        var changed: [String] = []
        if !after.windows.subtracting(before.windows).isEmpty { changed.append("a new window opened") }
        if !before.windows.subtracting(after.windows).isEmpty { changed.append("a window closed") }
        if after.value != before.value { changed.append("its value changed") }
        if after.focused != before.focused { changed.append("the focus moved") }
        if before.alive, !after.alive { changed.append("the element went away") }
        CULog.act.notice("\(what, privacy: .public) in \(t.appName, privacy: .public): AXError \(code, privacy: .public), but it took effect")
        return "\(t.appName) answered \(what) with an error (AXError \(code)), but it took effect — \(changed.joined(separator: ", ")); don't repeat it"
    }

    // MARK: verified presses on web content

    /// What a press on web content can visibly change. Google Docs' widgets act on a real mouse press: an
    /// accessibility press (a simulated DOM click) is accepted and ignored, and nothing says so — the model loops.
    struct WebPressEvidence: Equatable {
        var windows: Set<UInt32>
        var focused: AXIdentity?
        var alive: Bool
        var value: String?
        var selected: Bool?
        var expanded: Bool?
        var title: String?
        var frame: CGRect?
        /// The children of its parent and grandparent: a structural change near it (a panel closed, a list grew).
        var near: [AXIdentity]
        /// The page (URL, window title): a link that navigates changes it before its element goes away.
        var page: PageSignature?
    }

    func webPressEvidence(_ e: AXUIElement, _ t: CUTarget) -> WebPressEvidence {
        let parent = ax.element(e, kAXParentAttribute)
        let grand = parent.flatMap { ax.element($0, kAXParentAttribute) }
        let near = [parent, grand].compactMap { $0 }.flatMap { ax.elements($0, kAXChildrenAttribute) }.map { AXIdentity(element: $0) }
        return WebPressEvidence(windows: Set(sys.windows(pid: t.pid).filter { $0.layer == 0 }.map(\.id)),
                                focused: ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute).map { AXIdentity(element: $0) },
                                alive: ax.isAlive(e), value: ax.string(e, kAXValueAttribute),
                                selected: ax.bool(e, kAXSelectedAttribute), expanded: ax.bool(e, kAXExpandedAttribute),
                                title: ax.string(e, kAXTitleAttribute) ?? ax.string(e, kAXDescriptionAttribute),
                                frame: ax.frame(e), near: near, page: pageSignature(t))
    }

    /// Whether anything changed since `before`, watched for up to `webPressWatchMs` (the element gone or moved or
    /// hidden, its value / selected / expanded / title, a window opened or closed, the focus, the tree near it).
    func webPressChanged(_ e: AXUIElement, _ t: CUTarget, since before: WebPressEvidence) -> Bool {
        let deadline = clock.nowMs() + webPressWatchMs
        repeat {
            if webPressEvidence(e, t) != before { return true }
            if clock.nowMs() >= deadline { return false }
            usleep(50_000)
        } while true
    }

    /// `[15] “Close”` (or the role when it has no name).
    static func elementLabel(_ ref: Int?, _ info: ElementInfo) -> String {
        let name = info.labels.compactMap { $0 }.first { !$0.isEmpty }.map { "\u{201C}\($0.prefix(40))\u{201D}" }
        let role = CURoleWords.words(role: info.role ?? "AXUnknown", subrole: info.subrole)
        return [ref.map { "[\($0)]" }, name ?? role].compactMap { $0 }.joined(separator: " ")
    }

    /// A command that may act without showing anything at once (it sends, pays, deletes…): an accessibility press
    /// that changed nothing visible is NOT followed by a click — that could do it twice.
    static func mayActUnseen(_ labels: [String?]) -> Bool {
        let words = labels.compactMap { $0 }.joined(separator: " ").lowercased()
        let pattern = #"\b(send|submit|post|publish|pay|buy|order|purchase|checkout|delete|remove|trash|confirm|transfer|sign|invite|upload)\b"#
        return words.range(of: pattern, options: .regularExpression) != nil
    }

    static func unseenPressNote(_ label: String) -> String {
        "the accessibility press on \(label) had no visible effect — a command like this may still act without showing it at once, so it was not clicked as well; check state() before pressing again"
    }

    /// After an accessibility press on web content: something changed → done; nothing → a window-targeted click
    /// at its centre (unless a repeat could do harm), itself verified.
    /// After an accessibility press on web content that accessibility shows no effect of, the fallback click is
    /// CONSERVATIVE — on a page whose effect accessibility can't see, a second action would undo or double the
    /// first (a toggle flips back, a like is withdrawn, an item goes into the cart twice). It is clicked only when
    /// none of these holds: a name that may act unseen (send, pay, delete, …); a toggle-like control whose state
    /// can't be read; a window not on screen (its pixels may be stale); no capture to compare; or its pixels
    /// changed (the press did something: said so, not repeated).
    private func verifyWebPress(_ e: AXUIElement, _ info: ElementInfo, ref: Int, before: WebPressEvidence,
                                crop: CGRect?, shotBefore: CGImage?,
                                _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        if webPressChanged(e, t, since: before) { return ActOutcome(rung: .accessibility) }
        let label = Self.elementLabel(ref, info)
        if Self.mayActUnseen(info.labels) {
            CULog.act.notice("click in \(t.appName, privacy: .public): the accessibility press changed nothing visible, and the command may act unseen — not clicked as well")
            return ActOutcome(rung: .accessibility, detail: Self.unseenPressNote(label))
        }
        if statefulWithoutReadableState(e, info) {
            CULog.act.notice("click in \(t.appName, privacy: .public): a toggle-like control with no readable state — not clicked as well")
            return ActOutcome(rung: .accessibility, detail: "the accessibility press on \(label) showed no change accessibility can see, and a second press could undo it (it holds a state accessibility doesn't show) — check state() or a screenshot before pressing again")
        }
        if offScreenSubject(t) != nil {
            CULog.act.notice("click in \(t.appName, privacy: .public): no visible effect, and the window is not on screen — not clicked as well")
            return ActOutcome(rung: .accessibility, detail: Self.noEffectNote(label))
        }
        guard let crop, let shotBefore, let shotAfter = pressShot(crop, t) else {
            CULog.act.notice("click in \(t.appName, privacy: .public): no visible effect and no capture to compare — not clicked as well")
            return ActOutcome(rung: .accessibility, detail: Self.noEffectNote(label))
        }
        if CUImageTools.differs(shotBefore, shotAfter) {
            CULog.act.notice("click in \(t.appName, privacy: .public): the press changed pixels but nothing accessibility can see — pressed, not clicked as well")
            return ActOutcome(rung: .accessibility, detail: "pressed \(label) (the effect is visible but not to accessibility)")
        }
        CULog.act.notice("click in \(t.appName, privacy: .public): the accessibility press on web content changed nothing, not even pixels — a window-targeted click instead")
        return try clickWebElement(e, info, ref: ref, p, t, token, pressIgnored: true, why: "the accessibility press did nothing")
    }

    static func noEffectNote(_ label: String) -> String {
        "the accessibility press on \(label) had no effect accessibility can see — check state() or a screenshot before pressing again"
    }

    /// Toggle-like and stateful controls — checkbox, switch, toggle, radio button, tab, disclosure, a menu item with
    /// a check mark — whose state can't be read: a second press could undo the first, so no fallback click. One
    /// whose value / selected / expanded reads (and stayed the same) may be.
    func statefulWithoutReadableState(_ e: AXUIElement, _ info: ElementInfo) -> Bool {
        let role = info.role ?? "", sub = info.subrole ?? ""
        let toggleLike = ["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle", "AXDisclosureTriangle", "AXTab"].contains(role)
            || ["AXToggle", "AXSwitch", "AXTabButton"].contains(sub)
            || (role == kAXMenuItemRole && ax.attribute(e, kAXMenuItemMarkCharAttribute) != nil)
        guard toggleLike else { return false }
        let readable = ax.attribute(e, kAXValueAttribute) != nil || ax.bool(e, kAXSelectedAttribute) != nil
            || ax.bool(e, kAXExpandedAttribute) != nil
        return !readable
    }

    /// The area a press's visible effect shows in: the element, with its parent row when that is small (a list
    /// row, a toolbar), else the element with a margin — within the window. Nil when it has no frame.
    func pressCrop(_ e: AXUIElement, _ info: ElementInfo, _ t: CUTarget) -> CGRect? {
        guard let f = ax.frame(e), f.width > 0, f.height > 0 else { return nil }
        var rect = f.insetBy(dx: -12, dy: -8)
        if let parent = ax.element(e, kAXParentAttribute), let pf = ax.frame(parent),
           pf.width * pf.height <= max(4 * f.width * f.height, 400 * 120) {
            rect = rect.union(pf)
        }
        if let window = sys.window(id: t.windowID)?.frame { rect = rect.intersection(window) }
        return rect.isNull || rect.isEmpty ? nil : rect
    }

    /// The window server's picture of `rect` (global points) of the bound window, when it is on screen and one can
    /// be had (Screen Recording granted, not blank); nil otherwise.
    func pressShot(_ rect: CGRect, _ t: CUTarget) -> CGImage? {
        guard sys.window(id: t.windowID)?.onScreen == true, let image = try? privateWindowImage(t.windowID, globalRect: rect),
              !CUImageTools.isBlank(image) else { return nil }
        return image
    }

    /// A window-targeted left click at the element's centre, after the synthetic activation (an inactive window
    /// may take a first click as activation only; no focus blip — a click needs no key focus), verified.
    private func clickWebElement(_ e: AXUIElement, _ info: ElementInfo, ref: Int, _ p: TargetActParams, _ t: CUTarget,
                                 _ token: CUCancellation.Token, pressIgnored: Bool, why: String) throws -> ActOutcome {
        guard let center = clickablePoint(e, info, t) else {
            throw CUError.unsupported("[\(ref)] is outside the window and could not be scrolled into view — scroll to it first")
        }
        return try webClickVerified(e, t, pressIgnored: pressIgnored, why: why, label: Self.elementLabel(ref, info)) {
            enforceFocus(p, t)
            return try pointerClick(p, t, at: center, button: .left, count: 1, flags: [], token, announced: true,
                                    element: e, axTried: true)
        }
    }

    /// Runs `click`, then says what it did: the effect seen (the app's web content ignored the press: counted,
    /// see `prefersWebClicks`), or plainly that nothing changed that accessibility can see — never a silent success.
    func webClickVerified(_ e: AXUIElement, _ t: CUTarget, pressIgnored: Bool, why: String, label: String,
                          _ click: () throws -> ActOutcome) throws -> ActOutcome {
        let before = webPressEvidence(e, t)
        let o = try click()
        if webPressChanged(e, t, since: before) {
            if pressIgnored { noteWebPressIgnored(t) }
            CULog.act.notice("click in \(t.appName, privacy: .public): the window-targeted click took effect")
            return o.noting(pressIgnored ? "\(why); clicked it instead" : "\(why), so \(label) was clicked")
        }
        CULog.act.notice("click in \(t.appName, privacy: .public): nothing changed after the window-targeted click either")
        return o.noting("\(why); clicked \(label), and nothing changed that accessibility can see — check with state() or a screenshot")
    }

    /// The app answered that the element does not support the action (not a timeout or a dead element).
    static func refusedAction(_ e: CUError) -> Bool {
        guard e.code == "unsupported", case .number(let n)? = e.data?["axError"] else { return false }
        return [AXError.actionUnsupported.rawValue, AXError.notImplemented.rawValue].contains(Int32(n))
    }

    /// A menu-bar command, through the UI (an AX press of the menu item). The menu bar validates commands
    /// against the app's ACTIVE window, so while the app is in the background one can be disabled for the bound
    /// window even with that window made key (Finder's File › Move to Trash). Then the answer names the UI routes
    /// that validate against the item itself — its context menu, the window's toolbar or Action menu, the
    /// shortcut after background key focus — and only asking for the same command again asks for the
    /// foreground (`needs_foreground`: with the user's consent the app comes forward for the command, and the
    /// front is given back after). The app is never made front in the background: that switches the user to
    /// the Space its windows are on.
    private func menu(_ a: CUMenuAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        // A menu command has no on-screen point in the background: a caption only, no press.
        cursor(t, "caption", text: Self.caption("Choosing", a.path.joined(separator: " › ")))
        try token.check()
        // Finder's Open (File › Open, or Open on the selection) opens the selected items in the background
        // (NSWorkspace activates:false), never a Finder open event that would bring the opener to the front.
        if let open = try finderOpenRoute(a.path, p, t) { return open }
        // A web app's own menu bar, inside the page (the app's menu bar has no such menu): real clicks, verified.
        if let page = try pageMenuIfNotInMenuBar(a, t, token) { return page }
        let key = a.path.map(CUMenuWalker.normalize).joined(separator: "\u{1F}")
        if p.allowForeground {
            return try inForeground(t) {
                do {
                    try pressMenu(try resolveMenu(a, p, t), t)
                } catch let e as CUError where e.data?["disabled"] != nil {
                    throw CUError.unsupported("\(e.message), even with \(t.appName) in front — nothing it applies to is selected (check state())")
                }
                t.disabledMenuCommands.remove(key)
                return ActOutcome(rung: .foreground, detail: "\(t.appName) was brought forward for the command, and the front given back after")
            }
        }
        aimMenuCommands(at: t)
        // The menu bar validates commands against the app's KEY window (live: the fixture's web window stayed
        // key after typing there), and in the background re-validates a command only in the focus blip; and the
        // selection a command acts on can have been moved by a focus click the app handled late. Checked, put
        // right and logged step by step.
        var blipped = false
        let note: String?
        do {
            note = try pressBackgroundMenu(a, p, t, blipped: &blipped)
        } catch let e as CUError where e.data?["disabled"] != nil {
            // In front already: disabled for what it applies to, not for being in the background.
            guard sys.frontmostPid() != t.pid else { throw e }
            let title: String = { if case .string(let s)? = e.data?["disabled"] { return s }; return a.path.last ?? "" }()
            if t.disabledMenuCommands.contains(key) {
                CULog.act.notice("menu in \(t.appName, privacy: .public): asked again while disabled in the background — asking for the foreground")
                throw CUError(code: "needs_foreground",
                              message: "“\(title)” stays disabled while \(t.appName) is in the background\(blipped ? ", even with its window made key" : ""), and it was asked for again after the UI routes: the command needs \(t.appName) in front")
            }
            // A known AppleScript equivalent, when the user already lets Winter control the app.
            if let done = menuThroughAppleScript(a.path, title: title, t) { return done }
            t.disabledMenuCommands.insert(key)
            CULog.act.notice("menu in \(t.appName, privacy: .public): disabled in the background — pointing at the UI routes")
            throw CUError(code: "unsupported", message: backgroundMenuRoutes(title: title, path: a.path, t),
                          data: ["disabled": .string(title)])
        }
        t.disabledMenuCommands.remove(key)
        let made = blipped ? "\(t.appName)'s window was made key for a moment to re-validate the command (your app kept the front)" : nil
        let detail = [made, note].compactMap { $0 }.joined(separator: "; ")
        return ActOutcome(rung: .accessibility, detail: detail.isEmpty ? nil : detail)
    }

    /// What to do about a menu command disabled in the background: the UI routes that check the item itself,
    /// then `menu()` again for the foreground.
    func backgroundMenuRoutes(title: String, path: [String], _ t: CUTarget) -> String {
        let item = (try? CUAXMenuNode.menuBar(pid: t.pid, ax: ax)).flatMap { try? CUMenuWalker.resolve(path, in: $0, requireEnabled: false) }
        let attrs = item.flatMap {
            ax.copyMultiple($0.element, [kAXMenuItemCmdCharAttribute, kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdModifiersAttribute])
        } ?? [:]
        let combo = Self.shortcutCombo(char: attrs[kAXMenuItemCmdCharAttribute].flatMap(AX.stringValue),
                                       virtualKey: attrs[kAXMenuItemCmdVirtualKeyAttribute].flatMap { ($0 as? NSNumber)?.intValue },
                                       modifiers: attrs[kAXMenuItemCmdModifiersAttribute].flatMap { ($0 as? NSNumber)?.intValue })
        let shortcut = combo.map { "its shortcut key(\"\($0)\")" } ?? "its shortcut with key()"
        let script = knownMenuScript(path, t) != nil || appIsScriptable(t)
            ? ", or app.applescript() (macOS asks the user once to let Winter control \(t.appName))" : ""
        return "“\(title)” is disabled while \(t.appName) is in the background (its menu bar checks its active window). "
            + "Use a route that checks the item itself: its context menu (action(ref, \"showMenu\") on the selected item, "
            + "then click “\(title)” in the menu state() lists first), the window's toolbar or Action menu, \(shortcut)\(script). "
            + "Only if those are disabled too, call menu() again to ask for \(t.appName) in front"
    }

    /// The app has a scripting dictionary (read from its bundle, cached).
    func appIsScriptable(_ t: CUTarget) -> Bool {
        if let o = scriptingDictionaryOverride { return o(t) != nil }
        return NSRunningApplication(processIdentifier: t.pid)?.bundleURL.flatMap { CUScriptingDictionary.model(appURL: $0) } != nil
    }

    /// A menu item's key equivalent as a `key()` combo (`AXMenuItemCmdModifiers`: 1 shift, 2 option, 4 control,
    /// 8 no command), or nil when it has none or one `key()` can't name. Pure.
    static func shortcutCombo(char: String?, virtualKey: Int?, modifiers: Int?) -> String? {
        let named: [Int: String] = [0x33: "delete", 0x75: "forwarddelete", 0x24: "return", 0x30: "tab", 0x31: "space",
                                    0x35: "escape", 0x7B: "left", 0x7C: "right", 0x7D: "down", 0x7E: "up",
                                    0x73: "home", 0x77: "end", 0x74: "pageup", 0x79: "pagedown"]
        let keyName: String
        if let c = char, let scalar = c.unicodeScalars.first, c.unicodeScalars.count == 1,
           scalar.value > 0x20, scalar.value != 0x7F, !(0xF700...0xF8FF).contains(scalar.value) {
            keyName = c.lowercased()
        } else if let v = virtualKey, let n = named[v] {
            keyName = n
        } else if let c = char, c == "\u{8}" || c == "\u{7F}" {
            keyName = "delete"
        } else {
            return nil
        }
        let m = modifiers ?? 0
        var parts: [String] = []
        if m & 8 == 0 { parts.append("cmd") }
        if m & 4 != 0 { parts.append("ctrl") }
        if m & 2 != 0 { parts.append("option") }
        if m & 1 != 0 { parts.append("shift") }
        guard !parts.isEmpty else { return nil }  // a bare key is not a command shortcut
        return (parts + [keyName]).joined(separator: "+")
    }

    private func resolveMenu(_ a: CUMenuAction, _ p: TargetActParams, _ t: CUTarget) throws -> CUAXMenuNode {
        let item = try CUMenuWalker.resolve(a.path, in: try CUAXMenuNode.menuBar(pid: t.pid, ax: ax))
        let attrs = ax.copyMultiple(item.element, [kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute]) ?? [:]
        if CUPasteMenu.isPasteItem(title: item.menuTitle, cmdChar: attrs[kAXMenuItemCmdCharAttribute].flatMap(AX.stringValue),
                                   cmdModifiers: attrs[kAXMenuItemCmdModifiersAttribute].flatMap { ($0 as? NSNumber)?.intValue }) {
            try requirePasteSafe(p, t)
        }
        return item
    }

    /// Presses a menu item; a note when the app answered with an error but the command took effect.
    @discardableResult
    private func pressMenu(_ item: CUAXMenuNode, _ t: CUTarget) throws -> String? {
        let before = pressEvidence(item.element, t)
        do {
            try ax.perform(item.element, kAXPressAction)
            return nil
        } catch let error where Self.pressMayHaveActed(error) != nil {
            return try judgeErroredPress(item.element, t, before: before, code: Self.pressMayHaveActed(error)!,
                                         what: "the menu command “\(item.menuTitle)”")
        }
    }

    /// Controls a press means something to; a disabled one of these does nothing, so it is refused rather than
    /// pressed "successfully" (a live run pressed Finder's disabled "Move to Trash" three times to no effect).
    /// Containers are exempt: apps mark whole groups disabled (Finder's icon-view groups) around live items.
    static let pressableRoles: Set<String> = [
        "AXButton", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton",
        "AXLink", "AXDisclosureTriangle", "AXIncrementor", "AXSwitch", "AXToggle", "AXTab", "AXComboBox",
    ]

    func requireEnabled(_ info: ElementInfo, ref: Int, _ t: CUTarget) throws {
        guard info.enabled == false, let role = info.role, Self.pressableRoles.contains(role) else { return }
        let name = (info.labels.first ?? nil).flatMap { $0.isEmpty ? nil : " \u{201C}\($0.prefix(60))\u{201D}" } ?? ""
        let why = role == "AXMenuItem" || role == "AXMenuBarItem"
            ? " — \(t.appName) enables menu commands for its active window and what is selected in it; while it is in the background the command may not apply to the bound window"
            : " — it does nothing until \(t.appName) enables it"
        throw CUError.unsupported("[\(ref)]\(name) is disabled right now\(why)")
    }

    /// Menu commands (the menu bar, or a shortcut that is a menu item) act on the app's main/key window, which
    /// need not be the bound one when the app is in the background: Finder's Go › Downloads opened a NEW window
    /// instead of moving the bound one. Making the bound window the app's main window first points them at it.
    func aimMenuCommands(at t: CUTarget) { makeBoundWindowMain(t) }

    /// The title of the app's main window when it is provably ANOTHER window than the bound one ("" when it has
    /// none); nil when it is the bound one, or can't be told.
    func mainWindowElsewhere(_ t: CUTarget) -> String? {
        guard t.accessible, let w = try? windowElement(t) else { return nil }
        if ax.bool(w, kAXMainAttribute) == true { return nil }
        guard let main = ax.element(ax.application(t.pid), kAXMainWindowAttribute) else { return nil }
        if let id = ax.windowID(main) { return id == t.windowID ? nil : (ax.string(main, kAXTitleAttribute) ?? "") }
        return CFEqual(main, w) ? nil : (ax.string(main, kAXTitleAttribute) ?? "")
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
            // No focus records here (the user's ruling: the focus blip is for menu validation only, never for
            // typing, clicks or reads): window-targeted events after the synthetic activation.
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
    private func syntheticFocus(_ t: CUTarget) { makeBoundWindowMain(t) }

    /// Rung 4: bring the app forward, act with the real pointer, then put the pointer and the user's app back.
    /// Every press, drag step and release is hit-tested by the caller's check.
    private func inForeground<T>(_ t: CUTarget, _ body: () throws -> T) throws -> T {
        // Bringing an app forward whose window is on ANOTHER desktop takes the user there: never without their
        // say for a desktop visit (user ruling 2026-10-10) — not with `allowForeground`, not for a held app.
        // Inside a visit the window is on screen already.
        if !isVisiting(t), isOffThisDesktop(t) {
            CULog.act.notice("foreground in \(t.appName, privacy: .public): its window is on another desktop — not brought forward without the user's say for a visit")
            throw CUError.needsDesktopVisit(t.appName, why: .act)
        }
        // The user agreed to this act taking the foreground: the user-view guard and the Focus Guardian leave
        // it alone, for this one action.
        t.consentedForeground = true
        guardianExempt(t.pid)
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
    /// `AXEnabled`; nil when the element doesn't say.
    var enabled: Bool?

    static let attributes: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXTitleAttribute,
        kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXIdentifierAttribute, "AXDOMIdentifier",
        kAXEnabledAttribute,
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
        enabled = a[kAXEnabledAttribute].flatMap(AX.boolValue)
        actions = ax.actions(e)
    }

    /// A password or payment field (never read, never typed into).
    var secure: Bool { CUFloors.isSensitiveField(role: role ?? "", subrole: subrole, texts: labels) }
    var center: CGPoint? {
        guard let f = frame, f.width > 0 || f.height > 0 else { return nil }
        return CGPoint(x: f.midX, y: f.midY)
    }
}
