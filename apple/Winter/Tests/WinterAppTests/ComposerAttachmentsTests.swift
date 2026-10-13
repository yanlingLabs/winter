import AppKit
import UniformTypeIdentifiers
import XCTest
import WinterKit
@testable import Winter
import WinterProtocol

/// Composer attachments (2026-10-13): the draft's chips (insert, × remove, Backspace), the submit-time
/// serialisation to `[Image #n]` / `[File #n]` placeholders with `images` / `files`, the older-daemon fallbacks,
/// a refused send keeping the draft, file intake from a pasteboard, the "+" gate, and the transcript side — the
/// reducer carrying a message's attachments onto its exchange and the bubble's chips.
@MainActor
final class ComposerAttachmentsTests: XCTestCase {
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])

    private func adapter(mode: String? = "code", images: Bool = true) -> FieldStateAdapter {
        let a = FieldStateAdapter(session: SessionModel())
        let row = SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global", cwd: "/repo",
                                 mode: mode, model: "anthropic/claude-sonnet-5-5")
        a.currentSessionRow = { row }
        a.modelCatalogue = SyncConfigSnapshot(provider: "anthropic", defaultModel: "anthropic/claude-sonnet-5-5",
                                              models: [SyncConfigModelInfo(id: "anthropic/claude-sonnet-5-5", providerId: "anthropic",
                                                                           displayName: "Sonnet", facingName: nil, efforts: [],
                                                                           supportsImages: images)],
                                              defaultEffort: "", clientEfforts: [])
        return a
    }

    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("winter-attach-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let noStage: (ComposerImageData) async throws -> StagedImage = { _ in StagedImage(path: "/t/image_1.png", imagesOnSend: true) }

    // MARK: - The draft

    func testInsertRemoveAndBackspaceOrder() {
        var draft = ComposerAttachmentDraft()
        let a = draft.add(.file(path: "/Users/me/a.pdf"))
        let b = draft.add(.image(ComposerImage(data: png, mediaType: "image/png")))
        let c = draft.add(.file(path: "/Users/me/src"))
        XCTAssertEqual([a, b, c], [1, 2, 3], "ids climb")
        XCTAssertEqual(draft.placeholderNumbers, [a: 1, b: 1, c: 2], "images and files each count from 1, in strip order")
        XCTAssertTrue(draft.remove(id: a))
        XCTAssertFalse(draft.remove(id: a), "a second × on the same chip is a no-op")
        XCTAssertEqual(draft.removeLast()?.id, c, "Backspace takes the LAST chip")
        XCTAssertEqual(draft.items.map(\.id), [b])
        XCTAssertEqual(draft.add(.file(path: "/x")), 4, "an id is never reused")
    }

    func testChipModelsNameEachKind() {
        var draft = ComposerAttachmentDraft()
        draft.add(.image(.file(path: "/Users/me/Desktop/Screen Shot.png")))
        draft.add(.image(ComposerImage(data: png, mediaType: "image/png")))
        draft.add(.file(path: "/Users/me/Documents/My Report.pdf"))
        draft.add(.file(path: "/Users/me/Projects/app"))
        let chips = composerChipModels(draft)
        XCTAssertEqual(chips.map(\.name), ["Screen Shot.png", "Image #2", "My Report.pdf", "app"])
        XCTAssertEqual(chips.map(\.attachmentID), [1, 2, 3, 4])
        XCTAssertEqual(chips[0].visual, .image(source: .path("/Users/me/Desktop/Screen Shot.png"), fallbackName: "Image #1"))
        XCTAssertEqual(chips[2].visual, .file(path: "/Users/me/Documents/My Report.pdf"))
    }

    // MARK: - Serialising to placeholders

    func testFilesSerialiseToFilePlaceholdersAfterTheImages() async throws {
        var draft = ComposerAttachmentDraft()
        draft.add(.file(path: "/Users/me/My Report.pdf"))
        draft.add(.image(.file(path: "/Users/me/shot.png")))
        draft.add(.file(path: "/Users/me/app"))
        let out = try await resolveComposerAttachments("explain these", draft: draft, stage: noStage)
        XCTAssertEqual(out.text, "[Image #1] [File #1] [File #2]\nexplain these")
        XCTAssertEqual(out.images, [SessionEvent.UserMessageImageRef(n: 1, path: "/Users/me/shot.png")])
        XCTAssertEqual(out.files, [SessionEvent.UserMessageFileRef(n: 1, path: "/Users/me/My Report.pdf"),
                                   SessionEvent.UserMessageFileRef(n: 2, path: "/Users/me/app")])
        // Attachments alone are a message: the placeholders are its whole text.
        let bare = try await resolveComposerAttachments("", draft: draft, stage: noStage)
        XCTAssertEqual(bare.text, "[Image #1] [File #1] [File #2]")
    }

    /// A daemon without the `attachment-files` hello feature would strip `files`: each path goes in the text.
    func testAnOlderDaemonIsSentEachFilesPathInTheText() async throws {
        var draft = ComposerAttachmentDraft()
        draft.add(.file(path: "/Users/me/My Report.pdf"))
        draft.add(.file(path: "/Users/me/app"))
        let out = try await resolveComposerAttachments("read", draft: draft, attachmentFiles: false, stage: noStage)
        XCTAssertEqual(out.text, "/Users/me/My Report.pdf /Users/me/app\nread")
        XCTAssertEqual(out.files, [])
    }

    func testMoreThanTwentyFilesIsRefused() async {
        let a = adapter()
        let dir = FileManager.default.temporaryDirectory.path
        for _ in 0..<21 { XCTAssertTrue(a.composerImageIntake.attach(.file(path: dir))) }
        let sent = await a.composerTextForSend("x", stage: noStage)
        XCTAssertNil(sent)
        XCTAssertEqual(a.composerNotice, "A message can carry at most 20 files")
    }

    // MARK: - The adapter

    func testAFileOrFolderAttachesWithoutAnImageCapableModel() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let doc = dir.appendingPathComponent("notes.docx")
        try Data("x".utf8).write(to: doc)
        let a = adapter(images: false)
        XCTAssertTrue(a.composerImageIntake.attach(.file(path: doc.path)))
        XCTAssertTrue(a.composerImageIntake.attach(.file(path: dir.path)), "a folder is a file attachment too")
        XCTAssertFalse(a.composerImageIntake.attach(.file(path: dir.appendingPathComponent("gone.txt").path)))
        XCTAssertEqual(a.composerNotice, composerFileUnreadableMessage)
        XCTAssertEqual(a.composerChips.map(\.name), ["notes.docx", dir.lastPathComponent])
    }

    func testTheChipsXRemovesItsAttachmentAndItNeverReachesTheMessage() async throws {
        let a = adapter()
        XCTAssertTrue(a.composerImageIntake.attach(.image(ComposerImage(data: png, mediaType: "image/png"))))
        XCTAssertTrue(a.composerImageIntake.attach(.file(path: "/")))
        let first = try XCTUnwrap(a.composerChips.first)
        a.composerAttachmentsControl.onRemove(first)
        XCTAssertEqual(a.composerChips.map(\.name), ["/"])
        var staged = 0
        let out = await a.composerTextForSend("hi") { _ in staged += 1; return StagedImage(path: "/t/x.png", imagesOnSend: true) }
        XCTAssertEqual(staged, 0, "the removed image is never staged")
        XCTAssertEqual(out?.text, "[File #1]\nhi")
        XCTAssertEqual(out?.images, [])
    }

    func testBackspaceAtTheStartRemovesTheLastChipOnlyThere() {
        let a = adapter()
        XCTAssertTrue(a.composerImageIntake.attach(.file(path: "/")))
        XCTAssertTrue(a.composerImageIntake.attach(.file(path: "/tmp")))
        let view = CommandTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        view.imageIntake = a.composerImageIntake
        view.string = "ab"
        view.setSelectedRange(NSRange(location: 2, length: 0))
        view.deleteBackward(nil)
        XCTAssertEqual(view.string, "a", "mid-text Backspace is AppKit's")
        XCTAssertEqual(a.composerAttachments.items.count, 2)
        view.setSelectedRange(NSRange(location: 0, length: 0))
        view.deleteBackward(nil)
        XCTAssertEqual(view.string, "a", "the text is untouched")
        XCTAssertEqual(a.composerChips.map(\.name), ["/"], "the LAST chip went")
        view.deleteBackward(nil)
        view.deleteBackward(nil) // no chip left: AppKit's own (nothing before the caret)
        XCTAssertTrue(a.composerAttachments.isEmpty)
        XCTAssertEqual(view.string, "a")
    }

    func testARefusedSendKeepsTheTextAndTheChips() async throws {
        let a = adapter()
        XCTAssertTrue(a.composerImageIntake.attach(.file(path: "/tmp")))
        a.composerDraft = "keep me"
        let outMaybe = await a.composerTextForSend(a.composerDraft, stage: noStage)
        let out = try XCTUnwrap(outMaybe)
        let ok = await a.composerSend(out, send: { _ in throw RpcError(code: -32602, message: "[File #1] could not be found") }, stage: noStage)
        XCTAssertFalse(ok)
        XCTAssertEqual(a.composerNotice, "[File #1] could not be found")
        XCTAssertEqual(a.composerDraft, "keep me")
        XCTAssertEqual(a.composerAttachments.items.count, 1)
        // …and once it goes, both clear.
        let wentOK = await a.composerSend(out, send: { _ in }, stage: noStage)
        XCTAssertTrue(wentOK)
        a.composerSendSucceeded(sentDraft: "keep me", sentAttachments: out.sentAttachmentIDs)
        XCTAssertEqual(a.composerDraft, "")
        XCTAssertTrue(a.composerAttachments.isEmpty)
    }

    func testThePlusIsLiveOnlyInACodeSession() {
        for (mode, live) in [("code", true), ("chat", false), ("dispatch", false)] {
            let a = adapter(mode: mode)
            let control = a.composerAttachmentsControl
            XCTAssertEqual(control.isEnabled, live, mode)
            XCTAssertEqual(control.disabledReason, "Attachments work in code sessions — chats can't take files or images")
        }
        XCTAssertEqual(composerAttachmentsRowHeight(chipCount: 0), 0, "no chip, no growth")
        XCTAssertEqual(composerAttachmentsRowHeight(chipCount: 3), AttachmentChipMetrics.height + 10)
        XCTAssertEqual(composerStripSurfaceHeight(10, attachmentsRow: 42), newChatComposerHeight + 52)
    }

    // MARK: - Intake from a pasteboard

    func testAnyFileOrFolderOnThePasteboardIsAnAttachmentImagesFirstByTheirBytes() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let shot = dir.appendingPathComponent("shot.png"); try png.write(to: shot)
        let notes = dir.appendingPathComponent("notes.txt"); try Data("n".utf8).write(to: notes)
        let svg = dir.appendingPathComponent("logo.svg"); try Data("<svg/>".utf8).write(to: svg)
        let folder = dir.appendingPathComponent("src"); try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let board = NSPasteboard(name: NSPasteboard.Name("winter.test.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([shot, notes, svg, folder, dir.appendingPathComponent("gone.pdf")].map { $0 as NSURL })
        XCTAssertTrue(composerPasteboardMayHaveAttachment(board))
        XCTAssertEqual(composerAttachments(from: board), [
            .image(.file(path: shot.path)), .file(path: notes.path), .file(path: svg.path), .file(path: folder.path),
        ], "an SVG is no raster image: a file chip; a vanished file is skipped")
        board.clearContents()
        board.setString("just text", forType: .string)
        XCTAssertNil(composerAttachments(from: board))
        XCTAssertFalse(composerPasteboardMayHaveAttachment(board))
    }

    // MARK: - The transcript

    private func userMessage(_ text: String, seq: Int, images: [SessionEvent.UserMessageImageRef]? = nil,
                             files: [SessionEvent.UserMessageFileRef]? = nil) -> SessionEvent {
        .userMessage(SessionEvent.UserMessage(seq: seq, sessionId: "s", ts: 0, threadId: "main", text: text, clientName: "orb",
                                              images: images, files: files))
    }

    func testTheReducerCarriesAMessagesAttachmentsAndRenumbersAFoldedSteers() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("[Image #1] [File #1]\nlook", seq: 1,
                                                 images: [.init(n: 1, path: "/a.png")], files: [.init(n: 1, path: "/r.pdf")]))
        XCTAssertEqual(s.exchanges.last?.promptAttachments, PromptAttachments(images: [1: "/a.png"], files: [1: "/r.pdf"]))
        s = SessionReducer.reduce(s, .turnStarted(SessionEvent.TurnStarted(seq: 2, sessionId: "s", ts: 0, threadId: "main")))
        s = SessionReducer.reduce(s, userMessage("[File #1]\nalso this", seq: 3, files: [.init(n: 1, path: "/b.txt")]))
        let exchange = s.exchanges.last!
        XCTAssertEqual(exchange.prompt, "[Image #1] [File #1]\nlook\n↳ [File #2]\nalso this", "the steer's #1 moved past the prompt's")
        XCTAssertEqual(exchange.promptAttachments, PromptAttachments(images: [1: "/a.png"], files: [1: "/r.pdf", 2: "/b.txt"]))
    }

    func testTheBubbleDrawsKnownPlaceholdersAsChipsAndKeepsTheRest() {
        let attachments = PromptAttachments(images: [1: "/tmp/winter-session-s_1/images/image_1.png", 2: "/Users/me/shot.png"],
                                            files: [1: "/Users/me/My Report.pdf"])
        let display = promptDisplay("[Image #1] [Image #2] [File #1]\ncompare [Image #2] with [Image #7]\n\nthanks", attachments: attachments)
        XCTAssertEqual(display.chips.map(\.name), ["Image #1", "shot.png", "My Report.pdf"], "a staged copy reads Image #n; each placeholder once")
        XCTAssertEqual(display.text, "compare with [Image #7]\n\nthanks", "an unknown placeholder stays text; a chips-only line goes")
        XCTAssertEqual(display.chips[0].visual, .image(source: .path("/tmp/winter-session-s_1/images/image_1.png"), fallbackName: "Image #1"))
        XCTAssertNil(display.chips[0].attachmentID, "a sent message's chip has no × to wire")
        // No attachments: the text exactly as it was.
        XCTAssertEqual(promptDisplay("[Image #1] typed by hand", attachments: PromptAttachments()),
                       PromptDisplay(chips: [], text: "[Image #1] typed by hand"))
        XCTAssertTrue(attachmentPathIsStagedImage("/var/folders/x/T/winter-session-s_1/images/image_3.jpg"))
        XCTAssertFalse(attachmentPathIsStagedImage("/Users/me/images/image_3.jpg"))
    }

    func testAThumbnailIsADownscaledImageAndAnUnreadableSourceIsNil() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        // A real 400×300 PNG.
        let ctx = CGContext(data: nil, width: 400, height: 300, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
        let pngData = try XCTUnwrap(composerEncode(ctx.makeImage()!, as: .png, quality: nil))
        let file = dir.appendingPathComponent("big.png"); try pngData.write(to: file)
        let thumb = try XCTUnwrap(AttachmentThumbnails.makeThumbnail(.path(file.path)))
        XCTAssertLessThanOrEqual(max(thumb.width, thumb.height), AttachmentChipMetrics.thumbnailPixels)
        XCTAssertNotNil(AttachmentThumbnails.makeThumbnail(.data(key: "k", bytes: AttachmentImageBytes(pngData))))
        XCTAssertNil(AttachmentThumbnails.makeThumbnail(.path(dir.appendingPathComponent("deleted.png").path)), "a deleted temp file: the neutral chip")
        XCTAssertNil(AttachmentThumbnails.makeThumbnail(.data(key: "x", bytes: AttachmentImageBytes(Data("nope".utf8)))))
    }
}
