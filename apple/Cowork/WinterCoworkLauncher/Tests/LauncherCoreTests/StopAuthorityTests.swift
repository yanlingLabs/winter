import XCTest
@testable import LauncherCore

/// Class A means "terminated AND flushed AND consistent". Each row below breaks exactly one link and must come out Class B.
final class StopAuthorityTests: XCTestCase {
    private let context = StopContext(scope: Fixture.scope, homeId: Fixture.homeId, launcherInstanceId: Fixture.launcherInstanceId, hostBootId: Fixture.bootId, workerPid: 4242, workerStartToken: "1760000000.000001")
    private let pair = [VolumeIdentity(purpose: .data, device: "16777234", inode: "111", uid: 501, capacityBytes: 16 << 20), VolumeIdentity(purpose: .environment, device: "16777234", inode: "222", uid: 501, capacityBytes: 16 << 20)]
    private let one = FlushCounters(requested: 1, completed: 1)

    private func evidence(attached: Bool = true, booted: Bool = true, drain: Bool = true, acked: Bool = true, halted: Bool = true, counters: CounterPair? = nil, sent: Bool? = nil) -> WorkerEvidence {
        var e = WorkerEvidence()
        e.volumesSent = sent ?? attached
        if attached { e.attachedVolumes = pair; e.statuses.insert(.volumesAccepted) }
        if booted { e.statuses.formUnion([.vmRunning, .guestHello]) }
        if drain { e.drain = DrainRecord(nonce: Fixture.nonce, origin: .hostStop) }
        if acked { e.statuses.insert(.drainAcked) }
        if halted { e.statuses.insert(.guestHalted); e.finalCounters = counters ?? CounterPair(data: one, environment: FlushCounters()) }
        return e
    }
    private func decide(_ e: WorkerEvidence, exit: WorkerExit = .code(0), killSent: Bool = false, killReason: UncertainReason? = nil, demote: UncertainReason? = nil) -> StopReceipt {
        OrderlyStopAuthority.decide(context: context, exit: exit, evidence: e, killSent: killSent, killReason: killReason, issuedAtMs: 1_760_000_000_000, confirmationId: "confirm-test", demoteTo: demote)
    }
    private func reason(_ r: StopReceipt, file: StaticString = #filePath, line: UInt = #line) -> UncertainReason? {
        guard case .uncertain(let b) = r else { XCTFail("expected Class B, got \(r)", file: file, line: line); return nil }
        return b.reason
    }

    func testAFullyFlushedOrderlyStopIsClassAAndSatisfiesTheContractsInvariants() throws {
        guard case .orderly(let r) = decide(evidence()) else { return XCTFail("expected Class A") }
        XCTAssertTrue(r.invariantsHold)
        XCTAssertEqual(r.confirmationId, "confirm-test"); XCTAssertEqual(r.stopNonce, Fixture.nonce); XCTAssertEqual(r.origin, .hostStop)
        XCTAssertEqual(r.homeId, Fixture.homeId); XCTAssertEqual(r.hostBootId, Fixture.bootId); XCTAssertEqual(r.launcherInstanceId, Fixture.launcherInstanceId)
        XCTAssertEqual([r.workspaceId, r.incarnationId, r.admissionId, r.controllerInstanceId, r.workerInstanceId, r.runtimeImageDigest], [Fixture.scope.workspaceId, Fixture.scope.incarnationId, Fixture.scope.admissionId, Fixture.scope.controllerInstanceId, Fixture.scope.workerInstanceId, Fixture.scope.runtimeImageDigest])
        XCTAssertEqual(r.leaseEpoch, 3); XCTAssertEqual(r.workerPid, 4242); XCTAssertEqual(r.guestDrain, .acked); XCTAssertEqual(r.guestPowerOff, .observed)
        XCTAssertEqual(r.volumes.map(\.inode), ["111", "222"], "an attached entry names the exact file the daemon sent")
        XCTAssertEqual(r.volumes[0].flushRequested, 1); XCTAssertEqual(r.volumes[0].flushCompleted, 1); XCTAssertTrue(r.volumes.allSatisfy { $0.finalFlush == .completed && $0.attached })
        XCTAssertEqual(try StopReceipt.parse(StopReceipt.orderly(r).serialize()), .orderly(r), "and it survives its own wire format")
    }
    func testAnUnattachedNeverBootedStopIsClassAWithZerosThatNameNothing() throws {
        guard case .orderly(let r) = decide(evidence(attached: false, booted: false, acked: false, halted: false)) else { return XCTFail() }
        XCTAssertTrue(r.invariantsHold)
        XCTAssertEqual(r.guestDrain, .notBooted); XCTAssertEqual(r.guestPowerOff, .notBooted)
        XCTAssertEqual(r.volumes, [.unattached(.data), .unattached(.environment)])
    }
    func testAttachedButNeverBootedWroteNothingAndIsClassA() throws {
        guard case .orderly(let r) = decide(evidence(booted: false, acked: false, halted: false)) else { return XCTFail() }
        XCTAssertTrue(r.invariantsHold)
        XCTAssertTrue(r.volumes.allSatisfy { $0.attached && $0.flushRequested == 0 && $0.flushCompleted == 0 && $0.finalFlush == .completed })
    }

    func testEveryBrokenLinkIsClassB() {
        // terminated
        XCTAssertEqual(reason(decide(evidence(), exit: .code(79))), .workerCrashed)
        XCTAssertEqual(reason(decide(evidence(), exit: .signal(SIGSEGV))), .workerCrashed)
        XCTAssertEqual(reason(decide(evidence(), exit: .signal(SIGKILL), killSent: true, killReason: .drainTimeout)), .drainTimeout)
        XCTAssertEqual(reason(decide(evidence(), exit: .signal(SIGKILL), killSent: true)), .workerKilled)
        XCTAssertEqual(reason(decide(evidence(), exit: .uncertain(ETIMEDOUT))), .launcherFault)
        XCTAssertEqual(reason(decide(evidence(), exit: .lost(ECHILD))), .launcherFault)
        XCTAssertEqual(reason(decide(evidence(), exit: .running)), .launcherFault)
        // consistent
        var faulted = evidence(); faulted.fault = .vmFailed
        XCTAssertEqual(reason(decide(faulted)), .guestFault)
        var violated = evidence(); violated.violations = ["envelope sequence"]
        XCTAssertEqual(reason(decide(violated)), .guestFault)
        // asked for
        XCTAssertEqual(reason(decide(evidence(drain: false))), .workerCrashed, "exit 0 that nobody asked for is a crash that returned 0")
        // flushed
        XCTAssertEqual(reason(decide(evidence(acked: false))), .flushUncertain, "booted but never acknowledged the drain")
        XCTAssertEqual(reason(decide(evidence(halted: false))), .flushUncertain, "booted but never reported power-off and the final flush")
        XCTAssertEqual(reason(decide(evidence(counters: CounterPair(data: FlushCounters(requested: 2, completed: 1), environment: FlushCounters())))), .flushUncertain, "a requested flush that did not complete")
        XCTAssertEqual(reason(decide(evidence(counters: CounterPair(data: one, environment: FlushCounters(requested: 1, completed: 0))))), .flushUncertain)
        XCTAssertEqual(reason(decide(evidence(booted: false, acked: false, halted: true, counters: CounterPair(data: one, environment: FlushCounters())))), .flushUncertain, "flushes without a VM")
        // held
        XCTAssertEqual(reason(decide(evidence(attached: false, sent: true))), .flushUncertain, "descriptors were handed over and never acknowledged")
        XCTAssertEqual(reason(decide(evidence(attached: false, booted: true, sent: false))), .guestFault, "a VM without disks")
    }
    func testAnAttachedVMThatNeverRanMustShowNoFlushAtAllInAnyStatus() {
        // Counters on the LAST status (guest_halted / exiting) …
        XCTAssertEqual(reason(decide(evidence(booted: false, acked: false, halted: true, counters: CounterPair(data: one, environment: FlushCounters())))), .flushUncertain)
        // … and counters carried by ANY earlier status (here only `latestCounters` knows), which the last-status check alone would miss.
        var earlier = evidence(booted: false, acked: false, halted: false)
        earlier.latestCounters = CounterPair(data: FlushCounters(requested: 1, completed: 1), environment: FlushCounters())
        XCTAssertNil(earlier.finalCounters)
        XCTAssertEqual(reason(decide(earlier)), .flushUncertain)
        // All zero is a clean never-booted stop.
        var clean = evidence(booted: false, acked: false, halted: false); clean.latestCounters = CounterPair()
        guard case .orderly = decide(clean) else { return XCTFail("zero counters are the honest story of a VM that never ran") }
    }
    func testBootedMeansTheWorkerSentVMRunningAndNothingElseImpliesIt() {
        var e = WorkerEvidence(); XCTAssertFalse(e.booted)
        for status in [WorkerStatus.sandboxed, .volumesAccepted, .guestHello, .draining, .drainAcked, .guestHalted, .exiting] { e.statuses = [status]; XCTAssertFalse(e.booted, "\(status)") }
        e.statuses = [.vmRunning]; XCTAssertTrue(e.booted)
    }
    func testClassBCarriesWhatTheLauncherSawAndNothingThatCouldReleaseAnything() throws {
        guard case .uncertain(let b) = decide(evidence(), exit: .signal(SIGKILL), killSent: true, killReason: .drainTimeout) else { return XCTFail() }
        XCTAssertEqual(b.workerExit, .signal); XCTAssertEqual(b.workerStatus, Int(SIGKILL)); XCTAssertTrue(b.attachedVolumes)
        let text = String(decoding: try StopReceipt.uncertain(b).serialize(), as: UTF8.self)
        for forbidden in ["confirmationId", "stopNonce", "volumes\":["] { XCTAssertFalse(text.contains(forbidden), "Class B must not carry \(forbidden)") }
        guard case .uncertain(let c) = decide(evidence(), exit: .uncertain(EBUSY)) else { return XCTFail() }
        XCTAssertEqual(c.workerExit, .unknown)
    }
    func testAVerdictThatCannotBeMadeDurableIsDemotedNeverSentAsOrderly() {
        XCTAssertEqual(reason(decide(evidence(), demote: .launcherFault)), .launcherFault)
    }
    func testClassAOwnerLossDrainCarriesItsOwnOrigin() throws {
        var e = evidence(); e.drain = DrainRecord(nonce: String(repeating: "a5", count: 16), origin: .ownerLossDrain)
        guard case .orderly(let r) = decide(e) else { return XCTFail() }
        XCTAssertEqual(r.origin, .ownerLossDrain); XCTAssertEqual(r.stopNonce, String(repeating: "a5", count: 16))
    }
}
