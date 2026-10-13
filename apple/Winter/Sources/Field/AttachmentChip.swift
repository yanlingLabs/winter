import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

// MARK: - The attachment chip (2026-10-13)
//
// ONE chip for every attachment, in the composer's strip and in the sent message's bubble: the same shape,
// height, padding, corner radius and hover ×. An IMAGE shows a small thumbnail where a FILE shows its system
// icon; both show a name (the file's own, or "Image #n" for pasted data with none). The thumbnail is ImageIO's
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

/// The chip itself. `onRemove` nil (a sent message) shows no ×.
struct AttachmentChip: View {
    let model: AttachmentChipModel
    var onRemove: (() -> Void)? = nil

    @State private var thumbnail: NSImage?
    @State private var fileIcon: NSImage?
    @State private var unreadable = false
    @State private var isHovered = false

    private var shownName: String {
        if case .image(_, let fallback) = model.visual, unreadable { return fallback }
        return model.name
    }

    var body: some View {
        HStack(spacing: 7) {
            leading
                .frame(width: AttachmentChipMetrics.thumbnailSide, height: AttachmentChipMetrics.thumbnailSide)
            Text(shownName)
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: AttachmentChipMetrics.nameMaxWidth, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.leading, 4)
        .padding(.trailing, 10)
        .frame(height: AttachmentChipMetrics.height)
        .background(Theme.elevatedSurface, in: RoundedRectangle(cornerRadius: AttachmentChipMetrics.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AttachmentChipMetrics.cornerRadius, style: .continuous)
                .strokeBorder(Theme.hairlineElevated, lineWidth: 0.5)
        )
        .overlay(alignment: .topTrailing) {
            if let onRemove, isHovered {
                removeButton(onRemove)
                    .offset(x: 6, y: -6)
                    .transition(.opacity)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { isHovered = hovering } }
        .help(model.visual.helpPath ?? shownName)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .task(id: model.visual) { await loadThumbnail() }
    }

    @ViewBuilder
    private var leading: some View {
        switch model.visual {
        case .image:
            if let thumbnail {
                Image(nsImage: thumbnail)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: AttachmentChipMetrics.thumbnailSide, height: AttachmentChipMetrics.thumbnailSide)
                    .clipShape(RoundedRectangle(cornerRadius: AttachmentChipMetrics.thumbnailCornerRadius, style: .continuous))
            } else {
                // Loading, or unreadable: the neutral photo glyph on the thumbnail's own square.
                RoundedRectangle(cornerRadius: AttachmentChipMetrics.thumbnailCornerRadius, style: .continuous)
                    .fill(Theme.controlSurface)
                    .overlay(
                        Image(systemName: "photo")
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                    )
            }
        case .file:
            if let fileIcon {
                Image(nsImage: fileIcon)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: "doc")
                    .font(Typography.body())
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    private func removeButton(_ onRemove: @escaping () -> Void) -> some View {
        Button(action: onRemove) {
            Image(systemName: "xmark")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(Theme.canvas)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Theme.textPrimary))
                .overlay(Circle().strokeBorder(Theme.canvas, lineWidth: 1.5))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help("Remove \(shownName)")
        .accessibilityLabel("Remove \(shownName)")
    }

    private var accessibilityLabel: String {
        switch model.visual {
        case .image: return "Image attachment, \(shownName)"
        case .file: return "File attachment, \(shownName)"
        }
    }

    private func loadThumbnail() async {
        if case .file(let path) = model.visual {
            // Looked up once per chip (the transcript re-renders on every streamed chunk), never in `body`.
            fileIcon = await AttachmentThumbnails.fileIcon(path)
            return
        }
        guard case .image(let source, _) = model.visual else { return }
        if let hit = AttachmentThumbnails.cached(source) {
            thumbnail = hit
            unreadable = false
            return
        }
        thumbnail = nil
        let image = await AttachmentThumbnails.load(source)
        guard !Task.isCancelled else { return }
        thumbnail = image
        unreadable = image == nil
    }
}

private extension AttachmentChipModel.Visual {
    /// The full path, for the hover tooltip — a FILE's, or an image FILE's (never pasted data's).
    var helpPath: String? {
        switch self {
        case .file(let path): return path
        case .image(.path(let path), _): return path
        case .image: return nil
        }
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

/// The composer's chips for a draft, in strip order. Pasted data is named by the number its placeholder will
/// carry ("Image #2"); a file by its own name.
func composerChipModels(_ draft: ComposerAttachmentDraft) -> [AttachmentChipModel] {
    let numbers = draft.placeholderNumbers
    return draft.items.map { item in
        let n = numbers[item.id] ?? 0
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
}

/// The composer's strip: its chips in one row, scrolling sideways when they outrun the composer. Room is left
/// above and to the right of each chip for its hover × (which sits on the chip's corner).
struct ComposerAttachmentStrip: View {
    let chips: [AttachmentChipModel]
    let onRemove: (AttachmentChipModel) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips) { chip in
                    AttachmentChip(model: chip, onRemove: { onRemove(chip) })
                }
            }
            .padding(.top, 8)
            .padding(.trailing, 8)
        }
        .scrollClipDisabled()
    }
}
