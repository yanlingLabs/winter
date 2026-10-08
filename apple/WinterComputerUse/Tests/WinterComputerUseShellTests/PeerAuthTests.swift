import Darwin
import Foundation
import WinterComputerUseShell
import XCTest

final class PeerAuthTests: XCTestCase {
    private let token = PeerToken(auditToken: Data(repeating: 7, count: 32), pid: 4242)

    // MARK: The decision, with fakes

    func testAPeerWhoseTokenCannotBeReadIsRejected() {
        let policy = PeerAuthPolicy(readToken: { _ in throw PeerAuthFailure("LOCAL_PEERTOKEN failed") }, checkCode: { _ in })
        XCTAssertEqual(policy.authorize(socket: 3), .reject(reason: "LOCAL_PEERTOKEN failed"))
    }

    func testAPeerWhoseCodeFailsTheRequirementIsRejectedNamingItsPid() {
        let token = self.token
        let policy = PeerAuthPolicy(readToken: { _ in token }, checkCode: { _ in throw PeerAuthFailure("not the daemon") })
        XCTAssertEqual(policy.authorize(socket: 3), .reject(reason: "pid 4242: not the daemon"))
    }

    func testAnyOtherCheckFailureStillRejects() {
        struct Odd: Error {}
        let token = self.token
        let policy = PeerAuthPolicy(readToken: { _ in token }, checkCode: { _ in throw Odd() })
        guard case .reject = policy.authorize(socket: 3) else { return XCTFail("an unexpected error must not accept") }
    }

    func testAPeerThatPassesIsAcceptedWithItsPid() {
        let token = self.token
        let seen = Counter()
        let policy = PeerAuthPolicy(readToken: { fd in XCTAssertEqual(fd, 9); return token }, checkCode: { t in
            XCTAssertEqual(t, token)
            seen.increment()
        })
        XCTAssertEqual(policy.authorize(socket: 9), .accept(pid: 4242))
        XCTAssertEqual(seen.value, 1)
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
        withSocketPair { fd in XCTAssertEqual(auth.authorize(socket: fd), .accept(pid: getpid())) }
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
