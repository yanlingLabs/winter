import XCTest
@testable import NormaKit

final class ProbeArgsTests: XCTestCase {
    func testAttachWithFlags() throws {
        let r = ProbeArgs.parse(["attach", "s_abc", "--from", "12", "--token", "t0", "--socket", "/tmp/x.sock"])
        guard case .success(let a) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(a.command, "attach")
        XCTAssertEqual(a.positional, ["s_abc"])
        XCTAssertEqual(a.from, 12)
        XCTAssertEqual(a.token, "t0")
        XCTAssertEqual(a.socket, "/tmp/x.sock")
    }

    func testSendJoinsRemainingWords() throws {
        guard case .success(let a) = ProbeArgs.parse(["send", "s_1", "hello", "brave", "world"]) else { return XCTFail() }
        XCTAssertEqual(a.positional, ["s_1", "hello", "brave", "world"])
    }

    func testCreateWithCwd() throws {
        guard case .success(let a) = ProbeArgs.parse(["create", "global", "--cwd", "/tmp/p"]) else { return XCTFail() }
        XCTAssertEqual(a.cwd, "/tmp/p")
    }

    func testUnknownCommandAndMissingArgsFail() {
        guard case .failure = ProbeArgs.parse(["frobnicate"]) else { return XCTFail() }
        guard case .failure = ProbeArgs.parse([]) else { return XCTFail() }
        guard case .failure = ProbeArgs.parse(["attach"]) else { return XCTFail() } // needs sessionId
        guard case .failure = ProbeArgs.parse(["attach", "s_1", "--from", "NaN"]) else { return XCTFail() }
    }

    /// devfix: `--dev` picks the dev Keychain service (`com.norma.core.dev`) for the fallback
    /// `KeychainToken.readHarnessToken` read — default (absent) must stay `false`/dist so every
    /// existing invocation is unaffected.
    func testDevFlagDefaultsFalse() throws {
        guard case .success(let a) = ProbeArgs.parse(["list"]) else { return XCTFail() }
        XCTAssertFalse(a.dev)
    }

    func testDevFlagSetWhenPassed() throws {
        guard case .success(let a) = ProbeArgs.parse(["list", "--dev"]) else { return XCTFail() }
        XCTAssertTrue(a.dev)
    }

    // MARK: - resolvedSocketPath (devfix, socket strand)

    /// devfix: `--dev` switched the Keychain service but NOT the socket in the earlier pass —
    /// `norma-probe --dev list` dialed the DIST socket with a DEV token and hung. `--dev` (absent
    /// `--socket`) must now target the dev home's socket explicitly.
    func testResolvedSocketPathDevDefaultsToDevHomeSocket() throws {
        guard case .success(let a) = ProbeArgs.parse(["list", "--dev"]) else { return XCTFail() }
        XCTAssertEqual(a.resolvedSocketPath(devHome: "/tmp/fake-dev-home"), "/tmp/fake-dev-home/run/core.sock")
    }

    /// Explicit `--socket` always wins, `--dev` or not.
    func testResolvedSocketPathExplicitSocketWinsOverDev() throws {
        guard case .success(let a) = ProbeArgs.parse(["list", "--dev", "--socket", "/tmp/explicit.sock"]) else { return XCTFail() }
        XCTAssertEqual(a.resolvedSocketPath(devHome: "/tmp/fake-dev-home"), "/tmp/explicit.sock")
    }

    /// No `--dev`: falls back to the ambient `NormaPaths.socketPath()` default — unchanged dist
    /// behavior for every invocation that predates `--dev`.
    func testResolvedSocketPathWithoutDevMatchesAmbientDefault() throws {
        guard case .success(let a) = ProbeArgs.parse(["list"]) else { return XCTFail() }
        XCTAssertEqual(a.resolvedSocketPath(), NormaPaths.socketPath())
    }
}
