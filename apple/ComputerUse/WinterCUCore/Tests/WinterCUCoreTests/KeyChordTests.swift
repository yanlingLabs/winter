import Carbon.HIToolbox
import XCTest
@testable import WinterCUCore

/// `key()` combos: Winter's `cmd+s` style and xdotool's spellings.
final class KeyChordTests: XCTestCase {
    private func parse(_ s: String) throws -> CUKeyChord { try CUKeyChord.parse(s) }

    func testCommonChords() throws {
        XCTAssertEqual(try parse("cmd+s"), CUKeyChord(key: .character("s"), modifiers: [.command]))
        XCTAssertEqual(try parse("return"), CUKeyChord(key: .named(.returnKey)))
        XCTAssertEqual(try parse("shift+tab"), CUKeyChord(key: .named(.tab), modifiers: [.shift]))
        XCTAssertEqual(try parse("cmd+shift+z"), CUKeyChord(key: .character("z"), modifiers: [.command, .shift]))
        XCTAssertEqual(try parse("escape"), CUKeyChord(key: .named(.escape)))
        XCTAssertTrue(try parse("Esc").isEscape)
    }

    func testXdotoolSpellings() throws {
        XCTAssertEqual(try parse("ctrl+alt+Delete"), CUKeyChord(key: .named(.delete), modifiers: [.control, .option]))
        XCTAssertEqual(try parse("super+l"), CUKeyChord(key: .character("l"), modifiers: [.command]))
        XCTAssertEqual(try parse("Page_Up"), CUKeyChord(key: .named(.pageUp)))
        XCTAssertEqual(try parse("Next"), CUKeyChord(key: .named(.pageDown)))
        XCTAssertEqual(try parse("BackSpace"), CUKeyChord(key: .named(.delete)))
        XCTAssertEqual(try parse("KP_Enter"), CUKeyChord(key: .named(.keypadEnter)))
        XCTAssertEqual(try parse("F12"), CUKeyChord(key: .named(.f12)))
    }

    func testShiftedCharactersAndPlus() throws {
        XCTAssertEqual(try parse("cmd+S"), CUKeyChord(key: .character("s"), modifiers: [.command, .shift]))
        XCTAssertEqual(try parse("cmd+?"), CUKeyChord(key: .character("/"), modifiers: [.command, .shift]))
        XCTAssertEqual(try parse("cmd++"), CUKeyChord(key: .character("="), modifiers: [.command, .shift]))
        XCTAssertEqual(try parse("cmd+plus"), CUKeyChord(key: .character("="), modifiers: [.command, .shift]))
        XCTAssertEqual(try parse("cmd+minus"), CUKeyChord(key: .character("-"), modifiers: [.command]))
        XCTAssertEqual(try parse("cmd+-"), CUKeyChord(key: .character("-"), modifiers: [.command]))
    }

    func testFnDeleteIsForwardDelete() throws {
        XCTAssertEqual(try parse("fn+delete"), CUKeyChord(key: .named(.forwardDelete)))
        XCTAssertEqual(try parse("del"), CUKeyChord(key: .named(.forwardDelete)))
    }

    func testLoneModifierIsItsOwnKey() throws {
        XCTAssertEqual(try parse("shift"), CUKeyChord(key: .named(.shiftKey)))
        XCTAssertEqual(try parse("cmd"), CUKeyChord(key: .named(.commandKey)))
    }

    func testErrors() {
        XCTAssertThrowsError(try parse("")) { XCTAssertEqual(($0 as? CUError)?.code, "invalid_params") }
        XCTAssertThrowsError(try parse("hyper+s"))
        XCTAssertThrowsError(try parse("cmd+frobnicate"))
        XCTAssertThrowsError(try parse("cmd++s"))
    }

    func testModifierFlags() throws {
        let f = try parse("cmd+ctrl+alt+shift+fn+a").modifiers.cgFlags
        XCTAssertTrue(f.contains(.maskCommand) && f.contains(.maskControl) && f.contains(.maskAlternate)
                      && f.contains(.maskShift) && f.contains(.maskSecondaryFn))
        XCTAssertEqual(try cuModifierFlags(["cmd", "Shift"]), [.maskCommand, .maskShift])
        XCTAssertThrowsError(try cuModifierFlags(["hyper"]))
    }

    func testKeyCodes() {
        XCTAssertEqual(CUKeyCodes.code(for: .returnKey), CGKeyCode(kVK_Return))
        XCTAssertEqual(CUKeyCodes.code(for: .escape), CGKeyCode(kVK_Escape))
        XCTAssertEqual(CUKeyCodes.code(for: .f5), CGKeyCode(kVK_F5))
        // Without a layout table the US-ANSI positions are used.
        XCTAssertEqual(CUKeyCodes.code(for: "s", layout: nil), CGKeyCode(kVK_ANSI_S))
        XCTAssertEqual(CUKeyCodes.code(for: "S", layout: nil), CGKeyCode(kVK_ANSI_S))
        XCTAssertEqual(CUKeyCodes.code(for: "/", layout: nil), CGKeyCode(kVK_ANSI_Slash))
        XCTAssertNil(CUKeyCodes.code(for: "é", layout: nil))
    }

    func testTextProducingChords() throws {
        XCTAssertTrue(CUCore.producesText(try parse("a")))
        XCTAssertTrue(CUCore.producesText(try parse("shift+a")))
        XCTAssertTrue(CUCore.producesText(try parse("cmd+v")))
        XCTAssertTrue(CUCore.producesText(try parse("space")))
        XCTAssertFalse(CUCore.producesText(try parse("cmd+s")))
        XCTAssertFalse(CUCore.producesText(try parse("ctrl+a")))
        XCTAssertFalse(CUCore.producesText(try parse("tab")))
        XCTAssertFalse(CUCore.producesText(try parse("return")))
    }
}
