import SwiftUI
import NormaKit

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

// MARK: - The header affordance

/// app-shell T3: the header's `/background` affordance — the Mac's door onto `session.setActivity`.
///
/// A function-family on `WindowContentView`, the same cross-file extension shape as
/// `WorkingDirsMenu`/`WorkSidebar`, so it renders inside the existing header row beside the
/// folders/model/effort/policy affordances and reads the SAME `currentSidebarSessionSummary` row
/// they read.
///
/// GALLERY EXTENSION POINT: `norma-ios/docs/ios26-design-gallery` has no coverage for an activity
/// verb — the phone's activity work is still on its own debt list (spec §2), so there is no
/// first-party pattern to mirror here and none is invented. What is reused instead is this window's
/// OWN established idiom: a plain icon button opening a small popover, with the daemon's refusal
/// rendered verbatim inside it, exactly like the working-folders chip. When the phone builds its
/// activity surface, that is the direction the language should flow — from a shipped Mac affordance
/// to the gallery, not from a gallery section that does not exist.
extension WindowContentView {
    /// Visible only when the daemon's own row says this session HAS a lifecycle and a verb applies
    /// (`backgroundVerbOffered`), and only on a surface that wired the callback at all
    /// (`adapter.onSetActivity` — every pre-existing window leaves it nil and grows no button).
    var backgroundVerbForCurrentSession: BackgroundVerb? {
        guard adapter.onSetActivity != nil else { return nil }
        return backgroundVerbOffered(activity: currentSidebarSessionSummary?.activity)
    }

    /// The button. Turns RED while a refusal is outstanding — the refusal's SENTENCE lives inside
    /// the popover, but a click can be refused after the popover has closed, so the colour is the
    /// pointer and the sentence is still the daemon's (the folders chip's own reasoning).
    @ViewBuilder
    func backgroundVerbButton(_ verb: BackgroundVerb) -> some View {
        let refused = adapter.activityRefusal != nil
        Button {
            showingActivityMenu = true
        } label: {
            Image(systemName: refused ? "moon.badge.exclamationmark" : (verb == .background ? "moon" : "moon.fill"))
                .font(Typography.body())
                .foregroundStyle(refused ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
        }
        .buttonStyle(.plain)
        .help(backgroundVerbLabel(verb))
        .accessibilityLabel(backgroundVerbLabel(verb))
        .popover(isPresented: $showingActivityMenu, arrowEdge: .bottom) {
            activityMenuContent(verb)
        }
    }

    @ViewBuilder
    func activityMenuContent(_ verb: BackgroundVerb) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Activity")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
            // The daemon's derived state, read off the same row every other header affordance reads.
            Text(activityDisplayLabel(currentSidebarSessionSummary?.activity))
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .padding(.bottom, 6)

            Button(backgroundVerbLabel(verb)) {
                adapter.onSetActivity?(verb.rawValue)
                showingActivityMenu = false
            }
            .buttonStyle(.plain)
            .font(Typography.caption(.medium))
            .disabled(adapter.activityChangeInFlight)
            .padding(.vertical, 3)

            Text(backgroundVerbExplanation(verb))
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 240, alignment: .leading)

            // The daemon's own sentence, verbatim — see `FieldStateAdapter.activityRefusal`.
            if let refusal = adapter.activityRefusal {
                Text(refusal)
                    .font(Typography.caption())
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 240, alignment: .leading)
                    .padding(.top, 6)
            }
        }
        .padding(12)
        .frame(minWidth: 200)
    }
}
