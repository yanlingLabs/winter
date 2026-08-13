import NormaKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// ConsentSheetState — Task 3 (4d-iii): a PURE state machine backing the plugin install/enable
// consent sheet. No `NormaClient`, no SwiftUI — table-tested directly in `ConsentSheetStateTests`,
// same "pure model, table-tested next to its View" posture as `pluginRowDisplay` in
// `PluginManagerView.swift`.
// -----------------------------------------------------------------------------------------------

/// Built from EITHER of the two triggers the brief calls out: `plugin.enable`'s
/// `.needsConsent(...)` outcome (an existing installed-but-unconsented plugin whose Enable button
/// just came back needing consent) or a fresh `plugins.install`'s `.ok(...)` outcome (a plugin the
/// user just picked via the folder/zip panel). Both wire results carry the SAME
/// `requiredConsents`/`consentBlock` shape server-side (`buildConsentBlock`,
/// `packages/core/src/plugins/lifecycle.ts`), so one state type covers both.
///
/// `consentBlock` is carried byte-for-byte from the wire result into `ConsentSheet`'s monospaced
/// body — the design-spec §1 "exec payload, never a summary" discipline the CLI's own
/// `buildConsentBlock` + `type "yes" to consent:` prompt already enforce (`packages/cli/src/
/// main.ts`'s `plugin enable`). This type must never reformat/truncate/reorder those lines.
///
/// `decision` is a pure record of user intent, NOT a completed action — `PluginManagerModel` is
/// the one that actually calls `pluginEnable(name:consent:true)` on `.confirmed`
/// (`PluginManagerModel.confirmConsent()`); this type has no `NormaClient` of its own to call it
/// with.
struct ConsentSheetState: Equatable, Identifiable {
    enum Decision: Equatable {
        case pending
        case confirmed
        case cancelled
    }

    var id: String { pluginName }
    let pluginName: String
    let consentBlock: [String]
    let requiredConsents: [String]
    private(set) var decision: Decision = .pending

    init(pluginName: String, consentBlock: [String], requiredConsents: [String]) {
        self.pluginName = pluginName
        self.consentBlock = consentBlock
        self.requiredConsents = requiredConsents
    }

    /// From `plugin.enable`'s `.needsConsent(requiredConsents, consentBlock)` outcome — `nil` for
    /// every other case (`.ok`/`.unknownPlugin` have nothing to show a consent sheet for).
    init?(pluginName: String, needsConsent outcome: PluginEnableOutcome) {
        guard case .needsConsent(let requiredConsents, let consentBlock) = outcome else { return nil }
        self.init(pluginName: pluginName, consentBlock: consentBlock, requiredConsents: requiredConsents)
    }

    /// From a fresh `plugins.install`'s `.ok(...)` outcome — `nil` for `.invalidSource`/
    /// `.alreadyInstalled` (those surface via `PluginManagerModel.errorText` instead, never a
    /// sheet).
    init?(installOutcome outcome: PluginsInstallOutcome) {
        guard case .ok(let name, let requiredConsents, _, let consentBlock) = outcome else { return nil }
        self.init(pluginName: name, consentBlock: consentBlock, requiredConsents: requiredConsents)
    }

    /// User clicked "Grant consent & enable" — records the decision; `PluginManagerModel` reads
    /// this transition as its cue to call `pluginEnable(name:consent:true)`.
    mutating func confirm() { decision = .confirmed }

    /// User clicked "Cancel" — records the decision; the plugin stays exactly as it was (no
    /// `pluginEnable` call at all).
    mutating func cancel() { decision = .cancelled }
}

// -----------------------------------------------------------------------------------------------
// ConsentSheet — the SwiftUI presentation. Mirrors the CLI's typed-"yes" gravity
// (`packages/cli/src/main.ts`'s `plugin enable`: full disclosure block, then an explicit
// confirming action) with a GUI-native equivalent: the exec-payload lines rendered VERBATIM in a
// monospaced, scrollable block, plus an explicitly-labeled confirm button rather than a generic
// "OK". Same adaptive-color/opaque-window idiom as the rest of this pane (`.primary`/`.secondary`/
// `.quaternary` only — no `.ultraThinMaterial`/glass blend; this window is opaque).
// -----------------------------------------------------------------------------------------------

struct ConsentSheet: View {
    let state: ConsentSheetState
    /// Fix wave (Task 2 review, consent double-submit guard): true while `confirmConsent()` is
    /// in flight (`model.busyName == state.pluginName`, threaded in by `PluginManagerView`) —
    /// disables BOTH buttons (Cancel too, so the sheet can't be torn down mid-RPC) and shows a
    /// small progress indicator on the grant button, so a second click can't fire a second RPC.
    let busy: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(state.pluginName) requests consent")
                .font(Typography.paneTitle)
            Text("Granting consent lets this plugin run the following, verbatim, on this Mac. Review it before continuing.")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(state.consentBlock.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(Typography.labelMono())
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
            .frame(minHeight: 90, maxHeight: 240)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.quaternary))

            HStack {
                Spacer()
                Button("Cancel") { onCancel() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy)
                // Deliberately NO `.keyboardShortcut(.defaultAction)` here — mirrors the CLI's
                // typed-"yes" gravity (`packages/cli/src/main.ts`'s `plugin enable`: a bare Enter
                // at the prompt does NOT consent, only literally typing "yes" does). Granting
                // exec/tcc/hardware access must be a deliberate click, never a reflexive Enter.
                Button {
                    onConfirm()
                } label: {
                    HStack(spacing: 6) {
                        if busy {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text("Grant consent & enable")
                    }
                }
                .foregroundStyle(.red)
                .disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
