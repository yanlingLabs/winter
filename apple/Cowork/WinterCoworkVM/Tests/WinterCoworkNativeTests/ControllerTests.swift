import XCTest
import Foundation
import Darwin
@testable import WinterCoworkNative

final class ControllerTests: XCTestCase {
    private let scope = NativeScope(workspaceId: "fixture-workspace", incarnationId: "fixture-incarnation", grantRevision: 7, leaseEpoch: 4)
    private func json(_ kind: String, fields: [String: Any] = [:], scope: NativeScope? = nil) throws -> String {
        let encoded = try JSONEncoder().encode(scope ?? self.scope)
        var value = fields; value["kind"] = kind; value["scope"] = try JSONSerialization.jsonObject(with: encoded)
        return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
    private func events(_ controller: NativeController, terminalIDs: Set<UInt64>, timeout: Int = 2000) async throws -> [NativeEvent] {
        var collected: [NativeEvent] = [], seen: Set<UInt64> = []
        for _ in 0..<timeout {
            while let text = controller.events.pollJSON() {
                let event = try JSONDecoder().decode(NativeEvent.self, from: Data(text.utf8))
                collected.append(event)
                if event.kind == .terminal, let id = UInt64(event.operationId) { seen.insert(id) }
            }
            if terminalIDs.isSubset(of: seen) { return collected }
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("missing native terminal events"); return collected
    }
    private func start(_ controller: NativeController) async throws {
        let id = controller.submit(try json("start"))
        let rows = try await events(controller, terminalIDs: [id])
        XCTAssertEqual(rows.last?.terminalStatus, .completed)
    }

    func testScopeRevisionAndLeaseCannotBeInventedByRequest() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend())
        let forged = NativeScope(workspaceId: scope.workspaceId, incarnationId: scope.incarnationId, grantRevision: 8, leaseEpoch: 4)
        let id = controller.submit(try json("start", scope: forged))
        let rows = try await events(controller, terminalIDs: [id])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.last?.code, "stale_authority")
        XCTAssertEqual(rows.last?.scope, scope)
    }

    func testConcurrentExecAndIndependentTaskCancellation() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend(delayMilliseconds: 2))
        try await start(controller)
        let first = controller.submit(try json("exec", fields: ["taskId": "first", "arguments": ["long", "one"]]))
        let second = controller.submit(try json("exec", fields: ["taskId": "second", "arguments": ["echo", "two"]]))
        try await Task.sleep(for: .milliseconds(10))
        let wrong = controller.submit(try json("cancel", fields: ["taskId": "second", "ownerOperationId": String(first)]))
        let right = controller.submit(try json("cancel", fields: ["taskId": "first", "ownerOperationId": String(first)]))
        let rows = try await events(controller, terminalIDs: [first, second, wrong, right])
        XCTAssertEqual(rows.first { $0.operationId == String(wrong) && $0.kind == .terminal }?.code, "task_ownership_denied")
        XCTAssertEqual(rows.first { $0.operationId == String(first) && $0.kind == .terminal }?.terminalStatus, .cancelled)
        XCTAssertEqual(rows.first { $0.operationId == String(second) && $0.kind == .terminal }?.terminalStatus, .completed)
        XCTAssertEqual(rows.filter { $0.operationId == String(first) && $0.kind == .terminal }.count, 1)
    }

    func testBoundedInputFlowsToOnlyItsOwner() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend())
        try await start(controller)
        let owner = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["wait-input"]]))
        try await Task.sleep(for: .milliseconds(10))
        let input = controller.submit(try json("input", fields: ["taskId": "owner", "ownerOperationId": String(owner), "inputBase64": Data("transport".utf8).base64EncodedString()]))
        _ = try await events(controller, terminalIDs: [input])
        let close = controller.submit(try json("closeInput", fields: ["taskId": "owner", "ownerOperationId": String(owner)]))
        let rows = try await events(controller, terminalIDs: [owner, close])
        let output = rows.filter { $0.operationId == String(owner) && $0.kind == .stdout }.compactMap { $0.dataBase64 }.compactMap { Data(base64Encoded: $0) }
        XCTAssertEqual(String(decoding: output.reduce(into: Data()) { $0.append($1) }, as: UTF8.self), "transport")
    }

    func testUncertainStopClosesAllExecutionAdmission() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend(stopUncertain: true))
        try await start(controller)
        let stop = controller.submit(try json("stop"))
        let rows = try await events(controller, terminalIDs: [stop])
        XCTAssertEqual(rows.last?.terminalStatus, .uncertain)
        let exec = controller.submit(try json("exec", fields: ["taskId": "later", "arguments": ["echo"]]))
        let refused = try await events(controller, terminalIDs: [exec])
        XCTAssertEqual(refused.last?.code, "controller_draining")
        XCTAssertFalse(controller.lifetime.canRelease())
    }

    func testOutputBackpressurePreservesTerminalReservationAndAllocationRetry() throws {
        let channel = try NativeEventChannel(scope: scope, operationLimit: 1, outputLimit: 4)
        let id = try XCTUnwrap(channel.reserve())
        try channel.emit(id, kind: .stdout, bytes: [1, 2, 3, 4])
        XCTAssertThrowsError(try channel.emit(id, kind: .stdout, bytes: [5]))
        try channel.emit(id, kind: .terminal, status: .failed, code: "output_backpressure")
        XCTAssertNil(channel.pollAllocated { _ in nil })
        XCTAssertNil(channel.reserve())
        XCTAssertNotNil(channel.pollJSON()); XCTAssertNotNil(channel.pollJSON())
        XCTAssertNotNil(channel.reserve())
    }

    func testProductionDefaultRefusesCreationWithoutReadingAnyHostPath() async throws {
        let controller = try NativeController(scope: scope, backend: BlockedWorkspaceBackend())
        let id = controller.submit(try json("start"))
        let rows = try await events(controller, terminalIDs: [id])
        XCTAssertEqual(rows.last?.code, "cowork_gate_blocked")
    }

    func testRealVZBackendDefaultAdmissionRefusesBeforeArtifactAccess() async throws {
        let artifact = HostArtifact(path: "/intentionally-unavailable-native-test-artifact", sha256: String(repeating: "0", count: 64), identity: HostFileIdentity(device: 0, inode: 0))
        let descriptor = HostLaunchDescriptor(scope: scope, homeId: "fixture-home", ownerNonce: "fixture-owner", ownedStorageRoot: "/intentionally-unavailable-native-test-storage", rootfs: artifact, kernel: artifact, initfs: artifact, shares: [], supervisorArguments: ["/immutable/supervisor"], memoryCeilingBytes: 1024 * 1024 * 1024, virtualCPUs: 2)
        let backend = VZWorkspaceBackend(descriptor: descriptor)
        do { try await backend.start(); XCTFail("Default real backend must refuse before file access") }
        catch let failure as NativeFailure { XCTAssertEqual(failure.code, "cowork_gate_blocked") }
    }

    func testCABIReleaseRequiresConfirmedShutdownAndConsumedTerminals() async throws {
        let options = "{\"backend\":\"fake\",\"scope\":{\"protocolVersion\":1,\"workspaceId\":\"fixture-workspace\",\"incarnationId\":\"fixture-incarnation\",\"grantRevision\":7,\"leaseEpoch\":4}}"
        let handle = try XCTUnwrap(options.withCString { nativeCreate($0, UInt32(options.utf8.count)) })
        XCTAssertEqual(nativeRelease(handle), 0)
        XCTAssertGreaterThanOrEqual(nativeEventFD(handle), 0)
        XCTAssertNotEqual(nativeShutdown(handle, 1000), 0)
        for _ in 0..<200 {
            while let text = nativePoll(handle) { nativeStringFree(text) }
            if nativeRelease(handle) == 1 { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("confirmed fake controller did not release")
    }

    func testStopWaitsForPendingStartBeforeConfirmingTermination() async throws {
        let backend = BarrierBackend()
        let controller = try NativeController(scope: scope, backend: backend)
        let start = controller.submit(try json("start"))
        for _ in 0..<200 { if await backend.entered { break }; try await Task.sleep(for: .milliseconds(1)) }
        let stop = controller.submit(try json("stop", fields: ["stopBudgetMilliseconds": 1000]))
        try await Task.sleep(for: .milliseconds(10))
        let before = await backend.stops
        XCTAssertEqual(before, 0)
        await backend.finishStart()
        let rows = try await events(controller, terminalIDs: [start, stop])
        XCTAssertEqual(rows.first { $0.kind == .terminal && $0.operationId == String(start) }?.code, "start_interrupted")
        XCTAssertEqual(rows.first { $0.kind == .terminal && $0.operationId == String(stop) }?.terminalStatus, .completed)
        let after = await backend.stops
        XCTAssertEqual(after, 1)
    }

    func testStopBudgetProducesOneUncertainTerminalAndRetainsLateCleanup() async throws {
        let controller = try NativeController(scope: scope, backend: SlowStopBackend())
        try await start(controller)
        let stop = controller.submit(try json("stop", fields: ["stopBudgetMilliseconds": 1]))
        let rows = try await events(controller, terminalIDs: [stop])
        XCTAssertEqual(rows.last?.terminalStatus, .uncertain)
        XCTAssertEqual(rows.last?.code, "stop_budget_exhausted")
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertNil(controller.events.pollJSON())
        let state = await controller.state()
        XCTAssertEqual(state, .closed)
        XCTAssertTrue(controller.lifetime.canRelease())
    }

    func testCancellationCannotMaskUncertainProcessCreation() async throws {
        let backend = UncertainCreationBackend()
        let controller = try NativeController(scope: scope, backend: backend)
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["fixture"]]))
        for _ in 0..<200 { if await backend.entered { break }; try await Task.sleep(for: .milliseconds(1)) }
        let cancel = controller.submit(try json("cancel", fields: ["taskId": "owner", "ownerOperationId": String(exec)]))
        _ = try await events(controller, terminalIDs: [cancel])
        await backend.failCreation()
        let rows = try await events(controller, terminalIDs: [exec])
        XCTAssertEqual(rows.last?.terminalStatus, .uncertain)
        let state = await controller.state(); XCTAssertEqual(state, .uncertain)
        let next = controller.submit(try json("exec", fields: ["taskId": "next", "arguments": ["fixture"]]))
        let refused = try await events(controller, terminalIDs: [next])
        XCTAssertEqual(refused.last?.code, "controller_draining")
        XCTAssertFalse(controller.lifetime.canRelease())
    }

    func testExecutionSaturationPreservesCancelAndShutdownCapacity() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend())
        try await start(controller)
        var running = Set<UInt64>()
        for _ in 0..<128 {
            let id = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["wait-input"]]))
            XCTAssertNotEqual(id, 0); running.insert(id)
        }
        XCTAssertEqual(controller.submit(try json("capabilities")), 0)
        try await Task.sleep(for: .milliseconds(20))
        let cancel = controller.submit(try json("cancel", fields: ["taskId": "owner", "ownerOperationId": String(running.first!)]))
        let stop = controller.submit(try json("shutdown"))
        XCTAssertNotEqual(cancel, 0); XCTAssertNotEqual(stop, 0)
        let rows = try await events(controller, terminalIDs: running.union([cancel, stop]))
        XCTAssertEqual(rows.first { $0.operationId == String(stop) && $0.kind == .terminal }?.terminalStatus, .completed)
        XCTAssertEqual(rows.filter { $0.kind == .terminal }.count, 130)
    }

    func testCleanupDoesNotDependOnShutdownReceiptCapacity() async throws {
        let backend = BarrierBackend()
        let controller = try NativeController(scope: scope, backend: backend)
        // Simulate an unconsumed shutdown receipt; cleanup still reaches the backend.
        XCTAssertNotNil(controller.events.reserve(.shutdown))
        controller.requestCleanup()
        for _ in 0..<200 { if await backend.stops == 1 { break }; try await Task.sleep(for: .milliseconds(1)) }
        let stops = await backend.stops; XCTAssertEqual(stops, 1)
        let state = await controller.state(); XCTAssertEqual(state, .closed)
        // Retained event ownership still prevents a C ABI release.
        XCTAssertEqual(controller.events.counts().operations, 1)
    }

    func testUnrelatedRefusalDoesNotPoisonPendingStart() async throws {
        let backend = BarrierBackend(), controller = try NativeController(scope: scope, backend: backend)
        let start = controller.submit(try json("start"))
        for _ in 0..<200 { if await backend.entered { break }; try await Task.sleep(for: .milliseconds(1)) }
        let wrong = NativeScope(workspaceId: "wrong", incarnationId: scope.incarnationId, grantRevision: 7, leaseEpoch: 4)
        let stale = controller.submit(try json("stats", scope: wrong))
        let malformed = controller.submit("{")
        _ = try await events(controller, terminalIDs: [stale, malformed])
        let during = await controller.state(); XCTAssertEqual(during, .starting)
        await backend.finishStart()
        let rows = try await events(controller, terminalIDs: [start])
        XCTAssertEqual(rows.last?.terminalStatus, .completed)
        let after = await controller.state(); XCTAssertEqual(after, .running)
    }

    func testRepeatedOutputFailuresScheduleOnlyOneCancellation() throws {
        let failure = OutputFailure(), cancellations = LockedCounter()
        let writer = OutputWriter(kind: .stdout, output: { _, _ in throw NativeFailure("output_backpressure", "fixture") }, failure: failure, cancel: { cancellations.increment() })
        DispatchQueue.concurrentPerform(iterations: 1024) { _ in
            do { try writer.write(Data([1])); XCTFail("Output must stay failed") } catch { }
        }
        XCTAssertEqual(cancellations.value, 1)
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() { lock.lock(); count += 1; lock.unlock() }
}

private actor UncertainCreationBackend: NativeWorkspaceBackend {
    private var pending: CheckedContinuation<Void, Never>?
    private(set) var entered = false
    func start() async throws {}
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess {
        entered = true; await withCheckedContinuation { pending = $0 }
        throw NativeFailure("process_creation_uncertain", "Fixture uncertain creation after cancellation")
    }
    func failCreation() { pending?.resume(); pending = nil }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { BackendStopResult(terminationConfirmed: false, flushConfirmed: false) }
}

private actor BarrierBackend: NativeWorkspaceBackend {
    private var pending: CheckedContinuation<Void, Never>?
    private(set) var entered = false
    private(set) var stops = 0
    func start() async throws { entered = true; await withCheckedContinuation { pending = $0 } }
    func finishStart() { pending?.resume(); pending = nil }
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { throw NativeFailure("unused", "Unused test path") }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { stops += 1; return BackendStopResult(terminationConfirmed: true, flushConfirmed: true) }
}
private struct SlowStopBackend: NativeWorkspaceBackend {
    func start() async throws {}
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { throw NativeFailure("unused", "Unused test path") }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { try await Task.sleep(for: .milliseconds(50)); return BackendStopResult(terminationConfirmed: true, flushConfirmed: true) }
}
