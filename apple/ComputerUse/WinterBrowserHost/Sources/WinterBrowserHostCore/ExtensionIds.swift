import Foundation

/// The Winter for Chrome extension ids each profile serves. Defined once per language and kept equal by a repo test:
/// here, the daemon's `browser/extension/extension-ids.ts`, Winter.app's manifest writer, and the id the dev build's
/// manifest `key` derives (`extensions/winter-for-chrome/keys/dev.pub`).
public enum ExtensionIds {
    /// The Chrome Web Store and Edge Add-ons listings (publisher yanlingLabs). Assigned at the first upload: until then
    /// dist serves no extension at all.
    public static let dist: [String] = []
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
