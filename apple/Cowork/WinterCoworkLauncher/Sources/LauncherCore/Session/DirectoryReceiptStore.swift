import Foundation
import LauncherNative

/*
 * A file-backed `DurableReceiptStore`: one file per scope, exactly the receipt line, WRITE-ONCE.
 *
 *   <directory>/<workspaceId>.<incarnationId>.<leaseEpoch>.receipt        (0600, owned by the running user)
 *
 * Durability order for `persist`: write a private temporary file, F_FULLFSYNC it, rename it into place WITHOUT replacing anything
 * (`renamex_np(RENAME_EXCL)`), then F_FULLFSYNC the directory. Only then does `persist` return, and only then may the session send.
 * The directory must be a real directory, not a symlink, owned by the running user, mode 0700 (it is created with those bits if its parent
 * exists). Nothing here is under a Winter home: a path with any `.winter*` component, in ANY case, is refused outright, and so is a path
 * whose REAL location (every symlink on the way followed, `F_GETPATH`) has one, before anything is created. The receipts must survive a
 * wipe of that home, and tests must never be able to reach it.
 *
 * WHAT THIS IS NOT: authentication. The file is plain text a same-user process could also write. The daemon slice that reads it back
 * (`CoworkNativeDurableReceiptPort.load`) must attest it by other means; see the research note for the proposal.
 */
public final class DirectoryReceiptStore: DurableReceiptStore {
    public let directory: String
    private let dirFD: OwnedFD
    private let randomness: Randomness

    /// A component names a Winter home (`.winter`, `.winter-dev`, …) in ANY case: the volumes are case-insensitive by default, so
    /// `.WINTER-x` is the same directory as `.winter-x`.
    static func isWinterHomeComponent(_ component: String) -> Bool { component.lowercased().hasPrefix(".winter") }

    /// Every component of the REAL location of an open directory (`F_GETPATH`, which follows every symlink on the way) is vetted.
    private static func resolvedLocationIsSafe(_ fd: Int32) -> Bool {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
        guard fcntl(fd, F_GETPATH, &buffer) == 0 else { return false }
        let resolved = String(decoding: buffer.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return resolved.hasPrefix("/") && !resolved.split(separator: "/").contains(where: { isWinterHomeComponent(String($0)) })
    }

    public init(directory: String, randomness: Randomness = SystemRandomness()) throws {
        guard directory.hasPrefix("/"), !directory.contains("\0") else { throw ReceiptStoreFailure.unsafeDirectory }
        let components = directory.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        // 1. The name as given, case-insensitively.
        guard let last = components.last, !components.contains("."), !components.contains(".."), !components.contains(where: Self.isWinterHomeComponent) else { throw ReceiptStoreFailure.unsafeDirectory }
        // 2. Where the PARENT really is. It is opened FOLLOWING symlinks so its real path can be read back and vetted BEFORE anything is
        //    created in it: an ancestor that is a symlink into a Winter home must never get a directory made inside it.
        let parentPath = "/" + components.dropLast().joined(separator: "/")
        let parentFD = open(parentPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard parentFD >= 0 else { throw ReceiptStoreFailure.ioFailed(errno) }
        defer { Darwin.close(parentFD) }
        guard Self.resolvedLocationIsSafe(parentFD) else { throw ReceiptStoreFailure.unsafeDirectory }
        // 3. The directory itself: created private if missing, opened WITHOUT following a symlink, and its real location vetted again.
        if mkdirat(parentFD, last, 0o700) != 0 && errno != EEXIST { throw ReceiptStoreFailure.ioFailed(errno) }
        let fd = openat(parentFD, last, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ReceiptStoreFailure.ioFailed(errno) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700, Self.resolvedLocationIsSafe(fd) else { Darwin.close(fd); throw ReceiptStoreFailure.unsafeDirectory }
        self.directory = directory; self.dirFD = OwnedFD(fd); self.randomness = randomness
    }

    static func fileName(_ scope: ReceiptScope) -> String { "\(scope.workspaceId).\(scope.incarnationId).\(scope.leaseEpoch).receipt" }

    private func fullSync(_ fd: Int32) throws {
        if fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0 { throw ReceiptStoreFailure.ioFailed(errno) }
    }

    public func persist(_ receipt: StopReceipt, scope: ReceiptScope) throws {
        let bytes = try receipt.serialize()
        let name = Self.fileName(scope)
        let temporary = ".tmp-" + randomness.bytes(8).map { String(format: "%02x", $0) }.joined()
        let fd = openat(dirFD.raw, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ReceiptStoreFailure.ioFailed(errno) }
        var wrote = false
        defer { if !wrote { unlinkat(dirFD.raw, temporary, 0) } }
        var offset = 0
        while offset < bytes.count {
            let n = bytes[offset...].withUnsafeBytes { write(fd, $0.baseAddress, bytes.count - offset) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { let e = errno; Darwin.close(fd); throw ReceiptStoreFailure.ioFailed(e) }
            offset += n
        }
        do { try fullSync(fd) } catch { Darwin.close(fd); throw error }
        Darwin.close(fd)
        if renameatx_np(dirFD.raw, temporary, dirFD.raw, name, UInt32(RENAME_EXCL)) != 0 {
            let e = errno
            if e == EEXIST {
                // Write-once: the same bytes are a repeat of the same verdict; anything else is a different one and is refused.
                guard let existing = try? readExisting(name), existing == bytes else { throw ReceiptStoreFailure.alreadyExists }
                return
            }
            throw ReceiptStoreFailure.ioFailed(e)
        }
        wrote = true
        try fullSync(dirFD.raw)
    }

    private func readExisting(_ name: String) throws -> [UInt8] {
        let fd = openat(dirFD.raw, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ReceiptStoreFailure.ioFailed(errno) }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_mode & 0o777 == 0o600, info.st_nlink == 1,
              info.st_size > 0, info.st_size <= WireLimits.receiptBytes else { throw ReceiptStoreFailure.unsafeDirectory }
        var buffer = [UInt8](repeating: 0, count: Int(info.st_size)), offset = 0
        while offset < buffer.count {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress! + offset, $0.count - offset) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw ReceiptStoreFailure.ioFailed(errno) }
            offset += n
        }
        return buffer
    }

    public func load(_ scope: ReceiptScope) throws -> StopReceipt? {
        let bytes: [UInt8]
        do { bytes = try readExisting(Self.fileName(scope)) } catch ReceiptStoreFailure.ioFailed(let e) where e == ENOENT { return nil }
        let receipt = try StopReceipt.parse(bytes)
        // The name and the content must say the same thing; a file moved or copied under another name is not this scope's.
        let named: ReceiptScope
        switch receipt {
        case .orderly(let r): named = ReceiptScope(workspaceId: r.workspaceId, incarnationId: r.incarnationId, leaseEpoch: r.leaseEpoch)
        case .uncertain(let r): named = ReceiptScope(workspaceId: r.workspaceId, incarnationId: r.incarnationId, leaseEpoch: r.leaseEpoch)
        }
        guard named == scope else { throw ReceiptStoreFailure.unsafeDirectory }
        return receipt
    }

    public func retire(_ scope: ReceiptScope) throws {
        if unlinkat(dirFD.raw, Self.fileName(scope), 0) != 0 && errno != ENOENT { throw ReceiptStoreFailure.ioFailed(errno) }
        try fullSync(dirFD.raw)
    }
}

public struct SystemRandomness: Randomness {
    public init() {}
    public func bytes(_ count: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: count)
        _ = lc_random(&out, count)
        return out
    }
}
public struct SystemClock: WallClock {
    public init() {}
    public var nowMs: UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }
}
