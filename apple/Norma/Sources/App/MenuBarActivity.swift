import Foundation
import NormaProtocol

/// Menu-bar status derived from the daemon's event stream (Task DD-T5). Pure transition function
/// so the mapping is unit-testable; `AppModel` owns the stateful application of it (see
/// `AppModel.handle(_:)`'s derive-and-publish step).
///
/// Adaptation note (brief's `event.typeName` stand-in): `SessionEvent` is a Swift enum with
/// associated values, not a string-discriminated type — there is no `.typeName` accessor anywhere
/// in NormaProtocol/NormaKit (the real uniform accessors on `SessionEvent`, added by NormaKit's
/// `NormaClient.swift`, are `.seq`/`.sessionId` — see the `NormaKit exhaustive-switch trap`
/// precedent). The real way to dispatch on variant is a plain `switch` over the enum's cases
/// themselves, exactly as done below.
///
/// Adaptation note (reasoning-delta type string): the brief guessed a `"reasoning_summary_delta"`
/// case alongside `assistant_delta`. NormaProtocol's `SessionEvent` has no dedicated reasoning-delta
/// variant at all — the daemon's opaque provider reasoning item (`reasoning_item` on the wire,
/// `encrypted_content`/`itemJson`) is deliberately NOT mirrored as a distinct Swift case; it decodes
/// via the `Discriminator` switch's default/unknown path into `NormaClient`'s `.unknownEvent` ->
/// `NormaEvent.unknown`, per CLAUDE.md's "provider `encrypted_content`/`reasoning_item.itemJson` is
/// opaque... never log it" contract. So "reasoning streaming" never reaches this function at all;
/// "assistant streaming" is `.assistantDelta` alone.
enum MenuBarActivity: Equatable {
    case idle, thinking, working

    static func next(after current: MenuBarActivity, event: SessionEvent) -> MenuBarActivity {
        switch event {
        case .assistantDelta:
            return .thinking
        case .toolCall:
            return .working
        case .toolResult:
            return .thinking
        case .turnCompleted, .agentError:
            return .idle
        default:
            return current
        }
    }
}
