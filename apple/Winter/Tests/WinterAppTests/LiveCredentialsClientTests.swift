import XCTest
import WinterKit
@testable import Winter

/// Winter Phase 10b amendment (c), WS-19 §9 A-4: `LiveCredentialsClient`'s WIRE-level decoding —
/// the half `FakeCredentialsClient`-driven tests (`CredentialsSectionModelTests`) structurally
/// cannot reach, since that fake hands back already-built `CredentialRow`s and never parses a byte.
/// Drives a REAL `WinterClient` over `FeedScriptedTransport`, the same pattern as
/// `LiveAnthropicAuthClientTests` beside it.
@MainActor
final class LiveCredentialsClientTests: XCTestCase {
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "credentials-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// Sends the request and feeds `resultJSON` back as `credential.list`'s result.
    ///
    /// `resultJSON` must be a SINGLE LINE: the transport is NDJSON, so a pretty-printed fixture
    /// with real newlines in it is not one frame but several unparseable ones, and the call simply
    /// times out 5s later with no decoding error to read. (Measured, not theorised — three tests in
    /// this file first failed exactly that way.)
    private func list(_ resultJSON: String) async throws -> [CredentialRow] {
        let (client, t) = try await connectedClient()
        let live = LiveCredentialsClient(client: client)
        async let listTask = live.list()
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "credential.list")
        XCTAssertEqual((req["params"] as? [String: Any])?.isEmpty, true, "credential.list takes no params")
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":\#(resultJSON)}"#)
        return try await listTask
    }

    // MARK: - A-4: a reply with no `providers` array is an ERROR, never an empty list

    /// The asymmetry the ruling turns on. "No credentials are stored" and "I could not read the
    /// reply" render identically if the second degrades into the first — and the harm is one-sided:
    /// a user shown a spuriously empty list concludes their keys are gone and re-enters them, which
    /// is a UI bug talking a person into handling their own secrets for no reason.
    func testAListReplyWithoutAProvidersArrayThrows() async throws {
        do {
            _ = try await list("{}")
            XCTFail("a reply with no `providers` array must throw, never answer []")
        } catch let error as CredentialsClientError {
            XCTAssertEqual(error, .malformedListReply)
        }
    }

    /// The same rule for a `providers` that is present but is not an array — the wrong TYPE is no
    /// more readable than a missing key.
    func testAListReplyWhoseProvidersIsNotAnArrayThrows() async throws {
        do {
            _ = try await list(#"{"providers":"none"}"#)
            XCTFail("a non-array `providers` must throw")
        } catch let error as CredentialsClientError {
            XCTAssertEqual(error, .malformedListReply)
        }
    }

    /// A genuinely empty inventory is NOT an error — `[]` is a claim the daemon itself made here,
    /// which is exactly what makes it safe to show.
    func testAnExplicitlyEmptyProvidersArrayIsNotAnError() async throws {
        let rows = try await list(#"{"providers":[]}"#)

        XCTAssertTrue(rows.isEmpty)
    }

    // MARK: - A-4: one malformed row is SKIPPED, the rest still decode

    /// The other half of the ruling, and the opposite call for a reason: the surrounding rows are
    /// perfectly readable, so dropping the batch over one unknown shape from a newer daemon would
    /// hide credentials that are fine. Here the middle row is missing `displayName`.
    func testASingleMalformedRowIsSkippedAndTheOthersSurvive() async throws {
        let openai = #"{"providerId":"openai","displayName":"OpenAI","group":"provider","authKinds":["api-key"],"manageable":true,"present":true,"kind":"api-key","risk":"approved","door":"credential.set"}"#
        // No `displayName` — a REQUIRED field (W19-3), so this row is unreadable.
        let broken = #"{"providerId":"broken","group":"provider","authKinds":["api-key"],"manageable":true,"present":false,"risk":"approved","door":"credential.set"}"#
        let deepseek = #"{"providerId":"deepseek","displayName":"DeepSeek","group":"provider","authKinds":["api-key"],"manageable":true,"present":false,"kind":"api-key","risk":"review-required","door":"credential.set"}"#
        let rows = try await list("{\"providers\":[\(openai),\(broken),\(deepseek)]}")

        XCTAssertEqual(rows.map(\.providerId), ["openai", "deepseek"], "the unreadable row is skipped; the readable ones are not")
        XCTAssertEqual(rows.first?.risk, "approved")
        XCTAssertEqual(rows.last?.risk, "review-required")
    }

    /// `kind` is genuinely optional (W19-3), so its absence must NOT be read as a malformed row —
    /// the distinction between "optional field missing" and "required field missing" is the thing
    /// that decides whether a real credential disappears from the list.
    func testAMissingOptionalKindDoesNotSkipTheRow() async throws {
        let exa = #"{"providerId":"exa","displayName":"Exa","group":"tool","authKinds":["api-key"],"manageable":true,"present":true,"risk":"approved","door":"credential.set"}"#
        let rows = try await list("{\"providers\":[\(exa)]}")

        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows.first?.kind)
        XCTAssertEqual(rows.first?.group, "tool")
    }

    /// Per-slot rows (A-1): `anthropic` twice, distinguished by `door`/`kind`, and the composite
    /// `id` keeps them apart on the wire path too — not just in the hand-built fixtures the model
    /// tests use.
    func testTheTwoAnthropicSlotsDecodeAsTwoDistinctRows() async throws {
        let apiKeySlot = #"{"providerId":"anthropic","displayName":"Anthropic","group":"provider","authKinds":["api-key"],"manageable":true,"present":true,"kind":"api-key","risk":"approved","door":"credential.set"}"#
        let consoleSlot = #"{"providerId":"anthropic","displayName":"Anthropic (Console)","group":"provider","authKinds":["oauth"],"manageable":false,"present":true,"kind":"bearer","risk":"approved","door":"provider.login"}"#
        let rows = try await list("{\"providers\":[\(apiKeySlot),\(consoleSlot)]}")

        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.map(\.id)).count, 2)
        XCTAssertTrue(credentialRowOffersRemove(rows[0]), "the api-key slot is removable")
        XCTAssertFalse(credentialRowOffersRemove(rows[1]), "the console slot is not (A-3)")
    }

    // MARK: - set/remove wire shapes

    /// The key goes out verbatim under `apiKey`, and `{ok:true}` resolves without throwing.
    func testSetSendsProviderIdAndKeyAndSucceedsOnOkTrue() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveCredentialsClient(client: client)

        async let setTask: () = live.set(providerId: "deepseek", apiKey: "WS19-SENTINEL-wire")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        XCTAssertEqual(req["method"] as? String, "credential.set")
        let params = req["params"] as? [String: Any]
        XCTAssertEqual(params?["providerId"] as? String, "deepseek")
        XCTAssertEqual(params?["apiKey"] as? String, "WS19-SENTINEL-wire", "the key crosses the wire verbatim")

        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)
        try await setTask
    }

    /// A well-formed `{ok:false}` is a FAILURE, not a quiet success — same rule as
    /// `LiveAnthropicAuthClient.submitLoginCode`, and the thrown message names only the method, so
    /// nothing derived from the key can reach a caller that renders it.
    func testSetOkFalseThrowsWithoutNamingTheValue() async throws {
        let (client, t) = try await connectedClient()
        let live = LiveCredentialsClient(client: client)

        async let setTask: () = live.set(providerId: "deepseek", apiKey: "WS19-SENTINEL-wire")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":false}}"#)

        do {
            try await setTask
            XCTFail("ok:false must throw")
        } catch let error as RpcError {
            XCTAssertFalse(error.message.contains("WS19-SENTINEL-wire"), "no thrown message may carry the key")
        }
    }

    /// `removed` is returned, not thrown on: `false` means nothing was stored, which is the
    /// post-state the caller asked for.
    func testRemoveReturnsTheRemovedFlag() async throws {
        for removed in [true, false] {
            let (client, t) = try await connectedClient()
            let live = LiveCredentialsClient(client: client)

            async let removeTask = live.remove(providerId: "deepseek")
            await feedWaitUntil { t.sent.count >= 2 }
            let req = feedLineJSON(t.sent[1])
            XCTAssertEqual(req["method"] as? String, "credential.remove")
            t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true,"removed":\#(removed)}}"#)

            let got = try await removeTask
            XCTAssertEqual(got, removed)
        }
    }
}
