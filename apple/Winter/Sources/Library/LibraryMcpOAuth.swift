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

/// PURE: whether the detail page's "Set client secret…" action should show at all — polish round.
/// Gated on the daemon's own `oauthPreregistered` fact for THIS server, never inferred from `auth`:
/// a DCR/CIMD server has no client secret to set, and `nil` (an older daemon that has never heard of
/// this field) reads the same as `false` — hide it, rather than offering an action that would only
/// ever produce a refusal.
func mcpShowsClientSecretAction(_ server: McpServerRow) -> Bool {
    server.oauthPreregistered == true
}

/// PURE: maps a typed MCP-auth refusal (`error.data.code`, `RpcError.mcpAuthCode`) to plain, shown-
/// to-the-user text — polish round 2 (daemon-oauth lane's contract addition). `nil` when `error`
/// carries no code this build recognizes (a transport error, an untyped RPC failure, or a newer
/// daemon's code), so every catch site below falls back to ITS OWN generic wording rather than this
/// function inventing one. `.issuerChangeRequiresConfirmation` also answers `nil` — that refusal
/// drives its OWN confirmation phase (`McpSignInSheetModel.attemptLogin`) rather than ever being
/// shown as flat text; reaching this function with it unhandled would only be a caller that forgot
/// to check `RpcError.mcpIssuerChangeConfirmation` first.
///
/// The two SDK-raw codes (`sdkClientSecretIssuerMismatch`/`sdkMetadataIssuerMismatch`) share the
/// daemon's own `clientSecretIssuerMismatch` wording rather than each getting a sentence: all three
/// describe the same underlying fact (this server's sign-in configuration names an issuer/authorizer
/// that doesn't match what it should) from different layers, and a user has no use for which layer
/// caught it.
func mcpAuthErrorText(_ error: Error) -> String? {
    guard let code = (error as? RpcError)?.mcpAuthCode else { return nil }
    switch code {
    case .issuerChangeRequiresConfirmation:
        return nil
    case .serverNotFound:
        return "this server isn't configured"
    case .oauthNotApplicable:
        return "this server doesn't use sign-in"
    case .oauthConfigInvalid:
        return "this server's sign-in configuration is invalid"
    case .projectUntrusted:
        return "trust this project first"
    case .scopeNeedsCwd:
        return "this action needs a project directory this panel doesn't have"
    case .clientSecretUnavailable:
        return "no client secret is stored for this server"
    case .clientSecretIssuerMismatch, .sdkClientSecretIssuerMismatch, .sdkMetadataIssuerMismatch:
        return "this server's sign-in configuration points somewhere it shouldn't"
    case .loginFailed:
        return "sign-in failed"
    case .secretNeedsUserScope:
        return "client secrets can only be set at user scope"
    case .notPreregistered:
        return "this server has no pre-registered client to set a secret for"
    case .discoveryFailed:
        return "couldn't discover this server's sign-in details"
    }
}

/// PURE: the confirm sheet's second line about where the browser actually lands, or `nil` when it's
/// the same place as `issuerOrigin` and saying so twice would be noise (item 2, polish round 2).
func mcpAuthorizeOriginNote(issuerOrigin: String, authorizeOrigin: String) -> String? {
    guard authorizeOrigin != issuerOrigin else { return nil }
    return "You'll sign in at \(authorizeOrigin)."
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
        /// `mcp.login` was refused `mcp_issuer_change_requires_confirmation` — the server's issuer
        /// moved since a prior sign-in. Both origins, so the sheet can show "this server now signs
        /// in through NEW; it used to be STORED"; the user's "Continue" retries with
        /// `confirmIssuerChange: true` (`confirmIssuerChangeAndRetry()`).
        case confirmIssuerChange(storedIssuerOrigin: String, newIssuerOrigin: String)
        /// `mcp.login` answered; `issuerOrigin`/`authorizeOrigin` here are ITS authoritative values
        /// (never the row's hint). Waiting on the user's "Continue" tap before anything reaches a
        /// browser.
        case confirmOrigin(issuerOrigin: String, authorizeOrigin: String)
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
    /// site — `McpOAuthActionsModel.startSignIn`).
    func start() async {
        await attemptLogin(confirmIssuerChange: false)
    }

    /// The user's "Continue" tap on the issuer-change confirmation (`.confirmIssuerChange`) — retries
    /// with `confirmIssuerChange: true` now that the user has seen and accepted both origins. A
    /// no-op from any other phase.
    func confirmIssuerChangeAndRetry() async {
        guard case .confirmIssuerChange = phase else { return }
        await attemptLogin(confirmIssuerChange: true)
    }

    /// Calls `mcp.login`. `mcp_issuer_change_requires_confirmation` moves to its own confirmation
    /// phase rather than being treated as an ordinary failure; every other thrown error is a
    /// `.failure` with the SAME terminal shape a later poll failure would produce, discovered
    /// synchronously instead — mapped through `mcpAuthErrorText` where it recognizes the refusal,
    /// falling back to a generic sentence otherwise.
    private func attemptLogin(confirmIssuerChange: Bool) async {
        do {
            let begun = try await client.login(name: serverName, confirmIssuerChange: confirmIssuerChange)
            loginId = begun.loginId
            authUrl = begun.authUrl
            phase = .confirmOrigin(issuerOrigin: begun.issuerOrigin, authorizeOrigin: begun.authorizeOrigin)
        } catch {
            if let confirmation = (error as? RpcError)?.mcpIssuerChangeConfirmation {
                phase = .confirmIssuerChange(storedIssuerOrigin: confirmation.storedIssuerOrigin,
                                              newIssuerOrigin: confirmation.newIssuerOrigin)
            } else {
                phase = .failure(reason: mcpAuthErrorText(error) ?? "couldn't start sign-in")
            }
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
                phase = .failure(reason: mcpAuthErrorText(error) ?? "couldn't check the sign-in status")
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

    /// Set the first time THIS attempt's close is reported to `McpOAuthActionsModel` — lives on the
    /// attempt itself rather than being inferred from `McpOAuthActionsModel.signInSheet`'s own
    /// nil-ness, because SwiftUI's interactive dismissal (Esc, clicking outside the sheet) nils that
    /// binding directly, BEFORE `McpSignInSheet`'s `onDisappear` ever runs — by the time it does,
    /// the binding is already nil whether or not a button reported the close first, so it cannot
    /// tell the two apart. This flag can.
    private(set) var closeReported = false

    /// Always cancels; returns `true` only the FIRST time this attempt reports its close (`false`
    /// on every call after — the caller should treat that as "already handled, do nothing more").
    /// Called from every door a sheet can close through — Cancel, Done, and `onDisappear` — so
    /// whichever one runs first wins and the other's `onDisappear` (which always follows a button
    /// tap too, once SwiftUI tears the sheet down) becomes a harmless no-op rather than a second
    /// `onAuthChanged()` round-trip.
    @discardableResult
    func reportClose() -> Bool {
        cancel()
        guard !closeReported else { return false }
        closeReported = true
        return true
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
            case .confirmIssuerChange(let stored, let new):
                confirmIssuerChangeBody(storedIssuerOrigin: stored, newIssuerOrigin: new)
            case .confirmOrigin(let issuerOrigin, let authorizeOrigin):
                confirmBody(issuerOrigin: issuerOrigin, authorizeOrigin: authorizeOrigin)
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
        // The belt to `cancel()`'s suspender, AND the door `onAuthChanged()` needs for a completed
        // sign-in the user dismissed by Esc/click-outside rather than Done: SwiftUI's interactive
        // dismissal nils the parent's binding directly and calls neither the buttons below nor their
        // `onDone()` — so this is the only place that path is ever seen. `model.reportClose()` is
        // idempotent (`closeReported`), so when a button already ran it (every button below also
        // calls it, before `onDone()`), this fires again here as SwiftUI tears the sheet down and is
        // a harmless no-op — no second `onAuthChanged()` round-trip. Scoped to `.success` on purpose:
        // an Esc during `.starting`/`.confirmOrigin`/`.waiting`/`.failure` has nothing new for a
        // refresh to pick up, so it stays a plain cancel.
        .onDisappear {
            if model.phase == .success, model.reportClose() {
                onDone()
            } else {
                model.cancel()
            }
        }
    }

    private func startingBody(issuerOriginHint: String?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(issuerOriginHint.map { "Starting sign-in through \($0)…" } ?? "Starting sign-in…")
                .font(Typography.label())
                .foregroundStyle(.secondary)
            HStack {
                ProgressView().controlSize(.small)
                Spacer()
                Button("Cancel") { model.reportClose(); onDone() }
                    .keyboardShortcut(.cancelAction)
            }
        }
    }

    /// The issuer-change confirmation — shown INSTEAD of the ordinary confirm step when `mcp.login`
    /// was refused `mcp_issuer_change_requires_confirmation` (a server's issuer moved since a prior
    /// sign-in). "Continue" retries with `confirmIssuerChange: true`.
    private func confirmIssuerChangeBody(storedIssuerOrigin: String, newIssuerOrigin: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("This server now signs in through \(newIssuerOrigin); it used to be \(storedIssuerOrigin).")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { model.reportClose(); onDone() }
                    .keyboardShortcut(.cancelAction)
                Button("Continue") { Task { await model.confirmIssuerChangeAndRetry() } }
                    .accessibilityLabel("Continue signing in to \(model.serverName) at its new address, \(newIssuerOrigin)")
            }
        }
    }

    private func confirmBody(issuerOrigin: String, authorizeOrigin: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("You'll be redirected to \(issuerOrigin) to sign in.")
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // Item 2 (polish round 2): only when the browser actually lands somewhere ELSE — saying
            // the same origin twice would be noise, not information.
            if let note = mcpAuthorizeOriginNote(issuerOrigin: issuerOrigin, authorizeOrigin: authorizeOrigin) {
                Text(note)
                    .font(Typography.label())
                    .foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") { model.reportClose(); onDone() }
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
                Button("Cancel") { model.reportClose(); onDone() }
                    .keyboardShortcut(.cancelAction)
            }
        }
    }

    private var doneButton: some View {
        HStack {
            Spacer()
            Button("Done") { model.reportClose(); onDone() }
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
            errorText = mcpAuthErrorText(error) ?? "couldn't sign out — try again"
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
    /// Item 3 (polish round 2): the origin `mcp.setClientSecret` saved the secret against — shown as
    /// "Secret saved for <origin>" once `done`. `nil` until then.
    @Published private(set) var savedIssuerOrigin: String?

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
            savedIssuerOrigin = try await client.setClientSecret(name: serverName, secret: trimmed)
            errorText = nil
            done = true
        } catch {
            errorText = mcpAuthErrorText(error) ?? "couldn't save the client secret — try again"
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
            if model.done {
                // Item 3 (polish round 2): the ORIGIN the daemon actually saved it against, not
                // just "saved" — the same "say the concrete fact, not a bare acknowledgement"
                // posture as the sign-in sheet's own success line.
                Text("Secret saved for \(model.savedIssuerOrigin ?? model.serverName).")
                    .foregroundStyle(.green)
                    .font(Typography.label())
                HStack {
                    Spacer()
                    Button("Done") { onDone() }
                }
            } else {
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
                        Task { await model.submit() }
                    } label: {
                        HStack(spacing: 6) {
                            if model.submitting { ProgressView().controlSize(.small) }
                            Text("Save")
                        }
                    }
                    .disabled(model.submitting || model.secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(20)
        .frame(width: 380)
        .interactiveDismissDisabled(model.submitting)
        // The secret in the field is exactly as sensitive right up until submit as it is after —
        // leaving the sheet any other way (Esc past the guard above, once not submitting; the
        // panel's own Back) must not leave it sitting in a dismissed-but-still-alive model. Always
        // empty by the time this fires regardless (`submit()` clears it before its own `await`), so
        // this is belt-and-suspenders, not the primary clearing door.
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
