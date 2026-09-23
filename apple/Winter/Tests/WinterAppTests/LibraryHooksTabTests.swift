import XCTest
import WinterKit
@testable import Winter

/// Fix round 3 minors — the pure display helpers `LibraryHooksTab.swift` adds: sanitizing a hook's
/// attacker-controllable fields (`hooks.json` is plugin-authored) and never silently dropping an
/// entry the daemon couldn't fully name.
final class LibraryHooksTabTests: XCTestCase {
    // MARK: librarySanitizedHookField

    func testSanitizesC0ControlCharacters() {
        XCTAssertEqual(librarySanitizedHookField("a\u{0007}b\tc\nd"), "a\\u{7}b\\u{9}c\\u{a}d")
    }

    func testSanitizesDelete() {
        XCTAssertEqual(librarySanitizedHookField("a\u{7F}b"), "a\\u{7f}b")
    }

    /// The exact spoofing vector the fix guards against: an RLO can redraw `evil.sh` as something
    /// else entirely when rendered — this pins that the raw override scalar never reaches SwiftUI.
    func testSanitizesBidiOverridesAndIsolates() {
        let rlo = "\u{202E}"
        let lro = "\u{202D}"
        let pdf = "\u{202C}"
        let rle = "\u{202B}"
        let lre = "\u{202A}"
        let isolates = "\u{2066}\u{2067}\u{2068}\u{2069}"
        for scalar in [rlo, lro, pdf, rle, lre] {
            XCTAssertTrue(librarySanitizedHookField("x\(scalar)y").hasPrefix("x\\u{"), "scalar \(scalar.unicodeScalars.first!.value) must be escaped")
        }
        XCTAssertFalse(librarySanitizedHookField(isolates).unicodeScalars.contains { (0x2066...0x2069).contains($0.value) })
    }

    func testLeavesOrdinaryTextUntouched() {
        XCTAssertEqual(librarySanitizedHookField("PreToolUse: Bash (npm test)"), "PreToolUse: Bash (npm test)")
    }

    // MARK: libraryHooksEmptyText — `hooks: []` vs a missing/unreadable key

    func testEmptyArrayReadsAsNoHooksDeclared() {
        XCTAssertEqual(libraryHooksEmptyText([]), "No hooks declared.")
    }

    func testNilReadsAsUnreadable() {
        XCTAssertEqual(libraryHooksEmptyText(nil), "Couldn't read this plugin's hooks.")
    }

    func testNonEmptyReturnsNilSoTheCallerRendersRows() {
        let hook = PluginHookEntry(event: "PreToolUse", matcher: nil, type: "command", command: "true")
        XCTAssertNil(libraryHooksEmptyText([hook]))
    }

    // MARK: libraryHookSummaryLine / libraryHookFullText — missing event/type never drop the entry

    func testMissingEventAndTypeRenderAsUnnamedRatherThanDropped() {
        let hook = PluginHookEntry(event: nil, matcher: nil, type: nil, command: nil)
        XCTAssertEqual(libraryHookSummaryLine(hook), "(unnamed) — (unnamed)")
        XCTAssertEqual(libraryHookFullText(hook), "event: (unnamed)\ntype: (unnamed)")
    }

    func testSummaryPrefersCommandOverType() {
        let hook = PluginHookEntry(event: "PreToolUse", matcher: "Bash", type: "command", command: "npm test")
        XCTAssertEqual(libraryHookSummaryLine(hook), "PreToolUse (Bash): npm test")
    }

    func testFullTextSanitizesEveryField() {
        let hook = PluginHookEntry(event: "e\u{202E}vil", matcher: "m\u{0007}", type: "t", command: "c\u{202E}")
        let full = libraryHookFullText(hook)
        XCTAssertFalse(full.unicodeScalars.contains { $0.value == 0x202E })
        XCTAssertFalse(full.unicodeScalars.contains { $0.value == 0x07 })
        XCTAssertTrue(full.contains("event: e\\u{202e}vil"))
        XCTAssertTrue(full.contains("matcher: m\\u{7}"))
        XCTAssertTrue(full.contains("command: c\\u{202e}"))
    }
}
