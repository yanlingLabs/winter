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
    public static func validate(_ expected: [HostSharePolicy], backing: [URL], protectedHostRoots: [String] = [], managedShares: [HostManagedShareRecord] = []) throws {
        let protected = [NSHomeDirectory()] + protectedHostRoots
        func contains(_ parent: String, _ child: String) -> Bool { parent == "/" || child == parent || child.hasPrefix(parent + "/") }
        let fixedGuestRoots: Set<String> = ["/workspace/source", "/workspace/host-ro", "/workspace/host-rw", "/opt/cowork-fixture", "/run/winter/shared-instructions", "/workspace/.winter/memory", "/workspace/outputs"]
        var guestPaths: Set<String> = []
        var identities: Set<String> = []
        for policy in expected {
            let url = URL(fileURLWithPath: policy.sourcePath).resolvingSymlinksInPath().standardizedFileURL
            let guest = policy.guestPath
            let sourceGuest = guest.range(of: "^/workspace/sources/[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil
            guard policy.sourcePath != "/", !protected.contains(where: { contains(policy.sourcePath, $0) }),
                  fixedGuestRoots.contains(guest) || sourceGuest, guestPaths.insert(guest).inserted else {
                throw ProbeFailure(code: "unsafe_share", message: "host root/home ancestors and noncanonical or unapproved guest mount roots are refused")
            }
            var info = stat()
            guard url.path == policy.sourcePath, lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
                throw ProbeFailure(code: "unsafe_share", message: "share policy requires canonical ordinary directories")
            }
            let matchingManaged = policy.managedRole.map { role in
                role.guestPath == policy.guestPath && role.readOnly == policy.readOnly && managedShares.filter {
                    $0.path == policy.sourcePath && $0.role == role && $0.device == UInt64(bitPattern: Int64(info.st_dev)) && $0.inode == info.st_ino
                }.count == 1
            } ?? false
            guard policy.managedRole == nil || matchingManaged,
                  !protectedHostRoots.contains(where: { contains($0, policy.sourcePath) }) || matchingManaged else {
                throw ProbeFailure(code: "managed_share_not_authorized", message: "protected home children require exact host-owned role/path/identity records")
            }
            guard identities.insert("\(info.st_dev):\(info.st_ino)").inserted else {
                throw ProbeFailure(code: "share_alias_refused", message: "share source identities must be distinct; conflicting read-only aliases are refused")
            }
            guard backing.allSatisfy({ !contains(url.path, $0.resolvingSymlinksInPath().standardizedFileURL.path) }) else {
                throw ProbeFailure(code: "unsafe_share", message: "share must not contain backing files")
            }
        }
        for (index, first) in expected.enumerated() {
            for second in expected.dropFirst(index + 1) {
                guard !first.sourcePath.hasPrefix(second.sourcePath + "/"), !second.sourcePath.hasPrefix(first.sourcePath + "/") else {
                    throw ProbeFailure(code: "share_alias_refused", message: "share sources must not overlap")
                }
            }
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
