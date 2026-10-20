import Foundation
import Darwin
import Containerization
import Virtualization

public enum HostManagedShareRole: String, Codable, Sendable {
    case instructions, memory, outputs
    public var guestPath: String { switch self { case .instructions: "/run/winter/shared-instructions"; case .memory: "/workspace/.winter/memory"; case .outputs: "/workspace/outputs" } }
    public var readOnly: Bool { self == .instructions }
}
public struct HostManagedShareRecord: Sendable {
    public let path: String
    public let role: HostManagedShareRole
    public let device: UInt64
    public let inode: UInt64
    public init(path: String, role: HostManagedShareRole, device: UInt64, inode: UInt64) { self.path = path; self.role = role; self.device = device; self.inode = inode }
}

public struct HostProtectedRootRecord: Sendable {
    public let path: String
    public let device: UInt64
    public let inode: UInt64
    public init(path: String, device: UInt64, inode: UInt64) { self.path = path; self.device = device; self.inode = inode }
}

public struct HostSharePolicy: Sendable {
    public let sourcePath: String
    public let guestPath: String
    public let readOnly: Bool
    public let managedRole: HostManagedShareRole?

    public init(sourcePath: String, guestPath: String, readOnly: Bool, managedRole: HostManagedShareRole? = nil) { self.sourcePath = sourcePath; self.guestPath = guestPath; self.readOnly = readOnly; self.managedRole = managedRole }

    public var mount: Containerization.Mount {
        .share(source: sourcePath, destination: guestPath, options: readOnly ? ["ro"] : [])
    }
}

public enum SharePolicy {
    private struct Identity: Hashable { let device: UInt64; let inode: UInt64 }
    /// Identity ancestry catches APFS firmlinks/case aliases that preserve a
    /// different canonical spelling. Only metadata is inspected, never contents.
    private static func ancestors(_ path: String) throws -> [Identity] {
        let fd = open(path, O_EVTONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ProbeFailure(code: "unsafe_share", message: "Cannot open host identity metadata handle") }
        defer { Darwin.close(fd) }
        var pinned = stat()
        var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fstat(fd, &pinned) == 0,
              bytes.withUnsafeMutableBytes({ fcntl(fd, F_GETPATH_NOFIRMLINK, $0.baseAddress!) }) == 0,
              let end = bytes.firstIndex(of: 0), end > 0 else {
            throw ProbeFailure(code: "unsafe_share", message: "Physical host path identity proof is unavailable")
        }
        let physical = String(decoding: bytes[..<end].map { UInt8(bitPattern: $0) }, as: UTF8.self)
        guard physical.hasPrefix("/") else { throw ProbeFailure(code: "unsafe_share", message: "Physical host path must be absolute") }
        let identity = Identity(device: UInt64(bitPattern: Int64(pinned.st_dev)), inode: pinned.st_ino)
        var result: [Identity] = []
        // Firmlinks may cross the lexical root's volume. Walk the NOFIRMLINK
        // backing spelling too, so its volume root is fenced as an ancestor.
        for spelling in path == physical ? [path] : [path, physical] {
            var current = URL(fileURLWithPath: spelling).standardizedFileURL
            var complete = false
            for depth in 0..<1024 {
                var info = stat()
                guard fstatat(AT_FDCWD, current.path, &info, 0) == 0 else {
                    throw ProbeFailure(code: "unsafe_share", message: "Cannot establish complete host path identity ancestry")
                }
                let observed = Identity(device: UInt64(bitPattern: Int64(info.st_dev)), inode: info.st_ino)
                guard depth != 0 || observed == identity else {
                    throw ProbeFailure(code: "unsafe_share", message: "Host path identity changed during ancestry validation")
                }
                result.append(observed)
                if current.path == "/" { complete = true; break }
                current.deleteLastPathComponent()
            }
            guard complete else { throw ProbeFailure(code: "unsafe_share", message: "Host path identity ancestry exceeded its bound") }
        }
        return result
    }
    public static func validate(_ expected: [HostSharePolicy], backing: [URL], protectedHostRoots: [String] = [], managedShares: [HostManagedShareRecord] = [], userHomeRoot: String? = NSHomeDirectory(), protectedRootRecords: [HostProtectedRootRecord] = []) throws {
        let protected = protectedHostRoots + (userHomeRoot.map { [$0] } ?? [])
        let protectedAncestry = try protected.map { try ancestors($0) }
        var privateRootIDs: Set<Identity> = []
        for (index, path) in protectedHostRoots.enumerated() {
            let identity = protectedAncestry[index][0]
            if !protectedRootRecords.isEmpty {
                let records = protectedRootRecords.filter { $0.path == path }
                guard !records.isEmpty, records.allSatisfy({ $0.device == identity.device && $0.inode == identity.inode }) else {
                    throw ProbeFailure(code: "home_identity_mismatch", message: "Protected root identity differs from authenticated host authority")
                }
            }
            privateRootIDs.insert(identity)
        }
        let allProtectedAncestorIDs = Set(protectedAncestry.flatMap { $0 })
        let backingAncestry = try backing.map { try ancestors($0.path) }
        let fixedGuestRoots: Set<String> = ["/workspace/source", "/workspace/host-ro", "/workspace/host-rw", "/opt/cowork-fixture", "/run/winter/shared-instructions", "/workspace/.winter/memory", "/workspace/outputs"]
        var guestPaths: Set<String> = []
        var identities: Set<Identity> = []
        var shareAncestry: [[Identity]] = []
        for policy in expected {
            let url = URL(fileURLWithPath: policy.sourcePath).resolvingSymlinksInPath().standardizedFileURL
            let guest = policy.guestPath
            let sourceGuest = guest.range(of: "^/workspace/sources/[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil
            guard policy.sourcePath != "/", fixedGuestRoots.contains(guest) || sourceGuest, guestPaths.insert(guest).inserted else {
                throw ProbeFailure(code: "unsafe_share", message: "Host root and noncanonical or unapproved guest mount roots are refused")
            }
            var info = stat()
            guard url.path == policy.sourcePath, lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
                throw ProbeFailure(code: "unsafe_share", message: "Share policy requires canonical ordinary directories")
            }
            let identity = Identity(device: UInt64(bitPattern: Int64(info.st_dev)), inode: info.st_ino)
            let ancestry = try ancestors(policy.sourcePath)
            guard ancestry[0] == identity else {
                throw ProbeFailure(code: "unsafe_share", message: "Share identity changed during validation")
            }
            guard !allProtectedAncestorIDs.contains(identity) else {
                throw ProbeFailure(code: "unsafe_share", message: "Host root/home identity or an ancestor cannot be shared through aliases")
            }
            let matchingManaged = policy.managedRole.map { role in
                role.guestPath == policy.guestPath && role.readOnly == policy.readOnly && managedShares.filter {
                    $0.path == policy.sourcePath && $0.role == role && $0.device == identity.device && $0.inode == identity.inode
                }.count == 1
            } ?? false
            guard policy.managedRole == nil || matchingManaged,
                  privateRootIDs.isDisjoint(with: ancestry) || matchingManaged else {
                throw ProbeFailure(code: "managed_share_not_authorized", message: "Protected home children require exact host-owned role/path/identity records")
            }
            guard identities.insert(identity).inserted else {
                throw ProbeFailure(code: "share_alias_refused", message: "Share source identities must be distinct; conflicting read-only aliases are refused")
            }
            guard backingAncestry.allSatisfy({ !$0.contains(identity) }) else {
                throw ProbeFailure(code: "unsafe_share", message: "Share must not contain backing files through any identity alias")
            }
            for previous in shareAncestry {
                guard !previous.contains(identity), !ancestry.contains(previous[0]) else {
                    throw ProbeFailure(code: "share_alias_refused", message: "Share sources must not overlap through any identity alias")
                }
            }
            shareAncestry.append(ancestry)
        }
    }

    /// Check the built VZ graph, not only Mount.options or a guest bind mount.
    /// The pinned backend consolidates all virtiofs mounts into one dictionary
    /// keyed by a source-path hash, so duplicate/conflicting sources can collapse.
    public static func assertBuilt(_ configuration: VZVirtualMachineConfiguration,
                            expected: [HostSharePolicy], mountsByID: [String: [Containerization.Mount]]) throws {
        let mounts = mountsByID.values.flatMap { $0 }.filter { if case .virtiofs = $0.runtimeOptions { return true }; return false }
        guard mounts.count == expected.count,
              configuration.directorySharingDevices.count == 1,
              let device = configuration.directorySharingDevices.first as? VZVirtioFileSystemDeviceConfiguration,
              device.tag == "virtiofs", let share = device.share as? VZMultipleDirectoryShare,
              share.directories.count == expected.count else {
            throw ProbeFailure(code: "share_policy_mismatch", message: "built VZ share graph must exactly match declared fixture sources")
        }
        var actual: [String: Bool] = [:]
        for directory in share.directories.values {
            let canonical = directory.url.resolvingSymlinksInPath().standardizedFileURL.path
            guard actual.updateValue(directory.isReadOnly, forKey: canonical) == nil else {
                throw ProbeFailure(code: "share_policy_mismatch", message: "built VZ graph contains duplicate canonical sources")
            }
        }
        for policy in expected {
            guard actual[policy.sourcePath] == policy.readOnly,
                  mounts.filter({ $0.source == policy.sourcePath && $0.destination == policy.guestPath && $0.options.contains("ro") == policy.readOnly }).count == 1 else {
                throw ProbeFailure(code: "share_policy_mismatch", message: "built VZ source or per-source read-only policy differs from host declaration")
            }
        }
    }
}
