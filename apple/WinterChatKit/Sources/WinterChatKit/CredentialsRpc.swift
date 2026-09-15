import Foundation
import WinterProtocol

// ================================================================================================
// Winter Phase 10b amendment (c) — WS-19 "provider credentials", Lane I (the iOS half).
//
// The phone half of the same three RPCs Lane Q wrapped for the Mac
// (`apple/WinterKit/Sources/WinterKit/CredentialsClient.swift`): `credential.list`,
// `credential.set`, `credential.remove` (WS-19 W19-3/4/5, remote-allowed by W19-10).
//
// WHY THIS IS A SECOND COPY RATHER THAN A SHARED ONE. The phone links exactly three SPM products
// off the repo's root umbrella manifest — `WinterProtocol`, `WinterSessionKit` and
// `WinterChatKit` — and `WinterKit` is not among them: it is the MAC's kit (Unix-socket transport,
// the Gateway, `WinterClient`), and Lane Q's client is built on `WinterClient.request`, a door that
// does not exist on this side of the wire. The phone's door is `RpcConn` (declared in
// `SyncClient.swift` beside this file): one byte-in/byte-out method the app implements over the
// paired iroh connection it already has. So the two clients cannot share an implementation without
// dragging Mac-only code onto the phone; what they CAN share is their reading of the wire, and
// `apple/fixtures/ws19-credential-list.json` is decoded by BOTH test suites against the same
// expectations so the two decoders cannot drift apart silently.
//
// The decoder below is therefore a DELIBERATE line-by-line mirror of Lane Q's, including its
// leniencies: `authKinds` missing or holding a non-string is NOT a reason to drop a row, `kind` is
// genuinely optional, and only the seven fields W19-3 makes required can unread a row. A
// synthesized `Decodable` would diverge on every one of those (it throws where Lane Q shrugs), and
// a row thrown away here is a stored credential the user cannot see — which is why this decodes
// through `SessionEvent.JSONValue` and applies the same accessors by hand.
//
// SECRET DISCIPLINE (WS-19 §2 standing ruling, W19-4, and W19-10 for this leg specifically). The
// API key crosses this file exactly once, as `set(providerId:apiKey:)`'s argument, straight into
// the request params and over the phone's existing encrypted channel. It is never stored on this
// type, never written to the phone's Keychain or `UserDefaults`, never logged, never interpolated
// into an error, and never returned by any call: `credential.list`'s rows carry names and booleans
// only — never a value, never a fragment, never a length.
// ================================================================================================

/// One row of `credential.list` (WS-19 §5 `CredentialRow`). Field-for-field identical to
/// `WinterKit.CredentialRow`.
///
/// `group`, `kind`, `risk` and `door` are plain `String`s, not closed Swift enums, and that is
/// load-bearing rather than lazy: the inventory these values describe is DERIVED from the agent
/// SDK's catalog (W19-1), so it grows with a daemon update and no app release — and an App Store
/// app updates on its own slower schedule, making "a newer daemon paired with an older app" the
/// NORMAL state on this leg, not an edge case. A closed enum turns "a value I don't know" into "a
/// row I drop", which for a credentials list means a stored key that is simply invisible.
///
/// `id` is a COMPOSITE, not `providerId` (WS-19 §9 A-1): rows are emitted per SLOT, so `anthropic`
/// appears TWICE — once for `anthropic:default` (`door: "credential.set"`, manageable) and once for
/// `anthropic:console` (`door: "provider.login"`, not manageable). A SwiftUI `ForEach` keyed on
/// `providerId` alone would collide and render one of the two, silently.
public struct CredentialRow: Equatable, Sendable, Identifiable {
    /// The provider's id as the daemon knows it (`openai`, `anthropic`, `deepseek`, …). Also the
    /// value `credential.set`/`credential.remove` take — never a display name.
    public let providerId: String
    public let displayName: String
    /// `"provider"` | `"tool"` — the two daemon tool keys (Exa, web search) group separately.
    public let group: String
    public let authKinds: [String]
    /// True exactly for the rows `credential.set` accepts (W19-3): the api-key providers and the
    /// two tool rows. It governs SET ONLY — see `credentialRowOffersRemove` for the other half.
    public let manageable: Bool
    /// Whether material is stored right now. A boolean, never a length or a fragment.
    public let present: Bool
    /// `"api-key"` | `"oauth"` | `"bearer"`, absent when the daemon didn't say.
    public let kind: String?
    /// `"approved"` | `"review-required"` — carried so a later UI can badge it (WS-19 §7).
    public let risk: String
    /// Where the user goes to change this credential: `"credential.set"` (this client),
    /// `"provider.login"` (the Mac's Anthropic sign-in controls), `"cli-oauth"` (`winter login`).
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

/// Whether a client offers a Remove control for this row (WS-19 §9 A-3).
///
/// `manageable` is NOT the test, and the difference is not cosmetic: A-3 rules that removal is
/// offered independently of it, so the Codex OAuth row (`manageable: false`, `door: "cli-oauth"`)
/// CAN be removed from the phone — `credential.remove codex-oauth` clears the whole token pair —
/// while the Anthropic console arm can only be signed out through its own door and so is excluded
/// by `door != "provider.login"`. Copied verbatim from the Mac's helper of the same name
/// (`apple/Winter/Sources/Dashboard/panes/CredentialsSection.swift`) so the two surfaces offer the
/// same buttons for the same rows.
public func credentialRowOffersRemove(_ row: CredentialRow) -> Bool {
    row.present && row.door != "provider.login"
}

/// The four typed refusals `credential.set`/`credential.remove` can carry in `error.data.code`
/// (WS-19 §5). A closed enum is safe HERE — unlike `CredentialRow`'s fields — because
/// `credentialCode` answers `nil` for anything it doesn't recognise and every caller already needs
/// a generic-failure branch, so a code this build has never heard of degrades to "something went
/// wrong" rather than to a crash or a dropped row.
public enum CredentialRpcCode: String, Equatable, Sendable {
    case providerUnknown = "credential_provider_unknown"
    case kindUnsupported = "credential_kind_unsupported"
    case valueInvalid = "credential_value_invalid"
    case storeUnavailable = "credential_store_unavailable"
}

extension RpcError {
    /// `nil` for every error that isn't one of the four WS-19 codes — including a refusal that
    /// arrived with no `data` at all (an older daemon, or a Gateway hop that dropped it).
    ///
    /// Switch on this rather than string-matching `message`: `message` is daemon prose and must
    /// never be rendered for a credential operation, because a view that renders it renders
    /// whatever the daemon happened to put there.
    public var credentialCode: CredentialRpcCode? {
        guard let raw = data?["code"]?.credentialString else { return nil }
        return CredentialRpcCode(rawValue: raw)
    }

    /// `error.data.door` — the door a `credential_kind_unsupported` refusal names
    /// (`"provider.login"` for the Anthropic console arm, `"cli-oauth"` for Codex; W19-4). A raw
    /// string for the same reason `CredentialRow.door` is: the vocabulary is the daemon's, and it
    /// has already moved once (WS-19 §9 A-1 withdrew `"provider.logout"` from it).
    public var credentialDoor: String? { data?["door"]?.credentialString }
}

/// Failures that are this CLIENT's own reading of a reply, rather than something the daemon
/// refused. Separate from `RpcError` on purpose: an `RpcError` means the daemon answered "no" and
/// said why, while this means the daemon answered something this client could not make sense of.
public enum CredentialsClientError: Error, Equatable, Sendable {
    /// `credential.list` returned a result with no `providers` array — or a non-empty one from
    /// which not a single row could be read (WS-19 §9 A-4).
    ///
    /// A THROW rather than an empty list, and the distinction is the whole point of the ruling:
    /// "no credentials are stored" and "I could not read the reply" look identical on screen if the
    /// second degrades into the first, and the harm is asymmetric. A user shown a spuriously empty
    /// list concludes their keys are gone and re-enters them — a UI bug talking a person into
    /// handling their own secrets for no reason.
    case malformedListReply
}

/// The phone's one seam onto the three WS-19 credential RPCs. A view model depends on THIS
/// protocol, never on a transport, so it is testable against a hand-written fake with no connection
/// in the loop. Mirrors `WinterKit.CredentialsClient` method for method.
public protocol CredentialsRpc: Sendable {
    /// Every credential slot the daemon knows, present or not. A live read on every call (W19-3) —
    /// never a cached snapshot, so a key added on the Mac or the CLI shows up on the next refresh
    /// with no restart anywhere. Throws rather than answering `[]` when the reply cannot be read at
    /// all (`CredentialsClientError.malformedListReply`, §9 A-4).
    func list() async throws -> [CredentialRow]
    /// Stores `apiKey` as `providerId`'s material ON THE MAC. Throws on transport/RPC failure OR on
    /// a well-formed `{ok:false}` reply. The key is never echoed back, in a result or an error.
    func set(providerId: String, apiKey: String) async throws
    /// Deletes `providerId`'s material. Returns whether anything was actually stored — `false` is a
    /// SUCCESS (nothing to remove), not a failure, so it is a return value rather than a throw.
    func remove(providerId: String) async throws -> Bool
}

/// The production implementation — every call goes through the app's `RpcConn`, i.e. over the
/// phone's existing paired connection (`PhoneRpcConn` → `WinterSessionClient.send`). It owns no
/// transport and no state beyond that one reference.
public struct RemoteCredentialsRpc: CredentialsRpc, Sendable {
    private let conn: RpcConn

    public init(conn: RpcConn) {
        self.conn = conn
    }

    /// `credential.list` takes no params and returns `{ providers: Row[] }`.
    ///
    /// The two malformed-input cases are deliberately asymmetric (WS-19 §9 A-4). A reply with NO
    /// `providers` array throws — the client could not read the reply at all, and reporting that as
    /// "no credentials stored" would tell a user their keys are gone. A SINGLE unreadable row is
    /// skipped — the other rows are perfectly good, and one unknown shape from a newer daemon must
    /// not blank the whole section.
    ///
    /// The THIRD case sits between them and lands on A-4's side: a NON-EMPTY `providers` array in
    /// which not one row decodes. Skipping is only ever safe as a partial measure — "some rows I
    /// could not read, here are the ones I could" — and when there are none left it silently becomes
    /// the empty list the ruling exists to forbid. The daemon said it had credentials; answering
    /// `[]` would repaint that as "you have none", the screen that talks a user into re-entering
    /// keys they never lost. It is also the most likely way this breaks on THIS leg specifically: an
    /// App Store app meets daemons it is many releases behind, so a wholesale row-shape change lands
    /// here as every row failing at once, not as one odd row. An EXPLICITLY empty array stays an
    /// empty list — that is a claim the daemon itself made. Mirrored in
    /// `WinterKit.LiveCredentialsClient.list`.
    public func list() async throws -> [CredentialRow] {
        let raw = try await conn.call(method: METHODS.credentialList, paramsJSON: encode(CredentialListParams()))
        let result = try JSONDecoder().decode(SessionEvent.JSONValue.self, from: raw)
        guard let rows = result["providers"]?.credentialArray else {
            throw CredentialsClientError.malformedListReply
        }
        let decoded = rows.compactMap(Self.decodeRow)
        guard !decoded.isEmpty || rows.isEmpty else {
            throw CredentialsClientError.malformedListReply
        }
        return decoded
    }

    /// One row, or `nil` when a field W19-3 makes REQUIRED is missing or the wrong type.
    ///
    /// `kind` is optional on the wire and so is never a reason to skip. `authKinds` is display-only
    /// here, so a missing array becomes `[]` and a non-string element is dropped rather than
    /// unreading the row — matching Lane Q's `?? []` / `compactMap(\.stringValue)` exactly. Both
    /// leniencies are pinned by the shared fixture (`apple/fixtures/ws19-credential-list.json`).
    static func decodeRow(_ row: SessionEvent.JSONValue) -> CredentialRow? {
        guard let providerId = row["providerId"]?.credentialString,
              let displayName = row["displayName"]?.credentialString,
              let group = row["group"]?.credentialString,
              let manageable = row["manageable"]?.credentialBool,
              let present = row["present"]?.credentialBool,
              let risk = row["risk"]?.credentialString,
              let door = row["door"]?.credentialString
        else { return nil }
        return CredentialRow(
            providerId: providerId,
            displayName: displayName,
            group: group,
            authKinds: row["authKinds"]?.credentialArray?.compactMap(\.credentialString) ?? [],
            manageable: manageable,
            present: present,
            kind: row["kind"]?.credentialString,
            risk: risk,
            door: door
        )
    }

    /// `credential.set` → `{ ok: true }`. The key goes into the params and nowhere else: this
    /// method holds no reference to it after the call, and the `{ok:false}` guard below mints a
    /// message that names only the METHOD — never the provider's value, never its length.
    public func set(providerId: String, apiKey: String) async throws {
        let raw = try await conn.call(
            method: METHODS.credentialSet,
            paramsJSON: encode(CredentialSetParams(providerId: providerId, apiKey: apiKey))
        )
        let result = try JSONDecoder().decode(SessionEvent.JSONValue.self, from: raw)
        guard result["ok"]?.credentialBool == true else {
            throw RpcError(code: ERR_INTERNAL, message: "credential.set returned ok:false")
        }
    }

    /// `credential.remove` → `{ ok: true, removed: boolean }`. `removed:false` (nothing was stored)
    /// is returned, not thrown — only `ok:false` is a failure.
    public func remove(providerId: String) async throws -> Bool {
        let raw = try await conn.call(
            method: METHODS.credentialRemove,
            paramsJSON: encode(CredentialRemoveParams(providerId: providerId))
        )
        let result = try JSONDecoder().decode(SessionEvent.JSONValue.self, from: raw)
        guard result["ok"]?.credentialBool == true else {
            throw RpcError(code: ERR_INTERNAL, message: "credential.remove returned ok:false")
        }
        return result["removed"]?.credentialBool ?? false
    }

    /// Params are tiny closed shapes, so unlike the result path they get a plain `Encodable`. An
    /// encode failure is not reachable for `String`-only structs; `{}` is the only sane floor and
    /// is exactly what `credential.list` wants anyway.
    private func encode<T: Encodable>(_ value: T) -> Data { (try? JSONEncoder().encode(value)) ?? Data("{}".utf8) }
}

// ------------------------------------------------------------------------------------------------
// Wire params (packages/protocol/src/methods.ts — WS-19 §5).
// ------------------------------------------------------------------------------------------------

private struct CredentialListParams: Encodable {}

private struct CredentialSetParams: Encodable {
    let providerId: String
    /// The user's key, verbatim and exactly once. `Encodable` rather than a hand-built dictionary
    /// so there is no string interpolation anywhere near it.
    let apiKey: String
}

private struct CredentialRemoveParams: Encodable {
    let providerId: String
}

// ------------------------------------------------------------------------------------------------
// JSON accessors.
//
// `WinterProtocol.SessionEvent.JSONValue` ships no ergonomic accessors, and `WinterSessionKit`
// already declares a set of PUBLIC ones (`stringValue`, `boolValue`, `subscript`, … in
// `SessionModels.swift`). The iOS app imports BOTH that module and this one, so declaring public
// accessors of the same names here would make every call site in the app ambiguous. These are
// `fileprivate` (a `private extension`'s members) and distinctly named for that reason: invisible
// outside this file, and impossible to confuse with the kit's own set inside it.
// ------------------------------------------------------------------------------------------------

private extension SessionEvent.JSONValue {
    subscript(key: String) -> SessionEvent.JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var credentialString: String? { if case .string(let s) = self { return s }; return nil }
    var credentialBool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var credentialArray: [SessionEvent.JSONValue]? { if case .array(let a) = self { return a }; return nil }
}
