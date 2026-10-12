import AppKit
import Foundation

/// ComputerV2 Phase 4 (lane H3) — **keys and modifiers for the headless presentation**, pure: a macOS key event as
/// the fields of a `WinterPresentInputMsg` (CEF's `CefKeyEvent`): the Windows key code, the native (macOS) key code,
/// the character and the unmodified character, and CEF's `EVENTFLAG_*` modifier bits.
///
/// The Windows key code follows Chromium's own rule for a Mac event (`ui/events/keycodes/
/// keyboard_code_conversion_mac.mm`, BSD-3 — the table below is Winter's own transcription of its mapping): a
/// printable key that is not on the keypad by its character first (so ⌘ on a Dvorak-QWERTY layout and every other
/// layout reach the key a page expects), then by its unmodified character, else by the physical key code.
enum HeadlessPresentKeys {

    // MARK: - CEF's EVENTFLAG bits (cef_types.h, cef_event_flags_t)

    static let capsLockOn: UInt32 = 1 << 0
    static let shiftDown: UInt32 = 1 << 1
    static let controlDown: UInt32 = 1 << 2
    static let altDown: UInt32 = 1 << 3
    static let leftMouseButton: UInt32 = 1 << 4
    static let middleMouseButton: UInt32 = 1 << 5
    static let rightMouseButton: UInt32 = 1 << 6
    static let commandDown: UInt32 = 1 << 7
    static let isKeyPad: UInt32 = 1 << 9

    /// Which mouse button an event carries (for its EVENTFLAG bit).
    enum MouseButton { case none, left, middle, right }

    /// CEF's modifier bits for an event's modifier flags, its key code (keypad keys), and the button it carries.
    static func modifiers(_ flags: NSEvent.ModifierFlags, keyCode: UInt16? = nil, button: MouseButton = .none) -> UInt32 {
        var bits: UInt32 = 0
        if flags.contains(.control) { bits |= controlDown }
        if flags.contains(.shift) { bits |= shiftDown }
        if flags.contains(.option) { bits |= altDown }
        if flags.contains(.command) { bits |= commandDown }
        if flags.contains(.capsLock) { bits |= capsLockOn }
        if let keyCode, flags.contains(.numericPad) || isKeyPad(keyCode) { bits |= isKeyPad }
        switch button {
        case .left: bits |= leftMouseButton
        case .middle: bits |= middleMouseButton
        case .right: bits |= rightMouseButton
        case .none: break
        }
        return bits
    }

    /// The keypad's keys (Clear, =, /, *, -, +, Enter, ., 0–9).
    static func isKeyPad(_ keyCode: UInt16) -> Bool {
        switch keyCode {
        case 71, 81, 75, 67, 78, 69, 76, 65, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92: return true
        default: return false
        }
    }

    /// A `flagsChanged` event is a modifier key going up when its own flag is now off (as cefclient reads it).
    static func isModifierKeyUp(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> Bool {
        switch keyCode {
        case 54, 55: return !flags.contains(.command)    // right, left Command
        case 57: return !flags.contains(.capsLock)       // Caps Lock
        case 56, 60: return !flags.contains(.shift)      // left, right Shift
        case 58, 61: return !flags.contains(.option)     // left, right Option
        case 59, 62: return !flags.contains(.control)    // left, right Control
        case 63: return !flags.contains(.function)       // fn
        default: return false
        }
    }

    // MARK: - Windows key codes

    /// A few named Windows key codes (WinUser.h's VK_*), for tests and the code below.
    enum VK {
        static let back: Int32 = 0x08, tab: Int32 = 0x09, clear: Int32 = 0x0C, returnKey: Int32 = 0x0D
        static let shift: Int32 = 0x10, control: Int32 = 0x11, menu: Int32 = 0x12, capital: Int32 = 0x14
        static let escape: Int32 = 0x1B, space: Int32 = 0x20
        static let prior: Int32 = 0x21, next: Int32 = 0x22, end: Int32 = 0x23, home: Int32 = 0x24
        static let left: Int32 = 0x25, up: Int32 = 0x26, right: Int32 = 0x27, down: Int32 = 0x28
        static let insert: Int32 = 0x2D, delete: Int32 = 0x2E
        static let lwin: Int32 = 0x5B, apps: Int32 = 0x5D
        static let numpad0: Int32 = 0x60
        static let multiply: Int32 = 0x6A, add: Int32 = 0x6B, subtract: Int32 = 0x6D, decimal: Int32 = 0x6E, divide: Int32 = 0x6F
        static let f1: Int32 = 0x70
        static let volumeMute: Int32 = 0xAD, volumeDown: Int32 = 0xAE, volumeUp: Int32 = 0xAF
        static let oem1: Int32 = 0xBA, oemPlus: Int32 = 0xBB, oemComma: Int32 = 0xBC, oemMinus: Int32 = 0xBD
        static let oemPeriod: Int32 = 0xBE, oem2: Int32 = 0xBF, oem3: Int32 = 0xC0
        static let oem4: Int32 = 0xDB, oem5: Int32 = 0xDC, oem6: Int32 = 0xDD, oem7: Int32 = 0xDE
        static func f(_ n: Int32) -> Int32 { f1 + n - 1 }
    }

    /// The Windows key code of a physical macOS key (kVK_*), 0 for none.
    static func windowsKeyCode(keyCode: UInt16) -> Int32 {
        guard Int(keyCode) < byKeyCode.count else { return 0 }
        return byKeyCode[Int(keyCode)]
    }

    /// The Windows key code a character means on a US layout (letters, digits, punctuation, a few function keys
    /// macOS reports as characters), 0 for none.
    static func windowsKeyCode(character: unichar) -> Int32 {
        switch character {
        case 0x61...0x7A: return Int32(character) - 0x20     // a–z → VK_A…VK_Z
        case 0x41...0x5A: return Int32(character)            // A–Z
        case 0x30...0x39: return Int32(character)            // 0–9
        case 0x3B, 0x3A: return VK.oem1                       // ; :
        case 0x3D, 0x2B: return VK.oemPlus                    // = +
        case 0x2C, 0x3C: return VK.oemComma                   // , <
        case 0x2D, 0x5F: return VK.oemMinus                   // - _
        case 0x2E, 0x3E: return VK.oemPeriod                  // . >
        case 0x2F, 0x3F: return VK.oem2                       // / ?
        case 0x60, 0x7E: return VK.oem3                       // ` ~
        case 0x5B, 0x7B: return VK.oem4                       // [ {
        case 0x5C, 0x7C: return VK.oem5                       // \ |
        case 0x5D, 0x7D: return VK.oem6                       // ] }
        case 0x27, 0x22: return VK.oem7                       // ' "
        case unichar(NSPauseFunctionKey): return 0x13
        case unichar(NSSelectFunctionKey): return 0x29
        case unichar(NSPrintFunctionKey): return 0x2A
        case unichar(NSExecuteFunctionKey): return 0x2B
        case unichar(NSPrintScreenFunctionKey): return 0x2C
        case unichar(NSInsertFunctionKey): return VK.insert
        case unichar(NSF21FunctionKey): return VK.f(21)
        case unichar(NSF22FunctionKey): return VK.f(22)
        case unichar(NSF23FunctionKey): return VK.f(23)
        case unichar(NSF24FunctionKey): return VK.f(24)
        case unichar(NSScrollLockFunctionKey): return 0x91
        default: return 0
        }
    }

    /// The Windows key code of a key event: by its character, then its unmodified character (a key off the keypad
    /// that is not a digit-row number key… as Chromium reads a Mac event), else by the physical key.
    static func windowsKeyCode(keyCode: UInt16, characters: String?, charactersIgnoringModifiers: String?) -> Int32 {
        if !isKeyPad(keyCode) {
            if let c = characters?.utf16.first {
                let code = windowsKeyCode(character: c)
                if code != 0 { return code }
            }
            if let c = charactersIgnoringModifiers?.utf16.first {
                let code = windowsKeyCode(character: c)
                if code != 0 { return code }
            }
        }
        return windowsKeyCode(keyCode: keyCode)
    }

    /// kVK_* (0x00–0x7F) → VK_*, by the physical key.
    private static let byKeyCode: [Int32] = [
        /* 0x00 */ 0x41, 0x53, 0x44, 0x46, 0x48, 0x47, 0x5A, 0x58,   // A S D F H G Z X
        /* 0x08 */ 0x43, 0x56, VK.oem3, 0x42, 0x51, 0x57, 0x45, 0x52, // C V § B Q W E R
        /* 0x10 */ 0x59, 0x54, 0x31, 0x32, 0x33, 0x34, 0x36, 0x35,   // Y T 1 2 3 4 6 5
        /* 0x18 */ VK.oemPlus, 0x39, 0x37, VK.oemMinus, 0x38, 0x30, VK.oem6, 0x4F, // = 9 7 - 8 0 ] O
        /* 0x20 */ 0x55, VK.oem4, 0x49, 0x50, VK.returnKey, 0x4C, 0x4A, VK.oem7,   // U [ I P Return L J '
        /* 0x28 */ 0x4B, VK.oem1, VK.oem5, VK.oemComma, VK.oem2, 0x4E, 0x4D, VK.oemPeriod, // K ; \ , / N M .
        /* 0x30 */ VK.tab, VK.space, VK.oem3, VK.back, 0, VK.escape, VK.apps, VK.lwin, // Tab Space ` ⌫ – Esc R⌘ L⌘
        /* 0x38 */ VK.shift, VK.capital, VK.menu, VK.control, VK.shift, VK.menu, VK.control, 0, // ⇧ ⇪ ⌥ ⌃ R⇧ R⌥ R⌃ fn
        /* 0x40 */ VK.f(17), VK.decimal, 0, VK.multiply, 0, VK.add, 0, VK.clear,
        /* 0x48 */ VK.volumeUp, VK.volumeDown, VK.volumeMute, VK.divide, VK.returnKey, 0, VK.subtract, VK.f(18),
        /* 0x50 */ VK.f(19), VK.oemPlus, VK.numpad0, VK.numpad0 + 1, VK.numpad0 + 2, VK.numpad0 + 3, VK.numpad0 + 4, VK.numpad0 + 5,
        /* 0x58 */ VK.numpad0 + 6, VK.numpad0 + 7, VK.f(20), VK.numpad0 + 8, VK.numpad0 + 9, 0, 0, 0,
        /* 0x60 */ VK.f(5), VK.f(6), VK.f(7), VK.f(3), VK.f(8), VK.f(9), 0, VK.f(11),
        /* 0x68 */ 0, VK.f(13), VK.f(16), VK.f(14), 0, VK.f(10), VK.apps, VK.f(12),
        /* 0x70 */ 0, VK.f(15), VK.insert, VK.home, VK.prior, VK.delete, VK.f(4), VK.end,
        /* 0x78 */ VK.f(2), VK.next, VK.f(1), VK.left, VK.right, VK.down, VK.up, 0,
    ]

    // MARK: - Characters

    /// The first UTF-16 unit of `s`, 0 for none.
    static func firstUnit(_ s: String?) -> UInt16 { s?.utf16.first ?? 0 }

    /// macOS's private-use range for function keys (arrows, F1…, Home): never typed text.
    static func isFunctionKeyCharacter(_ c: UInt16) -> Bool { c >= 0xF700 && c <= 0xF8FF }
}

/// The page's cursor (CEF's `cef_cursor_type_t`, in the producer's CURSOR message), as a kind Winter draws.
enum HeadlessCursorKind: Equatable {
    case arrow, crosshair, pointingHand, iBeam, verticalIBeam
    case resizeLeftRight, resizeUpDown, resizeDiagonalNESW, resizeDiagonalNWSE
    case openHand, closedHand, contextualMenu, dragLink, dragCopy, notAllowed, zoomIn, zoomOut, hidden

    /// `cef_cursor_type_t` → kind. An unknown or custom cursor (its image is not on the wire) is the arrow.
    static func from(cefType type: Int32) -> HeadlessCursorKind {
        switch type {
        case 0: return .arrow                       // CT_POINTER
        case 1: return .crosshair                   // CT_CROSS
        case 2: return .pointingHand                // CT_HAND
        case 3: return .iBeam                       // CT_IBEAM
        case 4, 5: return .arrow                    // CT_WAIT, CT_HELP (no public cursor)
        case 6, 13, 15, 18: return .resizeLeftRight // EAST, WEST, EASTWEST, COLUMN
        case 7, 10, 14, 19: return .resizeUpDown    // NORTH, SOUTH, NORTHSOUTH, ROW
        case 8, 12, 16: return .resizeDiagonalNESW  // NORTHEAST, SOUTHWEST, NORTHEASTSOUTHWEST
        case 9, 11, 17: return .resizeDiagonalNWSE  // NORTHWEST, SOUTHEAST, NORTHWESTSOUTHEAST
        case 20...28: return .openHand              // the panning cursors
        case 29: return .openHand                   // CT_MOVE
        case 30: return .verticalIBeam              // CT_VERTICALTEXT
        case 31: return .crosshair                  // CT_CELL
        case 32: return .contextualMenu             // CT_CONTEXTMENU
        case 33: return .dragLink                   // CT_ALIAS
        case 34: return .arrow                      // CT_PROGRESS
        case 35: return .notAllowed                 // CT_NODROP
        case 36: return .dragCopy                   // CT_COPY
        case 37: return .hidden                     // CT_NONE
        case 38: return .notAllowed                 // CT_NOTALLOWED
        case 39: return .zoomIn                     // CT_ZOOMIN
        case 40: return .zoomOut                    // CT_ZOOMOUT
        case 41: return .openHand                   // CT_GRAB
        case 42: return .closedHand                 // CT_GRABBING
        case 43, 44: return .openHand               // middle panning, vertical/horizontal
        case 46, 47: return .arrow                  // CT_DND_NONE, CT_DND_MOVE
        case 48: return .dragCopy                   // CT_DND_COPY
        case 49: return .dragLink                   // CT_DND_LINK
        default: return .arrow                      // CT_CUSTOM and anything newer
        }
    }

    /// The AppKit cursor that draws it.
    @MainActor
    var cursor: NSCursor {
        switch self {
        case .arrow: return .arrow
        case .crosshair: return .crosshair
        case .pointingHand: return .pointingHand
        case .iBeam: return .iBeam
        case .verticalIBeam: return .iBeamCursorForVerticalLayout
        case .resizeLeftRight: return .columnResize(directions: .all)
        case .resizeUpDown: return .rowResize(directions: .all)
        case .resizeDiagonalNESW: return .frameResize(position: .topRight, directions: .all)
        case .resizeDiagonalNWSE: return .frameResize(position: .topLeft, directions: .all)
        case .openHand: return .openHand
        case .closedHand: return .closedHand
        case .contextualMenu: return .contextualMenu
        case .dragLink: return .dragLink
        case .dragCopy: return .dragCopy
        case .notAllowed: return .operationNotAllowed
        case .zoomIn: return .zoomIn
        case .zoomOut: return .zoomOut
        case .hidden: return Self.blank
        }
    }

    /// A cursor that draws nothing (CT_NONE: the page hides it).
    @MainActor private static let blank = NSCursor(image: NSImage(size: NSSize(width: 1, height: 1)), hotSpot: .zero)
}
