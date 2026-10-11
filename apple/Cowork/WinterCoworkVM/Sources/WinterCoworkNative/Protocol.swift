import Foundation

public struct NativeScope: Codable, Equatable, Sendable {
    public let protocolVersion: UInt32
    public let workspaceId: String
    public let incarnationId: String
    public let grantRevision: UInt64
    public let leaseEpoch: UInt64
    public init(protocolVersion: UInt32 = 1, workspaceId: String, incarnationId: String, grantRevision: UInt64, leaseEpoch: UInt64) {
        self.protocolVersion = protocolVersion; self.workspaceId = workspaceId; self.incarnationId = incarnationId
        self.grantRevision = grantRevision; self.leaseEpoch = leaseEpoch
    }
}

public enum NativeOperationKind: String, Codable, Sendable { case capabilities, start, exec, cancel, input, closeInput, stats, balloon, stop, shutdown }
public struct NativeRequest: Decodable, Sendable {
    public let scope: NativeScope
    public let kind: NativeOperationKind
    public let taskId: String?
    public let ownerOperationId: String?
    public let arguments: [String]?
    public let inputBase64: String?
    public let memoryAllowanceBytes: UInt64?
    public let stopBudgetMilliseconds: UInt32?
}

public enum NativeEventKind: String, Codable, Sendable { case accepted, processRegistered, stdout, stderr, terminal }
public enum NativeTerminalStatus: String, Codable, Sendable { case completed, cancelled, failed, uncertain }
public struct NativeEvent: Codable, Sendable {
    public let scope: NativeScope
    public let operationId: String
    public let sequence: UInt64
    public let kind: NativeEventKind
    public let terminalStatus: NativeTerminalStatus?
    public let code: String?
    public let message: String?
    public let dataBase64: String?
    public let exitCode: Int32?
    public let result: [String: String]?
}

public struct NativeFailure: Error, LocalizedError, Sendable {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { message }
}

public struct HostFileIdentity: Codable, Equatable, Sendable {
    public let device: UInt64
    public let inode: UInt64
    public init(device: UInt64, inode: UInt64) { self.device = device; self.inode = inode }
}
public struct HostArtifact: Codable, Sendable {
    public let path: String
    public let sha256: String
    public let identity: HostFileIdentity
}
public struct HostDirectoryGrant: Codable, Sendable {
    public let sourceId: String
    public let path: String
    public let guestPath: String
    public let readOnly: Bool
    public let identity: HostFileIdentity
}
public struct HostLaunchDescriptor: Codable, Sendable {
    public let scope: NativeScope
    public let homeId: String
    public let ownerNonce: String
    public let ownedStorageRoot: String
    public let rootfs: HostArtifact
    public let kernel: HostArtifact
    public let initfs: HostArtifact
    public let shares: [HostDirectoryGrant]
    public let supervisorArguments: [String]
    public let memoryCeilingBytes: UInt64
    public let virtualCPUs: Int
}

/// Authenticated host authority and feasibility admission are separate from a
/// guest wire request. Implementations validate the canonical DB/lease/grants.
public protocol HostLaunchAdmission: Sendable {
    func authorize(_ descriptor: HostLaunchDescriptor) async throws
    func authorizeProcess(_ descriptor: HostLaunchDescriptor, taskId: String, arguments: [String]) async throws
    func retainUncertainOwnership(_ descriptor: HostLaunchDescriptor, reason: String) async
    func confirmStopped(_ descriptor: HostLaunchDescriptor) async throws
}
extension HostLaunchAdmission {
    public func authorizeProcess(_ descriptor: HostLaunchDescriptor, taskId: String, arguments: [String]) async throws {
        throw NativeFailure("trusted_execution_not_admitted", "Host must authorize a trusted runtime/bootstrap process; arbitrary tool exec is not this port")
    }
}

public struct FeatureBlockedAdmission: HostLaunchAdmission {
    public init() {}
    public func authorize(_ descriptor: HostLaunchDescriptor) async throws {
        throw NativeFailure("cowork_gate_blocked", "Cowork native production launch awaits host authority, signing, network, ownership and resource gates")
    }
    public func retainUncertainOwnership(_ descriptor: HostLaunchDescriptor, reason: String) async {}
    public func confirmStopped(_ descriptor: HostLaunchDescriptor) async throws {
        throw NativeFailure("ownership_unverified", "Feature-blocked admission cannot confirm a production disk owner")
    }
}

public struct BackendStopResult: Sendable {
    public let terminationConfirmed: Bool
    public let flushConfirmed: Bool
    public init(terminationConfirmed: Bool, flushConfirmed: Bool) {
        self.terminationConfirmed = terminationConfirmed; self.flushConfirmed = flushConfirmed
    }
}
public protocol NativeGuestProcess: Sendable {
    func run(output: @escaping @Sendable (NativeEventKind, Data) throws -> Void) async throws -> Int32
    func writeInput(_ data: Data) async throws
    func closeInput() async throws
    func cancel() async throws
}
public protocol NativeWorkspaceBackend: Sendable {
    func start() async throws
    func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess
    func stats() async throws -> [String: String]
    func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String]
    func stop() async throws -> BackendStopResult
}
