import AppKit
import XCTest
import WinterKit
@testable import Winter

/// Code-mode image input (2026-09-29): the composer's placeholder bookkeeping, the one submit-time
/// substitution helper, the pasteboard reading, and the adapter's attach gate (code sessions only,
/// the exact refusal for a text-only model, the size cap).
@MainActor
final class ComposerImagesTests: XCTestCase {
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 16])

    // MARK: - Placeholders and substitution

    func testTheExactStrings() {
        XCTAssertEqual(ComposerImageDraft.token(1), "[Image #1]")
        XCTAssertEqual(composerImageUnsupportedMessage, "The selected model doesn't support images")
    }

    func testNumbersClimbPerDraftAndAreNeverReused() {
        var draft = ComposerImageDraft()
        XCTAssertEqual(draft.add(ComposerImage(data: png, mediaType: "image/png")), 1)
        XCTAssertEqual(draft.add(ComposerImage(data: jpeg, mediaType: "image/jpeg")), 2)
        // The user deletes #1's placeholder: its number is still never handed out again.
        XCTAssertEqual(draft.referencedNumbers(in: "only [Image #2]"), [2])
        XCTAssertEqual(draft.add(ComposerImage(data: png, mediaType: "image/png")), 3)
        XCTAssertEqual(ComposerImageDraft().nextNumber, 1, "a fresh draft starts again at #1")
    }

    func testTokenNumbersAreFirstAppearanceOrderEachOnce() {
        XCTAssertEqual(composerImageTokenNumbers(in: "a [Image #2] b [Image #1] [Image #2] [Image #x] [image #3]"), [2, 1])
        XCTAssertEqual(composerImageTokenNumbers(in: "nothing here"), [])
    }

    func testSubstitutionReplacesOnlyKnownPlaceholders() {
        let out = substituteComposerImageTokens("[Image #1] vs [Image #2] vs [Image #1] ✓",
                                                paths: [1: "/t/winter-session-s/images/image_4.png"])
        XCTAssertEqual(out, "/t/winter-session-s/images/image_4.png vs [Image #2] vs /t/winter-session-s/images/image_4.png ✓")
    }

    func testResolveStagesOnlyLivePlaceholdersInOrderThenSubstitutes() async throws {
        var draft = ComposerImageDraft()
        _ = draft.add(ComposerImage(data: png, mediaType: "image/png"))
        _ = draft.add(ComposerImage(data: jpeg, mediaType: "image/jpeg"))
        _ = draft.add(ComposerImage(data: png, mediaType: "image/png"))
        var staged: [String] = []
        let text = try await resolveComposerImages("see [Image #3], then [Image #1] ([Image #9])", draft: draft) { image in
            staged.append(image.mediaType)
            return "/t/image_\(staged.count).png"
        }
        XCTAssertEqual(staged, ["image/png", "image/png"], "#2's placeholder was deleted — it is never staged")
        XCTAssertEqual(text, "see /t/image_1.png, then /t/image_2.png ([Image #9])")
        let plain = try await resolveComposerImages("no images", draft: draft) { _ in
            XCTFail("nothing to stage"); return ""
        }
        XCTAssertEqual(plain, "no images")
    }

    // MARK: - Sniffing and the pasteboard

    func testMagicBytesDecideTheType() {
        XCTAssertEqual(composerImageMediaType(of: png), "image/png")
        XCTAssertEqual(composerImageMediaType(of: jpeg), "image/jpeg")
        XCTAssertEqual(composerImageMediaType(of: Data("GIF89a..".utf8)), "image/gif")
        XCTAssertEqual(composerImageMediaType(of: Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)), "image/webp")
        XCTAssertNil(composerImageMediaType(of: Data("hello".utf8)))
    }

    private func tinyTIFF() -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return rep.tiffRepresentation!
    }

    func testTIFFDataBecomesAPNGAttachment() {
        let image = composerImage(fromImageData: tinyTIFF())
        XCTAssertEqual(image?.mediaType, "image/png")
        XCTAssertEqual(image.flatMap { composerImageMediaType(of: $0.data) }, "image/png")
        XCTAssertNil(composerImage(fromImageData: Data("not an image".utf8)))
    }

    func testPasteboardImageDataAndFiles() throws {
        let board = NSPasteboard(name: NSPasteboard.Name("winter.test.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }

        board.clearContents()
        board.setString("just text", forType: .string)
        XCTAssertNil(composerImages(from: board), "no image → AppKit's own paste")

        board.clearContents()
        board.setData(tinyTIFF(), forType: .tiff)
        XCTAssertEqual(composerImages(from: board)?.map(\.mediaType), ["image/png"])

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("winter-composer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let shot = dir.appendingPathComponent("shot.png")
        let notes = dir.appendingPathComponent("notes.txt")
        try png.write(to: shot)
        try Data("notes".utf8).write(to: notes)

        board.clearContents()
        board.writeObjects([shot as NSURL])
        XCTAssertEqual(composerImages(from: board), [ComposerImage(data: png, mediaType: "image/png")])

        board.clearContents()
        board.writeObjects([shot as NSURL, notes as NSURL])
        XCTAssertNil(composerImages(from: board), "any non-image file hands the whole paste back to AppKit")
    }

    // MARK: - The adapter's attach gate

    private func catalogue(supportsImages: Bool) -> SyncConfigSnapshot {
        SyncConfigSnapshot(provider: "anthropic", defaultModel: "anthropic/claude-sonnet-5-5",
                           models: [SyncConfigModelInfo(id: "anthropic/claude-sonnet-5-5", providerId: "anthropic",
                                                        displayName: "Claude Sonnet 5.5", facingName: "sonnet", efforts: [],
                                                        supportsImages: supportsImages)],
                           defaultEffort: "", clientEfforts: [])
    }

    private func adapter(mode: String?, model: String? = "anthropic/claude-sonnet-5-5", images: Bool = true,
                         hasRow: Bool = true) -> FieldStateAdapter {
        let a = FieldStateAdapter(session: SessionModel())
        let row = SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global", cwd: "/repo",
                                 mode: mode, model: model)
        a.currentSessionRow = { hasRow ? row : nil }
        a.modelCatalogue = catalogue(supportsImages: images)
        return a
    }

    func testIntakeIsLiveOnlyForACodeSessionAndFailsClosed() {
        // The intake holds its adapter weakly (as a view's render does), so each is kept alive here.
        func enabled(_ a: FieldStateAdapter) -> Bool { withExtendedLifetime(a) { a.composerImageIntake.isEnabled() } }
        XCTAssertTrue(enabled(adapter(mode: nil)), "an absent mode is code")
        XCTAssertTrue(enabled(adapter(mode: "code")))
        XCTAssertFalse(enabled(adapter(mode: "chat")))
        XCTAssertFalse(enabled(adapter(mode: "dispatch")))
        XCTAssertFalse(enabled(adapter(mode: "code", hasRow: false)), "a row not loaded yet is no intake — never a guess")
        XCTAssertFalse(enabled(FieldStateAdapter(session: SessionModel())),
                       "an unwired surface (the orb's field) never takes images")
    }

    func testAttachInsertsTheNextPlaceholder() {
        let a = adapter(mode: "code")
        XCTAssertEqual(a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png")), "[Image #1]")
        XCTAssertEqual(a.composerImageIntake.attach(ComposerImage(data: jpeg, mediaType: "image/jpeg")), "[Image #2]")
        XCTAssertNil(a.composerNotice)
    }

    func testATextOnlyModelRefusesAtAttachTimeWithTheExactMessage() {
        let a = adapter(mode: "code", images: false)
        XCTAssertNil(a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png")))
        XCTAssertEqual(a.composerNotice, "The selected model doesn't support images")
        XCTAssertTrue(a.composerImages.isEmpty)
        // An optimistic switch to a model the catalogue says takes images is honoured at once.
        a.modelCatalogue = SyncConfigSnapshot(provider: "x", defaultModel: "",
            models: [SyncConfigModelInfo(id: "x/text", providerId: "x", displayName: "T", facingName: nil, efforts: [], supportsImages: false),
                     SyncConfigModelInfo(id: "x/vision", providerId: "x", displayName: "V", facingName: nil, efforts: [], supportsImages: true)],
            defaultEffort: "", clientEfforts: [])
        a.pendingModel = .value("x/vision")
        XCTAssertEqual(a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png")), "[Image #1]")
        XCTAssertNil(a.composerNotice, "a successful attach clears the notice")
    }

    func testAnUnlistedModelIsLeftToTheDaemon() {
        let a = adapter(mode: "code", model: "somewhere/unlisted")
        XCTAssertEqual(a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png")), "[Image #1]")
    }

    func testOverTheCapIsRefused() {
        let a = adapter(mode: "code")
        var big = png
        big.append(Data(count: composerImageMaxBytes))
        XCTAssertNil(a.composerImageIntake.attach(ComposerImage(data: big, mediaType: "image/png")))
        XCTAssertEqual(a.composerNotice, composerImageTooLargeMessage)
    }

    func testComposerTextForSendSubstitutesOrRefusesWithTheDaemonsSentence() async {
        let a = adapter(mode: "code")
        _ = a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png"))
        let sent = await a.composerTextForSend("look [Image #1]") { image in
            XCTAssertEqual(image.mediaType, "image/png")
            return "/t/image_1.png"
        }
        XCTAssertEqual(sent, "look /t/image_1.png")
        let refused = await a.composerTextForSend("look [Image #1]") { _ in
            throw RpcError(code: -32602, message: "The selected model doesn't support images")
        }
        XCTAssertNil(refused, "a refusal sends nothing")
        XCTAssertEqual(a.composerNotice, "The selected model doesn't support images")
        a.resetComposerImages()
        XCTAssertTrue(a.composerImages.isEmpty)
        XCTAssertNil(a.composerNotice)
    }
}
