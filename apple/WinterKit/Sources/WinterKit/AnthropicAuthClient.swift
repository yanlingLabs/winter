import Foundation

// -----------------------------------------------------------------------------------------------
// Winter Phase 10a (Console login through Anthropic's official brokers), Lane A.
//
// Lane O's generated types replace this after merge (P10a Interfaces): `provider.login`/
// `provider.logout`/the extended `provider.status`/the transient `provider_login_progress` event
// land in `packages/protocol/*` + this kit's own generated mirror on a LATER merge (Lane O owns
// the protocol change end-to-end, per the phase plan's Lanes section). Until then, this file is
// the whole seam: a hand-written protocol + a stub implementation over `WinterClient`'s existing
// raw `request(_:params:)` door, so the app (`AnthropicAuthSectionModel`/`AnthropicLoginSheetModel`,
// `apple/Winter/Sources/Dashboard/panes/`) can be built and unit-tested against a fake NOW rather
// than waiting on the protocol merge. When Lane O lands: delete this file, re-point those two model
// types at the generated wrappers, keeping the SAME method names on purpose (`status()`, `login()`,
// `submitLoginCode(_:)`, `logout()`, `configureAuth(_:)`, `loginUpdates()`) so the call sites don't
// have to change, only their type's origin.
//
// M2 amendment (2026-09-13, measured against the real embedded `claude` binary): Console login is
// a paste-a-code flow, not an automatic browser callback. `login()` starts the flow and returns
// once the daemon has told the login binary to open the browser — NOT once the user has finished
// signing in. The user then pastes the one-time code Anthropic's page shows into the app;
// `submitLoginCode(_:)` sends it on. The terminal outcome (`provider_login_finished`) arrives
// later, asynchronously, on `loginUpdates()` — never as `login()`'s own return value. The code is a
// one-time secret: no conforming implementation may log it or any raw line that might carry it.
//
// Real `SessionEvent` decoding is a closed, exhaustive enum (`WinterProtocol`) — a `type` it
// doesn't know (which `provider_login_progress`/`provider_login_finished` currently are, since
// Lane O hasn't landed them) fails that decode and surfaces as `ServerMessage.unknownEvent(raw:)` /
// `WinterEvent.unknown(raw:)` instead (`ServerMessage.swift`'s own doc comment: "a newer daemon's
// event type... never a crash, never silently dropped"). `LiveAnthropicAuthClient.loginUpdates()`
// below parses that raw NDJSON line by hand for exactly those two `type`s, which is why this stub
// can observe a real daemon's progress lines today even though WinterKit has no typed case for them.
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
    /// Selecting "API key" or "Console login" — `provider.configure`'s anthropic arm (stub shape;
    /// Lane O owns the real wire schema). Never called for the disabled "Claude subscription" row.
    func configureAuth(_ mode: AnthropicAuthMode) async throws
    /// Starts a console login attempt. Returns once the daemon confirms it told the login binary
    /// to open the browser — NOT once the user has finished signing in (M2 amendment). Returns the
    /// login binary's own hint URL when it has one (`provider.login`'s `urlHint`, ALREADY sanitized
    /// via `sanitizedLoginURL` — query/fragment stripped) — the sheet's PRIMARY fallback link, with
    /// a line-scraped URL from `loginUpdates()` as backup. The terminal outcome arrives later on
    /// `loginUpdates()`, never as this call's own return value.
    func login() async throws -> URL?
    /// Submits the one-time code Anthropic's page shows the user, completing the attempt `login()`
    /// started. Never log the code. Throws on a thrown transport/RPC error OR on a well-formed
    /// `{ok:false}` reply (fix round 1: `ok:false` is a failure, not just a possible thrown error).
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

/// The stub's live implementation — every call routes through `WinterClient.request`, the same raw
/// JSON-RPC door every typed wrapper in `WinterClient+Methods.swift` is itself built on.
public final class LiveAnthropicAuthClient: AnthropicAuthClient, Sendable {
    private let client: WinterClient

    public init(client: WinterClient) {
        self.client = client
    }

    /// `provider.status` takes NO params (fix round 1: Lane O's final shape is `{}`, not
    /// `{provider:"anthropic"}`) and returns `{ anthropic: {...} }` directly — it's a status of
    /// every provider, keyed by name, not a per-provider query.
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

    /// `provider.login` returns `{ started: true, urlHint?: string }` (fix round 1, Lane O's final
    /// shape) — `started` carries no independent meaning here (a thrown error is still how a
    /// failed START surfaces); `urlHint`, when present, is sanitized (query/fragment stripped —
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

    public func loginUpdates() -> AsyncStream<AnthropicLoginEvent> {
        AsyncStream { continuation in
            let task = Task {
                for await ev in client.events {
                    if case .unknown(let raw) = ev, let parsed = Self.parse(raw) {
                        continuation.yield(parsed)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// `raw` is the full NDJSON line (`ServerMessage.unknownEvent(raw:)`'s own contract) — pulled
    /// back apart by hand rather than importing a `SessionEvent` case that doesn't exist yet.
    private static func parse(_ raw: String) -> AnthropicLoginEvent? {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let params = obj["params"] as? [String: Any],
              params["provider"] as? String == "anthropic",
              let type = params["type"] as? String
        else { return nil }
        switch type {
        case "provider_login_progress":
            guard let line = params["line"] as? String else { return nil }
            return .progress(line)
        case "provider_login_finished":
            guard let ok = params["ok"] as? Bool else { return nil }
            return .finished(ok: ok, reason: params["reason"] as? String)
        default:
            return nil
        }
    }
}
