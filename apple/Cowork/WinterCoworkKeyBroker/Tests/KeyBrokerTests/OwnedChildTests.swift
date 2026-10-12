import XCTest
import Darwin
import KeyBrokerNative
@testable import KeyBrokerCore

private final class InjectedChild: ChildOperations {
    let pid: Int32=4242
    var resumeResult=ChildWaitResult(state:.ownedRunning)
    var waitResult=ChildWaitResult(state:.confirmedExit,status:0)
    var resumes=0
    var waits: [(Int32,Int32)]=[]
    var onWait: (() -> Void)?
    func resume() -> ChildWaitResult { resumes+=1;return resumeResult }
    func wait(milliseconds: Int32, reapMilliseconds: Int32) -> ChildWaitResult {
        waits.append((milliseconds,reapMilliseconds));onWait?();return waitResult
    }
}

final class OwnedChildTests: XCTestCase {
    func testNativeDeadlineAndErrorMatrixUsesSameAlgorithmWithoutRealPIDs() {
        // exit; ECHILD; EIO; EINTR storm; kill/reap; post-kill EINTR timeout;
        // ESRCH without reap; exit just before kill; post-kill ECHILD;
        // failed clock; changed SIGCHLD policy; interrupted final ownership probe;
        // PID zero/negative defense; invalid timeout refuses without a signal.
        for scenario in 0...14 { XCTAssertEqual(kb_fixture_wait_scenario(Int32(scenario)),1,"scenario \(scenario)") }
    }
    func testConfirmedExitPreservesStatusAndNeverSignalsOrWaitsAgain() throws {
        let ledger=ChildOwnershipLedger(capacity:1),ops=InjectedChild()
        ops.waitResult=ChildWaitResult(state:.confirmedExit,status:71)
        var child: OwnedChild?=try OwnedChild(testing:ops,ledger:ledger)
        XCTAssertEqual(try child?.waitStatus(),71)
        XCTAssertEqual(child?.lifecycle.state,.confirmedExit)
        XCTAssertEqual(ledger.count,0)
        XCTAssertThrowsError(try child?.resume())
        XCTAssertThrowsError(try child?.waitStatus())
        child=nil
        XCTAssertEqual(ops.resumes,0);XCTAssertEqual(ops.waits.count,1)
    }
    func testNegativeWaitRetainsDebtAndCannotSignalOnResumeRetryOrDeinit() throws {
        for state in [ChildWaitResult.State.terminationUncertain,.lostOwnership] {
            let ledger=ChildOwnershipLedger(capacity:1),ops=InjectedChild()
            ops.waitResult=ChildWaitResult(state:state,systemError:state == .lostOwnership ? ECHILD : EIO)
            var child: OwnedChild?=try OwnedChild(testing:ops,ledger:ledger)
            XCTAssertThrowsError(try child?.waitStatus())
            XCTAssertNil(child?.lifecycle.status);XCTAssertEqual(child?.lifecycle.state,state)
            XCTAssertThrowsError(try child?.resume());XCTAssertThrowsError(try child?.waitStatus())
            child=nil
            XCTAssertEqual(ops.waits.count,1);XCTAssertEqual(ops.resumes,0)
            XCTAssertEqual(ledger.count,1);XCTAssertEqual(ledger.debts.count,1)
            XCTAssertEqual(ledger.debts.first?.result.state,state)
        }
    }
    func testTimeoutWithConfirmedReapReleasesAdmissionButStillReportsTimeout() throws {
        let ledger=ChildOwnershipLedger(capacity:1),ops=InjectedChild()
        ops.waitResult=ChildWaitResult(state:.confirmedExit,status:137,timedOut:true,killSent:true)
        var child: OwnedChild?=try OwnedChild(testing:ops,ledger:ledger)
        XCTAssertThrowsError(try child?.waitStatus()) { error in
            guard case ChildLifecycleFailure.timeout(let result)=error else { return XCTFail("expected explicit timeout") }
            XCTAssertEqual(result.status,137);XCTAssertTrue(result.killSent)
        }
        XCTAssertEqual(child?.lifecycle.state,.confirmedExit)
        child=nil;XCTAssertEqual(ops.waits.count,1);XCTAssertEqual(ledger.count,0);XCTAssertTrue(ledger.debts.isEmpty)
    }
    func testDestructorUsesImmediateTerminationAndBoundedReapWindow() throws {
        let ledger=ChildOwnershipLedger(capacity:1),ops=InjectedChild()
        var child: OwnedChild?=try OwnedChild(testing:ops,ledger:ledger)
        XCTAssertEqual(child?.lifecycle.state,.ownedRunning);child=nil
        XCTAssertEqual(ops.waits.count,1);XCTAssertEqual(ops.waits[0].0,0);XCTAssertEqual(ops.waits[0].1,250)
        XCTAssertEqual(ledger.count,0)
    }
    func testDestructorRetainsUnconfirmedOwnershipRatherThanDroppingHandle() throws {
        let ledger=ChildOwnershipLedger(capacity:1)
        var ops: InjectedChild?=InjectedChild()
        ops!.waitResult=ChildWaitResult(state:.terminationUncertain,systemError:ETIMEDOUT,timedOut:true,killSent:true)
        weak var retained=ops
        var child: OwnedChild?=try OwnedChild(testing:ops!,ledger:ledger)
        ops=nil;XCTAssertNotNil(child);child=nil
        XCTAssertNotNil(retained);XCTAssertEqual(ledger.debts.count,1)
        XCTAssertTrue(ledger.debts[0].result.killSent);XCTAssertNil(ledger.debts[0].result.status)
    }
    func testDebtAndActiveOwnersConsumeBoundedCapacityAndAreNeverEvicted() throws {
        let ledger=ChildOwnershipLedger(capacity:2),first=InjectedChild(),second=InjectedChild()
        first.waitResult=ChildWaitResult(state:.lostOwnership,systemError:ECHILD)
        var a: OwnedChild?=try OwnedChild(testing:first,ledger:ledger)
        var b: OwnedChild?=try OwnedChild(testing:second,ledger:ledger)
        XCTAssertThrowsError(try a?.waitStatus());a=nil
        let refused=InjectedChild()
        XCTAssertThrowsError(try OwnedChild(testing:refused,ledger:ledger)) { error in
            guard case ChildLifecycleFailure.admissionBlocked=error else { return XCTFail("expected admission refusal") }
        }
        XCTAssertEqual(refused.waits.count,0);XCTAssertEqual(refused.resumes,0)
        XCTAssertEqual(ledger.count,2);XCTAssertEqual(ledger.debts.count,1)
        try b?.wait();b=nil
        XCTAssertEqual(ledger.count,1);XCTAssertEqual(ledger.debts.count,1)
        var c: OwnedChild?=try OwnedChild(testing:InjectedChild(),ledger:ledger)
        XCTAssertNotNil(c);c=nil
        XCTAssertEqual(ledger.count,1);XCTAssertEqual(ledger.debts.count,1)
    }
    func testResumeLostOwnershipCannotIssueLaterTerminationAttempt() throws {
        let ledger=ChildOwnershipLedger(capacity:1),ops=InjectedChild()
        ops.resumeResult=ChildWaitResult(state:.lostOwnership,systemError:ECHILD)
        var child: OwnedChild?=try OwnedChild(testing:ops,ledger:ledger)
        XCTAssertThrowsError(try child?.resume());child=nil
        XCTAssertEqual(ops.resumes,1);XCTAssertEqual(ops.waits.count,0);XCTAssertEqual(ledger.debts.count,1)
    }
    func testConcurrentLifecycleCallRefusesWithoutChangingTheOwner() throws {
        let ledger=ChildOwnershipLedger(capacity:1),ops=InjectedChild()
        let child=try OwnedChild(testing:ops,ledger:ledger)
        ops.onWait={
            do { try child.resume();XCTFail("expected busy refusal") }
            catch ChildLifecycleFailure.busy {} catch { XCTFail("unexpected lifecycle error") }
        }
        try child.wait();ops.onWait=nil
        XCTAssertEqual(ops.resumes,0);XCTAssertEqual(ledger.count,0)
    }
}
