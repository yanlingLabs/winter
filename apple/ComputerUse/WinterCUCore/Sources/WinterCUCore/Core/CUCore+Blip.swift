import ApplicationServices
import CoreGraphics
import Foundation

/// The focus blip (the user's ruling, 2026-10-09): the focus records (`keyWithoutRaise`) make the bound window
/// the window server's key window for a moment — the user's app resigns active for about 60 ms while its front
/// and Space stay as they are — and that is what makes an app in the background re-validate its menu (live: a
/// selection-dependent command read enabled only on the activation that followed the focus records, never on
/// a click or a synthetic activation alone). So it is used to validate a menu command or menu shortcut that
/// reads disabled in the background, and in its one retry; and (the ruling's extension, same day) for keyboard
/// input — type, paste as keys, key, editing shortcuts — into a window that does not hold the key focus, once
/// per burst of keys (`CUKeyBlips`): an app takes no keys for a window that isn't key (live: typed text never
/// reached Google Docs in a background Safari without it). Never for clicks or reads.
///
/// It never runs without the keyboard reroute (`CUKeyReroute`): a head keyboard tap on the target, installed
/// just before the focus records, sends the user's own keys to their app and drops them from the target, and
/// is removed once the user's app holds the key focus again. The whole blip — focus handed back, the user's
/// app front again (else the guardian restores it), the tap removed — ends at the latest `blipDeadlineMs`
/// after it began, on every path.
final class CUFocusBlip {
    let begunMs: Double
    /// Its bound: the tap is removed and the focus handed back by then, whatever happens.
    let boundMs: Double
    /// The desktop the user was on when it began: a switch while it lasts stops the act.
    let space: UInt64?
    private let lock = NSLock()
    private var ended = false
    private let finish: (String) -> Void

    init(begunMs: Double, boundMs: Double, space: UInt64?, finish: @escaping (String) -> Void) {
        self.begunMs = begunMs
        self.boundMs = boundMs
        self.space = space
        self.finish = finish
    }

    /// Ends the blip once (the act, or the deadline — whichever comes first).
    func end(_ reason: String = "done") {
        let first = lock.withLock { () -> Bool in
            defer { ended = true }
            return !ended
        }
        if first { finish(reason) }
    }

    var isEnded: Bool { lock.withLock { ended } }
}

extension CUCore {
    /// Starts a blip for `why`: the reroute tap first, then the focus records. Nil — with the reason logged —
    /// when it can't run: the private path off, the app already in front, no tap, or the focus records
    /// unavailable or retired (the user-view guard undid them once).
    func beginBlip(_ p: TargetActParams, _ t: CUTarget, why: String, boundMs: Double = CUCore.blipDeadlineMs) -> CUFocusBlip? {
        let app = t.appName
        guard p.privatePath, let user = sys.frontmostPid(), user != t.pid else {
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): not used (private path off, or the app is in front)")
            return nil
        }
        let reroute = CUKeyReroute(target: t.pid, victim: user, installer: keyTapInstaller, post: keyReroutePost)
        let start = clock.nowMs()  // the deadline counts from the tap's install
        guard reroute.begin() else {
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): not used — no keyboard reroute tap")
            return nil
        }
        guard let undo = keyWithoutRaise(t) else {
            reroute.end()
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): not used — the focus records are unavailable or retired")
            return nil
        }
        let space = sys.activeSpace()
        // The tap's removal, bounded: by the act's end, or at the bound by the timer — never later (an overrun is a
        // fault in the log).
        let removeTap = { [self] (why: String) -> Int in
            let held = clock.nowMs() - start
            let n = reroute.end()
            if held > boundMs + 30 {
                CULog.act.fault("focus blip in \(app, privacy: .public): the keyboard reroute stayed \(Int(held), privacy: .public) ms, over its \(Int(boundMs), privacy: .public) ms bound (\(why, privacy: .public))")
            }
            return n
        }
        let blip = CUFocusBlip(begunMs: start, boundMs: boundMs, space: space) { [self] reason in
            undo()  // the user's key window handed back
            // The user's app must hold the key focus and the front again within `blipFrontWaitMs` (and before the
            // bound); the tap stays until then, so a key typed meanwhile still goes to them.
            let until = min(clock.nowMs() + Self.blipFrontWaitMs, start + boundMs)
            let back = { [self] in keyFocusPidForTarget(t) != t.pid && sys.frontmostPid() == user }
            while clock.nowMs() < until, !back() { usleep(10_000) }
            // Not back yet: hand it back once more (the first focus record can be lost while the app is busy),
            // and only then is it a theft for the guardian.
            var handedBackTwice = false
            if !back() {
                undo()
                handedBackTwice = true
                let again = min(clock.nowMs() + 60, start + boundMs)
                while clock.nowMs() < again, !back() { usleep(10_000) }
            }
            noteGuardianActed(t.pid)  // the blip's end is a cause: an activation right after it may be its doing
            let rerouted = removeTap(reason)
            // Still not back (the front elsewhere, or the keys still going to the target): the guardian restores
            // the user's app, which takes its key focus back with it.
            let front = sys.frontmostPid() == user
            let keys = keyFocusPidForTarget(t) != t.pid
            if handedBackTwice { CULog.act.notice("focus blip in \(app, privacy: .public): the key focus was handed back a second time — back: \(front && keys ? "yes" : "no", privacy: .public)") }
            if !front || !keys {
                guardianRestore(CUGuardedView(app: user, space: space), thief: t.pid, repeatOffender: false,
                                cause: front ? "the focus blip left the key focus with the target" : "the focus blip did not hand the front back")
            }
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): ended (\(reason, privacy: .public)) after \(Int(self.clock.nowMs() - start), privacy: .public) ms; \(rerouted, privacy: .public) key event(s) rerouted to the user's app; the user's app back (front and keys): \(front && keys ? "yes" : "no — the guardian restored it", privacy: .public)")
        }
        // The bound, enforced by the timer: the blip ends AND the tap comes off, whatever the act is doing.
        blipSchedule(max(0, boundMs - (clock.nowMs() - start))) { [weak blip] in
            blip?.end("its bound")
            _ = removeTap("its bound")
        }
        CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): begun, the keyboard reroute on")
        return blip
    }

    enum BlipOutcome { case pressed(String?), stillDisabled, unavailable }

    /// A menu command or menu shortcut that reads disabled in the background, validated in the focus blip: the
    /// synthetic activation posted in it, the item read for `blipReadMs`, and pressed — still inside the blip —
    /// once it reads enabled. Once more in a fresh blip if not. `read` answers the item while enabled, nil
    /// while disabled.
    func pressInBlip<Item>(_ p: TargetActParams, _ t: CUTarget, title: String, read: () throws -> Item?,
                           press: (Item) throws -> String?) throws -> BlipOutcome {
        for attempt in 1...2 {
            guard let blip = beginBlip(p, t, why: "“\(title)” (try \(attempt))") else {
                return attempt == 1 ? .unavailable : .stillDisabled
            }
            defer { blip.end() }
            activateForMenu(p, t)
            let until = clock.nowMs() + blipReadMs
            var reads = 0
            while true {
                reads += 1
                if let item = try read() {
                    CULog.act.notice("menu in \(t.appName, privacy: .public): “\(title, privacy: .public)” read enabled in the focus blip (try \(attempt, privacy: .public), read \(reads, privacy: .public), \(Int(self.clock.nowMs() - blip.begunMs), privacy: .public) ms)")
                    return .pressed(try press(item))
                }
                if clock.nowMs() >= until || blip.isEnded { break }
                usleep(20_000)
            }
            CULog.act.notice("menu in \(t.appName, privacy: .public): “\(title, privacy: .public)” still disabled in the focus blip (try \(attempt, privacy: .public), \(reads, privacy: .public) reads)")
        }
        return .stillDisabled
    }
}

// MARK: keyboard input

extension CUCore {
    /// Whether keys for the bound window need the focus blip: the private path is on, the app is in the
    /// background, and the window does not hold the key focus — not its app's key window by accessibility, or
    /// not the window server's key focus.
    func needsKeyBlip(_ p: TargetActParams, _ t: CUTarget) -> Bool {
        guard p.privatePath, sys.frontmostPid() != t.pid else { return false }
        return boundWindowIsKeyInApp(t) != true || keyFocusPidForTarget(t) != t.pid
    }
}

/// The focus blip for one act's keyboard input: begun before the first key when the window does not hold the
/// key focus, and — since a blip ends within `blipDeadlineMs` — ended and begun afresh before the next key once
/// its burst (`blipBurstMs` from its start) is spent. A window that already holds it takes none; a blip that
/// can't run is not asked for again in this act.
final class CUKeyBlips {
    private unowned let core: CUCore
    private let p: TargetActParams
    private let t: CUTarget
    private let why: String
    private var blip: CUFocusBlip?
    private var settled = false  // not needed, or not possible: never asked again in this act
    private(set) var bursts = 0

    init(_ core: CUCore, _ p: TargetActParams, _ t: CUTarget, why: String) {
        self.core = core
        self.p = p
        self.t = t
        self.why = why
    }

    /// Before a key, or a run of keys. Throws (stopping the act) when the user's desktop began to switch while the
    /// blip lasted: nothing more is sent.
    func before() throws {
        if let b = blip, let space = b.space, let now = core.sys.activeSpace(), now != space {
            b.end("the desktop began to switch")
            blip = nil
            CULog.act.fault("keys in \(self.t.appName, privacy: .public): macOS began switching desktops during the focus blip — stopped")
            throw CUError.uncertain("macOS began switching desktops while keys were going to \(t.appName), so the typing was stopped (the user's desktop is being put back) — check state() to see what landed")
        }
        if settled { return }
        if let b = blip, !b.isEnded, core.clock.nowMs() - b.begunMs < core.blipBurstMs { return }
        blip?.end("its burst was spent")
        blip = nil
        guard core.needsKeyBlip(p, t) else {
            if bursts == 0 { CULog.act.notice("keys in \(self.t.appName, privacy: .public): the window holds the key focus — no focus blip") }
            settled = bursts == 0
            return
        }
        guard let b = core.beginBlip(p, t, why: "\(why) (burst \(bursts + 1))", boundMs: core.keyBlipBoundMs) else {
            settled = true
            return
        }
        blip = b
        bursts += 1
        // The app takes the key focus as it handles the focus record: keys sent before that are lost.
        if core.blipKeySettleMs > 0 { usleep(useconds_t(core.blipKeySettleMs * 1000)) }
    }

    func end() {
        blip?.end()
        blip = nil
    }
}
