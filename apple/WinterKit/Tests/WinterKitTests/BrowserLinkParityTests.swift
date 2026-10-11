import XCTest
@testable import WinterKit

/// ComputerV2 Phase 2 — the browser link's two cross-language pins: the Swift copy of the CDP
/// allowlist equals the daemon's `cdp-allowlist.ts` element for element, and `BrowserLinkProtocol.version`
/// equals the daemon's `BROWSER_LINK_PROTOCOL`. Both read the TypeScript source itself — two hand-kept
/// lists that "match" by a comment are the drift this file exists to catch.
final class BrowserLinkParityTests: XCTestCase {

    /// `apple/WinterKit/Tests/WinterKitTests/<this file>` → the repo root.
    private static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // WinterKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // WinterKit
            .deletingLastPathComponent() // apple
            .deletingLastPathComponent() // repo root
    }

    private static let browserDir = "packages/core/src/computer-use/browser"

    /// The quoted strings of `export const <name>: readonly string[] = [ … ];`, in order.
    private func stringArray(named name: String, in source: String) throws -> [String] {
        guard let start = source.range(of: "export const \(name): readonly string[] = [") else {
            XCTFail("\(name) not found in cdp-allowlist.ts")
            return []
        }
        guard let end = source.range(of: "];", range: start.upperBound..<source.endIndex) else {
            XCTFail("\(name) is not closed in cdp-allowlist.ts")
            return []
        }
        let body = String(source[start.upperBound..<end.lowerBound])
        let regex = try NSRegularExpression(pattern: "\"([^\"]*)\"")
        return regex.matches(in: body, range: NSRange(body.startIndex..., in: body)).compactMap {
            Range($0.range(at: 1), in: body).map { String(body[$0]) }
        }
    }

    func testTheSwiftAllowlistEqualsTheDaemons() throws {
        let url = Self.repoRoot.appendingPathComponent("\(Self.browserDir)/cdp-allowlist.ts")
        let source = try String(contentsOf: url, encoding: .utf8)

        let methods = try stringArray(named: "CDP_ALLOWED_METHODS", in: source)
        let events = try stringArray(named: "CDP_ALLOWED_EVENTS", in: source)
        let networkParams = try stringArray(named: "CDP_NETWORK_EVENT_PARAMS", in: source)
        XCTAssertFalse(methods.isEmpty)
        XCTAssertFalse(events.isEmpty)
        XCTAssertEqual(CDPAllowlist.methods, methods, "the Swift CDP method allowlist drifted from cdp-allowlist.ts")
        XCTAssertEqual(CDPAllowlist.events, events, "the Swift CDP event allowlist drifted from cdp-allowlist.ts")
        XCTAssertEqual(CDPAllowlist.networkEventParams, networkParams)

        let world = try NSRegularExpression(pattern: #"export const CDP_WORLD_NAME = "([^"]*)";"#)
        let match = try XCTUnwrap(world.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)))
        XCTAssertEqual(CDPAllowlist.worldName, String(source[Range(match.range(at: 1), in: source)!]))

        // And the sets the gate checks against are the lists, not a third copy.
        XCTAssertEqual(CDPAllowlist.methodSet, Set(methods))
        XCTAssertEqual(CDPAllowlist.eventSet, Set(events))
    }

    func testTheLinkProtocolNumberEqualsTheDaemons() throws {
        let dir = Self.repoRoot.appendingPathComponent("\(Self.browserDir)/cef-link")
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            throw XCTSkip("the daemon's cef-link/ is not on this branch yet (lane B-engine) — nothing to compare against")
        }
        let pattern = try NSRegularExpression(pattern: #"BROWSER_LINK_PROTOCOL\s*(?::\s*\w+\s*)?=\s*(\d+)"#)
        var found: [Int] = []
        for file in files where file.pathExtension == "ts" {
            let source = try String(contentsOf: file, encoding: .utf8)
            for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                if let range = Range(match.range(at: 1), in: source), let value = Int(source[range]) { found.append(value) }
            }
        }
        guard !found.isEmpty else {
            throw XCTSkip("cef-link/ declares no BROWSER_LINK_PROTOCOL yet")
        }
        XCTAssertEqual(Set(found), [BrowserLinkProtocol.version],
                       "BrowserLinkProtocol.version must equal the daemon's BROWSER_LINK_PROTOCOL")
    }
}
