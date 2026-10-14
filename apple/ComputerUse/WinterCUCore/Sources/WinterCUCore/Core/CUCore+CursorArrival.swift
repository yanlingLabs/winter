import CoreGraphics
import Foundation

/// The arrival gate (WinterCUPresentation's DESIGN-cursor.md, "Arrival"). The agent cursor glides to an act's place
/// before the act lands there, so the act's real input — an AX press, a posted click, typing, a key, a scroll, a drag —
/// waits for it: the page reacts when the arrow is there, and the press pulse plays at the moment of the real click.
/// The wait is the presentation's own answer (0 when no cursor is drawn: an off-screen window, another desktop, a
/// covered or hidden cursor, Reduce Motion, a cursor already resting there, no presentation at all), bounded (0.4 s).
extension CUCore {
    /// The cursor kinds whose place the act's input is about to land on.
    static let arrivalGated: Set<String> = ["target", "press", "type", "key", "scroll", "drag"]

    /// Right after an act's own place-bound cursor event: asks the shell how long until the on-screen cursor has
    /// arrived — on the main queue, behind that very event (FIFO) — and pauses the act's pid queue that long. Never
    /// on the main thread. Bounded by `cursorArrivalCapMs` per place the act lands on, the main-queue answer included,
    /// so a busy main thread can't hold the act either: the budget starts again at the act's start and at each reticle
    /// ("target"), and the event after it (the press on that element) shares it.
    ///
    /// No ask at all when the presentation said this target's cursor is not drawn where the user can see it (off screen,
    /// another desktop, covered, Reduce Motion: `cursorDrawn`), or when the act was already cancelled. The wait itself
    /// ends early on the act's cancel (an Esc): the caller's next `token.check()` then stops the act before its input.
    func awaitCursorArrival(_ t: CUTarget, kind: String) {
        if kind == "target" { t.arrivalWaitedMs = 0 }
        let budget = cursorArrivalCapMs - t.arrivalWaitedMs
        guard budget > 0, events != nil, !Thread.isMainThread, t.actToken?.isCancelled != true,
              cursorBoard.mayBeDrawn(sessionId: t.sessionId, pid: t.pid, windowID: t.windowID) else { return }
        let started = clock.nowMs()
        let answer = ArrivalAnswer()
        let (session, pid, wid) = (t.sessionId, t.pid, t.windowID)
        DispatchQueue.main.async { [weak self] in
            let seconds = MainActor.assumeIsolated {
                self?.events?.cursorArrival(sessionId: session, pid: pid, windowID: wid) ?? 0
            }
            answer.set(seconds)
        }
        let asked = answer.ready.wait(timeout: .now() + budget / 1000) == .success
        let spent = max(0, clock.nowMs() - started)
        guard asked else {
            t.arrivalWaitedMs = cursorArrivalCapMs
            logOnce("arrival-gate-timeout", "the agent cursor's arrival was not answered within \(Int(budget)) ms — acting without waiting for it")
            return
        }
        var left = min(answer.seconds * 1000, budget - spent)
        var waited = 0.0
        while left > 0, t.actToken?.isCancelled != true {
            let slice = min(left, Self.arrivalSliceMs)
            clock.pause(ms: slice)
            waited += slice
            left -= slice
        }
        t.arrivalWaitedMs += spent + waited
    }

    /// The arrival wait's step: an Esc ends it within this.
    static let arrivalSliceMs: Double = 20

    /// The presentation's word on whether a target's agent cursor is drawn where the user can see it (the shell
    /// forwards `CUPresentation.onCursorDrawn` here, on the main actor). While it is not, the arrival gate asks nothing.
    public func cursorDrawn(sessionId: String, pid: pid_t, windowID: CGWindowID, _ drawn: Bool) {
        cursorBoard.set(sessionId: sessionId, pid: pid, windowID: windowID, drawn: drawn)
    }
}

/// Which targets' cursors are known NOT to be drawn (thread-safe: written on the main actor, read on the pid queues).
/// A target it never heard of may be drawn — the gate asks.
final class CUCursorBoard: @unchecked Sendable {
    private struct Key: Hashable { let sessionId: String; let pid: pid_t; let windowID: CGWindowID }
    private let lock = NSLock()
    private var undrawn = Set<Key>()

    func set(sessionId: String, pid: pid_t, windowID: CGWindowID, drawn: Bool) {
        let key = Key(sessionId: sessionId, pid: pid, windowID: windowID)
        lock.withLock { if drawn { undrawn.remove(key) } else { undrawn.insert(key) } }
    }

    func mayBeDrawn(sessionId: String, pid: pid_t, windowID: CGWindowID) -> Bool {
        let key = Key(sessionId: sessionId, pid: pid, windowID: windowID)
        return lock.withLock { !undrawn.contains(key) }
    }

    func forget(sessionId: String) {
        lock.withLock { undrawn = undrawn.filter { $0.sessionId != sessionId } }
    }
}

/// The main queue's answer to the arrival gate, handed to the waiting pid queue.
private final class ArrivalAnswer: @unchecked Sendable {
    let ready = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var _seconds: TimeInterval = 0
    var seconds: TimeInterval { lock.withLock { _seconds } }
    func set(_ s: TimeInterval) {
        lock.withLock { _seconds = max(0, s.isFinite ? s : 0) }
        ready.signal()
    }
}
