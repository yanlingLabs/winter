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

    /// Fix round 4 (controller-required): NEL (U+0085, a C1 control) forces a line break exactly
    /// like LF — left unescaped, it would hide the tail of a `.lineLimit(1)`-truncated command.
    func testSanitizesNEL() {
        XCTAssertEqual(librarySanitizedHookField("a\u{0085}b"), "a\\u{85}b")
    }

    /// Fix round 4 (controller-required): Unicode LINE SEPARATOR (U+2028) — the same line-break
    /// risk as NEL, but outside the C0/C1 control blocks entirely, so it needs its own case.
    func testSanitizesLineSeparator() {
        XCTAssertEqual(librarySanitizedHookField("a\u{2028}b"), "a\\u{2028}b")
    }

    /// Fix round 4: PARAGRAPH SEPARATOR (U+2029), the LS's sibling.
    func testSanitizesParagraphSeparator() {
        XCTAssertEqual(librarySanitizedHookField("a\u{2029}b"), "a\\u{2029}b")
    }

    /// Fix round 4: the zero-width characters (space/non-joiner/joiner, word joiner, BOM-as-ZWNBSP)
    /// can split a command into two look-alike halves or hide entirely inside an innocuous string.
    func testSanitizesZeroWidthCharacters() {
        let zeroWidths = "\u{200B}\u{200C}\u{200D}\u{2060}\u{FEFF}"
        let sanitized = librarySanitizedHookField("a\(zeroWidths)b")
        XCTAssertFalse(sanitized.unicodeScalars.contains { $0.value == 0x200B || $0.value == 0x200C
            || $0.value == 0x200D || $0.value == 0x2060 || $0.value == 0xFEFF })
        XCTAssertTrue(sanitized.hasPrefix("a\\u{"))
        XCTAssertTrue(sanitized.hasSuffix("b"))
    }

    /// Fix round 4: the invisible directional marks (LRM, RLM, ALM) — one step short of the
    /// override/isolate family already covered, but still an invisible spoofing primitive.
    func testSanitizesBidiMarks() {
        let marks = "\u{200E}\u{200F}\u{061C}"
        let sanitized = librarySanitizedHookField("a\(marks)b")
        XCTAssertFalse(sanitized.unicodeScalars.contains { $0.value == 0x200E || $0.value == 0x200F || $0.value == 0x061C })
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
