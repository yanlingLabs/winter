import XCTest
import WinterProtocol
@testable import WinterChatKit

/// Winter Phase 10b amendment (c) — WS-19 Lane I, part A. `RemoteCredentialsRpc` over a scripted
/// `RpcConn`: no connection, no socket, no daemon.
///
/// The fixture-driven tests at the bottom are the PARITY half — they decode
/// `apple/fixtures/ws19-credential-list.json`, the same bytes
/// `apple/WinterKit/Tests/WinterKitTests/CredentialsDecoderParityTests.swift` drives through Lane
/// Q's `LiveCredentialsClient`, and assert the same rows. Two hand-written decoders on two legs of
/// the same RPC drift silently otherwise, and the way they drift is a row quietly disappearing from
/// one surface — i.e. a credential the user stored and can no longer see.
final class CredentialsRpcTests: XCTestCase {

    // MARK: - §9 A-4: a reply with no `providers` array is an ERROR, never an empty list

    /// The asymmetry the ruling turns on. "No credentials are stored" and "I could not read the
    /// reply" render identically if the second degrades into the first — and the harm is one-sided:
    /// a user shown a spuriously empty list concludes their keys are gone and re-enters them, which
    /// is a UI bug talking a person into handling their own secrets for no reason.
    func testAListReplyWithoutAProvidersArrayThrows() async throws {
        let conn = ScriptedCredentialsConn(["credential.list": ["{}"]])
        do {
            _ = try await RemoteCredentialsRpc(conn: conn).list()
            XCTFail("a reply with no `providers` array must throw, never answer []")
        } catch let error as CredentialsClientError {
            XCTAssertEqual(error, .malformedListReply)
        }
    }

    /// The same rule for a `providers` that is present but is not an array — the wrong TYPE is no
    /// more readable than a missing key.
    func testAListReplyWhoseProvidersIsNotAnArrayThrows() async throws {
        let conn = ScriptedCredentialsConn(["credential.list": [#"{"providers":"none"}"#]])
        do {
            _ = try await RemoteCredentialsRpc(conn: conn).list()
            XCTFail("a non-array `providers` must throw")
        } catch let error as CredentialsClientError {
            XCTAssertEqual(error, .malformedListReply)
        }
    }

    /// A genuinely empty inventory is NOT an error — `[]` is a claim the daemon itself made here,
    /// which is exactly what makes it safe to show.
    func testAnExplicitlyEmptyProvidersArrayIsNotAnError() async throws {
        let conn = ScriptedCredentialsConn(["credential.list": [#"{"providers":[]}"#]])

        let rows = try await RemoteCredentialsRpc(conn: conn).list()

        XCTAssertTrue(rows.isEmpty)
    }

    /// `credential.list` takes no params (W19-3): an empty OBJECT, not `null` and not a missing
    /// key. The daemon's zod schema is `z.object({})`, which a `null` fails.
    func testListSendsAnEmptyParamsObject() async throws {
        let conn = ScriptedCredentialsConn(["credential.list": [#"{"providers":[]}"#]])

        _ = try await RemoteCredentialsRpc(conn: conn).list()

        XCTAssertEqual(conn.calls.count, 1)
        XCTAssertEqual(conn.calls[0].method, "credential.list")
        XCTAssertEqual(String(decoding: conn.calls[0].paramsJSON, as: UTF8.self), "{}")
    }

    // MARK: - §9 A-4: one malformed row is SKIPPED, the rest still decode

    /// The other half of the ruling, and the opposite call for a reason: the surrounding rows are
    /// perfectly readable, so dropping the batch over one unknown shape from a newer daemon would
    /// hide credentials that are fine. Here the middle row is missing `displayName`.
    func testASingleMalformedRowIsSkippedAndTheOthersSurvive() async throws {
        let openai = #"{"providerId":"openai","displayName":"OpenAI","group":"provider","authKinds":["api-key"],"manageable":true,"present":true,"kind":"api-key","risk":"approved","door":"credential.set"}"#
        let broken = #"{"providerId":"broken","group":"provider","authKinds":["api-key"],"manageable":true,"present":false,"risk":"approved","door":"credential.set"}"#
        let deepseek = #"{"providerId":"deepseek","displayName":"DeepSeek","group":"provider","authKinds":["api-key"],"manageable":true,"present":false,"kind":"api-key","risk":"review-required","door":"credential.set"}"#
        let conn = ScriptedCredentialsConn(["credential.list": ["{\"providers\":[\(openai),\(broken),\(deepseek)]}"]])

        let rows = try await RemoteCredentialsRpc(conn: conn).list()

        XCTAssertEqual(rows.map(\.providerId), ["openai", "deepseek"], "the unreadable row is skipped; the readable ones are not")
        XCTAssertEqual(rows.first?.risk, "approved")
        XCTAssertEqual(rows.last?.risk, "review-required")
    }

    /// `kind` is genuinely optional (W19-3), so its absence must NOT be read as a malformed row —
    /// the distinction between "optional field missing" and "required field missing" is the thing
    /// that decides whether a real credential disappears from the list.
    func testAMissingOptionalKindDoesNotSkipTheRow() async throws {
        let exa = #"{"providerId":"exa","displayName":"Exa","group":"tool","authKinds":["api-key"],"manageable":true,"present":true,"risk":"approved","door":"credential.set"}"#
        let conn = ScriptedCredentialsConn(["credential.list": ["{\"providers\":[\(exa)]}"]])

        let rows = try await RemoteCredentialsRpc(conn: conn).list()

        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows.first?.kind)
        XCTAssertEqual(rows.first?.group, "tool")
    }

    /// The case between the two: rows were offered and NONE could be read. Skipping is only safe as
    /// a partial measure; with nothing left it becomes the empty list A-4 forbids, and the daemon
    /// had just said it holds credentials. On this leg it is also the likeliest shape of the
    /// failure — an App Store app meets daemons it is many releases behind, so a row-shape change
    /// arrives as every row failing at once rather than as one odd row.
    func testANonEmptyProvidersArrayWhereNoRowDecodesThrows() async throws {
        let broken = #"{"providerId":"broken","group":"provider","manageable":true,"present":true,"risk":"approved","door":"credential.set"}"#
        let conn = ScriptedCredentialsConn(["credential.list": ["{\"providers\":[\(broken),\(broken)]}"]])

        do {
            _ = try await RemoteCredentialsRpc(conn: conn).list()
            XCTFail("a non-empty providers array that decodes to nothing must throw, never answer []")
        } catch let error as CredentialsClientError {
            XCTAssertEqual(error, .malformedListReply)
        }
    }

    /// The same rule driven from the shared fixture, so the Mac side asserts it on identical bytes.
    func testTheAllMalformedSharedFixtureThrows() async throws {
        let fixture = try String(decoding: CredentialFixture.allMalformedListResult(), as: UTF8.self)
        let conn = ScriptedCredentialsConn(["credential.list": [fixture]])

        do {
            _ = try await RemoteCredentialsRpc(conn: conn).list()
            XCTFail("the all-malformed fixture must throw")
        } catch let error as CredentialsClientError {
            XCTAssertEqual(error, .malformedListReply)
        }
    }

    /// Per-slot rows (§9 A-1): `anthropic` twice, distinguished by `door`/`kind`. The composite `id`
    /// is what keeps a SwiftUI `ForEach` from collapsing them into one.
    func testTheTwoAnthropicSlotsDecodeAsTwoDistinctRows() async throws {
        let apiKeySlot = #"{"providerId":"anthropic","displayName":"Anthropic","group":"provider","authKinds":["api-key"],"manageable":true,"present":true,"kind":"api-key","risk":"approved","door":"credential.set"}"#
        let consoleSlot = #"{"providerId":"anthropic","displayName":"Anthropic (Console)","group":"provider","authKinds":["oauth"],"manageable":false,"present":true,"kind":"bearer","risk":"approved","door":"provider.login"}"#
        let conn = ScriptedCredentialsConn(["credential.list": ["{\"providers\":[\(apiKeySlot),\(consoleSlot)]}"]])

        let rows = try await RemoteCredentialsRpc(conn: conn).list()

        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.map(\.id)).count, 2)
        XCTAssertTrue(credentialRowOffersRemove(rows[0]), "the api-key slot is removable")
        XCTAssertFalse(credentialRowOffersRemove(rows[1]), "the console slot is not (A-3)")
    }

    // MARK: - §9 A-3: Remove is offered independently of `manageable`

    /// Codex OAuth is `manageable: false` — it cannot be SET from here, there is no key to paste —
    /// yet it is removable, because `credential.remove codex-oauth` clears the whole token pair.
    /// Keying the Remove button off `manageable` would strand those tokens on the Mac.
    func testCodexOAuthIsRemovableEvenThoughItIsNotManageable() {
        let codex = CredentialRow(
            providerId: "codex-oauth", displayName: "ChatGPT (Codex)", group: "provider",
            authKinds: ["oauth"], manageable: false, present: true, kind: "oauth",
            risk: "approved", door: "cli-oauth")

        XCTAssertTrue(credentialRowOffersRemove(codex))
    }

    /// Nothing stored, nothing to remove — the button would refuse on arrival (`removed:false`), so
    /// it is not offered.
    func testAnAbsentCredentialOffersNoRemove() {
        let deepseek = CredentialRow(
            providerId: "deepseek", displayName: "DeepSeek", group: "provider",
            authKinds: ["api-key"], manageable: true, present: false, kind: "api-key",
            risk: "review-required", door: "credential.set")

        XCTAssertFalse(credentialRowOffersRemove(deepseek))
    }

    // MARK: - set / remove wire shapes

    /// The key goes out verbatim under `apiKey`, and `{ok:true}` resolves without throwing.
    func testSetSendsProviderIdAndKeyAndSucceedsOnOkTrue() async throws {
        let conn = ScriptedCredentialsConn(["credential.set": [#"{"ok":true}"#]])

        try await RemoteCredentialsRpc(conn: conn).set(providerId: "deepseek", apiKey: "WS19-SENTINEL-phone")

        XCTAssertEqual(conn.calls.count, 1)
        XCTAssertEqual(conn.calls[0].method, "credential.set")
        let params = try XCTUnwrap(JSONSerialization.jsonObject(with: conn.calls[0].paramsJSON) as? [String: Any])
        XCTAssertEqual(params["providerId"] as? String, "deepseek")
        XCTAssertEqual(params["apiKey"] as? String, "WS19-SENTINEL-phone", "the key crosses the wire verbatim")
        XCTAssertEqual(params.count, 2, "no other field rides along with the key")
    }

    /// A well-formed `{ok:false}` is a FAILURE, not a quiet success — and the thrown message names
    /// only the method, so nothing derived from the key can reach a caller that renders it.
    func testSetOkFalseThrowsWithoutNamingTheValue() async throws {
        let conn = ScriptedCredentialsConn(["credential.set": [#"{"ok":false}"#]])

        do {
            try await RemoteCredentialsRpc(conn: conn).set(providerId: "deepseek", apiKey: "WS19-SENTINEL-phone")
            XCTFail("ok:false must throw")
        } catch let error as RpcError {
            XCTAssertFalse(error.message.contains("WS19-SENTINEL-phone"), "no thrown message may carry the key")
        }
    }

    /// `removed` is returned, not thrown on: `false` means nothing was stored, which is the
    /// post-state the caller asked for.
    func testRemoveReturnsTheRemovedFlag() async throws {
        for removed in [true, false] {
            let conn = ScriptedCredentialsConn(["credential.remove": ["{\"ok\":true,\"removed\":\(removed)}"]])

            let got = try await RemoteCredentialsRpc(conn: conn).remove(providerId: "deepseek")

            XCTAssertEqual(got, removed)
            XCTAssertEqual(conn.calls[0].method, "credential.remove")
            let params = try XCTUnwrap(JSONSerialization.jsonObject(with: conn.calls[0].paramsJSON) as? [String: Any])
            XCTAssertEqual(params["providerId"] as? String, "deepseek")
        }
    }

    /// A `removed` the daemon omitted reads as `false`, not as a failure: `ok:true` already said
    /// the operation succeeded, and the flag is only a report about the prior state.
    func testRemoveDefaultsToFalseWhenTheFlagIsAbsent() async throws {
        let conn = ScriptedCredentialsConn(["credential.remove": [#"{"ok":true}"#]])

        let got = try await RemoteCredentialsRpc(conn: conn).remove(providerId: "deepseek")

        XCTAssertFalse(got)
    }

    // MARK: - typed refusals (W19-4) travel in `error.data`, never in `message`

    /// The four §5 codes parse; `door` comes with the one that names a different door. This is the
    /// only way the phone can say "Anthropic Console is signed in from the Mac" instead of showing
    /// the daemon's prose.
    func testCredentialCodeAndDoorParseOutOfErrorData() {
        let refusal = RpcError(
            code: -32602, message: "anthropic:console is bearer-only",
            data: ["code": .string("credential_kind_unsupported"), "door": .string("provider.login")])

        XCTAssertEqual(refusal.credentialCode, .kindUnsupported)
        XCTAssertEqual(refusal.credentialDoor, "provider.login")
    }

    func testEveryDocumentedCredentialCodeParses() {
        let expected: [String: CredentialRpcCode] = [
            "credential_provider_unknown": .providerUnknown,
            "credential_kind_unsupported": .kindUnsupported,
            "credential_value_invalid": .valueInvalid,
            "credential_store_unavailable": .storeUnavailable,
        ]
        for (raw, code) in expected {
            XCTAssertEqual(RpcError(code: -32602, message: "x", data: ["code": .string(raw)]).credentialCode, code, raw)
        }
    }

    /// A code this build has never heard of degrades to `nil` — "something went wrong" — rather
    /// than to a crash. The daemon's vocabulary grows without an App Store release.
    func testAnUnknownCodeAndAnAbsentDataBothReadAsNil() {
        XCTAssertNil(RpcError(code: -32602, message: "x", data: ["code": .string("credential_future_code")]).credentialCode)
        XCTAssertNil(RpcError(code: -32602, message: "x").credentialCode)
        XCTAssertNil(RpcError(code: -32602, message: "x").credentialDoor)
    }

    /// The pre-existing `ERR.DIVERGED` path is untouched by the new `data` member: `SyncClient`
    /// reads `divergedLastSeq` and nothing else, and a fork decision must not start depending on
    /// whether a conn happened to forward `data`.
    func testTheDivergedFieldStillWorksWithoutData() {
        let diverged = RpcError(code: ERR_DIVERGED, message: "baseSeq mismatch", divergedLastSeq: 7)

        XCTAssertEqual(diverged.divergedLastSeq, 7)
        XCTAssertNil(diverged.data)
    }

    // MARK: - PARITY with Lane Q's Mac decoder (the shared fixture)

    /// Decodes `apple/fixtures/ws19-credential-list.json` and pins every field of every surviving
    /// row. `CredentialsDecoderParityTests` (WinterKitTests) asserts the identical table through
    /// `LiveCredentialsClient`, so any divergence between the two decoders fails one side.
    func testTheSharedFixtureDecodesToTheAgreedRows() async throws {
        let fixture = try String(decoding: CredentialFixture.listResult(), as: UTF8.self)
        XCTAssertFalse(fixture.trimmingCharacters(in: .whitespacesAndNewlines).contains("\n"),
                       "the fixture must stay SINGLE-LINE — the Mac side feeds it as one NDJSON frame")
        let conn = ScriptedCredentialsConn(["credential.list": [fixture]])

        let rows = try await RemoteCredentialsRpc(conn: conn).list()

        XCTAssertEqual(rows.map(\.id), CredentialFixture.expectedIDs)
        XCTAssertEqual(rows.map(\.displayName), CredentialFixture.expectedDisplayNames)
        XCTAssertEqual(rows.map(\.group), CredentialFixture.expectedGroups)
        XCTAssertEqual(rows.map(\.authKinds), CredentialFixture.expectedAuthKinds)
        XCTAssertEqual(rows.map(\.manageable), CredentialFixture.expectedManageable)
        XCTAssertEqual(rows.map(\.present), CredentialFixture.expectedPresent)
        XCTAssertEqual(rows.map(\.risk), CredentialFixture.expectedRisks)
        XCTAssertEqual(rows.map(credentialRowOffersRemove), CredentialFixture.expectedOffersRemove)
    }
}

// ------------------------------------------------------------------------------------------------
// Test doubles and the shared fixture locator.
// ------------------------------------------------------------------------------------------------

/// A scripted `RpcConn`: records every call, answers from a per-method queue of raw result JSON.
///
/// Every scripted reply is a SINGLE LINE, deliberately. This seam is byte-in/byte-out and would
/// tolerate a pretty-printed one, but the Mac side of the parity pair feeds the same bytes through
/// an NDJSON transport where a real newline is not one frame but several unparseable ones — a
/// failure that shows up as a 5s timeout with no decoding error to read.
final class ScriptedCredentialsConn: RpcConn, @unchecked Sendable {
    struct Call {
        let method: String
        let paramsJSON: Data
    }

    private let lock = NSLock()
    private var replies: [String: [String]]
    private var _calls: [Call] = []
    var calls: [Call] { lock.lock(); defer { lock.unlock() }; return _calls }

    init(_ replies: [String: [String]]) {
        self.replies = replies
    }

    func call(method: String, paramsJSON: Data) async throws -> Data {
        lock.lock()
        _calls.append(Call(method: method, paramsJSON: paramsJSON))
        let next = replies[method]?.first
        if next != nil { replies[method]?.removeFirst() }
        lock.unlock()
        guard let next else {
            throw RpcError(code: -32601, message: "no scripted reply for \(method)")
        }
        return Data(next.utf8)
    }
}

/// Locates the cross-kit credential fixture at `<repo>/apple/fixtures/`.
///
/// Read straight from the repo rather than copied into either package, the same habit
/// `ParityFixtures` established one directory over: a copy is a second source of truth that goes
/// stale the moment one side edits it, which is the exact drift this fixture exists to catch.
/// SwiftPM resource bundling could not carry it anyway — the file lives outside both test targets
/// on purpose, so neither kit owns it.
enum CredentialFixture {
    static func listResult() throws -> Data { try load("ws19-credential-list.json") }

    /// The companion fixture for the all-rows-unreadable case: three rows, each missing a different
    /// REQUIRED field (no `providerId`, no `displayName`, a `manageable` of the wrong type).
    static func allMalformedListResult() throws -> Data { try load("ws19-credential-list-all-malformed.json") }

    private static func load(_ name: String) throws -> Data {
        // #filePath == <repo>/apple/WinterChatKit/Tests/WinterChatKitTests/CredentialsRpcTests.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 4 { url.deleteLastPathComponent() } // file, WinterChatKitTests, Tests, WinterChatKit → <repo>/apple
        return try Data(contentsOf: url.appending(path: "fixtures/\(name)"))
    }

    /// The agreed decode of that fixture — the table BOTH decoders must produce. Its interesting
    /// entries: `anthropic` twice (A-1, kept apart only by the composite id), a tool row with no
    /// `kind`, a row missing `displayName` that is SKIPPED, a row with no `authKinds` at all
    /// (`[]`, not a skip), and a row whose `authKinds` holds a non-string element (dropped, not a
    /// skip) — the last two being exactly where a synthesized `Decodable` would throw the row away.
    static let expectedIDs = [
        "openai|credential.set|api-key",
        "anthropic|credential.set|api-key",
        "anthropic|provider.login|bearer",
        "exa|credential.set|",
        "deepseek|credential.set|api-key",
        "zai|credential.set|api-key",
        "openrouter|credential.set|api-key",
        "codex-oauth|cli-oauth|oauth",
    ]
    static let expectedDisplayNames = [
        "OpenAI", "Anthropic", "Anthropic (Console)", "Exa", "DeepSeek", "Z.ai", "OpenRouter", "ChatGPT (Codex)",
    ]
    static let expectedGroups = ["provider", "provider", "provider", "tool", "provider", "provider", "provider", "provider"]
    static let expectedAuthKinds = [
        ["api-key"], ["api-key"], ["oauth"], ["api-key"], ["api-key"], [], ["api-key"], ["oauth"],
    ]
    static let expectedManageable = [true, true, false, true, true, true, true, false]
    static let expectedPresent = [true, true, true, true, false, false, true, true]
    static let expectedRisks = [
        "approved", "approved", "approved", "approved", "review-required", "review-required", "review-required", "approved",
    ]
    /// A-3: present && door != "provider.login" — so the console slot is out, the absent rows are
    /// out, and Codex is IN despite `manageable: false`.
    static let expectedOffersRemove = [true, true, false, true, false, false, true, true]
}
