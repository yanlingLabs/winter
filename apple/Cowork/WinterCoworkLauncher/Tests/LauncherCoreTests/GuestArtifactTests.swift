import XCTest
import CryptoKit
@testable import LauncherCore

/// The launcher recomputes `runtimeImageDigest` from `<worker dir>/cowork-guest/{kernel,initramfs.cpio}` (NEW SECURITY LOGIC).
final class GuestArtifactTests: XCTestCase {
    private func fresh(kernel: String = "kernel-bytes", initramfs: String = "initramfs-bytes") throws -> GuestWorkerDirectory {
        try GuestWorkerDirectory(kernel: Array(kernel.utf8), initramfs: Array(initramfs.utf8))
    }
    private func verifier(_ g: GuestWorkerDirectory) -> GuestArtifactVerifier { GuestArtifactVerifier(workerPath: g.workerPath) }
    private func refused(_ g: GuestWorkerDirectory, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try verifier(g).verify(runtimeImageDigest: g.expectedDigest), label, file: file, line: line)
    }

    func testTheDigestIsTheContractsAndComputedFromTheFilesNextToTheWorker() throws {
        let g = try fresh()
        XCTAssertEqual(try verifier(g).computeDigest(), g.expectedDigest, "SHA-256(SHA-256(kernel) || SHA-256(initramfs)), raw digests, kernel first")
        XCTAssertNoThrow(try verifier(g).verify(runtimeImageDigest: g.expectedDigest))
        XCTAssertEqual(GuestArtifactVerifier(workerDirectory: (g.workerPath as NSString).deletingLastPathComponent).workerDirectory, GuestArtifactVerifier(workerPath: g.workerPath).workerDirectory)
    }
    func testAnotherDigestIsRefused() throws {
        let g = try fresh()
        XCTAssertThrowsError(try verifier(g).verify(runtimeImageDigest: String(repeating: "ab", count: 32)))
        XCTAssertThrowsError(try verifier(g).verify(runtimeImageDigest: "not a digest"))
        XCTAssertThrowsError(try verifier(g).verify(runtimeImageDigest: g.expectedDigest.uppercased()), "lowercase hex only")
    }
    func testChangingEitherArtifactChangesTheDigestAndOrderMatters() throws {
        let a = try fresh(kernel: "k1", initramfs: "i1"), b = try fresh(kernel: "k2", initramfs: "i1"), c = try fresh(kernel: "k1", initramfs: "i2"), swapped = try fresh(kernel: "i1", initramfs: "k1")
        let digests = try [a, b, c, swapped].map { try verifier($0).computeDigest() }
        XCTAssertEqual(Set(digests).count, 4)
        XCTAssertThrowsError(try verifier(a).verify(runtimeImageDigest: digests[1]))
    }
    func testAMissingArtifactOrDirectoryIsRefused() throws {
        let g = try fresh(); try FileManager.default.removeItem(atPath: g.guestDirectory + "/kernel"); refused(g, "no kernel")
        let h = try fresh(); try FileManager.default.removeItem(atPath: h.guestDirectory + "/initramfs.cpio"); refused(h, "no initramfs")
        let i = try fresh(); try FileManager.default.removeItem(atPath: i.guestDirectory); refused(i, "no guest directory")
    }
    func testASymlinkIsNeverFollowed() throws {
        let g = try fresh()
        let elsewhere = BuiltProducts.canonical(g.root.path) + "/elsewhere"
        try Data(g.kernelBytes).write(to: URL(fileURLWithPath: elsewhere))   // the SAME bytes: only the symlink is wrong
        try FileManager.default.removeItem(atPath: g.guestDirectory + "/kernel")
        try FileManager.default.createSymbolicLink(atPath: g.guestDirectory + "/kernel", withDestinationPath: elsewhere)
        refused(g, "kernel is a symlink")
        let h = try fresh()
        let realGuest = BuiltProducts.canonical(h.root.path) + "/real-guest"
        try FileManager.default.moveItem(atPath: h.guestDirectory, toPath: realGuest)
        try FileManager.default.createSymbolicLink(atPath: h.guestDirectory, withDestinationPath: realGuest)
        refused(h, "cowork-guest is a symlink")
    }
    func testOnlyPlainSinglyLinkedFilesNotWritableByOthersAreHashed() throws {
        let g = try fresh(); chmod(g.guestDirectory + "/kernel", 0o664); refused(g, "group-writable")
        let h = try fresh(); chmod(h.guestDirectory + "/initramfs.cpio", 0o646); refused(h, "world-writable")
        let i = try fresh(); XCTAssertEqual(Darwin.link(i.guestDirectory + "/kernel", BuiltProducts.canonical(i.root.path) + "/second-name"), 0); refused(i, "two names for the kernel")
        let j = try fresh(); try FileManager.default.removeItem(atPath: j.guestDirectory + "/kernel"); try FileManager.default.createDirectory(atPath: j.guestDirectory + "/kernel", withIntermediateDirectories: false); refused(j, "a directory")
        let k = try fresh(kernel: "", initramfs: "x"); refused(k, "an empty kernel")
    }
    /// A FIFO must be refused WITHOUT waiting for a writer (a plain blocking open would hang `begin` for ever): run the check on a thread and give it seconds.
    func testAFifoAsAnArtifactIsRefusedAtOnceAndNeverHangs() throws {
        for name in ["kernel", "initramfs.cpio"] {
            let g = try fresh()
            try FileManager.default.removeItem(atPath: g.guestDirectory + "/" + name)
            XCTAssertEqual(mkfifo(g.guestDirectory + "/" + name, 0o600), 0)
            let done = DispatchSemaphore(value: 0); var threw = false
            Thread.detachNewThread { threw = (try? GuestArtifactVerifier(workerPath: g.workerPath).computeDigest()) == nil; done.signal() }
            XCTAssertEqual(done.wait(timeout: .now() + 5), .success, "a FIFO as \(name) must not stall the launcher")
            XCTAssertTrue(threw, "a FIFO as \(name) is not a regular file")
        }
    }
    func testAnArtifactLargerThanTheGuestsRamCeilingIsRefusedBeforeItIsRead() throws {
        XCTAssertEqual(GuestArtifactVerifier.maximumArtifactBytes, 1 << 30, "1 GiB: the guest's RAM ceiling")
        let g = try fresh()
        let fd = open(g.guestDirectory + "/kernel", O_WRONLY); defer { close(fd) }
        XCTAssertEqual(ftruncate(fd, off_t(GuestArtifactVerifier.maximumArtifactBytes + 1)), 0)   // sparse: nothing is written
        let started = Date()
        XCTAssertThrowsError(try verifier(g).computeDigest(), "a kernel over the ceiling is not hashed at all (the digest itself, not just its comparison, is refused)")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "refused from fstat, not after hashing a gibibyte")
    }
    func testTheHashIsOfTheDescriptorNotOfAPathThatChangedAfterwards() throws {
        // `sha256(ofFileNamed:in:)` opens relative to an already-open directory descriptor: renaming the directory away afterwards
        // does not change what the descriptor reads.
        let g = try fresh()
        let guestFD = open(g.guestDirectory, O_RDONLY | O_DIRECTORY | O_CLOEXEC); defer { close(guestFD) }
        try FileManager.default.moveItem(atPath: g.guestDirectory, toPath: BuiltProducts.canonical(g.root.path) + "/moved-away")
        let expected = SHA256.hash(data: Data(g.kernelBytes)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(try GuestArtifactVerifier.sha256(ofFileNamed: "kernel", in: guestFD), expected)
    }
    func testALargeFileIsHashedInChunksAndMatches() throws {
        let big = [UInt8](repeating: 0x5a, count: 3 * (1 << 20) + 17)
        let g = try GuestWorkerDirectory(kernel: big, initramfs: [1])
        XCTAssertEqual(try verifier(g).computeDigest(), g.expectedDigest)
    }
}
