import Foundation

// -----------------------------------------------------------------------------------------------
// Winter Phase 10b amendment (c) — WS-19 "provider credentials", Lane Q (the Swift half).
//
// The daemon's credential inventory is DERIVED from the agent SDK's catalog (WS-19 W19-1), so the
// set of rows this client sees is not a constant any Swift code may mirror: it grows when the SDK's
// catalog grows, with no app release in between. Everything here is therefore shaped as "render
// whatever the daemon sent", never "know which providers exist".
//
// Same seam posture as `AnthropicAuthClient.swift` beside this file, and for the same reason: the
// protocol exists so `CredentialsSectionModel`
// (`apple/Winter/Sources/Dashboard/panes/CredentialsSection.swift`) is unit-testable against a
// hand-written fake with no socket/transport involved, and `LiveCredentialsClient` is its thin
// production implementation over `WinterClient.request`. There is still no generated Swift type for
// an RPC METHOD's result (`WinterProtocol` mirrors `SessionEvent` variants only) — so `list()`
// hand-decodes its `JSONValue`, exactly like every other method wrapper in this kit.
//
// SECRET DISCIPLINE (WS-19 §2 standing ruling, W19-4). The API key crosses this file exactly once,
// as `set(providerId:apiKey:)`'s argument, straight into the request params. It is never stored on
// this type, never logged, never interpolated into an error, and never returned by any call:
// `credential.list`'s rows carry names and booleans only — never a value, never a fragment, never a
// length — and `credential.set`'s own refusals are typed codes, not echoes. A conforming
// implementation that put the key into an error's `message` would defeat W19-14's sweep, since a
// thrown `RpcError`'s description is exactly what a view tends to render.
// -----------------------------------------------------------------------------------------------

/// One row of `credential.list` (WS-19 §5 `CredentialRow`).
///
/// `group`, `kind`, `risk` and `door` are deliberately plain `String`s rather than closed Swift
/// enums. The `door` vocabulary is exactly the three §5 values today (WS-19 §9 A-1 withdrew the
/// fourth, `"provider.logout"`, which an earlier draft had a remove-side refusal carry), but the
/// INVENTORY those values describe is catalog-derived (W19-1): it grows with an agent-SDK bump and
/// no app release, so a newer daemon paired with an older app is the NORMAL state here, not an edge
/// case. A closed enum turns "a value I don't know" into "a row I drop" — the worst possible
/// failure for a credentials list, since a stored key would simply be invisible. `risk` is the
/// live example of the direction this moves in: it exists so a LATER UI can badge a row, and its
/// vocabulary is the daemon's to extend.
///
/// `id` is a COMPOSITE, not `providerId`. WS-19 §9 A-1 makes this load-bearing rather than
/// defensive: rows are emitted per SLOT, so `anthropic` appears TWICE — once for `anthropic:default`
/// (`door: "credential.set"`, manageable) and once for `anthropic:console`
/// (`door: "provider.login"`, not manageable) — and A-1 names `providerId|door|kind` as the key
/// clients use. A `ForEach` keyed on `providerId` alone would collide, and SwiftUI would render one
/// row and drop the other, silently.
public struct CredentialRow: Equatable, Sendable, Identifiable {
    /// The provider's id as the daemon knows it (`openai`, `anthropic`, `deepseek`, …). Also the
    /// value `credential.set`/`credential.remove` take — never a display name.
    public let providerId: String
    public let displayName: String
    /// `"provider"` | `"tool"` — the two daemon tool keys (Exa, web search) group separately.
    public let group: String
    public let authKinds: [String]
    /// True exactly for the rows `credential.set`/`credential.remove` accept (W19-3): the api-key
    /// providers and the two tool rows. False for the OAuth doors, which keep their bespoke flows.
    public let manageable: Bool
    /// Whether material is stored right now. A boolean, never a length or a fragment.
    public let present: Bool
    /// `"api-key"` | `"oauth"` | `"bearer"`, absent when the daemon didn't say.
    public let kind: String?
    /// `"approved"` | `"review-required"` — carried so a later UI can badge it (WS-19 §7). This
    /// unstyled section does not.
    public let risk: String
    /// Where the user goes to change this credential: `"credential.set"` (this client),
    /// `"provider.login"` (the Anthropic section's own controls), `"cli-oauth"` (`winter login`).
    public let door: String

    public var id: String { "\(providerId)|\(door)|\(kind ?? "")" }

    public init(
        providerId: String,
        displayName: String,
        group: String,
        authKinds: [String],
        manageable: Bool,
        present: Bool,
        kind: String?,
        risk: String,
        door: String
    ) {
        self.providerId = providerId
        self.displayName = displayName
        self.group = group
        self.authKinds = authKinds
        self.manageable = manageable
        self.present = present
        self.kind = kind
        self.risk = risk
        self.door = door
    }
}

/// The four typed refusals `credential.set`/`credential.remove` can carry in `error.data.code`
/// (WS-19 §5). Mirrors `HandoffRpcCode`'s posture exactly (`ServerMessage.swift`): a closed enum is
/// safe HERE — unlike `CredentialRow`'s fields — because `credentialCode` answers `nil` for
/// anything it doesn't recognise, and every caller already has a generic-failure branch. A code
/// this build has never heard of degrades to "something went wrong", never to a crash or a drop.
public enum CredentialRpcCode: String, Equatable, Sendable {
    case providerUnknown = "credential_provider_unknown"
    case kindUnsupported = "credential_kind_unsupported"
    case valueInvalid = "credential_value_invalid"
    case storeUnavailable = "credential_store_unavailable"
}

extension RpcError {
    /// `nil` for every error that isn't one of the four WS-19 codes — including a plain
    /// `INVALID_PARAMS` with no `data` at all. Switch on this rather than string-matching
    /// `message`; `message` is daemon prose and must never be shown for a credential operation
    /// (secret discipline: a view that renders `message` renders whatever the daemon happened to
    /// put there).
    public var credentialCode: CredentialRpcCode? {
        guard let raw = data?["code"]?.stringValue else { return nil }
        return CredentialRpcCode(rawValue: raw)
    }

    /// `error.data.door` — the door a `credential_kind_unsupported` refusal names
    /// (`"provider.login"` for the Anthropic console arm, `"cli-oauth"` for Codex; W19-4). A raw
    /// string for the same reason `CredentialRow.door` is: the vocabulary is the daemon's, and it
    /// has already moved once (WS-19 §9 A-1 withdrew `"provider.logout"` from it).
    public var credentialDoor: String? { data?["door"]?.stringValue }
}

/// Failures that are this CLIENT's own reading of a reply, rather than something the daemon
/// refused. Separate from `RpcError` on purpose: an `RpcError` means the daemon answered "no" and
/// said why, while this means the daemon answered something this client could not make sense of.
public enum CredentialsClientError: Error, Equatable, Sendable {
    /// `credential.list` returned a result with no `providers` array — or a non-empty one from
    /// which not a single row could be read (WS-19 §9 A-4).
    ///
    /// This is a THROW rather than an empty list, and the distinction is the whole point of the
    /// ruling: "no credentials are stored" and "I could not read the reply" look identical on
    /// screen if the second degrades into the first, and the harm is asymmetric. A user shown a
    /// spuriously empty list concludes their keys are gone and re-enters them — the one situation
    /// where a UI bug turns into the user handling their own secrets unnecessarily.
    case malformedListReply
}

/// The app's one seam onto the three WS-19 credential RPCs. `CredentialsSectionModel` depends on
/// THIS protocol, never on `WinterClient` directly.
///
/// Errors are thrown as-is — a `LiveCredentialsClient` never re-wraps an `RpcError` into some
/// richer app error, so `credentialCode`/`credentialDoor` reach the view intact and no new string
/// is minted along the way that could carry a value.
public protocol CredentialsClient: Sendable {
    /// Every credential slot the daemon knows, present or not. A live read on every call (W19-3) —
    /// never a cached boot snapshot, so a key added from the phone or the CLI shows up on the next
    /// refresh with no restart. Throws rather than answering `[]` when the reply cannot be read at
    /// all (`CredentialsClientError.malformedListReply`, WS-19 §9 A-4): an empty list is a claim
    /// about the user's keys, and must only ever be made when the daemon actually made it.
    func list() async throws -> [CredentialRow]
    /// Stores `apiKey` as `providerId`'s material. Throws on transport/RPC failure OR on a
    /// well-formed `{ok:false}` reply. The key is never echoed back, in a result or an error.
    func set(providerId: String, apiKey: String) async throws
    /// Deletes `providerId`'s material. Returns whether anything was actually stored — `false` is a
    /// SUCCESS (nothing to remove), not a failure, so it is a return value rather than a throw.
    func remove(providerId: String) async throws -> Bool
}

/// The production implementation — every call routes through `WinterClient.request`, the same raw
/// JSON-RPC door `LiveAnthropicAuthClient` uses.
public final class LiveCredentialsClient: CredentialsClient, Sendable {
    private let client: WinterClient

    public init(client: WinterClient) {
        self.client = client
    }

    /// `credential.list` takes no params and returns `{ providers: Row[] }`.
    ///
    /// The two malformed-input cases are deliberately asymmetric (WS-19 §9 A-4). A reply with NO
    /// `providers` array throws — the client could not read the reply at all, and reporting that as
    /// "no credentials stored" would tell a user their keys are gone. A SINGLE unreadable row is
    /// skipped — the other rows are perfectly good, and one unknown shape from a newer daemon must
    /// not blank the whole section. `kind` is genuinely optional (W19-3) and so is never a reason
    /// to skip; `authKinds` defaults to empty since it is display-only here.
    ///
    /// The THIRD case sits between them and lands on A-4's side: a NON-EMPTY `providers` array in
    /// which not one row decodes. Skipping is only ever safe as a partial measure — "some rows I
    /// could not read, here are the ones I could" — and when there are none left it silently becomes
    /// the empty list the ruling exists to forbid. The daemon said it had credentials; answering
    /// `[]` would repaint that as "you have none", which is exactly the screen that talks a user
    /// into re-entering keys they never lost. A wholesale shape change (a schema bump, a relay that
    /// rewrites rows) is precisely what produces this, so it is a likely failure, not a theoretical
    /// one. An EXPLICITLY empty array stays an empty list: that is a claim the daemon itself made.
    public func list() async throws -> [CredentialRow] {
        let r = try await client.request("credential.list", params: .object([:]))
        guard let rows = r["providers"]?.arrayValue else {
            throw CredentialsClientError.malformedListReply
        }
        let decoded = rows.compactMap(Self.decodeRow)
        guard !decoded.isEmpty || rows.isEmpty else {
            throw CredentialsClientError.malformedListReply
        }
        return decoded
    }

    /// One row, or `nil` when a field W19-3 makes REQUIRED is missing or the wrong type. Mirrored
    /// line for line by `WinterChatKit.RemoteCredentialsRpc.decodeRow` — the phone cannot link this
    /// kit, so `apple/fixtures/ws19-credential-list.json` is decoded by both test suites against one
    /// expected table to keep the two from drifting.
    static func decodeRow(_ row: JSONValue) -> CredentialRow? {
        guard let providerId = row["providerId"]?.stringValue,
              let displayName = row["displayName"]?.stringValue,
              let group = row["group"]?.stringValue,
              let manageable = row["manageable"]?.boolValue,
              let present = row["present"]?.boolValue,
              let risk = row["risk"]?.stringValue,
              let door = row["door"]?.stringValue
        else { return nil }
        return CredentialRow(
            providerId: providerId,
            displayName: displayName,
            group: group,
            authKinds: row["authKinds"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            manageable: manageable,
            present: present,
            kind: row["kind"]?.stringValue,
            risk: risk,
            door: door
        )
    }

    /// `credential.set` → `{ ok: true }`. The key goes into the params and nowhere else: this
    /// method holds no reference to it after the call, and the `{ok:false}` guard below deliberately
    /// mints a message that names only the METHOD (same wording shape as
    /// `LiveAnthropicAuthClient.submitLoginCode`) — never the provider's value, never its length.
    public func set(providerId: String, apiKey: String) async throws {
        let r = try await client.request("credential.set", params: .object([
            "providerId": .string(providerId), "apiKey": .string(apiKey),
        ]))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "credential.set returned ok:false")
        }
    }

    /// `credential.remove` → `{ ok: true, removed: boolean }`. `removed:false` (nothing was stored)
    /// is returned, not thrown — only `ok:false` is a failure.
    public func remove(providerId: String) async throws -> Bool {
        let r = try await client.request("credential.remove", params: .object([
            "providerId": .string(providerId),
        ]))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "credential.remove returned ok:false")
        }
        return r["removed"]?.boolValue ?? false
    }
}
