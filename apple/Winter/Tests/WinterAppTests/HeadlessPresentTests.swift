import AppKit
import Darwin
import Metal
import UniformTypeIdentifiers
import XCTest
import WinterKit
@testable import Winter

/// ComputerV2 Phase 4 (lane H3) — the headless presentation's pure pieces in Winter.app: the geometry (fit, the
/// inverse fit, the render scale, wheel deltas, the IME rect), the key and cursor tables, the modifier bits, the
/// upload copier's rules, the chrome's state model, and the store's handling of the browser link's ops that need no
/// producer. Nothing here launches a helper or connects to one.
@MainActor
final class HeadlessPresentGeometryTests: XCTestCase {
    private let page = CGSize(width: 1280, height: 800)

    func testAWideViewLetterboxesLeftAndRight() {
        let fit = HeadlessPresentGeometry.fitRect(content: page, in: CGSize(width: 1000, height: 400))
        XCTAssertEqual(fit, CGRect(x: 180, y: 0, width: 640, height: 400))
    }

    func testATallViewLetterboxesTopAndBottom() {
        let fit = HeadlessPresentGeometry.fitRect(content: page, in: CGSize(width: 640, height: 1000))
        XCTAssertEqual(fit, CGRect(x: 0, y: 300, width: 640, height: 400))
    }

    func testAnEmptyViewOrPageFitsNothing() {
        XCTAssertEqual(HeadlessPresentGeometry.fitRect(content: page, in: .zero), .zero)
        XCTAssertEqual(HeadlessPresentGeometry.fitRect(content: .zero, in: CGSize(width: 10, height: 10)), .zero)
    }

    func testAViewPointBecomesACSSPixelAndTheLetterboxIsNothing() {
        let fit = CGRect(x: 180, y: 0, width: 640, height: 400) // half scale
        XCTAssertEqual(HeadlessPresentGeometry.cssPoint(CGPoint(x: 180, y: 0), fit: fit, content: page), CGPoint(x: 0, y: 0))
        XCTAssertEqual(HeadlessPresentGeometry.cssPoint(CGPoint(x: 500, y: 200), fit: fit, content: page), CGPoint(x: 640, y: 400))
        XCTAssertNil(HeadlessPresentGeometry.cssPoint(CGPoint(x: 100, y: 200), fit: fit, content: page))
        XCTAssertNil(HeadlessPresentGeometry.cssPoint(CGPoint(x: 820, y: 200), fit: fit, content: page))
    }

    func testADragOffThePageIsPinnedToItsEdge() {
        let fit = CGRect(x: 180, y: 0, width: 640, height: 400)
        XCTAssertEqual(HeadlessPresentGeometry.cssPoint(CGPoint(x: 100, y: -50), fit: fit, content: page, clamp: true), CGPoint(x: 0, y: 0))
        XCTAssertEqual(HeadlessPresentGeometry.cssPoint(CGPoint(x: 2000, y: 2000), fit: fit, content: page, clamp: true), CGPoint(x: 1279, y: 799))
    }

    func testACSSRectLandsInTheView() {
        let fit = CGRect(x: 180, y: 0, width: 640, height: 400)
        XCTAssertEqual(HeadlessPresentGeometry.viewRect(CGRect(x: 100, y: 200, width: 20, height: 40), fit: fit, content: page),
                       CGRect(x: 230, y: 100, width: 10, height: 20))
    }

    func testTheRenderScaleIsSteppedUpAndClamped() {
        XCTAssertEqual(HeadlessPresentGeometry.renderScale(fitScale: 0.5, backingScale: 2), 1.0)
        XCTAssertEqual(HeadlessPresentGeometry.renderScale(fitScale: 0.6, backingScale: 2), 1.25)
        XCTAssertEqual(HeadlessPresentGeometry.renderScale(fitScale: 0.75, backingScale: 2), 1.5)
        XCTAssertEqual(HeadlessPresentGeometry.renderScale(fitScale: 0.3, backingScale: 1), 1.0, "never below 1")
        XCTAssertEqual(HeadlessPresentGeometry.renderScale(fitScale: 3, backingScale: 2), 4.0, "never above 4")
        XCTAssertEqual(HeadlessPresentGeometry.renderScale(fitScale: .nan, backingScale: 2), 1.0)
        // A live resize between two steps asks for one scale, not one per frame.
        let a = HeadlessPresentGeometry.renderScale(fitScale: 0.51, backingScale: 2)
        let b = HeadlessPresentGeometry.renderScale(fitScale: 0.62, backingScale: 2)
        XCTAssertEqual(a, b)
    }

    func testPreciseWheelDeltasFollowTheFingersAndLinesAreFortyPixels() {
        let precise = HeadlessPresentGeometry.wheelDelta(dx: 3, dy: -10, precise: true, fitScale: 0.5)
        XCTAssertEqual(precise.dx, 6)
        XCTAssertEqual(precise.dy, -20)
        let lines = HeadlessPresentGeometry.wheelDelta(dx: 0, dy: 1, precise: false, fitScale: 0.5)
        XCTAssertEqual(lines.dx, 0)
        XCTAssertEqual(lines.dy, 40)
        XCTAssertEqual(HeadlessPresentGeometry.wheelDelta(dx: .infinity, dy: 0, precise: true, fitScale: 1).dx, 0)
    }

    func testTheCompositionRectIsTheComposedCharactersOwn() {
        let rects = [CGRect(x: 10, y: 20, width: 8, height: 16), CGRect(x: 18, y: 20, width: 8, height: 16)]
        XCTAssertEqual(HeadlessPresentGeometry.compositionRect(location: 5, compositionStart: 4, rects: rects), rects[1])
        XCTAssertEqual(HeadlessPresentGeometry.compositionRect(location: NSNotFound, compositionStart: 4, rects: rects), rects[0])
        XCTAssertEqual(HeadlessPresentGeometry.compositionRect(location: 9, compositionStart: 4, rects: rects),
                       CGRect(x: 26, y: 20, width: 0, height: 16), "past the end: a caret after the last character")
        XCTAssertNil(HeadlessPresentGeometry.compositionRect(location: 0, compositionStart: 0, rects: []))
    }

    func testTheFitInClipSpace() {
        let ndc = HeadlessPresentRenderer.ndcRect(fit: CGRect(x: 0, y: 0, width: 100, height: 50), drawable: CGSize(width: 100, height: 100))
        XCTAssertEqual(ndc, SIMD4<Float>(-1, 1, 1, 0))
    }
}

@MainActor
final class HeadlessPresentKeysTests: XCTestCase {
    typealias K = HeadlessPresentKeys

    func testThePhysicalKeyTable() {
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x00), 0x41)   // A
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x24), 0x0D)   // Return
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x4C), 0x0D)   // keypad Enter
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x7B), 0x25)   // left arrow
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x7E), 0x26)   // up arrow
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x33), 0x08)   // Backspace
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x75), 0x2E)   // forward Delete
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x35), 0x1B)   // Escape
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x7A), 0x70)   // F1
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x6F), 0x7B)   // F12
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x52), 0x60)   // keypad 0
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x38), 0x10)   // Shift
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x37), 0x5B)   // left Command
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x7F), 0)
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x200), 0)
    }

    func testTheCharacterComesFirstOffTheKeypad() {
        // On a non-QWERTY layout the physical key of "c" is elsewhere: the page wants VK_C.
        XCTAssertEqual(K.windowsKeyCode(keyCode: 7, characters: "c", charactersIgnoringModifiers: "c"), 0x43)
        // A character that maps nowhere falls back to the unmodified one, then the physical key.
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x00, characters: "å", charactersIgnoringModifiers: "a"), 0x41)
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x24, characters: "\r", charactersIgnoringModifiers: "\r"), 0x0D)
        // A keypad key is the keypad's, whatever it types.
        XCTAssertEqual(K.windowsKeyCode(keyCode: 0x53, characters: "1", charactersIgnoringModifiers: "1"), 0x61)
        XCTAssertEqual(K.windowsKeyCode(character: unichar(0x3B)), 0xBA) // ;
        XCTAssertEqual(K.windowsKeyCode(character: unichar(0x2F)), 0xBF) // /
        XCTAssertEqual(K.windowsKeyCode(character: unichar(NSInsertFunctionKey)), 0x2D)
    }

    func testModifierBitsAreCEFs() {
        // cef_types.h's cef_event_flags_t.
        XCTAssertEqual(K.modifiers([.capsLock]), 1 << 0)
        XCTAssertEqual(K.modifiers([.shift]), 1 << 1)
        XCTAssertEqual(K.modifiers([.control]), 1 << 2)
        XCTAssertEqual(K.modifiers([.option]), 1 << 3)
        XCTAssertEqual(K.modifiers([.command]), 1 << 7)
        XCTAssertEqual(K.modifiers([], button: .left), 1 << 4)
        XCTAssertEqual(K.modifiers([], button: .middle), 1 << 5)
        XCTAssertEqual(K.modifiers([], button: .right), 1 << 6)
        XCTAssertEqual(K.modifiers([], keyCode: 0x52), 1 << 9, "keypad")
        XCTAssertEqual(K.modifiers([], keyCode: 0x00), 0)
        XCTAssertEqual(K.modifiers([], keyCode: 0x00, repeating: true), 1 << 13, "a held key's repeat")
        XCTAssertEqual(K.precisionScrollingDelta, 1 << 14)
        XCTAssertEqual(K.modifiers([.shift, .command], keyCode: 0x08, button: .none), (1 << 1) | (1 << 7))
    }

    func testTheArrowKeysAreNotOnTheKeypad() {
        // macOS sets .numericPad on the arrows; a page must not read them as number-pad keys.
        for arrow: UInt16 in [0x7B, 0x7C, 0x7D, 0x7E] {
            XCTAssertEqual(K.modifiers([.numericPad, .function], keyCode: arrow) & K.isKeyPad, 0, "arrow \(arrow)")
        }
        XCTAssertEqual(K.modifiers([.numericPad], keyCode: 0x4C) & K.isKeyPad, K.isKeyPad, "keypad Enter")
    }

    func testAModifierReleaseIsReadFromItsOwnFlag() {
        XCTAssertTrue(K.isModifierKeyUp(keyCode: 56, flags: []))           // left Shift released
        XCTAssertFalse(K.isModifierKeyUp(keyCode: 56, flags: [.shift]))    // pressed
        XCTAssertTrue(K.isModifierKeyUp(keyCode: 55, flags: [.shift]))     // Command released while Shift held
        XCTAssertFalse(K.isModifierKeyUp(keyCode: 59, flags: [.control]))
        XCTAssertFalse(K.isModifierKeyUp(keyCode: 0, flags: []), "not a modifier key")
    }

    func testFunctionKeyCharactersAreNeverTyped() {
        XCTAssertTrue(K.isFunctionKeyCharacter(0xF700))
        XCTAssertTrue(K.isFunctionKeyCharacter(0xF8FF))
        XCTAssertFalse(K.isFunctionKeyCharacter(0x61))
    }

    func testTheCursorTable() {
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 0), .arrow)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 2), .pointingHand)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 3), .iBeam)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 15), .resizeLeftRight)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 14), .resizeUpDown)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 16), .resizeDiagonalNESW)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 17), .resizeDiagonalNWSE)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 37), .hidden)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 38), .notAllowed)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 42), .closedHand)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 45), .arrow, "CT_CUSTOM: its image is not on the wire")
        XCTAssertEqual(HeadlessCursorKind.from(cefType: 999), .arrow)
        XCTAssertEqual(HeadlessCursorKind.from(cefType: -1), .arrow)
    }
}

@MainActor
final class HeadlessPresentUploadsTests: XCTestCase {
    typealias U = HeadlessPresentUploads

    func testTheUploadsFolderIsTheRootOrInsideIt() {
        XCTAssertTrue(U.isInside("/h/cache/headless-uploads", root: "/h/cache/headless-uploads"))
        XCTAssertTrue(U.isInside("/h/cache/headless-uploads/", root: "/h/cache/headless-uploads"))
        XCTAssertTrue(U.isInside("/h/cache/headless-uploads/s_1", root: "/h/cache/headless-uploads"))
        XCTAssertFalse(U.isInside("/h/cache/headless-uploads/../downloads", root: "/h/cache/headless-uploads"))
        XCTAssertFalse(U.isInside("/h/cache/headless-uploads-evil", root: "/h/cache/headless-uploads"))
        XCTAssertFalse(U.isInside("cache/headless-uploads", root: "/h/cache/headless-uploads"))
        XCTAssertFalse(U.isInside("/etc", root: "/h/cache/headless-uploads"))
    }

    func testANameKeepsOnlyItsLastComponentAndNothingDangerous() {
        XCTAssertEqual(U.safeName("report.pdf"), "report.pdf")
        XCTAssertEqual(U.safeName("../../etc/passwd"), "passwd")
        XCTAssertEqual(U.safeName(".."), "file")
        XCTAssertEqual(U.safeName(""), "file")
        XCTAssertEqual(U.safeName(".hidden"), "_hidden")
        XCTAssertEqual(U.safeName("a:b\u{0}c\u{7}d.txt"), "a_b_c_d.txt")
        let long = String(repeating: "x", count: 300) + ".pdf"
        let cut = U.safeName(long)
        XCTAssertLessThanOrEqual(cut.utf8.count, 255)
        XCTAssertTrue(cut.hasSuffix(".pdf"))
    }

    func testTheRandomFolderIsSixteenHexDigits() {
        let hex = U.randomHex()
        XCTAssertEqual(hex.count, 16)
        XCTAssertTrue(hex.allSatisfy { $0.isHexDigit })
        XCTAssertNotEqual(hex, U.randomHex())
    }

    func testThePagesAcceptListBecomesContentTypes() {
        XCTAssertEqual(U.contentTypes(accept: [".pdf"]), [.pdf])
        XCTAssertEqual(U.contentTypes(accept: ["image/*"]), [.image])
        XCTAssertEqual(U.contentTypes(accept: ["image/png", "IMAGE/PNG"]), [.png], "deduplicated, case-insensitive")
        XCTAssertEqual(U.contentTypes(accept: ["", "  ", "nonsense", "x/*"]), [])
        XCTAssertEqual(U.contentTypes(accept: []), [])
    }

    private func scratch() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("winter-headless-uploads-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testAChosenFileIsCopiedIntoAFreshPrivateFolder() throws {
        let base = try scratch()
        let uploads = base.appendingPathComponent("cache/headless-uploads")
        let source = base.appendingPathComponent("chosen.txt")
        try Data("hello".utf8).write(to: source)
        let result = U.copy([source], into: uploads.path, root: uploads.path)
        let paths = try result.get()
        XCTAssertEqual(paths.count, 1)
        let copy = paths[0]
        XCTAssertTrue(copy.hasPrefix(uploads.path + "/"))
        XCTAssertEqual((copy as NSString).lastPathComponent, "chosen.txt")
        XCTAssertEqual(((copy as NSString).deletingLastPathComponent as NSString).lastPathComponent.count, 16)
        XCTAssertEqual(try String(contentsOfFile: copy, encoding: .utf8), "hello")
        var copied = stat(), original = stat(), folder = stat()
        XCTAssertEqual(lstat(copy, &copied), 0)
        XCTAssertEqual(lstat(source.path, &original), 0)
        XCTAssertEqual(lstat((copy as NSString).deletingLastPathComponent, &folder), 0)
        XCTAssertEqual(copied.st_mode & 0o777, 0o600)
        XCTAssertEqual(folder.st_mode & 0o777, 0o700)
        XCTAssertNotEqual(copied.st_ino, original.st_ino, "a copy, never a hard link")
        XCTAssertEqual(copied.st_nlink, 1)
    }

    func testTwoFilesWithOneNameGetTheirOwnFolders() throws {
        let base = try scratch()
        let uploads = base.appendingPathComponent("uploads")
        let a = base.appendingPathComponent("a/same.txt"), b = base.appendingPathComponent("b/same.txt")
        try FileManager.default.createDirectory(at: a.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: b.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("A".utf8).write(to: a)
        try Data("B".utf8).write(to: b)
        let paths = try U.copy([a, b], into: uploads.path, root: uploads.path).get()
        XCTAssertEqual(paths.count, 2)
        XCTAssertNotEqual(paths[0], paths[1])
        XCTAssertEqual(try String(contentsOfFile: paths[1], encoding: .utf8), "B")
    }

    func testALinkIsNeverFollowed() throws {
        let base = try scratch()
        let uploads = base.appendingPathComponent("uploads")
        let target = base.appendingPathComponent("secret.txt")
        try Data("secret".utf8).write(to: target)
        let link = base.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertEqual(U.copy([link], into: uploads.path, root: uploads.path), .failure(.unreadable(name: "link.txt")))
    }

    func testAFolderIsNotAFile() throws {
        let base = try scratch()
        let uploads = base.appendingPathComponent("uploads")
        let folder = base.appendingPathComponent("folder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        XCTAssertEqual(U.copy([folder], into: uploads.path, root: uploads.path), .failure(.unreadable(name: "folder")))
    }

    func testOverTheCapNothingIsWritten() throws {
        let base = try scratch()
        let uploads = base.appendingPathComponent("uploads")
        let a = base.appendingPathComponent("a.bin"), b = base.appendingPathComponent("b.bin")
        try Data(count: 600).write(to: a)
        try Data(count: 600).write(to: b)
        XCTAssertEqual(U.copy([a, b], into: uploads.path, root: uploads.path, maxTotalBytes: 1000), .failure(.tooLarge(bytes: 1200)))
        let left = (try? FileManager.default.contentsOfDirectory(atPath: uploads.path)) ?? []
        XCTAssertTrue(left.isEmpty, "\(left)")
    }

    func testAFolderOutsideTheRootIsRefusedBeforeAnythingIsWritten() throws {
        let base = try scratch()
        let source = base.appendingPathComponent("x.txt")
        try Data("x".utf8).write(to: source)
        let elsewhere = base.appendingPathComponent("elsewhere")
        XCTAssertEqual(U.copy([source], into: elsewhere.path, root: base.appendingPathComponent("uploads").path),
                       .failure(.notTheUploadsFolder))
        XCTAssertFalse(FileManager.default.fileExists(atPath: elsewhere.path))
    }

    func testTheTwoSidesMaySpellOneHomeTwoWays() throws {
        let base = try scratch()
        let home = base.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: home.appendingPathComponent("cache"), withIntermediateDirectories: true)
        let linkedHome = base.appendingPathComponent("linked-home")
        try FileManager.default.createSymbolicLink(at: linkedHome, withDestinationURL: home)
        // The app's root through the link, the daemon's folder through the real path (the folder not made yet).
        XCTAssertTrue(U.isInside(home.appendingPathComponent("cache/headless-uploads").path,
                                 root: linkedHome.appendingPathComponent("cache/headless-uploads").path))
        XCTAssertTrue(U.isInside(linkedHome.appendingPathComponent("cache/headless-uploads").path,
                                 root: home.appendingPathComponent("cache/headless-uploads").path))
        // A link inside the folder that leads out of it is outside.
        let uploads = home.appendingPathComponent("cache/headless-uploads")
        try FileManager.default.createDirectory(at: uploads, withIntermediateDirectories: true)
        let away = base.appendingPathComponent("away")
        try FileManager.default.createDirectory(at: away, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: uploads.appendingPathComponent("out"), withDestinationURL: away)
        XCTAssertFalse(U.isInside(uploads.appendingPathComponent("out").path, root: uploads.path))
    }

    func testAnUploadsFolderThatIsALinkIsRefused() throws {
        let base = try scratch()
        let real = base.appendingPathComponent("real")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let uploads = base.appendingPathComponent("uploads")
        try FileManager.default.createSymbolicLink(at: uploads, withDestinationURL: real)
        let source = base.appendingPathComponent("x.txt")
        try Data("x".utf8).write(to: source)
        XCTAssertEqual(U.copy([source], into: uploads.path, root: uploads.path), .failure(.notTheUploadsFolder))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: real.path), [])
    }
}

@MainActor
final class HeadlessPresentChromeTests: XCTestCase {
    typealias C = HeadlessPresentChromeState

    func testConnectingOffersNothingButClose() {
        let s = C.make(phase: .connecting, purpose: .watch, control: false)
        XCTAssertEqual(s.stateLine, "Connecting…")
        XCTAssertEqual(s.buttons, [])
        XCTAssertFalse(s.acceptsInput)
    }

    func testAHandOffWaitsForDoneOrStopWaiting() {
        let s = C.make(phase: .live, purpose: .handoff, control: true)
        XCTAssertEqual(s.stateLine, "Winter is waiting for you — finish here, then press Done")
        XCTAssertEqual(s.buttons.map(\.action), [.done, .stopWaiting])
        XCTAssertEqual(s.buttons.map(\.title), ["Done", "Stop waiting"])
        XCTAssertTrue(s.buttons[0].prominent)
        XCTAssertTrue(s.acceptsInput)
        XCTAssertTrue(s.buttonsEnabled)
    }

    func testWatchingOffersTakeOverAndSendsNothing() {
        let s = C.make(phase: .live, purpose: .watch, control: false)
        XCTAssertEqual(s.stateLine, "Watching Winter's headless tab")
        XCTAssertEqual(s.buttons.map(\.action), [.takeOver])
        XCTAssertFalse(s.acceptsInput)
    }

    func testHoldingControlOffersHandBack() {
        let s = C.make(phase: .live, purpose: .watch, control: true)
        XCTAssertEqual(s.stateLine, "You have control — Winter waits")
        XCTAssertEqual(s.buttons.map(\.action), [.handBack])
        XCTAssertTrue(s.acceptsInput)
    }

    func testAWindowThePageOpenedOffersOnlyTheCloseButton() {
        let s = C.make(phase: .live, purpose: .popup, control: true)
        XCTAssertEqual(s.stateLine, "A window the page opened — it closes when you are done")
        XCTAssertEqual(s.buttons, [])
        XCTAssertTrue(s.acceptsInput)
    }

    func testAnActionOnItsWayDisablesTheButtons() {
        let s = C.make(phase: .live, purpose: .watch, control: false, pending: .takeOver)
        XCTAssertFalse(s.buttonsEnabled)
        XCTAssertEqual(s.buttons.map(\.action), [.takeOver])
    }

    func testANoticeTakesTheLine() {
        let s = C.make(phase: .live, purpose: .watch, control: false, notice: "Winter isn't connected to its daemon right now")
        XCTAssertEqual(s.stateLine, "Winter isn't connected to its daemon right now")
        XCTAssertTrue(s.stateIsNotice)
    }

    func testAnEndedViewSaysWhyAndOffersNothing() {
        let s = C.make(phase: .ended("the presentation ended"), purpose: .handoff, control: true)
        XCTAssertEqual(s.stateLine, "The live view ended — the presentation ended")
        XCTAssertEqual(s.buttons, [])
        XCTAssertFalse(s.acceptsInput)
        XCTAssertEqual(C.endedLine(""), "The live view ended")
    }

    func testTheTitleLineFallsBackToTheHost() {
        XCTAssertEqual(C.titleLine(title: "Sign in", url: "https://accounts.example.com/x"), "Sign in")
        XCTAssertEqual(C.titleLine(title: "  ", url: "https://accounts.example.com/x"), "accounts.example.com")
        XCTAssertEqual(C.titleLine(title: "", url: "about:blank"), "about:blank")
        XCTAssertEqual(C.titleLine(title: "", url: ""), "Headless tab")
        XCTAssertEqual(C.tabLabel(BrowserLinkHeadlessTab(tabId: "t", url: "https://a.example/", title: "A", presented: false, control: false)),
                       "A — a.example")
    }

    func testADialogIsNamedAfterItsOwnOriginOrNoneAtAll() {
        XCTAssertEqual(C.dialogAuthor(origin: "https://accounts.example.com"), "accounts.example.com")
        XCTAssertEqual(C.dialogAuthor(origin: "http://127.0.0.1:8080"), "127.0.0.1")
        XCTAssertNil(C.dialogAuthor(origin: ""), "an opaque origin names no host")
        XCTAssertNil(C.dialogAuthor(origin: "not a url"))
    }

    func testTheAccessibilityWords() {
        XCTAssertEqual(C.accessibilityLabel(title: "Sign in", url: "https://accounts.example.com/"),
                       "Live page from Winter's headless browser: Sign in, accounts.example.com")
        XCTAssertEqual(C.accessibilityValue(control: true), "You have control")
        XCTAssertEqual(C.accessibilityValue(control: false), "Watching — Winter has control")
    }

    func testTheOfferedTabsLeaveOutTheShownOnes() {
        let tabs = [BrowserLinkHeadlessTab(tabId: "t1", url: "", title: "", presented: false, control: false),
                    BrowserLinkHeadlessTab(tabId: "t2", url: "", title: "", presented: true, control: false)]
        XCTAssertEqual(C.offeredTabs(tabs, shownTabIds: ["t2"]).map(\.tabId), ["t1"])
    }
}

/// What a closure recorded (the replier's closure is `@Sendable`).
private final class Recorded<T>: @unchecked Sendable {
    var values: [T] = []
}

/// The store's handling of the link's ops that need no producer: a show that is refused before (or at) the connect,
/// a hide of nothing, the session's list.
@MainActor
final class HeadlessPresentStoreTests: XCTestCase {
    private func show(service: String = "com.winter.headless.present.1.\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
                      uploadDir: String = "/h/cache/headless-uploads") -> BrowserLinkHeadlessCommand.Show {
        .init(sessionId: "s_1", tabId: "ht_1", service: service, nonce: 0x0123456789abcdef,
              producerRequirement: #"identifier "com.winter.headless" and anchor apple generic"#, control: false,
              purpose: .watch, url: "https://example.com/", title: "Example", uploadDir: uploadDir)
    }

    private func store() throws -> HeadlessPresentStore {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal device") }
        let store = HeadlessPresentStore(device: device)
        store.uploadsRoot = "/h/cache/headless-uploads"
        return store
    }

    func testAShowNamingAnotherFolderIsRefusedAndShowsNothing() throws {
        let store = try store()
        let shown = Recorded<String>()
        store.onShow = { shown.values.append($0) }
        guard case .failure(let code, _, _) = store.show(show(uploadDir: "/h/cache/elsewhere")) else {
            return XCTFail("should be refused")
        }
        XCTAssertEqual(code, .notAllowed)
        XCTAssertTrue(store.presentations.isEmpty)
        XCTAssertEqual(shown.values, [])
    }

    func testAShowWithNoUploadsFolderIsRefused() throws {
        let store = try store()
        store.uploadsRoot = nil
        guard case .failure(let code, _, _) = store.show(show()) else { return XCTFail("should be refused") }
        XCTAssertEqual(code, .notAllowed)
    }

    func testAShowWhoseServiceIsNotThereFailsWithItsReason() throws {
        let store = try store()
        let shown = Recorded<String>()
        store.onShow = { shown.values.append($0) }
        // Nobody checked this name in: the bootstrap lookup fails at once, no helper involved.
        guard case .failure(let code, let message, _) = store.show(show()) else { return XCTFail("should fail") }
        XCTAssertEqual(code, .notLive)
        XCTAssertTrue(message.contains("not there"), message)
        XCTAssertTrue(store.presentations.isEmpty)
        XCTAssertEqual(shown.values, [])
    }

    func testAHideOfNothingIsStillAnswered() throws {
        let store = try store()
        let answers = Recorded<BrowserLinkReply>()
        store.handle(BrowserLinkHeadlessCommand(linkId: "L", cmdId: "c", op: .hide(sessionId: "s_1", tabId: "ht_9", reason: "x")),
                     reply: BrowserLinkReplier { answers.values.append($0) })
        XCTAssertEqual(answers.values, [.empty])
    }

    func testTheSessionsTabsAreKeptAndOffered() throws {
        let store = try store()
        let tabs = [BrowserLinkHeadlessTab(tabId: "ht_1", url: "https://a.example/", title: "A", presented: false, control: false)]
        let answers = Recorded<BrowserLinkReply>()
        store.handle(BrowserLinkHeadlessCommand(linkId: "L", cmdId: "c", op: .tabs(sessionId: "s_1", tabs: tabs)),
                     reply: BrowserLinkReplier { answers.values.append($0) })
        XCTAssertEqual(answers.values, [.empty])
        XCTAssertEqual(store.tabsBySession["s_1"], tabs)
        XCTAssertEqual(store.offeredTabs(for: "s_1"), tabs)
        XCTAssertEqual(store.offeredTabs(for: "s_2"), [])
        XCTAssertEqual(store.offeredTabs(for: nil), [])
        // A new link: the old link's lists are stale.
        store.linkChanged()
        XCTAssertEqual(store.tabsBySession, [:])
    }

    func testAWatchWithNoLinkSaysSo() async throws {
        let store = try store()
        store.watch(sessionId: "s_1", tabId: "ht_1")
        XCTAssertTrue(store.watchPending.contains("ht_1"))
        for _ in 0..<200 where store.watchPending.contains("ht_1") {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertFalse(store.watchPending.contains("ht_1"))
        XCTAssertEqual(store.listNotice["s_1"], BrowserLinkHeadlessError.notConnected.message)
    }

    func testAWatchReachesTheLinkAsOneAction() async throws {
        let store = try store()
        let sent = Recorded<(String, String?, BrowserLinkHeadlessAction)>()
        store.sendAction = { sessionId, tabId, action in
            sent.values.append((sessionId, tabId, action))
            return nil
        }
        store.watch(sessionId: "s_1", tabId: "ht_1")
        for _ in 0..<200 where store.watchPending.contains("ht_1") {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(sent.values.count, 1)
        XCTAssertEqual(sent.values.first?.0, "s_1")
        XCTAssertEqual(sent.values.first?.1, "ht_1")
        XCTAssertEqual(sent.values.first?.2, .watch)
    }

    func testAnUpdateForATabNotShownIsStillAnswered() throws {
        let store = try store()
        let replies = Recorded<BrowserLinkReply>()
        store.handle(BrowserLinkHeadlessCommand(linkId: "L", cmdId: "c", op: .update(sessionId: "s_1", tabId: "ht_9", purpose: .handoff)),
                     reply: BrowserLinkReplier { replies.values.append($0) })
        XCTAssertEqual(replies.values, [.empty])
        XCTAssertTrue(store.presentations.isEmpty)
    }

    func testThePurposeFollowsTheDaemonUntilTheViewEnds() throws {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal device") }
        let presentation = HeadlessPresentation(show: show(), device: device, uploadsRoot: "/h/cache/headless-uploads")
        XCTAssertEqual(presentation.purpose, .watch)
        presentation.purposeChanged(.handoff)
        XCTAssertEqual(presentation.purpose, .handoff)
        presentation.close()
        presentation.purposeChanged(.watch)
        XCTAssertEqual(presentation.purpose, .handoff, "a closed view changes no more")
    }

    func testAListAnsweredAfterANewerPushNeverOverwritesIt() async throws {
        let store = try store()
        let gate = Recorded<CheckedContinuation<Void, Never>>()
        store.sendAction = { _, _, _ in
            await withCheckedContinuation { gate.values.append($0) }
            return [BrowserLinkHeadlessTab(tabId: "old", url: "", title: "", presented: false, control: false)]
        }
        store.refreshTabsIfNeeded(sessionId: "s_1")
        for _ in 0..<200 where gate.values.isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }
        // The daemon pushes a newer list while the fetch is out …
        let fresh = [BrowserLinkHeadlessTab(tabId: "new", url: "", title: "", presented: true, control: false)]
        store.handle(BrowserLinkHeadlessCommand(linkId: "L", cmdId: "c", op: .tabs(sessionId: "s_1", tabs: fresh)), reply: BrowserLinkReplier { _ in })
        // … and the fetch's older answer lands after it.
        gate.values.first?.resume()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(store.tabsBySession["s_1"]?.map(\.tabId), ["new"])
    }

    func testTheListIsFetchedOncePerLink() async throws {
        let store = try store()
        let lists = Recorded<BrowserLinkHeadlessAction>()
        store.sendAction = { _, tabId, action in
            XCTAssertNil(tabId)
            lists.values.append(action)
            return [BrowserLinkHeadlessTab(tabId: "ht_1", url: "", title: "", presented: false, control: false)]
        }
        store.refreshTabsIfNeeded(sessionId: "s_1")
        store.refreshTabsIfNeeded(sessionId: "s_1")
        for _ in 0..<200 where store.tabsBySession["s_1"] == nil {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(lists.values, [.list])
        XCTAssertEqual(store.tabsBySession["s_1"]?.map(\.tabId), ["ht_1"])
        store.linkChanged()
        store.refreshTabsIfNeeded(sessionId: "s_1")
        for _ in 0..<200 where lists.values.count < 2 {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(lists.values, [.list, .list])
    }
}
