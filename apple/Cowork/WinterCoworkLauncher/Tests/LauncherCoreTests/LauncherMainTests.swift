import XCTest
import Foundation
@testable import LauncherCore
import LauncherNative

/// The real `winter-cowork-launcher` binary as a child of the test host, with descriptor 3 as the daemon's socketpair end, exactly as
/// the daemon would start it.
final class LauncherProcess {
    let pid: pid_t
    let daemon: FakeDaemon
    init(arguments: [String], withDescriptor3: Bool = true) throws {
        let (d, l) = try Sock.pair(.stream)
        let child = try Sock.relocate(l, above: 5)
        try Sock.setNonBlocking(d)
        daemon = FakeDaemon(d)
        var actions: posix_spawn_file_actions_t?; posix_spawn_file_actions_init(&actions); defer { posix_spawn_file_actions_destroy(&actions) }
        var attributes: posix_spawnattr_t?; posix_spawnattr_init(&attributes); defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
        if withDescriptor3 { posix_spawn_file_actions_adddup2(&actions, child.raw, 3) }
        let argv = ([BuiltProducts.launcher] + arguments).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var spawned: pid_t = 0
        let rc = posix_spawn(&spawned, BuiltProducts.launcher, &actions, &attributes, argv, [nil])
        guard rc == 0 else { throw DescriptorFailure.errno(rc) }
        pid = spawned
    }
    /// The exit status, waiting at most `timeout`; nil if it is still running (it is then killed).
    func exitCode(timeout: TimeInterval = 10) -> Int32? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var status: Int32 = 0
            let r = waitpid(pid, &status, WNOHANG)
            if r == pid { return status & 0x7f == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f) }
            usleep(10_000)
        }
        kill(pid, SIGKILL); var status: Int32 = 0; waitpid(pid, &status, 0)
        return nil
    }
}

final class LauncherMainTests: XCTestCase {
    private func arguments(receipts: URL, extra: [String] = [], workerPath: String = BuiltProducts.fakeWorker) -> [String] {
        ["--worker-path", workerPath, "--receipt-dir", BuiltProducts.canonical(receipts.path)] + extra
    }
    private var receipts: URL!
    private var guest: GuestWorkerDirectory!
    override func setUpWithError() throws { receipts = makeTemporaryDirectory("main-receipts"); guest = try GuestWorkerDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: receipts); guest = nil }

    // MARK: arguments

    func testArgumentsAreClosed() throws {
        let ok = try LauncherArguments.parse(arguments(receipts: receipts))
        XCTAssertEqual(ok.workerPath, BuiltProducts.fakeWorker)
        for bad in [[], ["--worker-path", "/w"], ["--bogus"], ["--worker-path"],
                    ["--worker-path", "relative", "--receipt-dir", "/r"], ["--worker-path", "/w", "--receipt-dir", "relative"],
                    // The home identity arrives in `begin` and nowhere else; which daemon the launcher serves comes from its own signature.
                    ["--home-id", Fixture.homeId, "--worker-path", "/w", "--receipt-dir", "/r"], ["--profile", "dev", "--worker-path", "/w", "--receipt-dir", "/r"]] {
            XCTAssertThrowsError(try LauncherArguments.parse(bad), "\(bad)")
        }
    }

    #if WINTER_COWORK_TEST_BUILD
    func testTheTestPinExistsOnlyInATestBuild() throws {
        let parsed = try LauncherArguments.parse(arguments(receipts: receipts, extra: ["--WINTER_COWORK_TEST_PARENT_CDHASH", String(repeating: "ab", count: 20)]))
        XCTAssertEqual(parsed.testParentCDHash, String(repeating: "ab", count: 20))
        XCTAssertThrowsError(try LauncherArguments.parse(arguments(receipts: receipts, extra: ["--WINTER_COWORK_TEST_PARENT_CDHASH", "short"])))
    }
    #else
    func testANormalBuildDoesNotKnowTheTestPinAtAll() {
        XCTAssertThrowsError(try LauncherArguments.parse(arguments(receipts: receipts, extra: ["--WINTER_COWORK_TEST_PARENT_CDHASH", String(repeating: "ab", count: 20)])), "an unknown argument, not an ignored one")
        XCTAssertThrowsError(try LauncherArguments.parse(arguments(receipts: receipts, extra: ["--WINTER_COWORK_TEST_WORKER_CDHASH", String(repeating: "ab", count: 20)])))
    }
    #endif

    // MARK: the real binary

    func testUsageErrorsExitWithoutReadingAnything() throws {
        let p = try LauncherProcess(arguments: ["--nonsense"])
        XCTAssertEqual(p.exitCode(), LauncherMain.ExitCode.usage)
    }
    func testWithoutDescriptor3TheLauncherRefusesToRun() throws {
        let p = try LauncherProcess(arguments: arguments(receipts: receipts), withDescriptor3: false)
        XCTAssertEqual(p.exitCode(), LauncherMain.ExitCode.badChannel)
    }
    func testAParentThatIsNotTheWinterDaemonGetsOneRefusalAndNothingElse() throws {
        #if WINTER_COWORK_TEST_BUILD
        // In a test build the production requirement is still what applies when no pin is given.
        #endif
        let p = try LauncherProcess(arguments: arguments(receipts: receipts))
        XCTAssertEqual(p.exitCode(), LauncherMain.ExitCode.parentRefused, "this test host is not signed as the Winter daemon")
        XCTAssertEqual(p.daemon.nextFault(timeout: 2), .parent_unverified)
        XCTAssertFalse(p.daemon.inbox.contains { if case .hello = $0 { true } else { false } }, "`hello` is sent only after the parent is verified")
    }

    #if WINTER_COWORK_TEST_BUILD
    private func pinned(_ parent: String? = nil, worker: String? = nil) throws -> [String] {
        arguments(receipts: receipts, extra: ["--WINTER_COWORK_TEST_PARENT_CDHASH", try parent ?? CodeHash.ofSelf(), "--WINTER_COWORK_TEST_WORKER_CDHASH", try worker ?? CodeHash.ofFile(guest.workerPath)], workerPath: guest.workerPath)
    }
    func testAPinnedParentIsVerifiedAndTheWholeLifecycleRunsInTheRealBinary() throws {
        let p = try LauncherProcess(arguments: try pinned())
        let hello = try XCTUnwrap(p.daemon.next { if case .hello(let instance, let boot) = $0 { (instance, boot) } else { nil } })
        XCTAssertTrue(hello.0.hasPrefix("launcher-")); XCTAssertEqual(hello.1.count, 36, "kern.bootsessionuuid, verbatim")
        let scope = guest.scope(mode: "ok")
        p.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: scope, receiptKey: Fixture.receiptKey))
        let pid = try XCTUnwrap(p.daemon.next { if case .begun(_, _, let pid, _) = $0 { pid } else { nil } })
        let disks = try DiskPair()
        p.daemon.send(.volumes(id: "req-volumes", scopeDigest: try EnvelopeFormat.scopeDigest(scope), volumes: disks.identities), rights: disks.descriptors.map(\.raw))
        XCTAssertNotNil(p.daemon.next { if case .volumesAccepted = $0 { true } else { nil } })
        XCTAssertEqual(disks.dataMarker, "WINTER-FAKE-WORKER")
        p.daemon.send(.stop(id: "req-stop", stopNonce: Fixture.nonce, reason: .user, budgetMs: 10_000))
        let receipt = try XCTUnwrap(p.daemon.next { if case .stopped(_, let r) = $0 { r } else { nil } })
        XCTAssertTrue(receipt.invariantsHold); XCTAssertEqual(receipt.workerPid, pid); XCTAssertEqual(receipt.homeId, Fixture.homeId); XCTAssertEqual(receipt.hostBootId.count, 36)
        XCTAssertEqual(kill(Int32(pid), 0), -1, "reaped by the real launcher binary")
        p.daemon.send(.receiptRetire(confirmationId: receipt.confirmationId))
        XCTAssertEqual(p.exitCode(), 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: receipts.path), [], "retired")
    }
    func testAScopeNamingAnotherRuntimeImageIsRefusedBeforeAnythingIsSpawned() throws {
        let p = try LauncherProcess(arguments: try pinned())
        XCTAssertNotNil(p.daemon.next { if case .hello = $0 { true } else { nil } })
        var scope = guest.scope(mode: "ok"); scope.runtimeImageDigest = String(repeating: "cd", count: 32)
        p.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: scope, receiptKey: Fixture.receiptKey))
        XCTAssertEqual(p.daemon.refusal("req-begin"), .code_identity_mismatch)
        XCTAssertFalse(p.daemon.sees(timeout: 0.3) { if case .begun = $0 { true } else { false } })
        XCTAssertFalse(p.daemon.sees(timeout: 0.1) { if case .uncertain = $0 { true } else { false } }, "no worker was ever made, so there is no verdict")
        p.daemon.send(.begin(id: "req-again", homeId: Fixture.homeId, scope: guest.scope(mode: "ok"), receiptKey: Fixture.receiptKey))
        XCTAssertNotNil(p.daemon.next { if case .begun = $0 { true } else { nil } }, "the right digest still starts: nothing was consumed by the refusal")
        p.daemon.end.close()
        XCTAssertEqual(p.exitCode(), 0)
    }
    func testAPinnedParentWithTheWrongHashIsStillRefused() throws {
        let p = try LauncherProcess(arguments: try pinned(String(repeating: "00", count: 20)))
        XCTAssertEqual(p.exitCode(), LauncherMain.ExitCode.parentRefused)
        XCTAssertEqual(p.daemon.nextFault(timeout: 2), .parent_unverified)
    }
    func testAWorkerThatDoesNotMatchItsPinIsNeverResumed() throws {
        let p = try LauncherProcess(arguments: try pinned(worker: String(repeating: "11", count: 20)))
        XCTAssertNotNil(p.daemon.next { if case .hello = $0 { true } else { nil } })
        p.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: guest.scope(mode: "ok"), receiptKey: Fixture.receiptKey))
        XCTAssertEqual(p.daemon.refusal("req-begin"), .code_identity_mismatch)
        XCTAssertNotNil(p.daemon.next { if case .uncertain = $0 { true } else { nil } })
        p.daemon.end.close()
        XCTAssertEqual(p.exitCode(), 0)
    }
    func testASigtermMakesTheRealBinaryDrainTheWorkerLeaveAReceiptAndExit() throws {
        let p = try LauncherProcess(arguments: try pinned())
        XCTAssertNotNil(p.daemon.next { if case .hello = $0 { true } else { nil } })
        let scope = guest.scope(mode: "ok")
        p.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: scope, receiptKey: Fixture.receiptKey))
        let pid = try XCTUnwrap(p.daemon.next { if case .begun(_, _, let pid, _) = $0 { pid } else { nil } })
        let disks = try DiskPair()
        p.daemon.send(.volumes(id: "req-volumes", scopeDigest: try EnvelopeFormat.scopeDigest(scope), volumes: disks.identities), rights: disks.descriptors.map(\.raw))
        XCTAssertNotNil(p.daemon.next { if case .volumesAccepted = $0 { true } else { nil } })
        kill(p.pid, SIGTERM)
        let receipt = try XCTUnwrap(p.daemon.next { if case .stopped(_, let r) = $0 { r } else { nil } }, "the daemon was still there and is told")
        XCTAssertEqual(receipt.origin, .ownerLossDrain); XCTAssertTrue(receipt.invariantsHold)
        XCTAssertEqual(p.exitCode(), 0)
        XCTAssertEqual(kill(Int32(pid), 0), -1, "the worker did not outlive the launcher")
        let store = try DirectoryReceiptStore(directory: BuiltProducts.canonical(receipts.path))
        XCTAssertNotNil(try store.load(ReceiptScope(scope), key: Fixture.receiptKey))
    }
    func testLosingTheDaemonMakesTheRealBinaryDrainLeaveAReceiptAndExit() throws {
        let p = try LauncherProcess(arguments: try pinned())
        XCTAssertNotNil(p.daemon.next { if case .hello = $0 { true } else { nil } })
        let scope = guest.scope(mode: "ok")
        p.daemon.send(.begin(id: "req-begin", homeId: Fixture.homeId, scope: scope, receiptKey: Fixture.receiptKey))
        XCTAssertNotNil(p.daemon.next { if case .begun = $0 { true } else { nil } })
        let disks = try DiskPair()
        p.daemon.send(.volumes(id: "req-volumes", scopeDigest: try EnvelopeFormat.scopeDigest(scope), volumes: disks.identities), rights: disks.descriptors.map(\.raw))
        XCTAssertNotNil(p.daemon.next { if case .volumesAccepted = $0 { true } else { nil } })
        p.daemon.end.close()
        XCTAssertEqual(p.exitCode(), 0)
        let store = try DirectoryReceiptStore(directory: BuiltProducts.canonical(receipts.path))
        guard case .orderly(let r)? = try store.load(ReceiptScope(scope), key: Fixture.receiptKey) else { return XCTFail("a durable Class A") }
        XCTAssertEqual(r.origin, .ownerLossDrain)
    }
    #endif
}

extension FakeDaemon {
    func refusal(_ id: String, timeout: TimeInterval = 10) -> RefusalCode? {
        next(timeout: timeout) { (line: LineToDaemon) -> RefusalCode? in if case .refused(let i, let code) = line, i == id { return code }; return nil }
    }
}
