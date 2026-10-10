import AppKit
import ImageIO
import XCTest
import WinterKit
@testable import Winter
import WinterProtocol

/// Code-mode image input (2026-09-29; raw image paths 2026-10-10): the composer's placeholder
/// bookkeeping, the one submit-time substitution helper, the pasteboard reading (a FILE is its own
/// original path and is never staged; image DATA is raw unless it cannot fit one request), and the
/// adapter's attach gate (code sessions only, the exact refusal for a text-only model, the size caps).
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

    func testResolveStagesOnlyLivePlaceholdersInOrderKeepingThemAndNamingThePaths() async throws {
        var draft = ComposerImageDraft()
        _ = draft.add(ComposerImage(data: png, mediaType: "image/png"))
        _ = draft.add(ComposerImage(data: jpeg, mediaType: "image/jpeg"))
        _ = draft.add(ComposerImage(data: png, mediaType: "image/png"))
        var staged: [String] = []
        let out = try await resolveComposerImages("see [Image #3], then [Image #1] ([Image #9])", draft: draft) { image in
            staged.append(image.mediaType)
            return StagedImage(path: "/t/image_\(staged.count).png", imagesOnSend: true)
        }
        XCTAssertEqual(staged, ["image/png", "image/png"], "#2's placeholder was deleted — it is never staged")
        XCTAssertEqual(out, ComposerOutgoing(text: "see [Image #3], then [Image #1] ([Image #9])", images: [
            SessionEvent.UserMessageImageRef(n: 3, path: "/t/image_1.png"),
            SessionEvent.UserMessageImageRef(n: 1, path: "/t/image_2.png"),
        ]), "the message keeps its placeholders; only the model is given the paths")
        let plain = try await resolveComposerImages("no images", draft: draft) { _ in
            XCTFail("nothing to stage"); return StagedImage(path: "", imagesOnSend: true)
        }
        XCTAssertEqual(plain, ComposerOutgoing(text: "no images", images: []))
    }

    /// More than 20 referenced images is refused before anything is staged, with the daemon's sentence.
    func testMoreThanTwentyImagesIsRefusedBeforeStaging() async {
        let a = adapter(mode: "code")
        var text = ""
        for _ in 0..<21 { text += (a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png")) ?? "") + " " }
        var staged = 0
        let sent = await a.composerTextForSend(text) { _ in staged += 1; return StagedImage(path: "/t/x.png", imagesOnSend: true) }
        XCTAssertNil(sent, "nothing is sent")
        XCTAssertEqual(staged, 0, "nothing is staged")
        XCTAssertEqual(a.composerNotice, "A message can carry at most 20 images")
    }

    /// A daemon that predates `imagesOnSend` would silently drop `images` — so any stage answer
    /// without it sends the paths in the text, as before, with no images.
    func testResolveSubstitutesForADaemonWithoutImagesOnSend() async throws {
        var draft = ComposerImageDraft()
        _ = draft.add(ComposerImage(data: png, mediaType: "image/png"))
        _ = draft.add(ComposerImage(data: png, mediaType: "image/png"))
        var k = 0
        let out = try await resolveComposerImages("[Image #1] and [Image #2]", draft: draft) { _ in
            k += 1
            return StagedImage(path: "/t/image_\(k).png", imagesOnSend: k == 1)
        }
        XCTAssertEqual(out, ComposerOutgoing(text: "/t/image_1.png and /t/image_2.png", images: []))
    }

    // MARK: - Sniffing and the pasteboard

    func testMagicBytesDecideTheType() {
        XCTAssertEqual(composerImageMediaType(of: png), "image/png")
        XCTAssertEqual(composerImageMediaType(of: jpeg), "image/jpeg")
        XCTAssertEqual(composerImageMediaType(of: Data("GIF89a..".utf8)), "image/gif")
        XCTAssertEqual(composerImageMediaType(of: Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)), "image/webp")
        XCTAssertEqual(composerImageMediaType(of: Data("BM".utf8) + Data(count: 6)), "image/bmp")
        XCTAssertEqual(composerImageMediaType(of: Data([0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0])), "image/tiff")
        XCTAssertEqual(composerImageMediaType(of: Data([0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8])), "image/tiff")
        for brand in ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"] {
            XCTAssertEqual(composerImageMediaType(of: Data([0, 0, 0, 24]) + Data("ftyp\(brand)".utf8) + Data(count: 4)), "image/heic", brand)
        }
        // An MP4 shares the `ftyp` box but not a HEIC brand; a short header is nothing.
        XCTAssertNil(composerImageMediaType(of: Data([0, 0, 0, 24]) + Data("ftypmp42".utf8) + Data(count: 4)))
        XCTAssertNil(composerImageMediaType(of: Data([0, 0, 0, 24]) + Data("ftyphei".utf8)))
        XCTAssertNil(composerImageMediaType(of: Data("hello".utf8)))
        XCTAssertNil(composerImageMediaType(of: Data()))
    }

    private func tinyTIFF() -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return rep.tiffRepresentation!
    }

    /// RAW: pasteboard TIFF data is staged as the TIFF it is — no conversion to PNG any more.
    func testTIFFDataIsKeptRaw() {
        let tiff = tinyTIFF()
        let image = composerImage(fromImageData: tiff)
        XCTAssertEqual(image, ComposerImage(data: tiff, mediaType: "image/tiff"))
        XCTAssertNil(composerImage(fromImageData: Data("not an image".utf8)))
    }

    /// A `width`×`height` sRGB image, encoded as PNG — a gradient (compresses well) or noise (barely).
    private func generatedPNG(width: Int, height: Int, noise: Bool) -> Data {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let pixels = ctx.data!.bindMemory(to: UInt8.self, capacity: ctx.bytesPerRow * height)
        var seed: UInt32 = 0x2545F491
        for y in 0..<height {
            for x in 0..<width {
                let i = y * ctx.bytesPerRow + x * 4
                if noise {
                    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
                    pixels[i] = UInt8(seed & 0xFF); pixels[i + 1] = UInt8((seed >> 8) & 0xFF); pixels[i + 2] = UInt8((seed >> 16) & 0xFF)
                } else {
                    pixels[i] = UInt8(x * 255 / width); pixels[i + 1] = UInt8(y * 255 / height); pixels[i + 2] = 128
                }
            }
        }
        return composerEncode(ctx.makeImage()!, as: .png, quality: nil)!
    }

    private func pixelSize(_ data: Data) -> (Int, Int) {
        let props = CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(data as CFData, nil)!, 0, nil) as! [CFString: Any]
        return ((props[kCGImagePropertyPixelWidth] as! NSNumber).intValue, (props[kCGImagePropertyPixelHeight] as! NSNumber).intValue)
    }

    /// Raw means raw: a big picture that FITS one request is not decoded, resized or re-encoded.
    func testA4000By3000ImageThatFitsIsKeptByteForByte() {
        let big = generatedPNG(width: 4000, height: 3000, noise: false)
        XCTAssertLessThanOrEqual(big.count, composerImageMaxBytes)
        let image = composerImage(fromImageData: big)
        XCTAssertEqual(image, ComposerImage(data: big, mediaType: "image/png"))
        XCTAssertEqual(pixelSize(image!.imageData!.data).0, 4000, "not downscaled")
    }

    /// The over-budget fallback: ONLY an image whose bytes cannot fit one request is downscaled.
    func testAnImageOverTheRequestBudgetIsDownscaledTo1568SoItFits() {
        // 2400×2400 of noise barely compresses: ~17 MB as PNG (over the cap); even at 1568×1568 it is
        // ~7.4 MB, so only a JPEG fits.
        let noisy = generatedPNG(width: 2400, height: 2400, noise: true)
        XCTAssertGreaterThan(noisy.count, composerImageMaxBytes)
        let image = composerImage(fromImageData: noisy)
        XCTAssertEqual(image?.imageData?.mediaType, "image/jpeg")
        XCTAssertEqual(image.flatMap { $0.imageData.map { pixelSize($0.data).0 } }, 1568)
        XCTAssertLessThanOrEqual(image?.imageData?.data.count ?? .max, composerImageMaxBytes)
        XCTAssertEqual(image?.imageData.flatMap { composerImageMediaType(of: $0.data) }, "image/jpeg")
    }

    /// Over budget but a PNG fits once downscaled: it stays a PNG at a 1568 px long edge.
    func testAnOverBudgetPNGThatFitsOnceDownscaledStaysPNG() {
        let noisy = generatedPNG(width: 3000, height: 2000, noise: true) // ~18 MB; 1568×1045 noise is ~4.9 MB
        XCTAssertGreaterThan(noisy.count, composerImageMaxBytes)
        let image = composerImage(fromImageData: noisy)
        XCTAssertEqual(image?.imageData?.mediaType, "image/png")
        let size = image?.imageData.map { pixelSize($0.data) }
        XCTAssertEqual(size?.0, 1568)
        XCTAssertEqual(size?.1, 1045)
        XCTAssertLessThanOrEqual(image?.imageData?.data.count ?? .max, composerImageMaxBytes)
    }

    /// The budget is inclusive: data exactly at the cap stays raw, one byte over is the fallback's.
    func testTheCapIsInclusive() {
        var atCap = generatedPNG(width: 8, height: 8, noise: false)
        atCap.append(Data(count: composerImageMaxBytes - atCap.count))
        XCTAssertEqual(atCap.count, composerImageMaxBytes)
        XCTAssertEqual(composerImage(fromImageData: atCap), ComposerImage(data: atCap, mediaType: "image/png"), "at the cap: raw")
        let over = atCap + Data([0])
        // One byte over (trailing padding after the PNG's IEND): not raw any more — decoded and re-rendered.
        let fallback = composerImage(fromImageData: over)
        XCTAssertNotEqual(fallback, ComposerImage(data: over, mediaType: "image/png"))
        XCTAssertLessThan(fallback?.imageData?.data.count ?? .max, composerImageMaxBytes)
    }

    func testASmallImageIsKeptByteForByte() {
        let small = generatedPNG(width: 800, height: 600, noise: false)
        XCTAssertEqual(composerImage(fromImageData: small), ComposerImage(data: small, mediaType: "image/png"))
    }

    func testPasteboardImageDataAndFiles() throws {
        let board = NSPasteboard(name: NSPasteboard.Name("winter.test.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }

        board.clearContents()
        board.setString("just text", forType: .string)
        XCTAssertNil(composerImages(from: board), "no image → AppKit's own paste")

        // Image DATA comes back RAW: the TIFF as the TIFF it is, a big PNG untouched.
        board.clearContents()
        board.setData(tinyTIFF(), forType: .tiff)
        XCTAssertEqual(composerImages(from: board), [ComposerImage(data: tinyTIFF(), mediaType: "image/tiff")])
        XCTAssertTrue(composerPasteboardMayHaveImage(board))
        let bigPNG = generatedPNG(width: 3000, height: 2000, noise: false)
        board.clearContents()
        board.setData(bigPNG, forType: .png)
        XCTAssertEqual(composerImages(from: board), [ComposerImage(data: bigPNG, mediaType: "image/png")])

        // Copied cells / document text ride with an image rendering of themselves: that paste stays TEXT.
        board.clearContents()
        board.declareTypes([.string, .tiff], owner: nil)
        board.setString("Q3\t1,200\nQ4\t1,450", forType: .string)
        board.setData(tinyTIFF(), forType: .tiff)
        XCTAssertNil(composerImages(from: board))
        XCTAssertFalse(composerPasteboardMayHaveImage(board))

        // A browser's "Copy Image" can carry the image's own URL as its string: that paste is the image.
        board.clearContents()
        board.declareTypes([.string, .tiff], owner: nil)
        board.setString("https://example.com/cat.png", forType: .string)
        board.setData(tinyTIFF(), forType: .tiff)
        XCTAssertEqual(composerImages(from: board)?.map { $0.imageData?.mediaType }, ["image/tiff"])

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("winter-composer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let shot = dir.appendingPathComponent("shot.png")
        let notes = dir.appendingPathComponent("notes.txt")
        let realPNG = generatedPNG(width: 40, height: 30, noise: false)
        try realPNG.write(to: shot)
        try Data("notes".utf8).write(to: notes)

        // A FILE is its own original path — the bytes are not read into the attachment.
        board.clearContents()
        board.writeObjects([shot as NSURL])
        XCTAssertEqual(composerImages(from: board), [ComposerImage.file(path: shot.path)])

        board.clearContents()
        board.writeObjects([shot as NSURL, notes as NSURL])
        XCTAssertNil(composerImages(from: board), "any non-image file hands the whole paste back to AppKit")
    }

    // MARK: - Files: the original path, never read, copied or staged

    /// A Finder drag of a big image: the attachment is the path alone. The file here is sparse and
    /// only 12 bytes are real — reading it whole would be obvious (and slow); the attach never does.
    func testAnImageFileIsItsOwnPathAndNeverRead() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let huge = dir.appendingPathComponent("My Huge Shot.png")
        try Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]).write(to: huge)
        XCTAssertEqual(Darwin.truncate(huge.path, 40 * 1024 * 1024), 0)
        let board = privateBoard()
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([huge as NSURL])
        XCTAssertEqual(composerImages(from: board), [ComposerImage.file(path: huge.path)])
        XCTAssertEqual(composerImages(from: board)?.first?.imageData, nil, "no bytes ride along")
    }

    func testEverySupportedFileTypeIsAFileAttachmentWhateverItIsCalled() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let heic = Data([0, 0, 0, 24]) + Data("ftypheic".utf8) + Data(count: 4)
        let cases: [(String, Data)] = [("a.png", png), ("b.jpg", jpeg), ("c.gif", Data("GIF89a..".utf8)), ("d.heic", heic),
                                       ("e.tiff", Data([0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0])), ("f.bmp", Data("BM".utf8) + Data(count: 6)),
                                       ("renamed.jpeg", png)] // a PNG named .jpeg: the BYTES decide
        for (name, bytes) in cases {
            let url = dir.appendingPathComponent(name)
            try bytes.write(to: url)
            XCTAssertEqual(composerImage(fromFile: url), ComposerImage.file(path: url.path), name)
        }
    }

    func testFilesThatAreNotImagesByTheirBytesAreNotAttachments() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let text = dir.appendingPathComponent("notes.png"); try Data("plain text".utf8).write(to: text)
        let empty = dir.appendingPathComponent("empty.png"); try Data().write(to: empty)
        let folder = dir.appendingPathComponent("folder.png"); try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for url in [text, empty, folder, dir.appendingPathComponent("missing.png")] {
            XCTAssertNil(composerImage(fromFile: url), url.lastPathComponent)
        }
        // A symlink to an image is fine: the daemon judges the target.
        let real = dir.appendingPathComponent("real.png"); try png.write(to: real)
        let link = dir.appendingPathComponent("link.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertEqual(composerImage(fromFile: link), ComposerImage.file(path: link.path))
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
        XCTAssertEqual(composerImageTooLargeMessage, "The image is too large to attach")
    }

    func testAFileIsAttachedByPathAfterASizeCheckAndNeverStaged() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let shot = dir.appendingPathComponent("shot.png")
        try png.write(to: shot)
        let a = adapter(mode: "code")
        XCTAssertEqual(a.composerImageIntake.attach(.file(path: shot.path)), "[Image #1]")
        XCTAssertNil(a.composerNotice)
        // Submit: the path itself goes in `images`; nothing is staged.
        let sent = await a.composerTextForSend("look [Image #1]") { _ in XCTFail("a file is never staged"); return StagedImage(path: "", imagesOnSend: true) }
        XCTAssertEqual(sent, ComposerOutgoing(text: "look [Image #1]", images: [SessionEvent.UserMessageImageRef(n: 1, path: shot.path)]))
    }

    func testAFilePastTheRuntimesLimitOrGoneIsRefusedWithItsOwnNotice() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let exact = dir.appendingPathComponent("exact.png"); try png.write(to: exact)
        XCTAssertEqual(Darwin.truncate(exact.path, off_t(composerImageFileMaxBytes)), 0)
        let over = dir.appendingPathComponent("over.png"); try png.write(to: over)
        XCTAssertEqual(Darwin.truncate(over.path, off_t(composerImageFileMaxBytes) + 1), 0)
        let a = adapter(mode: "code")
        XCTAssertEqual(a.composerImageIntake.attach(.file(path: exact.path)), "[Image #1]", "exactly 64 MiB is inclusive")
        XCTAssertNil(a.composerImageIntake.attach(.file(path: over.path)))
        XCTAssertEqual(a.composerNotice, "Image files must be 64 MB or smaller")
        XCTAssertNil(a.composerImageIntake.attach(.file(path: dir.appendingPathComponent("gone.png").path)))
        XCTAssertEqual(a.composerNotice, composerImageFileUnreadableMessage)
        // The text-only-model refusal is the same exact message for a file.
        let text = adapter(mode: "code", images: false)
        XCTAssertNil(text.composerImageIntake.attach(.file(path: exact.path)))
        XCTAssertEqual(text.composerNotice, "The selected model doesn't support images")
    }

    /// A mixed draft: the file keeps its own path, the data is staged raw, in placeholder order; and an
    /// older daemon (no `imagesOnSend`) is sent every path, the file's included, in the text.
    func testAMixedDraftStagesOnlyTheDataAndAnOlderDaemonGetsPathsInTheText() async throws {
        var draft = ComposerImageDraft()
        _ = draft.add(.file(path: "/Users/me/My Shot.png"))
        _ = draft.add(ComposerImage(data: png, mediaType: "image/png"))
        _ = draft.add(.file(path: "/Users/me/b.heic"))
        var staged: [String] = []
        let out = try await resolveComposerImages("[Image #3] [Image #2] [Image #1]", draft: draft) { data in
            staged.append(data.mediaType)
            return StagedImage(path: "/t/image_1.png", imagesOnSend: true)
        }
        XCTAssertEqual(staged, ["image/png"], "only the clipboard data is staged")
        XCTAssertEqual(out, ComposerOutgoing(text: "[Image #3] [Image #2] [Image #1]", images: [
            SessionEvent.UserMessageImageRef(n: 3, path: "/Users/me/b.heic"),
            SessionEvent.UserMessageImageRef(n: 2, path: "/t/image_1.png"),
            SessionEvent.UserMessageImageRef(n: 1, path: "/Users/me/My Shot.png"),
        ]))
        let older = try await resolveComposerImages("[Image #1] and [Image #2]", draft: draft) { _ in StagedImage(path: "/t/image_9.png", imagesOnSend: false) }
        XCTAssertEqual(older, ComposerOutgoing(text: "/Users/me/My Shot.png and /t/image_9.png", images: []))
        // A draft of files alone stages nothing and keeps `images` (it cannot ask the daemon).
        var files = ComposerImageDraft()
        _ = files.add(.file(path: "/a.png"))
        let only = try await resolveComposerImages("[Image #1]", draft: files) { _ in XCTFail("never staged"); return StagedImage(path: "", imagesOnSend: false) }
        XCTAssertEqual(only, ComposerOutgoing(text: "[Image #1]", images: [SessionEvent.UserMessageImageRef(n: 1, path: "/a.png")]))
    }

    func testComposerTextForSendKeepsPlaceholdersOrRefusesWithTheDaemonsSentence() async {
        let a = adapter(mode: "code")
        _ = a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png"))
        let sent = await a.composerTextForSend("look [Image #1]") { image in
            XCTAssertEqual(image.mediaType, "image/png")
            return StagedImage(path: "/t/image_1.png", imagesOnSend: true)
        }
        XCTAssertEqual(sent, ComposerOutgoing(text: "look [Image #1]", images: [SessionEvent.UserMessageImageRef(n: 1, path: "/t/image_1.png")]))
        let refused = await a.composerTextForSend("look [Image #1]") { _ in
            throw RpcError(code: -32602, message: "The selected model doesn't support images")
        }
        XCTAssertNil(refused, "a refusal sends nothing")
        XCTAssertEqual(a.composerNotice, "The selected model doesn't support images")
        a.resetComposerImages()
        XCTAssertTrue(a.composerImages.isEmpty)
        XCTAssertNil(a.composerNotice)
    }

    // MARK: - Review fixes

    private func privateBoard() -> NSPasteboard {
        NSPasteboard(name: NSPasteboard.Name("winter.test.\(UUID().uuidString)"))
    }

    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("winter-composer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// An SVG conforms to `.image` but is no raster (nor is a corrupt file, whose bytes are no image's):
    /// the paste must fall through to AppKit (the path is typed), never silently do nothing.
    func testUndecodableImageFilesFallThroughToAppKit() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let svg = dir.appendingPathComponent("logo.svg")
        try Data(#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>"#.utf8).write(to: svg)
        let corrupt = dir.appendingPathComponent("broken.png")
        try Data("not really a png".utf8).write(to: corrupt)
        let good = dir.appendingPathComponent("good.png")
        try generatedPNG(width: 8, height: 8, noise: false).write(to: good)
        let board = privateBoard()
        defer { board.releaseGlobally() }
        for urls in [[svg], [corrupt], [good, svg]] {
            board.clearContents()
            board.writeObjects(urls.map { $0 as NSURL })
            XCTAssertNil(composerImages(from: board), "\(urls.map(\.lastPathComponent)) must go to AppKit")
        }
        board.clearContents()
        board.setData(Data("garbage".utf8), forType: .png)
        XCTAssertNil(composerImages(from: board), "undecodable image DATA is AppKit's too, not a silent no-op")
    }

    private func textView(intake: ComposerImageIntake) -> CommandTextView {
        let view = CommandTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        view.imageIntake = intake
        return view
    }

    /// A refused image FILE (a text-only model) still types its path — AppKit's paste runs beside the
    /// notice; an accepted one inserts its placeholder; refused image DATA is handled (nothing to type).
    func testRefusedImageFilesFallBackToAppKitsPaste() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let shot = dir.appendingPathComponent("shot.png")
        try generatedPNG(width: 8, height: 8, noise: false).write(to: shot)
        let board = privateBoard()
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([shot as NSURL])

        var refusals = 0
        let refusing = textView(intake: ComposerImageIntake(isEnabled: { true }, attach: { _ in refusals += 1; return nil }))
        XCTAssertFalse(refusing.takeComposerImages(from: board), "refused files → AppKit types the path")
        XCTAssertEqual(refusals, 1)
        XCTAssertEqual(refusing.string, "")

        let accepting = textView(intake: ComposerImageIntake(isEnabled: { true }, attach: { _ in "[Image #1]" }))
        XCTAssertTrue(accepting.takeComposerImages(from: board))
        XCTAssertEqual(accepting.string, "[Image #1]")

        board.clearContents()
        board.setData(generatedPNG(width: 8, height: 8, noise: false), forType: .png)
        XCTAssertTrue(refusing.takeComposerImages(from: board), "refused image data has no text to fall back to")

        let off = textView(intake: ComposerImageIntake(isEnabled: { false }, attach: { _ in XCTFail("never asked"); return nil }))
        XCTAssertFalse(off.takeComposerImages(from: board), "not a code session → AppKit's paste, untouched")
    }

    func testANewAttachmentNeverTakesANumberAlreadyWrittenInTheDraft() {
        var draft = ComposerImageDraft()
        XCTAssertEqual(draft.add(ComposerImage(data: png, mediaType: "image/png"), draftText: "old [Image #1] and [Image #3]"), 4)
        XCTAssertEqual(draft.add(ComposerImage(data: png, mediaType: "image/png")), 5)
        let a = adapter(mode: "code")
        a.composerDraft = "recalled [Image #1] "
        XCTAssertEqual(a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png")), "[Image #2]")
    }

    /// A double Enter during staging stages and sends once; edits made meanwhile are not wiped.
    func testOneSubmitAtATimeAndOnlyWhatWasSentIsCleared() {
        let a = adapter(mode: "code")
        XCTAssertTrue(a.beginComposerSubmit())
        XCTAssertFalse(a.beginComposerSubmit(), "a second Enter while the first is in flight is refused")
        a.endComposerSubmit()
        XCTAssertTrue(a.beginComposerSubmit())
        a.endComposerSubmit()

        _ = a.composerImageIntake.attach(ComposerImage(data: png, mediaType: "image/png"))
        a.composerDraft = "look [Image #1]"
        let sent = a.composerDraft
        a.composerDraft = sent + "\nand then [Image #1] again" // typed during the round trip
        a.composerSendSucceeded(sentDraft: sent)
        XCTAssertEqual(a.composerDraft, "and then [Image #1] again")
        XCTAssertFalse(a.composerImages.isEmpty, "#1 is still referenced by what remains")

        a.composerDraft = "plain"
        a.composerSendSucceeded(sentDraft: "plain")
        XCTAssertEqual(a.composerDraft, "")
    }

    /// Attachments carried into a chat session (the draft follows a switch) are dropped and the text
    /// goes literally — no staging, no error.
    func testAttachmentsCarriedIntoANonCodeSessionAreDroppedSilently() async {
        let a = adapter(mode: "chat")
        a.composerImages = { var d = ComposerImageDraft(); _ = d.add(ComposerImage(data: png, mediaType: "image/png")); return d }()
        let sent = await a.composerTextForSend("see [Image #1]") { _ in XCTFail("never staged"); return StagedImage(path: "", imagesOnSend: true) }
        XCTAssertEqual(sent, ComposerOutgoing(text: "see [Image #1]", images: []))
        XCTAssertTrue(a.composerImages.isEmpty)
        XCTAssertNil(a.composerNotice)
    }
}
