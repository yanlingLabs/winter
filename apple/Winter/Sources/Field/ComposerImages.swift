import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import WinterKit
import WinterProtocol

// MARK: - Code-mode image input (2026-09-29; raw image paths 2026-10-10)
//
// In a CODE session, pasting image data or an image file, or dropping image files, onto the composer
// adds an attachment to the draft and inserts the plain-text placeholder `[Image #n]` (n counts per
// draft from 1 and is never reused within it). There are two kinds of attachment, and neither is ever
// resized or copied by default (the runtime's Read tool prepares any image for the model itself):
//
//   - a FILE (a Finder drag, a dropped file, a file copied in Finder): the ORIGINAL file's path. It is
//     never read beyond its first few bytes, never copied and never staged — the path itself rides in
//     `images`, and the daemon checks it (an absolute path to a regular image file of at most 64 MiB,
//     outside its home);
//   - DATA with no file (a screenshot or image on the clipboard): the RAW bytes, written by
//     `session.stageImage` into the session's own temp directory at submit. Only an image whose bytes
//     cannot fit one request line (`composerImageMaxBytes`) is downscaled, and only that one.
//
// The text is sent WITH its placeholders (the user's message shows `[Image #n]`) and `images` names each
// one's path; the daemon gives the MODEL the text with the paths in place. A daemon whose stage answer
// lacks `imagesOnSend` (it would silently drop `images`) is sent the paths substituted into the text
// instead, as before. A placeholder the user deleted is never sent. Every other mode keeps today's
// behaviour: the intake answers "not handled" and AppKit's own paste/drop runs.
//
// Everything here is pure (or reads only a pasteboard handed to it), so the rules are unit-tested
// without a view (`ComposerImagesTests`).

/// The exact refusal the user sees when the selected model's catalog row takes no image — the
/// daemon's `image_input_unsupported` message, word for word.
let composerImageUnsupportedMessage = "The selected model doesn't support images"

/// The most a STAGED image may weigh — `STAGE_IMAGE_MAX_BYTES`: the raw size whose base64 fills one
/// request line (the daemon's 8 MiB NDJSON line cap) less 256 KiB of headroom. Hand-mirrored; the
/// protocol constant is the source (`packages/protocol/src/methods.ts`).
let composerImageMaxBytes = 6_094_848

/// The most an original image FILE may weigh — `IMAGE_FILE_MAX_BYTES`, the runtime Read tool's own 64 MiB.
let composerImageFileMaxBytes = 64 * 1024 * 1024

/// Shown for staged image data past `composerImageMaxBytes` even after the downscale — the daemon's
/// `image_too_large` refusal wording (`IMAGE_TOO_LARGE_MESSAGE`).
let composerImageTooLargeMessage = "The image is too large to attach"

/// Shown for an image FILE past `composerImageFileMaxBytes` (`IMAGE_FILE_TOO_LARGE_MESSAGE`).
let composerImageFileTooLargeMessage = "Image files must be 64 MB or smaller"

/// Shown when a dropped file vanished or stopped being a plain file between the drop and the attach.
let composerImageFileUnreadableMessage = "That image file could not be read"

/// Image DATA with no file of its own: its bytes and the media type those bytes ARE (sniffed, never
/// guessed from a name — the daemon refuses a declared type the bytes disagree with).
struct ComposerImageData: Equatable {
    let data: Data
    let mediaType: String
}

/// One attached image: the user's own FILE (its path is what the model is given), or image DATA that
/// has no file (staged raw at submit).
enum ComposerImage: Equatable {
    case file(path: String)
    case data(ComposerImageData)

    init(data: Data, mediaType: String) { self = .data(ComposerImageData(data: data, mediaType: mediaType)) }

    /// The staged half, or `nil` for a file.
    var imageData: ComposerImageData? {
        if case .data(let data) = self { return data }
        return nil
    }

    /// The original file's path, or `nil` for image data.
    var filePath: String? {
        if case .file(let path) = self { return path }
        return nil
    }
}

/// The media type the magic bytes name — one of the seven the runtime Read tool prepares: png, jpeg,
/// gif, webp, heic, tiff or bmp — or `nil` for anything else. A port of the daemon's
/// `sniffImageMediaType` (itself the runtime's `sniffImageType`): keep the three equal.
func composerImageMediaType(of data: Data) -> String? {
    let b = [UInt8](data.prefix(12))
    func starts(_ p: [UInt8], at i: Int = 0) -> Bool { b.count >= i + p.count && Array(b[i..<(i + p.count)]) == p }
    if starts([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
    if starts([0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    if starts(Array("GIF87a".utf8)) || starts(Array("GIF89a".utf8)) { return "image/gif" }
    if starts(Array("RIFF".utf8)) && starts(Array("WEBP".utf8), at: 8) { return "image/webp" }
    if starts(Array("BM".utf8)) { return "image/bmp" }
    if starts([0x49, 0x49, 0x2A, 0x00]) || starts([0x4D, 0x4D, 0x00, 0x2A]) { return "image/tiff" }
    if b.count >= 12 && starts(Array("ftyp".utf8), at: 4),
       let brand = String(bytes: b[8..<12], encoding: .ascii),
       ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].contains(brand) {
        return "image/heic"
    }
    return nil
}

/// The long edge an image is downscaled to WHEN IT CANNOT FIT `composerImageMaxBytes` — Anthropic's
/// documented size above which the service downscales anyway, so nothing the model could see is lost
/// (`IMAGE_ATTACH_MAX_LONG_EDGE`).
let composerImageMaxLongEdge = 1568

/// JPEG qualities tried, in order, when an image is still over the cap after the downscale.
private let composerJPEGQualities: [Double] = [0.85, 0.75, 0.65, 0.5]

/// Image DATA (a screenshot or image on the pasteboard — it has no file of its own) as an attachment,
/// decided ONCE, when attached — a submit never re-encodes. Data of one of the seven types that fits
/// one request (`composerImageMaxBytes`) is kept BYTE FOR BYTE, however big the picture: no decode, no
/// resize, no re-encode — the runtime's Read tool prepares it for the model. Anything else is the
/// over-budget fallback (`composerDownscaledImage`) for this one image. `nil` when the bytes are not
/// an image at all.
func composerImage(fromImageData data: Data) -> ComposerImage? {
    if let sniffed = composerImageMediaType(of: data), data.count <= composerImageMaxBytes {
        return ComposerImage(data: data, mediaType: sniffed)
    }
    return composerDownscaledImage(fromImageData: data)
}

/// The OVER-BUDGET fallback: bytes that cannot be staged as they are (more than `composerImageMaxBytes`,
/// or a type the daemon does not sniff — e.g. a pasteboard format ImageIO can still read) are rendered
/// through ImageIO — `CGImageSourceCreateThumbnailAtIndex`, long edge at most 1568, orientation
/// applied — and encoded as PNG (a JPEG stays JPEG; a GIF becomes a PNG of its first frame). If that is
/// still over the cap it is re-encoded as JPEG, quality stepping 0.85 → 0.5 (transparency flattened
/// onto white). What comes back may still exceed the cap only when nothing fits; the attach gate then
/// refuses it with `composerImageTooLargeMessage`. `nil` when the bytes are not an image at all.
func composerDownscaledImage(fromImageData data: Data) -> ComposerImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let width = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
    let height = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
    let longEdge = max(width, height)
    let sniffed = composerImageMediaType(of: data)
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: longEdge > 0 ? min(longEdge, composerImageMaxLongEdge) : composerImageMaxLongEdge,
    ]
    guard let rendered = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    let keepsJPEG = sniffed == "image/jpeg"
    var last: ComposerImage?
    if !keepsJPEG, let png = composerEncode(rendered, as: .png, quality: nil) {
        last = ComposerImage(data: png, mediaType: "image/png")
        if png.count <= composerImageMaxBytes { return last }
    }
    let opaque = composerFlattenedOnWhite(rendered) ?? rendered
    for quality in composerJPEGQualities {
        guard let jpeg = composerEncode(opaque, as: .jpeg, quality: quality) else { continue }
        last = ComposerImage(data: jpeg, mediaType: "image/jpeg")
        if jpeg.count <= composerImageMaxBytes { return last }
    }
    return last
}

/// A regular file's size, FOLLOWING symlinks (the daemon judges the target too); `nil` for a missing path,
/// a directory, a FIFO or anything else that is not a plain file.
func composerRegularFileSize(_ path: String) -> Int? {
    var info = stat()
    guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
    return Int(info.st_size)
}

/// An image FILE as an attachment: its ORIGINAL path, with nothing read beyond its first 12 bytes — a
/// plain file whose magic bytes are one of the seven types (never its name: an SVG or a corrupt file
/// hands the whole paste back to AppKit, which types the path). `nil` otherwise. The size is the attach
/// gate's business (`composerImageFileMaxBytes`).
func composerImage(fromFile url: URL) -> ComposerImage? {
    // A file-REFERENCE url (`/.file/id=…`, which some apps put on a pasteboard) is turned into its path first.
    let path = (url as NSURL).filePathURL?.path ?? url.path
    guard composerRegularFileSize(path) != nil,
          let handle = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? handle.close() }
    guard let header = try? handle.read(upToCount: 12), composerImageMediaType(of: header) != nil else { return nil }
    return ComposerImage.file(path: path)
}

/// One CGImage encoded as `type` through ImageIO.
func composerEncode(_ image: CGImage, as type: UTType, quality: Double?) -> Data? {
    let out = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
    var properties: [CFString: Any] = [:]
    if let quality { properties[kCGImageDestinationLossyCompressionQuality] = quality }
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return out as Data
}

/// JPEG has no alpha: composite onto white first, so transparent areas do not turn black.
private func composerFlattenedOnWhite(_ image: CGImage) -> CGImage? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(rect)
    context.draw(image, in: rect)
    return context.makeImage()
}

/// Whether a file URL names an image by its type — the gate for treating a pasted/dropped file as an
/// attachment rather than letting AppKit insert its path.
func composerURLIsImage(_ url: URL) -> Bool {
    guard url.isFileURL, let type = UTType(filenameExtension: url.pathExtension) else { return false }
    return type.conforms(to: .image)
}

/// Whether a pasteboard string is TEXT the user meant to paste — anything but a lone URL. Office and
/// iWork apps put an image rendering of copied cells or text beside the text itself, and that paste
/// must stay text; a browser's "Copy Image" can put the image's own URL beside its bytes, and that
/// paste is the image.
func composerStringIsPastedText(_ string: String) -> Bool {
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if trimmed.contains(where: { $0.isWhitespace }) { return true }
    guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return true }
    return !["http", "https", "file"].contains(scheme)
}

/// Which image source a pasteboard offers, decided from its TYPES and file names only — never its
/// bytes — so a drag's per-mouse-move check and ⌘V's menu validation stay cheap.
private enum ComposerImageSource {
    case files([URL])
    case data(NSPasteboard.PasteboardType)
}

private func composerImageSource(on pasteboard: NSPasteboard) -> ComposerImageSource? {
    let urls = (pasteboard.readObjects(forClasses: [NSURL.self],
                                       options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    if !urls.isEmpty {
        // File URLs decide alone: a Finder copy puts the file's ICON beside its URL, and reading image
        // data there would attach an icon. Any non-image file hands the whole paste back to AppKit
        // (it inserts paths, exactly as before).
        return urls.allSatisfy(composerURLIsImage) ? .files(urls) : nil
    }
    if let text = pasteboard.string(forType: .string), composerStringIsPastedText(text) { return nil }
    if let type = pasteboard.availableType(from: [.png, .tiff]) { return .data(type) }
    return nil
}

/// Whether a pasteboard carries an image the composer would take — the cheap, types-only answer
/// for Edit ▸ Paste's enablement and a drag's hover feedback.
func composerPasteboardMayHaveImage(_ pasteboard: NSPasteboard) -> Bool {
    composerImageSource(on: pasteboard) != nil
}

/// The images a pasteboard carries, or `nil` when it carries none (or any of them is not one) — `nil`
/// hands the paste/drop back to AppKit untouched. Image FILES (a Finder drag or copy) come back as their
/// ORIGINAL paths, checked by their first bytes only (`composerImage(fromFile:)`); with no file URLs,
/// PNG data wins over TIFF and comes back RAW (`composerImage(fromImageData:)`); text beside the image
/// (see `composerStringIsPastedText`) keeps the paste text.
func composerImages(from pasteboard: NSPasteboard) -> [ComposerImage]? {
    switch composerImageSource(on: pasteboard) {
    case nil:
        return nil
    case .files(let urls):
        // Every file must BE an image by its bytes, not merely be typed as one: an SVG conforms to
        // `.image` but is no raster, and a corrupt file is nothing. Any such file hands the whole paste
        // back to AppKit (which inserts the paths) rather than silently doing nothing.
        let images = urls.compactMap(composerImage(fromFile:))
        return images.count == urls.count ? images : nil
    case .data(let type):
        return pasteboard.data(forType: type).flatMap(composerImage(fromImageData:)).map { [$0] }
    }
}

/// One draft's attachments.
struct ComposerImageDraft: Equatable {
    private(set) var images: [Int: ComposerImage] = [:]
    private(set) var nextNumber = 1

    static func token(_ n: Int) -> String { "[Image #\(n)]" }

    var isEmpty: Bool { images.isEmpty }

    /// Adds an image and answers its number. Numbers climb for the draft's whole life: a deleted
    /// placeholder's number is never reused, so ⌘Z bringing it back still finds its image. `draftText`
    /// is the draft as it stands: the number also lands past every `[Image #n]` already WRITTEN in it,
    /// so a placeholder that came back after the attachments were reset (⌘Z past a send, a pasted old
    /// message) never binds to a different, newly attached image — it stays literal text.
    mutating func add(_ image: ComposerImage, draftText: String = "") -> Int {
        let n = max(nextNumber, (composerImageTokenNumbers(in: draftText).max() ?? 0) + 1)
        nextNumber = n + 1
        images[n] = image
        return n
    }

    /// Drops these attachments (a sent message's), keeping every other one and the counter.
    mutating func remove(_ numbers: [Int]) {
        for n in numbers { images[n] = nil }
    }

    /// The attachments `text` still references, first-appearance order, each once.
    func referencedNumbers(in text: String) -> [Int] {
        composerImageTokenNumbers(in: text).filter { images[$0] != nil }
    }
}

private let composerImageTokenRegex = try! NSRegularExpression(pattern: #"\[Image #(\d+)\]"#)

/// Every `[Image #n]` number in `text`, first-appearance order, each once.
func composerImageTokenNumbers(in text: String) -> [Int] {
    let ns = text as NSString
    var seen: [Int] = []
    for m in composerImageTokenRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        if let n = Int(ns.substring(with: m.range(at: 1))), !seen.contains(n) { seen.append(n) }
    }
    return seen
}

/// `text` with each placeholder `paths` knows replaced by its path; any other placeholder is left as typed.
func substituteComposerImageTokens(_ text: String, paths: [Int: String]) -> String {
    let ns = text as NSString
    var out = ""
    var cursor = 0
    for m in composerImageTokenRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        guard let n = Int(ns.substring(with: m.range(at: 1))), let path = paths[n] else { continue }
        out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
        out += path
        cursor = m.range.location + m.range.length
    }
    out += ns.substring(from: cursor)
    return out
}

/// At most this many images ride one message (`USER_MESSAGE_IMAGES_MAX`); a draft referencing more
/// is refused before anything is staged — the daemon would refuse the send after the files were written.
let composerImagesPerMessageMax = 20
/// The daemon's own sentence for that refusal (`USER_MESSAGE_IMAGES_MAX_MESSAGE`).
let composerImagesPerMessageMaxMessage = "A message can carry at most 20 images"

/// `resolveComposerImages`' own refusal (the per-message cap), shown on the composer's notice line.
struct ComposerImagesRefusal: Error, Equatable {
    let message: String
}

/// What a code-mode submit sends: `session.send`/`session.steer`'s `text` and `images`.
struct ComposerOutgoing: Equatable {
    let text: String
    let images: [SessionEvent.UserMessageImageRef]
}

/// **The one submit-time helper** every code-mode submit site goes through: resolve each attachment the
/// text still references into the path the model is given, in order. A FILE is its own path — nothing is
/// staged; DATA is staged raw (`stage` is `session.stageImage` for that session). When every stage
/// answered `imagesOnSend` (trivially so when nothing was staged — a draft of files alone assumes a daemon
/// that, being able to take an original path at all, takes `images`), the text goes as written
/// (placeholders kept) with `images` naming each path; otherwise (an older daemon) each placeholder is
/// replaced by its path in the text and `images` is empty. The first refusal throws — the caller sends
/// nothing. A text with no live placeholder comes back unchanged, with no images, and stages nothing.
func resolveComposerImages(_ text: String, draft: ComposerImageDraft,
                           stage: (ComposerImageData) async throws -> StagedImage) async throws -> ComposerOutgoing {
    var refs: [SessionEvent.UserMessageImageRef] = []
    var imagesOnSend = true
    let referenced = draft.referencedNumbers(in: text)
    if referenced.count > composerImagesPerMessageMax {
        throw ComposerImagesRefusal(message: composerImagesPerMessageMaxMessage)
    }
    for n in referenced {
        guard let image = draft.images[n] else { continue }
        switch image {
        case .file(let path):
            refs.append(SessionEvent.UserMessageImageRef(n: n, path: path))
        case .data(let data):
            let staged = try await stage(data)
            refs.append(SessionEvent.UserMessageImageRef(n: n, path: staged.path))
            if !staged.imagesOnSend { imagesOnSend = false }
        }
    }
    if refs.isEmpty || imagesOnSend { return ComposerOutgoing(text: text, images: refs) }
    let paths = Dictionary(uniqueKeysWithValues: refs.map { ($0.n, $0.path) })
    return ComposerOutgoing(text: substituteComposerImageTokens(text, paths: paths), images: [])
}

/// Whether a session takes composer images at all: a CODE session only (an absent mode is code), and
/// FAIL-CLOSED on a row not loaded yet — no row, no intake, AppKit's paste runs.
func composerImageInputEnabled(row: SessionSummary?) -> Bool {
    guard let row else { return false }
    return row.mode == nil || row.mode == "code"
}

/// Whether the model in force accepts images, per the synced catalogue. A model the catalogue does
/// not list (or an empty catalogue) is NOT refused here — the daemon is the authority and refuses at
/// submit when it truly is text-only (`session.stageImage` for data; `session.send`/`session.steer` for
/// any attachment, which is the only door a file passes through — a file is never staged).
func composerModelAcceptsImages(model: String?, catalogue: SyncConfigSnapshot) -> Bool {
    guard let model, let row = catalogue.models.first(where: { $0.id == model }) else { return true }
    return row.supportsImages
}

/// What a composer surface hands `ComposerTextView` so its paste/drop can take images.
struct ComposerImageIntake {
    /// Read at paste/drop time: `false` (not a code session) leaves AppKit's own behaviour untouched.
    let isEnabled: () -> Bool
    /// Attach one image: the placeholder to insert, or `nil` when it was refused (the surface has
    /// already shown why, in its composer notice line).
    let attach: (ComposerImage) -> String?
}
