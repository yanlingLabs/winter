import Foundation

/// The local answer channel for chat's `AskQuestion` tool — the phone-side stand-in for the daemon's
/// `QuestionBroker` (engine.ts's `ctx.ask`). The engine emits a `question_asked` event, then awaits
/// this broker keyed by the tool call's `callId`; the UI answers via `answer(id:text:)` and the turn
/// continues with the answer folded into the tool result. Same conversational shape as the daemon:
/// question → answer → the loop keeps going, no remote hop (Slice C's card UI re-targets this).
///
/// FIRST-WINS with EARLY-STORE: whoever resolves a `callId` first wins (a user answer, the engine's
/// own timeout, or an interrupt); a resolution that arrives BEFORE the engine's `wait` is stored and
/// returned by that `wait` — so the daemon's "register the wait before emitting" race (a UI that
/// answers the instant it sees `question_asked`) simply cannot drop an answer here.
public actor QuestionBroker {
    public enum Answer: Sendable, Equatable {
        case answered(String)
        /// No answer within the window — the engine tells the model to proceed.
        case timedOut
        /// The turn was interrupted while the question was open.
        case aborted
    }

    private enum Slot {
        case waiting(CheckedContinuation<Answer, Never>)
        case resolved(Answer)
    }

    private var slots: [String: Slot] = [:]

    public init() {}

    /// UI entry point: the user answered `id` with `text`. First resolution wins; a later answer to
    /// an already-resolved id is ignored.
    ///
    /// Returns **`alreadyResolved`** — `true` when this answer LOST the race (the ask window had
    /// already timed out, the turn was interrupted, or another surface answered first), `false` when
    /// it is the one the engine will act on. Without it the phone's card could not tell the two
    /// apart and had to hard-code `false`, so the local path could never surface the daemon's
    /// "answered elsewhere" copy that `approval.respond`/`ask_user` already have (T11 concern 4,
    /// review ruling 4). Early-store still counts as WINNING: an answer that arrives before the
    /// engine's `wait` is held and returned by that `wait`, so it is not resolved-elsewhere.
    @discardableResult
    public func answer(id: String, text: String) -> Bool {
        !resolve(id, .answered(text))
    }

    /// Engine entry point: the ask window elapsed.
    func timeOut(id: String) {
        resolve(id, .timedOut)
    }

    /// Engine entry point: the turn was interrupted with this question open.
    func abort(id: String) {
        resolve(id, .aborted)
    }

    /// Resolves `id`, returning whether THIS resolution won (i.e. is the one `wait` will hand back).
    @discardableResult
    private func resolve(_ id: String, _ answer: Answer) -> Bool {
        switch slots[id] {
        case .waiting(let continuation):
            slots[id] = nil
            continuation.resume(returning: answer)
            return true
        case .resolved:
            return false // first wins
        case nil:
            slots[id] = .resolved(answer) // early resolution — the next `wait` picks it up
            return true
        }
    }

    /// Whether a `wait` for `id` is currently PARKED on its continuation (as opposed to unregistered
    /// or already resolved). Internal, and it exists for one reason: a test that wants to prove the
    /// `.waiting` branch of `resolve` — rather than the early-store branch — has to gate on the
    /// continuation actually being installed, and that is not otherwise observable.
    func isWaiting(id: String) -> Bool {
        if case .waiting? = slots[id] { return true }
        return false
    }

    /// Engine: await the answer for `id`. Returns immediately if `id` was already resolved.
    func wait(id: String) async -> Answer {
        if case .resolved(let answer)? = slots[id] {
            slots[id] = nil
            return answer
        }
        return await withCheckedContinuation { continuation in
            slots[id] = .waiting(continuation)
        }
    }
}
