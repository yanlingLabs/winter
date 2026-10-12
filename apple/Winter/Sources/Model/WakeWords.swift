import Foundation

/// ComputerV2 wake triggers (2026-10-12): one trigger the session's model armed (`wake_armed`) and that has not ended.
/// The labels are what the user sees — the target ("Chrome — Developer Dashboard") and, for most conditions, the
/// element or text it watches (“Submit for review”, already quoted by the daemon). Never the model's own note.
struct ArmedWake: Equatable, Identifiable, Sendable {
    let wakeId: String
    /// `clicked`, `submitted`, `navigated`, `appeared`, `gone`, `changed` or `titled` (a newer word reads generically).
    let condition: String
    let targetLabel: String
    let elementLabel: String?
    /// Epoch milliseconds.
    let expiresAt: Int

    var id: String { wakeId }
}

/// The Mac's words for wake triggers — the pill ("Waiting for you · click “Submit for review” in Chrome · 52 min left"),
/// and the note a `computer-wake` message becomes ("Winter continued: you clicked “Submit for review” in Chrome"). The
/// terminal says the same with its own copy (`packages/cli/src/wake-words.ts`).
enum WakeWords {
    /// Mirrors core's `COMPUTER_WAKE_CLIENT_NAME` (`packages/protocol/src/events.ts`): the `clientName` of the daemon's
    /// wake message — rendered as a notice, never as a user bubble (`SessionReducer`).
    static let computerWakeClientName = "computer-wake"

    /// The endings that wake the session (`cancelled` and `disabled` never do; `expired` only when the model asked —
    /// the wake message then follows and its notice says so).
    static let wakingReasons: Set<String> = ["fired", "lost", "expired", "restart"]

    /// What Winter waits for, as the pill's middle: "click “Submit for review” in Chrome — Developer Dashboard".
    static func waitingFor(_ w: ArmedWake) -> String {
        let t = w.targetLabel.isEmpty ? "the app" : w.targetLabel
        let el = w.elementLabel
        switch w.condition {
        case "clicked": return "click \(el ?? "an element") in \(t)"
        case "submitted": return "submit \(el ?? "the form") in \(t)"
        case "changed": return "change \(el ?? "a field") in \(t)"
        case "navigated": return el.map { "\(t) to reach \($0)" } ?? "\(t) to move to another page"
        case "appeared": return "\(el ?? "the text") to appear in \(t)"
        case "gone": return "\(el ?? "an element") to go away in \(t)"
        case "titled": return "\(t)'s title to contain \(el ?? "the text")"
        default: return "something in \(t)"
        }
    }

    /// What happened, for an ending that woke the session: "you clicked “Submit for review” in Chrome".
    static func endedWords(_ w: ArmedWake, reason: String) -> String {
        let t = w.targetLabel.isEmpty ? "the app" : w.targetLabel
        let el = w.elementLabel
        switch reason {
        case "lost": return "\(t) went away while Winter waited"
        case "expired": return "the wait ran out (\(waitingFor(w)))"
        case "restart": return "Winter restarted while it waited (\(waitingFor(w)))"
        default: break
        }
        switch w.condition {
        case "clicked": return "you clicked \(el ?? "it") in \(t)"
        case "submitted": return "you submitted \(el ?? "the form") in \(t)"
        case "changed": return "you changed \(el ?? "the field") in \(t)"
        case "navigated": return el.map { "\(t) reached \($0)" } ?? "\(t) moved to another page"
        case "appeared": return "\(el ?? "the text") appeared in \(t)"
        case "gone": return "\(el ?? "it") went away in \(t)"
        case "titled": return "\(t)'s title now contains \(el ?? "the text")"
        default: return "the wait in \(t) ended"
        }
    }

    /// "52 min left", "1 h 5 min left", "under a minute left" — rounded UP, so a trigger never reads as ended early.
    static func timeLeft(_ w: ArmedWake, now: Date) -> String {
        let ms = Double(w.expiresAt) - now.timeIntervalSince1970 * 1000
        guard ms > 60_000 else { return "under a minute left" }
        let minutes = Int((ms / 60_000).rounded(.up))
        if minutes <= 60 { return "\(minutes) min left" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "\(hours) h left" : "\(hours) h \(rest) min left"
    }

    /// The whole pill line for one trigger: "Waiting for you · click “Submit for review” in Chrome · 52 min left".
    static func pillLine(_ w: ArmedWake, now: Date) -> String {
        "Waiting for you · \(waitingFor(w)) · \(timeLeft(w, now: now))"
    }
}
