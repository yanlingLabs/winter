import JavaScriptCore
import XCTest

/// The local-network rule inside the browser (`HeadlessNetworkRule`) answers every row of the fixture the daemon's own
/// copy (`private-network.ts`) answers — one file holds the two equal.
final class HeadlessNetworkRuleTests: XCTestCase {
    private struct Fixture: Decodable { let refused: [String]; let allowed: [String]; let localNameSuffixes: [String] }

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

    func testTheSuffixesAreTheFixturesAndTheResolverBeltMapsEachToNotFound() throws {
        XCTAssertEqual(HeadlessNetworkRule.localNameSuffixes, try fixture().localNameSuffixes)
        let belt = HeadlessNetworkRule.hostResolverRulesSwitch
        XCTAssertTrue(belt.hasPrefix("--host-resolver-rules=MAP *.local ~NOTFOUND,MAP *.local. ~NOTFOUND,"), belt)
        let rules = belt.dropFirst("--host-resolver-rules=".count).split(separator: ",").map(String.init)
        XCTAssertEqual(rules.count, HeadlessNetworkRule.localNameSuffixes.count * 2)
        for suffix in HeadlessNetworkRule.localNameSuffixes {
            XCTAssertTrue(rules.contains("MAP *\(suffix) ~NOTFOUND"), suffix)
            XCTAssertTrue(rules.contains("MAP *\(suffix). ~NOTFOUND"), suffix)
        }
        XCTAssertFalse(belt.contains("localhost"), "this Mac's own names are never mapped")
    }

    /// The PAC belt answers every row of the fixture the way the rule does — evaluated by a real JavaScript engine,
    /// with each host spelled as Chromium hands it to a PAC script (an IPv6 host without its brackets) and as a URL
    /// spells it.
    func testThePACBeltAnswersEveryRowOfTheSharedFixture() throws {
        let f = try fixture()
        let pac = try pacContext()
        func answer(_ host: String) -> String {
            pac.objectForKeyedSubscript("FindProxyForURL").call(withArguments: ["http://\(host)/", host]).toString()
        }
        for (rows, refused) in [(f.refused, true), (f.allowed, false)] {
            for url in rows {
                let host = try XCTUnwrap(HeadlessNetworkRule.schemeAndHost(url)?.1, url)
                let bare = host.hasPrefix("[") ? String(host.dropFirst().dropLast()) : host
                for spelling in Set([host, bare, host.lowercased()]) {
                    XCTAssertEqual(answer(spelling), refused ? HeadlessNetworkRule.deadProxy : "DIRECT", "\(url) as \(spelling)")
                }
            }
        }
        XCTAssertNil(pac.exception, pac.exception?.toString() ?? "")
    }

    func testThePACBeltSendsPublicHostsDirectAndNeverResolvesAName() throws {
        let pac = try pacContext()
        // Every PAC helper that resolves a name, or reads this Mac's addresses, throws if it is ever called.
        for helper in ["dnsResolve", "dnsResolveEx", "isInNet", "isInNetEx", "isResolvable", "isResolvableEx", "myIpAddress",
                       "myIpAddressEx", "dnsDomainIs", "isPlainHostName", "shExpMatch", "localHostOrDomainIs"] {
            pac.evaluateScript("var \(helper) = function () { throw new Error('\(helper) called'); };")
        }
        for host in ["example.com", "www.example.co.uk", "8.8.8.8", "2606:4700:4700::1111", "[2001:db8::1]", "xn--bcher-kva.example",
                     "localhost", "app.localhost", "127.0.0.1", "::1"] {
            let r = pac.objectForKeyedSubscript("FindProxyForURL").call(withArguments: ["https://\(host)/", host]).toString()
            XCTAssertEqual(r, "DIRECT", host)
        }
        for host in ["printer.local", "router", "192.168.0.1", "fe80::1", "fe80::1%en0", "[fd00::1]", "::ffff:10.0.0.1", "not:an:address"] {
            let r = pac.objectForKeyedSubscript("FindProxyForURL").call(withArguments: ["https://\(host)/", host]).toString()
            XCTAssertEqual(r, HeadlessNetworkRule.deadProxy, host)
        }
        XCTAssertNil(pac.exception, pac.exception?.toString() ?? "")
        for helper in ["dnsResolve", "isInNet", "myIpAddress", "isResolvable"] {
            XCTAssertFalse(HeadlessNetworkRule.pacScript.contains(helper), "the script never calls \(helper)")
        }
    }

    func testThePACSwitchCarriesTheScriptInlineAndItsSuffixesAreTheFixtures() throws {
        let sw = HeadlessNetworkRule.proxyPacSwitch
        let prefix = "--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,"
        XCTAssertTrue(sw.hasPrefix(prefix), sw)
        let decoded = try XCTUnwrap(Data(base64Encoded: String(sw.dropFirst(prefix.count))).flatMap { String(data: $0, encoding: .utf8) })
        XCTAssertEqual(decoded, HeadlessNetworkRule.pacScript)
        XCTAssertFalse(sw.contains(" ") || sw.dropFirst(prefix.count).contains(","), "one argument: no space, and no comma past the data URL's own")
        for suffix in try fixture().localNameSuffixes { XCTAssertTrue(decoded.contains("\"\(suffix)\""), suffix) }
        XCTAssertTrue(decoded.contains("var DEAD = \"PROXY 127.0.0.1:4\";"))
    }

    private func pacContext() throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript(HeadlessNetworkRule.pacScript)
        XCTAssertNil(context.exception, context.exception?.toString() ?? "")
        return context
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
