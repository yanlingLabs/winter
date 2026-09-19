import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Providers (2026-09-17; re-set in the card vocabulary 2026-09-18). ONE consolidated
// section (user's call), where the Dashboard's `ProviderPane` has three top-level blocks stacked as
// peers: an OpenAI BYO-key form, the Anthropic block, and the catalog-driven credentials list.
//
// 2026-09-18, the card restyle (user call: "make the settings tabs, all, look like ChatGPT's"):
// this page was the one left un-carded, because a credential row was a field, a state line and two
// buttons — more than a row's one trailing control. The answer is that the FIELD is not always
// there: a key row is a sentence ("Stored" / "Not set") with one soft button, and the SecureField
// only appears, under the row, for the one provider you chose to add or replace a key for. That
// also retires the page's old cost — a live SecureField per catalog row (~100) on every redraw.
// Every model, every read, every write and every failure string is still the shared Dashboard
// view-models' — this file is markup only.
//
// WHAT CHANGED, AND WHY (2026-09-17)
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
// already looking for it.
//
// NOT dropped: `ProviderPane` itself, which the Dashboard still renders. This section SHARES its
// view-models (`wiring.providerModel` and the two it owns) rather than minting new ones — they hold
// no socket, re-seed on `.task`, and the two destinations are never on screen at once.
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

/// PURE: the credential rows matching a search — on the facing name or the provider id,
/// case-insensitively. Blank matches everything, so the unfiltered list is the same code path.
func settingsProvidersMatching(_ query: String, in rows: [CredentialRow]) -> [CredentialRow] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return rows }
    return rows.filter {
        $0.displayName.localizedCaseInsensitiveContains(trimmed)
            || $0.providerId.localizedCaseInsensitiveContains(trimmed)
    }
}

/// PURE: the line under a credential row. A key row says whether it is stored; a bespoke-OAuth row
/// names its door. A row the daemon lists as NOT manageable yet whose door is `credential.set` is a
/// RETIRED tool key (2026-09-18: the Brave `web-search` key, listed only while something is stored,
/// and only to be removed) — "Enter a key here" would be exactly wrong for it.
func settingsCredentialRowDescription(_ row: CredentialRow) -> String? {
    if row.manageable { return row.present ? "Stored" : nil }
    if row.door == "credential.set" { return "Retired: nothing uses this key any more. Remove it." }
    return credentialDoorText(row.door)
}

/// Settings → Providers.
struct SettingsProvidersSection: View {
    @ObservedObject var model: ProviderPaneModel

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.providers)) {
            SettingsButton("Refresh", isEnabled: !model.statusLoading) {
                Task {
                    await model.refreshStatus()
                    await model.anthropicAuth.refreshStatus()
                    await model.credentials.refresh()
                }
            }
        } content: {
            SettingsGroup {
                currentRow
            }
            // ORDER IS LOAD-BEARING: the credential rows whose door is `provider.login` say "the
            // Anthropic (Claude) controls above" — that group has to actually be above.
            SettingsProvidersAnthropicGroup(model: model.anthropicAuth)
            SettingsProvidersKeyGroups(model: model.credentials)
            SettingsGroup("Custom endpoint") {
                ForEach(settingsEndpointOverrides) { override in
                    endpointForm(override)
                }
            }
            // The non-affiliation + account-risk disclosure, verbatim from the one constant both
            // this page and the first-run sheet read — never a second paraphrase of the same risk.
            Text(winterProviderDisclosureText)
                .font(Typography.control())
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task { await model.refreshStatus() }
    }

    /// What the daemon says it is actually using right now. Same read and same formatter as the
    /// Dashboard pane (`daemon.status` → `providerStatusText`).
    @ViewBuilder
    private var currentRow: some View {
        if let statusErrorText = model.statusErrorText {
            SettingsNoteRow(statusErrorText, isError: true)
        } else {
            SettingsValueRow(title: "Current provider",
                             description: "What the daemon is using right now.",
                             value: providerStatusText(providerId: model.providerId,
                                                       providerModel: model.providerModel))
        }
    }

    /// One provider's endpoint form. Bound to `ProviderPaneModel`'s own published fields and driven
    /// by its own `save()`/`canSave` — the MARKUP is re-stated here (ProviderPane's is `private`),
    /// never the logic, so there is still exactly one implementation of what Save does.
    @ViewBuilder
    private func endpointForm(_ override: SettingsEndpointOverride) -> some View {
        SettingsRow(override.displayName,
                    description: "Point \(override.displayName) at your own endpoint — a proxy, a gateway, or a compatible service. Saving re-sends your key and restarts the daemon, so the endpoint takes effect immediately.") {
            EmptyView()
        }
        VStack(alignment: .leading, spacing: 12) {
            endpointField("Base URL") {
                TextField(override.placeholderBaseUrl, text: $model.baseUrl)
            }
            endpointField("API key") {
                SecureField("sk-…", text: $model.apiKey)
            }
            // WS-20: a model is always a provider-qualified tag; the placeholder shows the shape.
            endpointField("Model (optional)") {
                TextField("openai/gpt-5.6-sol", text: $model.model)
            }
            HStack(spacing: 10) {
                if let saveErrorText = model.saveErrorText {
                    Text(saveErrorText).font(Typography.control()).foregroundStyle(.red)
                } else if model.savedConfirmation {
                    Text("Saved — Winter is switching to your API key.")
                        .font(Typography.control())
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                if model.saving { ProgressView().controlSize(.small) }
                SettingsButton("Save & apply", isEnabled: model.canSave) {
                    Task { await model.save() }
                }
            }
        }
        .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
        .padding(.vertical, SettingsChrome.rowVerticalPadding)
    }

    private func endpointField<Field: View>(_ label: String, @ViewBuilder field: () -> Field) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(Typography.control())
                .foregroundStyle(Theme.textMuted)
                .frame(width: 120, alignment: .leading)
            field()
                .textFieldStyle(SettingsTextFieldStyle())
                .font(Typography.control())
        }
    }
}

// MARK: - Anthropic (Claude)

/// The Anthropic block as one card. Its own view so it can OBSERVE `AnthropicAuthSectionModel` —
/// a nested `ObservableObject` does not republish through the `ProviderPaneModel` that owns it.
private struct SettingsProvidersAnthropicGroup: View {
    @ObservedObject var model: AnthropicAuthSectionModel

    var body: some View {
        SettingsGroup("Anthropic (Claude)") {
            SettingsRow("Anthropic Console",
                        description: "The arm is the model: anthropic/… uses the API key, console/… uses the Console profile.") {
                if let statusErrorText = model.statusErrorText {
                    Text(statusErrorText).font(Typography.control()).foregroundStyle(.red)
                } else {
                    SettingsRowNote(model.statusText)
                }
                if let selectErrorText = model.selectErrorText {
                    Text(selectErrorText).font(Typography.control()).foregroundStyle(.red)
                }
            } control: {
                if model.hasConsoleProfile {
                    SettingsButton("Sign out", isEnabled: !model.selecting) {
                        Task { await model.signOut() }
                    }
                } else {
                    SettingsButton("Sign in", isEnabled: !model.selecting) { model.startLogin() }
                }
            }
        }
        .task { await model.refreshStatus() }
        .sheet(item: $model.loginSheet) { sheet in
            AnthropicLoginSheet(model: sheet, onDone: {
                model.loginSheet = nil
                Task { await model.refreshStatus() }
            })
        }
    }
}

// MARK: - API keys

/// The catalog-driven credential rows, split into what is connected and what is not — the list is
/// ~100 providers long and the few you actually use should not be buried alphabetically among them.
///
/// Each row is a sentence with ONE soft button (Add key / Replace / Remove). The SecureField is
/// shown only under the row being edited, so there is exactly one live secret field on the page.
private struct SettingsProvidersKeyGroups: View {
    @ObservedObject var model: CredentialsSectionModel
    /// The one row whose key field is open, or nil. Local: which row you are typing into is a
    /// gesture, not state the model needs to know about.
    @State private var editing: String?
    /// The "Add a provider" filter. Local and never persisted, like the settings sidebar's own.
    @State private var query = ""

    var body: some View {
        let connected = model.rows.filter(\.present)
        let available = model.rows.filter { !$0.present }
        // A VStack, NOT a `Group` (2026-09-19 fix): modifiers on a `Group` are applied to EACH of
        // its children, so the removal dialog below was attached once per card — several
        // presenters for one `pendingRemoval`, and none of them showed, which read as a Remove
        // button that did nothing. The page's own spacing is reproduced so the layout is unchanged.
        VStack(alignment: .leading, spacing: SettingsChrome.groupGap) {
            if let loadErrorText = model.loadErrorText {
                SettingsGroup {
                    SettingsNoteRow(loadErrorText, isError: true)
                }
            }
            SettingsGroup("Connected") {
                if connected.isEmpty {
                    SettingsNoteRow(model.loading && model.rows.isEmpty ? "Loading…"
                                                                        : "No keys or sign-ins stored yet.")
                }
                ForEach(connected) { row in
                    credentialRow(row)
                }
            }
            if !available.isEmpty {
                let matches = settingsProvidersMatching(query, in: available)
                SettingsGroup("Add a provider") {
                    // The search is the card's FIRST ROW (user call, 2026-09-19), not a bar above
                    // it: it filters this list and nothing else, so it lives inside it.
                    SettingsInlineSearchRow(query: $query, placeholder: "Search \(available.count) providers")
                    SettingsNoteRow("Keys live only in this Mac's Keychain. Adding or removing one takes effect immediately — no restart.")
                    if matches.isEmpty {
                        SettingsNoteRow("No provider matches “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”.")
                    }
                    ForEach(matches) { row in
                        credentialRow(row)
                    }
                }
            }
        }
        .task { await model.refresh() }
        .onDisappear {
            editing = nil
            model.clearTypedState()
        }
        // ONE dialog for the whole list, driven by `pendingRemoval` — a presentation modifier per
        // row (~100 of them) is not something to rely on.
        .confirmationDialog(
            model.pendingRemoval.map(credentialRemovalTitle) ?? "",
            isPresented: Binding(
                get: { model.pendingRemoval != nil },
                set: { presented in if !presented { model.cancelRemoval() } }
            ),
            presenting: model.pendingRemoval
        ) { _ in
            Button("Remove", role: .destructive) { Task { await model.confirmRemoval() } }
            Button("Cancel", role: .cancel) { model.cancelRemoval() }
        } message: { row in
            Text(credentialRemovalMessage(row))
        }
    }

    @ViewBuilder
    private func credentialRow(_ row: CredentialRow) -> some View {
        let isEditing = editing == row.providerId
        SettingsRow(row.displayName,
                    // A bespoke-OAuth row (Anthropic Console, Codex) never gets a field —
                    // `credential.set` would refuse it typed — so its door says where it is made.
                    description: settingsCredentialRowDescription(row)) {
            if isEditing {
                HStack(spacing: 8) {
                    SecureField("API key", text: Binding(
                        get: { model.draft(for: row.providerId) },
                        set: { model.setDraft($0, for: row.providerId) }
                    ))
                    .textFieldStyle(SettingsTextFieldStyle())
                    .font(Typography.control())
                    .onSubmit { save(row) }
                    SettingsButton("Save", isEnabled: model.canSave(row.providerId)) { save(row) }
                    SettingsButton("Cancel") {
                        model.setDraft("", for: row.providerId)
                        editing = nil
                    }
                }
                .padding(.top, 6)
            }
            // Under the row it belongs to — on a catalog-sized list a refusal shown elsewhere is
            // indistinguishable from a Save that did nothing.
            if let rowErrorText = model.rowError(for: row.providerId) {
                Text(rowErrorText)
                    .font(Typography.control())
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } control: {
            // SET and REMOVE are two independent gates (WS-19 §9 A-3): a `codex-oauth` row can't be
            // typed into but CAN be removed.
            HStack(spacing: 8) {
                if row.manageable && !isEditing {
                    SettingsButton(row.present ? "Replace" : "Add key",
                                   isEnabled: model.busyProviderId == nil) {
                        if let previous = editing { model.setDraft("", for: previous) }
                        editing = row.providerId
                    }
                }
                if credentialRowOffersRemove(row) {
                    // Opens the confirmation only — the delete itself is `confirmRemoval()`.
                    SettingsButton("Remove", isDestructive: true,
                                   isEnabled: model.busyProviderId == nil) {
                        model.requestRemoval(row)
                    }
                }
            }
        }
    }

    private func save(_ row: CredentialRow) {
        guard model.canSave(row.providerId) else { return }
        Task {
            await model.save(providerId: row.providerId)
            // Close the field only when the write landed — a refused key stays typed for fixing.
            if model.rowError(for: row.providerId) == nil { editing = nil }
        }
    }
}
