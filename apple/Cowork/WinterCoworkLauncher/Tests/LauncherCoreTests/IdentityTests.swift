import XCTest
import Security
@testable import LauncherCore
import LauncherNative

final class Counter: @unchecked Sendable { private(set) var value = 0; func bump() { value += 1 } }

final class IdentityTests: XCTestCase {
    // MARK: the stated requirements

    func testTheRequirementsAreTheStatedOnesAndAllCompile() throws {
        XCTAssertEqual(LauncherProfile.production.parentRequirementText, "identifier \"com.winter.core\" and anchor apple generic and certificate leaf[subject.OU] = \"37N77U9RSZ\"")
        XCTAssertEqual(LauncherProfile.dev.parentRequirementText, "identifier \"com.winter.core.dev\" and anchor apple generic and certificate leaf[subject.OU] = \"37N77U9RSZ\"")
        XCTAssertEqual(LauncherProfile.production.workerRequirementText, "identifier \"com.winter.cowork.worker\" and anchor apple generic and certificate leaf[subject.OU] = \"37N77U9RSZ\"")
        for text in [LauncherProfile.production.parentRequirementText, LauncherProfile.dev.parentRequirementText, LauncherProfile.production.workerRequirementText] {
            XCTAssertNoThrow(try CodeRequirement(text))
        }
        XCTAssertThrowsError(try CodeRequirement("identifier \"unterminated")) // a requirement that does not compile stops the launcher
    }

    // MARK: the rule, with fakes

    private func policy(pair: Bool = true, token: PeerToken? = PeerToken(auditToken: Data(count: 32), pid: 100), expected: Int32? = 100, codeOK: Bool = true) -> ParentAuthPolicy {
        ParentAuthPolicy(expectedParentPid: expected, isUnnamedPair: { _ in pair },
                         readToken: { _ in if let token { return token } else { throw IdentityFailure("no token") } },
                         checkCode: { _ in if !codeOK { throw IdentityFailure("wrong code") } })
    }
    func testAcceptedOnlyWhenEveryHalfAgrees() {
        XCTAssertEqual(policy().authenticate(socket: 9), .accept(pid: 100))
    }
    func testNoTokenNoParent() {
        guard case .reject = policy(token: nil).authenticate(socket: 9) else { return XCTFail("a missing audit token must refuse") }
    }
    func testACodeThatFailsTheRequirementIsRefused() {
        guard case .reject(let reason) = policy(codeOK: false).authenticate(socket: 9) else { return XCTFail() }
        XCTAssertTrue(reason.contains("wrong code"))
    }
    func testAPeerThatIsNotTheSpawningProcessIsRefusedEvenIfItsCodeIsRight() {
        guard case .reject = policy(token: PeerToken(auditToken: Data(count: 32), pid: 101), expected: 100).authenticate(socket: 9) else { return XCTFail("only the process that spawned the launcher is its parent") }
    }
    func testASocketThatIsNotAnUnnamedPairIsRefusedBeforeAnyTokenIsRead() {
        let read = Counter()
        let p = ParentAuthPolicy(expectedParentPid: nil, isUnnamedPair: { _ in false }, readToken: { _ in read.bump(); return PeerToken(auditToken: Data(count: 32), pid: 1) }, checkCode: { _ in })
        guard case .reject = p.authenticate(socket: 9) else { return XCTFail() }
        XCTAssertEqual(read.value, 0)
    }

    // MARK: the real kernel token and SecCode, against this very test process

    func testRealAuthenticationAcceptsThePeerWhosCdhashIsPinned() throws {
        let (a, _b) = try Sock.pair(.stream)
        let requirement = try CodeRequirement(WinterCodeIdentity.cdhashRequirement(try CodeHash.ofSelf()))
        XCTAssertEqual(CodeSigningParent.authenticator(requirement: requirement, expectedParentPid: getpid()).authenticate(socket: a.raw), .accept(pid: getpid()))
    }
    func testRealAuthenticationRefusesAnotherCodeAnotherPidAndTheProductionRequirement() throws {
        let (a, _b) = try Sock.pair(.stream)
        let wrong = try CodeRequirement(WinterCodeIdentity.cdhashRequirement(String(repeating: "00", count: 20)))
        guard case .reject = CodeSigningParent.authenticator(requirement: wrong, expectedParentPid: getpid()).authenticate(socket: a.raw) else { return XCTFail("a different cdhash") }
        let right = try CodeRequirement(WinterCodeIdentity.cdhashRequirement(try CodeHash.ofSelf()))
        guard case .reject = CodeSigningParent.authenticator(requirement: right, expectedParentPid: getpid() &+ 1).authenticate(socket: a.raw) else { return XCTFail("a different pid") }
        let production = try CodeRequirement(LauncherProfile.production.parentRequirementText)
        guard case .reject = CodeSigningParent.authenticator(requirement: production, expectedParentPid: getpid()).authenticate(socket: a.raw) else { return XCTFail("the test host is not the Winter daemon") }
        let dev = try CodeRequirement(LauncherProfile.dev.parentRequirementText)
        guard case .reject = CodeSigningParent.authenticator(requirement: dev, expectedParentPid: getpid()).authenticate(socket: a.raw) else { return XCTFail() }
    }
    func testRealAuthenticationRefusesADatagramSocketAndANamedOne() throws {
        let (d, _e) = try Sock.pair(.datagram)
        let right = try CodeRequirement(WinterCodeIdentity.cdhashRequirement(try CodeHash.ofSelf()))
        guard case .reject = CodeSigningParent.authenticator(requirement: right, expectedParentPid: getpid()).authenticate(socket: d.raw) else { return XCTFail("L1 is a stream socketpair") }
    }

    // MARK: the worker image

    private func requirementForFakeWorker() throws -> CodeRequirement { try CodeRequirement(WinterCodeIdentity.cdhashRequirement(try CodeHash.ofFile(BuiltProducts.fakeWorker))) }

    func testThePinnedImageIsAcceptedWhenExecutedAndRefusedUnderAnotherRequirement() throws {
        let image = try WorkerImage(path: BuiltProducts.fakeWorker, requirement: try requirementForFakeWorker())
        try image.validatePath()
        let (p2, c2) = try Sock.pair(.datagram), (p3, c3) = try Sock.pair(.stream)
        let child = try NativeWorkerProcess(path: BuiltProducts.fakeWorker, verifier: image, l2Child: try Sock.relocate(c2, above: 5), l3Child: try Sock.relocate(c3, above: 5))
        defer { _ = child.kill() }
        XCTAssertNoThrow(try child.validateExecutedImage(), "the executed, still SUSPENDED image satisfies its requirement")
        let strict = try WorkerImage(path: BuiltProducts.fakeWorker, requirement: try CodeRequirement(WinterCodeIdentity.cdhashRequirement(String(repeating: "11", count: 20))))
        XCTAssertThrowsError(try strict.validateExecuted(pid: child.pid), "an image under the wrong requirement is not accepted")
        _ = (p2, p3)
    }
    func testAPathThatIsNotCanonicalOrIsHardLinkedIsNotPinned() throws {
        let directory = makeTemporaryDirectory("image"); defer { try? FileManager.default.removeItem(at: directory) }
        let copy = BuiltProducts.canonical(directory.appendingPathComponent("w").path)
        try FileManager.default.copyItem(atPath: BuiltProducts.fakeWorker, toPath: copy)
        let requirement = try CodeRequirement(WinterCodeIdentity.cdhashRequirement(try CodeHash.ofFile(copy)))
        let link = directory.appendingPathComponent("link").path
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: copy)
        XCTAssertThrowsError(try WorkerImage(path: BuiltProducts.canonical(directory.path) + "/link", requirement: requirement), "a symlink is not a canonical path")
        XCTAssertThrowsError(try WorkerImage(path: copy + "/../w", requirement: requirement))
        let hard = BuiltProducts.canonical(directory.path) + "/hard"
        XCTAssertEqual(Darwin.link(copy, hard), 0)
        XCTAssertThrowsError(try WorkerImage(path: copy, requirement: requirement), "two names for one file: nlink is not 1")
    }
    func testAnUnsignedOrMissingWorkerCannotBePinned() throws {
        let requirement = try requirementForFakeWorker()
        XCTAssertThrowsError(try WorkerImage(path: "/nonexistent/winter-worker", requirement: requirement))
    }
}
