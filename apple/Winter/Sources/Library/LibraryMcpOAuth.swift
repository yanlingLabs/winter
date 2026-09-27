import AppKit
import WinterKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// LibraryMcpOAuth — WS-25 (MCP OAuth), Mac lane. The Library MCP tab's sign-in/out/client-secret
// affordance for an external HTTP/SSE server (`LibraryMcpTab.swift`'s `LibraryMcpServerDetail`).
//
// **Why a whole second protocol (`McpAuthClient`, `WinterKit`) instead of another closure on
// `McpToolsModel`'s bare `Lister`.** `mcp.list` is one read with no state machine; sign-in is FOUR
// calls with a polling loop, a browser hand-off and three sheets — the same shape that earned
// `AnthropicAuthClient`/`LiveAnthropicAuthClient` their own file rather than another closure on
// `DashboardWiring`, and for the identical reason: `McpSignInSheetModel`'s poll state machine below
// is unit-tested as a PURE function (`mcpSignInPollOutcome`) plus a hand-written
// `FakeMcpAuthClient`, with no socket/transport anywhere in the test.
//
// **The login-order fix (spec `WS-25-mcp-oauth.md` §3, Mac lane, vs. the lane brief's own wording).**
// The brief describes "a sheet that shows the issuer origin and asks to continue; ON CONTINUE call
// `mcp.login`" — but the ONLY issuer origin known before `mcp.login` is called is `mcp.list`'s
// `oauthIssuerOrigin`, which is OPTIONAL (absent on an older daemon, or a server this daemon hasn't
// probed yet) and, even when present, is a HINT the daemon itself hasn't re-verified at this moment.
// The binding spec's own §3 line puts the calls in the other order — "Sign in (calls `mcp.login`,
// shows the AS issuer origin, then opens `authUrl`…)" — which this file follows: tapping "Sign in"
// calls `mcp.login` FIRST (there is nothing to see or confirm before the daemon answers), and the
// sheet's confirm step shows `mcp.login`'s own AUTHORITATIVE `issuerOrigin` — always present, never
// a stale guess — before it ever opens a browser. `McpServerRow.oauthIssuerOrigin` is used only as
// the confirm step's PLACEHOLDER text while `mcp.login` is still in flight (`.starting`), so the
// sheet has something to say instead of a bare spinner when the hint exists.
//
// **`authUrl` is opened, never rendered as text.** It carries PKCE `state`/`code_challenge`
// (`McpAuthClient.swift`'s own header) — a `Link` view or a copyable string would put a one-time
// secret in the accessibility tree and the undo-able clipboard both. The one place it appears is
// `NSWorkspace.shared.open(_:)`'s argument, through the injectable `openURL` below (never called
// directly from a test).
// -----------------------------------------------------------------------------------------------

// MARK: - Pure display helper

/// PURE: the trailing badge text for a server's OAuth state — `mcp.list`'s own `auth` field,
/// rendered the same "unknown word survives, `nil` renders nothing" way `McpServerRow.status`
/// itself does. `nil` (an older daemon) and `"none"` (the daemon looked and there is no OAuth here)
/// both render nothing: a badge would claim a fact silence and "not applicable" don't have.
func mcpAuthBadge(_ auth: String?) -> String? {
    switch auth {
    case nil, "none": return nil
    case "signed-in": return "Signed in"
    case "needs-auth": return "Needs sign-in"
    case let other?: return other
    }
}

// MARK: - The sign-in poll's pure state machine

/// One step's outcome — PURE, no async, no `Task`, no clock: `McpSignInSheetModel.poll(loginId:)`
/// is the only caller, and every branch this function can take is table-tested directly.
enum McpSignInPollOutcome: Equatable {
    case stillWaiting
    case success
    case failed(reason: String)
}

/// PURE: one `mcp.loginStatus` reply, decided. `attempt` is 1-indexed (the attempt that just
/// completed); `maxAttempts` is the item 2 "5-min cap" as an attempt COUNT rather than a wall-clock
/// deadline, so a test can set both `maxAttempts` and the poll interval to whatever makes it fast
/// without the outcome logic itself knowing about time at all.
///
/// A CLIENT-SIDE cap reached while the daemon still says `.pending` is worded as a TIMEOUT ("took
/// too long"), never as the daemon's own `.expired` — misattributing which side gave up would send
/// a user chasing the wrong door. `.unknown(word)` (a state this build has no rule for — a newer
/// daemon) is an IMMEDIATE failure naming the word, not extra pending attempts: spinning for up to
/// five minutes on a value nobody here understands would be worse than failing plainly right away.
func mcpSignInPollOutcome(status: McpLoginStatus, attempt: Int, maxAttempts: Int) -> McpSignInPollOutcome {
    switch status.state {
    case .done:
        return .success
    case .failed:
        return .failed(reason: status.error ?? "sign-in failed")
    case .expired:
        return .failed(reason: status.error ?? "this sign-in attempt expired — try signing in again")
    case .pending:
        if attempt >= maxAttempts {
            return .failed(reason: "sign-in timed out — try again")
        }
        return .stillWaiting
    case .unknown(let word):
        return .failed(reason: "the daemon reported an unrecognized sign-in state (\(word)) — try again")
    }
}

// MARK: - Sign-in sheet

/// The "Sign in" sheet's state machine. `LibraryMcpServerDetail` opens one per attempt
/// (`McpOAuthActionsModel.startSignIn`); it is torn down (and its poll cancelled) the moment the
/// sheet closes, by any door — Done, Cancel, Esc, or the panel navigating away.
@MainActor
final class McpSignInSheetModel: ObservableObject, Identifiable {
    enum Phase: Equatable {
        /// `mcp.login` is in flight. `issuerOriginHint` (the row's OWN, possibly stale/absent
        /// value) is shown here as placeholder text — see this file's header note on ordering.
        case starting(issuerOriginHint: String?)
        /// `mcp.login` answered; `issuerOrigin` here is ITS authoritative value. Waiting on the
        /// user's "Continue" tap before anything reaches a browser.
        case confirmOrigin(issuerOrigin: String)
        /// The browser is open (or the user can open it again via `authUrl`); polling
        /// `mcp.loginStatus` every `pollIntervalNanos`.
        case waiting
        case success
        case failure(reason: String)
    }

    let id = UUID()
    let serverName: String

    @Published private(set) var phase: Phase
    /// Set once `mcp.login` answers; `nil` before that and after a failure that never got one.
    @Published private(set) var authUrl: URL?

    private let client: McpAuthClient
    private let maxAttempts: Int
    private let pollIntervalNanos: UInt64
    /// Injectable so a test never actually opens a browser (mirrors `SettingsLinkSection.swift`'s
    /// own `open: (URL) -> Void` seam).
    private let openURL: (URL) -> Void
    /// Injectable so a test's poll loop doesn't really wait a second per attempt.
    private let sleep: @Sendable (UInt64) async -> Void
    private var pollTask: Task<Void, Never>?
    private var loginId: String?

    /// `maxAttempts: 300` × `pollIntervalNanos: 1_000_000_000` ≈ the item 2 "5-min cap".
    init(client: McpAuthClient, serverName: String, issuerOriginHint: String?,
         maxAttempts: Int = 300,
         pollIntervalNanos: UInt64 = 1_000_000_000,
         openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) },
         sleep: @escaping @Sendable (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }) {
        self.client = client
        self.serverName = serverName
        self.phase = .starting(issuerOriginHint: issuerOriginHint)
        self.maxAttempts = maxAttempts
        self.pollIntervalNanos = pollIntervalNanos
        self.openURL = openURL
        self.sleep = sleep
    }

    /// Called once, right after the sheet is presented (mirrors `AnthropicLoginSheetModel.start()`'s
    /// own "construction opens the sheet; `start()` is fired off as its own task" split at the call
    /// site — `McpOAuthActionsModel.startSignIn`). Calls `mcp.login`; a thrown error is a `.failure`
    /// with the SAME terminal shape a later poll failure would produce, discovered synchronously
    /// instead.
    func start() async {
        do {
            let begun = try await client.login(name: serverName)
            loginId = begun.loginId
            authUrl = begun.authUrl
            phase = .confirmOrigin(issuerOrigin: begun.issuerOrigin)
        } catch {
            phase = .failure(reason: "couldn't start sign-in")
        }
    }

    /// The user's "Continue" tap on the confirm step — the one point this model ever calls
    /// `openURL`. A no-op from any other phase (double-tap guard; there is also no button to
    /// produce a second tap from `.waiting` onward).
    func continueSignIn() {
        guard case .confirmOrigin = phase, let authUrl, let loginId else { return }
        phase = .waiting
        openURL(authUrl)
        pollTask = Task { [weak self] in
            await self?.poll(loginId: loginId)
        }
    }

    private func poll(loginId: String) async {
        var attempt = 0
        while !Task.isCancelled {
            attempt += 1
            let status: McpLoginStatus
            do {
                status = try await client.loginStatus(loginId: loginId)
            } catch {
                phase = .failure(reason: "couldn't check the sign-in status")
                return
            }
            switch mcpSignInPollOutcome(status: status, attempt: attempt, maxAttempts: maxAttempts) {
            case .success:
                phase = .success
                return
            case .failed(let reason):
                phase = .failure(reason: reason)
                return
            case .stillWaiting:
                await sleep(pollIntervalNanos)
            }
        }
    }

    /// Cancel tapped, or the sheet otherwise dismissed — stops polling. A no-op once the phase is
    /// already terminal (`.success`/`.failure`); `.starting`/`.confirmOrigin` have no task to cancel
    /// yet, so this is safe to call from any phase unconditionally.
    func cancel() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Direct property access, not a call to `cancel()` — same nonisolated-`deinit` rule
    /// `EditorFileWatcher.deinit` documents (an isolated method can't be called from a nonisolated
    /// deinit, but touching this type's own stored property can).
    deinit {
        pollTask?.cancel()
    }
}

struct McpSignInSheet: View {
    @ObservedObject var model: McpSignInSheetModel
    /// Fired by Cancel/Done — the PARENT (`McpOAuthActionsModel`) owns dismissal via its own
    /// `@Published` binding, same posture as `AnthropicLoginSheet`/`ConsentSheet`.
    let onDone: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign in to \(model.serverName)")
                .font(Typography.paneTitle)

            switch model.phase {
            case .starting(let issuerOriginHint):
                startingBody(issuerOriginHint: issuerOriginHint)
            case .confirmOrigin(let issuerOrigin):
                confirmBody(issuerOrigin: issuerOrigin)
            case .waiting:
                waitingBody
            case .success:
                Text("Signed in.")
                    .foregroundStyle(.green)
                    .font(Typography.label())
                doneButton
            case .failure(let reason):
                Text(reason)
                    .foregroundStyle(.red)
                    .font(Typography.label())
                doneButton
            }
        }
        .padding(20)
        .frame(width: 420)
        // The belt to `cancel()`'s suspender: Cancel/Done route through `onDone()`, but SwiftUI's
        // OWN interactive dismissal (Esc, clicking outside the sheet) nils the parent's binding
        // directly and calls neither — without this, the poll `Task` keeps `model` alive and
        // polling for up to its own cap (item 2's 5-min timeout) after the sheet is already gone,
        // since `poll()` captures `self` STRONGLY for its own duration (only the spawning `Task {
        // [weak self] in … }` is weak). `cancel()` is idempotent, so this fires harmlessly even
        // when Cancel/Done already called it.
        .onDisappear { model.cancel() }
    }

    private func startingBody(issuerOriginHint: String?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(issuerOriginHint.map { "Starting sign-in through \($0)…" } ?? "Starting sign-in…")
                .font(Typography.label())
                .foregroundStyle(.secondary)
            HStack {
                ProgressView().controlSize(.small)
                Spacer()
                Button("Cancel") { model.cancel(); onDone() }
                    .keyboardShortcut(.cancelAction)
            }
        }
    }

    private func confirmBody(issuerOrigin: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("You'll be redirected to \(issuerOrigin) to sign in.")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { model.cancel(); onDone() }
                    .keyboardShortcut(.cancelAction)
                Button("Continue") { model.continueSignIn() }
                    .accessibilityLabel("Continue signing in to \(model.serverName) through \(issuerOrigin)")
            }
        }
    }

    private var waitingBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("A browser window should open. Finish signing in there, then come back to this window.")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                ProgressView().controlSize(.small)
                Spacer()
                Button("Cancel") { model.cancel(); onDone() }
                    .keyboardShortcut(.cancelAction)
            }
        }
    }

    private var doneButton: some View {
        HStack {
            Spacer()
            Button("Done") { onDone() }
        }
    }
}

// MARK: - Sign-out sheet

/// A confirmation, not a progress sheet — one RPC, no polling. Mirrors `ConsentSheet`'s "confirm
/// with an explicit action, no default-action Enter" gravity for a destructive-ish choice.
@MainActor
final class McpSignOutSheetModel: ObservableObject, Identifiable {
    let id = UUID()
    let serverName: String
    /// "Also forget this app's registration with the server" (item 3) — `nil` maps to omitting the
    /// wire key entirely (`McpAuthClient.logout`'s own doc), so leaving this `false` and submitting
    /// is indistinguishable from never having shown the checkbox at all; that's deliberate, not a
    /// gap, since `false` and "omitted" are the same daemon-side default.
    @Published var forgetClient = false
    @Published private(set) var submitting = false
    @Published var errorText: String?
    @Published private(set) var done = false

    private let client: McpAuthClient

    init(client: McpAuthClient, serverName: String) {
        self.client = client
        self.serverName = serverName
    }

    func confirm() async {
        guard !submitting else { return }
        submitting = true
        defer { submitting = false }
        do {
            try await client.logout(name: serverName, forgetClient: forgetClient)
            errorText = nil
            done = true
        } catch {
            errorText = "couldn't sign out — try again"
        }
    }
}

struct McpSignOutSheet: View {
    @ObservedObject var model: McpSignOutSheetModel
    let onCancel: () -> Void
    let onDone: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign out of \(model.serverName)")
                .font(Typography.paneTitle)
            Toggle("Also forget this app's registration with the server", isOn: $model.forgetClient)
                .font(Typography.label())
                .disabled(model.submitting)
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label())
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                    .disabled(model.submitting)
                Button {
                    Task {
                        await model.confirm()
                        if model.done { onDone() }
                    }
                } label: {
                    HStack(spacing: 6) {
                        if model.submitting { ProgressView().controlSize(.small) }
                        Text("Sign out")
                    }
                }
                .disabled(model.submitting)
                .accessibilityLabel("Confirm sign out of \(model.serverName)")
            }
        }
        .padding(20)
        .frame(width: 380)
        // Same posture as `ConsentSheet`'s `busy` guard: a submit in flight must not be torn down
        // out from under `confirm()`'s own await.
        .interactiveDismissDisabled(model.submitting)
    }
}

// MARK: - Client-secret sheet

/// A pre-registered `oauth.clientId` server's secret — never displayed, never logged, never
/// retained on this type past the moment it is sent. Mirrors `AnthropicLoginSheetModel.submitCode()`
/// exactly: the field is cleared BEFORE the `await`, unconditionally, regardless of outcome.
@MainActor
final class McpClientSecretSheetModel: ObservableObject, Identifiable {
    let id = UUID()
    let serverName: String
    @Published var secret: String = ""
    @Published private(set) var submitting = false
    @Published var errorText: String?
    @Published private(set) var done = false

    private let client: McpAuthClient

    init(client: McpAuthClient, serverName: String) {
        self.client = client
        self.serverName = serverName
    }

    func submit() async {
        let trimmed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !submitting else { return }
        submitting = true
        secret = ""
        defer { submitting = false }
        do {
            try await client.setClientSecret(name: serverName, secret: trimmed)
            errorText = nil
            done = true
        } catch {
            errorText = "couldn't save the client secret — try again"
        }
    }
}

struct McpClientSecretSheet: View {
    @ObservedObject var model: McpClientSecretSheetModel
    let onCancel: () -> Void
    let onDone: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Client secret for \(model.serverName)")
                .font(Typography.paneTitle)
            Text("For a server already registered with a client id. Stored in the Keychain; never shown again.")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            SecureField("Client secret", text: $model.secret)
                .textFieldStyle(.roundedBorder)
                .disabled(model.submitting)
                .accessibilityLabel("Client secret for \(model.serverName)")
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label())
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                    .disabled(model.submitting)
                Button {
                    Task {
                        await model.submit()
                        if model.done { onDone() }
                    }
                } label: {
                    HStack(spacing: 6) {
                        if model.submitting { ProgressView().controlSize(.small) }
                        Text("Save")
                    }
                }
                .disabled(model.submitting || model.secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 380)
        .interactiveDismissDisabled(model.submitting)
        // The secret in the field is exactly as sensitive right up until submit as it is after —
        // leaving the sheet any other way (Esc past the guard above, once not submitting; the
        // panel's own Back) must not leave it sitting in a dismissed-but-still-alive model.
        .onDisappear { model.secret = "" }
    }
}

// MARK: - The owning model

/// Owns the three sheets above for ONE server's detail page (`LibraryMcpServerDetail`). `client ==
/// nil` (no wiring — an app running without daemon wiring, or a pure-construction test) is a first-
/// class "no door" state: every `start…` call becomes a no-op and `isUnwired` disables every button
/// the detail page shows, same posture as `McpToolsModel`/`WinterCapabilitiesModel`'s own `isUnwired`.
@MainActor
final class McpOAuthActionsModel: ObservableObject {
    private let client: McpAuthClient?
    /// Re-reads `mcp.list` (item 1's "after every login/logout" rule) — `McpToolsModel.refresh()`,
    /// the SAME nil-cwd pure read the tab already does on appear and Refresh. Never called after a
    /// client-secret save alone: item 4 doesn't ask for a re-poll, and a secret's presence isn't
    /// reflected in `auth` anyway. NOT live — there is no MCP `SessionEvent` until slice 3
    /// (`docs/superpowers/specs/winter/WS-25-mcp-oauth.md` §6), so a sign-in finished on the CLI or
    /// the phone is only seen here at the next poll (pane open, a login/logout of THIS pane's own,
    /// or a manual Refresh).
    private let onAuthChanged: () async -> Void

    @Published var signInSheet: McpSignInSheetModel?
    @Published var signOutSheet: McpSignOutSheetModel?
    @Published var clientSecretSheet: McpClientSecretSheetModel?

    var isUnwired: Bool { client == nil }

    init(client: McpAuthClient?, onAuthChanged: @escaping () async -> Void) {
        self.client = client
        self.onAuthChanged = onAuthChanged
    }

    /// Construction + `signInSheet =` happen synchronously (the sheet opens immediately, showing
    /// "Starting sign-in…") — `start()` itself is fired off as its own task since it awaits the
    /// daemon's `mcp.login` round-trip, same split as `AnthropicAuthSectionModel.startLogin()`.
    func startSignIn(serverName: String, issuerOriginHint: String?) {
        guard let client else { return }
        let sheet = McpSignInSheetModel(client: client, serverName: serverName, issuerOriginHint: issuerOriginHint)
        signInSheet = sheet
        Task { await sheet.start() }
    }

    func signInSheetClosed() {
        signInSheet?.cancel()
        signInSheet = nil
        Task { await onAuthChanged() }
    }

    func startSignOut(serverName: String) {
        guard let client else { return }
        signOutSheet = McpSignOutSheetModel(client: client, serverName: serverName)
    }

    func signOutSheetClosed() {
        signOutSheet = nil
        Task { await onAuthChanged() }
    }

    func startClientSecret(serverName: String) {
        guard let client else { return }
        clientSecretSheet = McpClientSecretSheetModel(client: client, serverName: serverName)
    }

    /// No `onAuthChanged()` call here — see this class's own header note.
    func clientSecretSheetClosed() {
        clientSecretSheet = nil
    }
}
