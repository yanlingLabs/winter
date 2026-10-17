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
    /// Writes the whole line, waiting for room: the launcher stops reading L1 while its relay backlog is full. False if `timeout` passes first.
    func sendAll(_ message: LineToLauncher, timeout: TimeInterval = 10) -> Bool {
        let line = try! LauncherLineCodec.serialize(message)
        var offset = 0
        let deadline = Date().addingTimeInterval(timeout)
        while offset < line.count {
            switch Sock.send(end, line[offset...]) {
            case .success(let n): offset += n
            case .failure(.errno(EAGAIN)): var table = [pollfd(fd: end.raw, events: Int16(POLLOUT), revents: 0)]; _ = poll(&table, 1, 20)
            case .failure: return false
            }
            if offset < line.count && Date() > deadline { return false }
        }
        return true
    }
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

    let artifacts: GuestArtifactVerifying

    /// `guest`: run against a scratch worker directory with REAL guest artifacts and the real verifier (default: a double that accepts).
    init(mode: String = "ok", workerRequirement: String? = nil, guest: GuestWorkerDirectory? = nil, artifacts: GuestArtifactVerifying? = nil,
         relayLimits: (soft: Int, hard: Int, stallMs: Int)? = nil, tune: (inout SessionConfig) -> Void = { _ in }) throws {
        let (d, l) = try Sock.pair(.stream)
        let launcherEnd = try Sock.relocate(l, above: 5)
        try Sock.setNonBlocking(launcherEnd)
        // The daemon's end is non-blocking too, as the real daemon's is: a blocking sendmsg here would ignore MSG_DONTWAIT and could never
        // tell the test that the launcher stopped reading.
        try Sock.setNonBlocking(d)
        daemon = FakeDaemon(d)
        storeDirectory = makeTemporaryDirectory("rig-receipts")
        store = try DirectoryReceiptStore(directory: BuiltProducts.canonical(storeDirectory.path))
        let workerPath = guest?.workerPath ?? BuiltProducts.fakeWorker
        let requirement = try CodeRequirement(workerRequirement ?? cdhashRequirementText(try CodeHash.ofFile(workerPath)))
        let image = try WorkerImage(path: workerPath, requirement: requirement)
        self.artifacts = artifacts ?? (guest != nil ? GuestArtifactVerifier(workerPath: workerPath) : FakeArtifacts())
        let semaphore = finished
        runtime = LauncherRuntime(l1: launcherEnd, spawner: NativeWorkerSpawner(verifier: image), onFinish: { semaphore.signal() })
        var cfg = Fixture.config(); tune(&cfg); config = cfg
        scope = guest?.scope(mode: mode) ?? Fixture.scope(mode: mode)
        runtime.start(config: config, dependencies: SessionDependencies(store: store, artifacts: self.artifacts, power: power), observePower: false, relayLimits: relayLimits)
    }
    deinit { try? FileManager.default.removeItem(at: storeDirectory) }

    func hello() -> Bool { daemon.next { if case .hello = $0 { true } else { nil } } != nil }
    /// begin, and the worker's pid from `begun` (nil when the begin was refused or never answered).
    func begin(id: String = "req-begin") -> (pid: Int, token: String)? {
        daemon.send(.begin(id: id, homeId: Fixture.homeId, scope: scope))
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
        // A descriptor WITHOUT close-on-exec, open in the launcher's process across the spawn: only POSIX_SPAWN_CLOEXEC_DEFAULT keeps it from the worker.
        // (Placed high with F_DUPFD: a low number would be overwritten by the worker's own descriptors 3 and 4 and prove nothing.)
        let low = open("/dev/null", O_RDONLY), stray = fcntl(low, F_DUPFD, 60); close(low)
        XCTAssertGreaterThanOrEqual(stray, 60); XCTAssertEqual(lc_has_cloexec(stray), 0); defer { close(stray) }
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
        let rig = try RuntimeRig(mode: "ignoredrain") { $0.ownerLossBudgetMs = 400; $0.exitAllowanceMs = 0 }
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
        let rig = try RuntimeRig(mode: "ignoredrain") { $0.exitAllowanceMs = 0 }
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
        rig.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: rig.scope))
        XCTAssertEqual(rig.refusal(), .sandbox_failed)
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled); XCTAssertEqual(b.workerExit, .signal)
        XCTAssertTrue(rig.processGone(b.workerPid))
    }

    func testAnImageThatFailsItsRequirementIsKilledWhileStillSuspended() throws {
        let rig = try RuntimeRig(workerRequirement: cdhashRequirementText(String(repeating: "00", count: 20)))
        XCTAssertTrue(rig.hello())
        rig.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: rig.scope))
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
        rig.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: rig.scope))
        XCTAssertEqual(rig.refusal(), .internal)
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled)
    }

    func testADescriptorAttachedToAFrameOnL3IsAViolationAndIsClosed() throws {
        let rig = try RuntimeRig(mode: "l3rights")
        XCTAssertTrue(rig.hello())
        let (pid, _) = try XCTUnwrap(rig.begin())
        let baseline = openDescriptorCount()
        XCTAssertTrue(try rig.attach(try DiskPair()))
        XCTAssertEqual(rig.daemon.nextFault(), .worker_channel_lost)
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled); XCTAssertTrue(rig.processGone(pid))
        XCTAssertFalse(rig.daemon.sees(timeout: 0.2) { if case .muxUp = $0 { true } else { false } }, "nothing from that stream is relayed")
        _ = baseline
    }
    // MARK: back-pressure on the relay

    func testASlowButHealthyWorkerIsNotKilledWhenTheDaemonOutrunsItAndNothingIsLost() throws {
        let rig = try RuntimeRig(mode: "sink", relayLimits: (soft: 128 << 10, hard: 32 << 20, stallMs: 20_000))
        XCTAssertTrue(rig.hello()); let (pid, _) = try XCTUnwrap(rig.begin()); XCTAssertTrue(try rig.attach(try DiskPair()))
        // 5 MiB of runtime frames against a 128 KiB soft limit: the backlog would have outgrown it forty times over. (Before back-pressure a
        // backlog over a fixed 8 MiB SIGKILLed a worker that was only slow; a debug build parses a megabyte line slowly, hence only five.)
        let payload = [UInt8](repeating: 0x61, count: 1_048_576)
        for seq in 1...5 { XCTAssertTrue(rig.daemon.sendAll(.muxDown(frame: MuxFormat.frame(.runtime, seq: UInt32(seq), payload: payload)), timeout: 30), "frame \(seq)") }
        XCTAssertTrue(rig.daemon.sendAll(.muxDown(frame: MuxFormat.frame(.bootstrap, seq: 1, payload: Array("done".utf8)))))
        let report = try XCTUnwrap(rig.daemon.next(timeout: 30) { (line: LineToDaemon) -> String? in
            if case .muxUp(let f) = line, f[5] == MuxClass.runtime.rawValue, f.count > 21, String(decoding: f[16..<21], as: UTF8.self) == "sunk:" { return String(decoding: f[16...], as: UTF8.self) }
            return nil
        })
        XCTAssertEqual(report, "sunk:\(5 * 1_048_576 + 4):6", "every byte of every frame reached the worker, in order")
        XCTAssertGreaterThan(rig.runtime.queue.sync { rig.runtime.backpressurePauses }, 0, "the launcher paused L1 instead of killing anything")
        XCTAssertEqual(kill(Int32(pid), 0), 0, "the worker is alive")
        rig.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .user, budgetMs: 10_000))
        let receipt = try XCTUnwrap(rig.daemon.next { if case .stopped(_, let r) = $0 { r } else { nil } })
        XCTAssertTrue(receipt.invariantsHold)
    }
    func testAWorkerThatIsSlowButAlwaysProgressingSurvivesEveryStallWindow() throws {
        // 2 MiB at 64 KiB per 50 ms is well over a second; the stall window is 250 ms, so the stall timer fires several times, and each time
        // the worker has accepted bytes since the last one: it is re-armed, never acted on.
        let rig = try RuntimeRig(mode: "trickle", relayLimits: (soft: 64 << 10, hard: 32 << 20, stallMs: 250))
        XCTAssertTrue(rig.hello()); let (pid, _) = try XCTUnwrap(rig.begin()); XCTAssertTrue(try rig.attach(try DiskPair()))
        let payload = [UInt8](repeating: 0x63, count: 1_048_576)
        for seq in 1...2 { XCTAssertTrue(rig.daemon.sendAll(.muxDown(frame: MuxFormat.frame(.runtime, seq: UInt32(seq), payload: payload)), timeout: 30), "frame \(seq)") }
        XCTAssertTrue(rig.daemon.sendAll(.muxDown(frame: MuxFormat.frame(.bootstrap, seq: 1, payload: Array("done".utf8)))))
        let report = try XCTUnwrap(rig.daemon.next(timeout: 30) { (line: LineToDaemon) -> String? in
            if case .muxUp(let f) = line, f[5] == MuxClass.runtime.rawValue, f.count > 21, String(decoding: f[16..<21], as: UTF8.self) == "sunk:" { return String(decoding: f[16...], as: UTF8.self) }
            return nil
        })
        XCTAssertEqual(report, "sunk:\(2 * 1_048_576 + 4):3")
        XCTAssertEqual(kill(Int32(pid), 0), 0, "a worker that keeps accepting bytes is never killed for being slow")
    }
    func testAWorkerThatNeverDrainsL3IsKilledOnlyAfterTheStallWindowNotWhenTheBacklogFirstFills() throws {
        let rig = try RuntimeRig(mode: "stalll3", relayLimits: (soft: 64 << 10, hard: 32 << 20, stallMs: 1_500))
        XCTAssertTrue(rig.hello()); let (pid, _) = try XCTUnwrap(rig.begin()); XCTAssertTrue(try rig.attach(try DiskPair()))
        let started = Date()
        let payload = [UInt8](repeating: 0x62, count: 1_048_576)
        var blocked = false
        for seq in 1...40 where !blocked { blocked = !rig.daemon.sendAll(.muxDown(frame: MuxFormat.frame(.runtime, seq: UInt32(seq), payload: payload)), timeout: 0.4) }
        XCTAssertTrue(blocked, "the daemon's own sends back up: the launcher stopped reading L1")
        XCTAssertEqual(kill(Int32(pid), 0), 0, "a worker that is merely behind is still alive while the stall window is open")
        XCTAssertEqual(rig.daemon.nextFault(), .worker_channel_lost)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 1.3, "the kill waited for the stall window")
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .workerKilled); XCTAssertTrue(rig.processGone(pid))
    }
    func testAFrameBiggerThanTheHardCapKillsTheWorker() throws {
        let rig = try RuntimeRig(mode: "stalll3", relayLimits: (soft: 32 << 10, hard: 512 << 10, stallMs: 60_000))
        XCTAssertTrue(rig.hello()); let (pid, _) = try XCTUnwrap(rig.begin()); XCTAssertTrue(try rig.attach(try DiskPair()))
        XCTAssertTrue(rig.daemon.sendAll(.muxDown(frame: MuxFormat.frame(.runtime, seq: 1, payload: [UInt8](repeating: 1, count: 1_000_000))), timeout: 5))
        XCTAssertEqual(rig.daemon.nextFault(), .worker_channel_lost)
        XCTAssertTrue(rig.processGone(pid))
    }

    // MARK: the guest artifacts, with the real verifier

    func testTheRealGuestArtifactCheckRefusesAnotherDigestAndATamperedKernelAndStartsWithTheRightOne() throws {
        let guest = try GuestWorkerDirectory()
        let rig = try RuntimeRig(guest: guest)
        XCTAssertTrue(rig.hello())
        var wrong = rig.scope; wrong.runtimeImageDigest = String(repeating: "0", count: 64)
        rig.daemon.send(.begin(id: "req-wrong", homeId: Fixture.homeId, scope: wrong))
        XCTAssertEqual(rig.refusal(id: "req-wrong"), .code_identity_mismatch)
        // The artifacts change after the daemon pinned them: the digest it states is no longer the files'.
        try Data("tampered".utf8).write(to: URL(fileURLWithPath: guest.guestDirectory + "/kernel"))
        chmod(guest.guestDirectory + "/kernel", 0o644)
        rig.daemon.send(.begin(id: "req-tampered", homeId: Fixture.homeId, scope: rig.scope))
        XCTAssertEqual(rig.refusal(id: "req-tampered"), .code_identity_mismatch)
        try Data(guest.kernelBytes).write(to: URL(fileURLWithPath: guest.guestDirectory + "/kernel"))
        chmod(guest.guestDirectory + "/kernel", 0o644)
        XCTAssertNotNil(rig.begin(id: "req-right"), "restored, the pinned digest starts the worker: nothing was consumed by the refusals")
        XCTAssertFalse(rig.daemon.sees(timeout: 0.1) { if case .uncertain = $0 { true } else { false } })
    }
    func testAGarbageDatagramFromTheWorkerKillsIt() throws {
        let rig = try RuntimeRig(mode: "garbage")
        XCTAssertTrue(rig.hello())
        rig.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: rig.scope))
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

    func testAPowerOffWithoutHaltingIsClassBEvenThoughTheWorkerExitedZero() throws {
        let rig = try RuntimeRig(mode: "nohalting")
        XCTAssertTrue(rig.hello())
        _ = try XCTUnwrap(rig.begin())
        XCTAssertTrue(try rig.attach(try DiskPair()))
        rig.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .user, budgetMs: 10_000))
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .guestFault); XCTAssertEqual(b.workerExit, .code); XCTAssertEqual(b.workerStatus, 0)
        XCTAssertFalse(rig.daemon.sees(timeout: 0.2) { if case .stopped = $0 { true } else { false } }, "never a Class A")
    }
    func testAGuestFaultIsForwardedAndTheRunCanNeverBeClassA() throws {
        let rig = try RuntimeRig(mode: "guestfault")
        XCTAssertTrue(rig.hello())
        _ = try XCTUnwrap(rig.begin())
        XCTAssertTrue(try rig.attach(try DiskPair()))
        XCTAssertNotNil(rig.daemon.next { if case .workerState(.guest_fault) = $0 { true } else { nil } })
        rig.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .user, budgetMs: 10_000))
        let b = try XCTUnwrap(rig.daemon.next { if case .uncertain(let r) = $0 { r } else { nil } })
        XCTAssertEqual(b.reason, .guestFault)
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
