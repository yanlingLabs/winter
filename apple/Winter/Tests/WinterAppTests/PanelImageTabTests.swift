import AppKit
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Winter

/// Transcript file links (2026-09-30): an image path opens as a `.code` tab that renders the native
/// image viewer (`PanelImageTab`) — decided at the rendering boundary, never on the wire.
@MainActor
final class PanelImageTabTests: XCTestCase {

    // MARK: - The routing decision (PURE)

    func testWhichPathsAreImages() {
        for path in ["/a/b.png", "/a/b.PNG", "/a/b.jpg", "/a/b.jpeg", "/a/b.gif", "/a/b.webp",
                     "/a/b.heic", "/a/b.heif", "/a/b.tif", "/a/b.tiff", "/a/b.bmp"] {
            XCTAssertTrue(panelCodeTabShowsImage(path: path), path)
        }
        for path in ["/a/b.svg", "/a/b.ts", "/a/b.docx", "/a/png", "/a/b", ""] {
            XCTAssertFalse(panelCodeTabShowsImage(path: path), path)
        }
        XCTAssertFalse(panelCodeTabShowsImage(path: nil))
    }

    /// An image stays a `.code` tab on the wire — the router never mints a new kind an older app or
    /// the phone could not decode.
    func testTheFileRouterStillAnswersCodeForAnImage() {
        XCTAssertEqual(panelTabKind(forFilePath: "/tmp/shot.png"), .code)
        XCTAssertEqual(panelTabKind(forFilePath: "/tmp/deck.pptx"), .document)
    }

    func testAnImageCodeTabRendersTheViewerAndNeverTheEditor() {
        let image = PanelTab(tabId: "img", kind: .code, url: "/tmp/winter-session-s_1/images/image_1.png",
                             title: "image_1.png")
        let content = panelTabContent(for: image)
        guard let viewer = content as? PanelImageTab else {
            return XCTFail("an image path must render the image viewer, got \(type(of: content))")
        }
        XCTAssertEqual(viewer.kind, .code)
        XCTAssertEqual(viewer.title, "image_1.png")

        let code = PanelTab(tabId: "code", kind: .code, url: "/repo/a.ts", title: "a.ts")
        XCTAssertTrue(panelTabContent(for: code) is PanelEditorTab, "a code path still gets the editor")
        PanelEditorTabModels.discard(tabId: "code")
    }

    func testSaveNeverTargetsAnImageTab() {
        let image = PanelTab(tabId: "img", kind: .code, url: "/tmp/a.png", title: "a.png")
        XCTAssertNil(editorSaveMenuTarget(tabs: [image], activeTabId: "img"),
                     "an image is a viewer — ⌘S has nothing to save")
        let code = PanelTab(tabId: "code", kind: .code, url: "/repo/a.ts", title: "a.ts")
        XCTAssertEqual(editorSaveMenuTarget(tabs: [code], activeTabId: "code")?.tabId, "code")
    }

    func testTheStripShowsAPhotoGlyphForAnImageTab() {
        let image = PanelTab(tabId: "img", kind: .code, url: "/tmp/a.jpg", title: "a.jpg")
        let code = PanelTab(tabId: "code", kind: .code, url: "/repo/a.ts", title: "a.ts")
        XCTAssertEqual(panelTabPillSystemImage(image), "photo")
        XCTAssertEqual(panelTabPillSystemImage(code), panelTabFaviconSystemImage(.code))
        XCTAssertEqual(panelTabPillSystemImage(PanelTab(tabId: "w", kind: .web)), panelTabFaviconSystemImage(.web))
        for symbol in ["photo", "folder", "arrow.up.forward.app"] {
            XCTAssertNotNil(NSImage(systemSymbolName: symbol, accessibilityDescription: nil),
                            "\(symbol) is not a real SF Symbol")
        }
    }

    func testThePixelSizeCaption() {
        XCTAssertEqual(panelImagePixelSizeCaption(CGSize(width: 1920, height: 1080)), "1920 × 1080")
    }

    // MARK: - The loader

    private var scratch: URL!

    override func setUp() async throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("panel-image-tab-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        DownsampledImageLoader.removeAllForTesting()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: scratch)
        DownsampledImageLoader.removeAllForTesting()
    }

    private func writePNG(width: Int, height: Int, named name: String) throws -> String {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let url = scratch.appendingPathComponent(name)
        let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return url.path
    }

    func testALargeImageIsDownsampledAndKeepsItsOriginalSize() throws {
        let path = try writePNG(width: 800, height: 400, named: "wide.png")
        guard case .loaded(let image, let original) = DownsampledImageLoader.loadSynchronously(
            path: path, maxPixelSize: 100) else {
            return XCTFail("a real PNG must load")
        }
        XCTAssertEqual(original, CGSize(width: 800, height: 400))
        XCTAssertEqual(image.size, CGSize(width: 100, height: 50), "capped on the long edge, aspect kept")
        guard case .loaded? = DownsampledImageLoader.cached(path: path, maxPixelSize: 100) else {
            return XCTFail("a load fills the synchronous cache")
        }
        XCTAssertNil(DownsampledImageLoader.cached(path: path, maxPixelSize: 200),
                     "the cache is keyed by size as well as path")
    }

    func testMissingDirectoryAndNonImageFiles() throws {
        guard case .notFound = DownsampledImageLoader.loadSynchronously(
            path: scratch.appendingPathComponent("missing.png").path, maxPixelSize: 100) else {
            return XCTFail("a missing file is notFound")
        }
        let folder = scratch.appendingPathComponent("folder.png")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard case .notFound = DownsampledImageLoader.loadSynchronously(path: folder.path, maxPixelSize: 100) else {
            return XCTFail("a directory is not an image file")
        }
        let text = scratch.appendingPathComponent("notes.png")
        try "not an image".write(to: text, atomically: true, encoding: .utf8)
        guard case .unreadable = DownsampledImageLoader.loadSynchronously(path: text.path, maxPixelSize: 100) else {
            return XCTFail("bytes ImageIO cannot decode are unreadable, not a crash")
        }
    }

    func testAnEditedFileIsDecodedAgain() async throws {
        let path = try writePNG(width: 40, height: 40, named: "edit.png")
        guard case .loaded(let first, _) = await DownsampledImageLoader.load(path: path, maxPixelSize: 100) else {
            return XCTFail("first load")
        }
        // Replace the file with a different size and a later modification date.
        try FileManager.default.removeItem(atPath: path)
        _ = try writePNG(width: 60, height: 30, named: "edit.png")
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: path)
        guard case .loaded(let second, let original) = await DownsampledImageLoader.load(path: path,
                                                                                         maxPixelSize: 100) else {
            return XCTFail("second load")
        }
        XCTAssertFalse(first === second, "a changed file is not served from the cache")
        XCTAssertEqual(original, CGSize(width: 60, height: 30))
        let size = await DownsampledImageLoader.pixelSize(path: path)
        XCTAssertEqual(size, CGSize(width: 60, height: 30), "the chrome's header-only read")
    }
}
