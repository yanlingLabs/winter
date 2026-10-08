import Foundation
import WinterProtocol

/// Holds a session's REPLAYED history while it arrives and hands it over once, complete, to be folded with ONE
/// publish (`SessionModel.apply(replay:)`).
///
/// `SessionFeed` does this for a window's pinned session; the orb feed (`AppModel`, which the Dispatch pill
/// follows) did not: it re-attached from seq 0 on every refocus and applied the whole log event by event — each
/// one a copy of the session state and a publish, so a long Dispatch session took minutes to arrive and held the
/// main thread the whole time (the pill frozen, the transcript behind).
///
/// The replay is complete when the event at `attach`'s ceiling arrives (the `harness_attached` of that very
/// attach), at once if it is already in hand or the attach failed, or `fallback` seconds after the last event
/// held — an idle timer, so a long history that takes a while is never cut in two.
@MainActor
final class ReplayBuffer {
    static let fallback: TimeInterval = 1.5

    /// Called once with everything held, in order, when the replay is complete.
    var onFinish: (([SessionEvent]) -> Void)?

    private var held: [SessionEvent]?
    private var ceiling: Int?
    private var deadline: DispatchWorkItem?
    private let fallback: TimeInterval

    init(fallback: TimeInterval = ReplayBuffer.fallback) { self.fallback = fallback }

    var isReplaying: Bool { held != nil }
    /// Events held right now (the backlog a hang report names).
    var count: Int { held?.count ?? 0 }

    /// A replay is about to be asked for: hold everything from here until it is complete.
    func begin() {
        deadline?.cancel()
        deadline = nil
        held = []
        ceiling = nil
    }

    /// The attach has answered with its ceiling (`nil`: it failed, so no replay is coming).
    func arm(ceiling: Int?) {
        guard held != nil else { return }
        guard let ceiling else { finish(); return }
        self.ceiling = ceiling
        if held?.contains(where: { !$0.isTransient && $0.seq >= ceiling }) == true { finish(); return }
        armDeadline()
    }

    /// Holds `event` if a replay is in progress; true when it was held (the caller must not apply it).
    func hold(_ event: SessionEvent) -> Bool {
        guard held != nil else { return false }
        held?.append(event)
        // Only a PERSISTED event can be the ceiling: a transient carries the store's current last seq.
        if let ceiling, !event.isTransient, event.seq >= ceiling { finish() } else { armDeadline() }
        return true
    }

    /// Completes the replay now with what is held (a connection change, the fallback, the ceiling).
    func finish() {
        deadline?.cancel()
        deadline = nil
        ceiling = nil
        guard let events = held else { return }
        held = nil
        onFinish?(events)
    }

    private func armDeadline() {
        guard ceiling != nil else { return } // armed once the attach has answered
        deadline?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.finish() } }
        deadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + fallback, execute: work)
    }
}
