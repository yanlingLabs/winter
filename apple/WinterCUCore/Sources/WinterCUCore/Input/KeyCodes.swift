import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Virtual key codes. Named keys have fixed codes; character keys use the current keyboard layout when it
/// can be read (so `cmd+z` is the Z key on AZERTY too), else the US-ANSI position.
public enum CUKeyCodes {
    public static func code(for named: CUNamedKey) -> CGKeyCode {
        switch named {
        case .returnKey: return CGKeyCode(kVK_Return)
        case .tab: return CGKeyCode(kVK_Tab)
        case .space: return CGKeyCode(kVK_Space)
        case .delete: return CGKeyCode(kVK_Delete)
        case .forwardDelete: return CGKeyCode(kVK_ForwardDelete)
        case .escape: return CGKeyCode(kVK_Escape)
        case .up: return CGKeyCode(kVK_UpArrow)
        case .down: return CGKeyCode(kVK_DownArrow)
        case .left: return CGKeyCode(kVK_LeftArrow)
        case .right: return CGKeyCode(kVK_RightArrow)
        case .home: return CGKeyCode(kVK_Home)
        case .end: return CGKeyCode(kVK_End)
        case .pageUp: return CGKeyCode(kVK_PageUp)
        case .pageDown: return CGKeyCode(kVK_PageDown)
        case .help: return CGKeyCode(kVK_Help)
        case .f1: return CGKeyCode(kVK_F1)
        case .f2: return CGKeyCode(kVK_F2)
        case .f3: return CGKeyCode(kVK_F3)
        case .f4: return CGKeyCode(kVK_F4)
        case .f5: return CGKeyCode(kVK_F5)
        case .f6: return CGKeyCode(kVK_F6)
        case .f7: return CGKeyCode(kVK_F7)
        case .f8: return CGKeyCode(kVK_F8)
        case .f9: return CGKeyCode(kVK_F9)
        case .f10: return CGKeyCode(kVK_F10)
        case .f11: return CGKeyCode(kVK_F11)
        case .f12: return CGKeyCode(kVK_F12)
        case .f13: return CGKeyCode(kVK_F13)
        case .f14: return CGKeyCode(kVK_F14)
        case .f15: return CGKeyCode(kVK_F15)
        case .f16: return CGKeyCode(kVK_F16)
        case .f17: return CGKeyCode(kVK_F17)
        case .f18: return CGKeyCode(kVK_F18)
        case .f19: return CGKeyCode(kVK_F19)
        case .f20: return CGKeyCode(kVK_F20)
        case .keypadEnter: return CGKeyCode(kVK_ANSI_KeypadEnter)
        case .keypadClear: return CGKeyCode(kVK_ANSI_KeypadClear)
        case .capsLock: return CGKeyCode(kVK_CapsLock)
        case .commandKey: return CGKeyCode(kVK_Command)
        case .shiftKey: return CGKeyCode(kVK_Shift)
        case .optionKey: return CGKeyCode(kVK_Option)
        case .controlKey: return CGKeyCode(kVK_Control)
        case .functionKey: return CGKeyCode(kVK_Function)
        case .volumeUp: return CGKeyCode(kVK_VolumeUp)
        case .volumeDown: return CGKeyCode(kVK_VolumeDown)
        case .mute: return CGKeyCode(kVK_Mute)
        case .plus: return CGKeyCode(kVK_ANSI_Equal)
        case .minus: return CGKeyCode(kVK_ANSI_Minus)
        }
    }

    /// US-ANSI positions of the unshifted characters.
    public static let ansi: [Character: CGKeyCode] = [
        "a": CGKeyCode(kVK_ANSI_A), "b": CGKeyCode(kVK_ANSI_B), "c": CGKeyCode(kVK_ANSI_C), "d": CGKeyCode(kVK_ANSI_D),
        "e": CGKeyCode(kVK_ANSI_E), "f": CGKeyCode(kVK_ANSI_F), "g": CGKeyCode(kVK_ANSI_G), "h": CGKeyCode(kVK_ANSI_H),
        "i": CGKeyCode(kVK_ANSI_I), "j": CGKeyCode(kVK_ANSI_J), "k": CGKeyCode(kVK_ANSI_K), "l": CGKeyCode(kVK_ANSI_L),
        "m": CGKeyCode(kVK_ANSI_M), "n": CGKeyCode(kVK_ANSI_N), "o": CGKeyCode(kVK_ANSI_O), "p": CGKeyCode(kVK_ANSI_P),
        "q": CGKeyCode(kVK_ANSI_Q), "r": CGKeyCode(kVK_ANSI_R), "s": CGKeyCode(kVK_ANSI_S), "t": CGKeyCode(kVK_ANSI_T),
        "u": CGKeyCode(kVK_ANSI_U), "v": CGKeyCode(kVK_ANSI_V), "w": CGKeyCode(kVK_ANSI_W), "x": CGKeyCode(kVK_ANSI_X),
        "y": CGKeyCode(kVK_ANSI_Y), "z": CGKeyCode(kVK_ANSI_Z),
        "0": CGKeyCode(kVK_ANSI_0), "1": CGKeyCode(kVK_ANSI_1), "2": CGKeyCode(kVK_ANSI_2), "3": CGKeyCode(kVK_ANSI_3),
        "4": CGKeyCode(kVK_ANSI_4), "5": CGKeyCode(kVK_ANSI_5), "6": CGKeyCode(kVK_ANSI_6), "7": CGKeyCode(kVK_ANSI_7),
        "8": CGKeyCode(kVK_ANSI_8), "9": CGKeyCode(kVK_ANSI_9),
        "-": CGKeyCode(kVK_ANSI_Minus), "=": CGKeyCode(kVK_ANSI_Equal), "[": CGKeyCode(kVK_ANSI_LeftBracket),
        "]": CGKeyCode(kVK_ANSI_RightBracket), "\\": CGKeyCode(kVK_ANSI_Backslash), ";": CGKeyCode(kVK_ANSI_Semicolon),
        "'": CGKeyCode(kVK_ANSI_Quote), ",": CGKeyCode(kVK_ANSI_Comma), ".": CGKeyCode(kVK_ANSI_Period),
        "/": CGKeyCode(kVK_ANSI_Slash), "`": CGKeyCode(kVK_ANSI_Grave),
        " ": CGKeyCode(kVK_Space), "\t": CGKeyCode(kVK_Tab), "\n": CGKeyCode(kVK_Return), "\r": CGKeyCode(kVK_Return),
    ]

    /// US-ANSI shifted symbols → the base key they live on.
    public static let shiftedBase: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]

    /// The key code for a character key: the current layout's when available, else US-ANSI.
    public static func code(for ch: Character, layout: CUKeyboardLayout? = .current) -> CGKeyCode? {
        let lower = Character(String(ch).lowercased())
        if let layout, let c = layout.code(for: lower) { return c }
        return ansi[lower]
    }
}

/// A character → key-code table for the current keyboard layout, built with `UCKeyTranslate`.
///
/// Text Input Sources must be queried on the main thread (HIToolbox asserts it on recent macOS), so the
/// table is built by `refresh()` on the main actor — at startup and whenever the input source changes —
/// and background input code only reads the cached copy.
public final class CUKeyboardLayout: @unchecked Sendable {
    private let table: [Character: CGKeyCode]

    init(table: [Character: CGKeyCode]) { self.table = table }

    func code(for ch: Character) -> CGKeyCode? { table[ch] }

    private static let lock = NSLock()
    private static var cached: CUKeyboardLayout?

    /// The last table `refresh()` built; nil until then (callers fall back to US-ANSI).
    public static var current: CUKeyboardLayout? {
        lock.lock(); defer { lock.unlock() }
        return cached
    }

    @MainActor public static func refresh() {
        let built = build()
        lock.lock(); cached = built; lock.unlock()
    }

    @MainActor private static func build() -> CUKeyboardLayout? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return nil }
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        var table: [Character: CGKeyCode] = [:]
        data.withUnsafeBytes { buf in
            guard let ptr = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            for code in 0..<128 {
                var deadKeys: UInt32 = 0
                var chars = [UniChar](repeating: 0, count: 4)
                var length = 0
                let status = UCKeyTranslate(ptr, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                                            OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, 4, &length, &chars)
                guard status == noErr, length > 0 else { continue }
                let s = String(utf16CodeUnits: chars, count: length)
                guard s.count == 1, let ch = s.first else { continue }
                if table[ch] == nil { table[ch] = CGKeyCode(code) }
            }
        }
        guard !table.isEmpty else { return nil }
        return CUKeyboardLayout(table: table)
    }
}
