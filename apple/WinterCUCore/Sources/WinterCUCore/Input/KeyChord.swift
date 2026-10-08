import CoreGraphics
import Foundation

/// A parsed `key()` combo: `"cmd+s"`, `"return"`, `"shift+tab"`, xdotool-style `"ctrl+alt+Delete"`,
/// `"super+l"`, `"Page_Up"`. Tokens are joined by `+`; case and underscores don't matter. A literal plus is
/// `plus` (or a trailing `+`, as in `"cmd++"`).
public struct CUKeyChord: Sendable, Equatable {
    public struct Modifiers: OptionSet, Sendable, Hashable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let command = Modifiers(rawValue: 1)
        public static let control = Modifiers(rawValue: 2)
        public static let option = Modifiers(rawValue: 4)
        public static let shift = Modifiers(rawValue: 8)
        public static let function = Modifiers(rawValue: 16)

        public var cgFlags: CGEventFlags {
            var f: CGEventFlags = []
            if contains(.command) { f.insert(.maskCommand) }
            if contains(.control) { f.insert(.maskControl) }
            if contains(.option) { f.insert(.maskAlternate) }
            if contains(.shift) { f.insert(.maskShift) }
            if contains(.function) { f.insert(.maskSecondaryFn) }
            return f
        }
    }

    public enum Key: Sendable, Equatable {
        /// A named key with a fixed virtual key code.
        case named(CUNamedKey)
        /// A character key; the live layer finds its key code in the current keyboard layout.
        case character(Character)
    }

    public var key: Key
    public var modifiers: Modifiers

    public init(key: Key, modifiers: Modifiers = []) {
        self.key = key
        self.modifiers = modifiers
    }

    public var isEscape: Bool { key == .named(.escape) }

    static let modifierNames: [String: Modifiers] = [
        "cmd": .command, "command": .command, "super": .command, "meta": .command, "win": .command, "⌘": .command,
        "ctrl": .control, "control": .control, "ctl": .control, "⌃": .control,
        "alt": .option, "option": .option, "opt": .option, "⌥": .option,
        "shift": .shift, "⇧": .shift,
        "fn": .function, "function": .function,
    ]

    public static func parse(_ combo: String) throws -> CUKeyChord {
        let trimmed = combo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw CUError.invalidParams("key combo is empty") }
        // Split on "+", keeping a literal "+" key when it is the last token ("cmd++", "+").
        var tokens = trimmed.components(separatedBy: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        if trimmed.hasSuffix("+") {
            while tokens.last == "" { tokens.removeLast() }
            tokens.append("plus")
        }
        guard !tokens.contains("") else { throw CUError.invalidParams("key combo \"\(combo)\" has an empty part") }
        var mods: Modifiers = []
        for t in tokens.dropLast() {
            guard let m = modifierNames[t.lowercased()] else {
                throw CUError.invalidParams("\"\(t)\" in \"\(combo)\" is not a modifier (cmd, ctrl, alt/option, shift, fn)")
            }
            mods.insert(m)
        }
        let last = tokens.last!
        if let m = modifierNames[last.lowercased()], tokens.count == 1 {
            // A lone modifier press ("shift") — send it as its own key.
            return CUKeyChord(key: .named(CUNamedKey.forModifier(m)), modifiers: [])
        }
        if let named = CUNamedKey.lookup(last) {
            // "plus"/"minus" are spellings of character keys.
            if named == .plus { mods.insert(.shift); return CUKeyChord(key: .character("="), modifiers: mods) }
            if named == .minus { return CUKeyChord(key: .character("-"), modifiers: mods) }
            // fn+delete is forward delete on a Mac keyboard.
            if named == .delete, mods.contains(.function) {
                mods.remove(.function)
                return CUKeyChord(key: .named(.forwardDelete), modifiers: mods)
            }
            return CUKeyChord(key: .named(named), modifiers: mods)
        }
        if last.count == 1, let ch = last.first {
            // Upper-case letters and shifted symbols imply shift on the base key.
            if let base = CUKeyCodes.shiftedBase[ch] {
                mods.insert(.shift)
                return CUKeyChord(key: .character(base), modifiers: mods)
            }
            if ch.isLetter, ch.isUppercase {
                mods.insert(.shift)
                return CUKeyChord(key: .character(Character(ch.lowercased())), modifiers: mods)
            }
            return CUKeyChord(key: .character(ch), modifiers: mods)
        }
        throw CUError.invalidParams("unknown key \"\(last)\" in \"\(combo)\"")
    }
}

/// Keys with a fixed virtual key code (Carbon `kVK_*`).
public enum CUNamedKey: String, Sendable, CaseIterable {
    case returnKey, tab, space, delete, forwardDelete, escape
    case up, down, left, right, home, end, pageUp, pageDown, help
    case f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20
    case keypadEnter, keypadClear
    case capsLock, commandKey, shiftKey, optionKey, controlKey, functionKey
    case volumeUp, volumeDown, mute
    case plus, minus

    static let aliases: [String: CUNamedKey] = [
        "return": .returnKey, "enter": .returnKey, "ret": .returnKey, "cr": .returnKey, "linefeed": .returnKey,
        "kpenter": .keypadEnter, "keypadenter": .keypadEnter, "numpadenter": .keypadEnter,
        "tab": .tab, "space": .space, "spacebar": .space,
        "delete": .delete, "backspace": .delete, "bksp": .delete,
        "forwarddelete": .forwardDelete, "fwddelete": .forwardDelete, "del": .forwardDelete,
        "escape": .escape, "esc": .escape,
        "up": .up, "arrowup": .up, "uparrow": .up,
        "down": .down, "arrowdown": .down, "downarrow": .down,
        "left": .left, "arrowleft": .left, "leftarrow": .left,
        "right": .right, "arrowright": .right, "rightarrow": .right,
        "home": .home, "end": .end,
        "pageup": .pageUp, "pgup": .pageUp, "prior": .pageUp,
        "pagedown": .pageDown, "pgdn": .pageDown, "next": .pageDown,
        "help": .help, "insert": .help, "clear": .keypadClear,
        "capslock": .capsLock,
        "volumeup": .volumeUp, "volumedown": .volumeDown, "mute": .mute,
        "plus": .plus, "minus": .minus,
    ]

    public static func lookup(_ token: String) -> CUNamedKey? {
        let t = token.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
        if let a = aliases[t] { return a }
        if t.hasPrefix("f"), let n = Int(t.dropFirst()), (1...20).contains(n) {
            return CUNamedKey(rawValue: "f\(n)")
        }
        return nil
    }

    static func forModifier(_ m: CUKeyChord.Modifiers) -> CUNamedKey {
        if m.contains(.command) { return .commandKey }
        if m.contains(.control) { return .controlKey }
        if m.contains(.option) { return .optionKey }
        if m.contains(.shift) { return .shiftKey }
        return .functionKey
    }
}
