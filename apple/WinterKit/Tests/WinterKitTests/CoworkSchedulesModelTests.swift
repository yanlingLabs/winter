import XCTest
@testable import WinterKit
import WinterProtocol

/// Source regressions using only a fake transport. No daemon, guest, native worker or home.
@MainActor final class CoworkSchedulesModelTests: XCTestCase {
    private final class Gate {
        var continuation: CheckedContinuation<Void, Never>?
        func wait() async { await withCheckedContinuation { continuation = $0 } }
        func release() { continuation?.resume(); continuation = nil }
    }
    private final class Host {
        var calls: [(String, SessionEvent.JSONValue)] = []
        var revision = 1, cancelled = false, loseCancelReplies = 0, failStatus = false
        var handler: ((String, [String: Any]) throws -> [String: Any])?
        static func record(workspace: String = "workspace", id: String = "schedule", revision: Int = 1, state: String = "enabled") -> [String: Any] {
            ["scheduleId": id, "workspaceId": workspace, "revision": revision, "state": state, "createdAt": 0, "nextDue": state == "enabled" ? 1000 : NSNull(),
             "definition": ["target": ["kind": "project", "projectId": "project"], "sourceId": "source", "prompt": "Fixture", "timing": ["kind": "recurring", "spec": "every 1h"], "timezone": "UTC", "policy": "bypass", "overlap": "one-active-one-pending", "savedCeiling": ["toolClasses": ["read"], "hostServices": [], "connectors": [], "network": "none"]]]
        }
        static func occurrence(id: String = "occurrence", schedule: String = "schedule", state: String = "pending", reason: Any = "execution_unavailable") -> [String: Any] {
            ["occurrenceId": id, "scheduleId": schedule, "dueAt": 1000, "latestDueAt": 9000, "missedCount": 8, "state": state, "reason": reason]
        }
        static func json(_ object: [String: Any]) throws -> SessionEvent.JSONValue {
            try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONSerialization.data(withJSONObject: object))
        }
        func params(_ method: String) throws -> [[String: Any]] {
            try calls.filter { $0.0 == method }.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0.1)) as! [String: Any] }
        }
        func call(_ method: String, _ value: SessionEvent.JSONValue) throws -> SessionEvent.JSONValue {
            calls.append((method, value))
            let params = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
            if let handler { return try Self.json(handler(method, params)) }
            let workspace = params["workspaceId"] as! String
            switch method {
            case "workspace.schedule.list": return try Self.json(["schedules": [Self.record(workspace: workspace, revision: revision, state: cancelled ? "cancelled" : "enabled")], "nextCursor": NSNull()])
            case "workspace.schedule.status":
                if failStatus { throw NSError(domain: "fixture-status", code: 1) }
                return try Self.json(["schedule": Self.record(workspace: workspace, revision: revision, state: cancelled ? "cancelled" : "enabled"), "occurrences": [Self.occurrence(state: cancelled ? "uncertain" : "pending", reason: cancelled ? "recovery_required" : "execution_unavailable")], "execution": "unavailable"])
            case "workspace.schedule.cancel":
                if !cancelled { cancelled = true; revision += 1 }
                if loseCancelReplies > 0 { loseCancelReplies -= 1; throw NSError(domain: "lost-reply", code: 1) }
                return try Self.json(Self.record(workspace: workspace, revision: revision, state: "cancelled"))
            default: throw NSError(domain: "unexpected-execution-method", code: 1)
            }
        }
    }
    func testCanonicalClaimsCoalescingCeilingAndUnavailableExecutionAreRetained() async throws {
        let host = Host()
        host.handler = { method, _ in
            if method == "workspace.schedule.list" { return ["schedules": [Host.record()], "nextCursor": NSNull()] }
            return ["schedule": Host.record(), "occurrences": [Host.occurrence(id: "claimed", state: "claimed", reason: NSNull()), Host.occurrence(id: "uncertain", state: "uncertain", reason: "recovery_required")], "execution": "unavailable"]
        }
        let model = CoworkSchedulesModel { try host.call($0, $1) }
        await model.open(workspaceId: "workspace"); await model.inspect(scheduleId: "schedule")
        let status = try XCTUnwrap(model.status)
        XCTAssertEqual(status.execution, .unavailable); XCTAssertEqual(status.occurrences.map(\.state), [.claimed, .uncertain])
        XCTAssertEqual(status.occurrences.last?.missedCount, 8); XCTAssertEqual(status.occurrences.last?.latestDueAt, 9000)
        guard case let .schedule(row) = status.schedule else { return XCTFail("Expected valid definition") }
        XCTAssertEqual(row.definition.policy, .bypass); XCTAssertEqual(row.definition.sourceId, "source"); XCTAssertEqual(row.definition.savedCeiling.toolClasses, ["read"])
        XCTAssertEqual(host.calls.map(\.0), ["workspace.schedule.list", "workspace.schedule.status"])
    }
    func testLateListCannotReplaceAnotherWorkspaceOrItsBusyState() async {
        let host = Host(), gate = Gate()
        let model = CoworkSchedulesModel { method, params in
            if case let .object(object) = params, object["workspaceId"] == .string("old") { await gate.wait() }
            return try host.call(method, params)
        }
        model.bind(workspaceId: "old"); let old = Task { await model.refresh() }
        while gate.continuation == nil { await Task.yield() }
        await model.open(workspaceId: "new"); gate.release(); await old.value
        XCTAssertEqual(model.workspaceId, "new"); XCTAssertEqual(model.schedules.first?.workspaceId, "new")
        XCTAssertFalse(model.busy); XCTAssertNil(model.error)
    }
    func testReturningToSameIdStillDiscardsPriorGenerationAndStaleRelease() async {
        let host = Host(), gate = Gate(); var suspended = false
        let model = CoworkSchedulesModel { method, params in
            if !suspended {
                suspended = true; await gate.wait()
                return try Host.json(["schedules": [Host.record(revision: 99)], "nextCursor": NSNull()])
            }
            return try host.call(method, params)
        }
        let oldBinding = model.bind(workspaceId: "workspace"), old = Task { await model.refresh() }
        while gate.continuation == nil { await Task.yield() }
        model.bind(workspaceId: nil); let newBinding = model.bind(workspaceId: "workspace")
        await model.refresh(); model.release(oldBinding)
        XCTAssertEqual(model.workspaceId, "workspace"); gate.release(); await old.value
        XCTAssertEqual(model.schedules.first?.revision, 1); model.release(newBinding); XCTAssertNil(model.workspaceId)
    }
    func testLateStatusDoesNotPublishAfterNavigation() async {
        let host = Host(), gate = Gate()
        let model = CoworkSchedulesModel { method, params in
            if method == "workspace.schedule.status" { await gate.wait() }
            return try host.call(method, params)
        }
        await model.open(workspaceId: "workspace"); let old = Task { await model.inspect(scheduleId: "schedule") }
        while gate.continuation == nil { await Task.yield() }
        model.bind(workspaceId: nil); gate.release(); await old.value
        XCTAssertNil(model.status); XCTAssertNil(model.workspaceId); XCTAssertFalse(model.busy)
    }
    func testPagesReplaceRowsAndPreviousPageUsesCanonicalCursor() async throws {
        let host = Host(); host.handler = { _, params in
            if params["cursor"] as? String == "next" { return ["schedules": [Host.record(id: "second")], "nextCursor": NSNull()] }
            return ["schedules": [Host.record(id: "first")], "nextCursor": "next"]
        }
        let model = CoworkSchedulesModel { try host.call($0, $1) }
        await model.open(workspaceId: "workspace"); await model.nextPage()
        XCTAssertEqual(model.schedules.map(\.scheduleId), ["second"]); XCTAssertTrue(model.canGoBack)
        await model.previousPage()
        XCTAssertEqual(model.schedules.map(\.scheduleId), ["first"]); XCTAssertFalse(model.canGoBack)
        let params = try host.params("workspace.schedule.list")
        XCTAssertNil(params[0]["cursor"]); XCTAssertEqual(params[1]["cursor"] as? String, "next"); XCTAssertNil(params[2]["cursor"])
    }
    func testRepeatedCursorDoesNotPublishPartialPage() async {
        let host = Host(); host.handler = { _, params in
            ["schedules": [Host.record(id: params["cursor"] == nil ? "first" : "second")], "nextCursor": "next"]
        }
        let model = CoworkSchedulesModel { try host.call($0, $1) }
        await model.open(workspaceId: "workspace"); await model.nextPage()
        XCTAssertNotNil(model.error); XCTAssertEqual(model.schedules.map(\.scheduleId), ["first"]); XCTAssertFalse(model.canGoBack)
    }
    func testPagingHistoryHasFiniteBoundWithoutAccumulatingScheduleRows() async throws {
        let host = Host(); host.handler = { _, params in
            let cursor = params["cursor"] as? String ?? "cursor-0", number = Int(cursor.dropFirst(7))!
            return ["schedules": [Host.record(id: "schedule-\(number)")], "nextCursor": "cursor-\(number + 1)"]
        }
        let model = CoworkSchedulesModel { try host.call($0, $1) }; await model.open(workspaceId: "workspace")
        for _ in 0..<100 { await model.nextPage() }
        XCTAssertEqual(model.schedules.map(\.scheduleId), ["schedule-100"])
        await model.nextPage()
        XCTAssertNotNil(model.error); XCTAssertEqual(try host.params("workspace.schedule.list").count, 101)
        XCTAssertEqual(model.schedules.count, 1)
    }
    func testOversizedResponseDoesNotPublishAnyRecord() async {
        let host = Host(); host.handler = { _, _ in
            var row = Host.record(), definition = row["definition"] as! [String: Any]
            definition["prompt"] = String(repeating: "x", count: 300 * 1024); row["definition"] = definition
            return ["schedules": [row], "nextCursor": NSNull()]
        }
        let model = CoworkSchedulesModel { try host.call($0, $1) }; await model.open(workspaceId: "workspace")
        XCTAssertNotNil(model.error); XCTAssertTrue(model.schedules.isEmpty); XCTAssertFalse(model.busy)
    }
    func testCrossWorkspaceAndDuplicateListRowsAreRejected() async {
        for rows in [[Host.record(workspace: "other")], [Host.record(), Host.record()]] {
            let host = Host(); host.handler = { _, _ in ["schedules": rows, "nextCursor": NSNull()] }
            let model = CoworkSchedulesModel { try host.call($0, $1) }; await model.open(workspaceId: "workspace")
            XCTAssertTrue(model.schedules.isEmpty); XCTAssertNotNil(model.error)
        }
    }
    func testMismatchedOrDuplicateStatusOccurrencesAreRejected() async {
        for rows in [[Host.occurrence(schedule: "other")], [Host.occurrence(), Host.occurrence()]] {
            let host = Host(); host.handler = { method, _ in
                if method == "workspace.schedule.list" { return ["schedules": [Host.record()], "nextCursor": NSNull()] }
                return ["schedule": Host.record(), "occurrences": rows, "execution": "unavailable"]
            }
            let model = CoworkSchedulesModel { try host.call($0, $1) }; await model.open(workspaceId: "workspace"); await model.inspect(scheduleId: "schedule")
            XCTAssertNil(model.status); XCTAssertNotNil(model.error)
        }
    }
    func testStatusRefreshUpdatesVisibleRevisionAndRejectsRollback() async throws {
        let host = Host(); var statusRevision = 2
        host.handler = { method, _ in
            if method == "workspace.schedule.list" { return ["schedules": [Host.record()], "nextCursor": NSNull()] }
            return ["schedule": Host.record(revision: statusRevision, state: "cancelled"), "occurrences": [], "execution": "unavailable"]
        }
        let model = CoworkSchedulesModel { try host.call($0, $1) }, binding = model.bind(workspaceId: "workspace")
        await model.refresh(); await model.inspect(scheduleId: "schedule")
        XCTAssertEqual(model.schedules.first?.revision, 2); XCTAssertTrue(model.schedules.first?.isCancelled == true)
        await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
        XCTAssertTrue(try host.params("workspace.schedule.cancel").isEmpty)
        statusRevision = 1; await model.inspect(scheduleId: "schedule")
        XCTAssertNil(model.status); XCTAssertNotNil(model.error); XCTAssertEqual(model.schedules.first?.revision, 2)
    }
    func testLostCancellationReplyReplaysExactRevisionWithoutRequestIdOrExecution() async throws {
        let host = Host(); host.loseCancelReplies = 1
        let model = CoworkSchedulesModel { try host.call($0, $1) }, binding = model.bind(workspaceId: "workspace")
        await model.refresh(); await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
        XCTAssertNil(model.lastCancellation); XCTAssertTrue(model.error?.hasPrefix("Cancellation not confirmed") == true)
        await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
        XCTAssertEqual(model.lastCancellation?.revision, 2); XCTAssertTrue(model.lastCancellation?.isCancelled == true)
        let calls = try host.params("workspace.schedule.cancel")
        XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0]["expectedRevision"] as? Int, 1); XCTAssertEqual(calls[1]["expectedRevision"] as? Int, 1)
        XCTAssertNil(calls[0]["requestId"]); XCTAssertNil(calls[1]["requestId"])
        XCTAssertTrue(host.calls.allSatisfy { ["workspace.schedule.list", "workspace.schedule.status", "workspace.schedule.cancel"].contains($0.0) })
    }
    func testConfirmedCancellationSurvivesStatusFailure() async {
        let host = Host(); host.failStatus = true
        let model = CoworkSchedulesModel { try host.call($0, $1) }, binding = model.bind(workspaceId: "workspace")
        await model.refresh(); await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
        XCTAssertEqual(model.lastCancellation?.revision, 2); XCTAssertTrue(model.schedules.first?.isCancelled == true)
        XCTAssertNil(model.status); XCTAssertTrue(model.error?.hasPrefix("Cancellation recorded; status refresh failed") == true)
        host.failStatus = false; await model.inspect(scheduleId: "schedule")
        XCTAssertEqual(model.status?.occurrences.first?.state, .uncertain); XCTAssertNil(model.error)
    }
    func testLateCancellationReceiptDoesNotPopulateNewWorkspace() async throws {
        let host = Host(), gate = Gate()
        let model = CoworkSchedulesModel { method, params in
            if method == "workspace.schedule.cancel" { await gate.wait() }
            return try host.call(method, params)
        }, binding = model.bind(workspaceId: "workspace")
        await model.refresh(); let old = Task { await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding) }
        while gate.continuation == nil { await Task.yield() }
        model.bind(workspaceId: "new"); gate.release(); await old.value
        XCTAssertNil(model.lastCancellation); XCTAssertNil(model.status); XCTAssertTrue(model.schedules.isEmpty)
        XCTAssertEqual(try host.params("workspace.schedule.status").count, 0); XCTAssertFalse(model.busy)
    }
    func testOldConfirmationAndChangedRevisionCannotCancelNewBinding() async throws {
        let host = Host(), model = CoworkSchedulesModel { try host.call($0, $1) }
        let old = model.bind(workspaceId: "workspace"); await model.refresh()
        let current = model.bind(workspaceId: "workspace"); await model.refresh()
        await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: old)
        await model.cancel(scheduleId: "schedule", expectedRevision: 9, binding: current)
        XCTAssertTrue(try host.params("workspace.schedule.cancel").isEmpty)
    }
    func testWorkspaceSelectionImmediatelyInvalidatesScheduleConfirmation() async throws {
        let host = Host(), gate = Gate()
        let workspace = CoworkWorkspaceModel { method, params in
            if method.hasPrefix("workspace.schedule.") { return try host.call(method, params) }
            await gate.wait(); throw NSError(domain: "fixture-detail-unavailable", code: 1)
        }
        let schedules = workspace.schedules, binding = schedules.bind(workspaceId: "workspace")
        await schedules.refresh(); let selection = Task { await workspace.select("other") }
        while gate.continuation == nil { await Task.yield() }
        XCTAssertNil(schedules.workspaceId); XCTAssertTrue(schedules.schedules.isEmpty)
        await schedules.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
        XCTAssertTrue(try host.params("workspace.schedule.cancel").isEmpty)
        gate.release(); await selection.value
    }
    func testCancellationIsSerializedWhileAwaitingReceipt() async throws {
        let host = Host(), gate = Gate()
        let model = CoworkSchedulesModel { method, params in
            if method == "workspace.schedule.cancel" { await gate.wait() }
            return try host.call(method, params)
        }, binding = model.bind(workspaceId: "workspace")
        await model.refresh(); let first = Task { await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding) }
        while gate.continuation == nil { await Task.yield() }
        await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
        XCTAssertTrue(model.busy); gate.release(); await first.value
        XCTAssertEqual(try host.params("workspace.schedule.cancel").count, 1); XCTAssertFalse(model.busy)
    }
    func testInvalidCancellationReceiptDoesNotClaimSuccess() async {
        for receipt in [Host.record(workspace: "other", revision: 2, state: "cancelled"), Host.record(id: "other", revision: 2, state: "cancelled"), Host.record(revision: 3, state: "cancelled"), Host.record(revision: 2, state: "enabled")] {
            let host = Host(); host.handler = { method, _ in method == "workspace.schedule.list" ? ["schedules": [Host.record()], "nextCursor": NSNull()] : receipt }
            let model = CoworkSchedulesModel { try host.call($0, $1) }, binding = model.bind(workspaceId: "workspace")
            await model.refresh(); await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
            XCTAssertNil(model.lastCancellation); XCTAssertFalse(model.schedules.first?.isCancelled ?? true)
            XCTAssertTrue(model.error?.hasPrefix("Cancellation not confirmed") == true)
        }
    }
    func testPostCancellationStatusCannotRollBackConfirmedRevision() async {
        let host = Host(); host.handler = { method, _ in
            switch method {
            case "workspace.schedule.list": ["schedules": [Host.record()], "nextCursor": NSNull()]
            case "workspace.schedule.cancel": Host.record(revision: 2, state: "cancelled")
            default: ["schedule": Host.record(), "occurrences": [], "execution": "unavailable"]
            }
        }
        let model = CoworkSchedulesModel { try host.call($0, $1) }, binding = model.bind(workspaceId: "workspace")
        await model.refresh(); await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
        XCTAssertEqual(model.lastCancellation?.revision, 2); XCTAssertNil(model.status)
        XCTAssertTrue(model.error?.hasPrefix("Cancellation recorded; status refresh failed") == true)
    }
    func testHandledAndQuarantinedSchedulesCanBeCancelledWithoutReadingInvalidDefinition() async {
        for row in [Host.record(state: "handled"), ["scheduleId": "schedule", "workspaceId": "workspace", "revision": 1, "state": "quarantined", "createdAt": 0, "nextDue": NSNull(), "reason": "invalid_schedule", "cancelled": false]] {
            let host = Host(); host.handler = { method, _ in
                switch method {
                case "workspace.schedule.list": return ["schedules": [row], "nextCursor": NSNull()]
                case "workspace.schedule.cancel": var result = row; result["revision"] = 2; if row["state"] as? String == "quarantined" { result["cancelled"] = true } else { result["state"] = "cancelled" }; return result
                default: var result = row; result["revision"] = 2; if row["state"] as? String == "quarantined" { result["cancelled"] = true } else { result["state"] = "cancelled" }; return ["schedule": result, "occurrences": [], "execution": "unavailable"]
                }
            }
            let model = CoworkSchedulesModel { try host.call($0, $1) }, binding = model.bind(workspaceId: "workspace")
            await model.refresh(); await model.cancel(scheduleId: "schedule", expectedRevision: 1, binding: binding)
            XCTAssertTrue(model.lastCancellation?.isCancelled == true); XCTAssertNil(model.error)
        }
    }
}
