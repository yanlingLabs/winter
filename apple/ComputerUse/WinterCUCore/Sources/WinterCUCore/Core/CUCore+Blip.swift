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
    /// The app the user was in when it began, and when (seconds): a change from it is judged from then.
    let user: pid_t
    let startedAt: TimeInterval
    private let lock = NSLock()
    private var ended = false
    private let finish: (String, Bool) -> Void

    init(begunMs: Double, boundMs: Double, space: UInt64?, user: pid_t, startedAt: TimeInterval,
         finish: @escaping (String, Bool) -> Void) {
        self.begunMs = begunMs
        self.boundMs = boundMs
        self.space = space
        self.user = user
        self.startedAt = startedAt
        self.finish = finish
    }

    /// Ends the blip once (the act, or the deadline — whichever comes first). `usersMove`: the user moved while it
    /// lasted (the one decision said so) — the tap comes off, and nothing is handed back or restored over them.
    func end(_ reason: String = "done", usersMove: Bool = false) {
        let first = lock.withLock { () -> Bool in
            defer { ended = true }
            return !ended
        }
        if first { finish(reason, usersMove) }
    }

    var isEnded: Bool { lock.withLock { ended } }
}

extension CUCore {
    /// Starts a blip for `why`: the reroute tap first, then the focus records. Nil — with the reason logged —
    /// when it can't run: the private path off, the app already in front, no tap, or the focus records
    /// unavailable or retired (the user-view guard undid them once). Throws when the bound window could not be made
    /// the window the app's keys go to (`keyWithoutRaise`): nothing may be sent then — and a refusal that came after
    /// the focus record ENDS the blip the ordinary way first (the hand-back, the wait for the user's app, a second
    /// hand-back, the tap removed only then, the guardian's restore if they are still not back): review of round 4, a
    /// refusal handed back once, removed the tap at once and threw, and the target could keep the user's keys.
    /// `forKeys`: a keyboard blip — when the app activated itself on the focus record (the step undone), its keys are
    /// refused rather than sent with no blip; a menu blip falls back to its other routes, as before.
    func beginBlip(_ p: TargetActParams, _ t: CUTarget, why: String, boundMs: Double = CUCore.blipDeadlineMs,
                   forKeys: Bool = false) throws -> CUFocusBlip? {
        let app = t.appName
        guard p.privatePath, let user = sys.frontmostPid(), user != t.pid else {
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): not used (private path off, or the app is in front)")
            return nil
        }
        // Each key of the user's that reaches the target goes to their place by the one rule (I3): through to the target
        // only once their own move took them there, else to where they are — never the app they left, never a target that
        // took the front by itself (`keyPlace`).
        let tpid = t.pid
        let space0 = sys.activeSpace()
        let start = clock.nowMs()  // the deadline counts from the tap's install
        let startedAt = clock.nowSeconds()
        // Where they are as the blip begins, judged once: their place (a move the guardian may not have heard of yet), or
        // an app that took the front by itself and is about to be put back.
        let startWasTheirs = !guardianRunning || isUsersMove(CUUserView(space: space0, front: user), since: nil, path: "the focus blip's start")
        let reroute = CUKeyReroute(target: t.pid, victim: user, installer: keyTapInstaller, post: keyReroutePost,
                                   destination: { [weak self] in
                                       self?.keyPlace(target: tpid, user: user, space: space0, since: startedAt,
                                                      startWasTheirs: startWasTheirs) ?? user
                                   })
        guard reroute.begin() else {
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): not used — no keyboard reroute tap")
            return nil
        }
        let space = space0
        let undo: () -> Void
        var refusal: CUError?
        switch keyWithoutRaise(t) {
        case .unavailable:
            reroute.end()
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): not used — the focus records are unavailable or retired")
            return nil
        case .refusedBeforeAnything(let e):
            reroute.end()
            throw e
        case .undone(let e):
            // The step already undone and the user's view put back.
            reroute.end()
            if forKeys { throw e }
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): not used — the app activated itself on the focus records (undone)")
            return nil
        case .userTookTheApp(let e):
            // The user is in the target app now: the key focus is theirs there — never handed back to the app they left.
            reroute.end()
            throw e
        case .keyed(let u):
            undo = u
        case .refused(let u, let e):
            undo = u
            refusal = e
        }
        // The tap's removal, bounded: by the act's end, or at the bound by the timer — never later (an overrun is a
        // fault in the log).
        let removeTap = { [self] (why: String) -> Int in
            let held = clock.nowMs() - start
            // Only a tap still installed now overran: the bound timer also runs after a blip that ended in time (its
            // tap long removed), and that is no overrun (live 2026-10-11: three false faults in one probe run).
            let wasInstalled = reroute.isInstalled
            let n = reroute.end()
            if wasInstalled, held > boundMs + 30 {
                CULog.act.fault("focus blip in \(app, privacy: .public): the keyboard reroute stayed \(Int(held), privacy: .public) ms, over its \(Int(boundMs), privacy: .public) ms bound (\(why, privacy: .public))")
            }
            return n
        }
        let blip = CUFocusBlip(begunMs: start, boundMs: boundMs, space: space, user: user, startedAt: startedAt) { [self] reason, usersMove in
            // The user moved while it lasted (the one decision): theirs — no hand-back, no restore over them.
            if usersMove {
                let rerouted = removeTap(reason)
                CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): ended (\(reason, privacy: .public)) after \(Int(self.clock.nowMs() - start), privacy: .public) ms — the user moved: nothing handed back; \(rerouted, privacy: .public) key event(s) rerouted before")
                return
            }
            // The front or the desktop is not where it began: whose move it was decides first, before any hand-back (a
            // hand-back would take the key focus from wherever they went).
            let nowView = userView()
            if nowView.front != user || (space != nil && nowView.space != nil && nowView.space != space),
               isUsersMove(nowView, since: startedAt, from: CUUserView(space: space, front: user), path: "the focus blip's end") {
                let rerouted = removeTap(reason)
                CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): ended (\(reason, privacy: .public)) — the user moved to \(nowView.front ?? 0, privacy: .public): nothing handed back; \(rerouted, privacy: .public) key event(s) rerouted before")
                return
            }
            // Where the user belongs now: their place as the guardian knows it (it follows their moves), else where the
            // blip began — never merely the pid captured then (review of round 6: the restore ignored where they had gone).
            let place = guardianPlace() ?? CUGuardedView(app: user, space: space)
            let home = place.app ?? user
            if home == user { undo() }  // the user's key window handed back (the record names their window)
            // The user's app must hold the key focus and the front again within `blipFrontWaitMs` (and before the
            // bound); the tap stays until then, so a key typed meanwhile still goes to them.
            let until = min(clock.nowMs() + Self.blipFrontWaitMs, start + boundMs)
            let back = { [self] in keyFocusPidForTarget(t) != t.pid && sys.frontmostPid() == home }
            // The user moving while the blip ends (during its waits): whose move decides again — theirs gets nothing more
            // handed back or restored (the model-based test: the second hand-back went to the app they had just left).
            let homeView = CUUserView(space: place.space ?? space, front: home)
            let usersMoveMeanwhile = { [self] () -> Bool in
                let v = userView()
                guard v.front != home || (homeView.space != nil && v.space != nil && v.space != homeView.space) else { return false }
                return isUsersMove(v, since: startedAt, from: homeView, path: "the focus blip's end, while it waits")
            }
            while clock.nowMs() < until, !back() { clock.pause(ms: 10) }
            if usersMoveMeanwhile() {
                noteGuardianAfterglow(t.pid)
                let rerouted = removeTap(reason)
                CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): ended (\(reason, privacy: .public)) — the user moved while it ended: nothing more handed back; \(rerouted, privacy: .public) key event(s) rerouted before")
                return
            }
            // Not back yet: hand it back once more (the first focus record can be lost while the app is busy),
            // and only then is it a theft for the guardian.
            var handedBackTwice = false
            if !back(), home == user {
                undo()
                handedBackTwice = true
                let again = min(clock.nowMs() + 60, start + boundMs)
                while clock.nowMs() < again, !back() { clock.pause(ms: 10) }
            }
            noteGuardianAfterglow(t.pid)  // an activation right after the blip's end may be its doing
            let rerouted = removeTap(reason)
            if usersMoveMeanwhile() {
                CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): ended (\(reason, privacy: .public)) — the user moved while it ended: nothing restored")
                return
            }
            // Still not back (the front elsewhere, or the keys still going to the target): the guardian restores
            // the user's app, which takes its key focus back with it.
            let front = sys.frontmostPid() == home
            let keys = keyFocusPidForTarget(t) != t.pid
            if handedBackTwice { CULog.act.notice("focus blip in \(app, privacy: .public): the key focus was handed back a second time — back: \(front && keys ? "yes" : "no", privacy: .public)") }
            if !front || !keys {
                guardianRestore(thief: t.pid, fallback: place, force: front,
                                cause: front ? "the focus blip left the key focus with the target" : "the focus blip did not hand the front back")
            }
            CULog.act.notice("focus blip in \(app, privacy: .public) for \(why, privacy: .public): ended (\(reason, privacy: .public)) after \(Int(self.clock.nowMs() - start), privacy: .public) ms; \(rerouted, privacy: .public) key event(s) rerouted to the user's app; the user's app back (front and keys): \(front && keys ? "yes" : "no — the guardian restored it", privacy: .public)")
        }
        if let refusal {
            blip.end("refused")
            throw refusal
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
            guard let blip = try beginBlip(p, t, why: "“\(title)” (try \(attempt))") else {
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
                clock.pause(ms: 20)
            }
            CULog.act.notice("menu in \(t.appName, privacy: .public): “\(title, privacy: .public)” still disabled in the focus blip (try \(attempt, privacy: .public), \(reads, privacy: .public) reads)")
        }
        return .stillDisabled
    }
}

// MARK: keyboard input

extension CUCore {
    /// The bound window's focus read while a keyboard blip holds it key (`CUTarget.blipFocus`): `start` once, after
    /// the first blip of the act settled and before its first key; otherwise after a blip's keys were taken, before it
    /// hands the key focus back (the last such read stands). Only the app's own answer for the window is kept — the
    /// one that says where its keys go.
    func noteBlipFocus(_ t: CUTarget, start: Bool) {
        guard t.accessible else { return }
        let f = windowFocus(t, fresh: true)
        guard f.source == .app, f.element != nil else { return }
        let seq = t.actSeq
        var cur: (act: Int, start: WindowFocus?, end: WindowFocus?) = t.blipFocus.flatMap { $0.act == seq ? $0 : nil } ?? (seq, nil, nil)
        if start { if cur.start == nil { cur.start = f } } else { cur.end = f }
        t.blipFocus = cur
    }

    /// The focus read inside this act's blips, `start` or end.
    func blipFocusRead(_ t: CUTarget, start: Bool) -> WindowFocus? {
        guard let bf = t.blipFocus, bf.act == t.actSeq else { return nil }
        return start ? bf.start : bf.end
    }

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
    /// When the last burst's blip began, and where the user was then.
    private var lastBurstAt: TimeInterval?
    private var lastBurstView: CUUserView?

    init(_ core: CUCore, _ p: TargetActParams, _ t: CUTarget, why: String) {
        self.core = core
        self.p = p
        self.t = t
        self.why = why
    }

    /// Before a key, or a run of keys — read EVERY time (review of round 6: a blip lives up to 1.5 s, and only the first
    /// ~20 ms were judged): when the user's front app or desktop is no longer where the blip began, the one decision
    /// says whose move it was. The user's (they switched into the target, to another app, or to another desktop): the
    /// blip ends with nothing handed back or restored over them and `app_in_front` stops the act. The app's own (it
    /// activated itself), or macOS switching desktops by itself: the blip ends the ordinary way — the user put back — and
    /// the act stops. Either way nothing more is sent.
    func before() throws {
        // A blip its bound already ended counts as none: the check between bursts applies (review of round 7: an ended
        // blip skipped both checks).
        if let b = blip, b.isEnded { blip = nil }
        if let b = blip {
            let front = core.sys.frontmostPid()
            let space = core.sys.activeSpace()
            let spaceMoved = b.space != nil && space != nil && space != b.space
            let frontMoved = front != nil && front != b.user
            if spaceMoved || frontMoved {
                blip = nil
                if core.isUsersMove(CUUserView(space: space, front: front), since: b.startedAt,
                                    from: CUUserView(space: b.space, front: b.user), path: "the agent's next key in the focus blip") {
                    b.end("the user moved", usersMove: true)
                    CULog.act.notice("keys in \(self.t.appName, privacy: .public): the user moved during the focus blip (front \(front ?? 0, privacy: .public)) — stopped, nothing handed back")
                    if frontMoved, let front { throw core.usersMoveRefusal(t, front: front, typed: true) }
                    throw CUError.uncertain("the user switched desktops while keys were going to \(t.appName), so the typing was stopped — they were left where they went; check state() to see what landed")
                }
                if spaceMoved, !frontMoved {
                    b.end("the desktop began to switch")
                    CULog.act.fault("keys in \(self.t.appName, privacy: .public): macOS began switching desktops during the focus blip — stopped")
                    throw CUError.uncertain("macOS began switching desktops while keys were going to \(t.appName), so the typing was stopped (the user's desktop is being put back) — check state() to see what landed")
                }
                b.end("\(front.map { core.appName($0) } ?? "an app") came to the front by itself")
                CULog.act.fault("keys in \(self.t.appName, privacy: .public): \(front ?? 0, privacy: .public) came to the front by itself during the focus blip — stopped")
                throw CUError.uncertain("\(front == t.pid ? t.appName : "another app") came to the front by itself while keys were going to \(t.appName), so the typing was stopped (the user was put back) — check state() to see what landed")
            }
        } else if let front = core.sys.frontmostPid(), front == t.pid,
                  let start = bursts > 0 ? lastBurstView.map({ ($0, lastBurstAt ?? core.clock.nowSeconds()) })
                                         : t.actStart.flatMap({ $0.front == t.pid ? nil : (CUUserView(space: $0.space, front: $0.front), $0.at) }) {
            // The target came to the front since this act began (before its first key, or between two bursts): its window
            // would take the keys with no blip — into the app the user may be using now (the model-based test: the user
            // clicked into it as the act began, and every key went in front of them). Judged the same way, and nothing
            // more is sent either way.
            if core.isUsersMove(core.userView(), since: start.1, from: start.0,
                                path: bursts > 0 ? "the agent's next key between two focus blips" : "the agent's first key") {
                throw core.usersMoveRefusal(t, front: front, typed: bursts > 0)
            }
            throw CUError.uncertain("\(t.appName) came to the front by itself while keys were going to it, so the typing was stopped (the user is being put back) — check state() to see what landed")
        }
        if settled { return }
        if let b = blip, !b.isEnded, core.clock.nowMs() - b.begunMs < core.blipBurstMs { return }
        if let b = blip, !b.isEnded { drain(); core.noteBlipFocus(t, start: false); b.end("its burst was spent") }
        blip = nil
        guard core.needsKeyBlip(p, t) else {
            if bursts == 0 { CULog.act.notice("keys in \(self.t.appName, privacy: .public): the window holds the key focus — no focus blip") }
            settled = bursts == 0
            return
        }
        guard let b = try core.beginBlip(p, t, why: "\(why) (burst \(bursts + 1))", boundMs: core.keyBlipBoundMs, forKeys: true) else {
            settled = true
            return
        }
        blip = b
        lastBurstAt = b.startedAt
        lastBurstView = CUUserView(space: b.space, front: b.user)
        bursts += 1
        // The app takes the key focus as it handles the focus record: keys sent before that are lost.
        if core.blipKeySettleMs > 0 { core.clock.pause(ms: core.blipKeySettleMs) }
        // Where the keys go, as the app answers for its key window — the bound one now.
        if bursts == 1 { core.noteBlipFocus(t, start: true) }
    }

    func end() {
        if let b = blip, !b.isEnded { drain(); core.noteBlipFocus(t, start: false); b.end() }
        blip = nil
    }

    /// The keys just posted are still in the app's queue: held key a moment longer, so they reach this window.
    private func drain() {
        if core.blipDrainMs > 0 { core.clock.pause(ms: core.blipDrainMs) }
    }
}
