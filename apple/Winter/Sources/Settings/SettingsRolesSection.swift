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
// WRITABLE SINCE 2026-09-18. Each row's model value is a door onto a two-step picker
// (`SettingsRoleModelPicker.swift`): choose a model, then choose which provider serves it, and the
// exact tag the daemon listed is written through `settings.setModelRole`. Rule 2 below is what
// binds it: the picker's contents are `permitted` and nothing else, and it never composes a tag of
// its own — the daemon validates a tag's SHAPE, not that a catalog row backs it, so a stitched
// pair would be stored happily and fail at session start instead.
//
// The reply repaints the whole pane, because clearing or moving one role moves every role that was
// following it. A row the daemon did not report, or did not name models for, stays exactly as
// read-only as it was.
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
//    read carries "explicit or defaulted". The row no longer draws it as a badge (user call,
//    2026-09-18); the picker still honours it, never ticking a model a role merely inherited.
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
    ///
    /// **CORRECTED 2026-09-18 (from the daemon's own session): do NOT build that pairing on
    /// `providerId`.** The list applies the blocked floor and nothing else, so it can name a
    /// provider that has no credential SLOT at all (which would read as "no key" forever), and the
    /// Anthropic Console arm's readiness is a live `ant` profile check with no Keychain slot
    /// behind it.
    ///
    /// **ANSWERED: `models.catalog` carries `credentialPresent` + `credentialDoor` per provider.**
    /// The boolean is the daemon's own readiness answer and the picker reads it straight off the
    /// provider row — no join of any kind; the door only names the fix
    /// (`roleProviderCredentialState`, and `SettingsRoleModelPicker.swift`'s header rule 2). On a
    /// daemon without the field this is all `.unknown`, which renders nothing.
    let permitted: [String]
    /// The same set with the wire's PROVIDER GROUPING intact — what the picker is built on, since
    /// its second step is "who serves this model".
    ///
    /// Defaulted, so every construction site that only cares about the value (previews, the older
    /// tests) keeps compiling and simply yields an unpickable row.
    let permittedProviders: [ModelRolePermittedProvider]
    /// The reasoning effort STORED for this role, or nil (the model's own default). Rendered as the
    /// row's second value and edited in its own card (`SettingsRoleEffortPicker.swift`); nowhere
    /// while `settingsRoleEffortControlEnabled` is false.
    let effort: String?
    let effortExplicit: Bool
    /// The CURRENT model's effort vocabulary, in the wire's order. `nil` = no reasoning block, `[]`
    /// = an empty vocabulary — two different facts (`roleEffortControl`).
    let efforts: [String]?
    /// The role's CURRENT problem as the daemon reported it (`settings.modelRoles`' `problem`), or
    /// nil. Rendered only in the page's "Notes" group (`SettingsRoleNotes.swift`), never on the row.
    let problem: RoleProblem?

    init(model: String?,
         isExplicit: Bool,
         constraint: String,
         permitted: [String],
         permittedProviders: [ModelRolePermittedProvider] = [],
         effort: String? = nil,
         effortExplicit: Bool = false,
         efforts: [String]? = nil,
         problem: RoleProblem? = nil) {
        self.model = model
        self.isExplicit = isExplicit
        self.constraint = constraint
        self.permitted = permitted
        self.permittedProviders = permittedProviders
        self.effort = effort
        self.effortExplicit = effortExplicit
        self.efforts = efforts
        self.problem = problem
    }
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

// 2026-09-18: the "Pinned"/"Default" BADGE is GONE from the rows (user call — they did not want
// it). `settingsRoleValueBadge` and `settingsRoleFollowsSessionDefault` went with it rather than
// being left as dead code with no caller.
//
// **The distinction itself is untouched.** `SettingsRoleValue.isExplicit` still arrives, is still
// the thing `settingsRolePickerSelection` branches on, and still decides that a DERIVED value does
// not tick its own model's row in the picker. What was removed is the chip in the row, not the fact
// it was drawn from.

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
            permitted: value.permitted.flatMap(\.models),
            permittedProviders: value.permitted,
            effort: value.effort,
            effortExplicit: value.effortExplicit,
            efforts: value.efforts,
            problem: value.problem.map(roleProblem)
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
    /// `settings.setModelRole`, which answers with the WHOLE effective map — see `commit`.
    typealias Writer = (_ role: String, _ model: String?) async throws -> [String: ModelRoleValue]
    /// The same door with its third, effort, state (`ModelRoleEffortWrite`: leave / clear / set).
    ///
    /// SEPARATE from `writer` rather than replacing it, so a host with only the two-argument closure
    /// still works. The live app passes THIS one (`SettingsSurface.swift`, `wiring?.setModelRole`).
    /// Where it is nil, (a) no effort door renders (`canWriteEffort`), and (b) a model change falls
    /// back to `writer`, so the `effort: null` rule 5 asks for cannot be sent.
    ///
    /// The MODEL is three-state as well (`ModelRoleModelWrite`), so an effort-only write can send
    /// `.leave` once the daemon makes `model` optional — see `roleEffortOnlyModelWrite`.
    typealias RoleWriter = (_ role: String, _ model: ModelRoleModelWrite, _ effort: ModelRoleEffortWrite)
        async throws -> [String: ModelRoleValue]

    private let loader: Loader?
    private let writer: Writer?
    private let roleWriter: RoleWriter?

    @Published private(set) var values: [SettingsModelRole: SettingsRoleValue] = [:]
    @Published private(set) var loading = false
    /// Latched by `-32601` alone — this daemon predates `settings.modelRoles`. Expected; not shown
    /// as an error.
    @Published private(set) var isUnsupported = false
    @Published private(set) var errorText: String?
    /// A write in flight. The picker's rows go inert on it rather than queueing a second write.
    @Published private(set) var writing = false
    /// A failed write's sentence. Kept apart from `errorText` because it belongs INSIDE the picker
    /// — the card is where the action was taken, and a message behind it is a message unread.
    @Published private(set) var writeErrorText: String?
    /// WHICH role's card is on screen, if any. Told by the shell's modal layer
    /// (`ShellOverlayPresentation.openRolePicker`/`closeRolePicker`), which is the one place that
    /// knows — the card is rendered at shell level now, not by this pane.
    ///
    /// A ROLE, not a flag: close the dispatch card mid-write and open the titles one, and a flag
    /// would say "a card is up" when dispatch's failure lands — putting it in the wrong card.
    @Published private(set) var openPickerRole: SettingsModelRole?

    var pickerIsOpen: Bool { openPickerRole != nil }

    var isUnwired: Bool { loader == nil }
    /// Whether a value on this pane is a door. No writer = the rows stay exactly as read-only as
    /// they were before the picker existed.
    var canWrite: Bool { writer != nil || roleWriter != nil }
    /// Whether an effort can reach the wire at all. False ⇒ no effort control, whatever the flag.
    var canWriteEffort: Bool { roleWriter != nil }

    init(loader: Loader? = nil, writer: Writer? = nil, roleWriter: RoleWriter? = nil) {
        self.loader = loader
        self.writer = writer
        self.roleWriter = roleWriter
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

    /// A card just opened for `role`. Yesterday's failed write is not news about this one.
    func pickerDidOpen(_ role: SettingsModelRole) {
        openPickerRole = role
        writeErrorText = nil
    }

    /// The card just went away — by its close button, its scrim, Esc, or another floating surface
    /// taking its place. A write it started may still be in flight; that is the whole reason this
    /// exists, because from here on the failure has nowhere to land but the pane.
    func pickerDidClose() {
        openPickerRole = nil
        writeErrorText = nil
    }

    /// Write one role and REPAINT FROM THE REPLY.
    ///
    /// `setModelRole` answers with the whole effective map, which is not a convenience — it is the
    /// only correct source: clearing or moving one role moves every role that was following it, so
    /// a pane that patched the single row it wrote would show eight stale ones. For the same reason
    /// this never calls `refresh()` afterwards: a second round trip could only disagree with the
    /// answer we were just handed.
    ///
    /// Returns true when the write landed, which is the picker's cue to close. On failure the last
    /// good map is left exactly as it was — a refused write must not repaint anything — and the
    /// daemon's words go through `shellPanelErrorText`, because a settings write can fail with a
    /// raw schema dump that would otherwise be shown to a person as if it were a sentence.
    ///
    /// `effort` defaults to `.leave`. With only the two-argument `writer` wired, a `.leave`/`.clear`
    /// goes through it with the effort key absent (see `RoleWriter` for why that is today's wire),
    /// and a `.set` is REFUSED here rather than silently dropped — a chosen effort that never
    /// reached the daemon would be the exact lie the gated control exists to avoid.
    ///
    /// A write that would change NOTHING (`model: .leave` and `effort: .leave`) is refused here —
    /// the daemon refuses it too. A `model: .leave` through the two-argument `writer` is refused as
    /// well: that door can only spell a tag or `null`, and turning "leave" into either would be a
    /// write nobody asked for.
    @discardableResult
    func commit(_ role: SettingsModelRole, model: String?,
                effort: ModelRoleEffortWrite = .leave) async -> Bool {
        await commit(role, model: ModelRoleModelWrite(model), effort: effort)
    }

    @discardableResult
    func commit(_ role: SettingsModelRole, model: ModelRoleModelWrite,
                effort: ModelRoleEffortWrite) async -> Bool {
        guard canWrite, !writing else { return false }
        if model == .leave, effort == .leave { return false }
        if roleWriter == nil, case .set = effort { return false }
        if roleWriter == nil, model == .leave { return false }
        writing = true
        defer { writing = false }
        do {
            let reply: [String: ModelRoleValue]
            if let roleWriter {
                reply = try await roleWriter(role.rawValue, model, effort)
            } else if let writer {
                let tag: String?
                switch model {
                case let .set(t): tag = t
                case .clear, .leave: tag = nil
                }
                reply = try await writer(role.rawValue, tag)
            } else {
                return false
            }
            values = settingsModelRoleValues(reply)
            writeErrorText = nil
            // A successful write also proves the read method is there, whatever an earlier answer
            // latched.
            isUnsupported = false
            return true
        } catch {
            // WHERE the sentence goes is decided, not assumed: the card is the right place when it
            // is still up, and the pane is the only place left when it is not. A write that was
            // started and then dismissed must still say that it failed.
            let sentence = shellPanelErrorText("Couldn't set \(settingsModelRoleTitle(role).lowercased())",
                                               detail: "\(error)")
            switch settingsRoleWriteErrorSink(openRole: openPickerRole, writtenRole: role) {
            case .picker: writeErrorText = sentence
            case .pane: errorText = sentence
            }
            return false
        }
    }
}

// -----------------------------------------------------------------------------------------------

/// Settings → Roles. One row per job, each row's value a door onto the two-step model picker.
///
/// Every dependency is optional and every absent one degrades to the honest read-only pane this
/// started as: no `loader` = nothing was ever asked, no `writer` = the values are text, no `picker`
/// = there is nowhere to show the card. That is why `SettingsSurface.swift`'s bare
/// `SettingsRolesSection()` still compiles and still renders something true.
///
/// The picker's contents are the daemon's `permitted` list and nothing else — never an app-side
/// allowlist, which would be stale the moment the agent SDK's catalog grows (an SDK bump ships with
/// no app release).
struct SettingsRolesSection: View {
    @StateObject private var model: SettingsRolesModel
    /// Directly-injected values, used when no loader has produced any. Kept for pure construction
    /// (previews, tests) — the live pane goes through `loader`.
    private let injected: [SettingsModelRole: SettingsRoleValue]
    /// Families, pricing and credential doors, INJECTED DIRECTLY. Nil is the ordinary case and
    /// means "use the store"; a non-nil value overrides it outright, which is what previews and
    /// tests pass. See `SettingsRoleModelPicker.swift`'s header for what `.none` renders.
    private let injectedFacts: ModelCatalogFacts?
    /// Where the live facts come from — `models.catalog` (readiness included), read once
    /// and kept. Defaulted to the shared instance because `SettingsSectionView` (a file this change
    /// did not own) constructs this section with `loader:`/`writer:` only; passing `catalog:` there
    /// is the one edit that turns this into an ordinary injected dependency.
    @ObservedObject private var catalog: ModelCatalogFactsModel
    /// Where the picker is SHOWN (2026-09-18). The pane publishes a request; the shell renders the
    /// card in its own floating-panel layer, which is the only way it can wear the same position,
    /// size, material, rim and scrim as the library/devices/updates panels — see
    /// `SettingsRolePickerRequest`. Nil (a preview, a test, a host that passes none) makes the rows
    /// honestly unpickable rather than clickable-but-inert; `settingsRoleIsPickable` says so.
    private let picker: (any SettingsRolePickerPresenting)?

    init(values: [SettingsModelRole: SettingsRoleValue] = [:],
         loader: SettingsRolesModel.Loader? = nil,
         writer: SettingsRolesModel.Writer? = nil,
         roleWriter: SettingsRolesModel.RoleWriter? = nil,
         facts: ModelCatalogFacts? = nil,
         catalog: ModelCatalogFactsModel = .shared,
         picker: (any SettingsRolePickerPresenting)? = nil) {
        self.injected = values
        self.injectedFacts = facts
        self.catalog = catalog
        self.picker = picker
        _model = StateObject(wrappedValue: SettingsRolesModel(loader: loader, writer: writer,
                                                              roleWriter: roleWriter))
    }

    // The facts themselves are no longer read HERE: the card is rendered by the shell, and
    // `SettingsRolePickerHost` resolves `injectedFacts ?? catalog.facts` where it can also OBSERVE
    // the store. This pane still owns the store (it is what makes the read lazy on the first click)
    // and hands it over in the request.

    /// The loaded map wins once there is one; `injected` is the fallback, so a pane constructed
    /// with literal values behaves exactly as it did before the loader existed.
    private var values: [SettingsModelRole: SettingsRoleValue] {
        model.values.isEmpty ? injected : model.values
    }

    var body: some View {
        // 2026-09-18: rewritten in the settings card vocabulary (`SettingsChrome`). The pane was
        // already the right SHAPE — title, explanation, trailing value — so this is presentation
        // only: not one read, decision or piece of copy changed, and it is STILL read-only by
        // construction (no binding, no button, nothing that can write a role).
        //
        // The page's subtitle is this pane's own intro sentence rather than
        // `settingsSectionSubtitle(.roles)`: the two say the same thing and this is the longer,
        // authored one. The sidebar keeps the short form, which is what a sidebar wants.
        SettingsPage(title: settingsSectionTitle(.roles),
                     subtitle: "Winter runs more than one model. These are the jobs it splits between them.") {
            if let errorText = model.errorText {
                SettingsGroup {
                    SettingsNoteRow(errorText, isError: true)
                }
            }
            ForEach(settingsModelRoleGroups) { group in
                SettingsGroup(group.title) {
                    ForEach(group.roles, id: \.self) { role in
                        roleRow(role)
                    }
                }
            }
            // "Notes" — a role's last failure (rate limit, usage limit, credits, …), said calmly at
            // the very bottom instead of failing silently or raising an error on screen. Absent
            // ENTIRELY when nothing is reported: no empty header, no "all clear". It rides the same
            // read and the same write reply as the values, so it repaints with them.
            let notes = settingsRoleNotes(values, now: Date())
            if !notes.isEmpty {
                SettingsGroup(settingsRoleNotesTitle) {
                    ForEach(notes) { note in
                        SettingsRoleNoteRow(note: note)
                    }
                }
            }
        }
        // Read-only and params-less, so re-asking on every open is free and always current — the
        // same re-seed-on-appear posture every other pane has. A daemon without the method answers
        // once and latches `isUnsupported`; it is not retried into a spin.
        .task { await model.refresh() }
        // NO `.overlay` here any more (2026-09-18). The picker used to ride this pane, and it cost
        // exactly what riding a pane costs: the scrim dimmed the detail area only — the settings
        // sidebar stayed lit — and the card's top inset was measured from the pane, so it sat lower
        // than the library/devices/updates panels and ⌘K, which are all measured from the window.
        // The card was already the shared `ShellPanelCard`; what differed was WHERE it was hung.
        //
        // It is now hung where they are: the pane publishes a `SettingsRolePickerRequest` and the
        // shell renders it (`ShellRootView`). Position, size, material, rim, scrim and the corner
        // close button are therefore the same BY CONSTRUCTION rather than by two places agreeing —
        // and, because all five surfaces now pass through one presentation object, opening any of
        // them closes the rest.
    }

    @ViewBuilder
    private func roleRow(_ role: SettingsModelRole) -> some View {
        let value = values[role]
        SettingsRow(settingsModelRoleTitle(role),
                    description: settingsModelRoleExplanation(role)) {
            if let value, let constraint = settingsRoleConstraintNote(value.constraint) {
                SettingsRowNote(constraint)
            }
            if value == nil {
                SettingsRowNote(model.isUnwired ? settingsModelRoleUnwiredNote
                                                : settingsModelRoleUnreadableNote)
            }
        } control: {
            HStack(spacing: 8) {
                // NO "Pinned"/"Default" badge (user call, 2026-09-18). The `explicit` fact behind it
                // is untouched and still decides the picker's checkmark — only the chip is gone.
                //
                // A DOOR when the daemon named models for this role, this app can write, and there
                // is a shell to present the card in; the same text, inert, otherwise — an
                // unreadable or unwritable row must look exactly as it did before the picker
                // existed rather than offering a click that cannot land.
                if settingsRoleIsPickable(value, canWrite: model.canWrite, canPresent: picker != nil) {
                    // The catalog read is LAZY and happens HERE, the first time a picker is
                    // opened — not on `.task`. Settings is visited far more often than a model is
                    // changed, and `models.catalog` is ~134 KB; paying for it on every visit to
                    // Settings buys a table nobody looked at. `loadIfNeeded` is idempotent and
                    // single-flight, so the click that opens the card can fire it unconditionally.
                    Button {
                        picker?.openRolePicker(
                            SettingsRolePickerRequest(role: role,
                                                      roles: model,
                                                      catalog: catalog,
                                                      injectedFacts: injectedFacts,
                                                      fallbackValues: injected))
                        Task { await catalog.loadIfNeeded() }
                    } label: {
                        SettingsMenuPill(valueString(value), isMuted: value?.model == nil,
                                         width: SettingsChrome.roleModelPillWidth)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Choose the model for \(settingsModelRoleTitle(role))")
                } else {
                    valueText(value)
                        .textSelection(.enabled)
                }
                // The role's REASONING EFFORT — its own value and its own card (2026-09-18), never
                // folded into the model picker. Shown only where `settingsRoleEffortIsPickable`
                // says so: a real vocabulary on the role's EFFECTIVE model — defaulted roles
                // included, whose effort-only write sends `model: null` and so stays unpinned
                // (`roleEffortOnlyModelWrite`) — or a stale leftover that must stay visible and
                // clearable. The advisor's `efforts` is always null, so it never shows.
                if let value,
                   settingsRoleEffortIsPickable(value, canWriteEffort: model.canWriteEffort,
                                                canPresent: picker != nil) {
                    Button {
                        picker?.openRolePicker(
                            SettingsRolePickerRequest(role: role,
                                                      roles: model,
                                                      catalog: catalog,
                                                      injectedFacts: injectedFacts,
                                                      fallbackValues: injected,
                                                      kind: .effort))
                    } label: {
                        let selection = roleEffortSelection(effort: value.effort, efforts: value.efforts)
                        SettingsMenuPill(roleEffortValueLabel(selection),
                                         isMuted: selection == .modelDefault,
                                         width: SettingsChrome.roleEffortPillWidth) {
                            // A stale effort reads "Mismatch" with a warning glyph — never as a choice.
                            if case .stale = selection {
                                Image(systemName: "exclamationmark.triangle")
                                    .font(Typography.caption())
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Choose the reasoning effort for \(settingsModelRoleTitle(role))")
                }
            }
        }
    }

    /// Three different strings for three different facts: the tag, "None" for a role the daemon
    /// reported as cleared, and "—" for a role it did not report at all.
    private func valueString(_ value: SettingsRoleValue?) -> String {
        value.map { $0.model ?? settingsModelRoleClearedValue } ?? settingsModelRoleUnknownValue
    }

    /// The read-only form: the same string, in the row's value ink, with no pill around it — a
    /// rimmed pill that did nothing on click would be a broken menu.
    @ViewBuilder
    private func valueText(_ value: SettingsRoleValue?) -> some View {
        Text(valueString(value))
            .font(Typography.body())
            .lineLimit(1)
            .truncationMode(.middle)
            .foregroundStyle(value?.model == nil ? Theme.textMuted : Theme.textSecondary)
            .padding(.horizontal, SettingsChrome.controlHorizontalPadding)
            .frame(width: SettingsChrome.roleModelPillWidth, alignment: .leading)
    }
}
