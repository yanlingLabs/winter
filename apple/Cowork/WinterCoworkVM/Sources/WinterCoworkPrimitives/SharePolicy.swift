import Foundation
import Darwin
import Containerization
import Virtualization

public struct HostSharePolicy: Sendable {
    public let sourcePath: String
    public let guestPath: String
    public let readOnly: Bool

    public init(sourcePath: String, guestPath: String, readOnly: Bool) { self.sourcePath = sourcePath; self.guestPath = guestPath; self.readOnly = readOnly }

    public var mount: Containerization.Mount {
        .share(source: sourcePath, destination: guestPath, options: readOnly ? ["ro"] : [])
    }
}

public enum SharePolicy {
    public static func validate(_ expected: [HostSharePolicy], backing: [URL]) throws {
        var identities: Set<String> = []
        for policy in expected {
            let url = URL(fileURLWithPath: policy.sourcePath).resolvingSymlinksInPath().standardizedFileURL
            var info = stat()
            guard url.path == policy.sourcePath, lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
                throw ProbeFailure(code: "unsafe_share", message: "share policy requires canonical ordinary directories")
            }
            guard identities.insert("\(info.st_dev):\(info.st_ino)").inserted else {
                throw ProbeFailure(code: "share_alias_refused", message: "share source identities must be distinct; conflicting read-only aliases are refused")
            }
            guard backing.allSatisfy({ !$0.path.hasPrefix(url.path + "/") }) else {
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
