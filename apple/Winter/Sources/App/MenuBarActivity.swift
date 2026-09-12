import Foundation
import WinterProtocol

/// Menu-bar status derived from the daemon's event stream (Task DD-T5). Pure transition function
/// so the mapping is unit-testable; `AppModel` owns the stateful application of it (see
/// `AppModel.handle(_:)`'s derive-and-publish step).
///
/// Adaptation note (brief's `event.typeName` stand-in): `SessionEvent` is a Swift enum with
/// associated values, not a string-discriminated type — there is no `.typeName` accessor anywhere
/// in WinterProtocol/WinterKit (the real uniform accessors on `SessionEvent`, added by WinterKit's
/// `WinterClient.swift`, are `.seq`/`.sessionId` — see the `WinterKit exhaustive-switch trap`
/// precedent). The real way to dispatch on variant is a plain `switch` over the enum's cases
/// themselves, exactly as done below.
///
/// Adaptation note (reasoning-delta type string): the brief guessed a `"reasoning_summary_delta"`
/// case alongside `assistant_delta`. WinterProtocol's `SessionEvent` has no dedicated reasoning-delta
/// variant at all — the daemon's opaque provider reasoning item (`reasoning_item` on the wire,
/// `encrypted_content`/`itemJson`) is deliberately NOT mirrored as a distinct Swift case: there is no
/// `Discriminator` case for `"reasoning_item"` at all, so `Discriminator(rawValue:)` simply fails for
/// it, `SessionEvent.init(from:)` throws, and WinterKit's `parseServerLine`'s `try?` catches that
/// throw, producing `.unknownEvent` -> `WinterEvent.unknown` — it never becomes a `SessionEvent`
/// (there is no "default/unknown path" within a `SessionEvent` switch to speak of). This lines up
/// with CLAUDE.md's "provider `encrypted_content`/`reasoning_item.itemJson` is opaque... never log
/// it" contract. So "reasoning streaming" never reaches this function at all; "assistant streaming"
/// is `.assistantDelta` alone.
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
