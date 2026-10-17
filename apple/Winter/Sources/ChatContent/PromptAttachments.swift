import AppKit
import SwiftUI
import WinterProtocol

// MARK: - A sent message's attachments (2026-10-13)
//
// A `user_message` carries `[Image #n]` / `[File #n]` placeholders in its text and names each one's path in
// `images` / `files`. The bubble draws every placeholder that HAS an entry as the composer's own chip, INLINE,
// where the placeholder is (`PromptBodyView`); a placeholder with no entry (typed by hand, or from a client that
// substituted the paths itself) stays as text. No × here.

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

/// One piece of a line that holds chips: words, or a chip.
enum PromptInlinePiece: Equatable {
    case text(String)
    case chip(AttachmentChipModel)
}

/// A stretch of a prompt: lines with no chip (markdown, as any bubble), or lines holding chips — drawn as text
/// with the chips in place.
enum PromptSegment: Equatable {
    case prose(String)
    case inline(lines: [[PromptInlinePiece]])
}

/// What a user bubble shows: its segments in order, and its chips (first-appearance order, each placeholder once).
struct PromptDisplay: Equatable {
    let segments: [PromptSegment]
    let chips: [AttachmentChipModel]

    /// Whether there is anything to draw.
    var isEmpty: Bool {
        segments.allSatisfy { segment in
            if case .prose(let text) = segment { return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            return false
        }
    }
}

/// PURE: a prompt split into what its bubble draws. A line with a placeholder that has an entry becomes an inline
/// line (its words around the chips kept as typed); runs of other lines stay prose. No attachments: the whole text
/// is one prose segment, exactly as before.
func promptDisplay(_ text: String, attachments: PromptAttachments) -> PromptDisplay {
    guard !attachments.isEmpty else { return PromptDisplay(segments: [.prose(text)], chips: []) }
    var segments: [PromptSegment] = []
    var chips: [AttachmentChipModel] = []
    var seen = Set<String>()
    var prose: [String] = []
    var inline: [[PromptInlinePiece]] = []
    func flushProse() {
        if !prose.isEmpty { segments.append(.prose(prose.joined(separator: "\n"))); prose = [] }
    }
    func flushInline() {
        if !inline.isEmpty { segments.append(.inline(lines: inline)); inline = [] }
    }
    for line in text.components(separatedBy: "\n") {
        let ns = line as NSString
        var pieces: [PromptInlinePiece] = []
        var cursor = 0
        for m in attachmentTokenRegex.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            let isImage = ns.substring(with: m.range(at: 1)) == "Image"
            guard let n = Int(ns.substring(with: m.range(at: 2))),
                  let path = isImage ? attachments.images[n] : attachments.files[n] else { continue }
            if m.range.location > cursor {
                pieces.append(.text(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))))
            }
            cursor = m.range.location + m.range.length
            let id = (isImage ? "image-" : "file-") + String(n)
            let chip = promptChipModel(id: id, n: n, path: path, isImage: isImage)
            pieces.append(.chip(chip))
            if seen.insert(id).inserted { chips.append(chip) }
        }
        guard !pieces.isEmpty else {
            flushInline()
            prose.append(line)
            continue
        }
        if cursor < ns.length { pieces.append(.text(ns.substring(from: cursor))) }
        flushProse()
        inline.append(pieces)
    }
    flushProse()
    flushInline()
    return PromptDisplay(segments: segments, chips: chips)
}

private func promptChipModel(id: String, n: Int, path: String, isImage: Bool) -> AttachmentChipModel {
    guard isImage else { return AttachmentChipModel(id: id, name: attachmentDisplayName(path), visual: .file(path: path)) }
    let fallback = "Image #\(n)"
    let name = attachmentPathIsStagedImage(path) ? fallback : attachmentDisplayName(path)
    return AttachmentChipModel(id: id, name: name, visual: .image(source: .path(path), fallbackName: fallback))
}

// MARK: - The bubble's body

/// A user message's body: prose segments through the transcript's own markdown text, chip lines as one `Text`
/// with each chip in place — the shared chip rasterised (`AttachmentChipImages`) at the prose's own size, sitting
/// on its descender like the composer's.
struct PromptBodyView: View {
    let display: PromptDisplay
    let tint: Color
    let role: TranscriptProseRole
    let fillsAvailableWidth: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(display.segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .prose(let text):
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        TranscriptFormattedMessageText(text: trimmed, tint: tint, role: role,
                                                       fillsAvailableWidth: fillsAvailableWidth)
                    }
                case .inline(let lines):
                    PromptInlineText(lines: lines, role: role)
                        .frame(maxWidth: fillsAvailableWidth ? .infinity : nil, alignment: .leading)
                }
            }
        }
    }
}

/// Lines holding chips, as one `Text`: each text piece through the transcript's inline markdown, each chip as its
/// image, baseline-aligned on the prose's descender.
struct PromptInlineText: View {
    let lines: [[PromptInlinePiece]]
    let role: TranscriptProseRole

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    /// Bumped when a chip's thumbnail or icon lands, so the chip is drawn again with it.
    @State private var artVersion = 0

    var body: some View {
        let metrics = transcriptProseMetrics(role)
        let font = transcriptProseFont(role, size: metrics.bodySize, weight: .regular)
        let size = AttachmentChipSize.inline(for: font)
        let _ = artVersion
        var text = Text(verbatim: "")
        for (index, line) in lines.enumerated() {
            if index > 0 { text = Text("\(text)\n") }
            for piece in line {
                switch piece {
                case .text(let words):
                    let styled = Text(MessageTextFormatter.chatInlineAttributedString(
                        words, colorScheme: colorScheme, baseFont: font,
                        codeFont: Typography.monoNS(ofSize: metrics.codeSize(for: metrics.bodySize)),
                        lineSpacing: metrics.lineSpacing))
                    text = Text("\(text)\(styled)")
                case .chip(let model):
                    let image = AttachmentChipImages.image(for: model, size: size, dark: colorScheme == .dark,
                                                           scale: displayScale,
                                                           didLoad: { artVersion &+= 1 })
                    let chip = Text(Image(nsImage: image)).baselineOffset(AttachmentChipSize.baselineOffset(for: font))
                    text = Text("\(text)\(chip)")
                }
            }
        }
        return text
            .lineSpacing(metrics.lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(accessibilityText)
    }

    /// What VoiceOver reads: the words, each chip as "image attachment, name".
    private var accessibilityText: String {
        lines.map { line in
            line.map { piece -> String in
                switch piece {
                case .text(let words): return words
                case .chip(let model): return attachmentChipAccessibilityLabel(model, shownName: model.name)
                }
            }.joined()
        }.joined(separator: "\n")
    }
}
