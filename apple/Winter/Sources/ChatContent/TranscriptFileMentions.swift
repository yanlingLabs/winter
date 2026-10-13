import AppKit
import SwiftUI

// MARK: - Transcript file links (2026-09-30, widened 2026-10-13)
//
// A path the ASSISTANT names in its reply — bare in prose, in an inline `code` span (inside **bold** or
// *italics* too), or as a markdown link's target — becomes a link when it names a file or folder that
// EXISTS. An image named in the reply that no `read` of the same turn already showed also draws a small
// thumbnail under the reply (the read ones show beside their tool row). Tool rows (their own door,
// `ToolRunCallDetailText`) and the user's own bubble are untouched.
//
// The door is the same injected closure the tool rows use (`WindowContentView.onOpenFile`): this
// file names no panel type and no host method, so the reply stays usable in the view's other two
// homes (the orb's morph window and detached windows), where the closure is `nil` and every reply
// renders exactly as it did before.
//
// The rules:
//  * **Only paths that EXIST are linked.** Candidates are cheap to find and over-inclusive on
//    purpose ("and/or", "e.g"); a stat, off the main thread and cached, is what decides — file or
//    folder.
//  * **A relative name links only when it maps to exactly ONE existing path** — resolved against the
//    session's working directory and the directories the turn has named (its attachments, its tool
//    calls' paths, the folders and files this reply names absolutely). Two matches is a guess, and a
//    guess stays text.
//  * **Finished replies only.** The streaming row is never linkified — no stat storm per delta; the
//    moment a round ends its reply renders as a new row and resolves once.
//  * **What a click does** (`transcriptFileLinkAction`): an image, or any file in a session with a
//    working directory, opens in the panel (the door); a folder opens in Finder (the composer folder
//    chip's gesture); any other file — the editor needs a working directory — is revealed in Finder.

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
/// At most this many directories a relative name is tried against (the working directory first) — the
/// stat fan-out of one reply is bounded by this times `transcriptFileMentionCandidateCap`.
let transcriptFileMentionBaseDirectoryCap = 12

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
/// (`./…`, `../…`), a relative path with a directory (`src/a.ts`), a bare file name with an
/// extension (`README.md`), or any of these naming a FOLDER with a trailing `/` (`~/Downloads/x/`,
/// `src/`) — the slash is dropped, the stat decides. A `file://` URL is decoded to its path; any other
/// `scheme://` is not a file. A `:line` or `:line:col` suffix is split off into `line`.
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
          !candidate.contains(where: { $0.isNewline }) else {
        return nil
    }
    // A folder's trailing slash: dropped, and remembered — a token that ends in one is path-shaped.
    var namesFolder = false
    while candidate.count > 1, candidate.hasSuffix("/") {
        candidate.removeLast()
        namesFolder = true
    }
    guard candidate != "/", !candidate.hasSuffix("/") else { return nil }
    let name = (candidate as NSString).lastPathComponent
    guard !name.isEmpty, name != ".", name != "..", name != "~" else { return nil }
    if candidate.hasPrefix("/") || candidate.hasPrefix("~/")
        || candidate.hasPrefix("./") || candidate.hasPrefix("../") {
        return (candidate, line)
    }
    // `~user/…` and bare `~` are not paths this door resolves.
    guard !candidate.hasPrefix("~") else { return nil }
    guard candidate.contains(where: { $0.isLetter }) else { return nil }
    if candidate.contains("/") || namesFolder { return (candidate, line) }
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
/// spaces link (`` `/Users/me/Xcode projects/app/a.swift` ``, `` `C.C. Pizza Time Collage.png` ``). A
/// span with spaces links whole when it is absolute or home-relative, or a bare file name (no `/`,
/// with an extension); `` `ls src/a.ts` `` is a command, and its path tokens are found by
/// `transcriptPathMentions(inRun:)` instead.
func transcriptCodeSpanPathCandidate(_ content: String) -> (path: String, line: Int?)? {
    let trimmed = content.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, let candidate = transcriptNormalizedPathCandidate(trimmed) else { return nil }
    if candidate.path.contains(where: { $0.isWhitespace }),
       !(candidate.path.hasPrefix("/") || candidate.path.hasPrefix("~/")) {
        let isBareName = !candidate.path.contains("/")
            && transcriptPathHasFileExtension((candidate.path as NSString).lastPathComponent)
        return isBareName ? candidate : nil
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

/// What an existing path is.
enum TranscriptPathKind: Equatable {
    case file
    case directory
}

/// What a click on a linked path does.
enum TranscriptFileLinkAction: Equatable {
    /// The panel, through the injected door (`TranscriptFileDoor.open`).
    case openInPanel
    /// A folder: opened in Finder — the composer folder chip's own gesture.
    case openFolderInFinder
    /// A file the panel cannot open here (a non-image in a session with no working directory, where the
    /// editor and office surfaces refuse to stand up): selected in its Finder window.
    case revealInFinder
}

/// PURE: what a click on an existing path does. An image opens in the panel's image viewer, which needs
/// no working directory — that is what lets a session-temp-dir image (`…/winter-session-<id>/images/
/// image_1.png`) open in a chat or no-folder session; any other file opens in the panel only where the
/// session has a working directory (`editorRuntimeForCodeTab`, office's gate 4 in
/// `toolDetailIsClickablePath`), and is revealed in Finder otherwise — still a link, never a tab that can
/// only apologise. A folder opens in Finder.
func transcriptFileLinkAction(absolutePath: String, kind: TranscriptPathKind,
                              sessionHasWorkingDirectory: Bool) -> TranscriptFileLinkAction {
    switch kind {
    case .directory:
        return .openFolderInFinder
    case .file:
        return transcriptFileMentionIsImage(absolutePath) || sessionHasWorkingDirectory ? .openInPanel : .revealInFinder
    }
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

/// PURE: whether a candidate is anchored — absolute or home-relative, so it names one path whatever the
/// session's folders are. Everything else is RELATIVE and is tried against several directories.
func transcriptMentionIsAnchored(_ candidate: String) -> Bool {
    candidate.hasPrefix("/") || candidate.hasPrefix("~/")
}

/// One candidate's answer: the absolute path it names and what is there.
struct TranscriptResolvedMention: Equatable {
    let path: String
    let kind: TranscriptPathKind
}

/// PURE, the resolution recipe — two stat passes, so a relative name can resolve inside a folder the SAME
/// reply names:
///   1. `anchoredPaths`: every absolute and `~/` candidate, resolved.
///   2. `baseDirectories(kinds:)`: the session's working directory, then every folder pass 1 found and every
///      found file's own folder, then the session's context directories (`contextDirectories` — attachments'
///      folders, tool calls' paths) — deduplicated, capped at `transcriptFileMentionBaseDirectoryCap`.
///   3. `relativePaths(bases:)`: every relative candidate joined to every base (`./` and `../` only to the
///      working directory — they say "here").
///   4. `resolve(kinds:)`: the answer, from both passes' stats. A relative candidate resolves only when
///      EXACTLY ONE distinct existing path came of it.
struct TranscriptMentionResolver {
    let candidates: [String]
    let baseDirectory: String?
    let contextDirectories: [String]
    let homeDirectory: String

    private var anchored: [String] { candidates.filter(transcriptMentionIsAnchored) }
    private var relative: [String] { candidates.filter { !transcriptMentionIsAnchored($0) } }

    var anchoredPaths: [String] {
        anchored.compactMap { transcriptResolvedMentionPath($0, baseDirectory: nil, homeDirectory: homeDirectory) }
    }

    func baseDirectories(kinds: [String: TranscriptPathKind]) -> [String] {
        var seen = Set<String>()
        var bases: [String] = []
        func add(_ raw: String?) {
            guard let raw, raw.hasPrefix("/"), bases.count < transcriptFileMentionBaseDirectoryCap,
                  let path = transcriptResolvedMentionPath(raw, baseDirectory: nil, homeDirectory: homeDirectory),
                  seen.insert(path).inserted else { return }
            bases.append(path)
        }
        add(baseDirectory)
        // What this reply names comes before what the session named earlier: under the cap, the reply's own
        // folders are never crowded out.
        for path in anchoredPaths {
            switch kinds[path] {
            case .directory?: add(path)
            case .file?: add((path as NSString).deletingLastPathComponent)
            case nil: break
            }
        }
        for directory in contextDirectories { add(directory) }
        return bases
    }

    /// Every path a relative candidate might be, per base.
    private func joins(_ candidate: String, bases: [String]) -> [String] {
        let hereOnly = candidate.hasPrefix("./") || candidate.hasPrefix("../")
        let tried = hereOnly ? Array(bases.prefix(baseDirectory?.hasPrefix("/") == true ? 1 : 0)) : bases
        return tried.compactMap { transcriptResolvedMentionPath(candidate, baseDirectory: $0, homeDirectory: homeDirectory) }
    }

    func relativePaths(bases: [String]) -> [String] {
        relative.flatMap { joins($0, bases: bases) }
    }

    /// Every candidate that names exactly one existing path, from `kinds` (what the stats found).
    func resolve(kinds: [String: TranscriptPathKind]) -> [String: TranscriptResolvedMention] {
        var out: [String: TranscriptResolvedMention] = [:]
        for candidate in anchored {
            guard let path = transcriptResolvedMentionPath(candidate, baseDirectory: nil, homeDirectory: homeDirectory),
                  let kind = kinds[path] else { continue }
            out[candidate] = TranscriptResolvedMention(path: path, kind: kind)
        }
        let bases = baseDirectories(kinds: kinds)
        for candidate in relative {
            let found = Set(joins(candidate, bases: bases).filter { kinds[$0] != nil })
            guard found.count == 1, let path = found.first, let kind = kinds[path] else { continue }
            out[candidate] = TranscriptResolvedMention(path: path, kind: kind)
        }
        return out
    }
}

/// Everything the renderer needs to link one reply: what each candidate resolved to, and whether the
/// session may open non-image files in the panel.
struct TranscriptFileLinks: Equatable {
    let resolved: [String: TranscriptResolvedMention]
    let sessionHasWorkingDirectory: Bool

    /// The `.link` for a candidate, or `nil` to leave it as text.
    func url(forCandidate candidate: String) -> URL? {
        resolved[candidate].flatMap { transcriptFileLinkURL(forAbsolutePath: $0.path) }
    }

    /// What a click on this path does — `nil` for a path this reply did not link.
    func action(forPath path: String) -> TranscriptFileLinkAction? {
        guard let mention = resolved.values.first(where: { $0.path == path }) else { return nil }
        return transcriptFileLinkAction(absolutePath: path, kind: mention.kind,
                                        sessionHasWorkingDirectory: sessionHasWorkingDirectory)
    }

    /// The existing images among `candidates`, resolved, deduplicated (the same picture named twice
    /// shows once), in order, leaving out `excluding` (the ones a `read` of this turn already shows),
    /// capped at `transcriptFileMentionThumbnailCap`.
    func images(among candidates: [String], excluding: Set<String> = []) -> [String] {
        var seen = excluding
        var images: [String] = []
        for candidate in candidates {
            guard let mention = resolved[candidate], mention.kind == .file,
                  transcriptFileMentionIsImage(mention.path), seen.insert(mention.path).inserted else { continue }
            images.append(mention.path)
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
/// The compact box a tool row's read image is drawn in — a row of these sits under a one-line row.
let transcriptCompactThumbnailMaxSize = CGSize(width: 96, height: 64)
/// Decoded at twice the display box, for a retina screen.
let transcriptThumbnailMaxPixelSize = 480
/// The code block's own radius family (`TranscriptCodeBlock` is 12, the user bubble 18), one step
/// tighter for something this small.
let transcriptThumbnailCornerRadius: CGFloat = 10

// MARK: The existence cache

/// What absolute paths are — a file, a folder, or nothing — stat-ed off the main thread and remembered
/// briefly: a recycled row, or the same path in the next reply, costs nothing. Positives are trusted for
/// a minute, negatives for a few seconds (the agent often names a file just before it writes it).
@MainActor
final class TranscriptFileExistenceCache {
    static let shared = TranscriptFileExistenceCache()

    private struct Entry {
        let kind: TranscriptPathKind?
        let checked: Date
    }

    private var entries: [String: Entry] = [:]
    private let positiveLifetime: TimeInterval = 60
    private let negativeLifetime: TimeInterval = 5
    private let capacity = 4096

    /// What is currently KNOWN about `paths` — synchronous, never touches disk. What a row draws on its
    /// first frame, so a recycled reply keeps its links without popping.
    func known(among paths: [String]) -> [String: TranscriptPathKind] {
        let now = Date()
        var out: [String: TranscriptPathKind] = [:]
        for path in paths {
            guard let entry = entries[path], let kind = entry.kind,
                  now.timeIntervalSince(entry.checked) < positiveLifetime else { continue }
            out[path] = kind
        }
        return out
    }

    /// What `paths` are, stat-ing whatever is unknown or expired (off the main thread). Missing paths
    /// are left out of the answer.
    func kinds(among paths: [String]) async -> [String: TranscriptPathKind] {
        let now = Date()
        let stale = Array(Set(paths.filter { path in
            guard let entry = entries[path] else { return true }
            let lifetime = entry.kind != nil ? positiveLifetime : negativeLifetime
            return now.timeIntervalSince(entry.checked) >= lifetime
        }))
        if !stale.isEmpty {
            let results = await Task.detached(priority: .utility) {
                stale.map { path -> (String, TranscriptPathKind?) in
                    var isDirectory: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
                        return (path, nil)
                    }
                    return (path, isDirectory.boolValue ? .directory : .file)
                }
            }.value
            if entries.count + results.count > capacity { entries.removeAll() }
            let checked = Date()
            for (path, kind) in results { entries[path] = Entry(kind: kind, checked: checked) }
        }
        var out: [String: TranscriptPathKind] = [:]
        for path in paths { if let kind = entries[path]?.kind { out[path] = kind } }
        return out
    }

    /// Test seam only — process-global state.
    func removeAllForTesting() { entries.removeAll() }
}

/// PURE (with its stats injected): one reply's links from the cache's SYNCHRONOUS knowledge — both
/// passes against what is already known, nothing touches the disk.
@MainActor
func transcriptKnownMentions(_ resolver: TranscriptMentionResolver,
                             cache: TranscriptFileExistenceCache? = nil) -> [String: TranscriptResolvedMention] {
    let cache = cache ?? .shared
    var kinds = cache.known(among: resolver.anchoredPaths)
    kinds.merge(cache.known(among: resolver.relativePaths(bases: resolver.baseDirectories(kinds: kinds)))) { a, _ in a }
    return resolver.resolve(kinds: kinds)
}

/// One reply's links, stat-ing what is unknown — both passes off the main thread, through the cache.
@MainActor
func transcriptResolveMentions(_ resolver: TranscriptMentionResolver,
                               cache: TranscriptFileExistenceCache? = nil) async -> [String: TranscriptResolvedMention] {
    let cache = cache ?? .shared
    let anchoredPaths = resolver.anchoredPaths
    var kinds = anchoredPaths.isEmpty ? [:] : await cache.kinds(among: anchoredPaths)
    let relativePaths = resolver.relativePaths(bases: resolver.baseDirectories(kinds: kinds))
    if !relativePaths.isEmpty {
        kinds.merge(await cache.kinds(among: relativePaths)) { a, _ in a }
    }
    return resolver.resolve(kinds: kinds)
}

// MARK: The door, as the reply receives it

/// The reply's file door: where relative paths resolve, whether non-image files may open in the panel,
/// and the injected open closure (`WindowContentView.onOpenFile`), which is called with an ABSOLUTE path.
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
    /// The turn's directories a relative name may resolve in (`TranscriptReplyContext.directories`).
    let contextDirectories: [String]
}

/// What a reply knows of its turn beyond its own text (`transcriptReplyContext`): the directories the
/// session has named so far — a relative name in the reply may resolve inside one — and the images a
/// `read` of the turn already shows beside its row (never drawn again under the reply).
struct TranscriptReplyContext: Equatable {
    var directories: [String] = []
    var readImages: Set<String> = []
}

/// How many directories a turn carries forward to the replies after it.
let transcriptSessionDirectoryCap = 8

/// PURE: the directories one exchange named, in order, each once (at most `transcriptSessionDirectoryCap`):
/// its attachments' folders (a `[File #n]` may BE a folder; every attachment's own folder), then its tool
/// calls' — each `read` path's folder, an `ls` path itself, a `write`/`edit` path's folder. Absolute only;
/// nothing is stat-ed here — a "directory" that is really a file just never resolves anything.
func transcriptExchangeDirectories(_ exchange: Exchange) -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    func add(_ path: String?) {
        guard out.count < transcriptSessionDirectoryCap, let path, path.hasPrefix("/"), path != "/",
              seen.insert(path).inserted else { return }
        out.append(path)
    }
    func parent(_ path: String) -> String { (path as NSString).deletingLastPathComponent }
    for n in exchange.promptAttachments.files.keys.sorted() {
        if let path = exchange.promptAttachments.files[n] { add(path); add(parent(path)) }
    }
    for n in exchange.promptAttachments.images.keys.sorted() {
        if let path = exchange.promptAttachments.images[n] { add(parent(path)) }
    }
    for item in exchange.activity {
        if let path = item.readPath { add(parent(path)); continue }
        guard case .tool(let name, let detail?, _, _, _, _, _) = item.kind, detail.hasPrefix("/"),
              detail.count < SessionReducer.maxToolDetailCharacters else { continue }
        switch name.lowercased() {
        case "ls": add(detail)
        case "write", "edit", "notebook_edit": add(parent(detail))
        default: break
        }
    }
    return out
}

/// PURE: the session's directories after one more exchange — `added` moved to the end (newest), each once,
/// the oldest dropped past `transcriptSessionDirectoryCap`.
func transcriptMergedDirectories(_ existing: [String], _ added: [String]) -> [String] {
    guard !added.isEmpty else { return existing }
    let fresh = Set(added)
    let merged = existing.filter { !fresh.contains($0) } + added
    return Array(merged.suffix(transcriptSessionDirectoryCap))
}

/// Carries out a link's click: the panel through the door, or Finder.
@MainActor
func transcriptPerformFileLinkAction(_ action: TranscriptFileLinkAction, path: String, door: TranscriptFileDoor) {
    switch action {
    case .openInPanel:
        door.open(path)
    case .openFolderInFinder:
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    case .revealInFinder:
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}

// MARK: Views

/// A row of thumbnails — under a reply, or (compact) under a tool row that read them — scrolling
/// sideways if it outgrows the column.
struct TranscriptImageThumbnailStrip: View {
    let paths: [String]
    var maxSize: CGSize = transcriptThumbnailMaxSize
    let onOpen: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: maxSize.height < transcriptThumbnailMaxSize.height ? 6 : 8) {
                ForEach(paths, id: \.self) { path in
                    TranscriptImageThumbnail(path: path, maxSize: maxSize, onOpen: onOpen)
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
    /// The box the picture is fitted in — `transcriptCompactThumbnailMaxSize` beside a tool row.
    var maxSize: CGSize = transcriptThumbnailMaxSize
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
                        .frame(width: transcriptThumbnailSize(for: image.size, maxSize: maxSize).width,
                               height: transcriptThumbnailSize(for: image.size, maxSize: maxSize).height)
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
                    .frame(width: maxSize.height, height: maxSize.height)
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
