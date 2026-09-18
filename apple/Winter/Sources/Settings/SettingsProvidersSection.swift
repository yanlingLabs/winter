import SwiftUI

// -----------------------------------------------------------------------------------------------
// LEFT AS IT WAS by the 2026-09-18 settings restyle, deliberately. Every other section moved into
// the card/row vocabulary (`SettingsChrome.swift`): a statement with one trailing control. This one
// is not that shape — it is three EDITORS stacked (the Anthropic auth block with its own sheet, a
// catalog-sized list of live `SecureField` credential rows, and a disclosure-group endpoint form).
// A card row has room for one control; a credential row is a field, a state line and two buttons.
// Carding it would shrink the fields and hide the states, so it keeps the surrounding
// `SettingsSectionView` header and its own layout until it is redesigned on its own terms.
// -----------------------------------------------------------------------------------------------

// -----------------------------------------------------------------------------------------------
// Settings → Providers (2026-09-17). ONE consolidated section (user's call), where the Dashboard's
// `ProviderPane` has three top-level blocks stacked as peers: an OpenAI BYO-key form, the Anthropic
// block, and the catalog-driven credentials list.
//
// WHAT CHANGED, AND WHY
//
// The credentials list is the SPINE here. Its rows are derived from the agent SDK's pinned catalog
// (WS-19 W19-1) — the daemon's inventory grows with an SDK bump and no app release — so it is the
// only block that is true for every provider. The OpenAI form was a fourth thing to read before you
// found the row you wanted, and the two overlap: both end with a key in the Keychain.
//
// So the form is demoted to an ADVANCED per-provider field (`endpointOverrides`), because the one
// thing it can do that `credential.set` cannot is name a custom BASE URL. Three facts that shape
// how honest that field can be, all of them worth knowing before extending this:
//
//  1. **There is no per-provider base-URL RPC.** The daemon reads `settings.providers.<id>.baseUrl`
//     (`providerBaseUrlFor`, hot, per provider) but exposes no method to WRITE it. The only
//     endpoint-writing door on the wire is `provider.configure`, which writes OpenAI's block —
//     hence exactly one entry in the list below. When a general door lands, this list stops being a
//     constant and becomes whatever the daemon reports.
//  2. **It cannot save a URL alone.** `provider.configure` takes baseUrl + apiKey together and
//     `ProviderPaneModel.canSave` gates on a non-empty key, so changing an endpoint means
//     re-supplying the key. The field says so rather than letting a user discover it at the Save.
//  3. **It restarts the daemon.** `onConfigured` (wired in `AppDelegate.makeDashboardWiring`) fires
//     the supervisor restart — unlike `credential.set`, which is hot. Also disclosed in the field.
//
// DROPPED from the pane, deliberately: the "Prefer to sign in with ChatGPT?" copy-the-command
// block. The credentials list already carries the `codex-oauth` row, whose `cli-oauth` door text
// ("Managed by the winter login command in a terminal") says the same thing where the user is
// already looking for it. Nothing lost; one fewer top-level block.
//
// NOT dropped: `ProviderPane` itself, which the Dashboard still renders. This section SHARES its
// view-models (`wiring.providerModel` and the two it owns) rather than minting new ones — they hold
// no socket, re-seed on `.task`, and the two destinations are never on screen at once, so
// `CredentialsSection`'s `.onDisappear { clearTypedState() }` and `AnthropicAuthSection`'s
// `.sheet(item:)` behave exactly as they do in the Dashboard.
// -----------------------------------------------------------------------------------------------

/// A provider whose ENDPOINT this build can change, and the door it goes through.
///
/// A struct rather than a bare id because the honest answer per provider is "and here is what
/// saving costs you": today's one entry restarts the daemon and needs the key re-typed, and a
/// future entry arriving over a settings RPC would not. A list of ids would hide that difference.
struct SettingsEndpointOverride: Identifiable, Hashable, Sendable {
    /// The catalog provider id, as the daemon knows it — the same value `CredentialRow.providerId`
    /// carries, so the two lists can be reconciled by eye (and, later, by code).
    let providerId: String
    let displayName: String
    /// The endpoint shown when the field is empty. Not a stored value: the form is write-only
    /// (`provider.configure` has no read half), which is why nothing here claims to show what the
    /// daemon currently has.
    let placeholderBaseUrl: String
    var id: String { providerId }
}

/// Every provider this build can re-point, today. EXACTLY ONE, and that is a statement about the
/// wire, not about the catalog: `provider.configure` is the only endpoint-writing method the daemon
/// exposes and it writes OpenAI's block (WS-20: the legacy single-provider `provider.baseUrl` is
/// gone; the v2→v3 migration copied it into `providers.openai.baseUrl` once).
///
/// Do NOT grow this by hand when another provider needs an override — that is the moment to ask for
/// the general RPC, because a second hand-written entry would have no method to call.
let settingsEndpointOverrides: [SettingsEndpointOverride] = [
    SettingsEndpointOverride(providerId: "openai",
                             displayName: "OpenAI",
                             placeholderBaseUrl: "https://api.openai.com/v1"),
]

// -----------------------------------------------------------------------------------------------

/// Settings → Providers. Wraps its content in a `ScrollView` on purpose: `CredentialsSection` is a
/// `LazyVStack` over a catalog-sized list (~100 rows, each with live controls) and a `LazyVStack`
/// with no enclosing scroll viewport silently degrades to a plain `VStack` — building every
/// `SecureField` in the catalog on each redraw. `SettingsSectionView` provides no scroll of its own.
struct SettingsProvidersSection: View {
    @ObservedObject var model: ProviderPaneModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                currentStatus
                Divider()
                // ORDER IS LOAD-BEARING: the credentials rows whose door is `provider.login` say
                // "the Anthropic (Claude) controls above" — that block has to actually be above.
                AnthropicAuthSection(model: model.anthropicAuth)
                Divider()
                CredentialsSection(model: model.credentials)
                Divider()
                advanced
                Divider()
                disclosure
            }
            .padding(.top, 18)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .task { await model.refreshStatus() }
    }

    /// What the daemon says it is actually using right now. Same read and same formatter as the
    /// Dashboard pane (`daemon.status` → `providerStatusText`), kept because it answers the first
    /// question anyone opens this page with.
    private var currentStatus: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Current provider")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(Theme.textMuted)
                Spacer()
                Button("Refresh") { Task { await model.refreshStatus() } }
                    .disabled(model.statusLoading)
            }
            if let statusErrorText = model.statusErrorText {
                // `.red` for a failure line, as every sibling surface in this app spells it.
                Text(statusErrorText).font(Typography.label()).foregroundStyle(.red)
            } else {
                Text(providerStatusText(providerId: model.providerId, providerModel: model.providerModel))
                    .font(Typography.controlMono())
                    .textSelection(.enabled)
            }
        }
    }

    /// Collapsed by default: an endpoint override is the rare case, and leaving a key field open on
    /// a page whose main job is a list of key fields invites typing into the wrong one.
    private var advanced: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 14) {
                Text("Point a provider at your own endpoint — a proxy, a gateway, or a compatible service. Leave this alone unless you know you need it.")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(settingsEndpointOverrides) { override in
                    endpointForm(override)
                }
            }
            .padding(.top, 10)
        } label: {
            Text("Advanced — custom endpoints")
                .font(Typography.control(.semibold))
        }
    }

    /// One provider's endpoint form. Bound to `ProviderPaneModel`'s own published fields and driven
    /// by its own `save()`/`canSave` — the MARKUP is re-stated here (ProviderPane's is `private`),
    /// never the logic, so there is still exactly one implementation of what Save does.
    @ViewBuilder
    private func endpointForm(_ override: SettingsEndpointOverride) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(override.displayName)
                .font(Typography.label(.semibold))
            Text("Saving re-sends your key and restarts the daemon, so the endpoint takes effect immediately.")
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                Text("Base URL").font(Typography.caption()).foregroundStyle(Theme.textMuted)
                TextField(override.placeholderBaseUrl, text: $model.baseUrl)
                    .textFieldStyle(.roundedBorder)
                    .font(Typography.labelMono())
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("API key").font(Typography.caption()).foregroundStyle(Theme.textMuted)
                SecureField("sk-…", text: $model.apiKey)
                    .textFieldStyle(.roundedBorder)
                    .font(Typography.labelMono())
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Model (optional)").font(Typography.caption()).foregroundStyle(Theme.textMuted)
                // WS-20: a model is always a provider-qualified tag; the placeholder shows the shape.
                TextField("openai/gpt-5.6-sol", text: $model.model)
                    .textFieldStyle(.roundedBorder)
                    .font(Typography.labelMono())
            }

            if let saveErrorText = model.saveErrorText {
                Text(saveErrorText).font(Typography.label()).foregroundStyle(.red)
            } else if model.savedConfirmation {
                Text("Saved — Winter is switching to your API key.")
                    .font(Typography.label())
                    .foregroundStyle(.green)
            }

            HStack {
                Spacer()
                Button {
                    Task { await model.save() }
                } label: {
                    HStack(spacing: 6) {
                        if model.saving { ProgressView().controlSize(.small) }
                        Text("Save & apply")
                    }
                }
                .disabled(!model.canSave)
            }
        }
    }

    /// The non-affiliation + account-risk disclosure, verbatim from the one constant both this
    /// section and the first-run sheet read — never a second paraphrase of the same risk.
    private var disclosure: some View {
        Text(winterProviderDisclosureText)
            .font(Typography.caption())
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }
}
