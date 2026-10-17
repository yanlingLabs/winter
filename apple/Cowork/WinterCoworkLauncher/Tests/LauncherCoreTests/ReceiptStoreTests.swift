import XCTest
@testable import LauncherCore

final class ReceiptStoreTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws { directory = makeTemporaryDirectory("receipts") }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }

    private func store() throws -> DirectoryReceiptStore { try DirectoryReceiptStore(directory: BuiltProducts.canonical(directory.path), randomness: FixedRandom()) }
    private let scope = ReceiptScope(Fixture.scope)
    private func orderly(_ id: String = "confirm-1") -> StopReceipt {
        var e = WorkerEvidence(); e.drain = DrainRecord(nonce: Fixture.nonce, origin: .hostStop)
        return OrderlyStopAuthority.decide(context: StopContext(scope: Fixture.scope, homeId: Fixture.homeId, launcherInstanceId: Fixture.launcherInstanceId, hostBootId: Fixture.bootId, workerPid: 4242, workerStartToken: "1.000001"),
                                           exit: .code(0), evidence: e, killSent: false, killReason: nil, issuedAtMs: 1_760_000_000_000, confirmationId: id)
    }

    func testPersistLoadRetireRoundTripsTheExactLine() throws {
        let s = try store()
        XCTAssertNil(try s.load(scope))
        let receipt = orderly()
        try s.persist(receipt, scope: scope)
        XCTAssertEqual(try s.load(scope), receipt)
        let file = directory.appendingPathComponent("\(Fixture.scope.workspaceId).\(Fixture.scope.incarnationId).3.receipt")
        XCTAssertEqual(try Data(contentsOf: file), Data(try receipt.serialize()), "the file is exactly the canonical receipt line")
        var info = stat(); XCTAssertEqual(stat(file.path, &info), 0)
        XCTAssertEqual(info.st_mode & 0o777, 0o600); XCTAssertEqual(info.st_uid, geteuid())
        try s.retire(scope)
        XCTAssertNil(try s.load(scope))
        XCTAssertNoThrow(try s.retire(scope), "retiring what is not there is not an error")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [], "no temporary file is left behind")
    }
    func testAReceiptIsWriteOnceButARepeatOfTheSameVerdictIsFine() throws {
        let s = try store()
        try s.persist(orderly("confirm-1"), scope: scope)
        XCTAssertNoThrow(try s.persist(orderly("confirm-1"), scope: scope))
        XCTAssertThrowsError(try s.persist(orderly("confirm-2"), scope: scope)) { XCTAssertEqual($0 as? ReceiptStoreFailure, .alreadyExists) }
        XCTAssertEqual(try s.load(scope), orderly("confirm-1"), "the first verdict stands")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1, "the refused write left nothing behind")
    }
    func testAFileMovedUnderAnotherScopesNameIsNotThatScopesReceipt() throws {
        let s = try store()
        try s.persist(orderly(), scope: scope)
        let other = ReceiptScope(workspaceId: Fixture.scope.workspaceId, incarnationId: "inc-other", leaseEpoch: 3)
        try FileManager.default.moveItem(at: directory.appendingPathComponent(DirectoryReceiptStore.fileName(scope)), to: directory.appendingPathComponent(DirectoryReceiptStore.fileName(other)))
        XCTAssertThrowsError(try s.load(other))
    }
    func testLoadRefusesWhatIsNotACanonicalReceipt() throws {
        let s = try store()
        let path = directory.appendingPathComponent(DirectoryReceiptStore.fileName(scope))
        for (label, content) in [("garbage", "not a receipt\n"), ("no newline", String(decoding: try orderly().serialize().dropLast(), as: UTF8.self))] {
            XCTAssertTrue(FileManager.default.createFile(atPath: path.path, contents: Data(content.utf8), attributes: [.posixPermissions: 0o600]), label)
            XCTAssertThrowsError(try s.load(scope), label)
            try FileManager.default.removeItem(at: path)
        }
        XCTAssertTrue(FileManager.default.createFile(atPath: path.path, contents: Data(try orderly().serialize()), attributes: [.posixPermissions: 0o644]))
        XCTAssertThrowsError(try s.load(scope), "a receipt file that is not 0600 is not the launcher's")
    }
    func testTheDirectoryMustBeAPrivateRealDirectoryOutsideAnyWinterHome() throws {
        let loose = makeTemporaryDirectory("loose"); defer { try? FileManager.default.removeItem(at: loose) }
        chmod(loose.path, 0o755)
        XCTAssertThrowsError(try DirectoryReceiptStore(directory: BuiltProducts.canonical(loose.path)), "a group- or world-readable directory") { XCTAssertEqual($0 as? ReceiptStoreFailure, .unsafeDirectory) }
        let target = makeTemporaryDirectory("target"); defer { try? FileManager.default.removeItem(at: target) }
        let link = target.appendingPathExtension("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target); defer { try? FileManager.default.removeItem(at: link) }
        XCTAssertThrowsError(try DirectoryReceiptStore(directory: link.path), "a symlink is not a directory")
        for refused in ["relative/path", "/tmp/../etc", "/var/example/.winter/cowork", "/var/example/.winter-dev/x", "/tmp/.winter/receipts", "/tmp/a\0b"] {
            XCTAssertThrowsError(try DirectoryReceiptStore(directory: refused), refused) { XCTAssertEqual($0 as? ReceiptStoreFailure, .unsafeDirectory) }
        }
    }
    func testAnUnwritableDirectoryFailsLoudlyNotSilently() throws {
        let s = try store()
        chmod(directory.path, 0o500); defer { chmod(directory.path, 0o700) }
        XCTAssertThrowsError(try s.persist(orderly(), scope: scope))
    }
}
