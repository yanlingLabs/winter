import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Screenshot budgets and the shot → point coordinate mapping.
final class CaptureMathTests: XCTestCase {
    // MARK: budgets

    func testLongEdgeScalesDownAndNeverUp() {
        let b = CUImageBudget(maxLongEdge: 1440, quality: 0.8)
        let (w, h) = CUCaptureBudget.targetSize(source: CGSize(width: 2880, height: 1800), budget: b)
        XCTAssertEqual(w, 1440)
        XCTAssertEqual(h, 900)
        let small = CUCaptureBudget.targetSize(source: CGSize(width: 800, height: 600), budget: b)
        XCTAssertEqual(small.width, 800)
        XCTAssertEqual(small.height, 600)
    }

    func testAnthropicTileBudget() {
        // 28-px tiles, at most 1568 tiles, long edge 1568 (spine §5).
        let b = CUImageBudget(maxLongEdge: 1568, tile: 28, maxTiles: 1568, quality: 0.8)
        let (w, h) = CUCaptureBudget.targetSize(source: CGSize(width: 2880, height: 1800), budget: b)
        let tiles = ((w + 27) / 28) * ((h + 27) / 28)
        XCTAssertLessThanOrEqual(tiles, 1568)
        XCTAssertLessThanOrEqual(max(w, h), 1568)
        // Aspect ratio kept (16:10) within a pixel.
        XCTAssertEqual(Double(w) / Double(h), 1.6, accuracy: 0.01)
        // And it is not needlessly small: one step bigger would break the tile cap.
        let biggerTiles = ((w + 1 + 27) / 28) * ((h + 1 + 27) / 28)
        XCTAssertTrue(biggerTiles > 1568 || w >= 1568 || tiles > 1450, "fits the budget closely (\(w)×\(h), \(tiles) tiles)")
    }

    func testClaude5TileBudgetAllowsLargerImages() {
        let b = CUImageBudget(maxLongEdge: 2576, tile: 28, maxTiles: 4784, quality: 0.8)
        let (w, h) = CUCaptureBudget.targetSize(source: CGSize(width: 2880, height: 1800), budget: b)
        XCTAssertLessThanOrEqual(((w + 27) / 28) * ((h + 27) / 28), 4784)
        XCTAssertGreaterThan(w, 1568)
    }

    func testOpenAITiles() {
        let b = CUImageBudget(maxLongEdge: 1440, tile: 32, maxTiles: 1500, quality: 0.8)
        let (w, h) = CUCaptureBudget.targetSize(source: CGSize(width: 1440, height: 900), budget: b)
        XCTAssertLessThanOrEqual(((w + 31) / 32) * ((h + 31) / 32), 1500)
    }

    func testQualitySteps() {
        XCTAssertEqual(CUCaptureBudget.qualitySteps(start: 0.8), [0.8, 0.7, 0.6, 0.5, 0.4])
        XCTAssertEqual(CUCaptureBudget.qualitySteps(start: 0.4), [0.4])
        XCTAssertEqual(CUCaptureBudget.qualitySteps(start: 0.1), [0.4], "never below the floor")
    }

    func testEncodeStepsQualityThenSizeUnderTheCap() {
        var calls: [(Int, Int, Double)] = []
        // Size grows with pixels × quality; the cap is reached only after shrinking once.
        let result = CUCaptureBudget.encodeWithinCap(width: 1000, height: 1000, quality: 0.8, byteCap: 300_000) { w, h, q in
            calls.append((w, h, q))
            return Data(count: Int(Double(w * h) * q))
        }
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.width, 800)
        XCTAssertLessThanOrEqual(result!.data.count, 300_000)
        XCTAssertEqual(calls.prefix(5).map(\.2), [0.8, 0.7, 0.6, 0.5, 0.4], "quality steps first at full size")
        XCTAssertEqual(calls[5].0, 800, "then the size steps down")
    }

    func testEncodeFailureIsNil() {
        XCTAssertNil(CUCaptureBudget.encodeWithinCap(width: 10, height: 10, quality: 0.8) { _, _, _ in nil })
    }

    // MARK: coordinate spaces

    func testWindowShotMapsPixelsToWindowRelativePoints() throws {
        // A 2x Retina window region 800×600 points captured into a 1200×900 image (budget-scaled).
        let shot = CUShotSpace(id: "t1.i1", anchor: .window(windowID: 42, regionOrigin: CGPoint(x: 10, y: 20)),
                               imageWidth: 1200, imageHeight: 900, pointsWidth: 800, pointsHeight: 600)
        XCTAssertEqual(try shot.localPoint(pixel: CGPoint(x: 600, y: 450)), CGPoint(x: 410, y: 320))
        // Window moved: the same pixel follows it.
        XCTAssertEqual(try shot.screenPoint(pixel: CGPoint(x: 600, y: 450), windowOrigin: CGPoint(x: 100, y: 50)),
                       CGPoint(x: 510, y: 370))
        XCTAssertEqual(try shot.screenPoint(pixel: .zero, windowOrigin: CGPoint(x: 100, y: 50)), CGPoint(x: 110, y: 70))
    }

    func testScreenShotMapsToGlobalPoints() throws {
        // Two displays side by side, union origin at (-1440, 0), captured at half size.
        let shot = CUShotSpace(id: "screen.i1", anchor: .screen(origin: CGPoint(x: -1440, y: 0)),
                               imageWidth: 1440, imageHeight: 450, pointsWidth: 2880, pointsHeight: 900)
        XCTAssertEqual(try shot.screenPoint(pixel: CGPoint(x: 720, y: 225)), CGPoint(x: 0, y: 450))
        XCTAssertEqual(try shot.screenPoint(pixel: CGPoint(x: 0, y: 0)), CGPoint(x: -1440, y: 0))
    }

    func testOutOfBoundsErrorHintsAtWindowPointsOrA2xValue() {
        // A 1280×803 image of a 1512×949 pt window (a < 1 scale, like the live VRoid case).
        let shot = CUShotSpace(id: "t1.i1", anchor: .window(windowID: 42, regionOrigin: .zero),
                               imageWidth: 1280, imageHeight: 803, pointsWidth: 1512, pointsHeight: 949)
        func message(_ x: Double, _ y: Double) -> String {
            do { _ = try shot.localPoint(pixel: CGPoint(x: x, y: y)); return "" }
            catch { return (error as? CUError)?.message ?? "" }
        }
        // Beyond the image px but within the window's points: a window-points mistake.
        let points = message(1400, 900)
        XCTAssertTrue(points.contains("valid x 0–1280, y 0–803 px (window 1512×949 pt)"), points)
        XCTAssertTrue(points.contains("looks like window points"), points)
        // The live case: [2000, 200] on a 1280×803 image is a 2× (Retina/backing) value.
        let retina = message(2000, 200)
        XCTAssertTrue(retina.contains("looks like a 2× (Retina) value"), retina)
    }


    func testOutOfImagePointsAreRejected() {
        let shot = CUShotSpace(id: "s", anchor: .screen(origin: .zero), imageWidth: 100, imageHeight: 100,
                               pointsWidth: 100, pointsHeight: 100)
        XCTAssertThrowsError(try shot.screenPoint(pixel: CGPoint(x: 101, y: 5))) {
            XCTAssertEqual(($0 as? CUError)?.code, "invalid_params")
        }
        XCTAssertThrowsError(try shot.screenPoint(pixel: CGPoint(x: -1, y: 5)))
        XCTAssertThrowsError(try shot.screenPoint(pixel: CGPoint(x: Double.nan, y: 5)))
        // A window shot needs the window's origin.
        let w = CUShotSpace(id: "w", anchor: .window(windowID: 1, regionOrigin: .zero), imageWidth: 10, imageHeight: 10,
                            pointsWidth: 10, pointsHeight: 10)
        XCTAssertThrowsError(try w.screenPoint(pixel: .zero))
    }

    func testWirePointAndRectParsing() throws {
        XCTAssertEqual(try cuPoint([3, 4]), CGPoint(x: 3, y: 4))
        XCTAssertNil(try cuPoint(nil))
        XCTAssertThrowsError(try cuPoint([1]))
        XCTAssertEqual(try cuRect([1, 2, 3, 4]), CGRect(x: 1, y: 2, width: 3, height: 4))
        XCTAssertThrowsError(try cuRect([1, 2, 0, 4]))
        XCTAssertEqual(cuFrame(CGRect(x: 1, y: 2, width: 3, height: 4)), [1, 2, 3, 4])
    }

    func testTargetShotLookup() throws {
        let t = CUTarget(id: "t9", sessionId: "s", pid: 1, bundleId: nil, appName: "X", isChromium: false, mirror: false,
                         windowID: 5, windowTitle: "")
        XCTAssertThrowsError(try t.shot(nil)) { XCTAssertEqual(($0 as? CUError)?.code, "invalid_params") }
        var ids: [String] = []
        for _ in 0..<10 {
            ids.append(t.registerShot(anchor: .window(windowID: 5, regionOrigin: .zero), imageWidth: 10, imageHeight: 10,
                                      points: CGSize(width: 10, height: 10)).id)
        }
        XCTAssertEqual(try t.shot(nil).id, ids.last)
        XCTAssertEqual(try t.shot(ids[5]).id, ids[5])
        XCTAssertThrowsError(try t.shot(ids[0]), "only the last 8 are kept")
    }
}
