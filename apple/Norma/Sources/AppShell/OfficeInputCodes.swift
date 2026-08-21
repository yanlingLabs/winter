import AppKit

/// Office Stage B Task 4 — **AppKit -> LOK input encoding, one shared table.** Pure functions of
/// primitive inputs (`UInt16`/`NSEvent.ModifierFlags`/`Int`), zero NSEvent construction, zero I/O —
/// the same "pure, total, table-tested" posture `TileMath` already established for the geometry
/// half of this pipeline. `OfficeTileCanvasView`'s `keyDown`/`keyUp`/`mouseDown`/`mouseDragged`/
/// `mouseUp` are the only production callers; they extract primitives off a REAL `NSEvent` and hand
/// them here — this file never touches an `NSEvent` itself, so it stays testable with hand-picked
/// integers, no synthetic-event construction needed.
///
/// ## Source of truth — read this before touching any table below
///
/// None of this is guessed or carried over from a half-remembered StackOverflow answer. Every
/// number below was fetched from LibreOffice core's own upstream source (`github.com/LibreOffice/
/// core`, `master`, read directly — not summarized) and cross-checked a SECOND, independent way
/// against this repo's own `ComputerCapabilities.cuKeyCode(for:)` table (`Sources/App/
/// ComputerCapabilities.swift`), an already-shipped, independently-written AppKit-keyCode table for
/// an unrelated feature (CGEvent synthesis for computer-use). Every entry the two tables share
/// agrees, index for index — the letters, digits, arrows, Return/Tab/Space/Delete/Escape, and every
/// F-key. That agreement is the strongest evidence available in this repo that the PHYSICAL keyCode
/// numbering itself is right; the LOK-specific *destination* codes (`KEY_A` = `512`, not `0`) come
/// from the LOK/UNO source below, which `cuKeyCode` has no reason to know about.
///
/// - **`baseCode` table**: a direct Swift port of `ImplMapKeyCode` (`vcl/osx/salframeview.mm`,
///   `LibreOffice/core` master) — the exact table VCL's own macOS backend uses to map `[NSEvent
///   keyCode]` (AppKit's PHYSICAL, layout-independent scancode) to `com::sun::star::awt::Key`
///   constants. This is not "a" mapping, it is THE mapping — the same code path native LibreOffice
///   on macOS itself runs for real keyboard input, transcribed rather than imported for the same
///   reason `LOKBridge.swift`'s own enum transcriptions exist (no C++ UNO headers in this plain-C
///   bridging context).
/// - **`Key` constant values** (`512` for `A`, `1280` for `RETURN`, ...): `offapi/com/sun/star/awt/
///   Key.idl`, fetched and read verbatim (`const short NAME = value;` lines, not the doc-generator's
///   own summary page, which was cross-checked and agreed).
/// - **`KeyModifier`/packed `KEY_SHIFT`/`KEY_MOD1`/`KEY_MOD2`/`KEY_MOD3` bit values** (`0x1000`/
///   `0x2000`/`0x4000`/`0x8000`, NOT the unshifted `1`/`2`/`4`/`8` `KeyModifier.idl` group):
///   `include/vcl/keycodes.hxx`. Confirmed these are what `postKeyEvent`'s `nKeyCode` actually wants
///   (not the bare `KeyModifier` values) by reading `vcl::KeyCode`'s own constructor
///   (`include/vcl/keycod.hxx`: `KeyCode(sal_uInt16 nKey, sal_uInt16 nModifier = 0) { nKeyCodeAndModifiers
///   = nKey | nModifier; }`) and the ONE call site between LOK's C API and that constructor
///   (`SfxLokHelper::postKeyEventAsync`, `sfx2/source/view/lokhelper.cxx`: `KeyEvent(nCharCode,
///   nKeyCode, nRepeat)` — a single-argument implicit conversion, so the WHOLE incoming `int`
///   becomes `nKeyCodeAndModifiers` verbatim, no separate modifier parameter ever splits it).
/// - **macOS modifier-flag -> `KEY_MOD*` mapping** (Cmd -> Mod1, Option -> Mod2, Control -> Mod3 —
///   the non-obvious, macOS-specific reassignment `KeyModifier.idl`'s own doc comments name
///   directly: "MOD1 ... Ctrl key (Cmd on macOS)", "MOD3 ... Ctrl key (macOS)"): `ImplGetModifierMask`
///   (`vcl/osx/salframe.cxx`), read directly — `NSEventModifierFlagCommand -> KEY_MOD1`,
///   `NSEventModifierFlagOption -> KEY_MOD2`, `NSEventModifierFlagControl -> KEY_MOD3`,
///   `NSEventModifierFlagShift -> KEY_SHIFT`.
/// - **`postMouseEvent`'s `nButtons`** (`MOUSE_LEFT = 1`, `MOUSE_MIDDLE = 2`, `MOUSE_RIGHT = 4`):
///   `include/vcl/event.hxx`'s own `#define`s, and confirmed as a SEPARATE parameter from
///   `nModifier` (never OR'd together by a caller) by reading `MouseEvent`'s constructor and
///   `ScModelObj::postMouseEvent` (`sc/source/ui/unoobj/docuno.cxx`), which passes both straight
///   through to `MouseEvent(...)` unmodified.
///
/// `OfficeWireFrame.keyEvent`'s own doc comment carries the same citations for the wire-level
/// contract; this file is where the encoding is actually COMPUTED.
enum OfficeInputCodes {

    // MARK: - Key codes

    /// `com.sun.star.awt.Key`'s modifier-free base code for a PHYSICAL AppKit key (`NSEvent.keyCode`
    /// — layout-independent; a German QWERTZ 'Z' key position reports the SAME raw `keyCode` a US
    /// QWERTY 'Y' key position would, matching how `ImplMapKeyCode` itself works: by PHYSICAL
    /// position, not by the character a given layout happens to produce there). `0` (no case in
    /// LO's own table either) for any keyCode this table does not cover — matches
    /// `ImplMapKeyCode`'s own "0 if out of range" fallback (`aKeyCodeMap[0x80]`, every entry past
    /// `0x7F` implicitly absent) and its own scattered `0` holes for keys this door never needs
    /// (numeric-keypad `Clear`, ISO extra keys, etc.).
    static func baseCode(appKitKeyCode: UInt16) -> Int {
        table[Int(appKitKeyCode)] ?? 0
    }

    /// The packed VCL modifier bits `postKeyEvent`'s `nKeyCode` (OR'd with `baseCode`) and
    /// `postMouseEvent`'s SEPARATE `nModifier` parameter both actually want — see this type's own
    /// header for why these are the SHIFTED `0x1000`/`0x2000`/`0x4000`/`0x8000` values, never the
    /// bare `1`/`2`/`4`/`8` `KeyModifier` group. `.capsLock`/`.function`/`.numericPad`/`.help` carry
    /// no VCL modifier meaning and are deliberately not consulted — LO's own `ImplGetModifierMask`
    /// checks exactly these four flags and no others.
    static func modifierMask(_ flags: NSEvent.ModifierFlags) -> Int {
        var mask = 0
        if flags.contains(.shift) { mask |= keyShift }
        if flags.contains(.command) { mask |= keyMod1 } // Cmd -> Mod1 on macOS (KeyModifier.idl's own doc)
        if flags.contains(.option) { mask |= keyMod2 }
        if flags.contains(.control) { mask |= keyMod3 } // real Ctrl -> Mod3 on macOS
        return mask
    }

    /// The full `nKeyCode` `postKeyEvent` wants: base code OR'd with the shifted modifier bits.
    /// `0` base with a non-zero modifier mask is legal and meaningful (a bare modifier press with no
    /// mappable physical key underneath it, or a key this table does not cover but whose modifiers
    /// still matter for whatever LOK does with an unrecognized base code) — never special-cased.
    static func lokKeyCode(appKitKeyCode: UInt16, modifierFlags: NSEvent.ModifierFlags) -> Int {
        baseCode(appKitKeyCode: appKitKeyCode) | modifierMask(modifierFlags)
    }

    /// `nCharCode`: the Unicode scalar the key produces, or `0` for anything that is NOT real
    /// insertable text — verified against real LibreOffice source, not assumed: native LO's own
    /// macOS `insertText:`-shaped handler (`vcl/osx/salframeview.mm`, the block starting `if( pInsert
    /// && ... )`) gates its OWN character insertion on the exact SAME shape excluded here —
    /// `aCharCode < 0x80 && aCharCode > 0x1f`, i.e. printable ASCII only, C0 controls (Tab `0x09`,
    /// Return `0x0D`/`0x0A`, Escape `0x1B`) explicitly excluded — confirming Return/Tab/Escape/
    /// Delete carry their meaning ENTIRELY in `keyCode` for real LO too, never as "a character to
    /// insert." Generalized here past that narrow ASCII ceiling for genuine Unicode TEXT (accented
    /// Latin, non-Latin scripts typed without an active IME composition — plain, non-composed input
    /// is exactly what raw `keyDown` can see; a composed sequence never reaches this door in the
    /// first place, since AppKit delivers it via `insertText:`, not `keyDown` — Task 5's own,
    /// unimplemented route), while STILL excluding two control ranges native LO's own narrower gate
    /// has no need to separately name because its ceiling already excludes them: C1 controls
    /// (`0x7F`...`0x9F`, DEL plus its extended-control siblings) and AppKit's own Private-Use-Area
    /// encoding for arrows/function keys/Home/End/PageUp/PageDown (`0xF700`...`0xF8FF` — `NSEvent`'s
    /// documented range, e.g. `NSUpArrowFunctionKey`) — without this second exclusion, an arrow
    /// key's OWN `characters` string (a genuine, non-empty, non-zero scalar in that range) would
    /// read as "text" and get sent to LOK as if `0xF700` were a real character to insert.
    ///
    /// Takes the FIRST Unicode scalar only — every character this table's own live typing drill
    /// exercises (ASCII letters/digits/punctuation) is a single scalar; a future IME/combining-
    /// character path is Task 5's `NSTextInputClient` route, never this one (see
    /// `OfficeTileCanvasView.keyDown`'s own header on why text-generating and navigation keys stay
    /// structurally separable for that reason).
    static func charCode(for characters: String?) -> Int {
        guard let scalar = characters?.unicodeScalars.first else { return 0 }
        let value = scalar.value
        guard value > 0x1F, !(0x7F...0x9F).contains(value), !(0xF700...0xF8FF).contains(value) else { return 0 }
        return Int(value)
    }

    /// Office Stage B Task 5 — `insertText(_:replacementRange:)`'s own multi-scalar door. `charCode
    /// (for:)` above takes only the FIRST scalar because every caller before Task 5 (`keyDown`/
    /// `keyUp`, one real physical key each) only ever hands it a single-scalar string. A genuine
    /// multi-character commit — a composed IME string landing in one `insertText` call, or a future
    /// dictation/autocomplete insert — needs one entry per scalar, each independently excluded or
    /// kept by the IDENTICAL rule `charCode(for:)` applies (same three exclusions: C0 controls, C1
    /// controls, AppKit's Private-Use-Area function-key range) — this is that same per-scalar
    /// exclusion, just iterated rather than taking the first and stopping. A scalar this rule
    /// excludes is DROPPED, not substituted with `0`: a `0`-charCode `keyEvent` is a real, meaningful
    /// "bare modifier / unmapped key" wire value elsewhere in this file (see `lokKeyCode`'s own
    /// header), so silently inserting one here for a scalar `insertText` was never asked to send
    /// would be a fabricated keystroke, not a faithful translation of `text`.
    static func charCodes(for text: String) -> [Int] {
        text.unicodeScalars.compactMap { scalar in
            let value = scalar.value
            guard value > 0x1F, !(0x7F...0x9F).contains(value), !(0xF700...0xF8FF).contains(value) else { return nil }
            return Int(value)
        }
    }

    // MARK: - Mouse

    /// VCL's `MOUSE_LEFT`/`MOUSE_MIDDLE`/`MOUSE_RIGHT` bitmask for `postMouseEvent`'s `nButtons` —
    /// AppKit's `NSEvent.buttonNumber` (0 = left, 1 = right, 2 = middle, by AppKit's own convention)
    /// translated to VCL's numbering, which is NOT the same order (`MOUSE_LEFT = 1`, `MOUSE_RIGHT =
    /// 4`, `MOUSE_MIDDLE = 2`). `0` for any button number past the three this door's mouseDown/Up
    /// handlers ever forward (a 4th+ mouse button, if AppKit ever reports one) — LOK has no bit for
    /// it, and `0` is a legal-but-inert value for `nButtons`, not a refusal.
    static func mouseButton(appKitButtonNumber: Int) -> Int {
        switch appKitButtonNumber {
        case 0: return mouseLeft
        case 1: return mouseRight
        case 2: return mouseMiddle
        default: return 0
        }
    }

    // MARK: - Packed modifier bits (include/vcl/keycodes.hxx)

    private static let keyShift = 0x1000
    private static let keyMod1 = 0x2000
    private static let keyMod2 = 0x4000
    private static let keyMod3 = 0x8000

    // MARK: - Mouse button bits (include/vcl/event.hxx)

    private static let mouseLeft = 1
    private static let mouseMiddle = 2
    private static let mouseRight = 4

    // MARK: - com.sun.star.awt.Key base codes (offapi/com/sun/star/awt/Key.idl)

    private enum Key {
        static let num0 = 256, num1 = 257, num2 = 258, num3 = 259, num4 = 260
        static let num5 = 261, num6 = 262, num7 = 263, num8 = 264, num9 = 265
        static let a = 512, b = 513, c = 514, d = 515, e = 516, f = 517, g = 518, h = 519
        static let i = 520, j = 521, k = 522, l = 523, m = 524, n = 525, o = 526, p = 527
        static let q = 528, r = 529, s = 530, t = 531, u = 532, v = 533, w = 534, x = 535
        static let y = 536, z = 537
        static let f1 = 768, f2 = 769, f3 = 770, f4 = 771, f5 = 772, f6 = 773, f7 = 774, f8 = 775
        static let f9 = 776, f10 = 777, f11 = 778, f12 = 779, f13 = 780, f14 = 781, f15 = 782
        static let f16 = 783, f17 = 784, f18 = 785, f19 = 786, f20 = 787
        static let down = 1024, up = 1025, left = 1026, right = 1027
        static let home = 1028, end = 1029, pageUp = 1030, pageDown = 1031
        static let returnKey = 1280, escape = 1281, tab = 1282, backspace = 1283, space = 1284
        static let insert = 1285, delete = 1286
        static let add = 1287, subtract = 1288, multiply = 1289, divide = 1290
        static let point = 1291, comma = 1292, less = 1293, greater = 1294, equal = 1295
        static let help = 1306, decimal = 1309, quoteLeft = 1311 // QUOTELEFT, not TILDE (1310) — the backtick/grave key
        static let capsLock = 1312
        static let bracketLeft = 1315, bracketRight = 1316, semicolon = 1317, quoteRight = 1318
        static let rightCurlyBracket = 1319
    }

    // MARK: - AppKit physical keyCode (0...0x7F) -> Key base code
    // (vcl/osx/salframeview.mm ImplMapKeyCode, transcribed verbatim, row-for-row)

    private static let table: [Int: Int] = [
        0: Key.a, 1: Key.s, 2: Key.d, 3: Key.f, 4: Key.h, 5: Key.g, 6: Key.z, 7: Key.x,
        8: Key.c, 9: Key.v, 11: Key.b, 12: Key.q, 13: Key.w, 14: Key.e, 15: Key.r,
        16: Key.y, 17: Key.t, 18: Key.num1, 19: Key.num2, 20: Key.num3, 21: Key.num4,
        22: Key.num6, 23: Key.num5, 24: Key.equal, 25: Key.num9, 26: Key.num7,
        27: Key.subtract, 28: Key.num8, 29: Key.num0, 30: Key.bracketRight,
        31: Key.rightCurlyBracket, 32: Key.u, 33: Key.bracketLeft, 34: Key.i, 35: Key.p,
        36: Key.returnKey, 37: Key.l, 38: Key.j, 39: Key.quoteRight, 40: Key.k,
        41: Key.semicolon, 43: Key.comma, 44: Key.divide, 45: Key.n, 46: Key.m,
        47: Key.point, 48: Key.tab, 49: Key.space, 50: Key.quoteLeft, 51: Key.delete,
        53: Key.escape, 57: Key.capsLock,
        64: Key.f17, 65: Key.decimal, 67: Key.multiply, 69: Key.add,
        75: Key.divide, 76: Key.returnKey, 78: Key.subtract, 79: Key.f18, 80: Key.f19,
        81: Key.equal, 90: Key.f20,
        96: Key.f5, 97: Key.f6, 98: Key.f7, 99: Key.f3, 100: Key.f8, 101: Key.f9,
        103: Key.f11, 105: Key.f13, 106: Key.f16, 107: Key.f14, 109: Key.f10, 111: Key.f12,
        113: Key.f15, 114: Key.help, 115: Key.home, 116: Key.pageUp,
        117: Key.delete, // forward-delete (fn+Delete) — a SECOND physical key, same LOK code as 51
        118: Key.f4, 119: Key.end, 120: Key.f2, 121: Key.pageDown, 122: Key.f1,
        123: Key.left, 124: Key.right, 125: Key.down, 126: Key.up,
    ]
}
