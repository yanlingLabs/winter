import CoreGraphics
import XCTest
@testable import WinterCUPresentation

@MainActor final class RecordingWatchRing: WatchRingSurface {
    var placed: [(ring: CGRect?, pill: CGRect, sentence: String)] = []
    var closed = false
    func place(ring: CGRect?, pill: CGRect, sentence: String) { placed.append((ring, pill, sentence)) }
    func close() { closed = true }
    func pillWidth(for sentence: String) -> CGFloat { CGFloat(sentence.count * 6) }
}

@MainActor final class RecordingWatchRingFactory: WatchRingSurfaceFactory {
    var made: [RecordingWatchRing] = []
    func make() -> WatchRingSurface {
        let s = RecordingWatchRing()
        made.append(s)
        return s
    }
}

final class WatchRingModelTests: XCTestCase {
    func testThePillsSentenceNamesOnlyTheElementsOwnLabel() {
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "clicked", label: "Submit for review"),
                       "Winter continues when you click \u{201C}Submit for review\u{201D}")
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "changed", label: "Name"), "Winter continues when you change \u{201C}Name\u{201D}")
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "gone", label: "Uploading"), "Winter continues when \u{201C}Uploading\u{201D} goes away")
        // The window-wide kinds name nothing at all: the text the model waits for never reaches the user's screen.
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "appeared", label: nil), "Winter continues when this window changes")
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "gone", label: nil), "Winter continues when this window changes")
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "titled", label: nil), "Winter continues when this window\u{2019}s title changes")
        // A label is one sanitized line, cut short.
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "clicked", label: "Pay\u{202E}\nnow"), "Winter continues when you click \u{201C}Pay now\u{201D}")
        XCTAssertTrue(CUWatchRingModel.sentence(kind: "clicked", label: String(repeating: "x", count: 200)).hasSuffix("…\u{201D}"))
        XCTAssertEqual(CUWatchRingModel.sentence(kind: "clicked", label: ""), "Winter continues when you click this")
    }

    func testTheRingIsClippedToTheWindowAndGoneWhenTheElementIsOutOfIt() {
        let window = CGRect(x: 0, y: 0, width: 400, height: 300)
        XCTAssertEqual(CUWatchRingModel.ringFrame(element: CGRect(x: 10, y: 10, width: 50, height: 20), window: window),
                       CGRect(x: 6, y: 6, width: 58, height: 28))
        XCTAssertEqual(CUWatchRingModel.ringFrame(element: CGRect(x: 380, y: 10, width: 50, height: 20), window: window),
                       CGRect(x: 376, y: 6, width: 28, height: 28))
        XCTAssertNil(CUWatchRingModel.ringFrame(element: CGRect(x: 10, y: 900, width: 50, height: 20), window: window), "scrolled out of view")
        XCTAssertNil(CUWatchRingModel.ringFrame(element: nil, window: window))
    }

    func testThePillSitsUnderTheRingOrAboveItOrAtTheWindowsTop() {
        let window = CGRect(x: 100, y: 100, width: 600, height: 400)
        let below = CUWatchRingModel.pillFrame(ring: CGRect(x: 300, y: 200, width: 80, height: 30), window: window, width: 200)
        XCTAssertEqual(below, CGRect(x: 240, y: 236, width: 200, height: CUWatchRingModel.pillHeight))
        let above = CUWatchRingModel.pillFrame(ring: CGRect(x: 300, y: 480, width: 80, height: 18), window: window, width: 200)
        XCTAssertEqual(above.maxY, 480 - CUWatchRingModel.pillGap)
        let top = CUWatchRingModel.pillFrame(ring: nil, window: window, width: 200)
        XCTAssertEqual(top.minY, 134)
        XCTAssertEqual(top.midX, window.midX)
        // Held inside the window, and never wider than the cap.
        let edge = CUWatchRingModel.pillFrame(ring: CGRect(x: 100, y: 200, width: 10, height: 10), window: window, width: 2_000)
        XCTAssertGreaterThanOrEqual(edge.minX, window.minX + 8)
        XCTAssertLessThanOrEqual(edge.width, CUWatchRingModel.pillMaxWidth)
    }

    @MainActor func testTheControllerDrawsEachWatchOnceMovesItAndClosesItWhenItLeaves() {
        let factory = RecordingWatchRingFactory()
        let c = CUWatchRingController(surfaces: factory)
        let window = CGRect(x: 0, y: 0, width: 500, height: 400)
        let a = CUWatchRing(watchId: "wk_a", kind: "clicked", label: "Send", elementFrame: CGRect(x: 10, y: 10, width: 40, height: 20),
                            windowFrame: window)
        c.show([a])
        c.show([a])
        XCTAssertEqual(factory.made.count, 1)
        XCTAssertEqual(factory.made[0].placed.count, 1, "an unchanged ring is not placed again")
        XCTAssertEqual(factory.made[0].placed[0].sentence, "Winter continues when you click \u{201C}Send\u{201D}")
        let moved = CUWatchRing(watchId: "wk_a", kind: "clicked", label: "Send", elementFrame: CGRect(x: 10, y: 60, width: 40, height: 20),
                                windowFrame: window)
        c.show([moved, CUWatchRing(watchId: "wk_b", kind: "titled", label: nil, elementFrame: nil, windowFrame: window)])
        XCTAssertEqual(factory.made.count, 2)
        XCTAssertEqual(factory.made[0].placed.count, 2, "moved with its element")
        XCTAssertNil(factory.made[1].placed[0].ring, "a window-wide watch has the pill only")
        XCTAssertEqual(c.shownIds, ["wk_a", "wk_b"])
        c.show([])
        XCTAssertTrue(factory.made.allSatisfy(\.closed))
        XCTAssertEqual(c.shownIds, [])
    }
}
