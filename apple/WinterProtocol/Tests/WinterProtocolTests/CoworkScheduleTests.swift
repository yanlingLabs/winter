import XCTest
@testable import WinterProtocol

final class CoworkScheduleTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ value: [String: Any]) throws -> T { try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value)) }
    private var definition: [String: Any] {
        ["target": ["kind": "project", "projectId": "project"], "sourceId": "source", "prompt": "Fixture", "timing": ["kind": "recurring", "spec": "every 1h"], "timezone": "UTC", "savedCeiling": ["toolClasses": ["read"], "hostServices": [], "connectors": [], "network": "none"], "policy": "bypass", "overlap": "one-active-one-pending"]
    }
    private var record: [String: Any] { ["scheduleId": "schedule", "workspaceId": "workspace", "definition": definition, "state": "enabled", "revision": 1, "nextDue": 1000, "createdAt": 0] }
    private var quarantine: [String: Any] { ["scheduleId": "schedule", "workspaceId": "workspace", "state": "quarantined", "revision": 2, "nextDue": NSNull(), "createdAt": 0, "reason": "invalid_schedule", "cancelled": false] }
    func testDefinitionPreservesBypassCeilingSourceAndTargetAndRoundTrips() throws {
        let value = try decode(CoworkScheduleDefinition.self, definition)
        XCTAssertEqual(value.policy, .bypass); XCTAssertEqual(value.savedCeiling.toolClasses, ["read"]); XCTAssertEqual(value.target, .project(projectId: "project")); XCTAssertEqual(value.sourceId, "source")
        XCTAssertEqual(try JSONDecoder().decode(CoworkScheduleDefinition.self, from: JSONEncoder().encode(value)), value)
    }
    func testConversationAndOneShotPreserveIntentWithoutCreatingAnotherWorkspace() throws {
        var data = definition; data["target"] = ["kind": "conversation", "sessionId": "session"]; data["timing"] = ["kind": "once", "at": 1000]
        let value = try decode(CoworkScheduleDefinition.self, data)
        XCTAssertEqual(value.target, .conversation(sessionId: "session")); XCTAssertEqual(value.timing, .once(at: 1000))
    }
    func testQuarantineCannotContainInvalidDefinitionOrClaimFutureDueTime() throws {
        let value = try decode(CoworkScheduleView.self, quarantine)
        XCTAssertEqual(value.scheduleId, "schedule"); XCTAssertTrue(value.canCancel)
        var leaked = quarantine; leaked["definition"] = definition; XCTAssertThrowsError(try decode(CoworkScheduleView.self, leaked))
        var future = quarantine; future["nextDue"] = 1000; XCTAssertThrowsError(try decode(CoworkScheduleView.self, future))
        var reason = quarantine; reason["reason"] = "execution_unavailable"; XCTAssertThrowsError(try decode(CoworkScheduleView.self, reason))
    }
    func testClosedSchemaRejectsMixedTargetsUnknownPoliciesPartialCeilingsAndOversizedNames() {
        var mixed = definition; mixed["target"] = ["kind": "project", "projectId": "project", "sessionId": "session"]; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, mixed))
        var unknown = definition; unknown["policy"] = "bypass-cowork"; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, unknown))
        var counts = definition; counts["savedCeiling"] = ["network": "none", "capabilityCounts": ["toolClasses": 1]]; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, counts))
        var oversized = definition; oversized["prompt"] = String(repeating: "🙂", count: 4097); XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, oversized))
        var nullBranch = definition; nullBranch["branchPrecondition"] = NSNull(); XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, nullBranch))
    }
    func testOccurrencesRetainAllClaimRecoveryStatesReasonsAndMissedCounts() throws {
        for state in ["pending", "claimed", "dispatching", "uncertain", "handled", "cancelled"] {
            let value = try decode(CoworkScheduleOccurrence.self, ["occurrenceId": "occurrence", "scheduleId": "schedule", "dueAt": 1000, "latestDueAt": 9000, "missedCount": 8, "state": state, "reason": "recovery_required"])
            XCTAssertEqual(value.state.rawValue, state); XCTAssertEqual(value.missedCount, 8); XCTAssertEqual(value.reason, .recoveryRequired)
        }
        var missing = record; missing.removeValue(forKey: "nextDue"); XCTAssertThrowsError(try decode(CoworkSchedule.self, missing))
        XCTAssertThrowsError(try decode(CoworkScheduleOccurrence.self, ["occurrenceId": "occurrence", "scheduleId": "schedule", "dueAt": 1000, "latestDueAt": 9000, "missedCount": -1, "state": "pending", "reason": NSNull()]))
    }
    func testStatusRejectsExecutionSuccessAndOverfullPages() {
        XCTAssertThrowsError(try decode(CoworkScheduleStatus.self, ["schedule": record, "occurrences": [], "execution": "available"]))
        XCTAssertThrowsError(try decode(CoworkSchedulePage.self, ["schedules": Array(repeating: record, count: 101), "nextCursor": NSNull()]))
    }
    func testAllExistingPoliciesAndClosedBlockedReasonsArePreserved() throws {
        for policy in ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] {
            var data = definition; data["policy"] = policy
            XCTAssertEqual(try decode(CoworkScheduleDefinition.self, data).policy.rawValue, policy)
        }
        for reason in ["execution_unavailable", "shutdown", "archived", "source_unavailable", "authority_denied", "branch_mismatch", "branch_state_unavailable", "recovery_required", "invalid_schedule"] {
            let data: [String: Any] = ["occurrenceId": "occurrence", "scheduleId": "schedule", "dueAt": 1000, "latestDueAt": 1000, "missedCount": 0, "state": "pending", "reason": reason]
            XCTAssertEqual(try decode(CoworkScheduleOccurrence.self, data).reason?.rawValue, reason)
        }
    }
    func testRequiredNullsRoundTripAndCeilingLabelsUseCoreUTF16AndTrimRules() throws {
        var data = record; data["nextDue"] = NSNull()
        let value = try decode(CoworkSchedule.self, data)
        XCTAssertNil(value.nextDue)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
        XCTAssertTrue(encoded["nextDue"] is NSNull)
        var ceiling = definition
        ceiling["savedCeiling"] = ["toolClasses": ["\u{0085}"], "hostServices": [], "connectors": [], "network": "none"]
        XCTAssertEqual(try decode(CoworkScheduleDefinition.self, ceiling).savedCeiling.toolClasses, ["\u{0085}"])
        ceiling["savedCeiling"] = ["toolClasses": ["\u{FEFF}"], "hostServices": [], "connectors": [], "network": "none"]
        XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, ceiling))
        ceiling["savedCeiling"] = ["toolClasses": [String(repeating: "🙂", count: 101)], "hostServices": [], "connectors": [], "network": "none"]
        XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, ceiling))
    }
    func testCeilingLabelsRefuseNulCarriageReturnAndLineFeedLikeCore() throws {
        // Core's /[\0\r\n]/ sees "\r\n" as two code units. A Swift Character comparison sees ONE grapheme,
        // equal to neither "\r" nor "\n", and used to let the pair through.
        for bad in ["a\r\nb", "\r\n", "a\rb", "a\nb", "a\0b"] {
            var ceiling = definition
            ceiling["savedCeiling"] = ["toolClasses": [bad], "hostServices": [], "connectors": [], "network": "none"]
            XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, ceiling), "\(bad.debugDescription) must be refused")
            ceiling["savedCeiling"] = ["toolClasses": [], "hostServices": [bad], "connectors": [], "network": "none"]
            XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, ceiling), "\(bad.debugDescription) must be refused in hostServices")
            ceiling["savedCeiling"] = ["toolClasses": [], "hostServices": [], "connectors": [bad], "network": "none"]
            XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, ceiling), "\(bad.debugDescription) must be refused in connectors")
        }
        var plain = definition
        plain["savedCeiling"] = ["toolClasses": ["a b", "tab\tseparated"], "hostServices": [], "connectors": [], "network": "none"]
        XCTAssertEqual(try decode(CoworkScheduleDefinition.self, plain).savedCeiling.toolClasses, ["a b", "tab\tseparated"])
    }
    func testDefinitionBoundsAreEnforcedIndependentlyAfterTheValidationSplit() throws {
        var empty = definition; empty["prompt"] = ""; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, empty))
        var nul = definition; nul["prompt"] = "a\0b"; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, nul))
        var zone = definition; zone["timezone"] = ""; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, zone))
        var longZone = definition; longZone["timezone"] = String(repeating: "z", count: 101); XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, longZone))
        var source = definition; source["sourceId"] = "../source"; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, source))
        var emptyBranch = definition; emptyBranch["branchPrecondition"] = ""; XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, emptyBranch))
        var longBranch = definition; longBranch["branchPrecondition"] = String(repeating: "b", count: 201); XCTAssertThrowsError(try decode(CoworkScheduleDefinition.self, longBranch))
        var branch = definition; branch["branchPrecondition"] = "main"; XCTAssertEqual(try decode(CoworkScheduleDefinition.self, branch).branchPrecondition, "main")
    }
    func testViewAccessorsAgreeForBothCases() throws {
        let normal = try decode(CoworkScheduleView.self, record), quarantined = try decode(CoworkScheduleView.self, quarantine)
        XCTAssertEqual(normal.scheduleId, "schedule"); XCTAssertEqual(normal.workspaceId, "workspace"); XCTAssertEqual(normal.revision, 1)
        XCTAssertFalse(normal.isCancelled); XCTAssertTrue(normal.canCancel)
        XCTAssertEqual(quarantined.revision, 2); XCTAssertFalse(quarantined.isCancelled); XCTAssertTrue(quarantined.canCancel)
        var cancelledRecord = record; cancelledRecord["state"] = "cancelled"; cancelledRecord["nextDue"] = NSNull()
        var cancelledQuarantine = quarantine; cancelledQuarantine["cancelled"] = true
        let cancelledNormal = try decode(CoworkScheduleView.self, cancelledRecord), cancelledQuarantined = try decode(CoworkScheduleView.self, cancelledQuarantine)
        for value in [cancelledNormal, cancelledQuarantined] {
            XCTAssertTrue(value.isCancelled); XCTAssertFalse(value.canCancel)
            XCTAssertEqual(try JSONDecoder().decode(CoworkScheduleView.self, from: JSONEncoder().encode(value)), value)
        }
    }
    func testFactoriesMirrorExistingLocalMethodsAndRequireExplicitRequestIdentity() throws {
        let value = try decode(CoworkScheduleDefinition.self, definition)
        let request = try CoworkRequest<CoworkSchedule>.createSchedule(workspaceId: "workspace", requestId: "stable-request", definition: value)
        XCTAssertEqual(request.method, "workspace.schedule.create")
        guard case let .object(params) = request.params else { return XCTFail("Expected object") }
        XCTAssertEqual(params["requestId"], .string("stable-request")); XCTAssertNil(params["cwd"])
        let cancel = try CoworkRequest<CoworkScheduleView>.cancelSchedule(workspaceId: "workspace", scheduleId: "schedule", expectedRevision: 1)
        XCTAssertEqual(cancel.method, "workspace.schedule.cancel")
        guard case let .object(cancelParams) = cancel.params else { return XCTFail("Expected object") }
        XCTAssertEqual(cancelParams["expectedRevision"], .number(1)); XCTAssertNil(cancelParams["requestId"])
        XCTAssertThrowsError(try CoworkRequest<CoworkSchedulePage>.schedules(workspaceId: "workspace", limit: 101))
        XCTAssertThrowsError(try CoworkRequest<CoworkSchedule>.createSchedule(workspaceId: "workspace", requestId: "../invalid", definition: value))
    }
}
