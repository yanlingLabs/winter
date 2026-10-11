import XCTest
import Foundation
import Darwin
@testable import WinterCoworkPrimitives
import Containerization
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
        let descriptor = HostLaunchDescriptor(scope: scope, compiledGraph: NativeCompiledGraph.identity, homeId: "fixture-home", currentHostHome: HostProtectedHome(homeId: "fixture-home", path: "/unavailable-fixture-home", identity: HostFileIdentity(device: 0, inode: 0)), protectedHomes: [], managedSharedDirectories: [], ownerNonce: "fixture-owner", ownedStorageRoot: "/intentionally-unavailable-native-test-storage", rootfs: artifact, kernel: artifact, initfs: artifact, shares: [], supervisorArguments: ["/immutable/supervisor"], memoryCeilingBytes: 1024 * 1024 * 1024, virtualCPUs: 2)
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
        // Wait for actual admission without a timing sleep; pending cancel
        // cannot acknowledge until the target construction/cleanup concludes.
        var cancellationAccepted = false
        for _ in 0..<10000 {
            if let text = controller.events.pollJSON() {
                let event = try JSONDecoder().decode(NativeEvent.self, from: Data(text.utf8))
                if event.operationId == String(cancel) && event.kind == .accepted { cancellationAccepted = true; break }
            }
            await Task.yield()
        }
        XCTAssertTrue(cancellationAccepted)
        await backend.failCreation()
        let rows = try await events(controller, terminalIDs: [exec, cancel])
        XCTAssertEqual(rows.first { $0.operationId == String(exec) && $0.kind == .terminal }?.terminalStatus, .uncertain)
        XCTAssertEqual(rows.first { $0.operationId == String(cancel) && $0.kind == .terminal }?.terminalStatus, .uncertain)
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

    func testImmediateCloseInputCannotOvertakeReservedExec() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend())
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["wait-input"]]))
        let close = controller.submit(try json("closeInput", fields: ["taskId": "owner", "ownerOperationId": String(exec)]))
        let rows = try await events(controller, terminalIDs: [exec, close])
        XCTAssertEqual(rows.first { $0.operationId == String(close) && $0.kind == .terminal }?.terminalStatus, .completed)
        XCTAssertEqual(rows.first { $0.operationId == String(exec) && $0.kind == .terminal }?.terminalStatus, .completed)
    }
    func testImmediateCancellationCannotOvertakeReservedExec() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend())
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["wait-input"]]))
        let cancel = controller.submit(try json("cancel", fields: ["taskId": "owner", "ownerOperationId": String(exec)]))
        let rows = try await events(controller, terminalIDs: [exec, cancel])
        XCTAssertEqual(rows.first { $0.operationId == String(cancel) && $0.kind == .terminal }?.terminalStatus, .completed)
        XCTAssertEqual(rows.first { $0.operationId == String(exec) && $0.kind == .terminal }?.terminalStatus, .cancelled)
    }
    func testStopDrainsCleanupBeforeConfirmationAndCannotBeRepoisoned() async throws {
        let backend = CleanupBarrierBackend(), controller = try NativeController(scope: scope, backend: backend)
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["fixture"]]))
        await backend.processValue.entered.wait()
        let stop = controller.submit(try json("stop"))
        await backend.processValue.cancellation.wait()
        let before = await backend.stops; XCTAssertEqual(before, 0)
        await backend.processValue.finish.open()
        let rows = try await events(controller, terminalIDs: [exec, stop])
        XCTAssertEqual(rows.first { $0.operationId == String(exec) && $0.kind == .terminal }?.terminalStatus, .uncertain)
        XCTAssertEqual(rows.first { $0.operationId == String(stop) && $0.kind == .terminal }?.terminalStatus, .completed)
        let state = await controller.state(); XCTAssertEqual(state, .closed)
        XCTAssertTrue(controller.lifetime.canRelease())
    }
    func testRegisteredCancellationWaitsForOwnerAndPreservesUncertainCleanup() async throws {
        let backend = CleanupBarrierBackend(), controller = try NativeController(scope: scope, backend: backend)
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["fixture"]]))
        await backend.processValue.entered.wait()
        let cancel = controller.submit(try json("cancel", fields: ["taskId": "owner", "ownerOperationId": String(exec)]))
        await backend.processValue.cancellation.wait()
        var before: [NativeEvent] = []
        while let text = controller.events.pollJSON() {
            before.append(try JSONDecoder().decode(NativeEvent.self, from: Data(text.utf8)))
        }
        XCTAssertFalse(before.contains { $0.operationId == String(cancel) && $0.kind == .terminal })
        await backend.processValue.finish.open()
        let rows = try await events(controller, terminalIDs: [exec, cancel])
        XCTAssertEqual(rows.first { $0.operationId == String(exec) && $0.kind == .terminal }?.terminalStatus, .uncertain)
        let receipt = rows.first { $0.operationId == String(cancel) && $0.kind == .terminal }
        XCTAssertEqual(receipt?.terminalStatus, .uncertain)
        XCTAssertEqual(receipt?.result?["cleanupConfirmed"], "false")
    }
    func testGracefulInputCloseDrainsEveryAcknowledgedChunkBeforeEOF() async throws {
        let input = BoundedInput(), ready = TestLatch(), consume = TestLatch()
        let received = Task { () -> Data in
            await ready.open(); await consume.wait()
            var bytes = Data()
            for await chunk in input.stream() { bytes.append(chunk) }
            return bytes
        }
        await ready.wait()
        try input.write(Data("first".utf8)); try input.write(Data("second".utf8))
        input.close()
        XCTAssertThrowsError(try input.write(Data("late".utf8)))
        await consume.open()
        let bytes = await received.value
        XCTAssertEqual(bytes, Data("firstsecond".utf8))
    }
    func testOutputFloodCannotConsumeAnotherOperationsQuota() throws {
        let channel = try NativeEventChannel(scope: scope, operationLimit: 2, outputLimit: 8)
        let first = try XCTUnwrap(channel.reserve()), second = try XCTUnwrap(channel.reserve())
        try channel.emit(first, kind: .stdout, bytes: [1,2,3,4])
        XCTAssertThrowsError(try channel.emit(first, kind: .stdout, bytes: [5]))
        try channel.emit(second, kind: .stdout, bytes: [6,7,8,9])
        try channel.emit(first, kind: .terminal, status: .failed)
        try channel.emit(second, kind: .terminal, status: .completed)
        XCTAssertEqual(channel.counts().outputBytes, 8)
    }
    func testSharesRejectRootHomeOverlapAndNoncanonicalGuestPaths() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("winter-share-review-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let protected = root.appendingPathComponent("winter-home")
        try FileManager.default.createDirectory(at: protected, withIntermediateDirectories: true)
        XCTAssertThrowsError(try SharePolicy.validate([.init(sourcePath: "/", guestPath: "/workspace/source", readOnly: true)], backing: []))
        XCTAssertThrowsError(try SharePolicy.validate([.init(sourcePath: root.path, guestPath: "/workspace/source", readOnly: true)], backing: [], protectedHostRoots: [protected.path]))
        for guest in ["/", "/workspace/source/../.winter", "/workspace//source", "/opt/runtime", "/workspace/source/"] {
            XCTAssertThrowsError(try SharePolicy.validate([.init(sourcePath: root.path, guestPath: guest, readOnly: true)], backing: []))
        }
        XCTAssertNoThrow(try SharePolicy.validate([.init(sourcePath: root.path, guestPath: "/workspace/source", readOnly: true)], backing: []))
    }
    func testTypedProbeFailureSurvivesNativeTerminalMapping() async throws {
        let controller = try NativeController(scope: scope, backend: ValidationFailureBackend())
        let id = controller.submit(try json("start")), rows = try await events(controller, terminalIDs: [id])
        XCTAssertEqual(rows.last?.code, "unsafe_share")
    }
    func testNeverCreatedLaunchFailureCanReleaseAfterReceipts() async throws {
        let controller = try NativeController(scope: scope, backend: NeverCreatedBackend())
        let id = controller.submit(try json("start")), rows = try await events(controller, terminalIDs: [id])
        XCTAssertEqual(rows.last?.code, "artifact_digest_mismatch")
        let state = await controller.state(); XCTAssertEqual(state, .closed)
        XCTAssertTrue(controller.lifetime.canRelease())
    }

    func testRepeatedConfirmedStopPreservesReleaseState() async throws {
        let controller = try NativeController(scope: scope, backend: FakeWorkspaceBackend())
        try await start(controller)
        let first = controller.submit(try json("stop")); _ = try await events(controller, terminalIDs: [first])
        let second = controller.submit(try json("stop")); let rows = try await events(controller, terminalIDs: [second])
        XCTAssertEqual(rows.last?.terminalStatus, .completed)
        let state = await controller.state(); XCTAssertEqual(state, .closed)
        XCTAssertTrue(controller.lifetime.canRelease())
    }

    func testExactManagedShareRecordAllowsOnlyRoleIdentityChild() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("winter-managed-share-" + UUID().uuidString).resolvingSymlinksInPath()
        let memory = home.appendingPathComponent("shared/memory")
        try FileManager.default.createDirectory(at: memory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        var info = stat(); XCTAssertEqual(lstat(memory.path, &info), 0)
        let record = HostManagedShareRecord(path: memory.path, role: .memory, device: UInt64(bitPattern: Int64(info.st_dev)), inode: info.st_ino)
        let share = HostSharePolicy(sourcePath: memory.path, guestPath: "/workspace/.winter/memory", readOnly: false, managedRole: .memory)
        XCTAssertNoThrow(try SharePolicy.validate([share], backing: [], protectedHostRoots: [home.path], managedShares: [record]))
        XCTAssertThrowsError(try SharePolicy.validate([share], backing: [], protectedHostRoots: [home.path]))
        XCTAssertThrowsError(try SharePolicy.validate([share], backing: [], protectedHostRoots: [home.path], managedShares: [.init(path: memory.path, role: .memory, device: record.device, inode: 0)]))
        XCTAssertThrowsError(try SharePolicy.validate([.init(sourcePath: home.path, guestPath: "/workspace/.winter/memory", readOnly: false, managedRole: .memory)], backing: [], protectedHostRoots: [home.path], managedShares: [.init(path: home.path, role: .memory, device: record.device, inode: record.inode)]))
        XCTAssertThrowsError(try SharePolicy.validate([.init(sourcePath: memory.path, guestPath: "/workspace/outputs", readOnly: false, managedRole: .memory)], backing: [], protectedHostRoots: [home.path], managedShares: [record]))
        XCTAssertThrowsError(try SharePolicy.validate([.init(sourcePath: memory.path, guestPath: "/run/winter/shared-instructions", readOnly: false, managedRole: .instructions)], backing: [], protectedHostRoots: [home.path], managedShares: [.init(path: memory.path, role: .instructions, device: record.device, inode: record.inode)]))
    }

    func testOutputProofRunsBeforeDeleteAndFailureKeepsTypedCode() async throws {
        let process = IOProofFixtureProcess()
        do {
            _ = try await ProcessLifecycle.run(process, timeout: 1, afterWait: {
                await process.record("output-proof")
                throw ProbeFailure(code: "output_completion_unproven", message: "Fixture EOF was not observed")
            })
            XCTFail("Unproved output must fail visibly")
        } catch let failure as ProcessRunFailure {
            XCTAssertEqual(failure.originalCode, "output_completion_unproven")
            XCTAssertFalse(failure.cleanupUncertain)
        }
        let calls = await process.calls
        XCTAssertEqual(calls, ["start", "wait", "output-proof", "kill", "wait", "delete"])
    }

    func testRealPreconstructionRefusalDoesNotRetainPhantomVM() async throws {
        let admission = FixtureHostAdmission()
        let artifact = HostArtifact(path: "/intentionally-unavailable-native-review-artifact", sha256: String(repeating: "0", count: 64), identity: .init(device: 0, inode: 0))
        let descriptor = HostLaunchDescriptor(scope: scope, compiledGraph: NativeCompiledGraph.identity, homeId: "fixture-home", currentHostHome: .init(homeId: "fixture-home", path: "/unavailable-fixture-home", identity: .init(device: 0, inode: 0)), protectedHomes: [], managedSharedDirectories: [], ownerNonce: "fixture-owner", ownedStorageRoot: "/intentionally-unavailable-native-review-storage", rootfs: artifact, kernel: artifact, initfs: artifact, shares: [], supervisorArguments: ["/immutable/supervisor"], memoryCeilingBytes: 1024 * 1024 * 1024, virtualCPUs: 1)
        let backend = VZWorkspaceBackend(descriptor: descriptor, admission: admission)
        do { try await backend.start(); XCTFail("Fixture must refuse before construction") }
        catch let failure as NativeFailure { XCTAssertTrue(failure.launchNeverCreated) }
        let retained = await admission.retained; XCTAssertEqual(retained, 0)
        let result = try await backend.stop(); XCTAssertTrue(result.terminationConfirmed)
    }

    func testUnconfirmedFlushPreventsNativeRelease() async throws {
        let controller = try NativeController(scope: scope, backend: FlushUncertainBackend())
        try await start(controller)
        let stop = controller.submit(try json("stop")), rows = try await events(controller, terminalIDs: [stop])
        XCTAssertEqual(rows.last?.terminalStatus, .uncertain)
        let state = await controller.state(); XCTAssertEqual(state, .uncertain)
        XCTAssertFalse(controller.lifetime.canRelease())
    }

    func testCancellationCannotHideUnprovedOutputCompletion() async throws {
        let backend = OutputUnprovedBackend(), controller = try NativeController(scope: scope, backend: backend)
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["fixture"]]))
        await backend.processValue.entered.wait()
        let cancel = controller.submit(try json("cancel", fields: ["taskId": "owner", "ownerOperationId": String(exec)]))
        let rows = try await events(controller, terminalIDs: [exec, cancel])
        let failure = rows.first { $0.operationId == String(exec) && $0.kind == .terminal }
        XCTAssertEqual(failure?.terminalStatus, .failed)
        XCTAssertEqual(failure?.code, "output_completion_unproven")
    }

    private func invalidDescriptor() -> HostLaunchDescriptor {
        let artifact = HostArtifact(path: "/intentionally-unavailable-native-review-artifact", sha256: String(repeating: "0", count: 64), identity: .init(device: 0, inode: 0))
        return HostLaunchDescriptor(scope: scope, compiledGraph: NativeCompiledGraph.identity, homeId: "fixture-home", currentHostHome: .init(homeId: "fixture-home", path: "/unavailable-fixture-home", identity: .init(device: 0, inode: 0)), protectedHomes: [], managedSharedDirectories: [], ownerNonce: "fixture-owner", ownedStorageRoot: "/intentionally-unavailable-native-review-storage", rootfs: artifact, kernel: artifact, initfs: artifact, shares: [], supervisorArguments: ["/immutable/supervisor"], memoryCeilingBytes: 1024 * 1024 * 1024, virtualCPUs: 1)
    }
    func testAcquiredReservationAbortsBeforeReleaseOnValidationFailure() async throws {
        let admission = FixtureHostAdmission(), backend = VZWorkspaceBackend(descriptor: invalidDescriptor(), admission: admission)
        do { try await backend.start(); XCTFail("Invalid descriptor must fail before VM construction") }
        catch let failure as NativeFailure { XCTAssertTrue(failure.launchNeverCreated) }
        let acquired = await admission.acquired, aborted = await admission.aborted, retained = await admission.retained
        XCTAssertEqual(acquired, 1); XCTAssertEqual(aborted, 1); XCTAssertEqual(retained, 0)
        let stopped = try await backend.stop(); XCTAssertTrue(stopped.terminationConfirmed)
        let after = await admission.aborted; XCTAssertEqual(after, 1)
    }
    func testFailedReservationAbortRetainsUncertaintyAndStopRetriesOnlyAbort() async throws {
        let admission = FixtureHostAdmission(abortFailures: 1), backend = VZWorkspaceBackend(descriptor: invalidDescriptor(), admission: admission)
        let controller = try NativeController(scope: scope, backend: backend)
        let start = controller.submit(try json("start")), failed = try await events(controller, terminalIDs: [start])
        XCTAssertEqual(failed.last?.code, "reservation_abort_uncertain")
        XCTAssertFalse(controller.lifetime.canRelease())
        let retained = await admission.retained; XCTAssertEqual(retained, 1)
        let stop = controller.submit(try json("stop")), stopped = try await events(controller, terminalIDs: [stop])
        XCTAssertEqual(stopped.last?.terminalStatus, .completed)
        let acquired = await admission.acquired, aborted = await admission.aborted
        XCTAssertEqual(acquired, 1); XCTAssertEqual(aborted, 1)
        XCTAssertTrue(controller.lifetime.canRelease())
    }
    func testConstructedReservationNeverUsesNoVMAbort() async throws {
        let admission = FixtureHostAdmission(), reservation = UnstartedReservation(descriptor: invalidDescriptor(), admission: admission)
        try await reservation.acquire()
        do { try await reservation.abort(didConstruct: true); XCTFail("Constructed VM must not release through reservation abort") }
        catch let failure as NativeFailure { XCTAssertEqual(failure.code, "reservation_abort_denied") }
        let held = await reservation.acquired, aborted = await admission.aborted
        XCTAssertTrue(held); XCTAssertEqual(aborted, 0)
    }
    func testDeadlineInvokesIndependentForceStopWhileGuestCancelAndRunAreStuck() async throws {
        let backend = StuckDrainBackend(), controller = try NativeController(scope: scope, backend: backend)
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["fixture"]]))
        await backend.processValue.entered.wait()
        let stop = controller.submit(try json("stop", fields: ["stopBudgetMilliseconds": 1]))
        await backend.forceEntered.wait()
        let early = try await events(controller, terminalIDs: [stop])
        XCTAssertEqual(early.last?.code, "stop_budget_exhausted")
        let before = await backend.stops; XCTAssertEqual(before, 0)
        XCTAssertFalse(controller.lifetime.canRelease())
        await backend.forceRelease.open(); await backend.forceExited.wait()
        // Even fully confirmed fake host force proof cannot release while guest
        // cancellation/run effects still own native tasks and callbacks.
        XCTAssertFalse(controller.lifetime.canRelease())
        await backend.processValue.runRelease.open()
        _ = try await events(controller, terminalIDs: [exec])
        XCTAssertFalse(controller.lifetime.canRelease())
        await backend.processValue.cancelRelease.open(); await backend.stopEntered.wait()
        for _ in 0..<10000 { if await controller.state() == .closed { break }; await Task.yield() }
        let state = await controller.state(), forces = await backend.forces
        XCTAssertEqual(state, .closed); XCTAssertEqual(forces, 1)
        XCTAssertTrue(controller.lifetime.canRelease())
        XCTAssertNil(controller.events.pollJSON()) // No second stop terminal.
    }

    func testNoReceiptCleanupStillOwnsIndependentEscalationDeadline() async throws {
        let backend = StuckDrainBackend(), controller = try NativeController(scope: scope, backend: backend, cleanupBudgetMilliseconds: 1)
        try await start(controller)
        let exec = controller.submit(try json("exec", fields: ["taskId": "owner", "arguments": ["fixture"]]))
        await backend.processValue.entered.wait()
        let occupied = try XCTUnwrap(controller.events.reserve(.shutdown))
        controller.requestCleanup()
        await backend.forceEntered.wait()
        XCTAssertFalse(controller.lifetime.canRelease())
        await backend.forceRelease.open(); await backend.forceExited.wait()
        await backend.processValue.runRelease.open(); _ = try await events(controller, terminalIDs: [exec])
        await backend.processValue.cancelRelease.open(); await backend.stopEntered.wait()
        for _ in 0..<10000 { if await controller.state() == .closed { break }; await Task.yield() }
        let forces = await backend.forces; XCTAssertEqual(forces, 1)
        XCTAssertTrue(controller.lifetime.canRelease())
        // The independently reserved receipt remains owned; no invented terminal.
        XCTAssertEqual(controller.events.counts().operations, 1)
        try controller.events.emit(occupied, kind: .terminal, status: .completed)
        XCTAssertNotNil(controller.events.pollJSON())
    }
    func testConcurrentReservationAbortSharesOneHostCallback() async throws {
        let admission = BarrierAbortAdmission(), reservation = UnstartedReservation(descriptor: invalidDescriptor(), admission: admission)
        try await reservation.acquire()
        let first = Task { try await reservation.abort(didConstruct: false) }
        await admission.entered.wait()
        let second = Task { try await reservation.abort(didConstruct: false) }
        for _ in 0..<10000 { if await reservation.abortWaiterCount == 2 { break }; await Task.yield() }
        let waiters = await reservation.abortWaiterCount, before = await admission.aborts
        XCTAssertEqual(waiters, 2); XCTAssertEqual(before, 1)
        await admission.release.open(); try await first.value; try await second.value
        try await reservation.abort(didConstruct: false)
        let held = await reservation.acquired, after = await admission.aborts
        XCTAssertFalse(held); XCTAssertEqual(after, 1)
    }
    func testStoppedHardwareWithoutFlushNeverCallsAuthorityRelease() async throws {
        let admission = FixtureHostAdmission(), descriptor = invalidDescriptor()
        let dirty = await CleanStopAuthority.confirm(descriptor, admission: admission, terminationConfirmed: true, flushConfirmed: false)
        XCTAssertTrue(dirty.terminationConfirmed); XCTAssertFalse(dirty.flushConfirmed)
        let released = await admission.confirmed, retained = await admission.retained
        XCTAssertEqual(released, 0); XCTAssertEqual(retained, 1)
        let clean = await CleanStopAuthority.confirm(descriptor, admission: admission, terminationConfirmed: true, flushConfirmed: true)
        XCTAssertTrue(clean.terminationConfirmed); XCTAssertTrue(clean.flushConfirmed)
        let after = await admission.confirmed; XCTAssertEqual(after, 1)
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

private actor TestLatch {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async { if opened { return }; await withCheckedContinuation { waiters.append($0) } }
    func open() { opened = true; let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume() } }
}
private actor CleanupBarrierProcess: NativeGuestProcess {
    nonisolated let entered = TestLatch(), cancellation = TestLatch(), finish = TestLatch()
    func run(output: @escaping @Sendable (NativeEventKind, Data) throws -> Void) async throws -> Int32 {
        await entered.open(); await finish.wait()
        throw NativeFailure("process_cleanup_uncertain", "Fixture cleanup failed before confirmed VM termination")
    }
    func writeInput(_ data: Data) async throws {}
    func closeInput() async throws {}
    func cancel() async throws { await cancellation.open() }
}
private actor CleanupBarrierBackend: NativeWorkspaceBackend {
    nonisolated let processValue = CleanupBarrierProcess()
    private(set) var stops = 0
    func start() async throws {}
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { processValue }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { stops += 1; return .init(terminationConfirmed: true, flushConfirmed: true) }
}
private struct ValidationFailureBackend: NativeWorkspaceBackend {
    func start() async throws { throw ProbeFailure(code: "unsafe_share", message: "fixture") }
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { throw NativeFailure("unused", "fixture") }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { .init(terminationConfirmed: true, flushConfirmed: true) }
}
private struct NeverCreatedBackend: NativeWorkspaceBackend {
    func start() async throws { throw NativeFailure("artifact_digest_mismatch", "fixture", launchNeverCreated: true) }
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { throw NativeFailure("unused", "fixture") }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { .init(terminationConfirmed: true, flushConfirmed: true) }
}

private actor IOProofFixtureProcess: ProbeProcess {
    private(set) var calls: [String] = []
    func record(_ value: String) { calls.append(value) }
    func start() async throws { calls.append("start") }
    func kill(_ signal: Signal) async throws { calls.append("kill") }
    func wait(timeoutInSeconds: Int64?) async throws -> ExitStatus { calls.append("wait"); return ExitStatus(exitCode: 0) }
    func delete() async throws { calls.append("delete") }
}

private actor FixtureHostAdmission: HostLaunchAdmission {
    private(set) var retained = 0
    private(set) var acquired = 0
    private(set) var aborted = 0
    private(set) var confirmed = 0
    private var abortFailures: Int
    init(abortFailures: Int = 0) { self.abortFailures = abortFailures }
    func authorize(_ descriptor: HostLaunchDescriptor) async throws { acquired += 1 }
    func abortUnstartedReservation(_ descriptor: HostLaunchDescriptor) async throws {
        if abortFailures > 0 { abortFailures -= 1; throw NativeFailure("fixture_abort_failed", "Fixture host release not confirmed") }
        aborted += 1
    }
    func retainUncertainOwnership(_ descriptor: HostLaunchDescriptor, reason: String) async { retained += 1 }
    func confirmStopped(_ descriptor: HostLaunchDescriptor) async throws { confirmed += 1 }
}

private struct FlushUncertainBackend: NativeWorkspaceBackend {
    func start() async throws {}
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { throw NativeFailure("unused", "fixture") }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { .init(terminationConfirmed: true, flushConfirmed: false) }
}

private actor OutputUnprovedProcess: NativeGuestProcess {
    nonisolated let entered = TestLatch(), finish = TestLatch()
    func run(output: @escaping @Sendable (NativeEventKind, Data) throws -> Void) async throws -> Int32 {
        await entered.open(); await finish.wait()
        throw ProcessRunFailure(original: "Fixture EOF unproved", originalCode: "output_completion_unproven", cleanupFailures: [], cleanupUncertain: false)
    }
    func writeInput(_ data: Data) async throws {}
    func closeInput() async throws {}
    func cancel() async throws { await finish.open() }
}
private actor OutputUnprovedBackend: NativeWorkspaceBackend {
    nonisolated let processValue = OutputUnprovedProcess()
    func start() async throws {}
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { processValue }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { .init(terminationConfirmed: true, flushConfirmed: true) }
}

private actor StuckDrainProcess: NativeGuestProcess {
    nonisolated let entered = TestLatch(), runRelease = TestLatch(), cancelRelease = TestLatch()
    func run(output: @escaping @Sendable (NativeEventKind, Data) throws -> Void) async throws -> Int32 { await entered.open(); await runRelease.wait(); return 0 }
    func writeInput(_ data: Data) async throws {}
    func closeInput() async throws {}
    func cancel() async throws { await cancelRelease.wait() }
}
private actor StuckDrainBackend: NativeWorkspaceBackend {
    nonisolated let processValue = StuckDrainProcess(), forceEntered = TestLatch(), forceRelease = TestLatch(), forceExited = TestLatch(), stopEntered = TestLatch()
    private(set) var stops = 0, forces = 0
    func start() async throws {}
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { processValue }
    func stats() async throws -> [String: String] { [:] }
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { [:] }
    func stop() async throws -> BackendStopResult { stops += 1; await stopEntered.open(); return .init(terminationConfirmed: false, flushConfirmed: false) }
    func forceStop() async throws -> BackendStopResult {
        forces += 1; await forceEntered.open(); await forceRelease.wait(); await forceExited.open()
        return .init(terminationConfirmed: true, flushConfirmed: true)
    }
}

private actor BarrierAbortAdmission: HostLaunchAdmission {
    nonisolated let entered = TestLatch(), release = TestLatch()
    private(set) var aborts = 0
    func authorize(_ descriptor: HostLaunchDescriptor) async throws {}
    func abortUnstartedReservation(_ descriptor: HostLaunchDescriptor) async throws { aborts += 1; await entered.open(); await release.wait() }
    func retainUncertainOwnership(_ descriptor: HostLaunchDescriptor, reason: String) async {}
    func confirmStopped(_ descriptor: HostLaunchDescriptor) async throws {}
}
