import AppKit
import Foundation
import UniformTypeIdentifiers
import WinterKit

// MARK: - Code-mode image input (2026-09-29)
//
// In a CODE session, pasting image data or an image file, or dropping image files, onto the composer
// adds an attachment to the draft and inserts the plain-text placeholder `[Image #n]` (n counts per
// draft from 1 and is never reused within it). At submit every placeholder still in the text is
// staged with `session.stageImage` — the daemon writes the image into the session's own temp
// directory — and replaced by the returned absolute path; the text is then sent exactly as before.
// A placeholder the user deleted is never staged. Every other mode keeps today's behaviour: the
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

/// Bytes as an attachment: kept as-is when they are one of the four stageable types, otherwise
/// decoded as any image AppKit reads (TIFF — what a screenshot or `NSImage` copy puts on the
/// pasteboard — HEIC, BMP, …) and re-encoded as PNG. `nil` when they are not an image at all.
func composerImage(fromImageData data: Data) -> ComposerImage? {
    if let type = composerImageMediaType(of: data) { return ComposerImage(data: data, mediaType: type) }
    guard let rep = NSBitmapImageRep(data: data),
          let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return ComposerImage(data: png, mediaType: "image/png")
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

/// The images a pasteboard carries, or `nil` when it carries none — `nil` hands the paste/drop back to
/// AppKit untouched. Image files are read (and converted if needed); with no file URLs, PNG data wins
/// over TIFF; text beside the image (see `composerStringIsPastedText`) keeps the paste text.
func composerImages(from pasteboard: NSPasteboard) -> [ComposerImage]? {
    switch composerImageSource(on: pasteboard) {
    case nil:
        return nil
    case .files(let urls):
        return urls.compactMap { url in (try? Data(contentsOf: url)).flatMap(composerImage(fromImageData:)) }
    case .data(let type):
        return pasteboard.data(forType: type).flatMap(composerImage(fromImageData:)).map { [$0] } ?? []
    }
}

/// One draft's attachments.
struct ComposerImageDraft: Equatable {
    private(set) var images: [Int: ComposerImage] = [:]
    private(set) var nextNumber = 1

    static func token(_ n: Int) -> String { "[Image #\(n)]" }

    var isEmpty: Bool { images.isEmpty }

    /// Adds an image and answers its number. Numbers climb for the draft's whole life: a deleted
    /// placeholder's number is never reused, so ⌘Z bringing it back still finds its image.
    mutating func add(_ image: ComposerImage) -> Int {
        let n = nextNumber
        nextNumber += 1
        images[n] = image
        return n
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

/// **The one submit-time helper** every code-mode submit site goes through: stage each attachment the
/// text still references (`stage` is `session.stageImage` for that session), in order, and answer the
/// text with every placeholder replaced by its staged path. The first refusal throws — the caller
/// sends nothing. A text with no live placeholder comes back unchanged and stages nothing.
func resolveComposerImages(_ text: String, draft: ComposerImageDraft,
                           stage: (ComposerImage) async throws -> String) async throws -> String {
    var paths: [Int: String] = [:]
    for n in draft.referencedNumbers(in: text) {
        guard let image = draft.images[n] else { continue }
        paths[n] = try await stage(image)
    }
    return paths.isEmpty ? text : substituteComposerImageTokens(text, paths: paths)
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
