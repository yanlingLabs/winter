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
        for raw in ["", "https://example.com/a.png", "//host/share/a.png", "/", "~/",
                    "v1.2", "3.14", "~alice/a.txt", "~", "12:30", "hello", "1/2", ".", "..", "1/2/"] {
            XCTAssertNil(transcriptNormalizedPathCandidate(raw), "\(raw) must not be a path candidate")
        }
    }

    /// A folder is a path too (2026-10-13): its trailing slash is dropped and the stat decides.
    func testAFolderWithATrailingSlashIsACandidate() {
        XCTAssertEqual(transcriptNormalizedPathCandidate("~/Downloads/upscayl_png_digital-art-4x_4x/")?.path,
                       "~/Downloads/upscayl_png_digital-art-4x_4x")
        XCTAssertEqual(transcriptNormalizedPathCandidate("/tmp/dir/")?.path, "/tmp/dir")
        XCTAssertEqual(transcriptNormalizedPathCandidate("src/")?.path, "src")
        XCTAssertEqual(transcriptNormalizedPathCandidate("/Users/me/Downloads")?.path, "/Users/me/Downloads")
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
        XCTAssertEqual(transcriptCodeSpanPathCandidate("C.C. Pizza Time Character Collage.png")?.path,
                       "C.C. Pizza Time Character Collage.png", "…but a bare file name with spaces is one name")
        XCTAssertNil(transcriptCodeSpanPathCandidate("git commit"), "no extension, no slash: not a name")
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

    /// The reply behind the user's report (2026-10-13): code spans inside **bold**, a folder with a
    /// trailing slash, a path with spaces, bare names listed under the folder. Each is ONE candidate now —
    /// before, bold content was split at whitespace, so only the space-free paths survived.
    func testCodeSpansInsideBoldAreWholeCandidates() {
        let reply = """
        - **`~/Desktop/Screenshot 2026-10-13 at 14.47.25.png`** (3024×1964) — a screenshot.
        - **`~/Downloads/social-preview.png`** (1280×640) — the social preview.
        - **`~/Downloads/upscayl_png_digital-art-4x_4x/`** (folder) — an output folder:
          - `C.C. Pizza Time Character Collage.png` — a collage.
          - `Unknown.png` — the same template.

        **The image set — `150315227_p7/p8/p9.jpg`** (1152×2048 each)
        """
        let candidates = transcriptFileMentionCandidates(in: reply)
        for expected in ["~/Desktop/Screenshot 2026-10-13 at 14.47.25.png", "~/Downloads/social-preview.png",
                         "~/Downloads/upscayl_png_digital-art-4x_4x", "C.C. Pizza Time Character Collage.png",
                         "Unknown.png"] {
            XCTAssertTrue(candidates.contains(expected), "\(expected) must be a candidate: \(candidates)")
        }
        // The renderer and the extractor still walk the same tokens through the nesting.
        var asked: [String] = []
        for block in MessageTextFormatter.chatMarkdownBlocks(reply) {
            if case .bullet(let text) = block.kind {
                _ = MessageTextFormatter.chatInlineAttributedString(text, colorScheme: .light,
                                                                    fileLink: { asked.append($0); return nil })
            }
        }
        XCTAssertTrue(Set(asked).isSubset(of: Set(candidates)))
        XCTAssertTrue(asked.contains("~/Desktop/Screenshot 2026-10-13 at 14.47.25.png"))
    }

    func testACodeSpanInsideBoldRendersAsCodeAndLinksWhole() {
        let url = transcriptFileLinkURL(forAbsolutePath: "/a b/c.png")!
        let attributed = MessageTextFormatter.chatInlineAttributedString(
            "**`/a b/c.png`** and *`/a b/c.png`*", colorScheme: .light,
            fileLink: { $0 == "/a b/c.png" ? url : nil })
        XCTAssertEqual(String(attributed.characters), "/a b/c.png and /a b/c.png", "the backticks are markup, not text")
        XCTAssertEqual(linkedTexts(attributed).map(\.0), ["/a b/c.png", "/a b/c.png"])
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
        XCTAssertEqual(transcriptResolvedMentionPath("/var/folders/x/a.png", baseDirectory: nil, homeDirectory: home),
                       "/private/var/folders/x/a.png", "/var lands on the staged image's own /private spelling")
        XCTAssertEqual(transcriptResolvedMentionPath("/tmp/a.png", baseDirectory: nil, homeDirectory: home),
                       "/private/tmp/a.png")
        XCTAssertEqual(transcriptResolvedMentionPath("/variable/a.png", baseDirectory: nil, homeDirectory: home),
                       "/variable/a.png", "only the whole /var component is folded")
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

    // MARK: - What a click does

    func testEveryExistingPathLinksAndTheClickFitsWhatItIs() {
        for image in ["/t/a.png", "/t/a.JPG", "/t/a.heic", "/t/a.webp", "/t/a.gif"] {
            XCTAssertEqual(transcriptFileLinkAction(absolutePath: image, kind: .file, sessionHasWorkingDirectory: false),
                           .openInPanel, "\(image): the image viewer needs no working directory")
        }
        for other in ["/t/a.ts", "/t/a.docx", "/t/a.pdf", "/t/Makefile"] {
            XCTAssertEqual(transcriptFileLinkAction(absolutePath: other, kind: .file, sessionHasWorkingDirectory: false),
                           .revealInFinder, "\(other): no working directory, so Finder rather than a tab that apologises")
            XCTAssertEqual(transcriptFileLinkAction(absolutePath: other, kind: .file, sessionHasWorkingDirectory: true),
                           .openInPanel)
        }
        XCTAssertEqual(transcriptFileLinkAction(absolutePath: "/t/dir", kind: .directory, sessionHasWorkingDirectory: true),
                       .openFolderInFinder)
    }

    // MARK: - Resolving a reply's candidates

    private func resolve(_ candidates: [String], cwd: String? = nil, context: [String] = [],
                         existing: [String: TranscriptPathKind]) -> [String: TranscriptResolvedMention] {
        let resolver = TranscriptMentionResolver(candidates: candidates, baseDirectory: cwd,
                                                 contextDirectories: context, homeDirectory: "/Users/me")
        return resolver.resolve(kinds: existing)
    }

    func testAnchoredCandidatesResolveFilesAndFolders() {
        let resolved = resolve(["~/Downloads/a.png", "~/Downloads/folder", "/tmp/b.jpg", "/missing.png"],
                               existing: ["/Users/me/Downloads/a.png": .file, "/Users/me/Downloads/folder": .directory,
                                          "/private/tmp/b.jpg": .file])
        XCTAssertEqual(resolved["~/Downloads/a.png"], TranscriptResolvedMention(path: "/Users/me/Downloads/a.png", kind: .file))
        XCTAssertEqual(resolved["~/Downloads/folder"]?.kind, .directory)
        XCTAssertEqual(resolved["/tmp/b.jpg"]?.path, "/private/tmp/b.jpg", "/tmp resolves to its /private spelling")
        XCTAssertNil(resolved["/missing.png"], "a path that does not exist stays text")
    }

    /// The report's case: bare names listed under a folder the same reply names resolve inside it.
    func testABareNameResolvesInAFolderTheReplyNames() {
        let folder = "/Users/me/Downloads/upscayl_png_digital-art-4x_4x"
        let candidates = ["~/Downloads/upscayl_png_digital-art-4x_4x", "Unknown.png",
                          "C.C. Pizza Time Character Collage.png", "150315227_p7/p8/p9.jpg"]
        let resolver = TranscriptMentionResolver(candidates: candidates, baseDirectory: nil, contextDirectories: [],
                                                 homeDirectory: "/Users/me")
        XCTAssertEqual(resolver.anchoredPaths, [folder])
        let firstPass: [String: TranscriptPathKind] = [folder: .directory]
        XCTAssertEqual(resolver.baseDirectories(kinds: firstPass), [folder])
        XCTAssertEqual(Set(resolver.relativePaths(bases: [folder])),
                       ["\(folder)/Unknown.png", "\(folder)/C.C. Pizza Time Character Collage.png",
                        "\(folder)/150315227_p7/p8/p9.jpg"])
        let resolved = resolver.resolve(kinds: firstPass.merging([
            "\(folder)/Unknown.png": .file, "\(folder)/C.C. Pizza Time Character Collage.png": .file,
        ]) { a, _ in a })
        XCTAssertEqual(resolved["Unknown.png"]?.path, "\(folder)/Unknown.png")
        XCTAssertEqual(resolved["C.C. Pizza Time Character Collage.png"]?.path,
                       "\(folder)/C.C. Pizza Time Character Collage.png")
        XCTAssertNil(resolved["150315227_p7/p8/p9.jpg"], "shorthand for three files names no one path")
    }

    func testARelativeNameThatMatchesTwoPlacesStaysText() {
        let resolved = resolve(["a.png", "b.png"], cwd: "/repo", context: ["/Users/me/Downloads"],
                               existing: ["/repo/a.png": .file, "/Users/me/Downloads/a.png": .file,
                                          "/Users/me/Downloads/b.png": .file])
        XCTAssertNil(resolved["a.png"], "two matches is a guess")
        XCTAssertEqual(resolved["b.png"]?.path, "/Users/me/Downloads/b.png", "one match in the turn's folders links")
    }

    func testRelativeResolutionAgainstTheWorkingDirectoryAndDotPaths() {
        let resolved = resolve(["src/a.ts", "./b.ts", "../c.ts"], cwd: "/repo/app", context: ["/elsewhere"],
                               existing: ["/repo/app/src/a.ts": .file, "/repo/app/b.ts": .file,
                                          "/elsewhere/b.ts": .file, "/repo/c.ts": .file])
        XCTAssertEqual(resolved["src/a.ts"]?.path, "/repo/app/src/a.ts")
        XCTAssertEqual(resolved["./b.ts"]?.path, "/repo/app/b.ts", "./ means the working directory only")
        XCTAssertEqual(resolved["../c.ts"]?.path, "/repo/c.ts")
        XCTAssertNil(resolve(["src/a.ts"], existing: ["/repo/app/src/a.ts": .file])["src/a.ts"],
                     "a relative path with nothing to resolve against is left as text")
    }

    func testFileLinksAnswerTheirURLsAndDeduplicateImages() {
        let links = TranscriptFileLinks(resolved: [
            "shot.png": TranscriptResolvedMention(path: "/repo/shot.png", kind: .file),
            "/repo/shot.png": TranscriptResolvedMention(path: "/repo/shot.png", kind: .file),
            "a.ts": TranscriptResolvedMention(path: "/repo/a.ts", kind: .file),
            "dir": TranscriptResolvedMention(path: "/repo/dir.png", kind: .directory),
            "/tmp/b.jpg": TranscriptResolvedMention(path: "/private/tmp/b.jpg", kind: .file),
        ], sessionHasWorkingDirectory: false)
        XCTAssertEqual(links.url(forCandidate: "shot.png").flatMap(transcriptFileLinkPath(from:)), "/repo/shot.png")
        XCTAssertNotNil(links.url(forCandidate: "a.ts"), "every existing path links")
        XCTAssertEqual(links.action(forPath: "/repo/a.ts"), .revealInFinder)
        XCTAssertEqual(links.action(forPath: "/repo/dir.png"), .openFolderInFinder)
        XCTAssertNil(links.url(forCandidate: "/tmp/missing.png"))
        XCTAssertEqual(links.images(among: ["shot.png", "/repo/shot.png", "a.ts", "dir", "/tmp/b.jpg"]),
                       ["/repo/shot.png", "/private/tmp/b.jpg"], "a folder named like an image is no image")
        XCTAssertEqual(links.images(among: ["shot.png", "/tmp/b.jpg"], excluding: ["/repo/shot.png"]),
                       ["/private/tmp/b.jpg"], "an image a read of the turn shows is not drawn again")
        let many = TranscriptFileLinks(resolved: Dictionary(uniqueKeysWithValues: (0..<10).map {
            ("/i/\($0).png", TranscriptResolvedMention(path: "/i/\($0).png", kind: .file))
        }), sessionHasWorkingDirectory: true)
        XCTAssertEqual(many.images(among: (0..<10).map { "/i/\($0).png" }).count, transcriptFileMentionThumbnailCap)
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
        for run in attributed.runs where run.link != nil {
            XCTAssertEqual(run.appKit.underlineStyle, .single,
                           "a linked path is underlined in the string itself, whatever Text does")
        }
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
    func testTheExistenceCacheAnswersFilesAndFolders() async throws {
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
        XCTAssertEqual(cache.known(among: [file]), [:], "nothing is known before a stat")
        let kinds = await cache.kinds(among: [file, folder, missing])
        XCTAssertEqual(kinds, [file: .file, folder: .directory])
        XCTAssertEqual(cache.known(among: [file, folder, missing]), [file: .file, folder: .directory],
                       "the synchronous answer a recycled row draws from")
        // Both passes through the cache: a bare name inside a folder named absolutely.
        let resolver = TranscriptMentionResolver(candidates: [dir.path, "a.png"], baseDirectory: nil,
                                                 contextDirectories: [], homeDirectory: "/nowhere")
        // The resolver spells a temp dir's `/var` as `/private/var`, as the links do.
        let spelled = transcriptResolvedMentionPath(file, baseDirectory: nil, homeDirectory: "/nowhere")
        let resolved = await transcriptResolveMentions(resolver, cache: cache)
        XCTAssertEqual(resolved["a.png"]?.path, spelled)
        XCTAssertEqual(transcriptKnownMentions(resolver, cache: cache)["a.png"]?.path, spelled,
                       "a recycled row resolves the same from what is known")
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

    // MARK: - Images a read looked at (2026-10-13)

    private func readCall(_ path: String?, output: String? = "[image]", isError: Bool = false) -> ToolCallRecord {
        ToolCallRecord(callId: UUID().uuidString, detail: path, output: output, isError: isError, readPath: path)
    }

    func testAReadOfAnImageIsAnImageTheModelLookedAt() {
        XCTAssertEqual(toolCallReadImagePath(name: "read", call: readCall("/Users/me/Downloads/a.png")),
                       "/Users/me/Downloads/a.png")
        XCTAssertEqual(toolCallReadImagePath(name: "read", call: readCall("/tmp/a.png")), "/private/tmp/a.png")
        XCTAssertNil(toolCallReadImagePath(name: "read", call: readCall("/a/doc.pdf", output: "[PDF: …]")),
                     "not an image")
        XCTAssertNil(toolCallReadImagePath(name: "read", call: readCall("/a/b.png", output: nil)), "no result yet")
        XCTAssertNil(toolCallReadImagePath(name: "read", call: readCall("/a/b.png", output: "denied", isError: true)))
        XCTAssertNil(toolCallReadImagePath(name: "bash", call: readCall("/a/b.png")))
        XCTAssertNil(toolCallReadImagePath(name: "read", call: readCall(nil)), "no path, no picture (the chip stays)")
    }

    /// The report's turn: seven reads of six-plus images across three runs; each picture once, in order.
    func testARunsReadImagesAreInOrderAndOnce() {
        let run = [ToolRunEntry(name: "read", calls: [readCall("/d/p7.jpg"), readCall("/d/p8.jpg"),
                                                     readCall("/d/p7.jpg"), readCall("/d/doc.pdf", output: "[PDF]")])]
        XCTAssertEqual(toolRunReadImages(run), ["/d/p7.jpg", "/d/p8.jpg"])
        XCTAssertNil(toolRunCollapsedReadImages((0..<8).map { "/d/\($0).png" }).note, "the report's eight reads all show")
        let bounded = toolRunCollapsedReadImages((0..<15).map { "/d/\($0).png" })
        XCTAssertEqual(bounded.images.count, maxCollapsedReadImages)
        XCTAssertEqual(bounded.note, "… 3 more images — expand to see them")
        XCTAssertNil(toolRunCollapsedReadImages(["/d/a.png"]).note)
    }

    func testTheReducerKeepsAReadsWholePath() {
        let long = "/Users/me/" + String(repeating: "deep/", count: 30) + "a.png"
        XCTAssertEqual(SessionReducer.readToolPath(argsJson: #"{"file_path":"\#(long)"}"#), long,
                       "uncut, where the row's detail stops at 100 characters")
        XCTAssertNil(SessionReducer.readToolPath(argsJson: #"{"file_path":"rel/a.png"}"#))
        XCTAssertNil(SessionReducer.readToolPath(argsJson: "not json"))
    }

    func testAnExchangeNamesItsAttachmentsAndToolFolders() {
        var exchange = Exchange(prompt: "[Image #1] [File #1] what are these", reply: "")
        exchange.promptAttachments = PromptAttachments(images: [1: "/Users/me/Desktop/shot.png"],
                                                       files: [1: "/Users/me/Downloads/folder"])
        exchange.activity = [ActivityItem(kind: .tool(name: "read", detail: "/Users/me/Downloads/folder/a.png"),
                                          readPath: "/Users/me/Downloads/folder/a.png"),
                             ActivityItem(kind: .tool(name: "ls", detail: "/opt/x"))]
        XCTAssertEqual(transcriptExchangeDirectories(exchange),
                       ["/Users/me/Downloads/folder", "/Users/me/Downloads", "/Users/me/Desktop", "/opt/x"])
        XCTAssertEqual(transcriptMergedDirectories(["/a", "/b"], ["/b", "/c"]), ["/a", "/b", "/c"])
        XCTAssertEqual(transcriptMergedDirectories((0..<10).map { "/\($0)" }, []).count, 10,
                       "nothing added, nothing dropped")
        XCTAssertEqual(transcriptMergedDirectories((0..<10).map { "/\($0)" }, ["/x"]).count,
                       transcriptSessionDirectoryCap)
    }
}
