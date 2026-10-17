import XCTest
import Foundation
@testable import LauncherCore
import LauncherNative

/// The daemon's side of L1, written the way the daemon must write it: one sendmsg carrying a whole line (and its descriptors), and
/// every read a recvmsg.
final class FakeDaemon {
    let end: OwnedFD
    private var framer = LineFramer()
    private(set) var inbox: [LineToDaemon] = []
    private(set) var raw: [[UInt8]] = []
    private var consumed = 0
    init(_ end: OwnedFD) { self.end = end }

    func send(_ message: LineToLauncher, rights: [Int32] = []) {
        let line = try! LauncherLineCodec.serialize(message)
        XCTAssertEqual(try! Sock.send(end, line[...], rights: rights).get(), line.count)
    }
    func sendRaw(_ bytes: [UInt8], rights: [Int32] = []) { _ = Sock.send(end, bytes[...], rights: rights) }
    private func pump(timeoutMs: Int32) {
        var table = [pollfd(fd: end.raw, events: Int16(POLLIN), revents: 0)]
        guard poll(&table, 1, timeoutMs) > 0 else { return }
        while true {
            switch Sock.receive(end, capacity: 1 << 20) {
            case .data(let bytes, let rights):
                XCTAssertTrue(rights.isEmpty, "the launcher never sends descriptors to the daemon")
                for line in (try? framer.feed(bytes, rights: [])) ?? [] {
                    raw.append(line.bytes)
                    inbox.append(try! LauncherLineCodec.parseToDaemon(line.bytes))
                }
            default: return
            }
        }
    }
    /// The first line from here on that `pick` accepts (lines before it are consumed).
    func next<T>(timeout: TimeInterval = 10, _ pick: (LineToDaemon) -> T?) -> T? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            while consumed < inbox.count {
                let line = inbox[consumed]; consumed += 1
                if let value = pick(line) { return value }
            }
            if Date() > deadline { return nil }
            pump(timeoutMs: 50)
        }
    }
    func nextFault(timeout: TimeInterval = 10) -> ChannelFault? {
        next(timeout: timeout) { (line: LineToDaemon) -> ChannelFault? in if case .fault(let code) = line { return code }; return nil }
    }
    /// Whether a line matching `matches` shows up within `timeout`.
    func sees(timeout: TimeInterval, _ matches: (LineToDaemon) -> Bool) -> Bool { next(timeout: timeout) { matches($0) ? true : nil } ?? false }
    func waitForEnd(timeout: TimeInterval = 10) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var table = [pollfd(fd: end.raw, events: Int16(POLLIN), revents: 0)]
            if poll(&table, 1, 50) > 0 {
                var byte = [UInt8](repeating: 0, count: 1 << 16)
                let n = read(end.raw, &byte, byte.count)
                if n == 0 { return true }
            }
        }
        return false
    }
}

/// The real runtime on real sockets, with the FakeWorker as the child. The daemon is this test.
final class RuntimeRig {
    let daemon: FakeDaemon
    let runtime: LauncherRuntime
    let store: DirectoryReceiptStore
    let storeDirectory: URL
    let finished = DispatchSemaphore(value: 0)
    let power = PowerLedger()
    let scope: Scope
    let config: SessionConfig

    init(mode: String = "ok", workerRequirement: String? = nil, tune: (inout SessionConfig) -> Void = { _ in }) throws {
        let (d, l) = try Sock.pair(.stream)
        let launcherEnd = try Sock.relocate(l, above: 5)
        try Sock.setNonBlocking(launcherEnd)
        daemon = FakeDaemon(d)
        storeDirectory = makeTemporaryDirectory("rig-receipts")
        store = try DirectoryReceiptStore(directory: BuiltProducts.canonical(storeDirectory.path))
        let requirement = try CodeRequirement(workerRequirement ?? WinterCodeIdentity.cdhashRequirement(try CodeHash.ofFile(BuiltProducts.fakeWorker)))
        let image = try WorkerImage(path: BuiltProducts.fakeWorker, requirement: requirement)
        let semaphore = finished
        runtime = LauncherRuntime(l1: launcherEnd, spawner: NativeWorkerSpawner(path: BuiltProducts.fakeWorker, verifier: image), onFinish: { semaphore.signal() })
        var cfg = Fixture.config(); tune(&cfg); config = cfg
        scope = Fixture.scope(mode: mode)
        runtime.start(config: config, dependencies: SessionDependencies(store: store, power: power), observePower: false)
    }
    deinit { try? FileManager.default.removeItem(at: storeDirectory) }

    func hello() -> Bool { daemon.next { if case .hello = $0 { true } else { nil } } != nil }
    /// begin, and the worker's pid from `begun` (nil when the begin was refused or never answered).
    func begin(id: String = "req-begin") -> (pid: Int, token: String)? {
        daemon.send(.begin(id: id, scope: scope))
        return daemon.next { (line: LineToDaemon) -> (pid: Int, token: String)?? in
            if case .begun(let i, _, let pid, let token) = line, i == id { return .some((pid, token)) }
            if case .refused(let i, _) = line, i == id { return .some(nil) }
            return nil
        } ?? nil
    }
    func refusal(id: String = "req-begin") -> RefusalCode? { daemon.next { if case .refused(let i, let code) = $0, i == id { code } else { nil } } }
    func sendVolumes(_ disks: DiskPair, id: String = "req-volumes") throws {
        daemon.send(.volumes(id: id, scopeDigest: try EnvelopeFormat.scopeDigest(scope), volumes: disks.identities), rights: disks.descriptors.map(\.raw))
    }
    func attach(_ disks: DiskPair) throws -> Bool {
        try sendVolumes(disks)
        return daemon.next { if case .volumesAccepted = $0 { true } else if case .refused = $0 { false } else { nil } } ?? false
    }
    func waitForFinish(_ timeout: TimeInterval = 10) -> Bool { finished.wait(timeout: .now() + timeout) == .success }
    func storedReceipt() -> StopReceipt? { try? store.load(ReceiptScope(scope)) }
    func processGone(_ pid: Int) -> Bool {
        for _ in 0..<200 { if kill(Int32(pid), 0) == -1 && errno == ESRCH { return true }; usleep(10_000) }
        return false
    }
}

final class RuntimeIntegrationTests: XCTestCase {
    func testHappyPathFromHelloToAnOrderlyStopAndRetire() throws {
        let rig = try RuntimeRig()
        XCTAssertTrue(rig.hello())
        let (pid, token) = try XCTUnwrap(rig.begin())
        XCTAssertNotNil(rig.daemon.next { if case .workerState(.sandboxed) = $0 { true } else { nil } })

        let disks = try DiskPair()
        XCTAssertTrue(try rig.attach(disks), "two real descriptors crossed L1, were forwarded over L2 and accepted by the worker")
        XCTAssertEqual(disks.dataMarker, "WINTER-FAKE-WORKER", "the worker really wrote through the descriptor it was handed")

        // The worker's descriptor table: 0 1 2 (null), 3 (L2), 4 (L3), and the two images. Nothing of the launcher's: not L1, not the store.
        let frame = try XCTUnwrap(rig.daemon.next { if case .muxUp(let f) = $0 { f } else { nil } })
        let report = String(decoding: frame[WireLimits.headerBytes...], as: UTF8.self)
        XCTAssertTrue(report.hasPrefix("fds:0,1,2,3,4,"), report)
        XCTAssertEqual(report.dropFirst(4).split(separator: ",").count, 7, "exactly the five of the table plus the two images: \(report)")

        // The relay carries bytes blind both ways: the FakeWorker echoes whatever frame it is sent.
        let payload: [UInt8] = [0xff, 0x00, 0x7b, 0x22]
        rig.daemon.send(.muxDown(frame: MuxFormat.frame(.bootstrap, seq: 1, payload: payload)))
        let echo = try XCTUnwrap(rig.daemon.next { if case .muxUp(let f) = $0, f[5] == MuxClass.bootstrap.rawValue { f } else { nil } })
        XCTAssertEqual(Array(echo[WireLimits.headerBytes...]), payload)

        rig.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .user, budgetMs: 10_000))
        let (stoppedId, receipt) = try XCTUnwrap(rig.daemon.next { if case .stopped(let id, let r) = $0 { (id, r) } else { nil } })
        XCTAssertEqual(stoppedId, "req-stop"); XCTAssertTrue(receipt.invariantsHold); XCTAssertEqual(receipt.stopNonce, Fixture.nonce)
        XCTAssertEqual(receipt.workerPid, pid); XCTAssertEqual(receipt.workerStartToken, token)
        XCTAssertEqual(receipt.volumes.map(\.inode), disks.identities.map(\.inode))
        XCTAssertEqual(rig.storedReceipt(), .orderly(receipt), "durable, byte for byte what was sent")
        XCTAssertTrue(rig.processGone(pid), "the worker was reaped by the launcher that owns it")

        rig.daemon.send(.receiptRetire(confirmationId: receipt.confirmationId))
        XCTAssertTrue(rig.waitForFinish())
        XCTAssertNil(rig.storedReceipt(), "retired")
    }

    func testOwnerLossDrainsTheWorkerAndLeavesADurableClassAForTheNextDaemon() throws {
        let rig = try RuntimeRig()
        XCTAssertTrue(rig.hello())
        let (pid, _) = try XCTUnwrap(rig.begin())
        XCTAssertTrue(try rig.attach(try DiskPair()))
        rig.daemon.end.close() // the daemon dies
        XCTAssertTrue(rig.waitForFinish(), "the launcher ends once the verdict is durable")
        guard case .orderly(let receipt)? = rig.storedReceipt() else { return XCTFail("a durable Class A") }
        XCTAssertEqual(receipt.origin, .ownerLossDrain); XCTAssertTrue(receipt.invariantsHold); XCTAssertEqual(receipt.workerPid, pid)
        XCTAssertEqual(receipt.stopNonce.count, 32, "a nonce the launcher minted itself")
        XCTAssertTrue(rig.processGone(pid))
    }

    func testAnUnresponsiveWorkerIsKilledAtTheOwnerLossBudgetAndLeavesClassB() throws {
        let rig = try RuntimeRig(mode: "ignoredrain") { $0.ownerLossBudgetMs = 400 }
        XCTAssertTrue(rig.hello())
        let (pid, _) = try XCTUnwrap(rig.begin())
        XCTAssertTrue(try rig.attach(try DiskPair()))
        let started = Date()
        rig.daemon.end.close()
        XCTAssertTrue(rig.waitForFinish())
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.35, "the drain budget was honoured before the kill")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        guard case .uncertain(let b)? = rig.storedReceipt() else { return XCTFail("a durable Class B") }
        XCTAssertEqual(b.reason, .drainTimeout); XCTAssertEqual(b.workerExit, .signal); XCTAssertEqual(b.workerStatus, Int(SIGKILL)); XCTAssertEqual(b.workerPid, pid)
        XCTAssertTrue(rig.processGone(pid))
    }

    func testAHostStopBudgetThatRunsOutKillsTheWorkerAndTheDaemonIsToldClassB() throws {
        let rig = try RuntimeRig(mode: "ignoredrain")
        XCTAssertTrue(rig.hello())
        let (pid, _) = try XCTUnwrap(rig.begin())
        XCTAssertTrue(try rig.attach(try DiskPair()))
        rig.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .shutdown, budgetMs: 300))
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .drainTimeout)
        XCTAssertTrue(rig.processGone(pid))
        XCTAssertFalse(rig.daemon.sees(timeout: 0.3) { if case .stopped = $0 { true } else { false } }, "never a Class A")
    }

    func testACrashedWorkerIsReapedAndReportedClassB() throws {
        let rig = try RuntimeRig(mode: "crash")
        XCTAssertTrue(rig.hello())
        let (pid, _) = try XCTUnwrap(rig.begin())
        try rig.sendVolumes(try DiskPair())
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerCrashed); XCTAssertEqual(b.workerExit, .code); XCTAssertEqual(b.workerStatus, 79); XCTAssertTrue(b.attachedVolumes)
        XCTAssertTrue(rig.processGone(pid))
    }

    func testAWorkerThatNeverReportsReadyIsKilled() throws {
        let rig = try RuntimeRig(mode: "silent") { $0.readyTimeoutMs = 300 }
        XCTAssertTrue(rig.hello())
        rig.daemon.send(.begin(id: "req-begin", scope: rig.scope))
        XCTAssertEqual(rig.refusal(), .sandbox_failed)
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled); XCTAssertEqual(b.workerExit, .signal)
        XCTAssertTrue(rig.processGone(b.workerPid))
    }

    func testAnImageThatFailsItsRequirementIsKilledWhileStillSuspended() throws {
        let rig = try RuntimeRig(workerRequirement: WinterCodeIdentity.cdhashRequirement(String(repeating: "00", count: 20)))
        XCTAssertTrue(rig.hello())
        rig.daemon.send(.begin(id: "req-begin", scope: rig.scope))
        XCTAssertEqual(rig.refusal(), .code_identity_mismatch)
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled); XCTAssertEqual(b.workerExit, .signal, "killed by SIGKILL while stopped: it never ran")
        XCTAssertTrue(rig.processGone(b.workerPid))
        XCTAssertFalse(rig.daemon.sees(timeout: 0.3) { if case .begun = $0 { true } else { false } })
    }

    func testAMalformedLineGetsOneFaultThenTheWorkerIsDrained() throws {
        let rig = try RuntimeRig()
        XCTAssertTrue(rig.hello())
        let (pid, _) = try XCTUnwrap(rig.begin())
        XCTAssertTrue(try rig.attach(try DiskPair()))
        rig.daemon.sendRaw(Array("this is not json\n".utf8))
        XCTAssertEqual(rig.daemon.nextFault(), .protocol_violation)
        XCTAssertTrue(rig.waitForFinish(), "the launcher drains and ends")
        guard case .orderly(let r)? = rig.storedReceipt() else { return XCTFail("the worker was drained, not abandoned") }
        XCTAssertEqual(r.origin, .ownerLossDrain); XCTAssertEqual(r.workerPid, pid)
    }

    func testDescriptorsOnTheWrongLineAreClosedByTheLauncherAndEndTheChannel() throws {
        let rig = try RuntimeRig()
        XCTAssertTrue(rig.hello())
        let disks = try DiskPair()
        let baseline = openDescriptorCount()
        rig.daemon.send(.ping(id: "req-ping"), rights: disks.descriptors.map(\.raw))
        XCTAssertEqual(rig.daemon.nextFault(), .protocol_violation)
        for _ in 0..<100 where openDescriptorCount() > baseline { usleep(10_000) }
        XCTAssertLessThanOrEqual(openDescriptorCount(), baseline, "the two descriptors that arrived were closed")
        XCTAssertTrue(rig.waitForFinish())
    }

    func testTruncatedAncillaryDataOnL1IsFatal() throws {
        let rig = try RuntimeRig()
        XCTAssertTrue(rig.hello())
        let source = try DiskPair()
        let many = (0..<20).map { _ in open(source.urls[0].path, O_RDONLY) }
        defer { many.forEach { close($0) } }
        XCTAssertGreaterThan(rawSendRights(rig.daemon.end.raw, Array("{\"v\":1,\"t\":\"ping\",\"id\":\"req-1\"}\n".utf8), rights: many), 0)
        XCTAssertEqual(rig.daemon.nextFault(), .protocol_violation)
        XCTAssertFalse(rig.daemon.sees(timeout: 0.3) { if case .pong = $0 { true } else { false } }, "nothing received on that channel is acknowledged")
    }

    func testTheWorkerSendingDescriptorsToTheLauncherIsAViolationAndTheyAreClosed() throws {
        let rig = try RuntimeRig(mode: "rightsback")
        XCTAssertTrue(rig.hello())
        rig.daemon.send(.begin(id: "req-begin", scope: rig.scope))
        XCTAssertEqual(rig.refusal(), .internal)
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled)
    }

    func testAGarbageDatagramFromTheWorkerKillsIt() throws {
        let rig = try RuntimeRig(mode: "garbage")
        XCTAssertTrue(rig.hello())
        rig.daemon.send(.begin(id: "req-begin", scope: rig.scope))
        XCTAssertEqual(rig.refusal(), .internal)
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled); XCTAssertTrue(rig.processGone(b.workerPid))
    }

    func testAWorkerThatExitsOnItsOwnWithoutBeingAskedIsClassB() throws {
        let rig = try RuntimeRig(mode: "exitnodrain")
        XCTAssertTrue(rig.hello())
        _ = try XCTUnwrap(rig.begin())
        try rig.sendVolumes(try DiskPair())
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerCrashed); XCTAssertEqual(b.workerExit, .code); XCTAssertEqual(b.workerStatus, 0)
    }

    func testAFlushShortfallReportedByTheWorkerIsClassBEvenThoughItExitedZero() throws {
        let rig = try RuntimeRig(mode: "badflush")
        XCTAssertTrue(rig.hello())
        _ = try XCTUnwrap(rig.begin())
        XCTAssertTrue(try rig.attach(try DiskPair()))
        rig.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .user, budgetMs: 10_000))
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .flushUncertain)
    }

    func testPingAndAStopBeforeBeginAreAnsweredWithoutAWorker() throws {
        let rig = try RuntimeRig()
        XCTAssertTrue(rig.hello())
        rig.daemon.send(.ping(id: "req-ping"))
        XCTAssertNotNil(rig.daemon.next { if case .pong("req-ping") = $0 { true } else { nil } })
        rig.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .user, budgetMs: 1000))
        XCTAssertEqual(rig.refusal(id: "req-stop"), .not_begun)
    }
}
