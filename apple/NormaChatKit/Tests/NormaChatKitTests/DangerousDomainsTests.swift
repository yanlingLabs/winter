import Foundation
import XCTest
@testable import NormaChatKit

final class DangerousDomainsTests: XCTestCase {
    /// The shipped list is a hand-mirrored copy of `packages/core/src/agent/dangerous-domains.ts`;
    /// the fixture is generated FROM that file. Equality (order included) is the drift tripwire.
    func testShippedListEqualsTheGeneratedFixture() throws {
        XCTAssertEqual(DangerousDomains.shipped, try ParityFixtures.dangerousDomains())
    }

    func testExactHostMatches() {
        XCTAssertTrue(DangerousDomains.matches(URL(string: "https://pastebin.com/raw/abc")!))
    }

    func testSubdomainMatches() {
        XCTAssertTrue(DangerousDomains.matches(URL(string: "https://raw.pastebin.com/x")!))
        XCTAssertTrue(DangerousDomains.matches(URL(string: "https://litterbox.catbox.moe/f")!))
    }

    /// Deliberately NOT a substring check: the entry as a PREFIX, and the entry without a label
    /// boundary, must both miss.
    func testLookalikesMiss() {
        XCTAssertFalse(DangerousDomains.matches(URL(string: "https://pastebin.com.evil.com/x")!))
        XCTAssertFalse(DangerousDomains.matches(URL(string: "https://evilpastebin.com/x")!))
        XCTAssertFalse(DangerousDomains.matches(URL(string: "https://notpastebin.com/x")!))
        XCTAssertFalse(DangerousDomains.matches(URL(string: "https://example.com/pastebin.com")!))
    }

    /// HIGH-1 (SP-approvals T10 review): the trailing-dot bypass. `pastebin.com.` is the same
    /// address as `pastebin.com` to DNS.
    func testTrailingDotIsStripped() {
        XCTAssertTrue(DangerousDomains.matches(URL(string: "https://pastebin.com./raw/x")!))
        XCTAssertTrue(DangerousDomains.matches(URL(string: "https://raw.pastebin.com./x")!))
    }

    /// Both sides are folded — the host (which arrives lowercased from `URL` in practice, but the
    /// matcher must be correct standalone) and each entry (a user-typed addition may be mixed-case).
    func testCaseIsFoldedOnBothSides() {
        XCTAssertTrue(DangerousDomains.matches(URL(string: "https://PasteBin.COM/x")!))
        XCTAssertTrue(DangerousDomains.matches(URL(string: "https://drop.example.com/x")!, extra: ["Example.COM"]))
    }

    func testExtraEntriesAreHonoured() {
        let url = URL(string: "https://drop.example.com/x")!
        XCTAssertFalse(DangerousDomains.matches(url))
        XCTAssertTrue(DangerousDomains.matches(url, extra: ["example.com"]))
        XCTAssertTrue(DangerousDomains.matches(url, extra: ["drop.example.com"]))
        XCTAssertFalse(DangerousDomains.matches(url, extra: ["ample.com"]))
    }

    func testHostlessUrlsNeverMatch() {
        XCTAssertFalse(DangerousDomains.matches(URL(string: "file:///etc/passwd")!, extra: ["passwd"]))
        XCTAssertFalse(DangerousDomains.matches(URL(string: "mailto:a@pastebin.com")!))
    }

    /// The matched ENTRY (the broader parent domain for a subdomain hit) is what a refusal names —
    /// same contract as the TS `dangerousDomainMatch` return value.
    func testMatchReturnsTheListEntryNotTheHost() {
        XCTAssertEqual(DangerousDomains.match(host: "raw.pastebin.com", entries: DangerousDomains.shipped), "pastebin.com")
        XCTAssertNil(DangerousDomains.match(host: "example.com", entries: DangerousDomains.shipped))
        XCTAssertNil(DangerousDomains.match(host: "anything", entries: []))
    }
}
