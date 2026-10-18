import Foundation
import CryptoKit

/*
 * NEW SECURITY LOGIC (REVIEW NEEDED): the launcher recomputes `runtimeImageDigest` and refuses a scope that does not match.
 *
 * Contract (docs/cowork-native-worker.md, "The worker process"): `runtimeImageDigest` is the SHA-256 (lowercase hex) of the 64 bytes
 * `SHA-256(kernel) || SHA-256(initramfs.cpio)`, each part the RAW 32 byte digest of that file, over
 * `<directory of the worker executable>/cowork-guest/{kernel,initramfs.cpio}`. The data and environment disks are not covered. The
 * daemon never hashes files; it learns the value from the image-pin port. A launcher that recomputes another value refuses the scope
 * (`code_identity_mismatch`) BEFORE it spawns anything.
 *
 * What this does and does not give. The files are opened with `O_NOFOLLOW` (the `cowork-guest` directory too) and hashed FROM THE
 * DESCRIPTORS, so the bytes hashed are the bytes of the file that was opened, never of a path that changed in between. It does NOT close
 * the window between this hash and the moment libkrun opens the same files BY PATH inside the worker: a same-user process that can
 * replace `kernel` after the launcher has hashed it wins that race. Closing it needs the worker to load from the verified
 * descriptors (for example `/dev/fd/N` paths for descriptors the launcher keeps open and passes down), which is a contract change
 * (the worker's table is exactly 0-4 today). Proposed in docs/research/2026-10-17-cowork-n2-launcher.md; not built here.
 */

public protocol GuestArtifactVerifying: Sendable {
    /// Recomputes the digest of the guest boot artifacts and compares it with the one the daemon stated. Throws on a mismatch AND on
    /// anything unusual about the files (missing, not regular, writable by others, not singly linked, changed while being read).
    func verify(runtimeImageDigest stated: String) throws
}

public enum RuntimeImageDigest {
    /// `SHA-256(rawKernelDigest || rawInitramfsDigest)` as lowercase hex, from the two files' hex digests. Order matters.
    public static func combine(kernelSha256: String, initramfsSha256: String) -> String? {
        guard V.isLowerHex(kernelSha256, count: 64), V.isLowerHex(initramfsSha256, count: 64) else { return nil }
        let raw = EnvelopeFormat.hexBytes(kernelSha256) + EnvelopeFormat.hexBytes(initramfsSha256)
        return EnvelopeFormat.hexOf(ArraySlice(SHA256.hash(data: Data(raw))))
    }
}

public struct GuestArtifactVerifier: GuestArtifactVerifying {
    public static let directoryName = "cowork-guest"
    public static let kernelName = "kernel"
    public static let initramfsName = "initramfs.cpio"
    /// The most one artifact may weigh: 1 GiB, the guest's RAM ceiling (`maxMemoryMiB`, 1024). A kernel or an initramfs the guest could not even load cannot
    /// be a boot artifact, and an unbounded file would stall the launcher's serial queue while it is hashed (the real kernel and cpio are tens of MiB).
    static let maximumArtifactBytes = Int64(WireLimits.maxMemoryMiB) << 20

    /// The directory of the worker executable (the pinned worker's own directory).
    public let workerDirectory: String
    public init(workerDirectory: String) { self.workerDirectory = workerDirectory }
    public init(workerPath: String) { self.workerDirectory = (workerPath as NSString).deletingLastPathComponent }

    public func computeDigest() throws -> String {
        let root = open(workerDirectory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw IdentityFailure("the worker directory cannot be opened") }
        defer { close(root) }
        // The guest directory is a real directory entry of the worker's own: a symlink here would aim the hash somewhere else.
        let guest = openat(root, Self.directoryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard guest >= 0 else { throw IdentityFailure("the guest artifact directory is missing or is a symlink") }
        defer { close(guest) }
        let kernel = try Self.sha256(ofFileNamed: Self.kernelName, in: guest)
        let initramfs = try Self.sha256(ofFileNamed: Self.initramfsName, in: guest)
        guard let combined = RuntimeImageDigest.combine(kernelSha256: kernel, initramfsSha256: initramfs) else { throw IdentityFailure("the artifact digests are not digests") }
        return combined
    }

    public func verify(runtimeImageDigest stated: String) throws {
        guard V.isLowerHex(stated, count: 64) else { throw IdentityFailure("the stated runtime image digest is not a digest") }
        guard try computeDigest() == stated else { throw IdentityFailure("the guest boot artifacts are not the pinned runtime image") }
    }

    /// Hash FROM THE DESCRIPTOR: open (no symlink), check what it is, read it to the end. A file that is not regular, is writable by
    /// anyone but its owner, has another name, or changes size while it is read, is refused.
    static func sha256(ofFileNamed name: String, in directory: Int32) throws -> String {
        // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer for ever and hang `begin`. Whatever it is gets judged
        // by fstat BEFORE anything is read, and the flag is cleared only for a regular file.
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw IdentityFailure("a guest boot artifact is missing or is a symlink") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_mode & (S_IWGRP | S_IWOTH) == 0, info.st_size > 0 else {
            throw IdentityFailure("a guest boot artifact is not a plain, singly-linked, owner-writable-only file")
        }
        guard info.st_size <= maximumArtifactBytes else { throw IdentityFailure("a guest boot artifact is larger than any boot artifact can be") }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 1 << 20)
        var total: Int64 = 0
        while true {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            guard n >= 0 else { throw IdentityFailure("a guest boot artifact cannot be read") }
            if n == 0 { break }
            buffer.withUnsafeBytes { hasher.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0.prefix(n))) }
            total += Int64(n)
        }
        var after = stat()
        guard total == Int64(info.st_size), fstat(fd, &after) == 0, after.st_size == info.st_size, after.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec else {
            throw IdentityFailure("a guest boot artifact changed while it was being hashed")
        }
        return EnvelopeFormat.hexOf(ArraySlice(hasher.finalize()))
    }
}
