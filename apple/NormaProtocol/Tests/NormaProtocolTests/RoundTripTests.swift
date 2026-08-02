import XCTest
@testable import NormaProtocol

final class RoundTripTests: XCTestCase {
    func fixtureURLs() throws -> [URL] {
        let urls = Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "Fixtures") ?? []
        XCTAssertEqual(urls.count, 58, "expected 58 fixtures — regenerate via pnpm protocol:generate")
        return urls
    }

    /// Gate (c): every TS-generated fixture decodes, re-encodes, and decodes to an equal value.
    func testAllFixturesRoundTrip() throws {
        for url in try fixtureURLs() {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(SessionEvent.self, from: data)
            let reencoded = try JSONEncoder().encode(decoded)
            let redecoded = try JSONDecoder().decode(SessionEvent.self, from: reencoded)
            XCTAssertEqual(decoded, redecoded, "round-trip mismatch for \(url.lastPathComponent)")

            let obj = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
            XCTAssertNotNil(obj?["type"] as? String, "re-encoded JSON lost the type discriminator for \(url.lastPathComponent)")
        }
    }

    func testUnknownDiscriminatorFailsLoudly() throws {
        let bad = #"{"type":"mystery","seq":1,"sessionId":"s","ts":0}"#.data(using: .utf8)!
        XCTAssertThrowsError(try JSONDecoder().decode(SessionEvent.self, from: bad))
    }

    func testThreadStartedDescriptionOptional() throws {
        let with = #"{"type":"thread_started","seq":9,"sessionId":"s","ts":5,"threadId":"th_1","parentThreadId":"main","agentType":"general-purpose","prompt":"go","description":"explore auth module"}"#
        guard case .threadStarted(let v) = try JSONDecoder().decode(SessionEvent.self, from: Data(with.utf8)) else { return XCTFail() }
        XCTAssertEqual(v.description, "explore auth module")

        let without = #"{"type":"thread_started","seq":9,"sessionId":"s","ts":5,"threadId":"th_1","parentThreadId":"main","agentType":"general-purpose","prompt":"go"}"#
        guard case .threadStarted(let v2) = try JSONDecoder().decode(SessionEvent.self, from: Data(without.utf8)) else { return XCTFail() }
        XCTAssertNil(v2.description)
    }

    /// Task-graph fields (4h-ii-d, CC parity) — additive guarantee both directions: a payload
    /// WITH owner/blocks/blockedBy/metadata decodes and re-encodes losslessly (via the
    /// TS-generated `task_with_graph_fields.json` fixture, synced from packages/protocol), and
    /// the OLD-shape `task_updated.json` fixture (predates these fields) still decodes with all
    /// four nil — mirrors `testThreadStartedDescriptionOptional`'s with/without pattern above.
    func testTaskGraphFieldsOptional() throws {
        guard let withURL = Bundle.module.url(forResource: "task_with_graph_fields", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing task_with_graph_fields.json fixture")
        }
        let withData = try Data(contentsOf: withURL)
        guard case .taskUpdated(let with) = try JSONDecoder().decode(SessionEvent.self, from: withData) else { return XCTFail() }
        XCTAssertEqual(with.task.owner, "researcher")
        XCTAssertEqual(with.task.blocks, ["5", "6"])
        XCTAssertEqual(with.task.blockedBy, ["2"])
        XCTAssertEqual(with.task.metadata?["priority"], .string("high"))
        XCTAssertEqual(with.task.metadata?["sprint"], .number(12))

        let reencoded = try JSONEncoder().encode(SessionEvent.taskUpdated(with))
        guard case .taskUpdated(let redecoded) = try JSONDecoder().decode(SessionEvent.self, from: reencoded) else { return XCTFail() }
        XCTAssertEqual(with, redecoded)

        guard let withoutURL = Bundle.module.url(forResource: "task_updated", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing task_updated.json fixture")
        }
        let withoutData = try Data(contentsOf: withoutURL)
        guard case .taskUpdated(let without) = try JSONDecoder().decode(SessionEvent.self, from: withoutData) else { return XCTFail() }
        XCTAssertNil(without.task.owner)
        XCTAssertNil(without.task.blocks)
        XCTAssertNil(without.task.blockedBy)
        XCTAssertNil(without.task.metadata)
    }

    /// Phase 5e T1 (reviewer maturity — the NormaKit-trap task): the NEW `tool_review` variant
    /// decodes with its verdict/toolName/reason/summary intact — this is what proves the exhaustive
    /// switches + codec were actually synced, not just that the union compiles.
    func testToolReviewDecodes() throws {
        guard let url = Bundle.module.url(forResource: "tool_review", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing tool_review.json fixture")
        }
        let data = try Data(contentsOf: url)
        guard case .toolReview(let v) = try JSONDecoder().decode(SessionEvent.self, from: data) else { return XCTFail() }
        XCTAssertEqual(v.toolName, "bash")
        XCTAssertEqual(v.verdict, "unsafe")
        XCTAssertFalse(v.reason.isEmpty)
        XCTAssertFalse(v.summary.isEmpty)
    }

    /// Phase 5e T1: `approval_requested.reviewerReason` is additive/optional — mirrors
    /// `testThreadStartedDescriptionOptional`/`testTaskGraphFieldsOptional`'s with/without pattern,
    /// via the TS-generated `approval_requested_with_reviewer_reason.json` fixture (present) vs the
    /// pre-existing `approval_requested.json` (predates this field, absent).
    func testApprovalRequestedReviewerReasonOptional() throws {
        guard let withURL = Bundle.module.url(forResource: "approval_requested_with_reviewer_reason", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing approval_requested_with_reviewer_reason.json fixture")
        }
        let withData = try Data(contentsOf: withURL)
        guard case .approvalRequested(let with) = try JSONDecoder().decode(SessionEvent.self, from: withData) else { return XCTFail() }
        XCTAssertEqual(with.reviewerReason, "recursive delete outside the session cwd")

        guard let withoutURL = Bundle.module.url(forResource: "approval_requested", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing approval_requested.json fixture")
        }
        let withoutData = try Data(contentsOf: withoutURL)
        guard case .approvalRequested(let without) = try JSONDecoder().decode(SessionEvent.self, from: withoutData) else { return XCTFail() }
        XCTAssertNil(without.reviewerReason)
    }

    /// task-16 (Stalled roster verb, CC-parity follow-up): `ThreadCompleted.stopReason` is a plain
    /// `String` (not a Swift enum) — see this struct's own field in SessionEvent.swift — so adding
    /// the new "stalled" wire value needs no case addition and breaks no exhaustive switch. This
    /// proves the new VALUE decodes intact via the TS-generated `thread_completed_stalled.json`
    /// fixture (testAllFixturesRoundTrip above already covers its generic round-trip; this asserts
    /// the specific stopReason content, mirroring testToolReviewDecodes' new-variant pattern
    /// adapted for a new-value-not-variant case).
    func testThreadCompletedStalledDecodes() throws {
        guard let url = Bundle.module.url(forResource: "thread_completed_stalled", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing thread_completed_stalled.json fixture")
        }
        let data = try Data(contentsOf: url)
        guard case .threadCompleted(let v) = try JSONDecoder().decode(SessionEvent.self, from: data) else { return XCTFail() }
        XCTAssertEqual(v.stopReason, "stalled")
    }

    /// task-30 (push-notification track — the final CC-parity tool item, and another
    /// NormaKit-trap task like `tool_review` above): the NEW `notification_requested` variant
    /// decodes with its title/message intact — proves the exhaustive switches + codec were synced.
    func testNotificationRequestedDecodes() throws {
        guard let url = Bundle.module.url(forResource: "notification_requested", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing notification_requested.json fixture")
        }
        let data = try Data(contentsOf: url)
        guard case .notificationRequested(let v) = try JSONDecoder().decode(SessionEvent.self, from: data) else { return XCTFail() }
        XCTAssertEqual(v.title, "Norma")
        XCTAssertFalse(v.message.isEmpty)
    }

    /// followups T3 (ChatEngine as a second `turn_completed` producer): `contextTokens` is
    /// additive/optional — mirrors `testThreadStartedDescriptionOptional`'s with/without pattern.
    /// Fix-round-1 (review): the "with" half now loads the TS-generated
    /// `turn_completed_with_contextTokens.json` fixture (`packages/protocol/scripts/generate.ts`)
    /// rather than a hand-written JSON literal — a literal ties nothing to the TS schema, so a
    /// future rename/drift there would leave this test green while a real daemon-emitted event
    /// silently stopped matching. `inputTokens` (900) deliberately != `contextTokens` (300) in that
    /// fixture, so it encodes the max-not-sum distinction, not just a present/absent one. The
    /// "without" half re-uses the pre-existing `turn_completed.json` fixture to prove an OLDER
    /// event (predating this field) still decodes.
    func testTurnCompletedContextTokensOptional() throws {
        guard let withURL = Bundle.module.url(forResource: "turn_completed_with_contextTokens", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing turn_completed_with_contextTokens.json fixture")
        }
        let withData = try Data(contentsOf: withURL)
        guard case .turnCompleted(let v) = try JSONDecoder().decode(SessionEvent.self, from: withData) else { return XCTFail() }
        XCTAssertEqual(v.contextTokens, 300)
        XCTAssertEqual(v.inputTokens, 900, "inputTokens keeps its billing (summed) meaning — untouched by this field")

        // Round-trips losslessly: re-encoding a present contextTokens must not drop it.
        let reencoded = try JSONEncoder().encode(SessionEvent.turnCompleted(v))
        guard case .turnCompleted(let redecoded) = try JSONDecoder().decode(SessionEvent.self, from: reencoded) else { return XCTFail() }
        XCTAssertEqual(v, redecoded)
        let obj = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
        XCTAssertEqual((obj?["contextTokens"] as? NSNumber)?.intValue, 300)

        guard let withoutURL = Bundle.module.url(forResource: "turn_completed", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing turn_completed.json fixture")
        }
        let withoutData = try Data(contentsOf: withoutURL)
        guard case .turnCompleted(let without) = try JSONDecoder().decode(SessionEvent.self, from: withoutData) else { return XCTFail() }
        XCTAssertNil(without.contextTokens)
        // Re-encoding an ABSENT contextTokens must not invent the key (encodeIfPresent semantics) —
        // load-bearing for byte-verbatim replication of an older/absent-field event.
        let withoutReencoded = try JSONEncoder().encode(SessionEvent.turnCompleted(without))
        let withoutObj = try JSONSerialization.jsonObject(with: withoutReencoded) as? [String: Any]
        XCTAssertNil(withoutObj?["contextTokens"], "an absent contextTokens must stay absent on re-encode")
    }

    /// SP-approvals T4: `approval_requested.options` is additive/optional — mirrors
    /// `testApprovalRequestedReviewerReasonOptional`'s with/without pattern, via the TS-generated
    /// `approval_requested_with_options.json` fixture (present, one rule-bearing option + one bare
    /// allow_once option) vs. the pre-existing `approval_requested.json` (predates this field,
    /// absent). Checks CONTENT, not just the fixture-count tripwire above — proves `ApprovalOption`
    /// decodes id/label/rule/scope correctly, not merely that the union still compiles.
    func testApprovalRequestedOptionsOptional() throws {
        guard let withURL = Bundle.module.url(forResource: "approval_requested_with_options", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing approval_requested_with_options.json fixture")
        }
        let withData = try Data(contentsOf: withURL)
        guard case .approvalRequested(let with) = try JSONDecoder().decode(SessionEvent.self, from: withData) else { return XCTFail() }
        guard let options = with.options else { return XCTFail("expected options to be present") }
        XCTAssertEqual(options.count, 2)
        XCTAssertEqual(options[0], SessionEvent.ApprovalOption(id: "allow_once", label: "Allow once", rule: nil, scope: nil))
        XCTAssertEqual(options[1], SessionEvent.ApprovalOption(id: "allow_project", label: "Always allow \"git push\" in this project", rule: "Bash(git push:*)", scope: "project"))

        let reencoded = try JSONEncoder().encode(SessionEvent.approvalRequested(with))
        guard case .approvalRequested(let redecoded) = try JSONDecoder().decode(SessionEvent.self, from: reencoded) else { return XCTFail() }
        XCTAssertEqual(with, redecoded)

        guard let withoutURL = Bundle.module.url(forResource: "approval_requested", withExtension: "json", subdirectory: "Fixtures") else {
            return XCTFail("missing approval_requested.json fixture")
        }
        let withoutData = try Data(contentsOf: withoutURL)
        guard case .approvalRequested(let without) = try JSONDecoder().decode(SessionEvent.self, from: withoutData) else { return XCTFail() }
        XCTAssertNil(without.options)
    }
}
