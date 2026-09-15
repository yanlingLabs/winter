import WinterKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// CredentialsSection — Winter Phase 10b amendment (c), WS-19 W19-12: the Provider pane's
// per-provider credential list, driven by `credential.list`/`credential.set`/`credential.remove`
// (`WinterKit`'s `CredentialsClient`).
//
// DELIBERATELY UNSTYLED (W19-12's own wording: "unstyled: a plain list"; R-10b-12: "no UI styling
// now"). Plain `Text`/`SecureField`/`Button` at their default metrics — no `Typography`, no
// `Theme`, no custom-drawn controls, unlike `AnthropicAuthSection` beside it. That is not an
// oversight to "fix" in a later pass without a ruling: the section exists so every API-key provider
// is REACHABLE from the Mac (the daemon's inventory went from a four-row literal to the SDK's whole
// catalog), and shipping it unstyled is what let that happen in this phase. A styling pass is its
// own piece of work with its own brand review (docs/brand.md).
//
// Modeled on `AnthropicAuthSectionModel` in this directory: `ObservableObject` (the pane's style,
// not `@Observable`), built around a PROTOCOL (`CredentialsClient`) rather than the concrete
// `WinterClient`, so it is unit-testable against `FakeCredentialsClient` with no socket/transport
// involved. It never fetches in `init` — only `.task`/`refresh()` does, same as that model.
//
// The rows are NOT a constant this file may enumerate: the daemon derives the inventory from the
// agent SDK's catalog (W19-1), so it grows with an SDK bump and no app release. Everything here
// renders what the daemon sent — including a `door` value this build has never heard of, which
// falls through to a neutral sentence rather than an empty row.
//
// SECRET DISCIPLINE (WS-19 §2/W19-4, and the property W19-14's sweep asserts globally). A typed
// key lives in exactly one place — `drafts[providerId]`, the `SecureField`'s own backing — and
// leaves it two ways: into `client.set(...)`, or discarded. It is never written to `UserDefaults`,
// never logged, and never reaches an error string: every message this model publishes is a
// COMPILE-TIME CONSTANT chosen by a typed `error.data.code`, never `RpcError.message` and never
// `localizedDescription`. That is why `refusalText` switches on `credentialCode` instead of
// rendering daemon prose — a `credential_value_invalid` refusal is precisely the case where a
// naively-built "invalid key: \(key)" message would leak the value to the screen.
// -----------------------------------------------------------------------------------------------

/// Pure display helper (same posture as `anthropicAuthStatusText` / `providerStatusText`): the
/// sentence that tells the user WHERE a credential they cannot type here is managed.
///
/// Takes an OPTIONAL raw string rather than an enum because the door vocabulary is open on both
/// sides: `CredentialRow.door` carries three values, while a `credential_kind_unsupported`
/// refusal's `data.door` can carry `"provider.logout"` (W19-5's console-arm REMOVE refusal), which
/// is not one of them. An unknown door yields a neutral sentence — never an empty string, which
/// would render as a row that silently says nothing.
func credentialDoorText(_ door: String?) -> String {
    switch door {
    case "credential.set":
        return "Enter a key here."
    case "provider.login":
        return "Managed by the Anthropic (Claude) controls above — use Console login there."
    case "provider.logout":
        return "Sign out with the Anthropic (Claude) controls above."
    case "cli-oauth":
        return "Managed by `winter login` in a terminal."
    default:
        return "Managed outside this window."
    }
}

@MainActor
final class CredentialsSectionModel: ObservableObject {
    private let client: CredentialsClient

    @Published private(set) var rows: [CredentialRow] = []
    @Published private(set) var loading = false
    @Published var loadErrorText: String?

    /// Per-row key text, keyed by `providerId` — one shared `@Published` field could not serve N
    /// rows. Keyed by `providerId` rather than `CredentialRow.id` on purpose: a providerId can
    /// carry two rows (the `anthropic:default` api-key slot and the `anthropic:console` bearer
    /// slot), but at most ONE of them is `manageable`, so only one of them ever owns a field.
    ///
    /// This dictionary is the only place a typed key exists in the app. It is cleared for a
    /// provider the moment its `credential.set` succeeds, and it is never persisted anywhere.
    @Published var drafts: [String: String] = [:]

    /// The providerId whose save/remove is in flight — drives per-row control disabling, and
    /// serializes the section (a second action is ignored while one is running).
    @Published private(set) var busyProviderId: String?

    /// The last save/remove refusal, already reduced to a constant sentence. Never daemon prose.
    @Published var errorText: String?

    init(client: CredentialsClient) {
        self.client = client
    }

    func draft(for providerId: String) -> String { drafts[providerId] ?? "" }

    func setDraft(_ value: String, for providerId: String) { drafts[providerId] = value }

    /// Whitespace-only is as unsendable as empty (`credential.set` refuses it as
    /// `credential_value_invalid` anyway — W19-4 — so gating here avoids a round-trip that could
    /// only ever fail). The check is on a TRIMMED copy; the value actually SENT is never trimmed,
    /// since a key's own characters are not ours to alter (same rule as
    /// `ProviderPaneModel.canSave`).
    func canSave(_ providerId: String) -> Bool {
        busyProviderId == nil
            && !draft(for: providerId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A live read of the whole inventory (W19-3 — never a cached boot snapshot), so a key added
    /// from the phone or the CLI appears here on the next refresh with no daemon restart.
    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            rows = try await client.list()
            loadErrorText = nil
        } catch {
            loadErrorText = "couldn't load credentials — try Refresh"
        }
    }

    /// Save this row's typed key. On success the draft is cleared BEFORE the refresh is awaited, so
    /// the field is empty from the instant the write lands rather than "once the list comes back"
    /// — a slow or failing refresh must never leave the key sitting in the field.
    ///
    /// On failure the draft is deliberately KEPT: the most likely refusal is
    /// `credential_value_invalid` (a mistyped or truncated key), and clearing the field there would
    /// make the user retype a long secret to fix a one-character mistake.
    func save(providerId: String) async {
        guard canSave(providerId) else { return }
        let key = draft(for: providerId)
        busyProviderId = providerId
        defer { busyProviderId = nil }
        do {
            try await client.set(providerId: providerId, apiKey: key)
            drafts[providerId] = nil
            errorText = nil
            await refresh()
        } catch {
            errorText = refusalText(error, fallback: "couldn't save that key — try again")
        }
    }

    /// Delete this row's material. `remove` answering `false` (nothing was stored) is a SUCCESS,
    /// not a failure — the post-state the user asked for already holds — so it is discarded here
    /// and the refresh below shows the row as absent either way.
    func remove(providerId: String) async {
        guard busyProviderId == nil else { return }
        busyProviderId = providerId
        defer { busyProviderId = nil }
        do {
            _ = try await client.remove(providerId: providerId)
            errorText = nil
            await refresh()
        } catch {
            errorText = refusalText(error, fallback: "couldn't remove that credential — try again")
        }
    }

    /// Every branch returns a literal. Nothing derived from the thrown error's own text, and
    /// nothing derived from the typed value, can reach the screen through here.
    private func refusalText(_ error: Error, fallback: String) -> String {
        guard let rpc = error as? RpcError else { return fallback }
        switch rpc.credentialCode {
        case .kindUnsupported:
            // The one refusal that carries a destination — show it, since "no" without "go here
            // instead" is the failure mode this whole section exists to remove.
            return credentialDoorText(rpc.credentialDoor)
        case .valueInvalid:
            // Neutral by construction: never the value, never its length, never which character
            // offended. (W19-4's rule set — empty after trim, over 4096 chars, or an invisible/
            // control character — is the daemon's to enforce and not worth mirroring in prose that
            // would drift from it.)
            return "that key wasn't accepted — check it and try again"
        case .providerUnknown:
            return "this Mac's Winter doesn't know that provider"
        case .storeUnavailable:
            return "couldn't reach the Keychain — try again"
        case nil:
            return fallback
        }
    }
}

struct CredentialsSection: View {
    @ObservedObject var model: CredentialsSectionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Provider credentials").font(.headline)
                Spacer()
                Button("Refresh") { Task { await model.refresh() } }
                    .disabled(model.loading)
            }

            Text("Keys live only in this Mac's Keychain. Adding or removing one takes effect immediately — no restart.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let loadErrorText = model.loadErrorText {
                Text(loadErrorText).foregroundStyle(.red).font(.callout)
            }
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(.callout)
            }

            ForEach(model.rows) { row in
                credentialRow(row)
                Divider()
            }
        }
        .task { await model.refresh() }
    }

    @ViewBuilder
    private func credentialRow(_ row: CredentialRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(row.displayName)
                Spacer()
                Text(row.present ? "stored" : "not set")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if row.manageable {
                HStack(spacing: 8) {
                    SecureField("API key", text: Binding(
                        get: { model.draft(for: row.providerId) },
                        set: { model.setDraft($0, for: row.providerId) }
                    ))
                    Button("Save") { Task { await model.save(providerId: row.providerId) } }
                        .disabled(!model.canSave(row.providerId))
                    if row.present {
                        Button("Remove") { Task { await model.remove(providerId: row.providerId) } }
                            .disabled(model.busyProviderId != nil)
                    }
                }
            } else {
                // A row whose credential is a bespoke OAuth flow (Anthropic Console, Codex). Never
                // a field: `credential.set` would refuse it typed (`credential_kind_unsupported`),
                // so the door is shown INSTEAD of a control the user would only be told off for
                // using. No Remove either — W19-3 makes `manageable` the single gate for both
                // verbs on this surface, even though W19-5 does define a `credential.remove` for
                // `codex-oauth` (the CLI's `winter logout` is that row's door here).
                Text(credentialDoorText(row.door))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
