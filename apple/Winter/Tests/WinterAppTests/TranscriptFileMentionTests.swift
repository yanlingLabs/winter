import AppKit
import SwiftUI
import XCTest
@testable import Winter

/// Transcript file links (2026-09-30): the pure pieces behind a reply's clickable paths and image
/// thumbnails — `ChatContent/TranscriptFileMentions.swift` and the inline formatter's `fileLink`.
final class TranscriptFileMentionTests: XCTestCase {

    // MARK: - Normalising one token

    func testPathShapesThatAreCandidates() {
        let accepted: [(String, String)] = [
            ("/Users/me/a.png", "/Users/me/a.png"),
            ("~/Desktop/shot.jpg", "~/Desktop/shot.jpg"),
            ("./src/a.ts", "./src/a.ts"),
            ("../lib/b.swift", "../lib/b.swift"),
            ("src/app/main.swift", "src/app/main.swift"),
            ("README.md", "README.md"),
            ("/private/var/folders/x/T/winter-session-s_1/images/image_1.png",
             "/private/var/folders/x/T/winter-session-s_1/images/image_1.png"),
        ]
        for (raw, path) in accepted {
            XCTAssertEqual(transcriptNormalizedPathCandidate(raw)?.path, path, raw)
        }
    }

    func testShapesThatAreNotPaths() {
        for raw in ["", "https://example.com/a.png", "//host/share/a.png", "src/", "/tmp/dir/",
                    "v1.2", "3.14", "~alice/a.txt", "~", "12:30", "hello", "1/2", ".", ".."] {
            XCTAssertNil(transcriptNormalizedPathCandidate(raw), "\(raw) must not be a path candidate")
        }
    }

    func testALineSuffixIsSplitOffAndAFileURLIsDecoded() {
        let withLine = transcriptNormalizedPathCandidate("/repo/a.ts:12")
        XCTAssertEqual(withLine?.path, "/repo/a.ts")
        XCTAssertEqual(withLine?.line, 12)
        let withColumn = transcriptNormalizedPathCandidate("src/a.ts:40:7")
        XCTAssertEqual(withColumn?.path, "src/a.ts")
        XCTAssertEqual(withColumn?.line, 40)
        XCTAssertEqual(transcriptNormalizedPathCandidate("file:///Users/me/My%20Pics/a.png")?.path,
                       "/Users/me/My Pics/a.png")
    }

    // MARK: - Finding paths in prose

    private func texts(_ run: String) -> [String] {
        transcriptPathMentions(inRun: run).map { String(run[$0.range]) }
    }

    func testProsePathsAreFoundWithSurroundingPunctuationStripped() {
        let run = "Saved to /tmp/out.png, then edited (./src/a.swift:3). See \"docs/guide.md\"."
        XCTAssertEqual(texts(run), ["/tmp/out.png", "./src/a.swift:3", "docs/guide.md"])
        let mentions = transcriptPathMentions(inRun: run)
        XCTAssertEqual(mentions.map(\.path), ["/tmp/out.png", "./src/a.swift", "docs/guide.md"])
        XCTAssertEqual(mentions[1].line, 3)
    }

    func testATrailingColonIsPunctuationButALineNumberSurvives() {
        XCTAssertEqual(texts("wrote it to /tmp/a.png: done"), ["/tmp/a.png"])
        XCTAssertEqual(texts("look at /tmp/a.ts:12: there"), ["/tmp/a.ts:12"])
    }

    func testPlainWordsAreNotCandidates() {
        XCTAssertEqual(texts("I will check it now and report back"), [])
    }

    // MARK: - Code spans and link targets

    func testACodeSpanLinksWholeEvenWithSpacesWhenAbsolute() {
        XCTAssertEqual(transcriptCodeSpanPathCandidate("/Users/me/Xcode progects/Norma v2/a.swift")?.path,
                       "/Users/me/Xcode progects/Norma v2/a.swift")
        XCTAssertEqual(transcriptCodeSpanPathCandidate(" ~/My Pics/a.png ")?.path, "~/My Pics/a.png")
        XCTAssertNil(transcriptCodeSpanPathCandidate("ls src/a.ts"),
                     "a relative span with spaces is a command, not one path")
        XCTAssertEqual(transcriptPathMentions(inRun: "ls src/a.ts").map(\.path), ["src/a.ts"],
                       "…whose path token still links on its own")
    }

    func testMarkdownLinkTargets() {
        XCTAssertEqual(transcriptLinkTargetPathCandidate("/a/b.png")?.path, "/a/b.png")
        XCTAssertEqual(transcriptLinkTargetPathCandidate("</a b/c.png>")?.path, "/a b/c.png")
        XCTAssertEqual(transcriptLinkTargetPathCandidate("/a/c.png \"a title\"")?.path, "/a/c.png")
        XCTAssertEqual(transcriptLinkTargetPathCandidate("/a%20b/c.png")?.path, "/a b/c.png")
        XCTAssertEqual(transcriptLinkTargetPathCandidate("file:///a%20b/c.png")?.path, "/a b/c.png")
        let anchored = transcriptLinkTargetPathCandidate("src/a.ts#L12")
        XCTAssertEqual(anchored?.path, "src/a.ts")
        XCTAssertEqual(anchored?.line, 12)
        XCTAssertNil(transcriptLinkTargetPathCandidate("https://example.com/a.png"))
    }

    // MARK: - A whole reply's candidates

    func testCandidatesSkipFencedCodeAndMathAndDeduplicate() {
        let reply = """
        Here is `/tmp/a.png` and /tmp/a.png again, plus [the doc](/tmp/doc.md).

        ```
        /tmp/in-a-fence.png
        ```

        **bold /tmp/b.jpg** and $x/y.z$ math.
        """
        let candidates = transcriptFileMentionCandidates(in: reply)
        XCTAssertEqual(candidates, ["/tmp/a.png", "/tmp/doc.md", "/tmp/b.jpg"])
    }

    func testCandidatesAreCapped() {
        let reply = (0..<200).map { "/tmp/f\($0).txt" }.joined(separator: " ")
        XCTAssertEqual(transcriptFileMentionCandidates(in: reply).count, transcriptFileMentionCandidateCap)
    }

    /// The renderer and the extractor walk the same tokens: everything the renderer asks the door
    /// about is something the view resolved.
    func testTheRendererAsksAboutExactlyTheExtractedCandidates() {
        let reply = "See `/tmp/a b/c.png`, *src/x.ts* and [doc](</tmp/d e.md>) or ~/f.gif."
        var asked: [String] = []
        _ = MessageTextFormatter.chatInlineAttributedString(reply, colorScheme: .light,
                                                            fileLink: { asked.append($0); return nil })
        XCTAssertEqual(Set(asked), Set(transcriptFileMentionCandidates(in: reply)))
        XCTAssertTrue(asked.contains("/tmp/a b/c.png"))
        XCTAssertTrue(asked.contains("/tmp/d e.md"))
    }

    // MARK: - Resolution

    func testResolution() {
        let home = "/Users/me"
        XCTAssertEqual(transcriptResolvedMentionPath("/a/./b/../c.png", baseDirectory: nil, homeDirectory: home),
                       "/a/c.png")
        XCTAssertEqual(transcriptResolvedMentionPath("/private/var/folders/x/a.png", baseDirectory: nil,
                                                     homeDirectory: home),
                       "/private/var/folders/x/a.png", "/private is never stripped")
        XCTAssertEqual(transcriptResolvedMentionPath("~/Desktop/a.png", baseDirectory: nil, homeDirectory: home),
                       "/Users/me/Desktop/a.png")
        XCTAssertEqual(transcriptResolvedMentionPath("src/a.ts", baseDirectory: "/repo", homeDirectory: home),
                       "/repo/src/a.ts")
        XCTAssertEqual(transcriptResolvedMentionPath("../other/a.ts", baseDirectory: "/repo/app",
                                                     homeDirectory: home),
                       "/repo/other/a.ts")
        XCTAssertNil(transcriptResolvedMentionPath("src/a.ts", baseDirectory: nil, homeDirectory: home),
                     "a relative path with nothing to resolve against is left as text")
    }

    // MARK: - Which files may link

    func testAnImageAlwaysLinksAndAnythingElseNeedsAWorkingDirectory() {
        for image in ["/t/a.png", "/t/a.JPG", "/t/a.heic", "/t/a.webp", "/t/a.gif"] {
            XCTAssertTrue(transcriptFileMentionIsClickable(absolutePath: image, sessionHasWorkingDirectory: false),
                          "\(image): the image viewer needs no working directory")
        }
        for other in ["/t/a.ts", "/t/a.docx", "/t/a.svg", "/t/Makefile"] {
            XCTAssertFalse(transcriptFileMentionIsClickable(absolutePath: other, sessionHasWorkingDirectory: false),
                           "\(other) would open a tab that can only say there is no working directory")
            XCTAssertTrue(transcriptFileMentionIsClickable(absolutePath: other, sessionHasWorkingDirectory: true))
        }
    }

    func testFileLinksAnswerOnlyForExistingClickableFilesAndDeduplicateImages() {
        let links = TranscriptFileLinks(baseDirectory: "/repo", homeDirectory: "/Users/me",
                                        sessionHasWorkingDirectory: false,
                                        existingFiles: ["/repo/shot.png", "/repo/a.ts", "/tmp/b.jpg"])
        XCTAssertEqual(links.url(forCandidate: "shot.png").flatMap(transcriptFileLinkPath(from:)),
                       "/repo/shot.png")
        XCTAssertNil(links.url(forCandidate: "a.ts"), "code without a working directory stays text")
        XCTAssertNil(links.url(forCandidate: "/tmp/missing.png"), "a file that does not exist stays text")
        XCTAssertEqual(links.images(among: ["shot.png", "/repo/shot.png", "a.ts", "/tmp/b.jpg", "/x.png"]),
                       ["/repo/shot.png", "/tmp/b.jpg"])
        let many = TranscriptFileLinks(baseDirectory: nil, homeDirectory: "/h", sessionHasWorkingDirectory: true,
                                       existingFiles: Set((0..<10).map { "/i/\($0).png" }))
        XCTAssertEqual(many.images(among: (0..<10).map { "/i/\($0).png" }).count,
                       transcriptFileMentionThumbnailCap)
    }

    // MARK: - The link URL

    func testTheLinkURLRoundTripsEveryPath() {
        for path in ["/Users/me/Xcode progects/Norma v2/a.swift", "/tmp/a#b?c%d.png", "/tmp/Ünïcødé 图.png",
                     "/private/var/folders/x/T/winter-session-s_1/images/image_1.png"] {
            guard let url = transcriptFileLinkURL(forAbsolutePath: path) else {
                return XCTFail("\(path) produced no URL")
            }
            XCTAssertEqual(url.scheme, transcriptFileLinkScheme)
            XCTAssertEqual(transcriptFileLinkPath(from: url), path)
        }
        XCTAssertNil(transcriptFileLinkURL(forAbsolutePath: "relative/a.png"))
        XCTAssertNil(transcriptFileLinkPath(from: URL(string: "https://example.com/a.png")!))
        XCTAssertNil(transcriptFileLinkPath(from: URL(fileURLWithPath: "/tmp/a.png")))
    }

    // MARK: - The renderer

    private func linkedTexts(_ attributed: AttributedString) -> [(String, URL)] {
        attributed.runs.compactMap { run in
            run.link.map { (String(attributed[run.range].characters), $0) }
        }
    }

    /// The `.link` must survive the NSAttributedString → AttributedString conversion SwiftUI's `Text`
    /// reads — the step that would fail silently.
    func testAPathInProseCarriesTheLinkOverExactlyItsOwnCharacters() {
        let url = transcriptFileLinkURL(forAbsolutePath: "/tmp/out.png")!
        let attributed = MessageTextFormatter.chatInlineAttributedString(
            "Saved it to /tmp/out.png.", colorScheme: .light,
            fileLink: { $0 == "/tmp/out.png" ? url : nil })
        let linked = linkedTexts(attributed)
        XCTAssertEqual(linked.map(\.0), ["/tmp/out.png"])
        XCTAssertEqual(linked.first?.1, url)
        XCTAssertEqual(String(attributed.characters), "Saved it to /tmp/out.png.", "no character changes")
    }

    func testACodeSpanAndAMarkdownLinkLabelCarryTheLink() {
        let url = transcriptFileLinkURL(forAbsolutePath: "/a b/c.swift")!
        let attributed = MessageTextFormatter.chatInlineAttributedString(
            "Edit `/a b/c.swift` or open [the file](</a b/c.swift>).", colorScheme: .light,
            fileLink: { $0 == "/a b/c.swift" ? url : nil })
        XCTAssertEqual(linkedTexts(attributed).map(\.0), ["/a b/c.swift", "the file"])
    }

    /// The session-temp-dir path the primary use case produces carries underscores; in prose they
    /// used to open italics mid-path, eating the underscores and splitting the link.
    func testAnUnderscoredPathInProseKeepsItsCharactersAndLinksWhole() {
        let path = "/private/var/folders/x/T/winter-session-s_1/images/image_1.png"
        let url = transcriptFileLinkURL(forAbsolutePath: path)!
        let attributed = MessageTextFormatter.chatInlineAttributedString(
            "The image is at \(path) now.", colorScheme: .light,
            fileLink: { $0 == path ? url : nil })
        XCTAssertEqual(String(attributed.characters), "The image is at \(path) now.")
        XCTAssertEqual(linkedTexts(attributed).map(\.0), [path])
        XCTAssertEqual(transcriptFileMentionCandidates(in: "The image is at \(path) now."), [path])
    }

    func testUnderscoreEmphasisStillWorksAtWordBoundaries() {
        let italic = MessageTextFormatter.chatInlineAttributedString("an _emphasised_ word and a snake_case_name",
                                                                     colorScheme: .light)
        XCTAssertEqual(String(italic.characters), "an emphasised word and a snake_case_name",
                       "boundary underscores still emphasise; intraword ones are literal")
    }

    func testNoDoorAndADoorThatLinksNothingRenderIdentically() {
        let text = "See `/tmp/a.png`, **src/b.ts** and [x](/tmp/c.md) then /tmp/d.jpg."
        let plain = MessageTextFormatter.chatInlineAttributedString(text, colorScheme: .dark)
        let unlinked = MessageTextFormatter.chatInlineAttributedString(text, colorScheme: .dark,
                                                                       fileLink: { _ in nil })
        XCTAssertEqual(plain, unlinked)
        XCTAssertTrue(linkedTexts(plain).isEmpty)
    }

    // MARK: - Existence

    @MainActor
    func testTheExistenceCacheAnswersRegularFilesOnly() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("transcript-file-mentions-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("a.png").path
        let folder = dir.appendingPathComponent("folder.png").path
        FileManager.default.createFile(atPath: file, contents: Data([1, 2, 3]))
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let missing = dir.appendingPathComponent("missing.png").path

        let cache = TranscriptFileExistenceCache.shared
        cache.removeAllForTesting()
        XCTAssertEqual(cache.knownFiles(among: [file]), [], "nothing is known before a stat")
        let files = await cache.files(among: [file, folder, missing])
        XCTAssertEqual(files, [file])
        XCTAssertEqual(cache.knownFiles(among: [file, folder, missing]), [file],
                       "the synchronous answer a recycled row draws from")
        cache.removeAllForTesting()
    }

    // MARK: - Thumbnail geometry

    func testThumbnailSizeFitsTheBoxKeepsAspectAndNeverUpscales() {
        XCTAssertEqual(transcriptThumbnailSize(for: CGSize(width: 1920, height: 1080)),
                       CGSize(width: 240, height: 135))
        XCTAssertEqual(transcriptThumbnailSize(for: CGSize(width: 1000, height: 2000)),
                       CGSize(width: 80, height: 160))
        XCTAssertEqual(transcriptThumbnailSize(for: CGSize(width: 64, height: 32)),
                       CGSize(width: 64, height: 32), "a small image is not blown up")
        XCTAssertEqual(transcriptThumbnailSize(for: CGSize(width: 4000, height: 20)).height, 24,
                       "a sliver keeps something to click")
    }
}
