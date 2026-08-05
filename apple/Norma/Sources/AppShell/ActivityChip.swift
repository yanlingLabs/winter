import SwiftUI

// MARK: - The pure decisions (driven directly by ModeLandingViewTests)

/// app-shell T4: which style a session row's chip renders in, off the wire's own `activity` field
/// (`SessionSummary.activity`) alone — never re-derived from anything else. `nil` means NO CHIP AT
/// ALL: chat/dispatch rows carry no `activity` (`ACTIVITY_MODES` — the participation allowlist,
/// mirrored already by `ActivityMenu.backgroundVerbOffered`), and a daemon predating the field looks
/// identical on the wire, so both read as "nothing to say" here, same as everywhere else this field
/// is consumed.
enum ActivityChipStyle: Equatable {
    case active, background, idle, archived
    /// A future activity value this client doesn't know the name of yet — shown verbatim (see
    /// `activityChipLabel`) rather than dropped, the same "the daemon said it, so show it" posture
    /// `activityDisplayLabel` (`ActivityMenu.swift`) already uses for the header affordance.
    case other
}

func activityChipStyle(_ activity: String?) -> ActivityChipStyle? {
    switch activity {
    case "active": return .active
    case "background": return .background
    case "idle": return .idle
    case "archived": return .archived
    case .some: return .other
    case .none: return nil
    }
}

/// The chip's text. `activityDisplayLabel` (`ActivityMenu.swift`) already formats every known value
/// and echoes an unknown one verbatim; the only thing added here is turning its `nil` answer ("—" —
/// meant for a popover header that always has SOME line to show) into an ABSENT chip, which is what
/// "chat rows never chip" means at this layer.
func activityChipLabel(_ activity: String?) -> String? {
    guard let activity else { return nil }
    return activityDisplayLabel(activity)
}

/// The chip's tint per style — presentational only; unlike the label, there is no daemon rule behind
/// the specific colours. Active reads as live work (green), background as ongoing-but-unattended
/// (blue — the header's moon icon lives in the same family), idle/archived/an unknown value all read
/// as quiet (secondary) rather than inventing a meaning for a state this client doesn't understand.
func activityChipColor(_ style: ActivityChipStyle) -> Color {
    switch style {
    case .active: return .green
    case .background: return .blue
    case .idle, .archived, .other: return .secondary
    }
}

// MARK: - The view

/// app-shell T4: the activity chip — a small capsule badge on a landing row.
///
/// GALLERY EXTENSION POINT: `norma-ios/docs/ios26-design-gallery` has no dedicated "status chip"
/// component to mirror (the phone's own activity/landing-tab surfaces are still on its debt list —
/// same honest gap `ActivityMenu.swift` already documents for the `/background` affordance). What
/// DOES transfer is `07-buttons-and-controls.md`'s stated convention — "capsule is the new default
/// shape" — so this reuses the ONE capsule-chip precedent already shipped in this app
/// (`ShellSidebar`'s "Soon" chip, `Capsule().fill(.quaternary)`) rather than inventing a second shape
/// for the same idea.
///
/// Renders NOTHING when the row has no activity at all (`activityChipLabel` returning `nil`) — never
/// an empty capsule.
struct ActivityChip: View {
    let activity: String?

    var body: some View {
        if let label = activityChipLabel(activity), let style = activityChipStyle(activity) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(activityChipColor(style))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(activityChipColor(style).opacity(0.15)))
        }
    }
}
