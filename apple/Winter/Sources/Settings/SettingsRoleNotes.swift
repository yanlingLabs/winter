import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Roles → "Notes" (2026-09-18).
//
// The user: "if one of those models fails because of rate limits / usage limits / no API credits
// etc. it will show a note there with the model followed by the problem, rather than silently
// failing or showing an annoying error on screen."
//
// THE DATA is the daemon's: `settings.modelRoles` carries, per role, an optional
// `problem: { reason, detail, model, at, retryAt? }` (decoded raw in WinterKit as
// `ModelRoleProblem`). It is cleared DAEMON-side by the role's next successful call and whenever
// its effective model changes, so this file never ages a note out — it renders exactly what was
// reported, and nothing when nothing was.
//
// Three rules this file keeps:
// 1. `reason` stays a STRING. A reason a later daemon adds reaches the screen through the fallback
//    (the daemon's own clipped detail) rather than being dropped by a closed enum.
// 2. A daemon string is never shown verbatim: `detail` goes through `roleProblemClip` (trimmed,
//    one line, capped), even though the daemon already sanitizes and caps it.
// 3. A NOTE, NOT AN ALARM. Muted text in the ordinary card — no red, no warning glyph. The section
//    does not render at all when there is nothing to say.
// -----------------------------------------------------------------------------------------------

/// One role's reported problem, with its timestamps parsed. The failed `model` is the EFFECTIVE tag
/// at the time — which may no longer be the role's model — and is what the note shows.
struct RoleProblem: Equatable, Sendable {
    /// Raw daemon classification (`rate-limited`, `usage-limit`, …) — never an enum.
    let reason: String
    let detail: String?
    let model: String?
    let at: Date?
    /// Present only when the provider said when it comes back.
    let retryAt: Date?
}

/// PURE: an ISO-8601 timestamp, with or without fractional seconds. An unparseable one is nil —
/// it costs the note a time, never the note itself.
func roleProblemDate(_ iso: String?) -> Date? {
    guard let iso else { return nil }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let date = plain.date(from: iso) { return date }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: iso)
}

/// PURE: the wire shape → the pane's.
func roleProblem(_ wire: ModelRoleProblem) -> RoleProblem {
    RoleProblem(reason: wire.reason, detail: wire.detail, model: wire.model,
                at: roleProblemDate(wire.at), retryAt: roleProblemDate(wire.retryAt))
}

/// The cap on a daemon string in a note. Shorter than `shellPanelErrorDetailLimit`: a note is one
/// calm line under a role's name, not a failure report.
let roleProblemDetailLimit = 120

/// PURE: the same clipping rule as `shellPanelErrorText` — trimmed, newlines folded to spaces,
/// capped with an ellipsis — without its "own sentence — " prefix. Nil for nothing to say.
func roleProblemClip(_ text: String?, limit: Int = roleProblemDetailLimit) -> String? {
    guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    let oneLine = trimmed.replacingOccurrences(of: "\r\n", with: " ")
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
    return oneLine.count > limit ? String(oneLine.prefix(limit)) + "…" : oneLine
}

/// PURE: a reason's lookup key — lowercased, `_` and spaces read as `-` — so `rate_limited` and
/// `Rate-Limited` land on the same wording as `rate-limited`.
func roleProblemReasonKey(_ reason: String) -> String {
    reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        .replacingOccurrences(of: "_", with: "-")
        .replacingOccurrences(of: " ", with: "-")
}

/// THE WORDING TABLE: Winter's own calm one-liners for the reasons the daemon classifies today.
/// `rate-limited` and `usage-limit` have a timed variant (`roleProblemText`); `other` is absent on
/// purpose — it means "unclassified", so the daemon's own detail says it better than we could.
let roleProblemWordings: [String: String] = [
    "rate-limited": "Rate limited for now — Winter will try again.",
    "usage-limit": "Usage limit reached.",
    "out-of-credits": "Out of credits — check this provider's billing.",
    "credential-rejected": "The provider didn't accept the stored credential.",
    "no-credential": "No credential is stored for this provider.",
    "model-unavailable": "This model isn't available from the provider right now.",
    "provider-unavailable": "The provider couldn't be reached — usually temporary.",
]

/// When there is nothing better to say: an `other` (or unknown) reason with no detail.
let roleProblemGenericText = "The last call to this model didn't go through."

/// PURE: when a provider comes back, relative and human — "3:40 PM today", "9:00 AM tomorrow",
/// "9:00 AM on Sep 21". `now`, `calendar` (its time zone) and `locale` are injected so the tests
/// are deterministic; the view passes the user's own.
func roleProblemTimeText(_ date: Date, now: Date,
                         calendar: Calendar = .autoupdatingCurrent,
                         locale: Locale = .autoupdatingCurrent) -> String {
    let clock = DateFormatter()
    clock.locale = locale
    clock.timeZone = calendar.timeZone
    clock.setLocalizedDateFormatFromTemplate("jmm")
    let time = clock.string(from: date)
    if calendar.isDate(date, inSameDayAs: now) { return "\(time) today" }
    if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
       calendar.isDate(date, inSameDayAs: tomorrow) {
        return "\(time) tomorrow"
    }
    let day = DateFormatter()
    day.locale = locale
    day.timeZone = calendar.timeZone
    day.setLocalizedDateFormatFromTemplate("MMMd")
    return "\(time) on \(day.string(from: date))"
}

/// PURE: the note's one line.
///
/// - A known reason → its wording. `usage-limit` and `rate-limited` with a FUTURE `retryAt` say
///   when ("resets at …" / "retrying after …"); a `retryAt` already past is dropped rather than
///   telling the user about a moment that has gone.
/// - `other` or a reason this build doesn't know → the daemon's own detail, clipped. With no
///   detail: an unknown reason shows its own (clipped) name — a new reason must still reach the
///   screen — and `other` shows the generic line.
func roleProblemText(_ problem: RoleProblem, now: Date,
                     calendar: Calendar = .autoupdatingCurrent,
                     locale: Locale = .autoupdatingCurrent) -> String {
    let key = roleProblemReasonKey(problem.reason)
    let when = problem.retryAt.flatMap { $0 > now
        ? roleProblemTimeText($0, now: now, calendar: calendar, locale: locale) : nil }
    switch (key, when) {
    case let ("usage-limit", when?): return "Usage limit reached — resets at \(when)."
    case let ("rate-limited", when?): return "Rate limited — retrying after \(when)."
    default: break
    }
    if let wording = roleProblemWordings[key] { return wording }
    if let detail = roleProblemClip(problem.detail) { return detail }
    return key == "other" ? roleProblemGenericText : (roleProblemClip(problem.reason) ?? roleProblemGenericText)
}

/// One rendered note.
struct RoleNote: Identifiable, Equatable, Sendable {
    let role: SettingsModelRole
    /// The tag that FAILED — the problem's own `model`, not the role's current one.
    let model: String?
    let text: String
    var id: SettingsModelRole { role }
}

let settingsRoleNotesTitle = "Notes"

/// PURE: every reported problem as a note, in the page's own role order. Empty ⇒ the section does
/// not render. No role list is hardcoded: whichever role carries a problem gets a note.
func settingsRoleNotes(_ values: [SettingsModelRole: SettingsRoleValue], now: Date,
                       calendar: Calendar = .autoupdatingCurrent,
                       locale: Locale = .autoupdatingCurrent) -> [RoleNote] {
    settingsModelRoleOrder.compactMap { role in
        guard let problem = values[role]?.problem else { return nil }
        return RoleNote(role: role, model: problem.model,
                        text: roleProblemText(problem, now: now, calendar: calendar, locale: locale))
    }
}

/// A note's row: the role's name, the problem under it, and the failed tag on the trailing edge —
/// all in the ordinary card, all muted. Deliberately NOT `SettingsNoteRow(isError:)`, which is red.
struct SettingsRoleNoteRow: View {
    let note: RoleNote

    var body: some View {
        SettingsRow(settingsModelRoleTitle(note.role), description: note.text) {
            Text(note.model ?? settingsModelRoleUnknownValue)
                .font(Typography.controlMono())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
    }
}
