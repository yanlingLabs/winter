import AppKit
import UniformTypeIdentifiers
import XCTest
import WinterKit
@testable import Winter
import WinterProtocol

/// Test seams shared by the composer suites: attach as the text view does — the attachment, and its chip (its
/// marker) at the end of the draft.
extension FieldStateAdapter {
    @discardableResult
    func attachChip(_ kind: ComposerAttachmentKind) -> Bool {
        guard let id = composerImageIntake.attach(kind) else { return false }
        composerDraft += String(composerAttachmentMarker(id)) + " "
        return true
    }
}

/// A draft's chips (every attachment it holds, in order), then `text` — what the composer would hold.
func chipText(_ draft: ComposerAttachmentDraft, _ text: String) -> String {
    (draft.items.map { String(composerAttachmentMarker($0.id)) } + (text.isEmpty ? [] : [text])).joined(separator: " ")
}

/// An intake with no adapter behind it: every id is a chip named "chip <id>", placeholders are `[File #id]`.
@MainActor
func makeTestIntake(enabled: Bool = true, draft: String = "test-draft",
                    attach: @escaping (ComposerAttachmentKind) -> Int?) -> ComposerAttachmentIntake {
    ComposerAttachmentIntake(isEnabled: { enabled }, attach: attach,
                             chip: { id, _ in AttachmentChipModel(id: "a\(id)", name: "chip \(id)", visual: .file(path: "/tmp")) },
                             placeholder: { id, _ in composerFileToken(id) }, draftToken: { draft })
}

/// Composer attachments (2026-10-13; inline since the same day): chips IN the composer's text — the draft's markers,
/// the submit-time serialisation to `[Image #n]` / `[File #n]` placeholders AT each chip's position with `images` /
/// `files`, the older-daemon fallbacks, a refused send keeping the draft, the text view's own behaviour (insert at
/// the caret, Backspace, the ×, undo/redo, caret movement, copy/cut/paste, the line metrics), file intake from a
/// pasteboard, the "+" gate, and the transcript side — the reducer and the bubble's inline chips.
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

    private func m(_ id: Int) -> String { String(composerAttachmentMarker(id)) }

    // MARK: - The draft

    func testMarkersAreOneCharacterAndOneUTF16Unit() {
        for id in [1, 2, 300, composerAttachmentMaxID] {
            let marker = composerAttachmentMarker(id)
            XCTAssertEqual(composerAttachmentID(marker: marker), id)
            XCTAssertEqual(String(marker).utf16.count, 1, "the same length as the U+FFFC the text view holds")
        }
        XCTAssertNil(composerAttachmentID(marker: "a"))
        XCTAssertNil(composerAttachmentID(marker: Character(Unicode.Scalar(composerAttachmentMarkerBase)!)), "id 0 is no chip")
        XCTAssertEqual(composerAttachmentMarkerIDs(in: "a\(m(2))b\(m(1))c\(m(2))"), [2, 1, 2])
        XCTAssertEqual(composerTextWithoutMarkers("a\(m(2)) b"), "a b")
    }

    func testTheDraftNumbersChipsByWhereTheyAreInTheText() {
        var draft = ComposerAttachmentDraft()
        let a = draft.add(.file(path: "/Users/me/a.pdf"))!
        let b = draft.add(.image(ComposerImage(data: png, mediaType: "image/png")))!
        let c = draft.add(.file(path: "/Users/me/src"))!
        XCTAssertEqual([a, b, c], [1, 2, 3], "ids climb")
        let text = "first \(m(c)) then \(m(b)) and \(m(a)) and \(m(c)) again"
        XCTAssertEqual(draft.live(in: text).map(\.id), [c, b, a], "first appearance, each once")
        XCTAssertEqual(draft.placeholderNumbers(in: text), [c: 1, b: 1, a: 2], "images and files each count from 1, by position")
        XCTAssertEqual(draft.serialized(text), "first [File #1] then [Image #1] and [File #2] and [File #1] again")
        XCTAssertEqual(draft.placeholder(id: a, in: text), "[File #2]")
        XCTAssertEqual(draft.serialized("gone \(m(9)) chip"), "gone  chip", "a marker the draft does not hold goes")
        XCTAssertTrue(draft.remove(id: a))
        XCTAssertFalse(draft.remove(id: a), "a second removal is a no-op")
        XCTAssertEqual(draft.add(.file(path: "/x")), 4, "an id is never reused")
        // Two drafts never share a token (a copied chip pastes back only into its own).
        XCTAssertNotEqual(draft.token, ComposerAttachmentDraft().token)
    }

    func testChipsOutOfTheTextAreKeptForUndoThenLetGo() {
        var draft = ComposerAttachmentDraft()
        for _ in 0..<5 { draft.add(.file(path: "/x")) }
        draft.prune(keeping: "\(m(2))", retaining: 2)
        XCTAssertEqual(draft.items.map(\.id), [2, 4, 5], "the text's chip, and the newest two deleted ones")
        draft.prune(keeping: "", retaining: 0)
        XCTAssertTrue(draft.isEmpty)
    }

    func testChipModelsNameEachKind() {
        var draft = ComposerAttachmentDraft()
        draft.add(.image(.file(path: "/Users/me/Desktop/Screen Shot.png")))
        draft.add(.image(ComposerImage(data: png, mediaType: "image/png")))
        draft.add(.file(path: "/Users/me/Documents/My Report.pdf"))
        draft.add(.file(path: "/Users/me/Projects/app"))
        let chips = composerChipModels(draft, text: chipText(draft, ""))
        XCTAssertEqual(chips.map(\.name), ["Screen Shot.png", "Image #2", "My Report.pdf", "app"])
        XCTAssertEqual(chips.map(\.attachmentID), [1, 2, 3, 4])
        XCTAssertEqual(chips[0].visual, .image(source: .path("/Users/me/Desktop/Screen Shot.png"), fallbackName: "Image #1"))
        XCTAssertEqual(chips[2].visual, .file(path: "/Users/me/Documents/My Report.pdf"))
        // Pasted data is named by its number, which follows the chip's position.
        let swapped = composerChipModels(draft, text: "\(m(2)) \(m(1))")
        XCTAssertEqual(swapped.map(\.name), ["Image #1", "Screen Shot.png"])
    }

    // MARK: - Serialising to placeholders

    func testEachChipBecomesItsPlaceholderWhereItIs() async throws {
        var draft = ComposerAttachmentDraft()
        let report = draft.add(.file(path: "/Users/me/My Report.pdf"))!
        let shot = draft.add(.image(.file(path: "/Users/me/shot.png")))!
        let app = draft.add(.file(path: "/Users/me/app"))!
        let out = try await resolveComposerAttachments("compare \(m(shot)) with \(m(report))\nand explain \(m(app))",
                                                       draft: draft, stage: noStage)
        XCTAssertEqual(out.text, "compare [Image #1] with [File #1]\nand explain [File #2]")
        XCTAssertEqual(out.images, [SessionEvent.UserMessageImageRef(n: 1, path: "/Users/me/shot.png")])
        XCTAssertEqual(out.files, [SessionEvent.UserMessageFileRef(n: 1, path: "/Users/me/My Report.pdf"),
                                   SessionEvent.UserMessageFileRef(n: 2, path: "/Users/me/app")])
        XCTAssertEqual(out.sentAttachmentIDs, [report, shot, app])
        // Attachments alone are a message: the placeholders are its whole text.
        let bare = try await resolveComposerAttachments("\(m(shot)) \(m(app))", draft: draft, stage: noStage)
        XCTAssertEqual(bare.text, "[Image #1] [File #1]")
        XCTAssertEqual(bare.sentAttachmentIDs, [shot, app], "a chip deleted from the text is not sent")
    }

    /// A daemon without the `attachment-files` hello feature would strip `files`: each path goes in the text.
    func testAnOlderDaemonIsSentEachFilesPathInTheText() async throws {
        var draft = ComposerAttachmentDraft()
        draft.add(.file(path: "/Users/me/My Report.pdf"))
        draft.add(.file(path: "/Users/me/app"))
        let out = try await resolveComposerAttachments(chipText(draft, "read"), draft: draft, attachmentFiles: false, stage: noStage)
        XCTAssertEqual(out.text, "/Users/me/My Report.pdf /Users/me/app read")
        XCTAssertEqual(out.files, [])
    }

    /// The older-daemon fallback substitutes images and files in ONE pass: a path that spells a token is never
    /// rewritten again.
    func testInlineSubstitutionIsOnePassOverBothKinds() async throws {
        var draft = ComposerAttachmentDraft()
        draft.add(.image(.file(path: "/Users/me/[File #1].png")))
        draft.add(.file(path: "/Users/me/[Image #1] notes.txt"))
        let out = try await resolveComposerAttachments(chipText(draft, "x"), draft: draft, originalPaths: false,
                                                       attachmentFiles: false, stage: noStage)
        XCTAssertEqual(out.text, "/Users/me/[File #1].png /Users/me/[Image #1] notes.txt x")
        XCTAssertEqual(substituteComposerAttachmentTokens("[File #1] [Image #2] [Image #1]", images: [1: "/a [File #1]"], files: [1: "/f"]),
                       "/f [Image #2] /a [File #1]")
    }

    /// Images and files TOGETHER are at most 20 (the daemon's `USER_MESSAGE_ATTACHMENTS_MAX`).
    func testMoreThanTwentyAttachmentsTogetherIsRefused() async throws {
        var draft = ComposerAttachmentDraft()
        for _ in 0..<15 { draft.add(.file(path: "/tmp")) }
        for _ in 0..<6 { draft.add(.image(.file(path: "/a.png"))) }
        do {
            _ = try await resolveComposerAttachments(chipText(draft, "x"), draft: draft, stage: noStage)
            XCTFail("21 together must be refused")
        } catch let refusal as ComposerImagesRefusal {
            XCTAssertEqual(refusal.message, "A message can carry at most 20 attachments")
        }
    }

    func testMoreThanTwentyFilesIsRefused() async {
        let a = adapter()
        let dir = FileManager.default.temporaryDirectory.path
        for _ in 0..<21 { XCTAssertTrue(a.attachChip(.file(path: dir))) }
        let sent = await a.composerTextForSend(a.composerDraft + "x", stage: noStage)
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
        XCTAssertTrue(a.attachChip(.file(path: doc.path)))
        XCTAssertTrue(a.attachChip(.file(path: dir.path)), "a folder is a file attachment too")
        XCTAssertFalse(a.attachChip(.file(path: dir.appendingPathComponent("gone.txt").path)))
        XCTAssertEqual(a.composerNotice, composerFileUnreadableMessage)
        XCTAssertEqual(a.composerChips.map(\.name), ["notes.docx", dir.lastPathComponent])
        XCTAssertTrue(a.composerHasAttachments)
    }

    func testARefusedSendKeepsTheTextAndTheChips() async throws {
        let a = adapter()
        XCTAssertTrue(a.attachChip(.file(path: "/tmp")))
        a.composerDraft += "keep me"
        let draft = a.composerDraft
        let outMaybe = await a.composerTextForSend(draft, stage: noStage)
        let out = try XCTUnwrap(outMaybe)
        XCTAssertEqual(out.text, "[File #1] keep me")
        let ok = await a.composerSend(out, send: { _ in throw RpcError(code: -32602, message: "[File #1] could not be found") }, stage: noStage)
        XCTAssertFalse(ok)
        XCTAssertEqual(a.composerNotice, "[File #1] could not be found")
        XCTAssertEqual(a.composerDraft, draft, "the text keeps its chip")
        XCTAssertEqual(a.composerChips.count, 1)
        // …and once it goes, both clear.
        let wentOK = await a.composerSend(out, send: { _ in }, stage: noStage)
        XCTAssertTrue(wentOK)
        a.composerSendSucceeded(sentDraft: draft, sentAttachments: out.sentAttachmentIDs)
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
        XCTAssertEqual(composerStripSurfaceHeight(10), newChatComposerHeight + 10, "chips never grow the composer")
    }

    // MARK: - The text view

    /// What a text view needs to undo outside a window.
    @MainActor
    private final class UndoHost: NSObject, NSTextViewDelegate {
        let manager = UndoManager()
        func undoManager(for view: NSTextView) -> UndoManager? { manager }
    }

    private func composerView(_ a: FieldStateAdapter, undo: UndoHost? = nil) -> CommandTextView {
        let view = CommandTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
        _ = view.layoutManager // TextKit 1, as the composer runs
        view.isRichText = false
        view.allowsUndo = true
        view.font = Typography.sansNS(ofSize: Typography.composerFieldSize)
        view.imageIntake = a.composerImageIntake
        if let undo {
            undo.manager.groupsByEvent = false
            view.delegate = undo
        }
        return view
    }

    private func undoably(_ undo: UndoHost, _ edit: () -> Void) {
        undo.manager.beginUndoGrouping()
        edit()
        undo.manager.endUndoGrouping()
    }

    func testAChipIsOneCharacterAtTheCaretAndTheDraftSpellsItAsItsMarker() throws {
        let a = adapter()
        let view = composerView(a)
        view.string = "look at  please"
        view.setSelectedRange(NSRange(location: 8, length: 0))
        XCTAssertTrue(view.takeComposerAttachments([.file(path: "/tmp")]))
        XCTAssertEqual(view.composerText, "look at \(m(1)) please", "at the caret, spaced from the words, never doubled")
        XCTAssertEqual(view.string, "look at \u{FFFC} please")
        XCTAssertEqual(view.selectedRange(), NSRange(location: 9, length: 0), "the caret ends after it")
        XCTAssertTrue(view.textStorage?.attribute(.attachment, at: 8, effectiveRange: nil) is ComposerChipAttachment)
        // The draft round-trips through the storage.
        let other = composerView(a)
        other.setComposerText(view.composerText)
        XCTAssertEqual(other.composerText, view.composerText)
        XCTAssertTrue(other.textStorage?.attribute(.attachment, at: 8, effectiveRange: nil) is ComposerChipAttachment)
        // Several at once go in a row; one between words gets a space either side.
        view.setSelectedRange(NSRange(location: 4, length: 0))
        XCTAssertTrue(view.takeComposerAttachments([.file(path: "/tmp"), .file(path: "/")]))
        XCTAssertEqual(view.composerText, "look \(m(2)) \(m(3)) at \(m(1)) please")
    }

    func testTheCaretMovesOverAChipAsOneCharacter() {
        let a = adapter()
        let view = composerView(a)
        view.string = "ab"
        view.setSelectedRange(NSRange(location: 1, length: 0))
        view.insertComposerChips([a.composerImageIntake.attach(.file(path: "/tmp"))].compactMap { $0 })
        XCTAssertEqual(view.composerText, "a \(m(1)) b")
        view.setSelectedRange(NSRange(location: 2, length: 0))
        view.moveRight(nil)
        XCTAssertEqual(view.selectedRange().location, 3, "one step crosses the whole chip")
        view.moveLeft(nil)
        XCTAssertEqual(view.selectedRange().location, 2)
    }

    func testBackspaceDeletesTheChipAndUndoRedoBringItBack() throws {
        let a = adapter()
        let undo = UndoHost()
        let view = composerView(a, undo: undo)
        view.string = "hi"
        view.setSelectedRange(NSRange(location: 2, length: 0))
        undoably(undo) { view.takeComposerAttachments([.file(path: "/tmp")]) }
        XCTAssertEqual(view.composerText, "hi \(m(1)) ")
        view.setSelectedRange(NSRange(location: 4, length: 0))
        undoably(undo) { view.deleteBackward(nil) }
        XCTAssertEqual(view.composerText, "hi  ", "Backspace takes the chip like any character")
        a.composerDraft = view.composerText
        XCTAssertFalse(a.composerHasAttachments, "…and its attachment with it")
        XCTAssertNotNil(a.composerAttachments.item(id: 1), "kept beside the draft for undo")
        undo.manager.undo()
        XCTAssertEqual(view.composerText, "hi \(m(1)) ", "undo brings the same chip back")
        undo.manager.redo()
        XCTAssertEqual(view.composerText, "hi  ")
        undo.manager.undo()
        // Forward Delete, too.
        view.setSelectedRange(NSRange(location: 3, length: 0))
        undoably(undo) { view.deleteForward(nil) }
        XCTAssertEqual(view.composerText, "hi  ")
    }

    func testTheChipsXRemovesItAndItsSpaceUndoably() {
        let a = adapter()
        let undo = UndoHost()
        let view = composerView(a, undo: undo)
        undoably(undo) { view.takeComposerAttachments([.file(path: "/tmp"), .file(path: "/")]) }
        undoably(undo) { view.insertText("go", replacementRange: view.selectedRange()) }
        XCTAssertEqual(view.composerText, "\(m(1)) \(m(2)) go")
        undoably(undo) { view.removeComposerChip(at: 0) }
        XCTAssertEqual(view.composerText, "\(m(2)) go")
        undo.manager.undo()
        XCTAssertEqual(view.composerText, "\(m(1)) \(m(2)) go")
        view.removeComposerChip(at: 7) // not a chip: nothing happens
        XCTAssertEqual(view.composerText, "\(m(1)) \(m(2)) go")
    }

    func testCopyPutsThePlaceholdersOnThePasteboardAndPasteBringsTheChipsBack() throws {
        let a = adapter()
        let view = composerView(a)
        view.string = "see "
        view.setSelectedRange(NSRange(location: 4, length: 0))
        view.takeComposerAttachments([.image(ComposerImage(data: png, mediaType: "image/png")), .file(path: "/tmp")])
        XCTAssertEqual(view.composerText, "see \(m(1)) \(m(2)) ")
        let board = NSPasteboard(name: NSPasteboard.Name("winter.test.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        view.setSelectedRange(NSRange(location: 0, length: 7))
        XCTAssertTrue(view.writeComposerChips(to: board))
        XCTAssertEqual(board.string(forType: .string), "see [Image #1] [File #1]", "plain text elsewhere: the placeholders")
        XCTAssertNotNil(board.data(forType: CommandTextView.composerChipsPasteboardType))
        // Back into the same draft: chips again.
        view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0))
        XCTAssertTrue(view.pasteComposerChips(from: board))
        XCTAssertEqual(view.composerText, "see \(m(1)) \(m(2)) see \(m(1)) \(m(2))")
        // Into ANOTHER draft: not ours to restore — AppKit pastes the placeholder text.
        let elsewhere = composerView(adapter())
        XCTAssertFalse(elsewhere.pasteComposerChips(from: board))
        // An attachment the draft no longer holds comes back as its placeholder.
        a.composerAttachments.remove(id: 2)
        let again = composerView(a)
        XCTAssertTrue(again.pasteComposerChips(from: board))
        XCTAssertEqual(again.composerText, "see \(m(1)) [File #1]")
        // A selection with no chip is AppKit's own copy.
        view.setSelectedRange(NSRange(location: 0, length: 3))
        XCTAssertFalse(view.writeComposerChips(to: board))
    }

    func testCutTakesTheChipsOutUndoably() {
        let a = adapter()
        let undo = UndoHost()
        let view = composerView(a, undo: undo)
        undoably(undo) { view.takeComposerAttachments([.file(path: "/tmp")]) }
        view.setSelectedRange(NSRange(location: 0, length: 1))
        let board = NSPasteboard(name: NSPasteboard.Name("winter.test.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        undoably(undo) { XCTAssertTrue(view.cutComposerChips(to: board)) }
        XCTAssertEqual(view.composerText, " ")
        XCTAssertEqual(board.string(forType: .string), "[File #1]")
        undo.manager.undo()
        XCTAssertEqual(view.composerText, "\(m(1)) ")
    }

    /// The chip is as tall as the text's own box and sits on its descender — a line with chips is no taller.
    func testAnInlineChipFitsTheLine() throws {
        let font = Typography.sansNS(ofSize: Typography.composerFieldSize)
        let size = AttachmentChipSize.inline(for: font)
        XCTAssertEqual(size.height, ceil(font.ascender - font.descender))
        XCTAssertLessThan(size.thumbnailSide, size.height)
        XCTAssertEqual(AttachmentChipSize.baselineOffset(for: font), font.descender)
        let a = adapter()
        let view = composerView(a)
        view.takeComposerAttachments([.file(path: "/tmp")])
        let attachment = try XCTUnwrap(view.textStorage?.attribute(.attachment, at: 0, effectiveRange: nil) as? ComposerChipAttachment)
        let cell = try XCTUnwrap(attachment.attachmentCell as? ComposerChipAttachmentCell)
        XCTAssertEqual(cell.cellSize().height, size.height, accuracy: 0.5)
        XCTAssertGreaterThan(cell.cellSize().width, size.height, "a thumbnail and a name")
        XCTAssertEqual(cell.cellBaselineOffset().y, font.descender)
        // The × sits inside the chip, at its trailing end.
        let frame = NSRect(x: 10, y: 0, width: 80, height: size.height)
        let x = attachmentChipInlineRemoveRect(in: frame)
        XCTAssertTrue(frame.contains(x))
        XCTAssertEqual(x.maxX, frame.maxX - 2)
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

    func testTheBubbleDrawsKnownPlaceholdersAsChipsInPlaceAndKeepsTheRest() {
        let attachments = PromptAttachments(images: [1: "/tmp/winter-session-s_1/images/image_1.png", 2: "/Users/me/shot.png"],
                                            files: [1: "/Users/me/My Report.pdf"])
        let display = promptDisplay("look at [Image #1] then [File #1]\ncompare [Image #2] with [Image #7]\n\n**thanks**",
                                    attachments: attachments)
        XCTAssertEqual(display.chips.map(\.name), ["Image #1", "My Report.pdf", "shot.png"], "a staged copy reads Image #n; each placeholder once")
        guard display.segments.count == 2, case .inline(let lines) = display.segments[0],
              case .prose(let prose) = display.segments[1] else {
            return XCTFail("two chip lines, then prose: \(display.segments)")
        }
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0], [.text("look at "), .chip(display.chips[0]), .text(" then "), .chip(display.chips[1])],
                       "each chip where its placeholder was")
        XCTAssertEqual(lines[1], [.text("compare "), .chip(display.chips[2]), .text(" with [Image #7]")],
                       "an unknown placeholder stays text")
        XCTAssertEqual(prose, "\n**thanks**", "lines with no chip stay markdown")
        XCTAssertNil(display.chips[0].attachmentID, "a sent message's chip has no × to wire")
        // No attachments: the text exactly as it was, one prose segment.
        XCTAssertEqual(promptDisplay("[Image #1] typed by hand", attachments: PromptAttachments()),
                       PromptDisplay(segments: [.prose("[Image #1] typed by hand")], chips: []))
        XCTAssertTrue(promptDisplay("[Image #1]", attachments: PromptAttachments(images: [1: "/a.png"])).segments.count == 1)
        XCTAssertFalse(promptDisplay("[Image #1]", attachments: PromptAttachments(images: [1: "/a.png"])).isEmpty,
                       "a message that is only a chip still draws")
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
