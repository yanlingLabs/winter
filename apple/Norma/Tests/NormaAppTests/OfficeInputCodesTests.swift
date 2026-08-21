import XCTest
@testable import Norma

/// Office Stage B Task 4 — `OfficeInputCodes`' own pin. Every literal here is independently
/// re-derived from the same two sources `OfficeInputCodes`' own header cites (LibreOffice core's
/// `offapi/com/sun/star/awt/Key.idl` + `vcl/osx/salframeview.mm`'s `ImplMapKeyCode`) rather than
/// copied from the implementation under test — a test that just re-typed the production table
/// verbatim would catch nothing.
final class OfficeInputCodesTests: XCTestCase {

    // MARK: - The navigation backbone (the brief's own explicit list)

    func testArrowKeysMapToTheirOwnDistinctLOKCodes() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 123), 1026, "left")
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 124), 1027, "right")
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 125), 1024, "down")
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 126), 1025, "up")
        let codes = Set([1026, 1027, 1024, 1025])
        XCTAssertEqual(codes.count, 4, "sanity: the four arrow codes must be pairwise distinct")
    }

    func testReturnMapsToKeyReturn() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 36), 1280)
    }

    func testTabMapsToKeyTab() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 48), 1282)
    }

    func testEscapeMapsToKeyEscape() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 53), 1281)
    }

    /// AppKit keyCode 51 is physically labeled "delete" (backspace) on every Mac keyboard; 117 is
    /// the SEPARATE forward-delete key (fn+Delete on a laptop, or a dedicated Del key on a full
    /// keyboard) — LO's own table maps BOTH to the identical `KEY_DELETE` (`ImplMapKeyCode`'s own
    /// two distinct rows, both value `51`/`0x33` = `KEY_DELETE`), so this is a real, source-verified
    /// fact about LOK's own vocabulary (it has one "delete" concept, not two), not an oversight in
    /// this table.
    func testBothBackspaceAndForwardDeleteMapToTheSameKeyDelete() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 51), 1286, "backspace/delete")
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 117), 1286, "forward-delete")
    }

    // MARK: - Letters and digits (independently re-typed from Key.idl, not copied from the table)

    /// **25 of 26 letters, not 26** — `O` is deliberately excluded, and that exclusion is itself the
    /// point; see `testAppKitKeyCode31IsRightCurlyBracketNotOAKnownLOKUpstreamQuirk` right below for
    /// the finding this split exists to isolate.
    func testEveryOtherLetterMapsToItsOwnPublishedAwtKeyConstant() {
        let expected: [UInt16: Int] = [
            0: 512, 11: 513, 8: 514, 2: 515, 14: 516, 3: 517, 5: 518, 4: 519,
            34: 520, 38: 521, 40: 522, 37: 523, 46: 524, 45: 525, /* 31: O, see below */ 35: 527,
            12: 528, 15: 529, 1: 530, 17: 531, 32: 532, 9: 533, 13: 534, 7: 535,
            16: 536, 6: 537,
        ]
        for (keyCode, awtCode) in expected {
            XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: keyCode), awtCode,
                           "AppKit keyCode \(keyCode) -> awt::Key \(awtCode)")
        }
        XCTAssertEqual(Set(expected.values).count, 25, "sanity: 25 distinct letters, 25 distinct codes")
    }

    /// **A real, source-verified quirk in LibreOffice's own `ImplMapKeyCode` table**
    /// (`vcl/osx/salframeview.mm`), not a bug in this repo's transcription — caught by this test
    /// SUITE's own independent-re-derivation discipline: an earlier draft of this test file expected
    /// keyCode 31 -> `KEY_O` (526), matching the standard Carbon `kVK_ANSI_O = 0x1F` assignment
    /// this repo's OWN unrelated `ComputerCapabilities.cuKeyCode` table also uses (`"o": 31`, correct
    /// for ITS purpose — raw CGEvent synthesis, which never goes through LOK) — and failed against
    /// the real implementation, which (re-fetched and re-read a second time to rule out a
    /// transcription slip on THIS side) genuinely has `KEY_RIGHTCURLYBRACKET` at that position, with
    /// no `KEY_O` anywhere in the whole 128-entry table. Kept faithful to LO's real table rather than
    /// "corrected" to what Carbon's own standard numbering would suggest: this repo's `baseCode`
    /// exists to match what LOK's own OWN accelerator/shortcut matching (`GetKeyCode()`) expects, not
    /// an independent notion of "the right physical-key numbering" — and it is HARMLESS for ordinary
    /// typing regardless, since a plain, unmodified printable letter's INSERTED CHARACTER comes from
    /// `nCharCode` (this table's own `charCode(for:)`, independent of `baseCode`), never from
    /// `keyCode`'s base-letter portion — `keyCode`'s base value only matters for NAMED keys
    /// (arrows/Return/Tab/Escape/Delete, all independently verified correct above) and for
    /// accelerator matching on a held modifier, and Norma's own policy never lets an unhandled
    /// Cmd-combo reach LOK at all (`OfficeTileCanvasView.keyDown`'s own routing).
    func testAppKitKeyCode31IsRightCurlyBracketNotOAKnownLOKUpstreamQuirk() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 31), 1319, "KEY_RIGHTCURLYBRACKET, not KEY_O (526)")
    }

    func testDigitRowMapsToItsOwnPublishedAwtKeyConstants() {
        // Key.idl: NUM0=256...NUM9=265. Physical row order on a US keyboard is 1,2,3,4,5,6,7,8,9,0 —
        // NOT sequential AppKit keyCodes (18,19,20,21,23,22,26,28,25,29), a real fact about the
        // physical layout this table must get right, not an artifact worth "cleaning up."
        let expected: [UInt16: Int] = [18: 257, 19: 258, 20: 259, 21: 260, 23: 261,
                                        22: 262, 26: 263, 28: 264, 25: 265, 29: 256]
        for (keyCode, awtCode) in expected {
            XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: keyCode), awtCode)
        }
    }

    func testUnmappedAppKitKeyCodeReturnsZeroNeverTraps() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 10), 0, "a real hole in LO's own table")
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 999), 0, "past the table's own 0...0x7F range")
    }

    // MARK: - Modifier packing (include/vcl/keycodes.hxx's SHIFTED bits, never KeyModifier.idl's bare 1/2/4/8)

    func testShiftMapsToTheShiftedKeyShiftBitNotTheBareKeyModifierValue() {
        XCTAssertEqual(OfficeInputCodes.modifierMask(.shift), 0x1000, "not 1 — KeyModifier.SHIFT is the wrong group")
    }

    func testCommandMapsToMod1PerTheMacOSSpecificKeyModifierIdlDocComment() {
        XCTAssertEqual(OfficeInputCodes.modifierMask(.command), 0x2000)
    }

    func testOptionMapsToMod2() {
        XCTAssertEqual(OfficeInputCodes.modifierMask(.option), 0x4000)
    }

    func testRealControlMapsToMod3PerTheMacOSSpecificReassignment() {
        XCTAssertEqual(OfficeInputCodes.modifierMask(.control), 0x8000)
    }

    func testModifiersCombineByOring() {
        XCTAssertEqual(OfficeInputCodes.modifierMask([.shift, .command]), 0x1000 | 0x2000)
        XCTAssertEqual(OfficeInputCodes.modifierMask([.shift, .command, .option, .control]),
                       0x1000 | 0x2000 | 0x4000 | 0x8000)
    }

    func testCapsLockAndFunctionFlagsCarryNoVCLModifierMeaning() {
        XCTAssertEqual(OfficeInputCodes.modifierMask([.capsLock, .function]), 0,
                       "ImplGetModifierMask checks exactly 4 flags — these are not among them")
    }

    func testNoModifiersProducesZero() {
        XCTAssertEqual(OfficeInputCodes.modifierMask([]), 0)
    }

    // MARK: - lokKeyCode: base | modifiers

    func testLokKeyCodeCombinesBaseAndModifiersByOring() {
        // Shift+A: base 512 (0x200) | shift 0x1000 = 0x1200 = 4608.
        XCTAssertEqual(OfficeInputCodes.lokKeyCode(appKitKeyCode: 0, modifierFlags: .shift), 0x1200)
    }

    func testLokKeyCodeWithNoModifiersIsJustTheBaseCode() {
        XCTAssertEqual(OfficeInputCodes.lokKeyCode(appKitKeyCode: 0, modifierFlags: []), 512)
    }

    func testLokKeyCodeForAnUnmappedKeyIsJustTheModifierBits() {
        XCTAssertEqual(OfficeInputCodes.lokKeyCode(appKitKeyCode: 10, modifierFlags: .command), 0x2000,
                       "a bare modifier over an unmapped physical key is not a refusal — 0 | mask")
    }

    // MARK: - charCode

    func testCharCodeIsTheFirstUnicodeScalar() {
        XCTAssertEqual(OfficeInputCodes.charCode(for: "A"), 65)
        XCTAssertEqual(OfficeInputCodes.charCode(for: "a"), 97)
        XCTAssertEqual(OfficeInputCodes.charCode(for: "-"), 45)
        XCTAssertEqual(OfficeInputCodes.charCode(for: "5"), 53)
    }

    func testCharCodeIsZeroForNilOrEmpty() {
        XCTAssertEqual(OfficeInputCodes.charCode(for: nil), 0)
        XCTAssertEqual(OfficeInputCodes.charCode(for: ""), 0)
    }

    func testCharCodeTakesOnlyTheFirstScalarOfAMultiCharacterString() {
        // A real AppKit `characters` string is virtually always one grapheme for ordinary typing,
        // but this function's own contract ("takes the FIRST Unicode scalar only") is worth pinning
        // directly rather than trusting it holds only by construction of every current call site.
        XCTAssertEqual(OfficeInputCodes.charCode(for: "AB"), 65)
    }

    // MARK: - Mouse buttons (include/vcl/event.hxx)

    func testAppKitButtonNumbersMapToVCLsDifferentlyOrderedBits() {
        XCTAssertEqual(OfficeInputCodes.mouseButton(appKitButtonNumber: 0), 1, "left: AppKit 0 -> VCL MOUSE_LEFT 1")
        XCTAssertEqual(OfficeInputCodes.mouseButton(appKitButtonNumber: 1), 4, "right: AppKit 1 -> VCL MOUSE_RIGHT 4")
        XCTAssertEqual(OfficeInputCodes.mouseButton(appKitButtonNumber: 2), 2, "middle: AppKit 2 -> VCL MOUSE_MIDDLE 2")
    }

    func testAFourthMouseButtonMapsToZeroRatherThanGuessing() {
        XCTAssertEqual(OfficeInputCodes.mouseButton(appKitButtonNumber: 3), 0)
    }
}
