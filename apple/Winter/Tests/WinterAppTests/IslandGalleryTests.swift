import XCTest
@testable import Winter

/// Renders the Winter island offscreen (`IslandGallery`) — no window, nothing on screen — into the folder
/// `WINTER_ISLAND_RENDER_DIR` names (pass it as `TEST_RUNNER_WINTER_ISLAND_RENDER_DIR` to `xcodebuild test`), else a
/// temporary folder removed afterwards. Asserts every picture was written.
@MainActor
final class IslandGalleryTests: XCTestCase {
    func testTheGalleryRendersOffscreen() throws {
        let named = ProcessInfo.processInfo.environment["WINTER_ISLAND_RENDER_DIR"].flatMap { $0.isEmpty ? nil : $0 }
        let directory = named.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("winter-island-gallery-\(UUID().uuidString)")
        if named == nil { addTeardownBlock { try? FileManager.default.removeItem(at: directory) } }
        let files = try IslandGallery.render(to: directory)
        XCTAssertGreaterThanOrEqual(files.count, 12)
        for file in files {
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
            XCTAssertGreaterThan(size, 1_000, file.lastPathComponent)
        }
    }

    func testTheLayoutHangsFromTheHousingOrTheTopEdge() {
        let notched = IslandScreenShape(housing: CGSize(width: 185, height: 32), menuBarHeight: 32)
        // Idle: exactly the housing (no wings over the menu bar); without a housing, nothing at all.
        XCTAssertEqual(IslandLayout.strip(notched, waiting: false), CGRect(x: -92.5, y: 0, width: 185, height: 32))
        XCTAssertNil(IslandLayout.strip(IslandScreenShape(housing: nil, menuBarHeight: 24), waiting: false))
        let strip = IslandLayout.strip(notched)
        XCTAssertEqual(strip.width, 185 + 2 * IslandLayout.stripWing, "the strip extends the housing on both sides")
        XCTAssertEqual(strip.height, 32)
        XCTAssertEqual(strip.midX, 0, accuracy: 0.01)
        let plain = IslandScreenShape(housing: nil, menuBarHeight: 24)
        XCTAssertEqual(IslandLayout.strip(plain).height, 24, "without a housing: a tab at the top centre")
        XCTAssertEqual(IslandLayout.strip(plain).width, IslandLayout.stripWidthWithoutHousing)
        let g = IslandLayout.cardGeometry(notched, size: CGSize(width: 400, height: 120), rounded: true)
        XCTAssertEqual(g.pill.minY, 32 + 10, "a card rests just below the housing")
        XCTAssertEqual(g.pill.height, 120)
        XCTAssertEqual(g.bodyCornerRadius, IslandLayout.cardCorner)
        XCTAssertTrue(g.sourceIsHousing)
        XCTAssertFalse(IslandLayout.cardGeometry(plain, size: CGSize(width: 400, height: 120), rounded: true).sourceIsHousing)
    }
}
