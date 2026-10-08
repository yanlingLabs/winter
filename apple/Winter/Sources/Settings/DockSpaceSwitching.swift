import AppKit
import Foundation

// -----------------------------------------------------------------------------------------------
// macOS's "When switching to an application, switch to a Space with open windows for the application"
// (System Settings → Desktop & Dock → Mission Control), kept by the Dock as `workspaces-auto-swoosh`.
// While it is on, an app that brings itself forward — Safari when the agent clicks its address bar is
// the case the live gate found — can move the user to another desktop.
//
// Winter only READS the preference, to show a hint on the Computer Use page; it never writes it (the Dock
// owns it, and a write would need the Dock restarted). Whether turning it off actually stops the switch
// is for the live gate to say: the hint's wording promises only what the user can check.
// -----------------------------------------------------------------------------------------------

enum DockSpaceSwitching {
    static let domain = "com.apple.dock"
    static let key = "workspaces-auto-swoosh"
    /// Desktop & Dock in System Settings.
    static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.Desktop-Settings.extension")!

    static let hintTitle = "Desktop switching"
    static let hint = "Apps that bring themselves forward (for example Safari when the agent clicks its address bar) can switch "
        + "your desktop. Turning this off in Desktop & Dock keeps you where you are."
    static let openButtonTitle = "Open Desktop & Dock"

    /// PURE: whether the setting is ON, given what the preference holds. Absent means ON (the system default), as
    /// does 1; 0 is OFF. Anything else that is not a recognisable "off" reads as ON — the safe side of a hint.
    static func isOn(_ value: Any?) -> Bool {
        switch value {
        case nil: return true
        case let number as NSNumber: return number.boolValue
        case let text as String: return !["0", "false", "no", "off"].contains(text.lowercased())
        default: return true
        }
    }

    /// The preference as the Dock stores it right now (`CFPreferencesCopyAppValue` — a read, and fresh: it asks the
    /// preference system, not a cache this process holds).
    static func read(_ copy: (String, String) -> Any? = { key, domain in CFPreferencesCopyAppValue(key as CFString, domain as CFString) }) -> Bool {
        isOn(copy(key, domain))
    }

    @MainActor
    static func openSettings() {
        NSWorkspace.shared.open(settingsURL)
    }
}
