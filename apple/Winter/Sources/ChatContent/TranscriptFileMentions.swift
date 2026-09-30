import AppKit
import SwiftUI

// MARK: - Transcript file links (2026-09-30)
//
// A file path the ASSISTANT names in its reply — bare in prose, in an inline `code` span, or as a
// markdown link's target — becomes a link that opens the file in the panel, and an IMAGE path also
// draws a small thumbnail under the reply. Tool rows (their own door, `ToolRunCallDetailText`) and
// the user's own bubble are untouched.
//
// The door is the same injected closure the tool rows use (`WindowContentView.onOpenFile`): this
// file names no panel type and no host method, so the reply stays usable in the view's other two
// homes (the orb's morph window and detached windows), where the closure is `nil` and every reply
// renders exactly as it did before.
//
// Three rules keep it honest:
//  * **Only files that EXIST are linked.** Candidates are cheap to find and over-inclusive on
//    purpose ("and/or", "e.g"); a stat, off the main thread and cached, is what decides. A
//    directory is not a file and is never linked.
//  * **Finished replies only.** The streaming row is never linkified — no stat storm per delta; the
//    moment a round ends its reply renders as a new row and resolves once.
//  * **A link only where the click can land.** An image opens the panel's image viewer, which needs
//    no working directory; code and office files need the session's working directory (the editor
//    and office surfaces both ride it), so in a session without one they stay plain text rather than
//    open a tab that can only say "This session has no working directory".

// MARK: Pure — finding candidates

/// One path found inside a run of text: the characters to link, and what they name.
struct TranscriptPathMention: Equatable {
    let range: Range<String.Index>
    /// The path as written, minus any `:line[:col]` suffix, a `file://` scheme or surrounding
    /// punctuation. `~` is NOT expanded here — resolution does that, against a stated home.
    let path: String
    let line: Int?
}

/// Longer than any real path a reply would name; a guard against pathological tokens.
let transcriptPathCandidateMaxLength = 1024
/// At most this many distinct candidates are resolved per reply — a reply listing a thousand paths
/// links the first 64 and leaves the rest as text, rather than stat-ing without bound.
let transcriptFileMentionCandidateCap = 64
/// At most this many thumbnails under one reply.
let transcriptFileMentionThumbnailCap = 6

/// What surrounds a path in prose and is never part of one (a backtick only reaches a plain run when
/// it is unpaired).
private let transcriptPathDelimiters: Set<Character> = ["`", "\"", "<", ">", "|"]
/// Opening punctuation stripped from a token's front: `(see`, `"quoted`, `[aside`.
private let transcriptPathLeadingStrip: Set<Character> = ["(", "[", "{", "'", "\"", "<", "*", "_"]
/// Closing punctuation stripped from a token's end: sentence punctuation, closing brackets, quotes.
/// `:` is here so "saved to /tmp/a.png:" links the path; a `:12` line suffix survives it because
/// digits are not stripped.
private let transcriptPathTrailingStrip: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]",
                                                           "}", "'", "\"", ">", "*", "_"]

private func transcriptPathIsDelimiter(_ character: Character) -> Bool {
    character.isWhitespace || transcriptPathDelimiters.contains(character)
}

/// PURE: whether `name` carries a file extension a reply would plausibly name — 1–10 alphanumeric
/// characters with at least one letter after a non-empty stem. Excludes "v1.2", "3.14", ".env".
func transcriptPathHasFileExtension(_ name: String) -> Bool {
    let ext = (name as NSString).pathExtension
    let stem = (name as NSString).deletingPathExtension
    guard !stem.isEmpty, (1...10).contains(ext.count) else { return false }
    return ext.allSatisfy { $0.isLetter || $0.isNumber } && ext.contains { $0.isLetter }
}

/// PURE: normalise one already-isolated token into a path candidate, or `nil` when it is not
/// path-shaped at all. Spaces are allowed (a code span or link target may carry them); the callers
/// decide when a token may.
///
/// Shapes accepted: absolute (`/…`, never `//…`), home-relative (`~/…`), explicitly relative
/// (`./…`, `../…`), a relative path with a directory (`src/a.ts`), or a bare file name with an
/// extension (`README.md`). A `file://` URL is decoded to its path; any other `scheme://` is not a
/// file. A trailing `/` names a directory and is refused. A `:line` or `:line:col` suffix is split
/// off into `line`.
func transcriptNormalizedPathCandidate(_ raw: String) -> (path: String, line: Int?)? {
    var candidate = raw
    if candidate.lowercased().hasPrefix("file://") {
        guard let url = URL(string: candidate), url.isFileURL, !url.path.isEmpty else { return nil }
        candidate = url.path
    }
    var line: Int?
    if let suffix = candidate.range(of: #":(\d+)(:\d+)?$"#, options: .regularExpression) {
        line = Int(candidate[suffix].dropFirst().prefix(while: \.isNumber))
        candidate = String(candidate[..<suffix.lowerBound])
    }
    guard !candidate.isEmpty, candidate.count <= transcriptPathCandidateMaxLength,
          !candidate.contains("://"), !candidate.hasPrefix("//"),
          !candidate.contains(where: { $0.isNewline }), !candidate.hasSuffix("/") else {
        return nil
    }
    let name = (candidate as NSString).lastPathComponent
    guard !name.isEmpty, name != ".", name != ".." else { return nil }
    if candidate.hasPrefix("/") || candidate.hasPrefix("~/")
        || candidate.hasPrefix("./") || candidate.hasPrefix("../") {
        return (candidate, line)
    }
    // `~user/…` and bare `~` are not paths this door resolves.
    guard !candidate.hasPrefix("~") else { return nil }
    if candidate.contains("/"), candidate.contains(where: { $0.isLetter }) { return (candidate, line) }
    if transcriptPathHasFileExtension(name) { return (candidate, line) }
    return nil
}

/// PURE: every path candidate in a run of plain text (prose, or the inside of a code span), split on
/// whitespace and quoting delimiters, surrounding punctuation stripped — each with the exact range to
/// link. Never spans whitespace: a prose path with spaces cannot be told from prose around it.
func transcriptPathMentions(inRun run: String) -> [TranscriptPathMention] {
    var mentions: [TranscriptPathMention] = []
    var index = run.startIndex
    while index < run.endIndex {
        if transcriptPathIsDelimiter(run[index]) {
            index = run.index(after: index)
            continue
        }
        var end = index
        while end < run.endIndex, !transcriptPathIsDelimiter(run[end]) { end = run.index(after: end) }
        var low = index
        var high = end
        while low < high, transcriptPathLeadingStrip.contains(run[low]) { low = run.index(after: low) }
        while high > low, transcriptPathTrailingStrip.contains(run[run.index(before: high)]) {
            high = run.index(before: high)
        }
        if low < high, let candidate = transcriptNormalizedPathCandidate(String(run[low..<high])) {
            mentions.append(TranscriptPathMention(range: low..<high, path: candidate.path,
                                                  line: candidate.line))
        }
        index = end
    }
    return mentions
}

/// PURE: an inline code span's WHOLE content as one candidate — the case that lets a path with
/// spaces link (`` `/Users/me/Xcode projects/app/a.swift` ``). A span with spaces links whole only
/// when it is absolute or home-relative; `` `ls src/a.ts` `` is a command, and its path tokens are
/// found by `transcriptPathMentions(inRun:)` instead.
func transcriptCodeSpanPathCandidate(_ content: String) -> (path: String, line: Int?)? {
    let trimmed = content.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, let candidate = transcriptNormalizedPathCandidate(trimmed) else { return nil }
    if candidate.path.contains(where: { $0.isWhitespace }),
       !(candidate.path.hasPrefix("/") || candidate.path.hasPrefix("~/")) {
        return nil
    }
    return candidate
}

/// PURE: a markdown link's `(target)` as a path candidate — `<angle bracketed>` targets (which may
/// hold spaces), an optional `"title"` dropped, percent-escapes decoded, and a `#L12` anchor taken as
/// the line. Web URLs are not files and answer `nil`.
func transcriptLinkTargetPathCandidate(_ target: String) -> (path: String, line: Int?)? {
    var value = target.trimmingCharacters(in: .whitespaces)
    if value.hasPrefix("<"), let close = value.firstIndex(of: ">") {
        value = String(value[value.index(after: value.startIndex)..<close])
    } else if let title = value.range(of: " \"") {
        value = String(value[..<title.lowerBound])
    }
    var anchorLine: Int?
    if let anchor = value.range(of: #"#L(\d+)(-L?\d+)?$"#, options: .regularExpression) {
        anchorLine = Int(value[anchor].dropFirst(2).prefix(while: \.isNumber))
        value = String(value[..<anchor.lowerBound])
    }
    if !value.lowercased().hasPrefix("file://"), value.contains("%"),
       let decoded = value.removingPercentEncoding {
        value = decoded
    }
    guard let candidate = transcriptNormalizedPathCandidate(value) else { return nil }
    return (candidate.path, candidate.line ?? anchorLine)
}

/// PURE: every distinct candidate a reply's rendered prose would ask about, in order of first
/// appearance and capped — the SAME block split the renderer makes (`FormattedMessageBlock` →
/// `FormattedMarkdownBlock`, fenced code and maths excluded, as neither is ever linked) and the SAME
/// token walk (`MessageTextFormatter.inlineFileMentionQueries`).
func transcriptFileMentionCandidates(in text: String) -> [String] {
    var seen = Set<String>()
    var ordered: [String] = []
    for block in FormattedMessageBlock.parse(text) {
        guard case .text(let content) = block.kind else { continue }
        for markdown in MessageTextFormatter.chatMarkdownBlocks(content) {
            let inline: String
            switch markdown.kind {
            case .paragraph(let text), .heading(_, let text), .bullet(let text),
                 .numbered(_, let text), .quote(let text):
                inline = text
            case .math:
                continue
            }
            for query in MessageTextFormatter.inlineFileMentionQueries(inline) where seen.insert(query).inserted {
                ordered.append(query)
                if ordered.count >= transcriptFileMentionCandidateCap { return ordered }
            }
        }
    }
    return ordered
}

// MARK: Pure — resolving and deciding

/// PURE: a candidate as an absolute, dot-free path — absolute as-is, `~/` against `homeDirectory`,
/// anything else against the session's primary working directory (`baseDirectory`; `nil` when the
/// session has none, and then a relative candidate resolves to nothing). Only `.`/`..` segments are
/// collapsed and no symlink is resolved, with one fixed exception: macOS's own `/var`, `/tmp` and
/// `/etc` links are spelled `/private/…`, the form a staged image's path takes (the daemon hands out
/// real paths), so a reply naming `/var/folders/…/image_1.png` lands on the same one panel tab.
func transcriptResolvedMentionPath(_ candidate: String, baseDirectory: String?,
                                   homeDirectory: String) -> String? {
    let raw: String
    if candidate.hasPrefix("/") {
        raw = candidate
    } else if candidate.hasPrefix("~/") {
        guard homeDirectory.hasPrefix("/") else { return nil }
        raw = (homeDirectory as NSString).appendingPathComponent(String(candidate.dropFirst(2)))
    } else {
        guard let baseDirectory, baseDirectory.hasPrefix("/") else { return nil }
        raw = (baseDirectory as NSString).appendingPathComponent(candidate)
    }
    let standardized = URL(fileURLWithPath: raw).standardized.path
    if standardized.isEmpty { return nil }
    for link in ["/var", "/tmp", "/etc"] where standardized == link || standardized.hasPrefix(link + "/") {
        return "/private" + standardized
    }
    return standardized
}

/// PURE: whether the panel shows this path as a picture — the panel's own set
/// (`panelCodeTabShowsImage`), never a second copy of it.
func transcriptFileMentionIsImage(_ absolutePath: String) -> Bool {
    panelCodeTabShowsImage(path: absolutePath)
}

/// PURE: whether an EXISTING file mentioned in a reply is offered as a link at all. An image always
/// is — the panel's image viewer needs no working directory, which is what lets a session-temp-dir
/// image (`…/winter-session-<id>/images/image_1.png`) open in a chat or no-folder session. Anything
/// else needs the session's working directory: the editor refuses to stand up without one
/// (`editorRuntimeForCodeTab`) and office rides working directories by policy
/// (`toolDetailIsClickablePath`'s gate 4) — so there a link would open a tab that can only apologise.
///
/// Stricter than the tool rows' rule for an absolute CODE path (which they offer regardless), and
/// deliberately so: a tool row names a file the agent just touched; prose names anything at all.
func transcriptFileMentionIsClickable(absolutePath: String, sessionHasWorkingDirectory: Bool) -> Bool {
    transcriptFileMentionIsImage(absolutePath) || sessionHasWorkingDirectory
}

/// The scheme a linked path rides inside the reply's `AttributedString`. Handled by the reply's own
/// `OpenURLAction` and never by the system — nothing else registers it.
let transcriptFileLinkScheme = "winter-transcript-file"

/// PURE: the `.link` URL for an absolute path. `URLComponents.path` percent-encodes what a path
/// component cannot hold (`space`, `?`, `#`, `%`), so every real path round-trips.
func transcriptFileLinkURL(forAbsolutePath path: String) -> URL? {
    guard path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
    var components = URLComponents()
    components.scheme = transcriptFileLinkScheme
    components.path = path
    return components.url
}

/// PURE: the absolute path a `transcriptFileLinkURL` carries, or `nil` for any other URL.
func transcriptFileLinkPath(from url: URL) -> String? {
    guard url.scheme == transcriptFileLinkScheme,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.path.hasPrefix("/") else {
        return nil
    }
    return components.path
}

/// Everything the renderer needs to link one reply: which candidates resolve to which files, which
/// of those exist, and whether the session may open non-image files.
struct TranscriptFileLinks: Equatable {
    let baseDirectory: String?
    let homeDirectory: String
    let sessionHasWorkingDirectory: Bool
    /// Absolute paths known to be regular files.
    let existingFiles: Set<String>

    /// The `.link` for a candidate, or `nil` to leave it as text.
    func url(forCandidate candidate: String) -> URL? {
        guard let path = transcriptResolvedMentionPath(candidate, baseDirectory: baseDirectory,
                                                       homeDirectory: homeDirectory),
              existingFiles.contains(path),
              transcriptFileMentionIsClickable(absolutePath: path,
                                               sessionHasWorkingDirectory: sessionHasWorkingDirectory)
        else { return nil }
        return transcriptFileLinkURL(forAbsolutePath: path)
    }

    /// The existing images among `candidates`, resolved, deduplicated (the same picture named twice
    /// shows once), in order, capped at `transcriptFileMentionThumbnailCap`.
    func images(among candidates: [String]) -> [String] {
        var seen = Set<String>()
        var images: [String] = []
        for candidate in candidates {
            guard let path = transcriptResolvedMentionPath(candidate, baseDirectory: baseDirectory,
                                                           homeDirectory: homeDirectory),
                  existingFiles.contains(path), transcriptFileMentionIsImage(path),
                  seen.insert(path).inserted else { continue }
            images.append(path)
            if images.count >= transcriptFileMentionThumbnailCap { break }
        }
        return images
    }
}

/// PURE: a thumbnail's frame — the image fitted inside `maxSize` (aspect preserved, never upscaled),
/// with neither edge below `minEdge` so a sliver of a banner still has something to click.
func transcriptThumbnailSize(for imageSize: CGSize,
                             maxSize: CGSize = transcriptThumbnailMaxSize,
                             minEdge: CGFloat = 24) -> CGSize {
    guard imageSize.width > 0, imageSize.height > 0 else { return maxSize }
    let scale = min(1, maxSize.width / imageSize.width, maxSize.height / imageSize.height)
    return CGSize(width: max(minEdge, (imageSize.width * scale).rounded()),
                  height: max(minEdge, (imageSize.height * scale).rounded()))
}

let transcriptThumbnailMaxSize = CGSize(width: 240, height: 160)
/// Decoded at twice the display box, for a retina screen.
let transcriptThumbnailMaxPixelSize = 480
/// The code block's own radius family (`TranscriptCodeBlock` is 12, the user bubble 18), one step
/// tighter for something this small.
let transcriptThumbnailCornerRadius: CGFloat = 10

// MARK: The existence cache

/// Which absolute paths are regular files, stat-ed off the main thread and remembered briefly — a
/// recycled row, or the same path in the next reply, costs nothing. Positives are trusted for a
/// minute, negatives for a few seconds (the agent often names a file just before it writes it).
@MainActor
final class TranscriptFileExistenceCache {
    static let shared = TranscriptFileExistenceCache()

    private struct Entry {
        let isFile: Bool
        let checked: Date
    }

    private var entries: [String: Entry] = [:]
    private let positiveLifetime: TimeInterval = 60
    private let negativeLifetime: TimeInterval = 5
    private let capacity = 4096

    /// The subset of `paths` currently KNOWN to be files — synchronous, never touches disk. What a
    /// row draws on its first frame, so a recycled reply keeps its links without popping.
    func knownFiles(among paths: [String]) -> Set<String> {
        let now = Date()
        return Set(paths.filter { path in
            guard let entry = entries[path], entry.isFile else { return false }
            return now.timeIntervalSince(entry.checked) < positiveLifetime
        })
    }

    /// The subset of `paths` that are regular files, stat-ing whatever is unknown or expired.
    func files(among paths: [String]) async -> Set<String> {
        let now = Date()
        let stale = paths.filter { path in
            guard let entry = entries[path] else { return true }
            let lifetime = entry.isFile ? positiveLifetime : negativeLifetime
            return now.timeIntervalSince(entry.checked) >= lifetime
        }
        if !stale.isEmpty {
            let results = await Task.detached(priority: .utility) {
                stale.map { path -> (String, Bool) in
                    var isDirectory: ObjCBool = false
                    let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
                    return (path, exists && !isDirectory.boolValue)
                }
            }.value
            if entries.count + results.count > capacity { entries.removeAll() }
            let checked = Date()
            for (path, isFile) in results { entries[path] = Entry(isFile: isFile, checked: checked) }
        }
        return Set(paths.filter { entries[$0]?.isFile == true })
    }

    /// Test seam only — process-global state.
    func removeAllForTesting() { entries.removeAll() }
}

// MARK: The door, as the reply receives it

/// The reply's file door: where relative paths resolve, whether non-image files may open, and the
/// injected open closure (`WindowContentView.onOpenFile`), which is called with an ABSOLUTE path.
struct TranscriptFileDoor {
    let baseDirectory: String?
    let sessionHasWorkingDirectory: Bool
    let open: (String) -> Void
}

/// What one reply's resolution answers for — see `TranscriptAssistantMessage.mentionKey`.
struct TranscriptFileMentionKey: Hashable {
    let text: String
    let baseDirectory: String?
    let sessionHasWorkingDirectory: Bool
}

// MARK: Views

/// The thumbnails under a reply — a row, scrolling sideways if it outgrows the column.
struct TranscriptImageThumbnailStrip: View {
    let paths: [String]
    let onOpen: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 8) {
                ForEach(paths, id: \.self) { path in
                    TranscriptImageThumbnail(path: path, onOpen: onOpen)
                }
            }
        }
    }
}

/// One clickable preview. Decoded off the main thread at `transcriptThumbnailMaxPixelSize`
/// (`DownsampledImageLoader`, the panel viewer's own door) and cached; a file that will not decode
/// draws nothing at all rather than a broken box.
struct TranscriptImageThumbnail: View {
    let path: String
    let onOpen: (String) -> Void

    @State private var result: DownsampledImageResult?
    @State private var isHovering = false

    /// A synchronous cache hit first, so a recycled row keeps its height instead of popping.
    private var shown: DownsampledImageResult? {
        result ?? DownsampledImageLoader.cached(path: path, maxPixelSize: transcriptThumbnailMaxPixelSize)
    }

    private var fileName: String { (path as NSString).lastPathComponent }

    var body: some View {
        Group {
            switch shown {
            case .loaded(let image, _)?:
                Button { onOpen(path) } label: {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fill)
                        .frame(width: transcriptThumbnailSize(for: image.size).width,
                               height: transcriptThumbnailSize(for: image.size).height)
                        .clipShape(RoundedRectangle(cornerRadius: transcriptThumbnailCornerRadius,
                                                    style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: transcriptThumbnailCornerRadius,
                                             style: .continuous)
                                .strokeBorder(isHovering ? Theme.accent.opacity(0.55) : Theme.hairlineElevated,
                                              lineWidth: isHovering ? 1 : 0.5)
                        )
                        .contentShape(RoundedRectangle(cornerRadius: transcriptThumbnailCornerRadius,
                                                       style: .continuous))
                }
                .buttonStyle(.plain)
                .onHover { isHovering = $0 }
                .animation(.easeOut(duration: 0.14), value: isHovering)
                .help("Open \(fileName) in the panel")
                .accessibilityLabel("Open \(fileName) in the panel")
            case .none:
                // Loading: a quiet box the size of the largest thumbnail's height, so the row does not
                // grow when the picture lands.
                RoundedRectangle(cornerRadius: transcriptThumbnailCornerRadius, style: .continuous)
                    .fill(Theme.controlSurface)
                    .frame(width: transcriptThumbnailMaxSize.height, height: transcriptThumbnailMaxSize.height)
            case .notFound?, .unreadable?:
                EmptyView()
            }
        }
        .task(id: path) {
            result = await DownsampledImageLoader.load(path: path,
                                                       maxPixelSize: transcriptThumbnailMaxPixelSize)
        }
    }
}
