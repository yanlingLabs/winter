import AppKit
import Foundation
import WinterKit
import WinterProtocol

// MARK: - Composer attachments (2026-10-13)
//
// A CODE session's composer holds its attachments INSIDE the typed text, where the user put them: each one is a
// chip in the line — a text attachment drawn as the shared chip (`ComposerChipAttachmentCell`, TextKit 1) — with
// a hover × to remove it; Backspace and Delete take it like any character, and undo brings it back. Two kinds:
//
//   - an IMAGE (`ComposerImage`, `ComposerImages.swift`): the user's own image file, or image data staged at
//     submit — exactly the code-mode image input of 2026-09-29/10-10;
//   - a FILE: any other file or folder (a PDF, a .docx, a code file, a folder…) — its absolute path.
//
// The draft (`FieldStateAdapter.composerDraft`) is a plain String; each chip is ONE private-use character in it,
// its MARKER (`composerAttachmentMarker`, U+E000 + the attachment's id) — one UTF-16 unit, like the U+FFFC the
// text view holds in its place, so a range in one is the same range in the other. The attachments themselves
// live beside the draft (`ComposerAttachmentDraft`), and stay there while their chip is out of the text so
// undo (or a paste of a cut chip) can bring it back; what a draft SENDS is only what its text holds.
//
// At submit (`resolveComposerAttachments`) each marker becomes its placeholder AT ITS POSITION — images and files
// each numbered from 1 in the order they first appear (`look at [Image #1] and compare [File #1]`) — with
// `images` and `files` naming the paths. So the wire contract is the one every daemon and client already speaks:
// the daemon substitutes the paths for the model (`modelTextOf`), the stored message keeps the placeholders, and
// the bubble draws a chip at each placeholder. A daemon without the `attachment-files` hello feature is sent each
// file's path in the text instead; one without `image-original-paths` (or a stage answer without
// `imagesOnSend`) likewise for images.

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

/// The first private-use code point a chip's marker uses; a marker is `base + id`.
let composerAttachmentMarkerBase: UInt32 = 0xE000
/// The last id a marker can carry (the BMP private-use area ends at U+F8FF) — far past any draft.
let composerAttachmentMaxID = Int(0xF8FF - composerAttachmentMarkerBase)

/// The marker character for an attachment id — what the draft String holds where its chip is.
func composerAttachmentMarker(_ id: Int) -> Character {
    Character(Unicode.Scalar(composerAttachmentMarkerBase + UInt32(id))!)
}

/// The attachment id a character marks, or `nil` for any other character.
func composerAttachmentID(marker: Character) -> Int? {
    guard marker.unicodeScalars.count == 1, let scalar = marker.unicodeScalars.first else { return nil }
    let value = scalar.value
    guard value > composerAttachmentMarkerBase, value <= 0xF8FF else { return nil }
    return Int(value - composerAttachmentMarkerBase)
}

/// The ids of every marker in `text`, in order (a chip pasted twice appears twice).
func composerAttachmentMarkerIDs(in text: String) -> [Int] {
    text.compactMap(composerAttachmentID(marker:))
}

/// `text` without its markers — what a surface that cannot take attachments shows or sends.
func composerTextWithoutMarkers(_ text: String) -> String {
    String(text.filter { composerAttachmentID(marker: $0) == nil })
}

/// One draft's attachments: every one attached and not yet sent or dropped, by id. Which of them the message
/// carries, and in what order, is the TEXT's business (`live(in:)`).
struct ComposerAttachmentDraft: Equatable {
    private(set) var items: [ComposerAttachment] = []
    private var nextID = 1
    /// Names this draft, for a copied chip: a paste restores a chip only into the draft it was cut from.
    let token = UUID().uuidString

    /// At most this many attachments are kept OUT of the text (for undo) — the oldest go first.
    static let retainedOutOfTextMax = 32

    var isEmpty: Bool { items.isEmpty }

    /// The attachment with this id, if the draft still holds it.
    func item(id: Int) -> ComposerAttachment? { items.first { $0.id == id } }

    /// Appends one attachment and answers its id — `nil` past `composerAttachmentMaxID` ids in one draft.
    @discardableResult
    mutating func add(_ kind: ComposerAttachmentKind) -> Int? {
        guard nextID <= composerAttachmentMaxID else { return nil }
        let id = nextID
        nextID += 1
        items.append(ComposerAttachment(id: id, kind: kind, key: UUID().uuidString))
        return id
    }

    /// Drops one — answers whether anything was removed.
    @discardableResult
    mutating func remove(id: Int) -> Bool {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return false }
        items.remove(at: i)
        return true
    }

    /// Drops these (a sent message's), keeping every other one — attached during the send's round trip.
    mutating func remove(ids: Set<Int>) {
        items.removeAll { ids.contains($0.id) }
    }

    /// Keeps what `text` holds, and of the rest (chips deleted, kept for undo) only the newest
    /// `retainedOutOfTextMax`. `retaining: 0` keeps only what the text holds.
    mutating func prune(keeping text: String, retaining: Int = retainedOutOfTextMax) {
        let inText = Set(composerAttachmentMarkerIDs(in: text))
        let outOfText = items.filter { !inText.contains($0.id) }.map(\.id)
        let dropped = Set(outOfText.dropLast(max(0, retaining)))
        if !dropped.isEmpty { items.removeAll { dropped.contains($0.id) } }
    }

    /// The attachments `text` carries, each once, in the order their chips first appear.
    func live(in text: String) -> [ComposerAttachment] {
        var seen = Set<Int>()
        return composerAttachmentMarkerIDs(in: text).compactMap { id in
            guard seen.insert(id).inserted else { return nil }
            return item(id: id)
        }
    }

    /// The number each attachment's placeholder carries when `text` is sent: images and files each count from 1,
    /// in the order they first appear in the text. Keyed by attachment id.
    func placeholderNumbers(in text: String) -> [Int: Int] {
        var images = 0, files = 0
        var out: [Int: Int] = [:]
        for item in live(in: text) {
            if item.image != nil { images += 1; out[item.id] = images } else { files += 1; out[item.id] = files }
        }
        return out
    }

    /// The placeholder a chip stands for in `text` (`[Image #2]`), or `nil` when the draft no longer holds it.
    func placeholder(id: Int, in text: String) -> String? {
        guard let item = item(id: id), let n = placeholderNumbers(in: text)[id] else { return nil }
        return item.image != nil ? composerImageToken(n) : composerFileToken(n)
    }

    /// `text` with each marker replaced by its placeholder; a marker the draft no longer holds goes.
    func serialized(_ text: String) -> String {
        let numbers = placeholderNumbers(in: text)
        var out = ""
        for character in text {
            guard let id = composerAttachmentID(marker: character) else { out.append(character); continue }
            guard let item = item(id: id), let n = numbers[id] else { continue }
            out += item.image != nil ? composerImageToken(n) : composerFileToken(n)
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

/// At most this many attachments — images and files TOGETHER — ride one message (`USER_MESSAGE_ATTACHMENTS_MAX`),
/// so a message's paths stay far inside the daemon's per-event cap.
let composerAttachmentsPerMessageMax = 20
/// The daemon's own sentence for that refusal (`USER_MESSAGE_ATTACHMENTS_MAX_MESSAGE`).
let composerAttachmentsPerMessageMaxMessage = "A message can carry at most 20 attachments"

/// `text` with each `[Image #n]` that `images` knows and each `[File #n]` that `files` knows replaced by its path —
/// for a daemon that would drop them. ONE pass over both grammars (as the daemon's `modelTextOf`), so a substituted
/// path that happens to spell a token is never rewritten again.
func substituteComposerAttachmentTokens(_ text: String, images: [Int: String], files: [Int: String]) -> String {
    rewriteAttachmentTokenText(text) { kind, n in kind == .image ? images[n] : files[n] }
}

/// **The one submit-time helper** every code-mode submit site goes through: the draft's `text` — its chips as
/// markers — as the wire's message, each chip's placeholder where the chip was (`ComposerAttachmentDraft
/// .serialized`). Each IMAGE resolves to the path the model is given — a FILE image is its own path, DATA is
/// staged raw through `stage` — and each FILE attachment is its own path. When every stage answered
/// `imagesOnSend` (and, for a file image, the daemon announced `originalPaths`) the images ride in `images` beside
/// their placeholders, else their paths go into the text; likewise files ride in `files` only when the daemon
/// announced `attachmentFiles`. The first refusal throws — the caller sends nothing. A text without markers comes
/// back as it is, with nothing staged.
func resolveComposerAttachments(_ text: String, draft: ComposerAttachmentDraft, originalPaths: Bool = true,
                                attachmentFiles: Bool = true,
                                stage: (ComposerImageData) async throws -> StagedImage) async throws -> ComposerOutgoing {
    let live = draft.live(in: text)
    let imageItems = live.filter { $0.image != nil }
    let fileItems = live.filter { $0.filePath != nil }
    if imageItems.count > composerImagesPerMessageMax { throw ComposerImagesRefusal(message: composerImagesPerMessageMaxMessage) }
    if fileItems.count > composerFilesPerMessageMax { throw ComposerImagesRefusal(message: composerFilesPerMessageMaxMessage) }
    if live.count > composerAttachmentsPerMessageMax { throw ComposerImagesRefusal(message: composerAttachmentsPerMessageMaxMessage) }
    let message = draft.serialized(text)

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
    var fileRefs = fileItems.enumerated().map { SessionEvent.UserMessageFileRef(n: $0.offset + 1, path: $0.element.filePath!) }
    // What the daemon cannot take goes into the text — both kinds in ONE pass.
    var inlineImages: [Int: String] = [:], inlineFiles: [Int: String] = [:]
    if !imageRefs.isEmpty && !imagesOnSend {
        inlineImages = Dictionary(uniqueKeysWithValues: imageRefs.map { ($0.n, $0.path) })
        imageRefs = []
        originals = [:]
    }
    if !fileRefs.isEmpty && !attachmentFiles {
        inlineFiles = Dictionary(uniqueKeysWithValues: fileRefs.map { ($0.n, $0.path) })
        fileRefs = []
    }
    let sent = inlineImages.isEmpty && inlineFiles.isEmpty
        ? message : substituteComposerAttachmentTokens(message, images: inlineImages, files: inlineFiles)
    return ComposerOutgoing(text: sent, images: imageRefs, files: fileRefs,
                            sentAttachmentIDs: Set(live.map(\.id)), originalImagePaths: originals)
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

/// What a composer surface hands `ComposerTextView` so its paste/drop (and the "+" picker) can attach, and its
/// chips can draw.
struct ComposerAttachmentIntake {
    /// Read at paste/drop time: `false` (not a code or dispatch session) leaves AppKit's own behaviour untouched.
    let isEnabled: () -> Bool
    /// Attach one: its id, for the text view to put its chip in the text — or `nil` when refused (the surface
    /// has already shown why, in its composer notice line).
    let attach: (ComposerAttachmentKind) -> Int?
    /// What the chip of an attachment draws, numbered against `text` (the draft as it now reads) — `nil` once the
    /// draft no longer holds it.
    let chip: (_ id: Int, _ text: String) -> AttachmentChipModel?
    /// The placeholder a chip stands for in `text` (`[Image #1]`) — what a copy puts on the pasteboard.
    let placeholder: (_ id: Int, _ text: String) -> String?
    /// The draft's own name (`ComposerAttachmentDraft.token`): a copied chip pastes back as a chip only here.
    let draftToken: () -> String
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
