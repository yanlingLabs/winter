import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Roles: the reasoning-effort picker (2026-09-18).
//
// The effort control used to live INSIDE the model picker, as a menu above the families. The user
// asked for it to be its own thing: "the effort should have its own picker and not be glued inside
// the model picker. its picker would be the same shape as the model picker panel with efforts on
// the left and a short comment about each effort."
//
// So each Roles row carries a SECOND value — the effort — and clicking it opens THIS card. It is
// the same `ShellPanelCard` as the model picker, presented through the same request
// (`SettingsRolePickerRequest`, `kind: .effort`) into the same single slot on the shell's modal
// layer (`ShellOverlayPresentation.picker`). Two pickers cannot be open at once because there is
// only one place to put one.
//
// Every RULE is unchanged and lives in `SettingsRoleModelPicker.swift`'s "Reasoning effort" section:
// what is offered (`roleEffortOptions`), what counts as stale (`roleEffortSelection`), and when an
// effort door exists at all (`roleEffortControl` — which is also the guard that keeps an effort-only
// write off a DERIVED role, where re-sending its tag would silently pin its model).
// -----------------------------------------------------------------------------------------------

/// Which of the two Roles cards a request opens.
enum SettingsRolePickerKind: Equatable, Sendable {
    /// The two-step model → provider picker.
    case model
    /// The reasoning-effort picker.
    case effort
}

// MARK: - The comments — WINTER'S OWN COPY, NOT CATALOG DATA

/// **Winter's own words, written app-side. NOT catalog data, and NOT sent by the daemon.**
///
/// The catalog's `ReasoningCapabilities` carries only `efforts` and `defaultEffort` — no
/// description of any effort — and the composer only formats a name. These sentences are ours.
///
/// Rules for editing this table:
/// - Keyed by the effort NAME exactly as a vocabulary spells it.
/// - Describe the GENERIC trade-off (speed and cost against depth) and nothing more. Vocabularies
///   are provider-specific and not interchangeable, so never state a token budget or a
///   provider-specific behaviour here.
/// - A name that is NOT in this table gets NO comment (`roleEffortComment` → nil). Never invent a
///   meaning for a vocabulary word we do not recognise.
/// - One line each.
let roleEffortComments: [String: String] = [
    "none": "No extended reasoning. The fastest, cheapest answer this model gives.",
    "minimal": "The least reasoning short of none. Very quick, for simple, well-defined work.",
    "low": "Light reasoning. Quick and inexpensive, at some cost to depth on hard problems.",
    "medium": "A balance of speed and depth. A sensible middle for most work.",
    "high": "More thinking before answering. Slower and costlier, stronger on hard problems.",
    "xhigh": "Beyond high. More depth again, for more time and cost.",
    "max": "As much reasoning as this model allows. The slowest and most expensive setting.",
]

/// PURE: the comment for one effort name, or nil for any name the table does not know.
func roleEffortComment(_ name: String) -> String? {
    roleEffortComments[name]
}

/// The "Model default" row's own line. A UI choice (clear the stored effort), not a vocabulary word,
/// so it is deliberately kept OUT of `roleEffortComments`.
let roleEffortModelDefaultComment = "Stores no effort, so the model's own default applies."

/// PURE: the card's right-hand comment for the highlighted row. `nil` highlight = "Model default";
/// an effort the table does not know → nil (no comment, never an invented one).
func roleEffortDetailComment(_ highlighted: String?) -> String? {
    guard let highlighted else { return roleEffortModelDefaultComment }
    return roleEffortComment(highlighted)
}

// MARK: - Pure decisions for the row and the card

/// PURE: whether a Roles row shows its effort door.
///
/// Built on `roleEffortControl`, so it inherits every existing guard — the flag, an effort-capable
/// writer, and an EFFECTIVE model. A DEFAULTED role qualifies too: its effort-only write sends
/// `model: null` and stays unpinned (`roleEffortOnlyModelWrite`). On top of that:
/// - a real vocabulary (`.menu`) → shown;
/// - no vocabulary but a STALE stored effort (`.noSetting(stale: x)`) → shown as a mismatch, so the
///   leftover can still be seen and cleared rather than vanish;
/// - no vocabulary and nothing stored → not shown. The advisor lands here: its `efforts` is always
///   null, since neither SDK's advisor option carries an effort (parity-blocked, not forgotten).
func settingsRoleEffortIsPickable(_ value: SettingsRoleValue?, canWriteEffort: Bool,
                                  canPresent: Bool,
                                  enabled: Bool = settingsRoleEffortControlEnabled) -> Bool {
    guard canPresent, let value else { return false }
    switch roleEffortControl(enabled: enabled, canWriteEffort: canWriteEffort, value: value) {
    case .hidden, .noSetting(stale: nil): return false
    case .noSetting, .menu: return true
    }
}

/// PURE: what the row's effort value reads. A stale value NEVER reads as a valid choice.
func roleEffortValueLabel(_ selection: RoleEffortSelection) -> String {
    switch selection {
    case .modelDefault: return roleEffortModelDefaultTitle
    case let .valid(effort): return effort
    case .stale: return roleEffortMismatchLabel
    }
}

let roleEffortMismatchLabel = "Mismatch"

/// PURE: which left-column row the card opens on. `nil` is "Model default". A stale value opens on
/// the default row — it is not a row at all, and the card names it as a mismatch instead.
func roleEffortInitialHighlight(_ selection: RoleEffortSelection) -> String? {
    if case let .valid(effort) = selection { return effort }
    return nil
}

/// PURE: the card's title, per role.
func settingsRoleEffortPickerTitle(_ role: SettingsModelRole) -> String {
    "\(roleEffortTitle) for \(settingsModelRoleTitle(role).lowercased())"
}

// MARK: - The card

/// The effort picker: efforts down the left (in the row's own order), the highlighted one's comment
/// and the commit on the right. Same card, same size, same place as the model picker.
///
/// Holds only which row is highlighted. It never reads the daemon and never writes: committing calls
/// `onCommitEffort`, which is the host's single effort write path.
struct SettingsRoleEffortPicker: View {
    let role: SettingsModelRole
    let value: SettingsRoleValue
    var isWriting: Bool = false
    /// A failed write's sentence, already through `shellPanelErrorText`.
    var errorText: String?
    let onCommitEffort: (ModelRoleEffortWrite) -> Void
    let onClose: () -> Void

    /// `nil` = "Model default".
    @State private var highlighted: String?

    init(role: SettingsModelRole,
         value: SettingsRoleValue,
         isWriting: Bool = false,
         errorText: String? = nil,
         onCommitEffort: @escaping (ModelRoleEffortWrite) -> Void,
         onClose: @escaping () -> Void) {
        self.role = role
        self.value = value
        self.isWriting = isWriting
        self.errorText = errorText
        self.onCommitEffort = onCommitEffort
        self.onClose = onClose
        _highlighted = State(initialValue: roleEffortInitialHighlight(
            roleEffortSelection(effort: value.effort, efforts: value.efforts)))
    }

    private var options: [String] { roleEffortOptions(value.efforts) }

    private var selection: RoleEffortSelection {
        roleEffortSelection(effort: value.effort, efforts: value.efforts)
    }

    /// Whether `choice` is what is stored now. A stale value matches nothing.
    private func isCurrent(_ choice: String?) -> Bool {
        switch selection {
        case .modelDefault: return choice == nil
        case let .valid(effort): return choice == effort
        case .stale: return false
        }
    }

    var body: some View {
        ShellPanelCard(accessibilityName: settingsRoleEffortPickerTitle(role), onClose: onClose) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 0) {
                    effortColumn
                    Divider()
                    detail
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    // MARK: Left column

    private var effortColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                ShellPanelColumnTitle(settingsRoleEffortPickerTitle(role))
                columnRow(roleEffortModelDefaultTitle, choice: nil)
                ForEach(options, id: \.self) { option in
                    columnRow(option, choice: option)
                }
                Spacer(minLength: 0)
            }
            .padding(8)
        }
        .frame(width: libraryTabColumnWidth)
    }

    private func columnRow(_ title: String, choice: String?) -> some View {
        Button {
            highlighted = choice
        } label: {
            HStack(spacing: 8) {
                Text(title)
                    .font(Typography.body())
                    .lineLimit(1)
                Spacer(minLength: 0)
                if isCurrent(choice) {
                    Image(systemName: "checkmark")
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: shellSidebarRowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: highlighted == choice))
        .disabled(isWriting)
    }

    // MARK: Right side

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The title line: whose vocabulary this is — efforts are per model.
            ShellPanelPaneHeading(value.model ?? settingsModelRoleClearedValue)
            detailBody
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var detailBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if case let .stale(stale) = selection { staleNote(stale) }
                // Reached only with a leftover stored effort on a model that takes none: the only
                // choice is to clear it, and the card says why.
                if options.isEmpty {
                    Text(roleEffortNoSettingText)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                }
                Text(highlighted ?? roleEffortModelDefaultTitle)
                    .font(highlighted == nil ? Typography.control(.semibold)
                                             : Typography.controlMono())
                    .foregroundStyle(Theme.textPrimary)
                // An effort the table does not know gets NO comment — never an invented one.
                if let comment = roleEffortDetailComment(highlighted) {
                    Text(comment)
                        .font(Typography.body())
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                commitButton
                if let errorText {
                    Text(errorText)
                        .font(Typography.caption())
                        .foregroundStyle(Color.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, shellPanelEdgeInset)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var commitButton: some View {
        if isCurrent(highlighted) {
            Text("Current setting")
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
        } else {
            // The house settings button (`.bordered`) — never `.borderedProminent`, which paints in
            // the user's System Settings accent rather than a colour Winter chose.
            SettingsButton(isWriting ? "Saving…"
                                     : (highlighted == nil ? "Use the model default" : "Use this effort"),
                           isEnabled: !isWriting) {
                onCommitEffort(roleEffortWriteForChoice(highlighted))
            }
        }
    }

    private func staleNote(_ stale: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(Typography.caption())
                .foregroundStyle(Theme.textSecondary)
            Text(roleEffortStaleText(stale))
                .font(Typography.caption())
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
