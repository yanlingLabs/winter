import XCTest
import WinterProtocol
@testable import WinterKit

/// Winter Phase 10b amendment (c) — WS-19, the MAC side of the Lane I/Lane Q decoder parity pair.
///
/// WS-19 is served by two hand-written Swift decoders for the same three RPCs: Lane Q's
/// `LiveCredentialsClient` here (over `WinterClient`, the Mac's Unix socket) and Lane I's
/// `RemoteCredentialsRpc` in `WinterChatKit` (over the phone's `RpcConn`). They cannot share an
/// implementation — the phone links neither `WinterKit` nor its transport — so they share their
/// INPUT instead: `apple/fixtures/ws19-credential-list.json`, decoded on both sides against the
/// same expected table (`CredentialsRpcTests.testTheSharedFixtureDecodesToTheAgreedRows`).
///
/// Without this pin the two drift silently, and the shape the drift takes is a row quietly
/// vanishing from one surface — a credential the user stored on the Mac and cannot see on the
/// phone, or the reverse. The fixture is built to sit on every leniency the two decoders have to
/// agree about: `anthropic` twice (§9 A-1, kept apart only by the composite `id`), both tool rows
/// (§9 A-2 — Exa present with no `kind`, Web search absent with one), a row
/// missing the required `displayName` that is SKIPPED, a row with no `authKinds`
/// at all, and a row whose `authKinds` holds a non-string element. The last two are where a
/// synthesized `Decodable` would throw the whole row away instead of shrugging.
final class CredentialsDecoderParityTests: XCTestCase {

    func testTheSharedFixtureDecodesToTheAgreedRows() async throws {
        let fixture = try String(decoding: sharedFixture(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // The transport is NDJSON: a pretty-printed fixture is not one frame but several
        // unparseable ones, and the call would simply time out with no decoding error to read.
        XCTAssertFalse(fixture.contains("\n"), "the shared fixture must stay SINGLE-LINE")

        let rows = try await list(fixture)

        XCTAssertEqual(rows.map(\.id), [
            "openai|credential.set|api-key",
            "anthropic|credential.set|api-key",
            "anthropic|provider.login|bearer",
            "exa|credential.set|",
            "web-search|credential.set|api-key",
            "deepseek|credential.set|api-key",
            "zai|credential.set|api-key",
            "openrouter|credential.set|api-key",
            "codex-oauth|cli-oauth|oauth",
        ])
        XCTAssertEqual(rows.map(\.displayName), [
            "OpenAI", "Anthropic", "Anthropic (Console)", "Exa", "Web search", "DeepSeek", "Z.ai", "OpenRouter", "ChatGPT (Codex)",
        ])
        XCTAssertEqual(rows.map(\.group), [
            "provider", "provider", "provider", "tool", "tool", "provider", "provider", "provider", "provider",
        ])
        XCTAssertEqual(rows.map(\.authKinds), [
            ["api-key"], ["api-key"], ["oauth"], ["api-key"], ["api-key"], ["api-key"], [], ["api-key"], ["oauth"],
        ])
        XCTAssertEqual(rows.map(\.manageable), [true, true, false, true, true, true, true, true, false])
        XCTAssertEqual(rows.map(\.present), [true, true, true, true, false, false, false, true, true])
        XCTAssertEqual(rows.map(\.risk), [
            "approved", "approved", "approved", "approved", "approved",
            "review-required", "review-required", "review-required", "approved",
        ])
        // §9 A-3, spelled out rather than called: the Mac's `credentialRowOffersRemove` lives in the
        // app module (`apple/Winter/Sources/Dashboard/panes/CredentialsSection.swift`), which this
        // kit-level target does not link. The rule itself is the thing under test.
        XCTAssertEqual(rows.map { $0.present && $0.door != "provider.login" },
                       [true, true, false, true, false, false, false, true, true])
    }

    /// A non-empty `providers` array in which NOT ONE row decodes throws, on the same bytes
    /// `CredentialsRpcTests.testTheAllMalformedSharedFixtureThrows` drives (three rows, each
    /// missing a different required field). Skipping unreadable rows is only safe as a partial
    /// measure — with none left it silently becomes the empty list §9 A-4 forbids, and the daemon
    /// had just said it holds credentials. This is the one A-4 case where the two clients could
    /// plausibly have been written to disagree, so it is pinned on both.
    func testTheAllMalformedSharedFixtureThrows() async throws {
        let fixture = try String(decoding: sharedFixture("ws19-credential-list-all-malformed.json"), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await list(fixture)
            XCTFail("a non-empty providers array that decodes to nothing must throw, never answer []")
        } catch let error as CredentialsClientError {
            XCTAssertEqual(error, .malformedListReply)
        }
    }

    /// An EXPLICITLY empty array is the other side of that line and must stay an empty list: `[]` is
    /// a claim the daemon itself made, which is what makes it safe to show.
    func testAnExplicitlyEmptyProvidersArrayIsStillNotAnError() async throws {
        let rows = try await list(#"{"providers":[]}"#)

        XCTAssertTrue(rows.isEmpty)
    }

    // MARK: - plumbing

    /// A fixture under `<repo>/apple/fixtures/`, read straight from the repo (the same
    /// source-relative habit `WinterProtocol`'s fixture tests and `ParityFixtures` use). Neither
    /// package owns these files: a copy inside one of them would be a second source of truth that
    /// goes stale the moment the other side edits it — the exact drift this test exists to catch.
    private func sharedFixture(_ name: String = "ws19-credential-list.json") throws -> Data {
        // #filePath == <repo>/apple/WinterKit/Tests/WinterKitTests/CredentialsDecoderParityTests.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 4 { url.deleteLastPathComponent() } // file, WinterKitTests, Tests, WinterKit → <repo>/apple
        return try Data(contentsOf: url.appending(path: "fixtures/\(name)"))
    }

    /// Drives a real `LiveCredentialsClient` over `ScriptedTransport` (WinterClientTests) and feeds
    /// `resultJSON` back as `credential.list`'s result.
    private func list(_ resultJSON: String) async throws -> [CredentialRow] {
        let t = ScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "credentials-parity")
        async let connected: Void = client.connect()
        let helloLine = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloLine)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        async let rows = LiveCredentialsClient(client: client).list()
        let sent = try await waitForSent(t, count: 2)
        let req = decodeLine(sent[1])
        XCTAssertEqual(req["method"] as? String, "credential.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":\#(resultJSON)}"#)
        return try await rows
    }
}
