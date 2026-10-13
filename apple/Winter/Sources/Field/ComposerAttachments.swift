import AppKit
import Foundation
import WinterKit
import WinterProtocol

// MARK: - Composer attachments (2026-10-13)
//
// A CODE session's composer holds its attachments BESIDE the typed text, never inside it: each one is a chip
// in a strip above the text (`ComposerAttachmentStrip`), with a hover × to remove it, and Backspace at the very
// start of the text removes the last one. Two kinds:
//
//   - an IMAGE (`ComposerImage`, `ComposerImages.swift`): the user's own image file, or image data staged at
//     submit — exactly the code-mode image input of 2026-09-29/10-10;
//   - a FILE: any other file or folder (a PDF, a .docx, a code file, a folder…) — its absolute path.
//
// Only at submit does the draft become the wire's shape (`resolveComposerAttachments`): the chips' placeholders,
// images first and then files, each numbered from 1 in strip order, on one line ABOVE the typed text —
// `[Image #1] [File #1]\nexplain these` — with `images` and `files` naming the paths. So the wire contract is
// the one every daemon and client already speaks: the daemon substitutes the paths for the model
// (`modelTextOf`), the stored message keeps the placeholders, and the bubble draws a chip per placeholder.
// A daemon without the `attachment-files` hello feature is sent each file's path in the text instead; one
// without `image-original-paths` (or a stage answer without `imagesOnSend`) likewise for images.
//
// Why a strip and not inline text attachments: the user asked for ONE chip design (thumbnail or icon, a name,
// a hover ×) shared by the composer and the sent bubble. The composer's `NSTextView` lays out with TextKit 1, so
// an inline chip would be an `NSTextAttachmentCell` drawn by hand — a second implementation of the chip, with
// hover tracking, glyph-rect hit testing, and copy/undo/serialisation all re-plumbed through the text storage.
// The strip keeps the text plain (copy, cut, undo and caret movement are AppKit's, untouched) and renders the
// same SwiftUI `AttachmentChip` in both places.

/// What one composer attachment is.
enum ComposerAttachmentKind: Equatable {
    /// An image the model reads (a file by its own path, or data staged at submit).
    case image(ComposerImage)
    /// Any other file or folder, by its absolute path — the model is given the path.
    case file(path: String)
}

/// One attachment of a draft. `id` is unique for the draft's life (never reused), so a chip's identity, its
/// removal and "clear only what was sent" never confuse two attachments.
struct ComposerAttachment: Identifiable, Equatable {
    let id: Int
    let kind: ComposerAttachmentKind
    /// Unique across drafts and windows (ids restart with every fresh draft) — what a pasted image's
    /// thumbnail is cached under, so two screenshots never share one.
    let key: String

    /// The image half, or `nil` for a file.
    var image: ComposerImage? {
        if case .image(let image) = kind { return image }
        return nil
    }

    /// A FILE attachment's path, or `nil` for an image.
    var filePath: String? {
        if case .file(let path) = kind { return path }
        return nil
    }
}

/// One draft's attachments, in strip order.
struct ComposerAttachmentDraft: Equatable {
    private(set) var items: [ComposerAttachment] = []
    private var nextID = 1

    var isEmpty: Bool { items.isEmpty }
    var imageCount: Int { items.filter { $0.image != nil }.count }
    var fileCount: Int { items.filter { $0.filePath != nil }.count }

    /// Appends one attachment and answers its id.
    @discardableResult
    mutating func add(_ kind: ComposerAttachmentKind) -> Int {
        let id = nextID
        nextID += 1
        items.append(ComposerAttachment(id: id, kind: kind, key: UUID().uuidString))
        return id
    }

    /// The chip's × — answers whether anything was removed.
    @discardableResult
    mutating func remove(id: Int) -> Bool {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return false }
        items.remove(at: i)
        return true
    }

    /// Backspace at the start of the text: the last chip goes. `nil` when there is none.
    @discardableResult
    mutating func removeLast() -> ComposerAttachment? {
        items.popLast()
    }

    /// Drops these (a sent message's), keeping every other one — attached during the send's round trip.
    mutating func remove(ids: Set<Int>) {
        items.removeAll { ids.contains($0.id) }
    }

    /// The number each attachment's placeholder will carry when sent: images and files each count from 1, in
    /// strip order. Keyed by attachment id.
    var placeholderNumbers: [Int: Int] {
        var images = 0, files = 0
        var out: [Int: Int] = [:]
        for item in items {
            if item.image != nil { images += 1; out[item.id] = images } else { files += 1; out[item.id] = files }
        }
        return out
    }
}

/// `[Image #n]` — the image placeholder, the wire's grammar.
func composerImageToken(_ n: Int) -> String { "[Image #\(n)]" }
/// `[File #n]` — the file placeholder (`DAEMON_FEATURE_ATTACHMENT_FILES`).
func composerFileToken(_ n: Int) -> String { "[File #\(n)]" }

/// At most this many files ride one message (`USER_MESSAGE_FILES_MAX`).
let composerFilesPerMessageMax = 20
/// The daemon's own sentence for that refusal (`USER_MESSAGE_FILES_MAX_MESSAGE`).
let composerFilesPerMessageMaxMessage = "A message can carry at most 20 files"

/// What a code-mode submit sends: `session.send`/`session.steer`'s `text`, `images` and `files`.
struct ComposerOutgoing: Equatable {
    let text: String
    let images: [SessionEvent.UserMessageImageRef]
    var files: [SessionEvent.UserMessageFileRef] = []
    /// The attachments this message carries — cleared from the draft only once it is sent.
    var sentAttachmentIDs: Set<Int> = []
    /// Each image placeholder that names the user's ORIGINAL file, by number → that path: the one fallback
    /// (`FieldStateAdapter.composerSend`) reads it here and stages it when the daemon cannot read it.
    var originalImagePaths: [Int: String] = [:]
}

/// The text a draft sends: its placeholders on one line (images, then files), then the typed text. A draft with
/// no attachment is its text, unchanged.
func composerMessageText(_ text: String, imageNumbers: Int, fileNumbers: Int) -> String {
    let tokens = (0..<imageNumbers).map { composerImageToken($0 + 1) } + (0..<fileNumbers).map { composerFileToken($0 + 1) }
    guard !tokens.isEmpty else { return text }
    let line = tokens.joined(separator: " ")
    return text.isEmpty ? line : line + "\n" + text
}

/// `text` with each `[File #n]` that `paths` knows replaced by its path — for a daemon without `attachment-files`.
func substituteComposerFileTokens(_ text: String, paths: [Int: String]) -> String {
    var out = text
    for (n, path) in paths { out = out.replacingOccurrences(of: composerFileToken(n), with: path) }
    return out
}

/// **The one submit-time helper** every code-mode submit site goes through: the draft (typed `text` plus its
/// attachments) as the wire's message. Each IMAGE resolves to the path the model is given — a FILE image is its
/// own path, DATA is staged raw through `stage` — and each FILE attachment is its own path. When every stage
/// answered `imagesOnSend` (and, for a file image, the daemon announced `originalPaths`) the images ride in
/// `images` beside their placeholders, else their paths go into the text; likewise files ride in `files` only
/// when the daemon announced `attachmentFiles`. The first refusal throws — the caller sends nothing. A draft with
/// no attachment comes back as its text, with nothing staged.
func resolveComposerAttachments(_ text: String, draft: ComposerAttachmentDraft, originalPaths: Bool = true,
                                attachmentFiles: Bool = true,
                                stage: (ComposerImageData) async throws -> StagedImage) async throws -> ComposerOutgoing {
    let imageItems = draft.items.filter { $0.image != nil }
    let fileItems = draft.items.filter { $0.filePath != nil }
    if imageItems.count > composerImagesPerMessageMax { throw ComposerImagesRefusal(message: composerImagesPerMessageMaxMessage) }
    if fileItems.count > composerFilesPerMessageMax { throw ComposerImagesRefusal(message: composerFilesPerMessageMaxMessage) }
    var message = composerMessageText(text, imageNumbers: imageItems.count, fileNumbers: fileItems.count)

    var imageRefs: [SessionEvent.UserMessageImageRef] = []
    var originals: [Int: String] = [:]
    var imagesOnSend = true
    for (i, item) in imageItems.enumerated() {
        let n = i + 1
        switch item.image! {
        case .file(let path):
            imageRefs.append(SessionEvent.UserMessageImageRef(n: n, path: path))
            originals[n] = path
            if !originalPaths { imagesOnSend = false }
        case .data(let data):
            let staged = try await stage(data)
            imageRefs.append(SessionEvent.UserMessageImageRef(n: n, path: staged.path))
            if !staged.imagesOnSend { imagesOnSend = false }
        }
    }
    if !imageRefs.isEmpty && !imagesOnSend {
        message = substituteComposerImageTokens(message, paths: Dictionary(uniqueKeysWithValues: imageRefs.map { ($0.n, $0.path) }))
        imageRefs = []
        originals = [:]
    }

    var fileRefs = fileItems.enumerated().map { SessionEvent.UserMessageFileRef(n: $0.offset + 1, path: $0.element.filePath!) }
    if !fileRefs.isEmpty && !attachmentFiles {
        message = substituteComposerFileTokens(message, paths: Dictionary(uniqueKeysWithValues: fileRefs.map { ($0.n, $0.path) }))
        fileRefs = []
    }
    return ComposerOutgoing(text: message, images: imageRefs, files: fileRefs,
                            sentAttachmentIDs: Set(draft.items.map(\.id)), originalImagePaths: originals)
}

// MARK: - Intake (paste, drop, the "+" picker)

/// Whether a path names a regular file or a directory (following symlinks) — what a FILE attachment may be.
func composerPathIsFileOrFolder(_ path: String) -> Bool {
    var info = stat()
    guard stat(path, &info) == 0 else { return false }
    let type = info.st_mode & S_IFMT
    return type == S_IFREG || type == S_IFDIR
}

/// One picked or dropped URL as an attachment: an IMAGE when it is one the composer can take
/// (`composerImage(fromFile:)` — by its name first, then its bytes), else a FILE when it is a file or folder,
/// else `nil` (it vanished, or is a FIFO, a socket…).
func composerAttachment(fromURL url: URL) -> ComposerAttachmentKind? {
    guard url.isFileURL else { return nil }
    let path = (url as NSURL).filePathURL?.path ?? url.path
    if composerURLMayBeImage(URL(fileURLWithPath: path)), let image = composerImage(fromFile: URL(fileURLWithPath: path)) {
        return .image(image)
    }
    return composerPathIsFileOrFolder(path) ? .file(path: path) : nil
}

private func composerFileURLs(on pasteboard: NSPasteboard) -> [URL] {
    (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
}

/// Whether a pasteboard carries something the composer would attach — any file URL, or image data — the
/// cheap, types-only answer for Edit ▸ Paste's enablement and a drag's hover feedback.
func composerPasteboardMayHaveAttachment(_ pasteboard: NSPasteboard) -> Bool {
    if !composerFileURLs(on: pasteboard).isEmpty { return true }
    return composerPasteboardMayHaveImage(pasteboard)
}

/// The attachments a pasteboard carries, or `nil` when it carries none — `nil` hands the paste/drop back to
/// AppKit untouched. File URLs decide alone (a Finder copy puts the file's ICON beside its URL): each is an
/// image or a file (`composerAttachment(fromURL:)`); one that is neither is skipped. With no file URLs, image
/// DATA is one image (`composerImages(from:)`); text beside an image keeps the paste text.
func composerAttachments(from pasteboard: NSPasteboard) -> [ComposerAttachmentKind]? {
    let urls = composerFileURLs(on: pasteboard)
    if !urls.isEmpty {
        let kinds = urls.compactMap(composerAttachment(fromURL:))
        return kinds.isEmpty ? nil : kinds
    }
    return composerImages(from: pasteboard).map { $0.map(ComposerAttachmentKind.image) }
}

/// What a composer surface hands `ComposerTextView` so its paste/drop (and the "+" picker) can attach.
struct ComposerAttachmentIntake {
    /// Read at paste/drop time: `false` (not a code session) leaves AppKit's own behaviour untouched.
    let isEnabled: () -> Bool
    /// Attach one: `true` when it was attached, `false` when refused (the surface has already shown why, in its
    /// composer notice line).
    let attach: (ComposerAttachmentKind) -> Bool
    /// Backspace at the start of the text: remove the last chip. `true` when one was removed.
    let removeLast: () -> Bool
}

/// The "+" button's job, handed to the text view: the button lives in SwiftUI chrome, the intake and the
/// caret in AppKit. The text view registers itself; the button calls `pick()`.
@MainActor
final class ComposerAttachPicker {
    weak var textView: CommandTextView?

    /// The open panel — several files and folders — on the composer's window, each pick through the intake.
    func pick() {
        guard let textView, textView.composerAttachmentsEnabled else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = true
        panel.prompt = "Attach"
        panel.message = "Images show as a preview; any other file or folder is given to Winter by its path."
        let finish: (NSApplication.ModalResponse) -> Void = { [weak textView] response in
            guard response == .OK, let textView else { return }
            textView.takeComposerAttachments(panel.urls.compactMap(composerAttachment(fromURL:)))
            textView.window?.makeFirstResponder(textView)
        }
        if let window = textView.window { panel.beginSheetModal(for: window, completionHandler: finish) } else { finish(panel.runModal()) }
    }
}
