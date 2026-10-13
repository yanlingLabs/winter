import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

// MARK: - The attachment chip (2026-10-13)
//
// ONE chip for every attachment, INLINE in the composer's text and in the sent message's bubble (2026-10-13): the
// same face (`AttachmentChipFace`), rasterised at the size of the line it sits in (`AttachmentChipImages`), with a
// hover × in the composer. An IMAGE shows a small thumbnail where a FILE shows its system icon; both show a name
// (the file's own, or "Image #n" for pasted data with none). The thumbnail is ImageIO's
// (`CGImageSourceCreateThumbnailAtIndex`, downscaled to the chip, the file's embedded thumbnail when it has one),
// made off the main thread and cached; an image that cannot be read any more (a staged temp file since deleted,
// a file macOS withholds) falls back to a neutral photo glyph and "Image #n".

/// What one chip shows. `id` is the view identity (a draft attachment's id, or a message's placeholder).
struct AttachmentChipModel: Identifiable, Equatable {
    enum Visual: Equatable {
        /// An image: its thumbnail comes from `source`; `fallbackName` replaces the name when it cannot be read.
        case image(source: AttachmentThumbnailSource, fallbackName: String)
        /// A file or folder: its system icon.
        case file(path: String)
    }

    let id: String
    let name: String
    let visual: Visual
    /// The draft attachment behind a COMPOSER chip (its × removes that one); `nil` in a sent message.
    var attachmentID: Int? = nil
}

/// Where an image chip's thumbnail comes from — a path, or bytes held in memory (pasted data, not yet staged).
/// Compared by `key` alone, so a re-render never compares megabytes.
enum AttachmentThumbnailSource: Equatable {
    case path(String)
    case data(key: String, bytes: AttachmentImageBytes)

    var key: String {
        switch self {
        case .path(let path): return "path:" + path
        case .data(let key, _): return "data:" + key
        }
    }

    static func == (a: Self, b: Self) -> Bool { a.key == b.key }
}

/// A reference box for image bytes, so the chip model stays cheap to copy and compare.
final class AttachmentImageBytes: @unchecked Sendable {
    let data: Data
    init(_ data: Data) { self.data = data }
}

/// The chip's metrics, written once.
enum AttachmentChipMetrics {
    static let height: CGFloat = 32
    static let cornerRadius: CGFloat = 8
    static let thumbnailSide: CGFloat = 24
    static let thumbnailCornerRadius: CGFloat = 5
    static let nameMaxWidth: CGFloat = 168
    /// The thumbnail's longest edge in PIXELS: the 24 pt square at 2×, with a little room for a crop.
    static let thumbnailPixels = 72
}

/// Thumbnails, made once per source off the main thread and kept in memory (an `NSCache`, so memory
/// pressure can take them back). A source that cannot be read is remembered as such for this run.
@MainActor
enum AttachmentThumbnails {
    private static let cache = NSCache<NSString, NSImage>()
    private static let failed = NSCache<NSString, NSNumber>()

    static func cached(_ source: AttachmentThumbnailSource) -> NSImage? { cache.object(forKey: source.key as NSString) }
    static func knownUnreadable(_ source: AttachmentThumbnailSource) -> Bool { failed.object(forKey: source.key as NSString) != nil }

    /// The thumbnail, or `nil` when the source is no readable image.
    static func load(_ source: AttachmentThumbnailSource) async -> NSImage? {
        if let hit = cached(source) { return hit }
        if knownUnreadable(source) { return nil }
        let key = source.key as NSString
        let made: CGImage? = await Task.detached(priority: .utility) { makeThumbnail(source) }.value
        guard let made else {
            failed.setObject(true, forKey: key)
            return nil
        }
        let image = NSImage(cgImage: made, size: NSSize(width: made.width, height: made.height))
        cache.setObject(image, forKey: key)
        return image
    }

    private static let icons = NSCache<NSString, NSImage>()

    /// A file chip's icon if it is already in memory.
    static func cachedFileIcon(_ path: String) -> NSImage? { icons.object(forKey: path as NSString) }

    /// A file chip's icon, looked up off the main thread once per path and kept.
    static func fileIcon(_ path: String) async -> NSImage {
        if let hit = icons.object(forKey: path as NSString) { return hit }
        let icon = await Task.detached(priority: .utility) { attachmentFileIcon(path) }.value
        icons.setObject(icon, forKey: path as NSString)
        return icon
    }

    /// PURE ImageIO: never a full decode of a big file — the source is opened without caching, the file's own
    /// embedded thumbnail is used when it has one, and otherwise ImageIO decodes at the reduced size directly.
    nonisolated static func makeThumbnail(_ source: AttachmentThumbnailSource, maxPixels: Int = AttachmentChipMetrics.thumbnailPixels) -> CGImage? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        let imageSource: CGImageSource?
        switch source {
        case .path(let path): imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, options)
        case .data(_, let bytes): imageSource = CGImageSourceCreateWithData(bytes.data as CFData, options)
        }
        guard let imageSource, CGImageSourceGetCount(imageSource) > 0 else { return nil }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageIfAbsent: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        return CGImageSourceCreateThumbnailAtIndex(imageSource, 0, thumbOptions as CFDictionary)
    }
}

/// A file's system icon — by its path when it exists, else by its extension's type (a file since moved still
/// shows what KIND it was). Touches the disk: called off the main thread (`AttachmentThumbnails.fileIcon`).
nonisolated func attachmentFileIcon(_ path: String) -> NSImage {
    if FileManager.default.fileExists(atPath: path) { return NSWorkspace.shared.icon(forFile: path) }
    let ext = (path as NSString).pathExtension
    let type = ext.isEmpty ? UTType.data : (UTType(filenameExtension: ext) ?? .data)
    return NSWorkspace.shared.icon(for: type)
}

/// The chip's size, as a value: a free-standing 32 pt chip (`.standard`), or one sized to sit INSIDE a line of
/// text (`inline(for:)`) — the composer's text and the sent bubble's prose.
struct AttachmentChipSize: Equatable, Hashable {
    var height: CGFloat
    var thumbnailSide: CGFloat
    var cornerRadius: CGFloat
    var thumbnailCornerRadius: CGFloat
    var nameMaxWidth: CGFloat
    var nameFontSize: CGFloat
    var leadingPadding: CGFloat
    var trailingPadding: CGFloat
    var spacing: CGFloat

    static let standard = AttachmentChipSize(
        height: AttachmentChipMetrics.height, thumbnailSide: AttachmentChipMetrics.thumbnailSide,
        cornerRadius: AttachmentChipMetrics.cornerRadius, thumbnailCornerRadius: AttachmentChipMetrics.thumbnailCornerRadius,
        nameMaxWidth: AttachmentChipMetrics.nameMaxWidth, nameFontSize: Typography.captionSize,
        leadingPadding: 4, trailingPadding: 10, spacing: 7)

    /// PURE: a chip that fits one line of `font` — as tall as the font's ascender-to-descender box, so a line
    /// holding chips is no taller than one without, and centred on it (`AttachmentChipSize.baselineOffset`).
    static func inline(for font: NSFont) -> AttachmentChipSize {
        let height = ceil(font.ascender - font.descender)
        let side = max(10, height - 4)
        return AttachmentChipSize(height: height, thumbnailSide: side, cornerRadius: min(6, height / 3),
                                  thumbnailCornerRadius: 3, nameMaxWidth: 160,
                                  nameFontSize: max(10, (font.pointSize * 0.8).rounded()),
                                  leadingPadding: 2, trailingPadding: 6, spacing: 4)
    }

    /// PURE: where an inline chip of this size sits against `font`'s baseline: its bottom on the descender, so
    /// it spans exactly the text's own box.
    static func baselineOffset(for font: NSFont) -> CGFloat { font.descender }
}

/// What a chip draws besides its model — the thumbnail or icon `AttachmentThumbnails` loads, which a rasterised
/// chip is rendered with (`AttachmentChipImages`).
struct AttachmentChipArt: Equatable {
    var thumbnail: NSImage?
    var fileIcon: NSImage?
    var unreadable = false
}

/// The chip's face — no state, no loading. ONE drawing for the composer's inline chips and the bubble's (both
/// are this view rasterised, `AttachmentChipImages`).
struct AttachmentChipFace: View {
    let model: AttachmentChipModel
    var size: AttachmentChipSize = .standard
    var art = AttachmentChipArt()
    /// An inline chip's hover: its × drawn INSIDE the chip, at the trailing end (an inline chip has no room
    /// outside itself — the text runs right up to it). The click is the text view's (`CommandTextView`).
    var showsInlineRemove = false

    var shownName: String {
        if case .image(_, let fallback) = model.visual, art.unreadable { return fallback }
        return model.name
    }

    var body: some View {
        HStack(spacing: size.spacing) {
            leading
                .frame(width: size.thumbnailSide, height: size.thumbnailSide)
            Text(shownName)
                .font(Typography.attachmentChip(ofSize: size.nameFontSize, .medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: size.nameMaxWidth, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.leading, size.leadingPadding)
        .padding(.trailing, size.trailingPadding)
        .frame(height: size.height)
        .background(Theme.elevatedSurface, in: RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .strokeBorder(Theme.hairlineElevated, lineWidth: 0.5)
        )
        .overlay(alignment: .trailing) {
            if showsInlineRemove {
                AttachmentChipInlineRemoveGlyph(side: size.height - 4)
                    .padding(.trailing, 2)
            }
        }
    }

    @ViewBuilder
    private var leading: some View {
        switch model.visual {
        case .image:
            if let thumbnail = art.thumbnail {
                Image(nsImage: thumbnail)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size.thumbnailSide, height: size.thumbnailSide)
                    .clipShape(RoundedRectangle(cornerRadius: size.thumbnailCornerRadius, style: .continuous))
            } else {
                // Loading, or unreadable: the neutral photo glyph on the thumbnail's own square.
                RoundedRectangle(cornerRadius: size.thumbnailCornerRadius, style: .continuous)
                    .fill(Theme.controlSurface)
                    .overlay(
                        Image(systemName: "photo")
                            .font(Typography.attachmentChip(ofSize: max(Typography.microSize, size.thumbnailSide * 0.5)))
                            .foregroundStyle(Theme.textMuted)
                    )
            }
        case .file:
            if let fileIcon = art.fileIcon {
                Image(nsImage: fileIcon)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: "doc")
                    .font(Typography.attachmentChip(ofSize: max(Typography.microSize, size.thumbnailSide * 0.6)))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
}

/// The inline chip's ×: a filled disc, inside the chip.
struct AttachmentChipInlineRemoveGlyph: View {
    let side: CGFloat

    var body: some View {
        Image(systemName: "xmark")
            .font(Typography.attachmentChip(ofSize: max(Typography.microSize - 2, side * 0.45), .bold))
            .foregroundStyle(Theme.canvas)
            .frame(width: side, height: side)
            .background(Circle().fill(Theme.textPrimary))
    }
}

/// PURE: where an inline chip's × is, inside a chip drawn in `frame` — the square at its trailing end that
/// `AttachmentChipFace(showsInlineRemove:)` paints (`frame` in the text view's flipped coordinates).
func attachmentChipInlineRemoveRect(in frame: NSRect) -> NSRect {
    let side = max(0, frame.height - 4)
    return NSRect(x: frame.maxX - 2 - side, y: frame.minY + (frame.height - side) / 2, width: side, height: side)
}

/// What VoiceOver says for a chip.
func attachmentChipAccessibilityLabel(_ model: AttachmentChipModel, shownName: String) -> String {
    switch model.visual {
    case .image: return "Image attachment, \(shownName)"
    case .file: return "File attachment, \(shownName)"
    }
}

extension AttachmentThumbnails {
    /// What is already in memory for a chip — synchronous, never touches the disk.
    static func cachedArt(for visual: AttachmentChipModel.Visual) -> AttachmentChipArt? {
        switch visual {
        case .image(let source, _):
            if let hit = cached(source) { return AttachmentChipArt(thumbnail: hit) }
            if knownUnreadable(source) { return AttachmentChipArt(unreadable: true) }
            return nil
        case .file(let path):
            return cachedFileIcon(path).map { AttachmentChipArt(fileIcon: $0) }
        }
    }

    /// A chip's art, loaded off the main thread once per source and kept.
    static func art(for visual: AttachmentChipModel.Visual) async -> AttachmentChipArt {
        if let hit = cachedArt(for: visual) { return hit }
        switch visual {
        case .image(let source, _):
            let image = await load(source)
            return AttachmentChipArt(thumbnail: image, unreadable: image == nil)
        case .file(let path):
            return AttachmentChipArt(fileIcon: await fileIcon(path))
        }
    }
}

// MARK: - Inline chips, rasterised (2026-10-13)
//
// A chip INSIDE a line of text — the composer's (an `NSTextAttachmentCell`, TextKit 1) and the sent bubble's
// (`Text(Image(nsImage:))`) — is `AttachmentChipFace` rendered to an image by SwiftUI's `ImageRenderer`, so there
// is still exactly one chip drawing. Images are kept per (model, size, hover, appearance, art); a chip whose
// thumbnail or icon is still loading draws its placeholder at the SAME size, and `didLoad` tells the owner to
// redraw once the art lands.

@MainActor
enum AttachmentChipImages {
    private static let cache = NSCache<NSString, NSImage>()
    private static var loading = Set<String>()

    private static func key(_ model: AttachmentChipModel, _ size: AttachmentChipSize, hovered: Bool, dark: Bool,
                            art: AttachmentChipArt, scale: CGFloat) -> String {
        let visual: String
        switch model.visual {
        case .image(let source, let fallback): visual = "i|" + source.key + "|" + fallback
        case .file(let path): visual = "f|" + path
        }
        return [visual, model.name, "\(size.hashValue)", hovered ? "h" : "-", dark ? "d" : "l",
                art.thumbnail != nil ? "t" : (art.fileIcon != nil ? "c" : (art.unreadable ? "u" : "-")),
                "\(scale)"].joined(separator: "|")
    }

    /// The chip as an image, sized in points. Never waits: the art in memory now (or the placeholder) is
    /// drawn, and a load is started for what is missing — `didLoad` runs on the main actor when it lands.
    static func image(for model: AttachmentChipModel, size: AttachmentChipSize, hovered: Bool = false,
                      dark: Bool, scale: CGFloat, didLoad: (() -> Void)? = nil) -> NSImage {
        let art = AttachmentThumbnails.cachedArt(for: model.visual)
        if art == nil {
            let loadKey = "\(model.visual)"
            if !loading.contains(loadKey) {
                loading.insert(loadKey)
                Task { @MainActor in
                    _ = await AttachmentThumbnails.art(for: model.visual)
                    loading.remove(loadKey)
                    didLoad?()
                }
            }
        }
        let shown = art ?? AttachmentChipArt()
        let cacheKey = key(model, size, hovered: hovered, dark: dark, art: shown, scale: scale) as NSString
        if let hit = cache.object(forKey: cacheKey) { return hit }
        let renderer = ImageRenderer(content: AttachmentChipFace(model: model, size: size, art: shown,
                                                                 showsInlineRemove: hovered)
            .environment(\.colorScheme, dark ? .dark : .light))
        renderer.scale = scale
        let image = renderer.nsImage ?? NSImage(size: NSSize(width: size.height * 3, height: size.height))
        cache.setObject(image, forKey: cacheKey)
        return image
    }
}

// MARK: - Chip models

/// The name a path shows: its last component ("My Report.pdf", "app").
func attachmentDisplayName(_ path: String) -> String {
    let name = (path as NSString).lastPathComponent
    return name.isEmpty ? path : name
}

/// Whether `path` is one `session.stageImage` wrote (`…/winter-session-<id>/images/image_<k>.<ext>`) — a
/// machine name the user never chose, shown as "Image #n" instead.
func attachmentPathIsStagedImage(_ path: String) -> Bool {
    let url = URL(fileURLWithPath: path)
    let dir = url.deletingLastPathComponent()
    return dir.lastPathComponent == "images"
        && dir.deletingLastPathComponent().lastPathComponent.hasPrefix("winter-session-")
        && url.lastPathComponent.hasPrefix("image_")
}

/// One composer chip: pasted data is named by the number its placeholder will carry ("Image #2"); a file by its
/// own name.
func composerChipModel(_ item: ComposerAttachment, number n: Int) -> AttachmentChipModel {
    switch item.kind {
    case .image(.file(let path)):
        return AttachmentChipModel(id: "a\(item.id)", name: attachmentDisplayName(path),
                                   visual: .image(source: .path(path), fallbackName: "Image #\(n)"), attachmentID: item.id)
    case .image(.data(let data)):
        return AttachmentChipModel(id: "a\(item.id)", name: "Image #\(n)",
                                   visual: .image(source: .data(key: item.key, bytes: AttachmentImageBytes(data.data)),
                                                  fallbackName: "Image #\(n)"), attachmentID: item.id)
    case .file(let path):
        return AttachmentChipModel(id: "a\(item.id)", name: attachmentDisplayName(path), visual: .file(path: path),
                                   attachmentID: item.id)
    }
}

/// The chips `text` holds, in the order they first appear, numbered as they will be sent.
func composerChipModels(_ draft: ComposerAttachmentDraft, text: String) -> [AttachmentChipModel] {
    let numbers = draft.placeholderNumbers(in: text)
    return draft.live(in: text).map { composerChipModel($0, number: numbers[$0.id] ?? 0) }
}
