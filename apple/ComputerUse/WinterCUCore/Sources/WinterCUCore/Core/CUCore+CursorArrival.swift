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
    func awaitCursorArrival(_ t: CUTarget, kind: String) {
        if kind == "target" { t.arrivalWaitedMs = 0 }
        let budget = cursorArrivalCapMs - t.arrivalWaitedMs
        guard budget > 0, events != nil, !Thread.isMainThread else { return }
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
        let wait = min(answer.seconds * 1000, budget - spent)
        if wait > 0 { clock.pause(ms: wait) }
        t.arrivalWaitedMs += spent + max(0, wait)
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
