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
    public func answer(id: String, text: String) {
        resolve(id, .answered(text))
    }

    /// Engine entry point: the ask window elapsed.
    func timeOut(id: String) {
        resolve(id, .timedOut)
    }

    /// Engine entry point: the turn was interrupted with this question open.
    func abort(id: String) {
        resolve(id, .aborted)
    }

    private func resolve(_ id: String, _ answer: Answer) {
        switch slots[id] {
        case .waiting(let continuation):
            slots[id] = nil
            continuation.resume(returning: answer)
        case .resolved:
            break // first wins
        case nil:
            slots[id] = .resolved(answer) // early resolution — the next `wait` picks it up
        }
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
