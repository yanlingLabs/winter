import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// `target.act`: every action walks the input ladder (spec §8) —
/// 1. AX actions and attribute writes (`AXPress`, `AXValue`, `AXSelectedText`, menu items), no focus needed;
/// 2. events posted to the target pid, with public synthetic focus;
/// 3. SkyLight events plus focus-without-raise for Chromium/Electron (`privatePath`);
/// 4. the foreground and the real pointer, only with `allowForeground`.
/// The floors (§2.4) run before anything reaches the app.
extension CUCore {
    struct ActOutcome {
        var rung: CUInputLadder.Rung
        var detail: String?
    }

    public func targetAct(_ p: TargetActParams) async throws -> TargetActResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        try ensureAlive(t)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        try token.check()
        if p.access == .click {
            switch p.action {
            case .click, .scroll, .action: break
            default:
                throw CUError.notAllowed("click_only",
                                         "\(t.appName) is set to click only in Settings — it allows clicks, scrolls and actions")
            }
        }
        if case .key(let k) = p.action, (try? CUKeyChord.parse(k.combo))?.isEscape == true {
            await MainActor.run { [weak self] in self?.events?.willSendEscape() }
        }
        let outcome = try await queues.run(t.pid) { [self] () -> ActOutcome in
            try floorCheckPrivacy(t)
            do {
                let o = try perform(p, on: t, token: token)
                t.lastActionMs = clock.nowMs()
                return o
            } catch let e as CUError where e.code == "stale_element" {
                if let ref = Self.primaryRef(p.action) { t.refs.forget(ref); throw CUError.staleRef(ref) }
                throw CUError.targetLost("the \(t.appName) window changed under the action — call state()")
            }
        }
        return TargetActResult(rung: outcome.rung.rawValue, detail: outcome.detail)
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

    // MARK: dispatch (pid queue)

    func perform(_ p: TargetActParams, on t: CUTarget, token: CUCancellation.Token) throws -> ActOutcome {
        switch p.action {
        case .click(let a): return try click(a, p, t)
        case .setValue(let a): return try setValue(a, p, t, token)
        case .type(let a): return try type(a, p, t, token)
        case .paste(let a): return try paste(a, p, t, token)
        case .key(let a): return try key(a, p, t, token)
        case .scroll(let a): return try scroll(a, p, t)
        case .drag(let a): return try drag(a, p, t)
        case .select(let a): return try select(a, p, t)
        case .action(let a): return try axAction(a, p, t)
        case .menu(let a): return try menu(a, t)
        }
    }

    // MARK: click

    private func click(_ a: CUClickAction, _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome {
        let button = a.button ?? .left
        let count = a.count ?? 1
        guard (1...3).contains(count) else { throw CUError.invalidParams("count must be 1, 2 or 3") }
        let flags = try cuModifierFlags(a.modifiers)
        if let ref = a.ref {
            guard a.point == nil else { throw CUError.invalidParams("click takes a ref or a point, not both") }
            let e = try element(ref, in: t)
            let info = ElementInfo(e)
            if info.role == kAXButtonRole { try CUFloorScan.checkPressInSavePanel(e) }
            if count == 1, flags.isEmpty {
                let axAction: String? = button == .left && info.actions.contains(kAXPressAction) ? kAXPressAction
                    : button == .right && info.actions.contains(kAXShowMenuAction) ? kAXShowMenuAction : nil
                if let axAction {
                    emitAction(p, t, info.center, "press")
                    do {
                        try AX.perform(e, axAction)
                        return ActOutcome(rung: .accessibility)
                    } catch let err as CUError where err.code == "stale_element" || err.code == "permission_missing" {
                        throw err
                    } catch {
                        // The element refused the action: fall through to events at its centre.
                    }
                }
            }
            guard let center = info.center else {
                throw CUError.unsupported("[\(ref)] has no position on screen — try action() or a screenshot point")
            }
            return try pointerClick(p, t, at: center, button: button, count: count, flags: flags, atPoint: false)
        }
        guard let px = try cuPoint(a.point) else { throw CUError.invalidParams("click needs a ref or a point") }
        let pt = try screenPoint(for: t, shotId: a.shotId, pixel: px)
        return try pointerClick(p, t, at: pt, button: button, count: count, flags: flags, atPoint: true)
    }

    private func pointerClick(_ p: TargetActParams, _ t: CUTarget, at pt: CGPoint, button: CUMouseButton, count: Int,
                              flags: CGEventFlags, atPoint: Bool) throws -> ActOutcome {
        let d = try CUInputLadder.decideEvents(context(p, t, atPoint: atPoint))
        emitAction(p, t, pt, "press")
        let synth = self.synth
        return try runEvents(p, t, d, focus: true) { route in
            synth.click(pid: t.pid, windowID: t.windowID, at: pt, button: button, count: count, flags: flags, route: route)
        }
    }

    /// A screenshot pixel of this target (`shotId`, else its latest shot) → global screen points.
    func screenPoint(for t: CUTarget, shotId: String?, pixel: CGPoint) throws -> CGPoint {
        let shot = try t.shot(shotId)
        switch shot.anchor {
        case .window(let wid, _):
            guard let w = CUWindowServer.window(id: wid) else { throw CUError.targetLost("that screenshot's window is gone") }
            return try shot.screenPoint(pixel: pixel, windowOrigin: w.frame.origin)
        case .screen:
            return try shot.screenPoint(pixel: pixel)
        }
    }

    // MARK: text

    private func setValue(_ a: CUSetValueAction, _ p: TargetActParams, _ t: CUTarget,
                          _ token: CUCancellation.Token) throws -> ActOutcome {
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e)
        if info.secure { throw secureRefusal() }
        try CUFloorScan.checkTypedIntoSavePanel(e, text: a.value)
        emitAction(p, t, info.center, "type")
        if AX.isSettable(e, kAXValueAttribute) {
            try AX.set(e, kAXValueAttribute, a.value as CFString)
            return ActOutcome(rung: .accessibility)
        }
        // Not settable: focus it, select everything, and type over it.
        try? AX.set(e, kAXFocusedAttribute, kCFBooleanTrue)
        if let len = AX.string(e, kAXValueAttribute)?.utf16.count, AX.isSettable(e, kAXSelectedTextRangeAttribute),
           let r = AX.makeRange(location: 0, length: len) {
            try? AX.set(e, kAXSelectedTextRangeAttribute, r)
        } else {
            _ = try sendChord(CUKeyChord(key: .character("a"), modifiers: [.command]), p, t)
        }
        return try typeText(a.value, into: e, p, t, token)
    }

    private func type(_ a: CUTypeAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let e = try textTarget(into: a.into, t, text: a.text)
        emitAction(p, t, e.flatMap { ElementInfo($0).center }, "type")
        return try typeText(a.text, into: e, p, t, token)
    }

    private func paste(_ a: CUPasteAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let e = try textTarget(into: a.into, t, text: a.text)
        emitAction(p, t, e.flatMap { ElementInfo($0).center }, "type")
        return try pasteText(a.text, format: a.format ?? .text, p, t, token)
    }

    /// The element text goes into: `into` (focused first), else the app's focused element. Floors applied.
    private func textTarget(into: Int?, _ t: CUTarget, text: String) throws -> AXUIElement? {
        let e: AXUIElement?
        if let into {
            let el = try element(into, in: t)
            if ElementInfo(el).secure { throw secureRefusal() }
            try? AX.set(el, kAXFocusedAttribute, kCFBooleanTrue)
            e = el
        } else {
            e = AX.element(AX.app(t.pid), kAXFocusedUIElementAttribute)
        }
        if let e {
            if ElementInfo(e).secure { throw secureRefusal() }
            try CUFloorScan.checkTypedIntoSavePanel(e, text: text)
        }
        return e
    }

    /// AX insert at the selection → paste for long or multi-line text → per-key events (8 ms apart).
    private func typeText(_ text: String, into e: AXUIElement?, _ p: TargetActParams, _ t: CUTarget,
                          _ token: CUCancellation.Token) throws -> ActOutcome {
        guard !text.isEmpty else { return ActOutcome(rung: .accessibility, detail: "nothing to type") }
        if let e, AX.isSettable(e, kAXSelectedTextAttribute) {
            let before = AX.string(e, kAXValueAttribute)
            if (try? AX.set(e, kAXSelectedTextAttribute, text as CFString)) != nil {
                let after = AX.string(e, kAXValueAttribute)
                // A field that reports its value must show the change; one that doesn't is trusted.
                if before == nil || after == nil || before != after { return ActOutcome(rung: .accessibility) }
            }
        }
        if text.contains("\n") || text.count > 64 {
            return try pasteText(text, format: .text, p, t, token)
        }
        let d = try CUInputLadder.decideEvents(context(p, t, atPoint: false))
        let synth = self.synth
        var typed = 0
        return try runEvents(p, t, d, focus: true) { route in
            try synth.type(pid: t.pid, text: text, route: route) {
                try token.check()
                typed += 1
                // Re-check the target between keys: still running, and (every 16 keys) not now a secure field.
                if NSRunningApplication(processIdentifier: t.pid)?.isTerminated ?? true {
                    throw CUError.targetLost("\(t.appName) quit while typing")
                }
                if typed % 16 == 0, let f = AX.element(AX.app(t.pid), kAXFocusedUIElementAttribute), ElementInfo(f).secure {
                    throw secureRefusal()
                }
            }
        }
    }

    private func pasteText(_ text: String, format: CUPasteFormat, _ p: TargetActParams, _ t: CUTarget,
                           _ token: CUCancellation.Token) throws -> ActOutcome {
        try token.check()
        var sent: ActOutcome?
        let seq = CUPasteSequence(
            pasteboard: CUSystemPasteboard(),
            sendPaste: { sent = try self.sendChord(CUKeyChord(key: .character("v"), modifiers: [.command]), p, t) },
            sleep: { usleep(useconds_t($0 * 1000)) })
        let result = try seq.run(items: CUPasteSequence.items(text: text, format: format),
                                 plain: CUPasteSequence.plain(text: text, format: format))
        var o = sent ?? ActOutcome(rung: .processEvents)
        if result == .leftAlone {
            o.detail = [o.detail, "the clipboard changed meanwhile, so it was not restored"].compactMap { $0 }.joined(separator: "; ")
        }
        return o
    }

    // MARK: keys

    private func key(_ a: CUKeyAction, _ p: TargetActParams, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome {
        let chord = try CUKeyChord.parse(a.combo)
        let rep = a.repeat ?? 1
        guard (1...100).contains(rep) else { throw CUError.invalidParams("repeat must be 1–100") }
        var e: AXUIElement?
        if let into = a.into {
            e = try element(into, in: t)
            try? AX.set(e!, kAXFocusedAttribute, kCFBooleanTrue)
        } else {
            e = AX.element(AX.app(t.pid), kAXFocusedUIElementAttribute)
        }
        // Characters (and pasting) into a secure field are typing; navigation keys are not.
        if let e, ElementInfo(e).secure, Self.producesText(chord) { throw secureRefusal() }
        // Return in a save panel saves, exactly like its Save button.
        if let e, chord.key == .named(.returnKey) || chord.key == .named(.keypadEnter) {
            try CUFloorScan.checkPressInSavePanel(e)
        }
        emitAction(p, t, e.flatMap { ElementInfo($0).center }, "type")
        // Resolve the route once (the menu lookup walks the menu bar), then press it `repeat` times.
        let plan = try chordPlan(chord, p, t)
        var out = ActOutcome(rung: .accessibility)
        for _ in 0..<rep {
            try token.check()
            out = try execute(plan, p, t)
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

    func chordPlan(_ chord: CUKeyChord, _ p: TargetActParams, _ t: CUTarget) throws -> ChordPlan {
        if chord.modifiers.contains(.command), case .character(let ch) = chord.key,
           let item = Self.menuItem(forKey: ch, modifiers: chord.modifiers, pid: t.pid) {
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
                       decision: try CUInputLadder.decideEvents(context(p, t, atPoint: false)))
    }

    func execute(_ plan: ChordPlan, _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome {
        switch plan {
        case .menuItem(let element, let title):
            try AX.perform(element, kAXPressAction)
            return ActOutcome(rung: .accessibility, detail: "used the menu item “\(title)”")
        case .events(let code, let flags, let d):
            let synth = self.synth
            return try runEvents(p, t, d, focus: true) { route in
                synth.key(pid: t.pid, code: code, flags: flags, route: route)
            }
        }
    }

    /// One chord, start to finish.
    func sendChord(_ chord: CUKeyChord, _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome {
        try execute(try chordPlan(chord, p, t), p, t)
    }

    /// A menu-bar item whose key equivalent is `key` with `modifiers` (command implied).
    static func menuItem(forKey key: Character, modifiers: CUKeyChord.Modifiers, pid: pid_t) -> (element: AXUIElement, title: String)? {
        guard let roots = try? CUAXMenuNode.menuBar(pid: pid) else { return nil }
        let want = String(key).uppercased()
        var wantMods = 0
        if modifiers.contains(.shift) { wantMods |= 1 }
        if modifiers.contains(.option) { wantMods |= 2 }
        if modifiers.contains(.control) { wantMods |= 4 }
        var queue = Array(roots.dropFirst())  // skip the Apple menu
        var seen = 0
        while !queue.isEmpty, seen < 1500 {
            let n = queue.removeFirst()
            seen += 1
            if let attrs = AX.copyMultiple(n.element, [kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute,
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

    // MARK: scroll and drag

    private func scroll(_ a: CUScrollAction, _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome {
        let pages = a.pages ?? 1
        guard pages > 0, pages <= 50 else { throw CUError.invalidParams("pages must be between 0 and 50") }
        var point: CGPoint
        var viewport: CGSize
        let atPoint: Bool
        if let ref = a.ref {
            let e = try element(ref, in: t)
            let info = ElementInfo(e)
            if let area = Self.scrollArea(from: e), Self.axScroll(area: area, direction: a.direction, pages: pages) {
                emitAction(p, t, info.center, "scroll")
                return ActOutcome(rung: .accessibility)
            }
            guard let c = info.center else { throw CUError.unsupported("[\(ref)] has no position on screen") }
            point = c
            viewport = (Self.scrollArea(from: e).flatMap(AX.frame) ?? info.frame)?.size ?? CGSize(width: 400, height: 400)
            atPoint = false
        } else {
            guard let px = try cuPoint(a.point) else { throw CUError.invalidParams("scroll needs a ref or a point") }
            point = try screenPoint(for: t, shotId: a.shotId, pixel: px)
            viewport = CUWindowServer.window(id: t.windowID)?.frame.size ?? CGSize(width: 400, height: 400)
            atPoint = true
        }
        let vertical = a.direction == .up || a.direction == .down
        let amount = (vertical ? viewport.height : viewport.width) * 0.9 * pages
        // Wheel deltas: positive moves the content down/right, i.e. scrolls up/left.
        let dy = a.direction == .down ? -amount : a.direction == .up ? amount : 0
        let dx = a.direction == .right ? -amount : a.direction == .left ? amount : 0
        let d = try CUInputLadder.decideEvents(context(p, t, atPoint: atPoint))
        emitAction(p, t, point, "scroll")
        let synth = self.synth
        return try runEvents(p, t, d, focus: false) { route in
            synth.scroll(pid: t.pid, windowID: t.windowID, at: point, deltaX: dx, deltaY: dy, route: route)
        }
    }

    /// The element itself when it is a scroll area, else its nearest scroll-area ancestor.
    static func scrollArea(from e: AXUIElement) -> AXUIElement? {
        var cur: AXUIElement? = e
        for _ in 0..<10 {
            guard let c = cur else { return nil }
            if AX.string(c, kAXRoleAttribute) == kAXScrollAreaRole { return c }
            cur = AX.element(c, kAXParentAttribute)
        }
        return nil
    }

    /// Rung 1 scrolling: move the scroll bar's value by `pages` viewports. False when the bar can't be set.
    static func axScroll(area: AXUIElement, direction: CUScrollDirection, pages: Double) -> Bool {
        let vertical = direction == .up || direction == .down
        guard let bar = AX.element(area, vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute),
              AX.isSettable(bar, kAXValueAttribute),
              let raw = AX.attribute(bar, kAXValueAttribute), let value = (raw as? NSNumber)?.doubleValue,
              let viewport = AX.frame(area)
        else { return false }
        let content = AX.elements(area, kAXChildrenAttribute).first {
            let r = AX.string($0, kAXRoleAttribute)
            return r != kAXScrollBarRole
        }.flatMap(AX.frame)
        guard let content else { return false }
        let view = vertical ? viewport.height : viewport.width
        let total = vertical ? content.height : content.width
        guard total > view + 1 else { return true }  // nothing to scroll: done
        let step = pages * 0.9 * view / (total - view)
        let sign: Double = (direction == .down || direction == .right) ? 1 : -1
        let next = min(1, max(0, value + sign * step))
        return (try? AX.set(bar, kAXValueAttribute, NSNumber(value: next))) != nil
    }

    private func drag(_ a: CUDragAction, _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome {
        func point(_ end: CUDragEnd, _ what: String) throws -> (CGPoint, Bool) {
            if let ref = end.ref {
                guard end.point == nil else { throw CUError.invalidParams("drag \(what) takes a ref or a point, not both") }
                guard let c = ElementInfo(try element(ref, in: t)).center else {
                    throw CUError.unsupported("[\(ref)] has no position on screen")
                }
                return (c, false)
            }
            guard let px = try cuPoint(end.point, "drag \(what)") else { throw CUError.invalidParams("drag \(what) needs a ref or a point") }
            return (try screenPoint(for: t, shotId: a.shotId, pixel: px), true)
        }
        let (from, fromPoint) = try point(a.from, "from")
        let (to, toPoint) = try point(a.to, "to")
        let d = try CUInputLadder.decideEvents(context(p, t, atPoint: fromPoint || toPoint))
        emit { $0.actionAt(sessionId: p.sessionId, pid: t.pid, windowID: t.windowID, point: from, kind: "drag", dragTo: to) }
        let synth = self.synth
        return try runEvents(p, t, d, focus: true) { route in
            synth.drag(pid: t.pid, windowID: t.windowID, from: from, to: to, route: route)
        }
    }

    // MARK: select, action, menu

    private func select(_ a: CUSelectAction, _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome {
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e)
        if info.secure { throw secureRefusal() }
        guard let value = AX.string(e, kAXValueAttribute) else { throw CUError.unsupported("[\(a.ref)] has no text to select") }
        guard let range = Self.selectionRange(in: value, text: a.text, before: a.before, after: a.after, caret: a.caret) else {
            throw CUError.invalidParams("“\(a.text)” is not in [\(a.ref)]\(a.before != nil || a.after != nil ? " with that context" : "")")
        }
        guard AX.isSettable(e, kAXSelectedTextRangeAttribute), let r = AX.makeRange(location: range.location, length: range.length)
        else { throw CUError.unsupported("[\(a.ref)] does not support selecting text") }
        try? AX.set(e, kAXFocusedAttribute, kCFBooleanTrue)
        try AX.set(e, kAXSelectedTextRangeAttribute, r)
        emitAction(p, t, info.center, "type")
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

    private func axAction(_ a: CUAXAction, _ p: TargetActParams, _ t: CUTarget) throws -> ActOutcome {
        let e = try element(a.ref, in: t)
        let info = ElementInfo(e)
        guard let name = CURoleWords.resolveAction(a.name, among: info.actions) else {
            let have = info.actions.map(CURoleWords.actionWords).joined(separator: ", ")
            throw CUError.invalidParams("[\(a.ref)] has no action “\(a.name)” — it has: \(have.isEmpty ? "none" : have)")
        }
        if name == kAXPressAction, info.role == kAXButtonRole { try CUFloorScan.checkPressInSavePanel(e) }
        emitAction(p, t, info.center, "press")
        try AX.perform(e, name)
        return ActOutcome(rung: .accessibility)
    }

    private func menu(_ a: CUMenuAction, _ t: CUTarget) throws -> ActOutcome {
        let item = try CUMenuWalker.resolve(a.path, in: try CUAXMenuNode.menuBar(pid: t.pid))
        try AX.perform(item.element, kAXPressAction)
        return ActOutcome(rung: .accessibility)
    }

    // MARK: rungs 2–4

    func context(_ p: TargetActParams, _ t: CUTarget, atPoint: Bool) -> CUInputLadder.Context {
        CUInputLadder.Context(appName: t.appName, bundleId: t.bundleId, isChromium: t.isChromium,
                              privatePath: p.privatePath, skyLightAvailable: skyLight.isAvailable,
                              allowForeground: p.allowForeground, pointerAtPoint: atPoint)
    }

    /// Runs `body` on the decided route, with the focus handling each rung needs.
    func runEvents(_ p: TargetActParams, _ t: CUTarget, _ d: CUInputLadder.Decision, focus: Bool,
                   _ body: (CURoute) throws -> CURoute) throws -> ActOutcome {
        switch d.rung {
        case .foreground:
            return try inForeground(t) {
                _ = try body(.hid)
                return ActOutcome(rung: .foreground, detail: d.detail)
            }
        case .privatePath:
            CUUserInputGuard.waitForQuiet()
            let restore = focus ? focusWithoutRaise(t) : nil
            defer { restore?() }
            let used = try body(.skyLight)
            if used != .skyLight {
                logOnce("skylight-fallback", "SkyLight posting unavailable; falling back to public pid events")
                return ActOutcome(rung: .processEvents, detail: "the private event path failed, so public events were used")
            }
            return ActOutcome(rung: .privatePath, detail: d.detail)
        case .accessibility, .processEvents:
            if focus { syntheticFocus(t) }
            _ = try body(.publicPid)
            return ActOutcome(rung: .processEvents, detail: d.detail)
        }
    }

    /// Rung 2's public focus: make the bound window the app's main window (no activation, no raise).
    private func syntheticFocus(_ t: CUTarget) {
        if let w = try? windowElement(t), AX.bool(w, kAXMainAttribute) != true {
            try? AX.set(w, kAXMainAttribute, kCFBooleanTrue)
        }
    }

    /// Rung 3: key focus to the target window without raising it; returns how to hand it back.
    private func focusWithoutRaise(_ t: CUTarget) -> (() -> Void)? {
        guard skyLight.canFocusWithoutRaise else { return nil }
        let front = NSWorkspace.shared.frontmostApplication
        let frontPid = front?.processIdentifier
        let frontWid = frontPid.flatMap { AX.element(AX.app($0), kAXFocusedWindowAttribute) }.flatMap(AX.windowID)
        guard skyLight.focusWithoutRaise(pid: t.pid, windowID: t.windowID) else { return nil }
        usleep(50_000)
        guard let fp = frontPid, let fw = frontWid, fp != t.pid else { return nil }
        let sky = skyLight
        let (tp, tw) = (t.pid, t.windowID)
        return { sky.restoreFocus(previousPid: fp, previousWindowID: fw, targetPid: tp, targetWindowID: tw) }
    }

    /// Rung 4: bring the app forward, act with the real pointer, then put the pointer and the user's app back.
    private func inForeground<T>(_ t: CUTarget, _ body: () throws -> T) throws -> T {
        guard let app = NSRunningApplication(processIdentifier: t.pid) else { throw CUError.targetLost("\(t.appName) quit") }
        let previous = NSWorkspace.shared.frontmostApplication
        let cursor = CGEvent(source: nil)?.location
        DispatchQueue.main.sync { _ = app.activate() }
        if let w = try? windowElement(t) { try? AX.perform(w, kAXRaiseAction) }
        var front = false
        for _ in 0..<50 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == t.pid { front = true; break }
            usleep(20_000)
        }
        defer {
            if let c = cursor { CGWarpMouseCursorPosition(c); CGAssociateMouseAndMouseCursorPosition(1) }
            if let prev = previous, prev.processIdentifier != t.pid { DispatchQueue.main.sync { _ = prev.activate() } }
        }
        guard front else { throw CUError.unsupported("could not bring \(t.appName) to the front") }
        // The real pointer goes wherever is frontmost: never into a dialog that guards trust.
        if let f = NSWorkspace.shared.frontmostApplication,
           CUFloors.isAuthOrSystemDialog(bundleId: f.bundleIdentifier, processName: f.localizedName) {
            throw CUError.refused(.authDialog, "a system dialog is in front — ask the user to handle it")
        }
        return try body()
    }

    // MARK: helpers

    func emitAction(_ p: TargetActParams, _ t: CUTarget, _ point: CGPoint?, _ kind: String) {
        guard let point else { return }
        let (session, pid, wid) = (p.sessionId, t.pid, t.windowID)
        emit { $0.actionAt(sessionId: session, pid: pid, windowID: wid, point: point, kind: kind, dragTo: nil) }
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

    init(_ e: AXUIElement) {
        let a = AX.copyMultiple(e, [kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute]) ?? [:]
        role = a[kAXRoleAttribute].flatMap(AX.stringValue)
        subrole = a[kAXSubroleAttribute].flatMap(AX.stringValue)
        if let p = a[kAXPositionAttribute].flatMap(AX.pointValue), let s = a[kAXSizeAttribute].flatMap(AX.sizeValue) {
            frame = CGRect(origin: p, size: s)
        }
        actions = AX.actions(e)
    }

    var secure: Bool { CUFloors.isSecureField(role: role ?? "", subrole: subrole) }
    var center: CGPoint? {
        guard let f = frame, f.width > 0 || f.height > 0 else { return nil }
        return CGPoint(x: f.midX, y: f.midY)
    }
}
