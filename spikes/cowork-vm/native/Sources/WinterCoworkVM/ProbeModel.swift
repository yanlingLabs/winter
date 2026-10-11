import Foundation
import Darwin

struct ProbeFailure: Error, LocalizedError, Sendable {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

struct Request: Decodable, Sendable {
    let method: String
    let id: String?
    let fixtureRoot: String?
    let kernelPath: String?
    let initfsPath: String?
    let rootfsPath: String?
    let sourcePath: String?
    let payloadPath: String?
    let memoryBytes: UInt64?
    let args: [String]?
    let cwd: String?
    let timeoutSeconds: Int64?
    let targetBytes: UInt64?
    let imageReference: String?
    let archivePath: String?
    let outputPath: String?
}

enum FixturePaths {
    static let markerName = ".winter-cowork-vm-fixture"
    static let markerContents = "winter-cowork-vm-disposable-v1\n"

    static func root(_ path: String?) throws -> URL {
        guard let path, path.hasPrefix("/") else { throw ProbeFailure(code: "fixture_required", message: "absolute fixtureRoot is required") }
        let root = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
        let temp = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL
        guard root.path.hasPrefix(temp.path + "/"), root.lastPathComponent.hasPrefix("winter-cowork-vm-") else {
            throw ProbeFailure(code: "fixture_required", message: "fixtureRoot must be a winter-cowork-vm-* directory under the current user's temporary directory")
        }
        let marker = root.appendingPathComponent(markerName)
        guard marker.resolvingSymlinksInPath().path == marker.path,
              try String(contentsOf: marker, encoding: .utf8) == markerContents else {
            throw ProbeFailure(code: "fixture_required", message: "disposable fixture marker is missing or invalid")
        }
        return root
    }

    static func existing(_ path: String?, within root: URL, directory: Bool = false) throws -> URL {
        guard let path, path.hasPrefix("/") else { throw ProbeFailure(code: "invalid_path", message: "absolute fixture path required") }
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
        var isDirectory: ObjCBool = false
        guard resolved.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory),
              isDirectory.boolValue == directory else {
            throw ProbeFailure(code: "path_outside_fixture", message: "path must name an existing fixture file or directory of the required kind")
        }
        if !directory {
            let attributes = try FileManager.default.attributesOfItem(atPath: resolved.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw ProbeFailure(code: "invalid_path", message: "fixture file must be regular")
            }
        }
        return resolved
    }

    static func output(_ path: String?, within root: URL) throws -> URL {
        guard let path, path.hasPrefix("/") else { throw ProbeFailure(code: "invalid_path", message: "absolute outputPath required") }
        let requested = URL(fileURLWithPath: path).standardizedFileURL
        // Foundation resolves an existing /private/var parent to /var on this
        // Mac, but preserves /private/var for a not-yet-existing leaf. Resolve
        // the existing parent first, then append the unused leaf. Resolving the
        // entire nonexistent output alone cannot canonicalize the comparison.
        let parent = requested.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
        if parent.path != root.path {
            _ = try existing(parent.path, within: root, directory: true)
        }
        let url = parent.appendingPathComponent(requested.lastPathComponent)
        var info = stat()
        guard url.path.hasPrefix(root.path + "/"), lstat(url.path, &info) != 0, errno == ENOENT else {
            throw ProbeFailure(code: "invalid_path", message: "outputPath must be an unused file within the fixture")
        }
        return url
    }

    static func validateBackingFiles(_ files: [URL]) throws {
        var identities: Set<String> = []
        for file in files {
            var info = stat()
            guard lstat(file.path, &info) == 0, info.st_nlink == 1, info.st_mode & S_IFMT == S_IFREG else {
                throw ProbeFailure(code: "backing_alias_refused", message: "each backing file must have exactly one filesystem link")
            }
            guard identities.insert("\(info.st_dev):\(info.st_ino)").inserted else {
                throw ProbeFailure(code: "backing_alias_refused", message: "backing files must have distinct filesystem identities")
            }
        }
    }

    static func validateShares(source: URL, payload: URL, backing: [URL]) throws {
        guard source.path != payload.path,
              !source.path.hasPrefix(payload.path + "/"), !payload.path.hasPrefix(source.path + "/"),
              backing.allSatisfy({ !$0.path.hasPrefix(source.path + "/") && !$0.path.hasPrefix(payload.path + "/") }) else {
            throw ProbeFailure(code: "unsafe_share", message: "source/payload shares must be separate and contain no backing files")
        }
        // A read-only share cannot protect files aliased into the writable
        // source. Fixture payloads must be independent ordinary host copies.
        let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey]
        guard let entries = FileManager.default.enumerator(at: payload, includingPropertiesForKeys: keys) else {
            throw ProbeFailure(code: "invalid_payload", message: "cannot enumerate private fixture payload")
        }
        for case let file as URL in entries {
            let values = try file.resourceValues(forKeys: Set(keys))
            guard values.isSymbolicLink != true else {
                throw ProbeFailure(code: "invalid_payload", message: "fixture payload must not contain symlinks")
            }
            if values.isRegularFile == true {
                try validateBackingFiles([file])
            } else if values.isDirectory != true {
                throw ProbeFailure(code: "invalid_payload", message: "fixture payload may contain only ordinary files/directories")
            }
        }
    }
}

/// A fixture-local inode-keyed sidecar is held until VZ reports stopped. Never
/// flock the image itself: VZ owns its image descriptor and storage locking.
/// This does not prove backing-service death after a crashed controller.
final class DiskLease: @unchecked Sendable {
    private let fd: Int32
    init(path: String, fixtureRoot: URL) throws {
        let imageFD = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard imageFD >= 0 else { throw ProbeFailure(code: "disk_open_failed", message: "cannot open fixture disk") }
        var imageInfo = stat()
        let inspected = fstat(imageFD, &imageInfo)
        Darwin.close(imageFD)
        guard inspected == 0, imageInfo.st_mode & S_IFMT == S_IFREG else {
            throw ProbeFailure(code: "disk_open_failed", message: "cannot inspect fixture disk")
        }
        let leaseDirectory = fixtureRoot.appendingPathComponent(".disk-leases")
        if mkdir(leaseDirectory.path, 0o700) != 0, errno != EEXIST {
            throw ProbeFailure(code: "disk_lease_failed", message: "cannot create fixture lease directory")
        }
        var directoryInfo = stat()
        guard lstat(leaseDirectory.path, &directoryInfo) == 0,
              directoryInfo.st_mode & S_IFMT == S_IFDIR, directoryInfo.st_uid == getuid(),
              directoryInfo.st_mode & 0o077 == 0 else {
            throw ProbeFailure(code: "disk_lease_failed", message: "fixture lease directory must be a private owned nonsymlink directory")
        }
        let leasePath = leaseDirectory.appendingPathComponent("\(imageInfo.st_dev)-\(imageInfo.st_ino).lock")
        fd = Darwin.open(leasePath.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ProbeFailure(code: "disk_lease_failed", message: "cannot open fixture disk sidecar") }
        var leaseInfo = stat()
        guard fstat(fd, &leaseInfo) == 0, leaseInfo.st_mode & S_IFMT == S_IFREG,
              leaseInfo.st_nlink == 1, leaseInfo.st_uid == getuid(), leaseInfo.st_mode & 0o077 == 0 else {
            Darwin.close(fd)
            throw ProbeFailure(code: "disk_lease_failed", message: "fixture lease sidecar must be a private owned ordinary file")
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd)
            throw ProbeFailure(code: "disk_owned", message: "fixture disk already has a writable owner")
        }
    }
    // Leave sidecars in place: unlinking a held/recent lock could let another
    // process lock a replacement inode while an old owner retains its fd.
    deinit { flock(fd, LOCK_UN); Darwin.close(fd) }
}

/// Reservations include both in-flight and unconsumed terminal events, so a
/// slow consumer cannot silently lose completion/error events.
final class EventQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var nextID: UInt64 = 1
    private var outstanding = 0
    private var events: [String] = []
    let limit: Int
    init(limit: Int = 128) { self.limit = limit }
    func reserve() -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        guard outstanding < limit, nextID < UInt64.max else { return nil }
        let id = nextID; nextID += 1; outstanding += 1
        return id
    }
    func finish(_ event: String) {
        lock.lock(); defer { lock.unlock() }
        events.append(event)
    }
    func poll() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard !events.isEmpty else { return nil }
        outstanding -= 1
        return events.removeFirst()
    }
}
