import Foundation
import Darwin
import KeyBrokerNative

public struct ChildWaitResult: Equatable, Codable, Sendable {
    public enum State: String, Codable, Sendable { case ownedRunning, confirmedExit, terminationUncertain, lostOwnership }
    public let state: State
    public let status: Int32?
    public let systemError: Int32
    public let timedOut: Bool
    public let killSent: Bool
    init(_ result: kb_wait_result) {
        state = switch result.state { case 0: .ownedRunning; case 1: .confirmedExit; case 3: .lostOwnership; default: .terminationUncertain }
        status=state == .confirmedExit ? result.status : nil
        systemError=result.error;timedOut=result.timed_out != 0;killSent=result.kill_sent != 0
    }
    init(state: State, status: Int32? = nil, systemError: Int32 = 0, timedOut: Bool = false, killSent: Bool = false) {
        self.state=state;self.status=status;self.systemError=systemError;self.timedOut=timedOut;self.killSent=killSent
    }
}
public enum ChildLifecycleFailure: Error { case admissionBlocked, busy, timeout(ChildWaitResult), unconfirmed(ChildWaitResult) }
public struct ChildOwnershipDebt: Equatable, Codable, Sendable {
    public let admissionId: UUID
    public let pid: Int32
    public let result: ChildWaitResult
}

protocol ChildOperations: AnyObject {
    var pid: Int32 { get }
    func resume() -> ChildWaitResult
    func wait(milliseconds: Int32, reapMilliseconds: Int32) -> ChildWaitResult
}
private final class NativeChildOperations: ChildOperations {
    let handle: OpaquePointer
    var pid: Int32 { kb_owned_pid(handle) }
    init(image: FixedFixtureImage, mode: String, input: OwnedFD, output: OwnedFD) throws {
        var child: OpaquePointer?
        guard kb_spawn_owned(image.path,mode,input.value,output.value,&child)==0,let child else { throw BrokerFailure.processFailure }
        handle=child
    }
    func resume() -> ChildWaitResult { ChildWaitResult(kb_resume_owned(handle)) }
    func wait(milliseconds: Int32, reapMilliseconds: Int32) -> ChildWaitResult { ChildWaitResult(kb_wait_owned(handle,milliseconds,reapMilliseconds)) }
    deinit { kb_owned_destroy(handle) } // Memory release only: never signal/wait.
}

/// Fixed capacity counts active owners and unresolved debt. Debt is never
/// evicted or accepted as successful cleanup. No PID-control API is exposed.
final class ChildOwnershipLedger: @unchecked Sendable {
    static let shared=ChildOwnershipLedger(capacity:16)
    private struct Entry { var operations: (any ChildOperations)?;var debt: ChildOwnershipDebt? }
    private let lock=NSLock()
    private let capacity: Int
    private var entries: [UUID:Entry]=[:]
    init(capacity: Int) { self.capacity=capacity }
    func reserve() throws -> UUID {
        lock.lock();defer { lock.unlock() }
        guard entries.count<capacity else { throw ChildLifecycleFailure.admissionBlocked }
        let id=UUID();entries[id]=Entry();return id
    }
    func attach(_ operations: any ChildOperations, id: UUID) {
        lock.lock();defer { lock.unlock() };entries[id]?.operations=operations
    }
    func release(_ id: UUID) { lock.lock();defer { lock.unlock() };entries.removeValue(forKey:id) }
    func retainDebt(_ id: UUID, result: ChildWaitResult) {
        lock.lock();defer { lock.unlock() }
        guard let operations=entries[id]?.operations else { return }
        entries[id]?.debt=ChildOwnershipDebt(admissionId:id,pid:operations.pid,result:result)
    }
    var debts: [ChildOwnershipDebt] { lock.lock();defer { lock.unlock() };return entries.values.compactMap(\.debt).sorted { $0.admissionId.uuidString<$1.admissionId.uuidString } }
    var count: Int { lock.lock();defer { lock.unlock() };return entries.count }
}

/// Fixture-only sole reaper. Construction requires native SIGCHLD default /
/// no-auto-reap policy; callers must not run a competing process-wide reaper.
public final class OwnedChild {
    public let pid: Int32
    private let operations: any ChildOperations
    private let ledger: ChildOwnershipLedger
    private let admissionId: UUID
    private let lock=NSLock()
    private var result=ChildWaitResult(state:.ownedRunning)
    public static var ownershipDebt: [ChildOwnershipDebt] { ChildOwnershipLedger.shared.debts }
    public static var admissionCount: Int { ChildOwnershipLedger.shared.count }
    public var lifecycle: ChildWaitResult { lock.lock();defer { lock.unlock() };return result }
    /// Optional path-swap hook is fixture-only; identity is checked on the
    /// suspended executed image before resuming or sending material.
    public init(image: FixedFixtureImage, mode: String, input: OwnedFD, output: OwnedFD, beforeSpawn: (() throws -> Void)? = nil) throws {
        let ledger=ChildOwnershipLedger.shared
        let admissionId=try ledger.reserve()
        let operations: NativeChildOperations
        do { try image.validatePath();try beforeSpawn?();operations=try NativeChildOperations(image:image,mode:mode,input:input,output:output) }
        catch { ledger.release(admissionId);throw error }
        self.operations=operations;self.ledger=ledger;self.admissionId=admissionId;pid=operations.pid
        ledger.attach(operations,id:admissionId)
        do { try image.validateExecuted(pid) }
        catch { teardown();throw error }
    }
    /// Dependency-injection seam is internal and never reachable by client RPC.
    init(testing operations: any ChildOperations, ledger: ChildOwnershipLedger) throws {
        admissionId=try ledger.reserve();self.ledger=ledger;self.operations=operations;pid=operations.pid
        ledger.attach(operations,id:admissionId)
    }
    private func record(_ value: ChildWaitResult) {
        result=value
        if value.state == .confirmedExit { ledger.release(admissionId) }
        else if value.state != .ownedRunning { ledger.retainDebt(admissionId,result:value) }
    }
    public func resume() throws {
        guard lock.try() else { throw ChildLifecycleFailure.busy };defer { lock.unlock() }
        guard result.state == .ownedRunning else { throw ChildLifecycleFailure.unconfirmed(result) }
        record(operations.resume())
        guard result.state == .ownedRunning else { throw ChildLifecycleFailure.unconfirmed(result) }
    }
    public func waitStatus() throws -> Int32 { try waitStatus(milliseconds:2000,reapMilliseconds:250) }
    func waitStatus(milliseconds: Int32, reapMilliseconds: Int32) throws -> Int32 {
        guard lock.try() else { throw ChildLifecycleFailure.busy };defer { lock.unlock() }
        guard result.state == .ownedRunning else { throw ChildLifecycleFailure.unconfirmed(result) }
        record(operations.wait(milliseconds:milliseconds,reapMilliseconds:reapMilliseconds))
        guard result.state == .confirmedExit,let status=result.status else { throw ChildLifecycleFailure.unconfirmed(result) }
        guard !result.timedOut else { throw ChildLifecycleFailure.timeout(result) }
        return status
    }
    public func wait() throws { guard try waitStatus()==0 else { throw BrokerFailure.processFailure } }
    private func teardown() {
        // No concurrent method can outlive its retaining reference into deinit.
        // A try-lock avoids adding a blocking synchronization path regardless.
        guard lock.try() else {
            ledger.retainDebt(admissionId,result:ChildWaitResult(state:.terminationUncertain,systemError:EBUSY));return
        };defer { lock.unlock() }
        if result.state == .ownedRunning { record(operations.wait(milliseconds:0,reapMilliseconds:250)) }
        // Uncertain/lost ownership is intentionally retained without more signals.
    }
    deinit { teardown() }
}
