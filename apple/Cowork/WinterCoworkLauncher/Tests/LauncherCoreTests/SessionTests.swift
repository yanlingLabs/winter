import XCTest
@testable import LauncherCore

/// The session state machine against doubles: every decision the launcher makes, deterministically.
final class SessionTests: XCTestCase {
    private func harness() -> SessionHarness { SessionHarness() }
    private func lastBegun(_ h: SessionHarness) -> Bool { h.ports.lines.contains { if case .begun = $0 { true } else { false } } }

    // MARK: start, begin, READY

    func testStartSendsHelloWithTheLauncherAndBootIdentityAndNothingElse() {
        let h = harness(); h.session.start()
        XCTAssertEqual(h.ports.lines, [.hello(launcherInstanceId: Fixture.launcherInstanceId, hostBootId: Fixture.bootId)])
    }
    func testBeginValidatesTheSuspendedImageBeforeResumeThenSendsTheScopeAndArmsReady() throws {
        let h = harness(); h.begin()
        XCTAssertEqual(h.log.all.filter { !$0.hasPrefix("send") }, ["spawn", "validate#1", "resume", "env:scope", "arm:ready", "arm:backstop"], "spawn suspended, validate, resume, only THEN the scope")
        XCTAssertEqual(h.ports.datagrams, [.scope(seq: 1, scope: Fixture.scope)])
        XCTAssertEqual(h.ports.armed[.ready], 10_000)
        XCTAssertFalse(lastBegun(h), "`begun` waits for the worker's READY")
        XCTAssertEqual(h.session.phase, .starting)
    }
    func testTheHomeIdentityComesFromBeginAndOnlyFromBegin() throws {
        let h = harness(); try h.bringUp(scope: Fixture.scope) // default home
        let other = harness(); other.begin(homeId: "home_other"); other.status(.sandboxed)
        let disks = try DiskPair()
        other.send(.volumes(id: "req-volumes", scopeDigest: try EnvelopeFormat.scopeDigest(Fixture.scope), volumes: disks.identities), descriptors: disks.reopen())
        other.status(.volumesAccepted); other.status(.vmRunning); other.stop(); other.cleanHalt(); other.workerExits(.code(0))
        XCTAssertEqual(other.ports.stopped.first?.homeId, "home_other")
        h.stop(); h.cleanHalt(); h.workerExits(.code(0))
        XCTAssertEqual(h.ports.stopped.first?.homeId, Fixture.homeId)
    }
    func testAScopeNamingAnotherRuntimeImageIsRefusedBeforeAnythingIsReservedSpawnedOrSent() {
        let h = harness(); h.artifacts.accept = false
        h.begin(id: "req-1")
        XCTAssertEqual(h.ports.refusals, [.code_identity_mismatch]); XCTAssertEqual(h.ports.spawnCalls, 0)
        XCTAssertTrue(h.ports.datagrams.isEmpty); XCTAssertEqual(h.session.phase, .awaitingBegin); XCTAssertTrue(h.store.records.isEmpty)
        XCTAssertEqual(h.artifacts.asked, [Fixture.scope.runtimeImageDigest], "it was asked about the digest the daemon stated")
        h.artifacts.accept = true; h.begin(id: "req-2")
        XCTAssertEqual(h.session.phase, .starting, "the refusal consumed nothing: the right digest still starts")
    }
    func testReadyValidatesTheRunningImageAgainThenReportsBegun() {
        let h = harness(); h.begin(); h.status(.sandboxed)
        XCTAssertEqual(h.ports.process.validateCalls, 2, "before resume and again after READY")
        XCTAssertEqual(h.ports.lines, [.begun(id: "req-begin", workerInstanceId: Fixture.scope.workerInstanceId, workerPid: 4242, workerStartToken: "1760000000.000001"), .workerState(.sandboxed)])
        XCTAssertNil(h.ports.armed[.ready]); XCTAssertEqual(h.session.phase, .begun)
    }
    func testAnImageThatFailsBeforeResumeIsNeverResumedAndIsKilledThroughTheHandle() {
        let h = harness(); h.ports.process.validateOK = false; h.begin()
        XCTAssertEqual(h.ports.process.resumeCalls, 0, "an image that failed its requirement never runs a single instruction")
        XCTAssertEqual(h.ports.process.killCalls, 1)
        XCTAssertTrue(h.ports.datagrams.isEmpty, "and it is never given a scope")
        XCTAssertEqual(h.ports.refusals, [.code_identity_mismatch])
        XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerKilled])
        XCTAssertTrue(h.ports.stopped.isEmpty)
        XCTAssertEqual(h.session.phase, .finished)
    }
    func testAnImageThatFailsAfterReadyIsKilledAndBegunIsNeverSent() {
        let h = harness(); h.begin()
        h.ports.process.validateOK = false
        h.status(.sandboxed)
        XCTAssertEqual(h.ports.process.killCalls, 1)
        XCTAssertEqual(h.ports.refusals, [.code_identity_mismatch])
        XCTAssertFalse(lastBegun(h))
    }
    func testASpawnFailureRefusesAndLeavesTheLauncherFreeToTryAgain() {
        let h = harness(); h.ports.spawnError = SpawnFailure.failed(ENOENT)
        h.begin(id: "req-1")
        XCTAssertEqual(h.ports.refusals, [.worker_spawn_failed]); XCTAssertEqual(h.session.phase, .awaitingBegin)
        h.ports.spawnError = nil; h.begin(id: "req-2")
        XCTAssertEqual(h.session.phase, .starting, "the reservation of an unconstructed worker was aborted")
    }
    func testAPinnedFileThatChangedIsACodeIdentityMismatch() {
        let h = harness(); h.ports.spawnError = SpawnFailure.imageChanged; h.begin()
        XCTAssertEqual(h.ports.refusals, [.code_identity_mismatch])
    }
    func testTheLauncherServesExactlyOneBegin() {
        let h = harness(); h.begin(id: "req-1"); h.begin(id: "req-2")
        XCTAssertEqual(h.ports.refusals, [.busy]); XCTAssertEqual(h.ports.spawnCalls, 1)
    }
    func testNoReadyInTimeKillsTheWorkerAndRefusesSandboxFailed() {
        let h = harness(); h.begin(); h.session.timerFired(.ready)
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertEqual(h.ports.refusals, [.sandbox_failed]); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerKilled])
    }
    func testAWorkerFaultBeforeReadyRefusesWithTheMatchingCode() {
        for (fault, code) in [(WorkerFault.sandboxFailed, RefusalCode.sandbox_failed), (.badScope, .bad_request), (.vmFailed, .internal)] {
            let h = harness(); h.begin(); h.workerFault(fault)
            XCTAssertEqual(h.ports.refusals, [code], "\(fault)")
            XCTAssertEqual(h.ports.process.killCalls, 1)
        }
    }
    func testAWorkerThatExitsBeforeReadyIsARefusedStartAndClassB() {
        let h = harness(); h.begin(); h.workerExits(.code(79))
        XCTAssertEqual(h.ports.refusals, [.sandbox_failed]); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerCrashed]); XCTAssertEqual(h.ports.process.killCalls, 0)
    }

    // MARK: volumes

    private func volumesLine(_ h: SessionHarness, _ disks: DiskPair, digest: String? = nil, descriptors: [OwnedFD]? = nil, id: String = "req-volumes") throws {
        h.send(.volumes(id: id, scopeDigest: try digest ?? EnvelopeFormat.scopeDigest(Fixture.scope), volumes: disks.identities), descriptors: descriptors ?? disks.reopen())
    }
    func testVolumesBeforeTheWorkerIsReadyAreNotBegun() throws {
        let h = harness(), disks = try DiskPair()
        try volumesLine(h, disks); XCTAssertEqual(h.ports.refusals, [.not_begun])
        h.begin(); try volumesLine(h, disks); XCTAssertEqual(h.ports.refusals, [.not_begun, .not_begun], "still starting: the worker has not said READY")
        XCTAssertFalse(h.ports.datagrams.contains { if case .volumes = $0 { true } else { false } })
    }
    func testTheTwoDescriptorsAreForwardedInOneEnvelopeAndTheLaunchersCopiesAreClosed() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        let disks = try DiskPair()
        var numbers: [Int32] = []
        do {
            let copies = disks.reopen(); numbers = copies.map(\.raw)
            try volumesLine(h, disks, descriptors: copies)
        }
        XCTAssertEqual(h.ports.datagramDescriptorCounts.last, 2, "exactly two descriptors in ONE datagram")
        guard case .volumes(let seq, let digest, let volumes)? = h.ports.datagrams.last else { return XCTFail() }
        XCTAssertEqual(seq, 2); XCTAssertEqual(digest, try EnvelopeFormat.scopeDigest(Fixture.scope)); XCTAssertEqual(volumes, disks.identities)
        for number in numbers { XCTAssertEqual(fcntl(number, F_GETFD), -1, "the launcher keeps no descriptor of an image it has forwarded") }
        XCTAssertEqual(h.session.phase, .attaching); XCTAssertEqual(h.ports.armed[.volumes], 10_000)
        XCTAssertTrue(h.session.evidence.volumesSent); XCTAssertNil(h.session.evidence.attachedVolumes, "forwarded is not accepted")
    }
    func testAScopeDigestThatIsNotTheBegunScopesIsRejectedAndNothingIsForwarded() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        let disks = try DiskPair()
        try volumesLine(h, disks, digest: String(repeating: "00", count: 32))
        XCTAssertEqual(h.ports.refusals, [.volumes_rejected]); XCTAssertEqual(h.ports.datagrams.count, 1); XCTAssertFalse(h.session.evidence.volumesSent)
    }
    func testDescriptorsThatDoNotNameTheFilesTheLineSaysAreRejected() throws {
        func rejected(_ mutate: (inout [VolumeIdentity]) -> Void, descriptors: (DiskPair) -> [OwnedFD]? = { _ in nil }, _ label: String) throws {
            let h = harness(); h.begin(); h.status(.sandboxed)
            let disks = try DiskPair()
            var identities = disks.identities; mutate(&identities)
            let copies = descriptors(disks) ?? disks.reopen()
            h.send(.volumes(id: "req-volumes", scopeDigest: try EnvelopeFormat.scopeDigest(Fixture.scope), volumes: identities), descriptors: copies)
            XCTAssertEqual(h.ports.refusals, [.volumes_rejected], label)
            XCTAssertEqual(h.ports.datagrams.count, 1, "\(label): nothing forwarded"); XCTAssertFalse(h.session.evidence.volumesSent, label)
        }
        try rejected({ $0[0].inode = "1" }, "another inode")
        try rejected({ $0[1].device = "1" }, "another device")
        try rejected({ $0[0].capacityBytes += 4096 }, "another size")
        try rejected({ $0[1].uid += 1 }, "another owner")
        try rejected({ _ in }, descriptors: { d in [OwnedFD(open(d.urls[0].path, O_RDONLY | O_CLOEXEC)), OwnedFD(open(d.urls[1].path, O_RDWR | O_CLOEXEC))] }, "a read-only descriptor")
        try rejected({ _ in }, descriptors: { d in [OwnedFD(open(d.urls[1].path, O_RDWR | O_CLOEXEC)), OwnedFD(open(d.urls[0].path, O_RDWR | O_CLOEXEC))] }, "the two swapped")
        try rejected({ _ in }, descriptors: { _ in [OwnedFD(open("/dev/null", O_RDWR | O_CLOEXEC)), OwnedFD(open("/dev/null", O_RDWR | O_CLOEXEC))] }, "devices, not images")
    }
    /// Hands descriptors to the session and returns their numbers; the caller keeps NO reference, as on the real path.
    private func handOver(_ h: SessionHarness, _ message: LineToLauncher, _ make: () -> [OwnedFD]) -> [Int32] {
        var numbers: [Int32] = []
        do { let descriptors = make(); numbers = descriptors.map(\.raw); h.send(message, descriptors: descriptors) }
        return numbers
    }
    private func noVolumesEnvelope(_ h: SessionHarness) -> Bool { !h.ports.datagrams.contains { if case .volumes = $0 { true } else { false } } }

    func testTheWrongNumberOfDescriptorsIsAProtocolViolationAndEveryOneIsClosed() throws {
        for count in [0, 1, 3] {
            let h = harness(); h.begin(); h.status(.sandboxed)
            let disks = try DiskPair()
            let line = LineToLauncher.volumes(id: "req-volumes", scopeDigest: try EnvelopeFormat.scopeDigest(Fixture.scope), volumes: disks.identities)
            let numbers = handOver(h, line) { (0..<count).map { _ in OwnedFD(open(disks.urls[0].path, O_RDWR | O_CLOEXEC)) } }
            XCTAssertTrue(h.ports.lines.contains(.fault(.protocol_violation)), "\(count) descriptors")
            for number in numbers { XCTAssertEqual(fcntl(number, F_GETFD), -1, "closed") }
            XCTAssertTrue(noVolumesEnvelope(h), "nothing was forwarded")
            XCTAssertFalse(h.session.evidence.volumesSent)
        }
    }
    func testDescriptorsOnAnyOtherLineAreAProtocolViolationAndAreClosed() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        let disks = try DiskPair()
        let numbers = handOver(h, .ping(id: "req-ping")) { disks.reopen() }
        XCTAssertTrue(h.ports.lines.contains(.fault(.protocol_violation)))
        for number in numbers { XCTAssertEqual(fcntl(number, F_GETFD), -1) }
        XCTAssertFalse(h.ports.lines.contains(.pong(id: "req-ping")))
    }
    func testAcceptedIsReportedWithTheStateAndBecomesEvidence() throws {
        let h = harness(); let disks = try h.bringUp(vm: false)
        XCTAssertEqual(h.ports.lines.suffix(2), [.volumesAccepted(id: "req-volumes"), .workerState(.volumes_accepted)])
        XCTAssertEqual(h.session.evidence.attachedVolumes, disks.identities); XCTAssertNil(h.ports.armed[.volumes]); XCTAssertEqual(h.session.phase, .attached)
    }
    func testASecondVolumesOfferIsBusy() throws {
        let h = harness(); let disks = try h.bringUp(vm: false)
        try volumesLine(h, disks, id: "req-again"); XCTAssertEqual(h.ports.refusals, [.busy])
    }
    func testVolumesNotAcknowledgedInTimeAreRefusedAndTheWorkerIsKilled() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        try volumesLine(h, try DiskPair()); h.session.timerFired(.volumes)
        XCTAssertEqual(h.ports.refusals, [.volumes_rejected]); XCTAssertEqual(h.ports.process.killCalls, 1)
        XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerKilled]); XCTAssertTrue(h.ports.uncertain[0].attachedVolumes, "it may have held them")
    }
    func testAWorkerFaultOnTheDisksRefusesThemAndGetsAGraceBeforeItIsKilled() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        try volumesLine(h, try DiskPair()); h.workerFault(.badVolumes)
        XCTAssertEqual(h.ports.refusals, [.volumes_rejected]); XCTAssertEqual(h.ports.process.killCalls, 0); XCTAssertEqual(h.ports.armed[.faultGrace], 5_000)
        h.session.timerFired(.faultGrace)
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.guestFault])
    }

    // MARK: relay

    private func frame(_ cls: MuxClass = .bootstrap, seq: UInt32 = 1) -> [UInt8] { MuxFormat.frame(cls, seq: seq, payload: Array("{\"x\":1}".utf8)) }

    func testFramesAreRelayedBlindInBothDirections() throws {
        let h = harness(); try h.bringUp()
        h.send(.muxDown(frame: frame(.bootstrap, seq: 1))); h.send(.muxDown(frame: frame(.runtime, seq: 1))); h.send(.muxDown(frame: frame(.bootstrap, seq: 2)))
        XCTAssertEqual(h.ports.relayed, [frame(.bootstrap, seq: 1), frame(.runtime, seq: 1), frame(.bootstrap, seq: 2)])
        h.frameUp(.bootstrap, seq: 1, payload: [0xff, 0x00, 0xfe]); h.frameUp(.runtime, seq: 1)
        let up = h.ports.lines.compactMap { if case .muxUp(let f) = $0 { f } else { nil } }
        XCTAssertEqual(up.count, 2); XCTAssertEqual(Array(up[0][16...]), [0xff, 0x00, 0xfe], "the payload is never inspected")
    }
    func testFramesBeforeTheDisksAreAcceptedAreAProtocolViolationEitherWay() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        h.send(.muxDown(frame: frame())); XCTAssertTrue(h.ports.lines.contains(.fault(.protocol_violation))); XCTAssertTrue(h.ports.relayed.isEmpty)
        let g = harness(); _ = try g.bringUp(vm: false)
        let h2 = harness(); h2.begin(); h2.status(.sandboxed); h2.frameUp()
        XCTAssertEqual(h2.ports.process.killCalls, 1); XCTAssertTrue(h2.ports.lines.contains(.fault(.worker_channel_lost)))
    }
    func testASequenceGapFromTheDaemonEndsTheChannel() throws {
        let h = harness(); try h.bringUp()
        h.send(.muxDown(frame: frame(seq: 1))); h.send(.muxDown(frame: frame(seq: 3)))
        XCTAssertEqual(h.ports.relayed.count, 1); XCTAssertTrue(h.ports.lines.contains(.fault(.protocol_violation)))
    }
    func testASequenceGapFromTheWorkerKillsIt() throws {
        let h = harness(); try h.bringUp()
        h.frameUp(seq: 1); h.frameUp(seq: 1)
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertTrue(h.ports.lines.contains(.fault(.worker_channel_lost)))
    }
    func testAControlFrameFromTheWorkerNeverCrossesL3() throws {
        let h = harness(); try h.bringUp()
        h.frameUp(.control, seq: 1)
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertEqual(h.session.relayedUp, 0)
    }
    func testTheProviderClassIsRefusedAtTheHeaderInBothDirections() throws {
        let h = harness(); try h.bringUp()
        var line = Array("{\"v\":1,\"t\":\"mux_down\",\"frame\":\"".utf8)
        line += Array(Data(MuxFormat.frame(.provider, seq: 1, payload: [])).base64EncodedString().utf8) + Array("\"}\n".utf8)
        XCTAssertThrowsError(try LauncherLineCodec.parseToLauncher(line)) { XCTAssertEqual($0 as? WireFailure, .reserved_class) }
        h.session.receiveLine(FramedLine(bytes: line, rights: []))
        XCTAssertTrue(h.ports.lines.contains(.fault(.protocol_violation))); XCTAssertTrue(h.ports.relayed.isEmpty)
        let g = harness(); try g.bringUp(); g.session.workerStreamFailed(.reserved_class)
        XCTAssertEqual(g.ports.process.killCalls, 1)
    }
    func testAFullL3BacklogKillsTheWorker() throws {
        let h = harness(); try h.bringUp(); h.ports.relayOK = false
        h.send(.muxDown(frame: frame()))
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertTrue(h.ports.lines.contains(.fault(.worker_channel_lost)))
    }
    func testNothingIsRelayedAfterTheVerdict() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt(); h.workerExits(.code(0))
        let before = h.ports.lines.count
        h.send(.muxDown(frame: frame())); h.frameUp()
        XCTAssertTrue(h.ports.relayed.isEmpty); XCTAssertEqual(h.ports.lines.count, before)
    }

    // MARK: orderly stop

    func testStopBeforeBeginIsNotBegun() {
        let h = harness(); h.stop(); XCTAssertEqual(h.ports.refusals, [.not_begun])
    }
    func testHostStopSendsDrainWithTheDaemonsNonceAndArmsItsBudget() throws {
        let h = harness(); try h.bringUp(); h.stop(nonce: Fixture.nonce, budget: 20_000)
        guard case .drain(_, let nonce, let budget, let origin)? = h.ports.datagrams.last else { return XCTFail() }
        XCTAssertEqual(nonce, Fixture.nonce); XCTAssertEqual(budget, 20_000); XCTAssertEqual(origin, .hostStop); XCTAssertEqual(h.ports.armed[.drain], 20_000)
        XCTAssertEqual(h.session.phase, .draining)
    }
    func testAnOrderlyStopMintsClassAIsDurableBeforeItIsSentAndIsRetiredOnRequest() throws {
        let h = harness(); let disks = try h.bringUp(); h.stop(); h.cleanHalt()
        XCTAssertTrue(h.ports.stopped.isEmpty, "nothing is claimed before the process has been reaped")
        h.workerExits(.code(0))
        let receipts = h.ports.stopped
        XCTAssertEqual(receipts.count, 1)
        let receipt = try XCTUnwrap(receipts.first)
        XCTAssertEqual(receipt.stopNonce, Fixture.nonce, "the daemon's nonce, echoed exactly"); XCTAssertEqual(receipt.origin, .hostStop)
        XCTAssertTrue(receipt.invariantsHold); XCTAssertEqual(receipt.volumes.map(\.inode), disks.identities.map(\.inode))
        guard case .stopped(let id, _)? = h.ports.lines.last else { return XCTFail() }
        XCTAssertEqual(id, "req-stop")
        let persisted = try XCTUnwrap(h.log.index(of: "persist:A")), sent = try XCTUnwrap(h.log.index(of: "send:stopped"))
        XCTAssertLessThan(persisted, sent, "fsync (persist) precedes send")
        XCTAssertEqual(try h.store.load(ReceiptScope(Fixture.scope)), .orderly(receipt))
        XCTAssertFalse(h.ports.finished, "the receipt stays until the daemon says it is done with it")
        h.send(.receiptRetire(confirmationId: "confirm-not-this-one")); XCTAssertTrue(h.store.retired.isEmpty); XCTAssertFalse(h.ports.finished)
        h.send(.receiptRetire(confirmationId: receipt.confirmationId))
        XCTAssertEqual(h.store.retired, [ReceiptScope(Fixture.scope)]); XCTAssertTrue(h.ports.finished); XCTAssertNil(try h.store.load(ReceiptScope(Fixture.scope)))
    }
    func testAClassAThatCannotBeMadeDurableIsNeverSent() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt(); h.store.failPersist = true
        h.workerExits(.code(0))
        XCTAssertTrue(h.ports.stopped.isEmpty, "not durable, therefore not orderly")
        XCTAssertEqual(h.ports.uncertain.map(\.reason), [.launcherFault])
    }
    func testAnExitNobodyAskedForIsClassBEvenWithStatusZero() throws {
        let h = harness(); try h.bringUp(); h.workerExits(.code(0))
        XCTAssertTrue(h.ports.stopped.isEmpty); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerCrashed])
        XCTAssertEqual(try h.store.load(ReceiptScope(Fixture.scope)).map { if case .uncertain = $0 { "B" } else { "A" } }, "B", "Class B is durable too")
    }
    func testAFlushShortfallIsClassB() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt(flushed: FlushCounters(requested: 2, completed: 1)); h.workerExits(.code(0))
        XCTAssertTrue(h.ports.stopped.isEmpty); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.flushUncertain])
    }
    func testAStopThatArrivesAgainWhileDrainingIsIdempotentAndADifferentOneIsBusy() throws {
        let h = harness(); try h.bringUp(); h.stop(id: "req-stop"); let drains = h.ports.datagrams.count
        h.stop(id: "req-stop"); XCTAssertEqual(h.ports.datagrams.count, drains); XCTAssertTrue(h.ports.refusals.isEmpty)
        h.stop(id: "req-other", nonce: String(repeating: "11", count: 16)); XCTAssertEqual(h.ports.refusals, [.busy])
    }
    func testAStopAfterTheVerdictIsAnsweredFromTheRecordedReceipt() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt(); h.workerExits(.code(0))
        h.stop(id: "req-stop-2"); XCTAssertEqual(h.ports.stopped.count, 2, "the same receipt, answered again")
        h.stop(id: "req-stop-3", nonce: String(repeating: "22", count: 16)); XCTAssertEqual(h.ports.refusals, [.busy], "another nonce is not the stop that was answered")
    }
    func testStopWhileStillStartingTakesTheWorkerDown() {
        let h = harness(); h.begin(); h.stop()
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertEqual(h.ports.refusals, [.worker_spawn_failed]); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerKilled])
    }
    func testAFailedStartIsStoppedAndAnsweredClassAWhenNothingWasHeld() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        h.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .failedStart, budgetMs: 30_000))
        h.status(.draining); h.status(.exiting); h.workerExits(.code(0))
        let receipt = try XCTUnwrap(h.ports.stopped.first)
        XCTAssertTrue(receipt.invariantsHold); XCTAssertEqual(receipt.volumes, [.unattached(.data), .unattached(.environment)]); XCTAssertEqual(receipt.guestDrain, .notBooted)
    }
    func testTheDrainBudgetRunningOutKillsThroughTheOwnedHandleAndYieldsClassBNeverA() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.status(.draining)
        h.session.timerFired(.drain)
        XCTAssertEqual(h.ports.process.killCalls, 1)
        XCTAssertEqual(h.ports.uncertain.map(\.reason), [.drainTimeout]); XCTAssertTrue(h.ports.stopped.isEmpty)
        XCTAssertLessThan(try XCTUnwrap(h.log.index(of: "kill")), try XCTUnwrap(h.log.index(of: "send:uncertain")))
    }

    // MARK: owner loss

    func testOwnerLossBeforeAnyWorkerJustEnds() {
        let h = harness(); h.session.daemonChannelClosed()
        XCTAssertTrue(h.ports.finished); XCTAssertTrue(h.store.records.isEmpty)
    }
    func testOwnerLossStartsAThirtySecondDrainWithTheLaunchersOwnNonce() throws {
        let h = harness(); try h.bringUp(); h.session.daemonChannelClosed()
        guard case .drain(_, let nonce, let budget, let origin)? = h.ports.datagrams.last else { return XCTFail() }
        XCTAssertEqual(origin, .ownerLoss); XCTAssertEqual(budget, 30_000); XCTAssertEqual(h.ports.armed[.drain], 30_000)
        XCTAssertEqual(nonce.count, 32); XCTAssertNotEqual(nonce, Fixture.nonce)
        XCTAssertEqual(h.ports.process.killCalls, 0, "nothing is killed while the drain budget lasts")
        XCTAssertFalse(h.ports.finished)
    }
    func testAnOwnerLossDrainThatCompletesLeavesADurableClassAWithItsOwnOriginAndSendsNothingToAnyone() throws {
        let h = harness(); try h.bringUp(); h.session.daemonChannelClosed(); h.cleanHalt(); h.workerExits(.code(0))
        guard case .orderly(let r)? = try h.store.load(ReceiptScope(Fixture.scope)) else { return XCTFail("a durable Class A") }
        XCTAssertEqual(r.origin, .ownerLossDrain); XCTAssertTrue(r.invariantsHold)
        XCTAssertTrue(h.ports.finished, "nobody is waiting: the next daemon decides what the receipt means")
        XCTAssertEqual(h.store.retired, [], "owner loss never retires or releases anything")
    }
    func testAnOwnerLossDrainThatRunsOutKillsTheOwnedHandleAndLeavesDurableClassBNotA() throws {
        let h = harness(); try h.bringUp(); h.session.daemonChannelClosed(); h.session.timerFired(.drain)
        XCTAssertEqual(h.ports.process.killCalls, 1)
        guard case .uncertain(let b)? = try h.store.load(ReceiptScope(Fixture.scope)) else { return XCTFail("a durable Class B") }
        XCTAssertEqual(b.reason, .drainTimeout); XCTAssertTrue(h.ports.finished)
    }
    func testOwnerLossWhileStartingTakesTheWorkerDownAtOnce() {
        let h = harness(); h.begin(); h.session.daemonChannelClosed()
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertTrue(h.ports.finished)
        guard case .uncertain(let b)? = try? h.store.load(ReceiptScope(Fixture.scope)) else { return XCTFail() }
        XCTAssertEqual(b.reason, .daemonLost)
    }
    func testOwnerLossWhileTheDisksAreBeingTransferredLetsTheDrainBudgetJudgeIt() throws {
        let h = harness(); h.begin(); h.status(.sandboxed)
        try volumesLine(h, try DiskPair()); XCTAssertEqual(h.ports.armed[.volumes], 10_000)
        h.session.daemonChannelClosed()
        XCTAssertNil(h.ports.armed[.volumes], "the transfer timer no longer applies")
        XCTAssertEqual(h.ports.armed[.drain], 30_000)
        h.session.timerFired(.drain)
        XCTAssertEqual(h.ports.uncertain.map(\.reason), [.drainTimeout]); XCTAssertTrue(h.ports.uncertain[0].attachedVolumes)
    }
    func testOwnerLossDuringAHostStopCapsALongerBudgetAtThirtySecondsAndKeepsAShorterOne() throws {
        let long = harness(); try long.bringUp(); long.stop(budget: 120_000); long.session.daemonChannelClosed()
        XCTAssertEqual(long.ports.armed[.drain], 30_000)
        let short = harness(); try short.bringUp(); short.stop(budget: 5_000); short.clockBox.value += 1_000; short.session.daemonChannelClosed()
        XCTAssertEqual(short.ports.armed[.drain], 5_000, "owner loss only ever shortens the drain")
        XCTAssertEqual(short.ports.datagrams.filter { if case .drain = $0 { true } else { false } }.count, 1, "the drain already under way is not restarted")
    }
    func testOwnerLossAfterTheVerdictEnds() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt(); h.workerExits(.code(0)); XCTAssertFalse(h.ports.finished)
        h.session.daemonChannelClosed(); XCTAssertTrue(h.ports.finished); XCTAssertEqual(h.store.retired, [], "EOF does not retire the receipt")
    }
    func testATerminationSignalDrainsLikeOwnerLossAndEndsTheProcessEvenWithTheDaemonStillListening() throws {
        let h = harness(); try h.bringUp(); h.session.terminationRequested()
        guard case .drain(_, _, let budget, let origin)? = h.ports.datagrams.last else { return XCTFail("the worker is drained, never left behind") }
        XCTAssertEqual(origin, .ownerLoss); XCTAssertEqual(budget, 30_000); XCTAssertFalse(h.ports.finished)
        h.cleanHalt(); h.workerExits(.code(0))
        guard case .stopped(let id, let receipt)? = h.ports.lines.last else { return XCTFail("a daemon that is still there is told") }
        XCTAssertNil(id); XCTAssertEqual(receipt.origin, .ownerLossDrain)
        XCTAssertTrue(h.ports.finished, "and the process ends without waiting to be retired")
        XCTAssertNotNil(try h.store.load(ReceiptScope(Fixture.scope)))
    }
    func testATerminationSignalBeforeAnyWorkerJustEndsAndOneAfterTheVerdictToo() throws {
        let a = harness(); a.session.terminationRequested(); XCTAssertTrue(a.ports.finished)
        let b = harness(); try b.bringUp(); b.stop(); b.cleanHalt(); b.workerExits(.code(0)); XCTAssertFalse(b.ports.finished)
        b.session.terminationRequested(); XCTAssertTrue(b.ports.finished); XCTAssertEqual(b.store.retired, [], "a signal does not retire the receipt")
    }
    func testADrainThatCouldNotBeHandedToTheWorkerIsNotEvidenceOfADrain() throws {
        let h = harness(); try h.bringUp(); h.ports.workerSendOK = false
        h.stop()
        XCTAssertNil(h.session.evidence.drain)
        XCTAssertEqual(h.ports.process.killCalls, 1); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.launcherFault]); XCTAssertTrue(h.ports.stopped.isEmpty)
    }

    func testAProtocolViolationOnL1IsOwnerLossAfterOneFaultLine() throws {
        let h = harness(); try h.bringUp()
        h.sendRaw("this is not json\n")
        XCTAssertEqual(h.ports.lines.filter { $0 == .fault(.protocol_violation) }.count, 1); XCTAssertTrue(h.ports.daemonChannelClosed)
        guard case .drain(_, _, _, let origin)? = h.ports.datagrams.last else { return XCTFail("the worker is drained, not abandoned") }
        XCTAssertEqual(origin, .ownerLoss)
        h.sendRaw("{\"v\":1,\"t\":\"ping\",\"id\":\"req-1\"}\n")
        XCTAssertFalse(h.ports.lines.contains(.pong(id: "req-1")), "a faulted channel reads nothing more")
    }

    // MARK: the worker breaking the contract

    func testEveryWorkerProtocolViolationKillsItThroughTheOwnedHandle() throws {
        func violation(_ label: String, _ act: (SessionHarness) throws -> Void, setup: (SessionHarness) throws -> Void = { try $0.bringUp() }) throws {
            let h = harness(); try setup(h); try act(h)
            XCTAssertEqual(h.ports.process.killCalls, 1, label); XCTAssertTrue(h.ports.lines.contains(.fault(.worker_channel_lost)), label)
            XCTAssertTrue(h.ports.stopped.isEmpty, label); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerKilled], label)
        }
        try violation("garbage datagram") { $0.session.receiveWorkerDatagram([1, 2, 3], descriptors: []) }
        try violation("descriptors from the worker") { h in h.session.receiveWorkerDatagram(try EnvelopeFormat.serialize(.status(seq: h.workerSeq + 1, state: .vmRunning, data: FlushCounters(), environment: FlushCounters())), descriptors: [OwnedFD(open("/dev/null", O_RDONLY | O_CLOEXEC))]) }
        try violation("a sequence gap") { $0.status(.exiting, seq: $0.workerSeq + 5) }
        try violation("a repeated sequence") { h in h.status(.exiting, seq: h.workerSeq) }
        try violation("draining nobody asked for") { $0.status(.draining) }
        try violation("drain_acked without a drain") { $0.status(.drainAcked) }
        try violation("guest_halted without a VM", { $0.status(.guestHalted) }, setup: { try $0.bringUp(vm: false) })
        try violation("guest_hello before vm_running", { $0.status(.guestHello) }, setup: { try $0.bringUp(vm: false) })
        try violation("vm_running before the disks", { $0.status(.vmRunning) }, setup: { $0.begin(); $0.status(.sandboxed) })
        try violation("sandboxed twice", { $0.status(.sandboxed) })
        try violation("volumes_accepted that nobody offered", { $0.status(.volumesAccepted) })
        try violation("a counter that goes backwards", { $0.status(.exiting, data: FlushCounters(requested: 0, completed: 0)) }, setup: { h in try h.bringUp(); h.status(.exiting, data: FlushCounters(requested: 3, completed: 3)) })
        try violation("completed beyond requested") { $0.status(.exiting, data: FlushCounters(requested: 1, completed: 2)) }
        try violation("a kind the worker may not send") { h in h.session.receiveWorkerDatagram(try EnvelopeFormat.serialize(.drain(seq: h.workerSeq + 1, stopNonce: Fixture.nonce, budgetMs: 1, origin: .hostStop)), descriptors: []) }
    }
    func testAWorkerFaultLaterOnGetsAGraceThenIsKilledAndIsNeverClassA() throws {
        let h = harness(); try h.bringUp(); h.workerFault(.vmFailed)
        XCTAssertEqual(h.ports.process.killCalls, 0); XCTAssertEqual(h.ports.armed[.faultGrace], 5_000)
        h.stop(); h.cleanHalt(); h.workerExits(.code(0))
        XCTAssertTrue(h.ports.stopped.isEmpty); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.guestFault])
    }

    // MARK: small things

    func testPingIsAnsweredInEveryPhase() throws {
        let h = harness(); h.send(.ping(id: "req-1")); try h.bringUp(); h.send(.ping(id: "req-2")); h.stop(); h.cleanHalt(); h.workerExits(.code(0)); h.send(.ping(id: "req-3"))
        XCTAssertEqual(h.ports.lines.filter { if case .pong = $0 { true } else { false } }.count, 3)
    }
    // MARK: an exit the kernel announced but the child was not yet waitable for

    func testAnExitThatIsNotWaitableYetIsProbedAgainOnAShortTimerUntilItIsJudged() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt()
        h.ports.process.probeSequence = [.running, .running, .code(0)]
        h.session.workerProcessEnded()
        XCTAssertTrue(h.ports.stopped.isEmpty); XCTAssertEqual(h.ports.armed[.exitProbe], 10, "retry soon, not never")
        h.fire(.exitProbe); XCTAssertTrue(h.ports.stopped.isEmpty); XCTAssertEqual(h.ports.armed[.exitProbe], 10)
        h.fire(.exitProbe)
        XCTAssertEqual(h.ports.stopped.count, 1, "the third probe saw the exit: it is judged (Class A, the chain was complete)")
        XCTAssertNil(h.ports.armed[.exitProbe]); XCTAssertEqual(h.session.phase, .finished)
    }
    func testTheRetriesAreBoundedAndTheBackstopCoversWhatTheyMiss() throws {
        var config = Fixture.config(); config.exitProbeAttempts = 3
        let h = SessionHarness(config: config); try h.bringUp()
        h.ports.process.probeResult = .running
        h.session.workerProcessEnded()
        for _ in 0..<3 { h.fire(.exitProbe) }
        XCTAssertNil(h.ports.armed[.exitProbe], "after the bound the short retries stop")
        XCTAssertEqual(h.ports.armed[.backstop], 1_000, "the coarse backstop is armed while a worker exists")
        h.fire(.backstop)
        XCTAssertEqual(h.ports.armed[.backstop], 1_000, "and re-armed every time it fires"); XCTAssertNil(h.ports.armed[.exitProbe], "a backstop probe that finds the worker running starts no retries")
        XCTAssertNil(h.session.verdict)
        h.ports.process.probeResult = .code(79)   // the exit event never came; the backstop finds it
        h.fire(.backstop)
        XCTAssertEqual(h.ports.uncertain.map(\.reason), [.workerCrashed]); XCTAssertNil(h.ports.armed[.backstop], "the verdict disarms it")
    }
    func testWhatTheWorkerSaidBeforeItEndedIsReadBeforeTheExitIsJudged() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt()
        h.workerExits(.code(0))
        let drained = try XCTUnwrap(h.log.index(of: "drain-inputs")), persisted = try XCTUnwrap(h.log.index(of: "persist:A"))
        XCTAssertLessThan(drained, persisted)
        XCTAssertEqual(h.ports.drainCalls, 1)
    }
    func testInputsDrainedAtTheExitCanStillCondemnIt() throws {
        // Something the worker wrote just before it ended turns out to break the contract: the exit is then judged Class B, not A.
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt()
        h.ports.onDrain = { h.session.receiveWorkerDatagram([1, 2, 3], descriptors: []) }
        h.workerExits(.code(0))
        XCTAssertTrue(h.ports.stopped.isEmpty); XCTAssertEqual(h.ports.uncertain.count, 1, "judged exactly once")
    }
    func testASecondDrainFaultFromTheWorkerIsAFaultLikeAnyOther() throws {
        let h = harness(); try h.bringUp(); h.stop()
        XCTAssertEqual(h.ports.datagrams.filter { if case .drain = $0 { true } else { false } }.count, 1, "the launcher sends exactly one DRAIN")
        h.workerFault(.secondDrain)
        h.cleanHalt(); h.workerExits(.code(0))
        XCTAssertTrue(h.ports.stopped.isEmpty); XCTAssertEqual(h.ports.uncertain.map(\.reason), [.guestFault])
    }

    func testPowerEventsAreReportedUpwardAndChangeNothing() throws {
        let h = harness(); try h.bringUp(); let phase = h.session.phase
        h.session.powerEvent(.willSleep); h.session.powerEvent(.didWake)
        XCTAssertEqual(h.power.events, [.willSleep, .didWake]); XCTAssertEqual(h.session.phase, phase); XCTAssertEqual(h.ports.process.killCalls, 0)
    }
    func testWorkerStatesAreForwardedAsInformationOnly() throws {
        let h = harness(); try h.bringUp(); h.stop(); h.cleanHalt()
        let states = h.ports.lines.compactMap { if case .workerState(let s) = $0 { s } else { nil } }
        XCTAssertEqual(states, [.sandboxed, .volumes_accepted, .vm_running, .guest_hello, .draining, .drain_acked])
    }
}
