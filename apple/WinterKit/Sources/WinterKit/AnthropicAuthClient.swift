import Foundation
import WinterProtocol

// -----------------------------------------------------------------------------------------------
// Winter Phase 10a (Console login through Anthropic's official brokers), Lane A.
//
// Post-merge reconciliation (2026-09-13): Lane O's generated protocol landed on main (8aa77718) —
// `SessionEvent.providerLoginProgress`/`.providerLoginFinished` (`WinterProtocol`), and this kit's
// own exhaustive `seq`/`sessionId` switches (`WinterClient.swift`) already cover them. The wire
// method shapes this file guessed pre-merge (`provider.configure`'s anthropic arm,
// `provider.login`/`loginCode`/`logout`/`status`) matched Lane O's landed `methods.ts` byte-for-
// byte, so `LiveAnthropicAuthClient`'s request/response handling is UNCHANGED; the one real change
// is `loginUpdates()`, which now consumes the two typed `SessionEvent` cases off
// `WinterClient.events` instead of hand-parsing raw NDJSON off `WinterEvent.unknown(raw:)` (the
// events aren't unknown to this build any more). There is still no generated Swift type for an RPC
// METHOD's result (`WinterProtocol` mirrors `SessionEvent` variants only, per the architecture doc)
// — `status()`/`login()`/`submitLoginCode(_:)`/`logout()` still decode their `JSONValue` results by
// hand, same as every other method wrapper in `WinterClient+Methods.swift`.
//
// This file — protocol + `LiveAnthropicAuthClient` — is now the PERMANENT seam (not a stub to
// delete): `AnthropicAuthSectionModel`/`AnthropicLoginSheetModel`
// (`apple/Winter/Sources/Dashboard/panes/`) depend on the `AnthropicAuthClient` protocol so they
// stay testable against a fake with no socket/transport involved; `LiveAnthropicAuthClient` is
// simply its thin production implementation over `WinterClient`.
//
// M2 amendment (2026-09-13, measured against the real embedded `claude` binary): Console login is
// a paste-a-code flow, not an automatic browser callback. `login()` starts the flow and returns
// once the daemon has told the login binary to open the browser — NOT once the user has finished
// signing in. The user then pastes the one-time code Anthropic's page shows into the app;
// `submitLoginCode(_:)` sends it on. The terminal outcome (`provider_login_finished`) arrives
// later, asynchronously, on `loginUpdates()` — never as `login()`'s own return value. The code is a
// one-time secret: no conforming implementation may log it or any raw line that might carry it.
// -----------------------------------------------------------------------------------------------

/// Mirrors the eventual `provider.status`'s `anthropic` sub-object (P10a Interfaces).
public struct AnthropicAuthStatus: Equatable, Sendable {
    /// An Anthropic API key material exists (Keychain `anthropic:default`, `winter login
    /// --anthropic-key` or the in-app key field).
    public let apiKey: Bool
    /// A Console profile exists (`<home>/runtimes/anthropic-config/credentials/winter.json`).
    public let consoleProfile: Bool
    /// The user's chosen mode: `"auto" | "api-key" | "console"` (`runtimes.official.auth`).
    public let auth: String
    /// What's actually in effect right now: `"api-key" | "console" | "none"`.
    public let effective: String

    public init(apiKey: Bool, consoleProfile: Bool, auth: String, effective: String) {
        self.apiKey = apiKey
        self.consoleProfile = consoleProfile
        self.auth = auth
        self.effective = effective
    }
}

/// The wire value `runtimes.official.auth` takes when the user picks one of the two ENABLED radio
/// options. "Claude subscription" is disabled (P9c-1, awaiting Anthropic's approval) and never
/// produces one of these; `"auto"` is the untouched default and is never SENT by the section — it
/// is only ever a value `status().auth` can already hold, shown as whichever mode is `effective`.
public enum AnthropicAuthMode: String, Equatable, Sendable {
    case apiKey = "api-key"
    case console = "console"
}

/// One update on the CURRENT login attempt — a `provider_login_progress` line (the embedded
/// binary's own stdout/stderr; a browser URL line included as the sheet's fallback link) or
/// `provider_login_finished`'s terminal outcome (M2 amendment: never carries a profile name, only
/// `ok`/`reason`).
public enum AnthropicLoginEvent: Equatable, Sendable {
    case progress(String)
    case finished(ok: Bool, reason: String?)
}

/// The app's one seam onto every Anthropic-auth RPC. `AnthropicAuthSectionModel` and
/// `AnthropicLoginSheetModel` (`apple/Winter/Sources/Dashboard/panes/AnthropicAuthSection.swift` /
/// `AnthropicLoginSheet.swift`) depend on THIS protocol, never on `WinterClient` directly, so both
/// are unit-testable against a hand-written fake with no socket/transport involved.
public protocol AnthropicAuthClient: Sendable {
    func status() async throws -> AnthropicAuthStatus
    /// Selecting "API key" or "Console login" — `provider.configure`'s anthropic arm
    /// (`packages/protocol/src/methods.ts`'s `ProviderConfigureParams` union, P10a-3). Never called
    /// for the disabled "Claude subscription" row.
    func configureAuth(_ mode: AnthropicAuthMode) async throws
    /// Starts a console login attempt. Returns once the daemon confirms it told the login binary
    /// to open the browser — NOT once the user has finished signing in (M2 amendment). Returns the
    /// login binary's own hint URL when it has one (`provider.login`'s `urlHint`, ALREADY sanitized
    /// — query/fragment stripped) — the sheet's PRIMARY fallback link, with a line-scraped URL from
    /// `loginUpdates()` as backup. The terminal outcome arrives later on `loginUpdates()`, never as
    /// this call's own return value.
    func login() async throws -> URL?
    /// Submits the one-time code Anthropic's page shows the user, completing the attempt `login()`
    /// started. Never log the code. Throws on a thrown transport/RPC error OR on a well-formed
    /// `{ok:false}` reply — `ok:false` is a failure, not just a possible thrown error.
    func submitLoginCode(_ code: String) async throws
    /// Throws on a thrown transport/RPC error OR on a well-formed `{ok:false}` reply, same as
    /// `submitLoginCode(_:)`.
    func logout() async throws
    /// Progress lines + the terminal outcome for the CURRENT/most recent login attempt. A fresh
    /// subscriber only sees updates from the point of subscription forward (mirrors
    /// `WinterClient.events`'s own live-only semantics) — a caller that needs every line must
    /// subscribe before calling `login()`.
    func loginUpdates() -> AsyncStream<AnthropicLoginEvent>
}

/// The production implementation — every call routes through `WinterClient.request`, the same raw
/// JSON-RPC door every typed wrapper in `WinterClient+Methods.swift` is itself built on (there is
/// no generated Swift type for a method's own result — only `SessionEvent` variants are mirrored).
public final class LiveAnthropicAuthClient: AnthropicAuthClient, Sendable {
    private let client: WinterClient

    public init(client: WinterClient) {
        self.client = client
    }

    /// `provider.status` takes NO params — it's a status of every provider, keyed by name, not a
    /// per-provider query — and returns `{ anthropic: {...} }` directly.
    public func status() async throws -> AnthropicAuthStatus {
        let r = try await client.request("provider.status", params: .object([:]))
        let a = r["anthropic"]
        return AnthropicAuthStatus(
            apiKey: a?["apiKey"]?.boolValue ?? false,
            consoleProfile: a?["consoleProfile"]?.boolValue ?? false,
            auth: a?["auth"]?.stringValue ?? "auto",
            effective: a?["effective"]?.stringValue ?? "none"
        )
    }

    public func configureAuth(_ mode: AnthropicAuthMode) async throws {
        _ = try await client.request("provider.configure", params: .object([
            "provider": .string("anthropic"),
            "settings": .object(["runtimes.official.auth": .string(mode.rawValue)]),
        ]))
    }

    /// `provider.login` returns `{ started: true, urlHint?: string }` — `started` carries no
    /// independent meaning here (a thrown error is still how a failed START surfaces); `urlHint`,
    /// when present, is sanitized (query/fragment stripped —
    /// Console login URLs carry the one-time code/state there) and returned as the sheet's PRIMARY
    /// fallback link, ahead of any line-scraped backup (`AnthropicLoginSheetModel.urlFallback`,
    /// `apple/Winter/Sources/Dashboard/panes/AnthropicLoginSheet.swift`, which strips the same way
    /// independently — the two call sites don't share a helper on purpose, since only ONE of them
    /// (this one) can live in a module the other depends on, and duplicating five lines beat
    /// reaching across the dependency direction for it).
    public func login() async throws -> URL? {
        let r = try await client.request("provider.login", params: .object([
            "provider": .string("anthropic"), "kind": .string("console"),
        ]))
        guard let hint = r["urlHint"]?.stringValue,
              var components = URLComponents(string: hint)
        else { return nil }
        components.query = nil
        components.fragment = nil
        return components.url
    }

    public func submitLoginCode(_ code: String) async throws {
        let r = try await client.request("provider.loginCode", params: .object([
            "provider": .string("anthropic"), "kind": .string("console"), "code": .string(code),
        ]))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "provider.loginCode returned ok:false")
        }
    }

    public func logout() async throws {
        let r = try await client.request("provider.logout", params: .object([
            "provider": .string("anthropic"), "kind": .string("console"),
        ]))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "provider.logout returned ok:false")
        }
    }

    /// Consumes `WinterClient.events` for the two typed transient cases the generated protocol now
    /// carries (`SessionEvent.providerLoginProgress`/`.providerLoginFinished`) — both are
    /// TRANSIENT (`$system`-scoped, never persisted/replayed), so `WinterClient.route()` yields
    /// them on `.session(...)` unconditionally, bypassing the per-session seq/attach gate entirely
    /// (`WinterClient.swift`'s own doc comment on that path). `provider` is checked defensively
    /// even though "anthropic" is the only value either case can carry today (P10a-6's own doc:
    /// `{provider, kind}` on every param is deliberately wide for a later provider/kind).
    public func loginUpdates() -> AsyncStream<AnthropicLoginEvent> {
        AsyncStream { continuation in
            let task = Task {
                for await ev in client.events {
                    guard case .session(let event) = ev else { continue }
                    switch event {
                    case .providerLoginProgress(let v) where v.provider == "anthropic":
                        continuation.yield(.progress(v.line))
                    case .providerLoginFinished(let v) where v.provider == "anthropic":
                        continuation.yield(.finished(ok: v.ok, reason: v.reason))
                    default:
                        break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
