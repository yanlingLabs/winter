import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import WinterKit
import WinterProtocol

// MARK: - Code-mode image input (2026-09-29)
//
// In a CODE session, pasting image data or an image file, or dropping image files, onto the composer
// adds an attachment to the draft and inserts the plain-text placeholder `[Image #n]` (n counts per
// draft from 1 and is never reused within it). At submit every placeholder still in the text is
// staged with `session.stageImage` — the daemon writes the image into the session's own temp
// directory. The text is sent WITH its placeholders (the user's message shows `[Image #n]`) and
// `images` names each one's staged path; the daemon gives the MODEL the text with the paths in place.
// A daemon whose stage answer lacks `imagesOnSend` (it would silently drop `images`) is sent the
// paths substituted into the text instead, as before. A placeholder the user deleted is never staged. Every other mode keeps today's behaviour: the
// intake answers "not handled" and AppKit's own paste/drop runs.
//
// Everything here is pure (or reads only a pasteboard handed to it), so the rules are unit-tested
// without a view (`ComposerImagesTests`).

/// The exact refusal the user sees when the selected model's catalog row takes no image — the
/// daemon's `image_input_unsupported` message, word for word.
let composerImageUnsupportedMessage = "The selected model doesn't support images"

/// The runtime Read tool's image limit — its `READ_IMAGE_MAX_BYTES` (3.75 MiB, the raw size whose
/// base64 is exactly 5 MiB) — which `session.stageImage` enforces too (`STAGE_IMAGE_MAX_BYTES`).
let composerImageMaxBytes = 3_932_160

/// Shown for an image past `composerImageMaxBytes` — the daemon's `image_too_large` refusal wording.
let composerImageTooLargeMessage = "Images must be 3.75 MB or smaller"

/// One attached image: its bytes and the media type those bytes ARE (sniffed, never guessed from a
/// file name — the daemon refuses a declared type the bytes disagree with).
struct ComposerImage: Equatable {
    let data: Data
    let mediaType: String
}

/// The media type the magic bytes name — png, jpeg, gif or webp, the four the daemon stages — or
/// `nil` for anything else.
func composerImageMediaType(of data: Data) -> String? {
    let b = [UInt8](data.prefix(12))
    func starts(_ p: [UInt8], at i: Int = 0) -> Bool { b.count >= i + p.count && Array(b[i..<(i + p.count)]) == p }
    if starts([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
    if starts([0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    if starts(Array("GIF87a".utf8)) || starts(Array("GIF89a".utf8)) { return "image/gif" }
    if starts(Array("RIFF".utf8)) && starts(Array("WEBP".utf8), at: 8) { return "image/webp" }
    return nil
}

/// The long edge an attached image is downscaled to — Anthropic's documented size above which the
/// service downscales anyway, so nothing the model could see is lost (`IMAGE_ATTACH_MAX_LONG_EDGE`).
let composerImageMaxLongEdge = 1568

/// JPEG qualities tried, in order, when an image is still over the cap after the downscale.
private let composerJPEGQualities: [Double] = [0.85, 0.75, 0.65, 0.5]

/// Bytes as an attachment, prepared ONCE, when attached — a submit never re-encodes.
///
/// One of the four stageable types that is already within `composerImageMaxLongEdge`, within the cap
/// and upright is kept byte for byte. Anything else (a Retina screenshot, TIFF/HEIC/BMP from the
/// pasteboard, a rotated JPEG) is rendered through ImageIO — `CGImageSourceCreateThumbnailAtIndex`,
/// long edge at most 1568, orientation applied — and encoded as PNG (a JPEG stays JPEG; a GIF becomes
/// a PNG of its first frame). If that is still over the cap it is re-encoded as JPEG, quality stepping
/// 0.85 → 0.5 (transparency flattened onto white). What comes back may still exceed the cap only when
/// nothing fits; the attach gate then refuses it with `composerImageTooLargeMessage`. `nil` when the
/// bytes are not an image at all.
func composerImage(fromImageData data: Data) -> ComposerImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let width = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
    let height = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
    let orientation = (props?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    let longEdge = max(width, height)
    let sniffed = composerImageMediaType(of: data)
    if let sniffed, longEdge > 0, longEdge <= composerImageMaxLongEdge, orientation == 1, data.count <= composerImageMaxBytes {
        return ComposerImage(data: data, mediaType: sniffed)
    }
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

/// The images a pasteboard carries, or `nil` when it carries none (or any of them fails to decode) —
/// `nil` hands the paste/drop back to AppKit untouched. Image files are read (and converted if needed); with no file URLs, PNG data wins
/// over TIFF; text beside the image (see `composerStringIsPastedText`) keeps the paste text.
func composerImages(from pasteboard: NSPasteboard) -> [ComposerImage]? {
    switch composerImageSource(on: pasteboard) {
    case nil:
        return nil
    case .files(let urls):
        // Every file must DECODE, not merely be typed as an image: an SVG conforms to `.image` but
        // ImageIO reads no frame from it, and a corrupt file reads nothing. Any such file hands the
        // whole paste back to AppKit (which inserts the paths) rather than silently doing nothing.
        let images = urls.compactMap { url in (try? Data(contentsOf: url)).flatMap(composerImage(fromImageData:)) }
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

/// What a code-mode submit sends: `session.send`/`session.steer`'s `text` and `images`.
struct ComposerOutgoing: Equatable {
    let text: String
    let images: [SessionEvent.UserMessageImageRef]
}

/// **The one submit-time helper** every code-mode submit site goes through: stage each attachment the
/// text still references (`stage` is `session.stageImage` for that session), in order. When every
/// stage answered `imagesOnSend`, the text goes as written (placeholders kept) with `images` naming
/// each staged path; otherwise (an older daemon) each placeholder is replaced by its path in the text
/// and `images` is empty. The first refusal throws — the caller sends nothing. A text with no live
/// placeholder comes back unchanged, with no images, and stages nothing.
func resolveComposerImages(_ text: String, draft: ComposerImageDraft,
                           stage: (ComposerImage) async throws -> StagedImage) async throws -> ComposerOutgoing {
    var refs: [SessionEvent.UserMessageImageRef] = []
    var imagesOnSend = true
    for n in draft.referencedNumbers(in: text) {
        guard let image = draft.images[n] else { continue }
        let staged = try await stage(image)
        refs.append(SessionEvent.UserMessageImageRef(n: n, path: staged.path))
        if !staged.imagesOnSend { imagesOnSend = false }
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
/// not list (or an empty catalogue) is NOT refused here — the daemon's `session.stageImage` is the
/// authority and refuses at submit when it truly is text-only.
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
