import AppKit
import ImageIO
import SwiftUI

// MARK: - Transcript file links (2026-09-30): the image viewer
//
// A `.code` tab whose path is a raster image (`panelCodeTabShowsImage`, `PanelEditorTab.swift`)
// renders THIS instead of the editor viewport — `panelTabContent(for:)` branches before the editor
// registry is ever consulted. Nothing here speaks to the daemon, the editor runtime or CEF: the file
// is read straight off disk through ImageIO, downsampled off the main thread, and cached.

/// The largest edge, in pixels, the viewer decodes an image at. A 50 MP photo decoded at full size
/// is ~200 MB of bitmap for a panel a few hundred points wide; 4096 px keeps a retina "actual size"
/// view sharp for anything a screenshot or a generated asset realistically is, and bounds the rest.
let panelImageViewerMaxPixelSize = 4096

/// What loading one image produced. `notFound`/`unreadable` map onto the editor's own failure
/// states (`EditorOpenFailure`) so the viewer says the same sentence the editor would.
enum DownsampledImageResult {
    case loaded(image: NSImage, originalPixelSize: CGSize)
    case notFound
    case unreadable(reason: String)
}

/// **The one ImageIO door** — the viewer tab and the transcript's thumbnails both load through it,
/// so "never decode a huge image on the main thread, never decode it at full size" is one rule.
///
/// Cached by (path, max size) in an `NSCache` (thread-safe, evicts under memory pressure). Each
/// entry remembers the file's modification date and size: `cached(…)` answers synchronously and may
/// be stale (it exists so a recycled transcript row or a revisited tab draws its image on the first
/// frame instead of popping in); `load(…)` re-validates against the file and re-decodes when it moved.
enum DownsampledImageLoader {
    private final class Entry {
        let image: NSImage
        let originalPixelSize: CGSize
        let modified: Date?
        let byteSize: Int?
        init(image: NSImage, originalPixelSize: CGSize, modified: Date?, byteSize: Int?) {
            self.image = image
            self.originalPixelSize = originalPixelSize
            self.modified = modified
            self.byteSize = byteSize
        }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 128
        return cache
    }()

    private static func key(_ path: String, _ maxPixelSize: Int) -> NSString {
        "\(maxPixelSize)|\(path)" as NSString
    }

    /// The last decode of this path at this size, if any — possibly stale. Never touches disk.
    static func cached(path: String, maxPixelSize: Int) -> DownsampledImageResult? {
        guard let entry = cache.object(forKey: key(path, maxPixelSize)) else { return nil }
        return .loaded(image: entry.image, originalPixelSize: entry.originalPixelSize)
    }

    /// Stat, and decode unless the cache already holds this exact file version. Off the main thread.
    static func load(path: String, maxPixelSize: Int) async -> DownsampledImageResult {
        await Task.detached(priority: .userInitiated) {
            loadSynchronously(path: path, maxPixelSize: maxPixelSize)
        }.value
    }

    /// The blocking half of `load` — callable from a test directly.
    static func loadSynchronously(path: String, maxPixelSize: Int) -> DownsampledImageResult {
        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        guard let attributes, (attributes[.type] as? FileAttributeType) != .typeDirectory else {
            cache.removeObject(forKey: key(path, maxPixelSize))
            return .notFound
        }
        let modified = attributes[.modificationDate] as? Date
        let byteSize = (attributes[.size] as? NSNumber)?.intValue
        if let entry = cache.object(forKey: key(path, maxPixelSize)),
           entry.modified == modified, entry.byteSize == byteSize {
            return .loaded(image: entry.image, originalPixelSize: entry.originalPixelSize)
        }
        let url = URL(fileURLWithPath: path)
        guard let source = CGImageSourceCreateWithURL(url as CFURL,
                                                      [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0 else {
            return .unreadable(reason: "It isn't an image this Mac can decode.")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return .unreadable(reason: "It isn't an image this Mac can decode.")
        }
        let original = originalPixelSize(source) ?? CGSize(width: cgImage.width, height: cgImage.height)
        // Points == decoded pixels: the viewer's "actual size" is the decoded bitmap 1:1, Preview's
        // own convention, and the thumbnail frames itself explicitly so its point size is moot.
        let image = NSImage(cgImage: cgImage, size: CGSize(width: cgImage.width, height: cgImage.height))
        cache.setObject(Entry(image: image, originalPixelSize: original, modified: modified,
                              byteSize: byteSize),
                        forKey: key(path, maxPixelSize))
        return .loaded(image: image, originalPixelSize: original)
    }

    /// The source's own pixel size, orientation applied (EXIF 5–8 are the quarter turns).
    private static func originalPixelSize(_ source: CGImageSource) -> CGSize? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue else {
            return nil
        }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return orientation >= 5 ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }

    /// The file's own pixel size from its header alone — no decode. What the chrome captions, read
    /// independently of the content's load so neither waits for (or duplicates) the other's work.
    static func pixelSize(path: String) async -> CGSize? {
        await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                          [kCGImageSourceShouldCache: false] as CFDictionary)
            else { return nil }
            return originalPixelSize(source)
        }.value
    }

    /// Test seam only — the cache is process-global.
    static func removeAllForTesting() { cache.removeAllObjects() }
}

/// PURE: the chrome's size caption — the ORIGINAL pixel dimensions, which is what a person checking
/// "did the agent export this at 2x" wants, not the viewer's capped decode.
func panelImagePixelSizeCaption(_ size: CGSize) -> String {
    "\(Int(size.width.rounded())) × \(Int(size.height.rounded()))"
}

// MARK: - The tab

/// The `.code`-kind tab content for an image path. Stateless — the view owns its load, keyed by
/// path, and the loader's cache is what makes a revisit instant; there is no registry to prune, so
/// neither `closePanelTab` nor the session-change prune needs to know this tab exists.
struct PanelImageTab: PanelTabContent {
    let tab: PanelTab

    var kind: PanelTabKind { .code }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: "photo") }

    func makeChrome() -> AnyView { AnyView(PanelImageChrome(tab: tab)) }
    func makeContent() -> AnyView { AnyView(PanelImageContent(path: tab.url ?? "")) }
}

/// Path, pixel size, and the two ways out of the panel — the editor chrome's own row shape
/// (`PanelEditorChrome`), with nothing to save.
struct PanelImageChrome: View {
    let tab: PanelTab

    @State private var pixelSize: CGSize?

    private var path: String { tab.url ?? "" }

    var body: some View {
        HStack(spacing: panelEditorChromeGap) {
            Text(editorTabDisplayPath(path: tab.url, fallbackTitle: panelTabDisplayTitle(tab)))
                .font(Typography.captionMono())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)

            if let pixelSize {
                Text(panelImagePixelSizeCaption(pixelSize))
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: panelEditorChromeGap)

            ShellTitlebarButton(systemImage: "folder", label: "Show in Finder",
                                size: panelChromeButtonSize) {
                guard !path.isEmpty else { return }
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            }
            ShellTitlebarButton(systemImage: "arrow.up.forward.app", label: "Open in default app",
                                size: panelChromeButtonSize) {
                guard !path.isEmpty else { return }
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            }
        }
        .padding(.horizontal, panelTabPillInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: path) {
            pixelSize = path.isEmpty ? nil : await DownsampledImageLoader.pixelSize(path: path)
        }
    }
}

/// The picture: fitted to the panel (never upscaled past its own size), aspect preserved; a
/// double-click toggles actual size, which scrolls in both directions.
struct PanelImageContent: View {
    let path: String

    @State private var result: DownsampledImageResult?
    @State private var actualSize = false

    /// A synchronous cache hit first, so a revisited tab draws its picture on the first frame.
    private var shown: DownsampledImageResult? {
        result ?? DownsampledImageLoader.cached(path: path, maxPixelSize: panelImageViewerMaxPixelSize)
    }

    var body: some View {
        Group {
            switch shown {
            case .none:
                EditorViewportStateView(state: .booting)
            case .notFound?:
                EditorViewportStateView(state: .openFailed(path: path, failure: .notFound))
            case .unreadable(let reason)?:
                EditorViewportStateView(state: .openFailed(path: path,
                                                           failure: .unreadable(reason: reason)))
            case .loaded(let image, _)?:
                picture(image)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: path) {
            guard !path.isEmpty else {
                result = .notFound
                return
            }
            result = await DownsampledImageLoader.load(path: path,
                                                       maxPixelSize: panelImageViewerMaxPixelSize)
        }
    }

    @ViewBuilder
    private func picture(_ image: NSImage) -> some View {
        if actualSize {
            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .interpolation(.high)
                    .frame(width: image.size.width, height: image.size.height)
                    .padding(panelImageViewerInset)
            }
            .onTapGesture(count: 2) { actualSize = false }
            .help("Double-click to fit the panel")
            .accessibilityLabel("Image, actual size")
        } else {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: image.size.width, maxHeight: image.size.height)
                .padding(panelImageViewerInset)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { actualSize = true }
                .help("Double-click for actual size")
                .accessibilityLabel("Image, fitted to the panel")
        }
    }
}

/// Breathing room between the picture and the panel's edges.
let panelImageViewerInset: CGFloat = 16
