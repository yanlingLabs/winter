import Darwin
import XCTest
@testable import WinterKit

/// ComputerV2 Phase 2 — the browser link's handshake against a REAL daemon (`RealDaemon`: the actual
/// bun daemon on a temp home with a file secret store — never `~/.winter*`, never the Keychain).
///
/// Two outcomes are both correct, and which one runs depends on the daemon this branch carries:
///   * a daemon with the link's handlers (lane B-engine merged): the link says hello as a harness,
///     attaches, and holds a `linkId`;
///   * a daemon without them (this lane's branch before the merge, and a Release app on an older
///     daemon in the field): `browserLink.attach` answers -32601, and the link must neither attach
///     nor report a loss — it backs off quietly, saying so once.
/// The CDP itself is not driven here: with no Winter.app CEF in a test process, the built-in browser's
/// real path is the controller's live-gate drill.
@MainActor
final class BrowserLinkRealDaemonTests: XCTestCase {
    func testTheLinkHandshakeAgainstARealDaemon() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }

        let handler = FakeLinkHandler()
        let logs = LogBox()
        var configuration = BrowserLinkClient.Configuration(appVersion: "test", pid: getpid())
        configuration.log = { line in logs.append(line) }
        configuration.sleep = { _ in try? await Task.sleep(nanoseconds: 200_000_000) }
        let link = BrowserLinkClient(configuration: configuration, makeClient: { _ in
            WinterClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.harnessToken,
                         clientName: BrowserLinkProtocol.clientName)
        }, handler: handler)
        link.start()
        defer { link.stop() }

        await eventually("an attach, or the older-daemon answer", timeout: 20) {
            !handler.attached.isEmpty || logs.lines.contains { $0.contains("has no browserLink") }
        }

        if let linkId = handler.attached.first {
            XCTAssertFalse(linkId.isEmpty)
            XCTAssertEqual(link.linkId, linkId)
            XCTAssertEqual(handler.lost, 0)
        } else {
            // The hello itself succeeded (a refused token would never reach the attach), and nothing
            // was attached, lost or logged as a failure — only the one quiet line.
            XCTAssertNil(link.linkId)
            XCTAssertEqual(handler.lost, 0)
            XCTAssertFalse(logs.lines.contains { $0.contains("attach failed") }, "\(logs.lines)")
            XCTAssertEqual(logs.lines.filter { $0.contains("has no browserLink") }.count, 1)
        }
    }
}
