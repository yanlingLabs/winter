import AppKit
import Foundation

/// Opening a file or URL in an app WITHOUT activating it — the one safe way to open a document (never Finder's
/// Open, a double-click or a menu, which activate the opener and pull the user's desktop). `NSWorkspace.open`
/// with `activates = false`, the same posture as a background app launch.
enum CUDocumentOpen {
    /// `strings` are file paths (absolute or `~`), `file:` URLs, or web/other URLs. A file path must exist.
    static func resolve(_ strings: [String]) throws -> [URL] {
        guard !strings.isEmpty else { throw CUError.invalidParams("open needs at least one file path or URL") }
        return try strings.map { raw -> URL in
            let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !s.isEmpty else { throw CUError.invalidParams("an empty path") }
            if s.hasPrefix("/") || s.hasPrefix("~") {
                let path = (s as NSString).expandingTildeInPath
                guard FileManager.default.fileExists(atPath: path) else { throw CUError.invalidParams("no file at \(s)") }
                return URL(fileURLWithPath: path).standardizedFileURL
            }
            if let u = URL(string: s), u.scheme != nil {
                // A bare file: URL path must exist; a web/other scheme is taken as is.
                if u.isFileURL {
                    guard FileManager.default.fileExists(atPath: u.path) else { throw CUError.invalidParams("no file at \(s)") }
                    return u.standardizedFileURL
                }
                return u
            }
            throw CUError.invalidParams("“\(s)” is not a file path or a URL")
        }
    }

    /// The default app for a url (the file's handler, or the scheme's), or nil.
    static func defaultApp(for url: URL) -> URL? {
        if url.isFileURL { return NSWorkspace.shared.urlForApplication(toOpen: url) }
        return NSWorkspace.shared.urlForApplication(toOpen: url)
    }

    /// Opens every url with the app at `appURL`, never activating it. The opener (running) is returned.
    static func open(_ urls: [URL], withApp appURL: URL) async throws -> NSRunningApplication {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.allowsRunningApplicationSubstitution = true
        config.addsToRecentItems = false
        config.promptsUserIfNeeded = false
        do {
            return try await NSWorkspace.shared.open(urls, withApplicationAt: appURL, configuration: config)
        } catch {
            throw CUError.unsupported("could not open \(urls.first?.lastPathComponent ?? "the document"): \(error.localizedDescription)")
        }
    }
}

/// A one-shot latch: the first `claim()` wins (resuming a continuation exactly once from racing tasks).
final class CUResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool { lock.withLock { if claimed { return false }; claimed = true; return true } }
}
