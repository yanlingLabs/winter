import AppKit
import Combine
import Foundation
import QuickLookThumbnailing

// The Winter island's Shelf (`docs/claude/island.md`): files the user dropped on the island, kept as REFERENCES ONLY.
// The rule: the shelf never copies, moves or writes a file it holds. It stores, per item, the file's bookmark data (a
// file-system reference that resolves through the file's identity, so it FOLLOWS a move or a rename on the same
// volume) and the last path it resolved to, in ONE metadata file of the app's own (`shelf.json` under the app's
// Application Support folder for its bundle id — `com.winter.app.dev` for the dev app — never `~/.winter*`). The app is
// not sandboxed, so the bookmarks are plain ones (a security scope would grant nothing).
//
// A file that no longer resolves is MISSING (shown so, with a remove action). A screenshot dragged off the floating
// thumbnail lives first in the screenshot tool's temporary folder; when macOS later files it at its final place the
// bookmark follows a same-volume move, and if it was copied instead the shelf looks for the same name in the
// screenshot folder (`screenshotFallback`) — reading only.

/// One shelf entry, as persisted.
struct IslandShelfItem: Codable, Identifiable, Equatable {
    let id: String
    /// The file's bookmark data (resolves through moves and renames).
    var bookmark: Data
    /// The path it last resolved to.
    var lastPath: String
    let addedAt: Date

    var name: String { (lastPath as NSString).lastPathComponent }
}

/// Where an item is now.
enum IslandShelfResolution: Equatable {
    case present(URL)
    case missing
}

/// Reads and writes the shelf's one metadata file. Injected in tests (a temporary folder).
struct IslandShelfPersistence {
    let fileURL: URL

    /// The app's own: `~/Library/Application Support/<bundle id>/Island/shelf.json` (the dev app's bundle id differs,
    /// so dev and dist never share a shelf).
    static func appDefault(bundleId: String? = Bundle.main.bundleIdentifier) -> IslandShelfPersistence {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return IslandShelfPersistence(fileURL: base.appendingPathComponent(bundleId ?? "com.winter.app", isDirectory: true)
            .appendingPathComponent("Island", isDirectory: true)
            .appendingPathComponent("shelf.json"))
    }

    func load() -> [IslandShelfItem] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.items ?? []
    }

    func save(_ items: [IslandShelfItem]) {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(Envelope(version: 1, items: items))
            try data.write(to: fileURL, options: .atomic)
        } catch {
            NSLog("[Island] shelf: could not save its list: %@", String(describing: error))
        }
    }

    private struct Envelope: Codable {
        let version: Int
        let items: [IslandShelfItem]
    }
}

/// The bookmark side, pure apart from the file system's own reads.
enum IslandShelfBookmarks {
    /// A bookmark for an existing file (nil for one that is not there).
    static func make(for url: URL) -> Data? {
        guard url.isFileURL, FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try? url.bookmarkData(options: [], includingResourceValuesForKeys: [.nameKey], relativeTo: nil)
    }

    /// Where the bookmark points now (following a move or rename), or nil when the file is gone. Never mounts a
    /// volume and never shows UI. `refreshed` is new bookmark data when the old one went stale.
    static func resolve(_ bookmark: Data) -> (url: URL, refreshed: Data?)? {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting],
                                 relativeTo: nil, bookmarkDataIsStale: &stale),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        // A file in the Trash is gone as far as the shelf is concerned.
        if url.pathComponents.contains(".Trash") { return nil }
        return (url, stale ? make(for: url) : nil)
    }

    /// PURE: is this path inside the screenshot tool's temporary folder (the floating thumbnail's file)?
    static func isScreenshotTemporary(_ path: String) -> Bool {
        path.contains("/NSIRD_screencaptureui_") || path.contains("/screencaptureui")
    }

    /// The folder screenshots are saved to (`com.apple.screencapture` `location`, else the Desktop). Reading only.
    static func screenshotFolder() -> URL {
        if let location = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location"), !location.isEmpty {
            return URL(fileURLWithPath: (location as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop", isDirectory: true)
    }

    /// A screenshot whose temporary file is gone: the same name in the screenshot folder, if one is there.
    static func screenshotFallback(lastPath: String, folder: URL = screenshotFolder()) -> URL? {
        guard isScreenshotTemporary(lastPath) else { return nil }
        let candidate = folder.appendingPathComponent((lastPath as NSString).lastPathComponent)
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }
}

/// The shelf's state. Main-actor; the persistence and the screenshot folder are injected (`IslandShelfTests`).
@MainActor
final class IslandShelfStore: ObservableObject {
    @Published private(set) var items: [IslandShelfItem] = []
    /// Each item's current place, refreshed by `resolveAll()` (the island resolves when the Shelf is shown).
    @Published private(set) var resolutions: [String: IslandShelfResolution] = [:]
    /// The selected item (⌘C copies it).
    @Published var selectedId: String?
    /// A drag with files is over the island.
    @Published var dropTargeted = false
    /// Told when the user selects an item (the island then takes the keyboard, so ⌘C reaches it).
    var onSelect: (() -> Void)?

    /// Most items kept (the oldest goes first).
    static let maxItems = 60

    private let persistence: IslandShelfPersistence
    var screenshotFolder: () -> URL = { IslandShelfBookmarks.screenshotFolder() }
    var now: () -> Date = { Date() }
    private var loaded = false

    init(persistence: IslandShelfPersistence) {
        self.persistence = persistence
    }

    /// Reads the list once (lazily, on first use: nothing is read at launch).
    func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        items = persistence.load()
    }

    /// Adds dropped files (file URLs only; a folder counts as a file). Already shelved files move to the front.
    /// Returns how many were added. Nothing is copied: only a bookmark and the path are kept.
    @discardableResult
    func add(_ urls: [URL]) -> Int {
        loadIfNeeded()
        var added = 0
        for url in urls where url.isFileURL {
            let standard = url.standardizedFileURL
            guard let bookmark = IslandShelfBookmarks.make(for: standard) else { continue }
            if let existing = items.firstIndex(where: { currentPath(of: $0) == standard.path }) {
                let item = items.remove(at: existing)
                items.insert(item, at: 0)
                continue
            }
            let item = IslandShelfItem(id: UUID().uuidString, bookmark: bookmark, lastPath: standard.path, addedAt: now())
            items.insert(item, at: 0)
            resolutions[item.id] = .present(standard)
            added += 1
        }
        if items.count > Self.maxItems {
            for gone in items[Self.maxItems...] { resolutions[gone.id] = nil }
            items.removeLast(items.count - Self.maxItems)
        }
        persistence.save(items)
        return added
    }

    /// A click on a tile.
    func select(_ id: String) {
        selectedId = id
        onSelect?()
    }

    /// ⌘C: the selected item's file URL onto the pasteboard.
    @discardableResult
    func copySelected(to pasteboard: NSPasteboard = .general) -> Bool {
        guard let id = selectedId else { return false }
        return copy(id, to: pasteboard)
    }

    /// Takes an item off the shelf. The file itself is never touched.
    func remove(_ id: String) {
        items.removeAll { $0.id == id }
        resolutions[id] = nil
        if selectedId == id { selectedId = nil }
        persistence.save(items)
    }

    /// Resolves every bookmark: a moved or renamed file updates its path (and a stale bookmark is refreshed); a file
    /// that is gone is `missing`. Saves only when something changed.
    func resolveAll() {
        loadIfNeeded()
        var changed = false
        var next: [String: IslandShelfResolution] = [:]
        for i in items.indices {
            let item = items[i]
            if let (resolved, refreshed) = IslandShelfBookmarks.resolve(item.bookmark) {
                // The same place spelled through a symlink (`/var` → `/private/var`) keeps the path the user dropped.
                let known = URL(fileURLWithPath: item.lastPath)
                let same = known.resolvingSymlinksInPath().path == resolved.resolvingSymlinksInPath().path
                let url = same ? known : resolved
                next[item.id] = .present(url)
                if !same { items[i].lastPath = resolved.path; changed = true }
                if let refreshed { items[i].bookmark = refreshed; changed = true }
            } else if let found = IslandShelfBookmarks.screenshotFallback(lastPath: item.lastPath, folder: screenshotFolder()),
                      let bookmark = IslandShelfBookmarks.make(for: found) {
                next[item.id] = .present(found)
                items[i].lastPath = found.path
                items[i].bookmark = bookmark
                changed = true
            } else {
                next[item.id] = .missing
            }
        }
        resolutions = next
        if changed { persistence.save(items) }
    }

    func resolution(of id: String) -> IslandShelfResolution {
        resolutions[id] ?? .missing
    }

    /// The file URL to hand out (drag, open, copy), or nil while missing.
    func url(of id: String) -> URL? {
        if case .present(let url)? = resolutions[id] { return url }
        return nil
    }

    private func currentPath(of item: IslandShelfItem) -> String {
        if case .present(let url)? = resolutions[item.id] { return url.path }
        return item.lastPath
    }

    /// COPY: the file's URL onto `pasteboard` — only on the user's explicit action (the button, the menu, ⌘C).
    @discardableResult
    func copy(_ id: String, to pasteboard: NSPasteboard = .general) -> Bool {
        guard let url = url(of: id) else { return false }
        pasteboard.clearContents()
        return pasteboard.writeObjects([url as NSURL])
    }

    /// Opens the file with its default app.
    func open(_ id: String, with workspace: NSWorkspace = .shared) {
        guard let url = url(of: id) else { return }
        workspace.open(url)
    }
}

/// Icon previews: QuickLook thumbnails, the workspace icon until (or unless) one arrives. Generated lazily — only for
/// an item drawn on screen — and cached in memory only, by path.
@MainActor
final class IslandShelfThumbnails: ObservableObject {
    @Published private(set) var images: [String: NSImage] = [:]
    private var asked: Set<String> = []
    private let cache = NSCache<NSString, NSImage>()

    func image(for url: URL) -> NSImage {
        if let image = images[url.path] ?? cache.object(forKey: url.path as NSString) { return image }
        return NSWorkspace.shared.icon(forFile: url.path)
    }

    /// Asks QuickLook once per path (no-op after).
    func request(_ url: URL, size: CGFloat = 44) {
        guard asked.insert(url.path).inserted else { return }
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: size, height: size), scale: scale,
                                                   representationTypes: .thumbnail)
        let path = url.path
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self] rep, _ in
            guard let image = rep?.nsImage else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.cache.setObject(image, forKey: path as NSString)
                    self?.images[path] = image
                }
            }
        }
    }
}
