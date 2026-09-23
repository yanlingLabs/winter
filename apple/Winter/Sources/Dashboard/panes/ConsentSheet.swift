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
    /// Fix round 4: set when `plugin.setConsent` answers `.staleDisclosure` and this sheet is
    /// rebuilt from the plugin's current `plugin.list` row — rendered INSIDE the sheet itself
    /// (`ConsentSheet`'s body, near the top) rather than the pane's general `errorText`, so it
    /// reads naturally next to the disclosure it's warning about and survives the sheet staying
    /// open for another attempt.
    var notice: String?
    /// Fix round 4: set when `plugin.setConsent` answers `.unknownPlugin` — the plugin this sheet
    /// was raised for is already gone by the time the user next acts on it (confirms, then later
    /// dismisses). `PluginManagerModel.consentSheetDismissed()` reads this to skip a `pluginDisable`
    /// call that would just fail again on the same unknown id, showing a plain "already gone"
    /// message instead of a confusing "installed but couldn't turn it off" one.
    var pluginGone: Bool = false

    init(pluginId: String, spec: String, scope: PluginScope, extras: PluginExtras, openedByInstall: Bool,
         notice: String? = nil, pluginGone: Bool = false) {
        self.pluginId = pluginId
        self.spec = spec
        self.scope = scope
        self.extras = extras
        self.openedByInstall = openedByInstall
        self.notice = notice
        self.pluginGone = pluginGone
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
///
/// Fix round 4: the entry command and every TCC/hardware string are plugin-authored (`winter-
/// plugin.json`), same as a hook's `event`/`matcher`/`type`/`command` — sanitized through the same
/// `librarySanitizedHookField` (`LibraryHooksTab.swift`) before they reach this sheet, which shows
/// them verbatim in a monospaced, `textSelection(.enabled)` block a user is meant to actually read
/// and trust.
func pluginConsentDisclosureLines(pluginId: String, extras: PluginExtras) -> [String] {
    // Fix round 5: `pluginId` is untrusted too — it comes straight from the marketplace file
    // (`marketplace.json`'s own `name`), same trust boundary as the entry command/TCC/hardware
    // strings sanitized below.
    var lines = ["\(librarySanitizedHookField(pluginId)) is asking for the following, on this Mac:"]
    // `execPermission` alone can be absent/false while `requiredConsents` still lists `"exec"`
    // (or an `entry` is declared without the daemon echoing `permissions.exec` back) — check all
    // three so a genuine exec request never renders as a bare, contentless header line.
    if extras.execPermission || extras.requiredConsents.contains("exec") || extras.entry != nil {
        if let entry = extras.entry {
            let command = ([entry.command] + entry.args).joined(separator: " ")
            lines.append("- run its own background process: \(librarySanitizedHookField(command))")
        } else {
            lines.append("- run its own background process")
        }
    }
    for permission in extras.tccPermissions {
        lines.append("- will request macOS permission: \(librarySanitizedHookField(permission))")
    }
    for permission in extras.hardwarePermissions {
        lines.append("- hardware access via Winter.app's helper: \(librarySanitizedHookField(permission))")
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

    /// I2: this consent covers ONLY the background process below — a plugin's skills, hooks and
    /// MCP servers are not gated on it at all (installing+enabling already loads those, spec §5.4).
    /// Round 3 minor: "declining here turns the whole plugin off" is true ONLY when this sheet was
    /// raised by an INSTALL (`state.openedByInstall`) — that's the one case where declining runs a
    /// `pluginDisable` follow-up (`PluginManagerModel.consentSheetDismissed()`). An ordinary
    /// `enable(_:)`-triggered sheet's plugin was never turned on in the first place; saying
    /// "declining turns it off" there would claim an effect this sheet's Cancel button doesn't have.
    private var introText: String {
        var text = "This consent covers only the background process listed below."
        if state.openedByInstall {
            text += " Skills, hooks and MCP servers this plugin declares load when it's enabled, "
                + "whether or not this process runs — declining here turns the whole plugin off."
        } else {
            text += " Skills, hooks and MCP servers this plugin declares load separately, when "
                + "it's enabled."
        }
        return text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Fix round 5: sanitized — `pluginId` is marketplace-authored, same as the disclosure
            // lines below it.
            Text("\(librarySanitizedHookField(state.pluginId)) requests consent")
                .font(Typography.paneTitle)
            // Fix round 4: the stale-disclosure notice lives ON the sheet (`state.notice`), not the
            // pane's general `errorText` — rendered at the top, above the intro copy, so it reads as
            // "here's what changed" before the (possibly now-different) disclosure below it.
            if let notice = state.notice {
                Text(notice)
                    .font(Typography.label())
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(introText)
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
        // N1 (round 3): while `busy` (a `pluginSetConsent`/`pluginEnable` call is in flight for
        // THIS sheet), interactive dismissal (Esc, a swipe-down, the sheet's own close chrome) is
        // disabled outright — the Cancel/Grant buttons are already `.disabled(busy)` above, so this
        // closes the one remaining way the sheet could disappear mid-RPC. Without it, an Esc
        // landing while `confirmConsent()`'s network calls are still in flight could race its own
        // eventual `pluginEnable` against `consentSheetDismissed()`'s `pluginDisable` follow-up —
        // this makes that race physically unreachable rather than merely rare.
        .interactiveDismissDisabled(busy)
    }
}
