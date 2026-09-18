import SwiftUI
import WinterKit

// MARK: - The pure decisions (driven directly by ShellChatSurfaceTests)

/// The background verb a surface may offer for a session's DERIVED activity — `nil` when it may
/// offer none at all.
///
/// The rule is the daemon's, mirrored rather than re-invented (`sessions/set-activity.ts`):
///
/// * `nil` activity — the session does not PARTICIPATE in the lifecycle (chat/dispatch, or a daemon
///   predating the field). `session.setActivity` refuses it outright with "activity states apply to
///   code and cowork sessions only", so an affordance here would be a button whose every click is a
///   refusal. The same "the daemon's own participation answer is the gate" shape `dirsMenuIsVisible`
///   already uses for the working-folders chip, off the same `session.list` row.
/// * `"archived"` — ARCHIVED IS IMMUTABLE EXCEPT THROUGH RESUME (activity-verb-semantics ruling 1):
///   both background verbs are refused with "session is archived — resume it first". Resume is a
///   real verb, but it belongs to the Archived tab that owns archived rows (T4), not to a
///   background toggle in a transcript header.
/// * an unrecognized future value — no guess. The daemon may grow a fifth state; offering it the
///   verb we happen to have is exactly the client-side guessing this codebase keeps deleting.
enum BackgroundVerb: String, Equatable {
    /// "Keep running unattended" — sets the background flag.
    case background
    /// Clears the background flag ONLY (never the archive one — one verb, one flag).
    case unbackground
}

func backgroundVerbOffered(activity: String?) -> BackgroundVerb? {
    switch activity {
    case "background": return .unbackground
    case "active", "idle": return .background
    default: return nil
    }
}

/// The verb's button label. "Background" is the CLI's own word for it (`/background`), and
/// "Foreground" is deliberately NOT used for its opposite: the daemon's verb clears a flag, it does
/// not bring anything forward, and the honest reading of the cleared state is "watch it here".
func backgroundVerbLabel(_ verb: BackgroundVerb) -> String {
    switch verb {
    case .background: return "Background"
    case .unbackground: return "Stop backgrounding"
    }
}

/// One sentence explaining what the verb does, shown under it — this is the affordance a user meets
/// at the hop-away-mid-turn moment (spec §1), so what "background" actually means has to be legible
/// at the moment of choosing it.
func backgroundVerbExplanation(_ verb: BackgroundVerb) -> String {
    switch verb {
    case .background: return "Keep this session running unattended while you look at something else."
    case .unbackground: return "Stop treating this as unattended work."
    }
}

/// How a session's derived activity reads in the affordance's header line. Unknown values render
/// verbatim rather than being coerced to something familiar — the daemon said it, so it is shown.
func activityDisplayLabel(_ activity: String?) -> String {
    switch activity {
    case "active": return "Active"
    case "background": return "Background"
    case "idle": return "Idle"
    case "archived": return "Archived"
    case .some(let other): return other
    case .none: return "—"
    }
}
