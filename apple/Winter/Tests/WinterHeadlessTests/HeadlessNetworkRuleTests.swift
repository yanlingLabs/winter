import XCTest

/// The local-network rule inside the browser (`HeadlessNetworkRule`) answers every row of the fixture the daemon's own
/// copy (`private-network.ts`) answers — one file holds the two equal.
final class HeadlessNetworkRuleTests: XCTestCase {
    private struct Fixture: Decodable { let refused: [String]; let allowed: [String] }

    private func fixture() throws -> Fixture {
        // Tests/WinterHeadlessTests → apple/Winter → apple → the repository.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("packages/core/test/computer-use/fixtures/headless-private-network.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testEveryRowOfTheSharedFixture() throws {
        let f = try fixture()
        XCTAssertGreaterThan(f.refused.count, 20)
        for url in f.refused { XCTAssertTrue(HeadlessNetworkRule.refuses(url), url) }
        for url in f.allowed { XCTAssertFalse(HeadlessNetworkRule.refuses(url), url) }
    }

    func testWebSocketsAreJudgedAndOtherSchemesOpenNothing() {
        XCTAssertTrue(HeadlessNetworkRule.refuses("ws://192.168.1.1/socket"))
        XCTAssertTrue(HeadlessNetworkRule.refuses("wss://printer.local/"))
        XCTAssertFalse(HeadlessNetworkRule.refuses("wss://example.com/"))
        for url in ["about:blank", "data:text/html,hi", "blob:https://example.com/0f0e", "javascript:void(0)"] {
            XCTAssertFalse(HeadlessNetworkRule.refuses(url), url)
        }
    }

    func testTheHostIsReadByHand() {
        XCTAssertEqual(HeadlessNetworkRule.schemeAndHost("HTTP://user:pw@Router.LAN:8080/a?b#c")?.1, "Router.LAN")
        XCTAssertEqual(HeadlessNetworkRule.schemeAndHost("http://[fe80::1]:80/x")?.1, "[fe80::1]")
        XCTAssertEqual(HeadlessNetworkRule.schemeAndHost("https://example.com/a|b")?.1, "example.com")
        XCTAssertTrue(HeadlessNetworkRule.refuses("http://evil.example@10.0.0.1/"), "the host, never the userinfo")
        XCTAssertFalse(HeadlessNetworkRule.refuses("http://10.0.0.1@evil.example/"))
        XCTAssertTrue(HeadlessNetworkRule.refuses("http://[fe80::1/"), "an unclosed IPv6 host is refused")
        XCTAssertTrue(HeadlessNetworkRule.refuses("http:///path"), "a network URL with no host is refused")
        XCTAssertTrue(HeadlessNetworkRule.refuses("no scheme at all"))
    }

    func testIPv6Parsing() {
        XCTAssertEqual(HeadlessNetworkRule.ipv6Bytes("::1"), Array(repeating: 0, count: 15) + [1])
        XCTAssertEqual(HeadlessNetworkRule.ipv6Bytes("1:2:3:4:5:6:7:8"), [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8])
        XCTAssertEqual(HeadlessNetworkRule.ipv6Bytes("::ffff:10.0.0.1").map { Array($0[10...]) }, [0xff, 0xff, 10, 0, 0, 1])
        XCTAssertEqual(HeadlessNetworkRule.ipv6Bytes("fe80::1%en0").map { Array($0[0..<2]) }, [0xfe, 0x80])
        for bad in ["", "1::2::3", "1:2:3:4:5:6:7:8:9", "12345::", "::1.2.3.256", "g::1", "1.2.3.4"] {
            XCTAssertNil(HeadlessNetworkRule.ipv6Bytes(bad), bad)
        }
    }

    func testTheCFunctionCEFCalls() {
        XCTAssertTrue("http://192.168.0.1/".withCString { headlessRequestRefused($0) })
        XCTAssertFalse("https://example.com/".withCString { headlessRequestRefused($0) })
        XCTAssertTrue(headlessRequestRefused(nil))
    }
}
