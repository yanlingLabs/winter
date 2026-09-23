import WinterKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// ConsentSheetState — WS-21 rewrite: a PURE state machine backing the plugin install/enable
// consent sheet, now seeded from a `plugin.list` row's `PluginExtras` rather than a wire outcome's
// `consentBlock` string array (the pre-WS-21 two-step `plugin.enable{consent:true}` flow, and the
// server-computed disclosure text it carried, are both retired — see `PluginManagerModel.enable`/
// `installFromFolder`'s own doc comments for the new consent-then-enable order). No `WinterClient`,
// no SwiftUI — table-tested directly in `ConsentSheetStateTests`, same "pure model, table-tested
// next to its View" posture as `pluginRowDisplay` in `PluginManagerView.swift`.
// -----------------------------------------------------------------------------------------------

/// Built from EITHER of the two triggers the brief calls out: `PluginManagerModel.enable(_:)` when
/// the row's extras still have a pending consent class, or a successful `installFromFolder(_:)`
/// whose freshly-installed row does. `spec`/`scope` are what `confirmConsent()` calls both
/// `pluginSetConsent` and `pluginEnable` with (fix round 1: `pluginSetConsent`'s param is `spec`
/// now too, not the bare id).
///
/// `extras` is carried verbatim from the daemon's `plugin.list` row (`winter-plugin.json`'s own
/// declared permissions, not a client-fabricated summary) — `ConsentSheet`'s body lists each
/// `tccPermissions`/`hardwarePermissions`/`entry` field individually rather than folding them into
/// prose, the same "never just a summary" discipline the old server-computed `consentBlock` text
/// enforced.
///
/// `decision` is a pure record of user intent, NOT a completed action — `PluginManagerModel` is
/// the one that actually calls `pluginSetConsent`/`pluginEnable` on `.confirmed`
/// (`PluginManagerModel.confirmConsent()`); this type has no `WinterClient` of its own to call it
/// with.
struct ConsentSheetState: Equatable, Identifiable {
    enum Decision: Equatable {
        case pending
        case confirmed
        case cancelled
    }

    var id: String { spec }
    let pluginId: String
    let spec: String
    let scope: PluginScope
    let extras: PluginExtras
    /// Fix round 1 (I2): which trigger raised this sheet — `installFromFolder(_:)` (a fresh install,
    /// already landed ENABLED) or an ordinary `enable(_:)` on an existing, still-disabled row.
    /// `PluginManagerModel.cancelConsent()` reads this to decide whether declining needs a
    /// follow-up `pluginDisable` (an install-triggered sheet's plugin is already loading its
    /// claude-native content; an enable-triggered sheet's plugin never started at all).
    let openedByInstall: Bool
    private(set) var decision: Decision = .pending

    init(pluginId: String, spec: String, scope: PluginScope, extras: PluginExtras, openedByInstall: Bool) {
        self.pluginId = pluginId
        self.spec = spec
        self.scope = scope
        self.extras = extras
        self.openedByInstall = openedByInstall
    }

    /// The classes `confirmConsent()` grants — required-but-not-yet-consented, verbatim from the
    /// wire (`PluginExtras.pendingConsents`).
    var pendingConsents: [String] { extras.pendingConsents }

    /// User clicked "Grant consent & enable" — records the decision; `PluginManagerModel` reads
    /// this transition as its cue to call `pluginSetConsent` then `pluginEnable`.
    mutating func confirm() { decision = .confirmed }

    /// User clicked "Cancel" — records the decision; the plugin stays exactly as it was (no
    /// `pluginSetConsent`/`pluginEnable` call at all).
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

/// PURE: the disclosure lines the consent sheet renders — every one of `extras`' declared Winter
/// permissions, individually and verbatim (never folded into prose or summarized), the same
/// "never just a summary" discipline the pre-WS-21 server-computed `consentBlock` text enforced.
/// Sourced straight from the daemon's `plugin.list` row (`winter-plugin.json`'s own declared
/// fields), not fabricated. Table-tested in `ConsentSheetStateTests`.
func pluginConsentDisclosureLines(pluginId: String, extras: PluginExtras) -> [String] {
    var lines = ["\(pluginId) is asking for the following, on this Mac:"]
    // `execPermission` alone can be absent/false while `requiredConsents` still lists `"exec"`
    // (or an `entry` is declared without the daemon echoing `permissions.exec` back) — check all
    // three so a genuine exec request never renders as a bare, contentless header line.
    if extras.execPermission || extras.requiredConsents.contains("exec") || extras.entry != nil {
        if let entry = extras.entry {
            let command = ([entry.command] + entry.args).joined(separator: " ")
            lines.append("- run its own background process: \(command)")
        } else {
            lines.append("- run its own background process")
        }
    }
    for permission in extras.tccPermissions {
        lines.append("- will request macOS permission: \(permission)")
    }
    for permission in extras.hardwarePermissions {
        lines.append("- hardware access via Winter.app's helper: \(permission)")
    }
    return lines
}

struct ConsentSheet: View {
    let state: ConsentSheetState
    /// Fix wave (Task 2 review, consent double-submit guard): true while `confirmConsent()` is
    /// in flight (`model.busySpec == state.spec`, threaded in by `PluginManagerView`) — disables
    /// BOTH buttons (Cancel too, so the sheet can't be torn down mid-RPC) and shows a small
    /// progress indicator on the grant button, so a second click can't fire a second RPC.
    let busy: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    private var disclosureLines: [String] {
        pluginConsentDisclosureLines(pluginId: state.pluginId, extras: state.extras)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(state.pluginId) requests consent")
                .font(Typography.paneTitle)
            // I2: this consent covers ONLY the background process below — a plugin's skills, hooks
            // and MCP servers are not gated on it at all (installing+enabling already loads those,
            // spec §5.4). Declining here (Cancel) turns the whole plugin back off, not just the
            // process, so the two facts belong in the same sentence.
            Text("This consent covers only the background process listed below. Skills, hooks and "
                + "MCP servers this plugin declares load when it's enabled, whether or not this "
                + "process runs — declining here turns the whole plugin off.")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(disclosureLines.enumerated()), id: \.offset) { _, line in
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
