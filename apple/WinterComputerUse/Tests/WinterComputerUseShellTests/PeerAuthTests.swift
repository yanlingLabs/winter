import Darwin
import Foundation
import WinterComputerUseShell
import XCTest

final class PeerAuthTests: XCTestCase {
    private let token = PeerToken(auditToken: Data(repeating: 7, count: 32), pid: 4242)

    // MARK: The decision, with fakes

    func testAPeerWhoseTokenCannotBeReadIsRejected() {
        let policy = PeerAuthPolicy(readToken: { _ in throw PeerAuthFailure("LOCAL_PEERTOKEN failed") }, checkCode: { _, _ in })
        XCTAssertEqual(policy.authorize(socket: 3), .reject(reason: "LOCAL_PEERTOKEN failed"))
    }

    func testAPeerThatIsNeitherTheDaemonNorTheAppIsRejectedNamingItsPid() {
        let token = self.token
        let policy = PeerAuthPolicy(readToken: { _ in token }, checkCode: { _, kind in throw PeerAuthFailure("not the \(kind.rawValue)") })
        XCTAssertEqual(policy.authorize(socket: 3), .reject(reason: "pid 4242: daemon: not the daemon; app: not the app"))
    }

    func testAnyOtherCheckFailureStillRejects() {
        struct Odd: Error {}
        let token = self.token
        let policy = PeerAuthPolicy(readToken: { _ in token }, checkCode: { _, _ in throw Odd() })
        guard case .reject = policy.authorize(socket: 3) else { return XCTFail("an unexpected error must not accept") }
    }

    func testAPeerIsAcceptedWithEveryClientKindItsCodeSatisfiesFromOneTokenRead() {
        let token = self.token
        let reads = Counter()
        let only = { (accepted: Set<PeerClientKind>) in
            PeerAuthPolicy(readToken: { fd in XCTAssertEqual(fd, 9); reads.increment(); return token }, checkCode: { t, kind in
                XCTAssertEqual(t, token)
                guard accepted.contains(kind) else { throw PeerAuthFailure("no") }
            })
        }
        XCTAssertEqual(only([.daemon]).authorize(socket: 9), .accept(pid: 4242, clients: [.daemon]))
        XCTAssertEqual(only([.app]).authorize(socket: 9), .accept(pid: 4242, clients: [.app]), "a Winter.app peer (fake identity)")
        XCTAssertEqual(only([.daemon, .app]).authorize(socket: 9), .accept(pid: 4242, clients: [.daemon, .app]))
        XCTAssertEqual(reads.value, 3, "one token read per connection")
    }

    // MARK: The real Security.framework path, on a socketpair (the peer is this test process)

    private func withSocketPair(_ body: (Int32) throws -> Void) rethrows {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        defer { close(fds[0]); close(fds[1]) }
        try body(fds[0])
    }

    func testTheRealCheckReadsTheAuditTokenAndThePid() throws {
        try withSocketPair { fd in
            let token = try CodeSigningPeerAuthenticator.peerToken(socket: fd)
            XCTAssertEqual(token.auditToken.count, 32)
            XCTAssertEqual(token.pid, getpid())
        }
    }

    func testTheRealCheckAcceptsAPeerThatSatisfiesTheRequirement() throws {
        let auth = try CodeSigningPeerAuthenticator(requirement: "always")
        withSocketPair { fd in XCTAssertEqual(auth.authorize(socket: fd), .accept(pid: getpid(), clients: [.daemon])) }
    }

    func testTheRealCheckTellsTheAppFromTheDaemon() throws {
        let appOnly = try CodeSigningPeerAuthenticator(requirements: [.daemon: "never", .app: "always"])
        withSocketPair { fd in XCTAssertEqual(appOnly.authorize(socket: fd), .accept(pid: getpid(), clients: [.app])) }
        let both = try CodeSigningPeerAuthenticator(requirements: [.daemon: "always", .app: "always"])
        withSocketPair { fd in XCTAssertEqual(both.authorize(socket: fd), .accept(pid: getpid(), clients: [.daemon, .app])) }
        let realApp = try CodeSigningPeerAuthenticator(requirements: [.daemon: "never",
            .app: WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.devAppIdentifier)])
        withSocketPair { fd in
            guard case .reject = realApp.authorize(socket: fd) else { return XCTFail("the test runner is not Winter Dev") }
        }
        XCTAssertThrowsError(try CodeSigningPeerAuthenticator(requirements: [.daemon: "always", .app: "nonsense ( ="]))
    }

    func testTheRealCheckRejectsAPeerThatIsNotTheDaemon() throws {
        for requirement in ["never", WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.devDaemonIdentifier),
                            WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.distDaemonIdentifier)] {
            let auth = try CodeSigningPeerAuthenticator(requirement: requirement)
            withSocketPair { fd in
                guard case .reject(let reason) = auth.authorize(socket: fd) else { return XCTFail("\(requirement) accepted the test runner") }
                XCTAssertTrue(reason.contains("pid \(getpid())"), reason)
            }
        }
    }

    func testARequirementThatDoesNotCompileStopsTheHelperFromStarting() {
        XCTAssertThrowsError(try CodeSigningPeerAuthenticator(requirement: "identifier = = nonsense ("))
    }

    func testTheStatedRequirementsAreIdentifierPlusTeamUnderApplesAnchor() {
        XCTAssertEqual(WinterCodeIdentity.requirement(identifier: "com.winter.core.dev"),
                       #"identifier "com.winter.core.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
        XCTAssertEqual(WinterCodeIdentity.distDaemonIdentifier, "winter-core")
    }
}
