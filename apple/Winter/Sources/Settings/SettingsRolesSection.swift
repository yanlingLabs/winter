import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Roles (2026-09-17). The one GENUINELY NEW settings section: "which model does each
// job".
//
// WHAT THIS READS, AND WHAT IT DOES WHEN IT CANNOT — read this before extending the file.
//
// UPDATE 2026-09-18 — WIRED. The door is `settings.modelRoles` (read) and `settings.setModelRole`
// (write): ONE method over all NINE keys, not pins-only, which would have stranded the three strays
// below. The read carries, per role: the effective model, whether it is EXPLICIT or DEFAULTED, the
// CONSTRAINT on what may be chosen for it, and the permitted set the daemon can actually serve
// today. `runtimes.advisorModel` is on the same door, so the advisor is a real row here now.
//
// STILL READ-ONLY, deliberately: the write wrapper exists (`WinterClient.setModelRole`, carried on
// `DashboardWiring.setModelRole`) but no control here calls it. Pickers are the next step, and the
// rule below about where their contents come from binds them.
//
// **THE DAEMON MAY NOT HAVE THE METHOD.** It landed after the app learned to call it, so a
// `winter-core` from before answers `-32601`. `SettingsRolesModel` turns that one code into
// `isUnsupported` and the pane renders EXACTLY what it rendered before this wiring — "—" per row
// and the unreadable note — because a pane that instead showed nine blank rows with no explanation,
// or a red error, would be lying about a perfectly healthy Winter. Every other failure is a real
// failure and says so.
//
// Two rules the later commit must keep:
//
// 1. **The value is the daemon's to report, not ours to compute.** `pinsFor`'s defaults are
//    provider-derived and have already moved once (0.114.1: a pin with no catalog row now falls
//    back to the user's own tag instead of a sentinel). Mirroring that rule in Swift would
//    guarantee the app eventually disagrees with the daemon about what is actually running. So the
//    view takes `values` — an injected `[SettingsModelRole: String]`, empty today — and renders
//    whatever the daemon said, or "—" when it said nothing.
// 2. **Never hardcode which providers a role may use.** The permitted-models list per role is part
//    of the payload the daemon is gaining; a picker added here must be populated from it. An
//    app-side allowlist would be stale the moment the agent SDK's catalog grows (which happens on
//    an SDK bump, with no app release — the same reason `CredentialRow`'s fields are plain strings).
//
// 3. **The default session model is not a peer of the others.** `provider.model` rebinds the
//    daemon's own internal provider, and every pin's DEFAULT is derived from it — so changing it
//    silently moves every role the user has not pinned explicitly. That is the entire reason the
//    read carries "explicit or defaulted" and this pane shows it: a user who changes the top row
//    can see which rows moved underneath them.
//
// The advisor keeps its live picker in the composer's model menu (`WinterComposerCard` →
// `FieldStateAdapter.applyAdvisorModelSelection` → `settings.setAdvisorModel`); the row here is the
// same setting through the same door, not a second one.
// -----------------------------------------------------------------------------------------------

/// One job a model is picked for. The raw value is the **settings.json path** the daemon stores it
/// at — not a display string — so the later `settings.setPin` wiring has an unambiguous key to send
/// and this enum cannot drift from the schema without someone noticing they had to edit it.
///
/// `sessionDefault`, `titles`, `bashReviewer` and `advisor` are NOT `pins.*` entries (they predate that block
/// and live at `provider.model` / `titles.model` / `reviewer.model`). They are roles all the same —
/// the user asked "which model does each job", and the answer does not care which settings block a
/// job's answer happens to be stored in. Whatever RPC lands must therefore accept all eight keys,
/// which is what the landing door does (all nine, one method).
enum SettingsModelRole: String, CaseIterable, Hashable, Sendable {
    case sessionDefault = "provider.model"
    case dispatch = "pins.dispatch"
    case dream = "pins.dream"
    case cleaner = "pins.cleaner"
    case titles = "titles.model"
    case research = "pins.research"
    case researchFallback = "pins.researchFallback"
    case bashReviewer = "reviewer.model"
    case advisor = "runtimes.advisorModel"
}

/// What the daemon reports for one role. Three fields, because a bare model tag cannot answer the
/// question the pane exists to answer: "is this model chosen, or is it just what the default rule
/// happens to produce today?"
struct SettingsRoleValue: Equatable, Sendable {
    /// The tag actually in force, provider-qualified (`openai/gpt-5.6-terra`).
    ///
    /// OPTIONAL, because eight of the nine roles accept `null` — a cleared role. That is a real,
    /// renderable state ("None") and is NOT the same as this whole value being absent, which means
    /// the daemon told us nothing about the role at all.
    let model: String?
    /// False when nothing is pinned and this is the derived default — which means it MOVES when the
    /// default session model changes.
    let isExplicit: Bool
    /// What the daemon will accept for this role: `any` | `internal-provider` | `same-as-session`.
    /// Kept as the RAW wire string, never an enum — a constraint a later daemon adds must reach the
    /// screen (through `settingsRoleConstraintNote`'s fallback) rather than be dropped by a decode
    /// that only knows three.
    let constraint: String
    /// The tags the daemon can serve for this role today, flattened across providers in the wire's
    /// own provider order. Empty is meaningful: it means the daemon named none, NOT that the role
    /// admits none — so a picker must stay disabled rather than render an empty menu.
    ///
    /// The provider GROUPING is not lost, it is just not needed yet: it lives on
    /// `ModelRolePermittedProvider` (WinterKit) and is what a picker should group its menu by.
    ///
    /// **This is CATALOG ELIGIBILITY, not "these will work"** (2026-09-18, from the session that
    /// built the read): for an unconstrained role it names every non-blocked provider whether or
    /// not a key is stored for it. A picker built on this alone will happily offer a provider the
    /// user has no credential for — pairing it with the credential state Settings → Providers
    /// already reads is what turns it into an honest list.
    let permitted: [String]
}

/// A named run of roles. Grouped rather than flat because the eight rows answer four different
/// questions — what you talk to, what runs behind your back, what reads the web, what checks a
/// command before it runs — and an ungrouped list makes "cleaner" look like a peer of "the model
/// every new chat starts on", which it very much is not.
struct SettingsModelRoleGroup: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let roles: [SettingsModelRole]
}

/// THE role information architecture. `settingsModelRoleOrder` derives from it, so the rendered
/// list and the order can never disagree (same device as `settingsSectionGroups`).
let settingsModelRoleGroups: [SettingsModelRoleGroup] = [
    SettingsModelRoleGroup(id: "sessions", title: "Sessions",
                           roles: [.sessionDefault, .dispatch]),
    SettingsModelRoleGroup(id: "housekeeping", title: "Behind the scenes",
                           roles: [.dream, .cleaner, .titles]),
    SettingsModelRoleGroup(id: "research", title: "Research",
                           roles: [.research, .researchFallback]),
    SettingsModelRoleGroup(id: "safety", title: "Safety",
                           roles: [.bashReviewer]),
    SettingsModelRoleGroup(id: "advice", title: "Advice",
                           roles: [.advisor]),
]

let settingsModelRoleOrder: [SettingsModelRole] = settingsModelRoleGroups.flatMap(\.roles)

/// PURE: the role's row title — the user's word for the job, never the settings key.
func settingsModelRoleTitle(_ role: SettingsModelRole) -> String {
    switch role {
    case .sessionDefault: return "Default session model"
    case .dispatch: return "Dispatch"
    case .dream: return "Dreaming"
    case .cleaner: return "Purge"
    case .titles: return "Chat titles"
    case .research: return "Research"
    case .researchFallback: return "Research fallback"
    case .bashReviewer: return "Command reviewer"
    case .advisor: return "Advisor"
    }
}

/// PURE: what the job IS, in the user's terms — deliberately describing the WORK, not the default
/// rule. The default is the daemon's answer and arrives as a value; a sentence here that also
/// explained the fallback chain would be a second source of truth for it, and the wrong one first.
func settingsModelRoleExplanation(_ role: SettingsModelRole) -> String {
    switch role {
    case .sessionDefault:
        return "The model a new chat starts on. Changing a single session's model never changes this."
    case .dispatch:
        return "The background session you hand tasks to. It keeps working with no chat window open."
    case .dream:
        return "Dreaming: the pass that turns what happened into the memories Winter keeps."
    case .cleaner:
        return "The purge: it reads old, idle chats and decides which ones were never worth keeping."
    case .titles:
        return "Names a chat from its first exchange, so the sidebar isn't a list of \"New chat\"."
    case .research:
        return "The short-lived research helper that reads pages and searches the web for an answer."
    case .researchFallback:
        return "Used when the research model can't be reached or refuses the job."
    case .bashReviewer:
        return "Reads a shell command before it runs and flags the dangerous ones. Only on the auto policy."
    case .advisor:
        return "The second opinion Winter asks mid-task. The composer's model menu sets the same thing."
    }
}

/// PURE: the sentence shown in place of a value when the daemon WAS asked. Covers the two cases
/// that are one fact from the pane's side — the daemon predates `settings.modelRoles`, or it
/// answered without naming this role. It never says anything is wrong, because nothing is.
let settingsModelRoleUnreadableNote = "Not reported — this daemon can't tell Winter about this one."

/// PURE: the same slot when the pane has NO DOOR — no loader was passed, so nothing was ever asked
/// and blaming the daemon would be a guess about a daemon we never spoke to. This is the state the
/// live app is in until `SettingsSurface` passes `loader:` (see this type's own doc).
let settingsModelRoleUnwiredNote = "Not readable yet — Winter can't ask the daemon for this one."

/// The em dash a role with no reported value shows. A blank cell reads as "no model", which is
/// never true: every role always resolves to something daemon-side.
let settingsModelRoleUnknownValue = "—"

/// PURE: the badge beside a value. "Pinned" is a choice someone made; "Default" is a value that
/// will move on its own when the default session model changes — which is the one thing a user
/// reading this pane most needs to be able to tell apart.
func settingsRoleValueBadge(_ value: SettingsRoleValue) -> String {
    value.isExplicit ? "Pinned" : "Default"
}

/// PURE: whether changing the default session model would move this role. The top row itself is
/// excluded — it is the cause, not one of the things carried along.
func settingsRoleFollowsSessionDefault(_ role: SettingsModelRole, value: SettingsRoleValue) -> Bool {
    role != .sessionDefault && !value.isExplicit
}

/// PURE: what a cleared role shows in the value column. Distinct from
/// `settingsModelRoleUnknownValue` ("—"), which means "the daemon said nothing": this one means the
/// daemon said `null`, and the two must never render the same.
let settingsModelRoleClearedValue = "None"

/// PURE: the constraint, in the user's terms — or nil when there is nothing worth saying (`any`,
/// which is most rows, and would be noise on all of them).
///
/// An unrecognised constraint is shown VERBATIM rather than hidden: a daemon that grows a fourth
/// one is telling the user something real about what this role will accept, and a client that
/// silently drops it would make a later refusal inexplicable.
func settingsRoleConstraintNote(_ constraint: String) -> String? {
    switch constraint {
    case "any": return nil
    case "internal-provider": return "Only a provider Winter can call on its own."
    case "same-as-session": return "Follows whatever the session itself is running."
    default: return "Constraint: \(constraint)"
    }
}

/// PURE: `settings.modelRoles`' wire map → the pane's values.
///
/// Keyed by the settings path, which is exactly `SettingsModelRole.rawValue` — that is why the enum
/// stores paths rather than display strings. A key this build has no case for (a role a later
/// daemon adds) is DROPPED here: the pane can only render rows it has copy for, and inventing a row
/// title from a settings path would put `pins.somethingNew` in front of a user as if it were a
/// sentence.
func settingsModelRoleValues(_ roles: [String: ModelRoleValue]) -> [SettingsModelRole: SettingsRoleValue] {
    var out: [SettingsModelRole: SettingsRoleValue] = [:]
    for (key, value) in roles {
        guard let role = SettingsModelRole(rawValue: key) else { continue }
        out[role] = SettingsRoleValue(
            model: value.model,
            isExplicit: value.explicit,
            constraint: value.constraint,
            permitted: value.permitted.flatMap(\.models)
        )
    }
    return out
}

// -----------------------------------------------------------------------------------------------

/// The pane's state. Four cases kept apart, because three of them would otherwise be the same
/// empty map: no door at all, a daemon without the method, a real failure, and an answer.
@MainActor
final class SettingsRolesModel: ObservableObject {
    typealias Loader = () async throws -> [String: ModelRoleValue]

    private let loader: Loader?

    @Published private(set) var values: [SettingsModelRole: SettingsRoleValue] = [:]
    @Published private(set) var loading = false
    /// Latched by `-32601` alone — this daemon predates `settings.modelRoles`. Expected; not shown
    /// as an error.
    @Published private(set) var isUnsupported = false
    @Published private(set) var errorText: String?

    var isUnwired: Bool { loader == nil }

    init(loader: Loader? = nil) {
        self.loader = loader
    }

    func refresh() async {
        guard let loader else { return }
        loading = true
        defer { loading = false }
        do {
            values = settingsModelRoleValues(try await loader())
            errorText = nil
            isUnsupported = false
        } catch {
            if isMethodNotFoundError(error) {
                isUnsupported = true
                errorText = nil
                return
            }
            // The last good map is kept on screen — a failed refresh must not blank a pane someone
            // is reading. `"\(error)"`, not `localizedDescription`: `RpcError` is a plain `Error`
            // and Foundation renders it as "The operation couldn't be completed."
            errorText = shellPanelErrorText("Couldn't read the model roles", detail: "\(error)")
        }
    }
}

// -----------------------------------------------------------------------------------------------

/// Settings → Roles. Read-only by construction: no bindings, no buttons — a value can reach this
/// view (through `loader`, or injected directly as `values`) but none can leave it.
///
/// `loader:` is DEFAULTED to nil so the existing construction sites (`SettingsSurface.swift`'s two
/// `SettingsRolesSection()` calls, a file this change does not own) keep compiling and keep
/// rendering the unreadable state. Passing `wiring.modelRoles` there is the one edit that lights
/// every row up.
///
/// Adding a picker later means one control per row, populated from that row's `permitted` list and
/// writing through `DashboardWiring.setModelRole` — never from an app-side allowlist, which would
/// be stale the moment the agent SDK's catalog grows (an SDK bump ships with no app release).
struct SettingsRolesSection: View {
    @StateObject private var model: SettingsRolesModel
    /// Directly-injected values, used when no loader has produced any. Kept for pure construction
    /// (previews, tests) — the live pane goes through `loader`.
    private let injected: [SettingsModelRole: SettingsRoleValue]

    init(values: [SettingsModelRole: SettingsRoleValue] = [:],
         loader: SettingsRolesModel.Loader? = nil) {
        self.injected = values
        _model = StateObject(wrappedValue: SettingsRolesModel(loader: loader))
    }

    /// The loaded map wins once there is one; `injected` is the fallback, so a pane constructed
    /// with literal values behaves exactly as it did before the loader existed.
    private var values: [SettingsModelRole: SettingsRoleValue] {
        model.values.isEmpty ? injected : model.values
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                intro
                if let errorText = model.errorText {
                    Text(errorText)
                        .font(Typography.caption())
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(settingsModelRoleGroups) { group in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(group.title)
                            .font(Typography.caption(.semibold))
                            .foregroundStyle(Theme.textMuted)
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(group.roles, id: \.self) { role in
                                roleRow(role)
                                if role != group.roles.last {
                                    Divider()
                                }
                            }
                        }
                    }
                }
            }
            .padding(.top, 18)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        // Read-only and params-less, so re-asking on every open is free and always current — the
        // same re-seed-on-appear posture every other pane has. A daemon without the method answers
        // once and latches `isUnsupported`; it is not retried into a spin.
        .task { await model.refresh() }
    }

    private var intro: some View {
        Text("Winter runs more than one model. These are the jobs it splits between them.")
            .font(Typography.label())
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func roleRow(_ role: SettingsModelRole) -> some View {
        let value = values[role]
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(settingsModelRoleTitle(role))
                    .font(Typography.control(.semibold))
                Spacer(minLength: 12)
                if let value, settingsRoleFollowsSessionDefault(role, value: value) {
                    // Says WHY this value is what it is, and warns that it is not anchored: change
                    // the top row and this one follows.
                    Text(settingsRoleValueBadge(value))
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                }
                // Three different strings for three different facts: the tag, "None" for a role
                // the daemon reported as cleared, and "—" for a role it did not report at all.
                Text(value.map { $0.model ?? settingsModelRoleClearedValue }
                     ?? settingsModelRoleUnknownValue)
                    .font(Typography.controlMono())
                    .foregroundStyle(value?.model == nil ? Theme.textMuted : Theme.textPrimary)
                    .textSelection(.enabled)
            }
            Text(settingsModelRoleExplanation(role))
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if let value, let constraint = settingsRoleConstraintNote(value.constraint) {
                Text(constraint)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if value == nil {
                Text(model.isUnwired ? settingsModelRoleUnwiredNote : settingsModelRoleUnreadableNote)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
}
