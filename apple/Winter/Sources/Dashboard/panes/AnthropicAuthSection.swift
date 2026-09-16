import WinterKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// AnthropicAuthSection — Winter Phase 10a Task A1/A2: the Provider pane's Anthropic (Claude) block.
//
// WS-20 review fix (M3): the three-radio "pick a sign-in ARM" UI is RETIRED along with
// `runtimes.official.auth`/`provider.configure`'s anthropic arm — there is no standing setting
// left to pick. THE ARM IS THE MODEL now: a session tagged `anthropic/…` uses the API key
// material, one tagged `console/…` uses the Console profile; both can be configured and present at
// once (`effective: "both"`). This section is now read-only PRESENCE plus the Console
// sign-in/sign-out affordance (creating/removing the profile is still a real action, independent
// of any "which one is active" choice) and the login-progress sheet (`AnthropicLoginSheet.swift`).
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

/// Pure display helper (mirrors `providerStatusText`'s "own tiny pure function" posture at the top
/// of `ProviderPane.swift`) — the section's status line, driven by `effective` alone (presence,
/// WS-20 review fix M3).
func anthropicAuthStatusText(_ status: AnthropicAuthStatus) -> String {
    switch status.effective {
    case "both": return "API key + Console"
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
        selecting = true
        defer { selecting = false }
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

            // WS-20 review fix (M3): no more arm picker — the arm is the model (an `anthropic/…`
            // tag uses the API key, a `console/…` tag uses the Console profile); either or both can
            // be configured at once. This section is read-only presence plus the Console sign-in/
            // sign-out affordance below.
            Text("The arm is the model: anthropic/… uses the API key, console/… uses the Console profile.")
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)

            HStack(spacing: 8) {
                if model.hasConsoleProfile {
                    Button("Sign out") { Task { await model.signOut() } }
                        .disabled(model.selecting)
                } else {
                    Button("Sign in to Anthropic Console") { model.startLogin() }
                        .disabled(model.selecting)
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
}
