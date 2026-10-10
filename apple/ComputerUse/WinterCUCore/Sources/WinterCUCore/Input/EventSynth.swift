import AppKit
import CoreGraphics
import Foundation

/// Where a synthesized event goes (ladder rungs 2–4).
enum CURoute: Sendable, Equatable {
    /// Rung 2: public `CGEventPostToPid` — background, no pointer movement.
    case publicPid
    /// Rung 3: SkyLight `SLEventPostToPid` (falls back to `publicPid` when the symbol is missing).
    case skyLight
    /// Rung 4: the global HID stream — moves the real pointer; only after the user agreed.
    case hid
}

/// The one place events leave the process. Injectable, so sequence logic can be tested by recording.
protocol CUEventPoster: Sendable {
    /// Returns the route actually used (SkyLight may degrade to the public one).
    @discardableResult func post(_ event: CGEvent, pid: pid_t, route: CURoute, authenticate: Bool) -> CURoute
}

/// The mark on every event the helper posts (`kCGEventSourceUserData`), so the Focus Guardian's listen-only
/// left-mouse-down tap can tell the helper's own clicks from the user's physical ones.
enum CUEventStamp {
    /// "WINTERCU" as eight ASCII bytes.
    static let value: Int64 = 0x5749_4E54_4552_4355
    static func stamp(_ e: CGEvent) { e.setIntegerValueField(.eventSourceUserData, value: value) }
    static func isOurs(_ userData: Int64) -> Bool { userData == value }
}

struct CULiveEventPoster: CUEventPoster {
    let skyLight: CUSkyLight
    /// The public routes, injectable so the SkyLight → public fallback is testable without posting anything.
    var postToPid: @Sendable (CGEvent, pid_t) -> Void = { e, pid in e.postToPid(pid) }
    var postHID: @Sendable (CGEvent) -> Void = { e in e.post(tap: .cghidEventTap) }

    func post(_ event: CGEvent, pid: pid_t, route: CURoute, authenticate: Bool) -> CURoute {
        CUEventStamp.stamp(event)  // every helper event carries the mark, whatever the route
        switch route {
        case .publicPid:
            postToPid(event, pid)
            return .publicPid
        case .skyLight:
            if skyLight.post(event, to: pid, authenticate: authenticate) { return .skyLight }
            postToPid(event, pid)
            return .publicPid
        case .hid:
            postHID(event)
            return .hid
        }
    }
}

/// Where the synthetic pointer last was in each window (window-targeted events only — never the real cursor): the
/// start of the next hover path there.
final class CUPointerMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var points: [UInt32: CGPoint] = [:]
    func point(in window: UInt32) -> CGPoint? { lock.withLock { points[window] } }
    func set(_ p: CGPoint, in window: UInt32) { lock.withLock { points[window] = p } }
}

/// Builds and posts the event sequences for pointer and keyboard input. Runs on the target's pid queue;
/// the short sleeps between events are what real input looks like to the receiving app.
struct CUEventSynth {
    let poster: CUEventPoster
    let skyLight: CUSkyLight
    var sleep: (Double) -> Void = { ms in usleep(useconds_t(max(0, ms) * 1000)) }
    /// The bounds origin (top-left, global points) of a window an event is aimed at, for the window-local
    /// location the public route states.
    var windowOrigin: (UInt32) -> CGPoint? = { _ in nil }
    /// Whether the private setters (field 51, the window location) may be used: the private event path setting.
    var windowSPI = true
    /// The synthetic pointer's last place per window (the hover path's start).
    var pointerMemory: CUPointerMemory?

    /// The hover path: this many window-targeted moves, this far apart, then a dwell before the press.
    static let hoverMoves = 3
    static let hoverMoveGapMs: Double = 10
    static let hoverDwellMs: Double = 40
    /// Where a path starts with no earlier synthetic position in the window: just up-left of the point, outside a
    /// small control, so it is ENTERED (mouseover / mouseenter), as a real pointer would.
    static let hoverEntryOffset = CGPoint(x: -24, y: -16)

    /// Raw `CGEventField` numbers the public enum does not name.
    static let windowNumberField: UInt32 = 51
    static let clickGroupField: UInt32 = 58

    private func source(_ route: CURoute) -> CGEventSource? {
        // The private state keeps the user's held modifiers out of background events; the SkyLight recipe and
        // the foreground use the HID state, as real input does.
        CGEventSource(stateID: route == .publicPid ? .privateState : .hidSystemState)
    }

    /// A point in screen points → the same point local to a window whose bounds start at `origin` (both
    /// top-left origin, no flip).
    static func windowLocal(_ point: CGPoint, origin: CGPoint) -> CGPoint {
        CGPoint(x: point.x - origin.x, y: point.y - origin.y)
    }

    /// Window-targeted pid events: the target pid (field 40), the
    /// window id in fields 91 and 92 (the window under the pointer, and the one that can handle the event)
    /// and 51 (its window number), and the window location. On the public route that location is LOCAL to
    /// the window (screen point minus its bounds origin), so the event is addressed to the window and not to
    /// whatever is on screen at that point — which is how a window on another Space or display can take it.
    /// SkyLight's route keeps the screen point: WindowServer derives the local one there (cua-driver).
    private func stampRouting(_ e: CGEvent, pid: pid_t, windowID: UInt32, location: CGPoint, route: CURoute,
                              clickGroup: Int64?) {
        guard route != .hid else { return }
        e.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        // Mouse subtype 3, the synthesized-mouse subtype (cua-driver stamps its events the same way).
        if e.type != .scrollWheel { e.setIntegerValueField(.mouseEventSubtype, value: 3) }
        if windowID != 0 {
            e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
            e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
            if windowSPI || route == .skyLight { skyLight.setField(e, Self.windowNumberField, Int64(windowID)) }
        }
        switch route {
        case .skyLight:
            if let g = clickGroup { skyLight.setField(e, Self.clickGroupField, g) }
            skyLight.setWindowLocation(e, location)
        case .publicPid:
            if windowSPI, windowID != 0, let origin = windowOrigin(windowID) {
                skyLight.setWindowLocation(e, Self.windowLocal(location, origin: origin))
            }
        case .hid:
            break
        }
    }

    private func mouseTypes(_ button: CUMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType, cg: CGMouseButton) {
        switch button {
        case .left: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
        case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
        case .middle: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
        }
    }

    /// Runs before every pointer event is posted: cancellation, and on rung 4 the hit test. Throwing stops
    /// the sequence there.
    typealias PointerCheck = (_ type: CGEventType, _ at: CGPoint) throws -> Void

    /// The pointer's way to `point` in window `wid` on a window-targeted route: `hoverMoves` moves from where the
    /// synthetic pointer last was in that window (else from just outside the point), `hoverMoveGapMs` apart, then
    /// `dwellMs` — so the page sees the pointer arrive: mouseover / mouseenter, hover-armed widgets, menus that
    /// open on hover, tooltips. Pid-posted (or SkyLight-posted) events only, stamped like the click: the user's
    /// real cursor never moves (no HID tap, no warp). Not for `.hid` (rung 4 moves the real pointer itself).
    @discardableResult
    func hoverPath(pid: pid_t, windowID wid: UInt32, to point: CGPoint, route: CURoute, flags: CGEventFlags,
                   clickGroup: Int64?, dwellMs: Double, check: PointerCheck) throws -> CURoute {
        guard route != .hid else { return route }
        let src = source(route)
        let start = pointerMemory?.point(in: wid)
            ?? CGPoint(x: point.x + Self.hoverEntryOffset.x, y: point.y + Self.hoverEntryOffset.y)
        var used = route
        for i in 1...Self.hoverMoves {
            let f = Double(i) / Double(Self.hoverMoves)
            let p = CGPoint(x: start.x + (point.x - start.x) * f, y: start.y + (point.y - start.y) * f)
            guard let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)
            else { continue }
            try check(.mouseMoved, p)
            move.flags = flags
            stampRouting(move, pid: pid, windowID: wid, location: p, route: route, clickGroup: clickGroup)
            used = poster.post(move, pid: pid, route: route, authenticate: false)
            sleep(i < Self.hoverMoves ? Self.hoverMoveGapMs : dwellMs)
        }
        pointerMemory?.set(point, in: wid)
        return used
    }

    /// The pointer moved to `point` and left there `dwellMs` (default: long enough for hover-only UI).
    @discardableResult
    func hover(pid: pid_t, windowFor: (CGPoint) -> UInt32, at point: CGPoint, route: CURoute, dwellMs: Double,
               check: PointerCheck = { _, _ in }) throws -> CURoute {
        guard route == .hid else {
            return try hoverPath(pid: pid, windowID: windowFor(point), to: point, route: route, flags: [], clickGroup: nil,
                                 dwellMs: dwellMs, check: check)
        }
        // Rung 4 (the user agreed to the foreground): the real pointer itself moves there.
        guard let move = CGEvent(mouseEventSource: source(route), mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        else { return route }
        try check(.mouseMoved, point)
        let used = poster.post(move, pid: pid, route: route, authenticate: false)
        sleep(dwellMs)
        return used
    }

    /// A click at `point` (screen points). On a window-targeted route the hover path comes first (the page sees
    /// the pointer arrive); for SkyLight an off-screen primer click follows it: Chromium only honours
    /// user-activation-gated clicks after a trusted gesture. Flags are always set, empty included, so modifiers
    /// the user is holding never leak into the click. `windowFor` names the window each event is routed to (the
    /// target pid's front-most window under that point).
    @discardableResult
    func click(pid: pid_t, windowFor: (CGPoint) -> UInt32, at point: CGPoint, button: CUMouseButton, count: Int,
               flags: CGEventFlags, route: CURoute, check: PointerCheck = { _, _ in }) throws -> CURoute {
        let t = mouseTypes(button)
        let src = source(route)
        let group = Int64(DispatchTime.now().uptimeNanoseconds & 0x7fff_ffff)
        let wid = windowFor(point)
        var used = route
        if route != .hid {
            used = try hoverPath(pid: pid, windowID: wid, to: point, route: route, flags: flags, clickGroup: group,
                                 dwellMs: Self.hoverDwellMs, check: check)
        }
        if route == .skyLight {
            if button == .left, used == .skyLight {
                let off = CGPoint(x: -1, y: -1)
                for type in [CGEventType.leftMouseDown, .leftMouseUp] {
                    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: off, mouseButton: .left)
                    else { continue }
                    e.setIntegerValueField(.mouseEventClickState, value: 1)
                    e.flags = []
                    stampRouting(e, pid: pid, windowID: wid, location: off, route: route, clickGroup: group)
                    poster.post(e, pid: pid, route: route, authenticate: false)
                    sleep(type == .leftMouseDown ? 1 : 100)
                }
            }
        }
        let n = max(1, min(3, count))
        for i in 1...n {
            for type in [t.down, t.up] {
                guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: t.cg)
                else { continue }
                try check(type, point)
                e.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                e.flags = flags
                stampRouting(e, pid: pid, windowID: wid, location: point, route: route, clickGroup: group)
                used = poster.post(e, pid: pid, route: route, authenticate: false)
                sleep(type == t.down ? 8 : (i < n ? 60 : 0))
            }
        }
        return used
    }

    /// Scroll-wheel events at `point`, `deltaY`/`deltaX` in points (positive = content moves down/right).
    @discardableResult
    func scroll(pid: pid_t, windowFor: (CGPoint) -> UInt32, at point: CGPoint, deltaX: Double, deltaY: Double,
                route: CURoute, check: PointerCheck = { _, _ in }) throws -> CURoute {
        let src = source(route)
        let wid = windowFor(point)
        // Deliver in a few chunks, like a real wheel, so apps that animate per event follow along.
        let steps = max(1, min(12, Int((max(abs(deltaX), abs(deltaY)) / 120).rounded(.up))))
        var used = route
        for _ in 0..<steps {
            guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2,
                                  wheel1: Int32((deltaY / Double(steps)).rounded()),
                                  wheel2: Int32((deltaX / Double(steps)).rounded()), wheel3: 0)
            else { continue }
            try check(.scrollWheel, point)
            e.location = point
            e.flags = []
            stampRouting(e, pid: pid, windowID: wid, location: point, route: route, clickGroup: nil)
            used = poster.post(e, pid: pid, route: route, authenticate: false)
            sleep(16)
        }
        if route != .hid { pointerMemory?.set(point, in: wid) }
        return used
    }

    /// Press at `from`, move in steps, release at `to`. Each event is checked before it is posted; a check
    /// that throws after the press still releases the button, so nothing is left held down.
    @discardableResult
    func drag(pid: pid_t, windowFor: (CGPoint) -> UInt32, from: CGPoint, to: CGPoint, route: CURoute, steps: Int = 12,
              check: PointerCheck = { _, _ in }) throws -> CURoute {
        let src = source(route)
        let group = Int64(DispatchTime.now().uptimeNanoseconds & 0x7fff_ffff)
        var used = route
        func send(_ type: CGEventType, _ p: CGPoint, wait: Double) {
            guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
            else { return }
            e.setIntegerValueField(.mouseEventClickState, value: 1)
            e.flags = []
            stampRouting(e, pid: pid, windowID: windowFor(p), location: p, route: route, clickGroup: group)
            used = poster.post(e, pid: pid, route: route, authenticate: false)
            sleep(wait)
        }
        try check(.mouseMoved, from)
        send(.mouseMoved, from, wait: 15)
        try check(.leftMouseDown, from)
        send(.leftMouseDown, from, wait: 50)
        let n = max(2, steps)
        var last = from
        do {
            for i in 1...n {
                let f = Double(i) / Double(n)
                let p = CGPoint(x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f)
                try check(.leftMouseDragged, p)
                send(.leftMouseDragged, p, wait: 16)
                last = p
            }
            try check(.leftMouseUp, to)
        } catch {
            // Never leave the button down: release where the drag stopped, then report why.
            send(.leftMouseUp, last, wait: 0)
            throw error
        }
        send(.leftMouseUp, to, wait: 0)
        if route != .hid { pointerMemory?.set(to, in: windowFor(to)) }
        return used
    }

    /// One key press (down + up) with modifiers.
    @discardableResult
    func key(pid: pid_t, code: CGKeyCode, flags: CGEventFlags, route: CURoute) -> CURoute {
        let src = source(route)
        var used = route
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
            e.flags = flags
            if route != .hid { e.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid)) }
            used = poster.post(e, pid: pid, route: route, authenticate: true)
            sleep(down ? 4 : 4)
        }
        return used
    }

    /// The key that types a character (the current layout's, else US-ANSI); replaceable by tests.
    var stroke: (Character) -> CUKeyStroke? = { CUKeyboardLayout.stroke(for: $0) }

    /// At most this many UTF-16 units ride on one key event (CGEvent truncates longer strings).
    static let unicodeChunk = 16

    /// Typing pace: the keys of a batch go back to back (no settle per key — the app takes its event queue in
    /// order), then a short yield. Return and Tab keep `key()`'s own pauses: a focus move must have been handled
    /// before the next character's focus check. The real per-key cost (posting plus the caller's checks) is
    /// logged as characters per second at the end of every typed run.
    static let keyBatch = 8
    static let batchYieldMs: Double = 3

    /// The key that types `ch` PLAINLY: an ASCII character on its layout key, with Shift at most. An Option-layer
    /// character (an em dash, "å") goes as Unicode alone with no modifier flags: a page reads Option + a key as
    /// its own shortcut (live: a title's em dash moved the focus to the page's menu search, and the rest of the
    /// title landed there). Non-ASCII characters go the same way — a key's code means different text on
    /// another layout.
    func plainStroke(_ ch: Character) -> CUKeyStroke? {
        guard ch.isASCII, let k = stroke(ch), !k.option else { return nil }
        return k
    }

    /// Types `text` at the batched pace above. Each plain ASCII character is ITS OWN KEY — the layout's key code
    /// with Shift as needed — carrying the character as its Unicode string, so an editor that reads the key
    /// (a canvas editor) sees the key it expects and one that reads the text gets the exact character.
    /// Characters no plain key types (Option-layer, non-ASCII, emoji, CJK) go as Unicode alone with no flags, a
    /// run of them in one event (in chunks of `unicodeChunk` UTF-16 units), never one carrier key per character.
    /// Return and Tab are their keys.
    /// `between` runs before each character (a run: before its first) and may throw to stop. `posted` is told
    /// how many characters have gone out so far, after each key or run (a cancelled type says how far it got).
    @discardableResult
    func type(pid: pid_t, text: String, route: CURoute, between: () throws -> Void,
              posted: ((Int) -> Void)? = nil) throws -> CURoute {
        let src = source(route)
        var used = route
        var inBatch = 0
        func post(code: CGKeyCode, flags: CGEventFlags, unicode: String?) {
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
                if let unicode {
                    let utf16 = Array(unicode.utf16)
                    utf16.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
                }
                e.flags = flags
                if route != .hid { e.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid)) }
                used = poster.post(e, pid: pid, route: route, authenticate: true)
            }
            inBatch += 1
            if inBatch >= Self.keyBatch {
                inBatch = 0
                sleep(Self.batchYieldMs)
            }
        }
        let chars = Array(text)
        var i = 0
        while i < chars.count {
            try between()
            let ch = chars[i]
            if ch == "\n" || ch == "\r" || ch == "\r\n" {
                used = key(pid: pid, code: CUKeyCodes.code(for: .returnKey), flags: [], route: route)
                i += 1
                inBatch = 0
                posted?(i)
                continue
            }
            if ch == "\t" {
                used = key(pid: pid, code: CUKeyCodes.code(for: .tab), flags: [], route: route)
                i += 1
                inBatch = 0
                posted?(i)
                continue
            }
            if let k = plainStroke(ch) {
                post(code: k.code, flags: k.flags, unicode: String(ch))
                i += 1
                posted?(i)
                continue
            }
            // A run of characters no key types: one event per chunk, never splitting a character.
            var run = ""
            while i < chars.count, plainStroke(chars[i]) == nil, !["\n", "\r", "\r\n", "\t"].contains(chars[i]),
                  run.utf16.count + String(chars[i]).utf16.count <= Self.unicodeChunk || run.isEmpty {
                run.append(chars[i])
                i += 1
            }
            post(code: 0, flags: [], unicode: run)
            posted?(i)
        }
        return used
    }
}

/// Click modifiers (`["cmd", "shift"]`) → event flags.
func cuModifierFlags(_ names: [String]?) throws -> CGEventFlags {
    var mods: CUKeyChord.Modifiers = []
    for n in names ?? [] {
        guard let m = CUKeyChord.modifierNames[n.lowercased()] else {
            throw CUError.invalidParams("\"\(n)\" is not a modifier (cmd, ctrl, alt/option, shift, fn)")
        }
        mods.insert(m)
    }
    return mods.cgFlags
}
