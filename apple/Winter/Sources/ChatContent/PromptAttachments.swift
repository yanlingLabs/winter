import Foundation
import WinterProtocol

// MARK: - A sent message's attachments (2026-10-13)
//
// A `user_message` carries `[Image #n]` / `[File #n]` placeholders in its text and names each one's path in
// `images` / `files`. The bubble draws every placeholder that HAS an entry as the composer's own chip
// (`AttachmentChip`), in a row above the prose, and takes the placeholder out of the prose; a placeholder with
// no entry (typed by hand, or from a client that substituted the paths itself) stays as text. No × here.

/// The placeholders' paths of one exchange's prompt, by number.
struct PromptAttachments: Equatable {
    var images: [Int: String] = [:]
    var files: [Int: String] = [:]

    var isEmpty: Bool { images.isEmpty && files.isEmpty }

    init(images: [Int: String] = [:], files: [Int: String] = [:]) {
        self.images = images
        self.files = files
    }

    init(_ message: SessionEvent.UserMessage) {
        for ref in message.images ?? [] where images[ref.n] == nil { images[ref.n] = ref.path }
        for ref in message.files ?? [] where files[ref.n] == nil { files[ref.n] = ref.path }
    }

    /// A STEER folded into this prompt brings its own placeholders, numbered from 1 like every message — so its
    /// numbers are moved past this prompt's before they join it (`[Image #1]` → `[Image #3]`), and the rewritten
    /// steer text is answered. A steer with no attachments comes back unchanged.
    mutating func fold(steerText: String, _ steer: PromptAttachments) -> String {
        guard !steer.isEmpty else { return steerText }
        let imageShift = images.keys.max() ?? 0
        let fileShift = files.keys.max() ?? 0
        let rewritten = rewriteAttachmentTokens(steerText) { kind, n in
            switch kind {
            case .image: return steer.images[n] == nil ? nil : n + imageShift
            case .file: return steer.files[n] == nil ? nil : n + fileShift
            }
        }
        for (n, path) in steer.images { images[n + imageShift] = path }
        for (n, path) in steer.files { files[n + fileShift] = path }
        return rewritten
    }
}

enum AttachmentTokenKind { case image, file }

private let attachmentTokenRegex = try! NSRegularExpression(pattern: #"\[(Image|File) #(\d+)\]"#)

/// Every `[Image #n]` / `[File #n]` in `text`, rewritten by `renumber` (`nil` leaves that token as typed).
func rewriteAttachmentTokens(_ text: String, _ renumber: (AttachmentTokenKind, Int) -> Int?) -> String {
    rewriteAttachmentTokenText(text) { kind, n in
        renumber(kind, n).map { kind == .image ? composerImageToken($0) : composerFileToken($0) }
    }
}

/// ONE pass over `text`: each `[Image #n]` / `[File #n]` for which `replacement` answers a string becomes that
/// string; any other is left as typed. Replacements are never scanned again.
func rewriteAttachmentTokenText(_ text: String, _ replacement: (AttachmentTokenKind, Int) -> String?) -> String {
    let ns = text as NSString
    var out = ""
    var cursor = 0
    for m in attachmentTokenRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        let kind: AttachmentTokenKind = ns.substring(with: m.range(at: 1)) == "Image" ? .image : .file
        guard let n = Int(ns.substring(with: m.range(at: 2))), let new = replacement(kind, n) else { continue }
        out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
        out += new
        cursor = m.range.location + m.range.length
    }
    out += ns.substring(from: cursor)
    return out
}

/// What a user bubble shows: the chips (first-appearance order, each placeholder once) and the prose left
/// once the known placeholders are taken out — a line that held only placeholders goes, and the spaces a
/// placeholder leaves inside a line collapse.
struct PromptDisplay: Equatable {
    let chips: [AttachmentChipModel]
    let text: String
}

func promptDisplay(_ text: String, attachments: PromptAttachments) -> PromptDisplay {
    guard !attachments.isEmpty else { return PromptDisplay(chips: [], text: text) }
    var chips: [AttachmentChipModel] = []
    var seen = Set<String>()
    let lines = text.components(separatedBy: "\n").compactMap { line -> String? in
        let ns = line as NSString
        var out = ""
        var cursor = 0
        var tookOne = false
        for m in attachmentTokenRegex.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            let isImage = ns.substring(with: m.range(at: 1)) == "Image"
            guard let n = Int(ns.substring(with: m.range(at: 2))),
                  let path = isImage ? attachments.images[n] : attachments.files[n] else { continue }
            out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            cursor = m.range.location + m.range.length
            tookOne = true
            let id = (isImage ? "image-" : "file-") + String(n)
            guard seen.insert(id).inserted else { continue }
            chips.append(promptChipModel(id: id, n: n, path: path, isImage: isImage))
        }
        out += ns.substring(from: cursor)
        guard tookOne else { return line }
        let collapsed = out.replacingOccurrences(of: #" {2,}"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        // A line that held only placeholders goes; one with words left keeps them.
        return collapsed.isEmpty ? nil : collapsed
    }
    return PromptDisplay(chips: chips, text: lines.joined(separator: "\n"))
}

private func promptChipModel(id: String, n: Int, path: String, isImage: Bool) -> AttachmentChipModel {
    guard isImage else { return AttachmentChipModel(id: id, name: attachmentDisplayName(path), visual: .file(path: path)) }
    let fallback = "Image #\(n)"
    let name = attachmentPathIsStagedImage(path) ? fallback : attachmentDisplayName(path)
    return AttachmentChipModel(id: id, name: name, visual: .image(source: .path(path), fallbackName: fallback))
}
