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
    /// keyboard). **They are two different keys and they must reach LOK as two different codes.**
    ///
    /// This assertion used to say both were `1286`, citing "`ImplMapKeyCode`'s own two distinct
    /// rows, both value `51`/`0x33` = `KEY_DELETE`" — which reads the array INDEX (`0x33` is 51,
    /// the macOS scancode for Backspace) as if it were the value, and pinned a real shipped defect:
    /// Backspace forward-deleted in every office tab. The correct source is `ImplMapCharCode`, the
    /// table LO consults FIRST (`sendSingleCharacter:` falls through to `ImplMapKeyCode` only when
    /// the character maps to 0), whose row `0x7F` — what the Backspace key actually reports — is
    /// `KEY_BACKSPACE`. Values re-derived from `Key.idl`: `BACKSPACE = 1283`, `DELETE = 1286`.
    func testBackspaceAndForwardDeleteMapToTheirOwnDistinctLOKCodes() {
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 51), 1283, "backspace -> KEY_BACKSPACE")
        XCTAssertEqual(OfficeInputCodes.baseCode(appKitKeyCode: 117), 1286, "fn+Delete -> KEY_DELETE")
        XCTAssertNotEqual(OfficeInputCodes.baseCode(appKitKeyCode: 51),
                          OfficeInputCodes.baseCode(appKitKeyCode: 117),
                          "the two physical delete keys must never collapse to one wire code again")
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

    /// **A real correctness bug, caught while building the six-criteria live tests, fixed here.**
    /// Real AppKit `characters` for Return/Tab/Escape/Backspace are NOT empty — they carry genuine,
    /// non-zero C0-control Unicode scalars ("\r"=0x0D, "\t"=0x09, "\u{1B}"=0x1B, "\u{7F}"/"\u{8}").
    /// An earlier version of this function had no exclusion at all, meaning `charCode` would have
    /// reported a non-zero value for every one of these — silently sending Return's own "\r" to LOK
    /// as if it were a character to type, alongside its own `keyCode`. Verified against real
    /// LibreOffice source before fixing: `vcl/osx/salframeview.mm`'s own `insertText:`-shaped
    /// handler gates real character insertion on `aCharCode > 0x1f` for exactly this reason — this
    /// function's own header has the full citation.
    func testControlCharactersProduceZeroCharCodeNeverTheirRawScalar() {
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\r"), 0, "Return")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\n"), 0, "Return (LF form)")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\t"), 0, "Tab")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\u{1B}"), 0, "Escape")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\u{08}"), 0, "Backspace (BS, C0)")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\u{7F}"), 0, "Delete (DEL, C1 boundary)")
    }

    /// AppKit represents arrow keys / function keys / Home / End / PageUp / PageDown via its own
    /// Private-Use-Area Unicode encoding (`NSEvent`'s documented `0xF700`...`0xF8FF` range, e.g.
    /// `NSUpArrowFunctionKey == 0xF700`) — a REAL, non-empty, non-zero `characters` string for these
    /// keys, which a naive "non-zero scalar means text" rule would wrongly forward to LOK as if
    /// `0xF700` were a character to insert.
    func testAppKitPrivateUseAreaFunctionKeyCodesProduceZeroCharCode() {
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\u{F700}"), 0, "NSUpArrowFunctionKey")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\u{F729}"), 0, "NSHomeFunctionKey")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "\u{F8FF}"), 0, "the top of the excluded range")
    }

    func testOrdinaryPrintableCharactersAreUnaffectedByTheControlExclusion() {
        XCTAssertEqual(OfficeInputCodes.charCode(for: " "), 32, "space is real content, not a control")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "~"), 126, "the printable-ASCII ceiling")
        XCTAssertEqual(OfficeInputCodes.charCode(for: "é"), 233, "non-ASCII Unicode text is still forwarded")
    }

    // MARK: - charCodes (Office Stage B Task 5 — insertText's multi-scalar door)

    func testCharCodesReturnsOneEntryPerScalarInOrder() {
        XCTAssertEqual(OfficeInputCodes.charCodes(for: "AB"), [65, 66])
        XCTAssertEqual(OfficeInputCodes.charCodes(for: "é"), [233])
        XCTAssertEqual(OfficeInputCodes.charCodes(for: "xyz"), [120, 121, 122])
    }

    func testCharCodesIsEmptyForEmptyString() {
        XCTAssertEqual(OfficeInputCodes.charCodes(for: ""), [])
    }

    /// Same three exclusions as `charCode(for:)` — this is the identical rule, just applied
    /// per-scalar rather than to the first scalar only.
    func testCharCodesDropsExcludedScalarsRatherThanSubstitutingZero() {
        XCTAssertEqual(OfficeInputCodes.charCodes(for: "A\rB"), [65, 66], "the C0 control (\\r) is "
                       + "DROPPED, not turned into a fabricated 0-charCode entry between A and B")
        XCTAssertEqual(OfficeInputCodes.charCodes(for: "\t\u{1B}"), [], "an all-control string yields "
                       + "an empty array, not an array of zeros")
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
