import XCTest
@testable import Winter

/// Renders the island's phase-2 activity offscreen (`IslandActivityGallery`) — no window, nothing on screen, nothing
/// captured — into the folder `WINTER_ISLAND_RENDER_DIR` names (pass it as `TEST_RUNNER_WINTER_ISLAND_RENDER_DIR`), else
/// a temporary folder removed afterwards. Asserts every picture was written.
@MainActor
final class IslandActivityGalleryTests: XCTestCase {
    func testTheActivityGalleryRendersOffscreen() throws {
        let named = ProcessInfo.processInfo.environment["WINTER_ISLAND_RENDER_DIR"].flatMap { $0.isEmpty ? nil : $0 }
        let directory = named.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("winter-island-activity-gallery-\(UUID().uuidString)")
        if named == nil { addTeardownBlock { try? FileManager.default.removeItem(at: directory) } }
        let files = try IslandActivityGallery.render(to: directory)
        XCTAssertGreaterThanOrEqual(files.count, 10)
        for file in files {
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
            XCTAssertGreaterThan(size, 1_000, file.lastPathComponent)
        }
    }
}
