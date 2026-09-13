import WinterKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// AnthropicAuthSection — Winter Phase 10a Task A1/A2: the Provider pane's Anthropic (Claude) block.
// Three custom-drawn radio options (docs/brand.md: never native list/radio treatment) — "API key",
// "Console login", "Claude subscription" (disabled, P9c-1) — plus the Console option's sign-in/out
// affordances and the login-progress sheet (`AnthropicLoginSheet.swift`).
//
// Modeled on `ProviderPaneModel` immediately above in this directory (same "own view-model, built
// around the raw client, no closures for the RPCs themselves" posture) with ONE deliberate
// difference: this model is built around `AnthropicAuthClient` (a protocol, `WinterKit`'s
// `AnthropicAuthClient.swift`), not the concrete `WinterClient` — so it is unit-testable against a
// hand-written fake with no socket/transport involved, same as every test in this file's sibling
// `AnthropicAuthSectionModelTests.swift`. `ProviderPaneModel` constructs the live implementation
// (`LiveAnthropicAuthClient(client:)`) and owns this model as `anthropicAuth`, so `ProviderPane`'s
// existing `.task`/wiring needs no changes beyond rendering the new section.
// -----------------------------------------------------------------------------------------------

/// The three radio rows, in display order. `.subscription` is permanently disabled (P9c-1: "Claude
/// subscription" login stays off until Anthropic approves it) — it is never the argument to a
/// `provider.configure` call.
enum AnthropicAuthOption: CaseIterable, Equatable {
    case apiKey
    case console
    case subscription
}

/// Pure display helper (mirrors `providerStatusText`'s "own tiny pure function" posture at the top
/// of `ProviderPane.swift`) — the section's status line, driven by `effective` alone. `apiKey`/
/// `consoleProfile` carry no independent text of their own: `provider.status.anthropic` keeps
/// `effective` consistent with them by construction (P10a Interfaces), so this never has a
/// contradiction to reconcile.
func anthropicAuthStatusText(_ status: AnthropicAuthStatus) -> String {
    switch status.effective {
    case "console": return "signed in (Console)"
    case "api-key": return "API key"
    default: return "not configured"
    }
}

@MainActor
final class AnthropicAuthSectionModel: ObservableObject {
    private let client: AnthropicAuthClient

    @Published private(set) var status: AnthropicAuthStatus?
    @Published private(set) var statusLoading = false
    @Published var statusErrorText: String?

    @Published private(set) var selecting = false
    @Published var selectErrorText: String?

    /// The Task A2 progress sheet — `.sheet(item:)`-driven (same idiom as
    /// `PluginManagerModel.consentSheet`, `PluginManagerView.swift`): setting this non-nil is the
    /// ONE thing that opens it; SwiftUI nils it back on dismiss (Esc, swipe, or the sheet's own
    /// "Done").
    @Published var loginSheet: AnthropicLoginSheetModel?

    init(client: AnthropicAuthClient) {
        self.client = client
    }

    /// The radio that reads as selected right now. `"auto"` (the untouched default, P10a-3) has no
    /// radio of its own — shown as whichever mode is CURRENTLY effective, per the brief ("'auto' is
    /// the untouched default shown as whichever is effective"). No status loaded yet defaults to
    /// `.apiKey` rather than leaving every radio unselected (`refreshStatus()` corrects it as soon
    /// as it lands, same "assume the common case" posture as `ProviderPaneModel.baseUrl`'s default).
    var selectedOption: AnthropicAuthOption {
        guard let status else { return .apiKey }
        switch status.auth {
        case "api-key": return .apiKey
        case "console": return .console
        default: return status.effective == "console" ? .console : .apiKey
        }
    }

    var statusText: String {
        guard let status else { return "not configured" }
        return anthropicAuthStatusText(status)
    }

    var hasConsoleProfile: Bool { status?.consoleProfile ?? false }

    func refreshStatus() async {
        statusLoading = true
        defer { statusLoading = false }
        do {
            status = try await client.status()
            statusErrorText = nil
        } catch {
            statusErrorText = "couldn't load Anthropic status — try Refresh"
        }
    }

    /// Tapping a radio row. `.subscription` is disabled in the view (`.disabled(true)`, never
    /// reachable by a click) — guarded again here defensively, so a future view change that
    /// disabled it incorrectly would show as "nothing happened" rather than a silent RPC.
    func select(_ option: AnthropicAuthOption) async {
        guard option != .subscription else { return }
        let mode: AnthropicAuthMode = option == .console ? .console : .apiKey
        selecting = true
        defer { selecting = false }
        do {
            try await client.configureAuth(mode)
            selectErrorText = nil
            await refreshStatus()
        } catch {
            selectErrorText = "couldn't switch sign-in method — try again"
        }
    }

    /// "Sign in to Anthropic Console" — opens the progress sheet and starts the login attempt.
    /// Construction + `loginSheet =` happen synchronously (the sheet opens immediately, showing
    /// "Waiting for your browser…") — `start()` itself is fired off as its own task since it awaits
    /// the daemon's `login()` round-trip.
    func startLogin() {
        let sheet = AnthropicLoginSheetModel(client: client)
        loginSheet = sheet
        Task { await sheet.start() }
    }

    func signOut() async {
        do {
            try await client.logout()
            selectErrorText = nil
            await refreshStatus()
        } catch {
            selectErrorText = "couldn't sign out — try again"
        }
    }
}

struct AnthropicAuthSection: View {
    @ObservedObject var model: AnthropicAuthSectionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Anthropic (Claude)").font(Typography.control(.semibold))

            VStack(alignment: .leading, spacing: 6) {
                optionRow(.apiKey, title: "API key", caption: nil)
                optionRow(.console, title: "Console login", caption: nil)
                optionRow(.subscription, title: "Claude subscription", caption: "Awaiting Anthropic approval")
            }

            if model.selectedOption == .console {
                HStack(spacing: 8) {
                    Button("Sign in to Anthropic Console") { model.startLogin() }
                        .disabled(model.selecting)
                    if model.hasConsoleProfile {
                        Button("Sign out") { Task { await model.signOut() } }
                            .disabled(model.selecting)
                    }
                }
            }

            if let statusErrorText = model.statusErrorText {
                Text(statusErrorText).foregroundStyle(.red).font(Typography.label())
            } else {
                Text(model.statusText)
                    .font(Typography.controlMono())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            if let selectErrorText = model.selectErrorText {
                Text(selectErrorText).foregroundStyle(.red).font(Typography.label())
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

    private func optionRow(_ option: AnthropicAuthOption, title: String, caption: String?) -> some View {
        let isSelected = model.selectedOption == option
        let isDisabled = option == .subscription
        return Button {
            Task { await model.select(option) }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                // Custom-drawn radio glyph — docs/brand.md forbids native list/radio treatment.
                ZStack {
                    Circle()
                        .strokeBorder(isSelected && !isDisabled ? Theme.accent : Color.secondary, lineWidth: 1.5)
                        .frame(width: 14, height: 14)
                    if isSelected && !isDisabled {
                        Circle().fill(Theme.accent).frame(width: 7, height: 7)
                    }
                }
                .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Typography.label())
                        .foregroundStyle(isDisabled ? Theme.textMuted : .primary)
                    if let caption {
                        Text(caption).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || model.selecting)
    }
}
