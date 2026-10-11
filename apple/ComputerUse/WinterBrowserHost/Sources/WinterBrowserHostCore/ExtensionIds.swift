import Foundation

/// The Winter for Chrome extension ids each profile serves. Defined once per language and kept equal by a repo test:
/// here, the daemon's `browser/extension/extension-ids.ts`, Winter.app's manifest writer, and the id the dev build's
/// manifest `key` derives (`extensions/winter-for-chrome/keys/dev.pub`).
public enum ExtensionIds {
    /// The store builds (publisher yanlingLabs), each id assigned by its store at the first upload: the Chrome Web Store's
    /// "Winter for Chrome" and Edge Add-ons' "Winter for Edge".
    public static let dist: [String] = [
        "bapmmpefcbjabfdfeehimdhldpjaoemd", // Edge Add-ons: Winter for Edge
        // Chrome Web Store: Winter for Chrome (its id goes here once the store assigns it)
    ]
    /// The unpacked dev build (its id is fixed by its manifest key).
    public static let dev: [String] = ["jikdcokcpbacalfeipkognejnlnobbbf"]

    /// The id in a `chrome-extension://<id>/` origin — exactly that shape, or nil.
    public static func id(fromOrigin origin: String) -> String? {
        let prefix = "chrome-extension://"
        guard origin.hasPrefix(prefix), origin.hasSuffix("/") else { return nil }
        let id = origin.dropFirst(prefix.count).dropLast()
        guard id.count == 32, id.allSatisfy({ $0 >= "a" && $0 <= "p" }) else { return nil }
        return String(id)
    }

    /// Is `origin` (Chrome's first argument to the host) one of `allowed`?
    public static func originAllowed(_ origin: String, allowed: [String]) -> Bool {
        guard let id = id(fromOrigin: origin) else { return false }
        return allowed.contains(id)
    }
}
