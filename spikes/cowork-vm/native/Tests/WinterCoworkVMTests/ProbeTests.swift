import WinterCoworkPrimitives
import XCTest
import Foundation
import Containerization
import ContainerizationError
import Darwin
import Virtualization
@testable import WinterCoworkVM

final class ProbeTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("winter-cowork-vm-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FixturePaths.markerContents.write(to: root.appendingPathComponent(FixturePaths.markerName), atomically: true, encoding: .utf8)
        return root.resolvingSymlinksInPath().standardizedFileURL
    }

    func testFixtureRequiresMarkedTempRootAndRejectsSymlinkEscape() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(try FixturePaths.root(root.path), root)
        XCTAssertThrowsError(try FixturePaths.root("/Users"))
        let escaped = root.appendingPathComponent("escape")
        try FileManager.default.createSymbolicLink(at: escaped, withDestinationURL: root.deletingLastPathComponent())
        XCTAssertThrowsError(try FixturePaths.existing(escaped.path, within: root, directory: true))
        XCTAssertThrowsError(try FixturePaths.output(escaped.appendingPathComponent("new.ext4").path, within: root))
        let dangling = root.appendingPathComponent("dangling.ext4")
        try FileManager.default.createSymbolicLink(at: dangling, withDestinationURL: root.deletingLastPathComponent().appendingPathComponent("absent-\(UUID().uuidString)"))
        XCTAssertThrowsError(try FixturePaths.output(dangling.path, within: root))
        XCTAssertEqual(try FixturePaths.output(root.appendingPathComponent("new.ext4").path, within: root).lastPathComponent, "new.ext4")
        try FileManager.default.removeItem(at: root.appendingPathComponent(FixturePaths.markerName))
        XCTAssertThrowsError(try FixturePaths.root(root.path))
    }

    func testDiskLeaseRejectsSameInodeThroughHardlinkAndAllowsAfterRelease() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let disk = root.appendingPathComponent("disk.ext4"), alias = root.appendingPathComponent("alias.ext4")
        try Data([0]).write(to: disk)
        try FileManager.default.linkItem(at: disk, to: alias)
        var owner: DiskLease? = try DiskLease(path: disk.path, fixtureRoot: root)
        XCTAssertThrowsError(try DiskLease(path: alias.path, fixtureRoot: root))
        // The probe's sidecar must leave VZ free to lock the image descriptor.
        let imageFD = Darwin.open(disk.path, O_RDWR | O_CLOEXEC)
        defer { Darwin.close(imageFD) }
        XCTAssertGreaterThanOrEqual(imageFD, 0)
        XCTAssertEqual(flock(imageFD, LOCK_EX | LOCK_NB), 0)
        flock(imageFD, LOCK_UN)
        withExtendedLifetime(owner) {}
        owner = nil
        _ = try DiskLease(path: alias.path, fixtureRoot: root)
    }

    func testPrivateVarAliasForNonexistentOutputUsesCanonicalExistingParent() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        guard root.path.hasPrefix("/var/") else { throw XCTSkip("macOS /private/var alias fixture") }
        let privateRootPath = "/private" + root.path
        let canonicalRoot = try FixturePaths.root(privateRootPath)
        XCTAssertEqual(canonicalRoot.path, root.path)
        let output = try FixturePaths.output(privateRootPath + "/initfs.ext4", within: canonicalRoot)
        XCTAssertEqual(output.path, root.appendingPathComponent("initfs.ext4").path)
        let nested = root.appendingPathComponent("nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
        let nestedOutput = try FixturePaths.output(privateRootPath + "/nested/rootfs.ext4", within: canonicalRoot)
        XCTAssertEqual(nestedOutput.path, nested.appendingPathComponent("rootfs.ext4").path)
    }

    func testBackingAndPayloadAliasesAreRejected() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let disk = root.appendingPathComponent("disk.ext4")
        try Data([0]).write(to: disk)
        XCTAssertNoThrow(try FixturePaths.validateBackingFiles([disk]))
        XCTAssertThrowsError(try FixturePaths.validateBackingFiles([disk, disk]))
        let source = root.appendingPathComponent("source"), payload = root.appendingPathComponent("payload")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: payload, withIntermediateDirectories: false)
        let runtime = payload.appendingPathComponent("runtime")
        try Data([1]).write(to: runtime)
        XCTAssertNoThrow(try FixturePaths.validateShares(source: source, payload: payload, backing: [disk]))
        XCTAssertThrowsError(try FixturePaths.validateShares(source: source, payload: source, backing: [disk]))
        try FileManager.default.linkItem(at: disk, to: source.appendingPathComponent("disk-alias"))
        XCTAssertThrowsError(try FixturePaths.validateBackingFiles([disk]))
        try FileManager.default.linkItem(at: runtime, to: source.appendingPathComponent("runtime-alias"))
        XCTAssertThrowsError(try FixturePaths.validateShares(source: source, payload: payload, backing: []))
    }

    func testNativeDiagnosticsKeepCodesAndFixturePathsButOmitOtherUserInfo() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let cause = NSError(domain: "NSPOSIXErrorDomain", code: 35, userInfo: [NSLocalizedDescriptionKey: "lock failed for " + root.appendingPathComponent("rootfs.ext4").path,
                                                                          "arbitrary-secret": "not-for-output"])
        let error = NSError(domain: "VZErrorDomain", code: 2, userInfo: [NSLocalizedDescriptionKey: "invalid attachment /Users/private/credential.db", NSUnderlyingErrorKey: cause])
        let chain = NativeDiagnostics.chain(error, fixtureRoot: root)
        XCTAssertEqual(chain.count, 2)
        XCTAssertEqual(chain[0]["domain"] as? String, "VZErrorDomain")
        XCTAssertEqual(chain[1]["code"] as? Int, 35)
        XCTAssertFalse((chain[0]["message"] as? String ?? "").contains("/Users/private"))
        XCTAssertTrue((chain[1]["message"] as? String ?? "").contains(root.path))
        XCTAssertFalse(String(describing: chain).contains("not-for-output"))
        let wrapped = ContainerizationError(.invalidState, message: "fixture create failed", cause: error)
        let wrappedChain = NativeDiagnostics.chain(wrapped, fixtureRoot: root)
        XCTAssertEqual(wrappedChain.count, 3)
        XCTAssertEqual(wrappedChain[0]["containerizationCode"] as? String, "invalidState")
        XCTAssertEqual(wrappedChain[2]["code"] as? Int, 35)
    }

    func testStartFailureRunsCleanupAndCleanReapAllowsFutureExec() async throws {
        let process = FakeProcess(startFails: true)
        do { _ = try await ProcessLifecycle.run(process, timeout: 30); XCTFail("start must fail") }
        catch let failure as ProcessRunFailure {
            XCTAssertFalse(failure.cleanupUncertain)
            var health = ExecHealth()
            health.record(processID: "fixture", failure: failure)
            XCTAssertNoThrow(try health.requireClean())
        }
        let calls = await process.calls
        XCTAssertEqual(calls, ["start", "kill", "wait:5", "delete"])
    }

    func testFailedReapBlocksFutureExecAndStillAttemptsDelete() async throws {
        let process = FakeProcess(startFails: true, waitsFail: true)
        do { _ = try await ProcessLifecycle.run(process, timeout: 30); XCTFail("start must fail") }
        catch let failure as ProcessRunFailure {
            XCTAssertTrue(failure.cleanupUncertain)
            var health = ExecHealth()
            health.record(processID: "fixture", failure: failure)
            XCTAssertThrowsError(try health.requireClean())
            XCTAssertEqual(health.uncertain.count, 1)
        }
        let calls = await process.calls
        XCTAssertEqual(calls, ["start", "kill", "wait:5", "delete"])
    }

    func testDeleteFailureRetainsCleanupUncertainty() async throws {
        let process = FakeProcess(deleteFails: true)
        do { _ = try await ProcessLifecycle.run(process, timeout: 30); XCTFail("delete must fail") }
        catch let failure as ProcessRunFailure { XCTAssertTrue(failure.cleanupUncertain) }
        let calls = await process.calls
        XCTAssertEqual(calls, ["start", "wait:30", "delete", "delete"])
    }

    func testQueueBackpressureKeepsUnconsumedCompletions() {
        let queue = EventQueue(limit: 2)
        XCTAssertEqual(queue.reserve(), 1)
        XCTAssertEqual(queue.reserve(), 2)
        XCTAssertNil(queue.reserve())
        queue.finish("one")
        XCTAssertNil(queue.reserve())
        XCTAssertEqual(queue.poll(), "one")
        XCTAssertEqual(queue.reserve(), 3)
        queue.finish("two"); queue.finish("three")
        XCTAssertEqual(queue.poll(), "two")
        XCTAssertEqual(queue.poll(), "three")
        XCTAssertNil(queue.poll())
    }

    func testPollAllocationFailureKeepsCompletionAndReservation() {
        let queue = EventQueue(limit: 1)
        XCTAssertEqual(queue.reserve(), 1)
        queue.finish("completion")
        XCTAssertNil(queue.pollAllocated { _ in nil })
        XCTAssertNil(queue.reserve())
        let allocated = queue.pollAllocated { strdup($0) }
        XCTAssertNotNil(allocated)
        if let allocated { XCTAssertEqual(String(cString: allocated), "completion"); free(allocated) }
        XCTAssertEqual(queue.reserve(), 2)
    }

    func testStopClosesDeviceAdmissionAndDrainsPendingWork() async throws {
        let gate = DeviceOperationGate()
        try gate.begin(); try gate.begin()
        let drained = expectation(description: "queued device operations finished before stop")
        let stop = Task { await gate.closeAndDrain(); drained.fulfill() }
        for _ in 0..<200 {
            if gate.snapshot().closing { break }
            await Task.yield()
        }
        XCTAssertTrue(gate.snapshot().closing)
        XCTAssertEqual(gate.snapshot().active, 2)
        XCTAssertThrowsError(try gate.begin())
        gate.finish()
        XCTAssertEqual(gate.snapshot().active, 1)
        gate.finish()
        await fulfillment(of: [drained], timeout: 1)
        await stop.value
        XCTAssertEqual(gate.snapshot().active, 0)
        XCTAssertThrowsError(try gate.begin())
    }

    func testBuiltVZSharePolicyRejectsReadOnlyMismatchAndAliases() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let ro = root.appendingPathComponent("ro"), rw = root.appendingPathComponent("rw")
        try FileManager.default.createDirectory(at: ro, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: rw, withIntermediateDirectories: false)
        let expected = [HostSharePolicy(sourcePath: ro.path, guestPath: "/workspace/host-ro", readOnly: true),
                        HostSharePolicy(sourcePath: rw.path, guestPath: "/workspace/host-rw", readOnly: false)]
        try SharePolicy.validate(expected, backing: [], userHomeRoot: nil)
        XCTAssertThrowsError(try SharePolicy.validate([expected[0], HostSharePolicy(sourcePath: ro.path, guestPath: "/other", readOnly: false)], backing: [], userHomeRoot: nil))
        let config = VZVirtualMachineConfiguration()
        let device = VZVirtioFileSystemDeviceConfiguration(tag: "virtiofs")
        config.directorySharingDevices = [device]
        device.share = VZMultipleDirectoryShare(directories: ["read": VZSharedDirectory(url: ro, readOnly: true), "write": VZSharedDirectory(url: rw, readOnly: false)])
        let mounts = ["fixture": expected.map(\.mount)]
        XCTAssertNoThrow(try SharePolicy.assertBuilt(config, expected: expected, mountsByID: mounts))
        device.share = VZMultipleDirectoryShare(directories: ["read": VZSharedDirectory(url: ro, readOnly: false), "write": VZSharedDirectory(url: rw, readOnly: false)])
        XCTAssertThrowsError(try SharePolicy.assertBuilt(config, expected: expected, mountsByID: mounts))
        device.share = VZMultipleDirectoryShare(directories: ["read": VZSharedDirectory(url: ro, readOnly: true), "alias": VZSharedDirectory(url: ro, readOnly: false)])
        XCTAssertThrowsError(try SharePolicy.assertBuilt(config, expected: expected, mountsByID: mounts))
    }

    func testConcurrentReservationsAreUniqueAndBounded() {
        let queue = EventQueue(limit: 128)
        DispatchQueue.concurrentPerform(iterations: 256) { _ in
            if let id = queue.reserve() { queue.finish(String(id)) }
        }
        var ids: Set<String> = []
        while let value = queue.poll() { ids.insert(value) }
        XCTAssertEqual(ids.count, 128)
        XCTAssertNotNil(queue.reserve())
    }

    func testOutputCaptureIsBoundedAndTruncationVisible() throws {
        let writer = CaptureWriter()
        try writer.write(Data(repeating: 65, count: 200 * 1024))
        let result = writer.snapshot()
        XCTAssertEqual(result.0.utf8.count, 128 * 1024)
        XCTAssertTrue(result.1)
    }

    func testABIReportsMalformedAndUnknownRequestsWithoutVM() async throws {
        XCTAssertEqual(winterCoworkVMABIVersion(), 1)
        XCTAssertEqual(winterCoworkVMSubmit(nil), 0)
        let malformed = "{".withCString { winterCoworkVMSubmit($0) }
        let unknown = "{\"method\":\"unsupported\"}".withCString { winterCoworkVMSubmit($0) }
        let capabilities = "{\"method\":\"capabilities\"}".withCString { winterCoworkVMSubmit($0) }
        XCTAssertNotEqual(malformed, 0)
        var responses: [UInt64: [String: Any]] = [:]
        for _ in 0..<200 {
            while let pointer = winterCoworkVMPoll() {
                defer { winterCoworkVMStringFree(pointer) }
                let data = Data(String(cString: pointer).utf8)
                let event = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                responses[try XCTUnwrap((event["opId"] as? NSNumber)?.uint64Value)] = event
            }
            if responses.count == 3 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(responses[malformed]?["status"] as? String, "failed")
        XCTAssertEqual((responses[unknown]?["error"] as? [String: Any])?["code"] as? String, "unsupported_method")
        XCTAssertEqual((responses[capabilities]?["result"] as? [String: Any])?["network"] as? String, "none")
    }
}

private actor FakeProcess: ProbeProcess {
    let startFails: Bool
    let waitsFail: Bool
    let deleteFails: Bool
    private(set) var calls: [String] = []
    init(startFails: Bool = false, waitsFail: Bool = false, deleteFails: Bool = false) {
        self.startFails = startFails; self.waitsFail = waitsFail; self.deleteFails = deleteFails
    }
    func start() async throws {
        calls.append("start")
        if startFails { throw ProbeFailure(code: "fake_start", message: "partial start failure") }
    }
    func kill(_ signal: Signal) async throws { calls.append("kill") }
    func wait(timeoutInSeconds: Int64?) async throws -> ExitStatus {
        calls.append("wait:\(timeoutInSeconds ?? -1)")
        if waitsFail { throw ProbeFailure(code: "fake_wait", message: "exit not established") }
        return ExitStatus(exitCode: 0)
    }
    func delete() async throws {
        calls.append("delete")
        if deleteFails { throw ProbeFailure(code: "fake_delete", message: "delete failure") }
    }
}
