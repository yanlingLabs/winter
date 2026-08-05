import AppKit
import NormaKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Pure display helper (BYOK T2) — same "id (model)" / bare-id / "none" formatting as
// `formatDaemonStatus`'s own provider field (`DaemonStatusPane.swift`), kept here as its own tiny
// pure function rather than a shared extraction: this pane only ever needs the provider half of
// `daemon.status`, never the daemon's other fields. Table-tested directly in `DashboardTests.swift`,
// same posture as `memoryTypeBadge`/`skillSourceBadge`.
// -----------------------------------------------------------------------------------------------
func providerStatusText(providerId: String?, providerModel: String?) -> String {
    switch (providerId, providerModel) {
    case let (.some(id), .some(model)):
        return "\(id) (\(model))"
    case let (.some(id), nil):
        return id
    default:
        return "none configured"
    }
}

/// The non-affiliation + account-risk disclosure (spec §2/§3) — mirrors the README's own
/// "Bringing your own AI" wording verbatim in spirit (plain language, not legalese). Shared by both
/// `ProviderPane` (this file) and the first-run disclosure sheet (`FirstRunDisclosure.swift`) so
/// the two surfaces never drift into saying subtly different things about the same risk.
let normaProviderDisclosureText = """
Norma is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI. \
Signing in with a ChatGPT account uses that account under OpenAI's own terms, which don't \
specifically bless third-party apps — so, as with any tool that isn't OpenAI's own, there's some \
risk to that account, and it's yours to weigh. If you'd rather not, the API-key option below is \
the straightforward, officially-supported path. Either way, your credentials live only in this \
Mac's Keychain — Norma keeps no copy.
"""

// -----------------------------------------------------------------------------------------------
// ProviderPaneModel — the pane's live view-model (`@MainActor`/`ObservableObject`), modeled
// directly on `MemoryPaneModel` (freshest reviewed precedent): owns the current-provider status
// read + the BYO-key form's save flow, constructed around the raw `NormaClient` — never closures
// for the RPCs themselves (mirrors `MemoryPaneModel`/`SkillsPaneModel`). App shell T7: built once,
// for the process lifetime, by `AppDelegate.makeDashboardWiring` (alongside `ShellSessionHost`,
// `summonAppWindow`'s construction) — replacing `DashboardWindowController.init`'s old "fresh per
// dashboard window-open" role; harmless, since this model already re-seeds itself on `.task`.
//
// `onConfigured` is the ONE closure this model takes beyond `client` (same "extra closure baked in
// at construction" posture as `ShortcutBindingEditorModel`'s `shortcutRegistry`) — fired after a
// successful `configureProvider(...)` so `AppDelegate` can restart the daemon supervisor
// (T1's report: "a provider-TYPE change needs a fresh daemon... T2's Dashboard pane must call
// `daemonSupervisor?.restart()` itself"). This view-model has no idea what "restart the daemon"
// means — it just fires the closure it was handed, same "pure seam, no AppDelegate reference"
// discipline as every other pane in this directory.
// -----------------------------------------------------------------------------------------------

@MainActor
final class ProviderPaneModel: ObservableObject {
    private let client: NormaClient
    private let onConfigured: () -> Void

    @Published private(set) var providerId: String?
    @Published private(set) var providerModel: String?
    @Published private(set) var statusLoading = false
    @Published var statusErrorText: String?

    /// The BYO-key form's editable fields — `baseUrl` defaults to OpenAI's own endpoint (spec §2),
    /// never seeded from the daemon's current settings (v1 is a one-way "set this up" form, not an
    /// editor of the live provider block).
    @Published var baseUrl: String = "https://api.openai.com/v1"
    @Published var apiKey: String = ""
    @Published var model: String = ""

    @Published private(set) var saving = false
    @Published var saveErrorText: String?
    /// True right after a successful save — the pane's confirmation row
    /// ("Saved — Norma is switching to your API key"). Reset at the START of the next save attempt
    /// so a second save doesn't show a stale confirmation while the new one is still in flight.
    @Published private(set) var savedConfirmation = false

    init(client: NormaClient, onConfigured: @escaping () -> Void = {}) {
        self.client = client
        self.onConfigured = onConfigured
    }

    /// Save is blocked on an empty (or whitespace-only) base URL or API key — `provider.configure`'s
    /// own wire schema rejects both (`z.string().url()`/`z.min(1)`, methods.ts) as `INVALID_PARAMS`,
    /// so gating client-side avoids a round-trip that could only ever fail. Trimmed check (same
    /// "whitespace-only is as unwritable as empty" posture as `MemoryPaneModel.canSave`); the SENT
    /// values stay untrimmed for baseUrl/model (trimmed at send time in `save()` below), never for
    /// apiKey (a key's own characters are never trimmed — leading/trailing whitespace could be
    /// meaningful, however unlikely).
    var canSave: Bool {
        !saving
            && !apiKey.isEmpty
            && !baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Loads the current provider id/model from `daemon.status` — called on the pane's `.task`
    /// (initial appear), same "static fetch + refresh button, no polling loop" posture as
    /// `DaemonStatusPane`.
    func refreshStatus() async {
        statusLoading = true
        defer { statusLoading = false }
        do {
            let status = try await client.daemonStatus()
            providerId = status.providerId
            providerModel = status.providerModel
            statusErrorText = nil
        } catch {
            statusErrorText = "couldn't load provider status — try Refresh"
        }
    }

    /// `provider.configure` with the form's current fields — `model` is sent only when non-empty
    /// (omitted entirely otherwise, matching `NormaClient.configureProvider`'s own "omit, never
    /// null" convention so the server falls back to its own default). On success: clears any prior
    /// error, shows the confirmation, fires `onConfigured` (the daemon-restart hook), and refreshes
    /// the status row so it reflects the just-applied change. On failure: the confirmation never
    /// shows, `onConfigured` is never fired, and the thrown error surfaces as `saveErrorText` —
    /// never a crash, same discipline as every other pane's RPC call in this directory.
    func save() async {
        guard canSave else { return }
        saving = true
        savedConfirmation = false
        defer { saving = false }
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await client.configureProvider(
                baseUrl: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                apiKey: apiKey,
                model: trimmedModel.isEmpty ? nil : trimmedModel
            )
            saveErrorText = nil
            savedConfirmation = true
            onConfigured()
            await refreshStatus()
        } catch {
            saveErrorText = "couldn't save your API key — check the base URL and key, then try again"
        }
    }
}

// -----------------------------------------------------------------------------------------------
// ProviderPane — the Dashboard's "AI Provider" pane (BYOK T2, spec §2). Modeled on
// `DaemonStatusPane`'s status-row idiom for the current-provider read, with a form section below
// (this pane's own addition — no existing pane has a save-a-secret form).
// -----------------------------------------------------------------------------------------------

struct ProviderPane: View {
    @ObservedObject var model: ProviderPaneModel
    @State private var didCopyLoginCommand = false

    private let loginCommand = "norma login"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                currentStatus
                Divider()
                byoKeyForm
                Divider()
                chatGptSignIn
                Divider()
                disclosure
            }
            .padding()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task { await model.refreshStatus() }
    }

    private var header: some View {
        HStack {
            Text("AI Provider").font(.headline)
            Spacer()
            Button("Refresh") { Task { await model.refreshStatus() } }
                .disabled(model.statusLoading)
        }
    }

    private var currentStatus: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Current provider").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            if let statusErrorText = model.statusErrorText {
                Text(statusErrorText).foregroundStyle(.red).font(.system(size: 12))
            } else {
                Text(providerStatusText(providerId: model.providerId, providerModel: model.providerModel))
                    .font(.system(size: 13, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
    }

    private var byoKeyForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Use your own OpenAI API key").font(.system(size: 13, weight: .semibold))
            Text("Norma will talk to OpenAI directly with this key. Applying it restarts the daemon so it takes effect immediately.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                Text("Base URL").font(.system(size: 11)).foregroundStyle(.secondary)
                TextField("https://api.openai.com/v1", text: $model.baseUrl)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("API key").font(.system(size: 11)).foregroundStyle(.secondary)
                SecureField("sk-…", text: $model.apiKey)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Model (optional)").font(.system(size: 11)).foregroundStyle(.secondary)
                TextField("gpt-4o", text: $model.model)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }

            if let saveErrorText = model.saveErrorText {
                Text(saveErrorText).foregroundStyle(.red).font(.system(size: 12))
            } else if model.savedConfirmation {
                Text("Saved — Norma is switching to your API key.")
                    .foregroundStyle(.green)
                    .font(.system(size: 12))
            }

            HStack {
                Spacer()
                Button {
                    Task { await model.save() }
                } label: {
                    HStack(spacing: 6) {
                        if model.saving {
                            ProgressView().controlSize(.small)
                        }
                        Text("Save & apply")
                    }
                }
                .disabled(!model.canSave)
            }
        }
    }

    private var chatGptSignIn: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Prefer to sign in with ChatGPT?").font(.system(size: 13, weight: .semibold))
            Text("Run this in a terminal:")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Text(loginCommand)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(.quaternary))
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(loginCommand, forType: .string)
                    didCopyLoginCommand = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { didCopyLoginCommand = false }
                } label: {
                    Image(systemName: didCopyLoginCommand ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.plain)
                .help("Copy")
            }
        }
    }

    private var disclosure: some View {
        Text(normaProviderDisclosureText)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
