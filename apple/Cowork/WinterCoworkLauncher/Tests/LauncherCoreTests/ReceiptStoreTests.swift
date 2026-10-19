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
        return OrderlyStopAuthority.decide(context: StopContext(scope: Fixture.scope, homeId: Fixture.homeId, launcherInstanceId: Fixture.launcherInstanceId, hostBootId: Fixture.bootId, workerPid: 4242, workerStartToken: "1.000001", receiptKey: Fixture.receiptKey),
                                           exit: .code(0), evidence: e, killSent: false, killReason: nil, issuedAtMs: 1_760_000_000_000, confirmationId: id)
    }

    func testPersistLoadRetireRoundTripsTheExactLine() throws {
        let s = try store()
        XCTAssertNil(try s.load(scope, key: Fixture.receiptKey))
        let receipt = orderly()
        try s.persist(receipt, scope: scope)
        XCTAssertEqual(try s.load(scope, key: Fixture.receiptKey), receipt)
        let file = directory.appendingPathComponent("\(Fixture.scope.workspaceId).\(Fixture.scope.incarnationId).3.receipt")
        XCTAssertEqual(try Data(contentsOf: file), Data(try receipt.serialize()), "the file is exactly the canonical receipt line")
        var info = stat(); XCTAssertEqual(stat(file.path, &info), 0)
        XCTAssertEqual(info.st_mode & 0o777, 0o600); XCTAssertEqual(info.st_uid, geteuid())
        try s.retire(scope)
        XCTAssertNil(try s.load(scope, key: Fixture.receiptKey))
        XCTAssertNoThrow(try s.retire(scope), "retiring what is not there is not an error")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [], "no temporary file is left behind")
    }
    func testAReceiptIsWriteOnceButARepeatOfTheSameVerdictIsFine() throws {
        let s = try store()
        try s.persist(orderly("confirm-1"), scope: scope)
        XCTAssertNoThrow(try s.persist(orderly("confirm-1"), scope: scope))
        XCTAssertThrowsError(try s.persist(orderly("confirm-2"), scope: scope)) { XCTAssertEqual($0 as? ReceiptStoreFailure, .alreadyExists) }
        XCTAssertEqual(try s.load(scope, key: Fixture.receiptKey), orderly("confirm-1"), "the first verdict stands")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1, "the refused write left nothing behind")
    }
    func testAFileMovedUnderAnotherScopesNameIsNotThatScopesReceipt() throws {
        let s = try store()
        try s.persist(orderly(), scope: scope)
        let other = ReceiptScope(workspaceId: Fixture.scope.workspaceId, incarnationId: "inc-other", leaseEpoch: 3)
        try FileManager.default.moveItem(at: directory.appendingPathComponent(DirectoryReceiptStore.fileName(scope)), to: directory.appendingPathComponent(DirectoryReceiptStore.fileName(other)))
        XCTAssertThrowsError(try s.load(other, key: Fixture.receiptKey))
    }
    func testLoadRefusesWhatIsNotACanonicalReceipt() throws {
        let s = try store()
        let path = directory.appendingPathComponent(DirectoryReceiptStore.fileName(scope))
        for (label, content) in [("garbage", "not a receipt\n"), ("no newline", String(decoding: try orderly().serialize().dropLast(), as: UTF8.self))] {
            XCTAssertTrue(FileManager.default.createFile(atPath: path.path, contents: Data(content.utf8), attributes: [.posixPermissions: 0o600]), label)
            XCTAssertThrowsError(try s.load(scope, key: Fixture.receiptKey), label)
            try FileManager.default.removeItem(at: path)
        }
        XCTAssertTrue(FileManager.default.createFile(atPath: path.path, contents: Data(try orderly().serialize()), attributes: [.posixPermissions: 0o644]))
        XCTAssertThrowsError(try s.load(scope, key: Fixture.receiptKey), "a receipt file that is not 0600 is not the launcher's")
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
    func testWinterHomesAreRefusedInAnyCaseAndThroughAnySymlinkedAncestorBeforeAnythingIsCreated() throws {
        let base = BuiltProducts.canonical(directory.path)
        for refused in [base + "/.WINTER-x", base + "/.Winter/receipts", base + "/ok/.wInTeR-dev/receipts"] {
            XCTAssertThrowsError(try DirectoryReceiptStore(directory: refused), refused) { XCTAssertEqual($0 as? ReceiptStoreFailure, .unsafeDirectory) }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: base + "/.WINTER-x"), "nothing was created for a refused name")
        // A symlinked ANCESTOR that lands inside a Winter home: the real location is vetted before a directory is made in it.
        let home = base + "/.winter-real"
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createSymbolicLink(atPath: base + "/innocent-link", withDestinationPath: home)
        XCTAssertThrowsError(try DirectoryReceiptStore(directory: base + "/innocent-link/receipts")) { XCTAssertEqual($0 as? ReceiptStoreFailure, .unsafeDirectory) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: home), [], "no directory was created inside the Winter home")
        // The final component as a symlink into a Winter home is refused by O_NOFOLLOW (and, were it followed, by the resolved-path check).
        try FileManager.default.createSymbolicLink(atPath: base + "/last-link", withDestinationPath: home)
        XCTAssertThrowsError(try DirectoryReceiptStore(directory: base + "/last-link"))
        // A symlinked ancestor that lands somewhere harmless is fine (the real location is what is vetted).
        let harmless = base + "/harmless"
        try FileManager.default.createDirectory(atPath: harmless, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createSymbolicLink(atPath: base + "/fine-link", withDestinationPath: harmless)
        XCTAssertNoThrow(try DirectoryReceiptStore(directory: base + "/fine-link/receipts"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: harmless + "/receipts"))
    }
    func testAHardLinkedReceiptFileIsNotTheLaunchersReceipt() throws {
        let s = try store()
        try s.persist(orderly(), scope: scope)
        let file = directory.appendingPathComponent(DirectoryReceiptStore.fileName(scope)).path
        XCTAssertEqual(Darwin.link(file, directory.path + "/second-name"), 0)
        XCTAssertThrowsError(try s.load(scope, key: Fixture.receiptKey), "two names for one receipt: st_nlink is not 1")
        XCTAssertThrowsError(try s.persist(orderly("confirm-2"), scope: scope))
    }
    func testAnUnwritableDirectoryFailsLoudlyNotSilently() throws {
        let s = try store()
        chmod(directory.path, 0o500); defer { chmod(directory.path, 0o700) }
        XCTAssertThrowsError(try s.persist(orderly(), scope: scope))
    }
}
