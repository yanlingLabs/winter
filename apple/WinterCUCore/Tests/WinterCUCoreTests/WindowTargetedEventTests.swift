import CoreGraphics
import XCTest
@testable import WinterCUCore

/// What the private setters were called with (a C function pointer can't capture, so it records here).
enum SPIRecord {
    nonisolated(unsafe) static var fields: [(field: UInt32, value: Int64)] = []
    nonisolated(unsafe) static var locations: [CGPoint] = []
    static func reset() { fields = []; locations = [] }
}

private let recordField: CUSkyLight.SetIntField = { _, field, value in SPIRecord.fields.append((field, value)) }
private let recordLocation: CUSkyLight.SetWindowLocation = { _, x, y in SPIRecord.locations.append(CGPoint(x: x, y: y)) }

/// SkyLight with only the two setters, recording into `SPIRecord` (posting stays on the public route).
func recordingSkyLight() -> CUSkyLight {
    CUSkyLight.resolve { name in
        switch name {
        case "SLEventSetIntegerValueField": return unsafeBitCast(recordField, to: UnsafeMutableRawPointer.self)
        case "CGEventSetWindowLocation": return unsafeBitCast(recordLocation, to: UnsafeMutableRawPointer.self)
        default: return nil
        }
    }
}

/// The window-targeted pid event: fields 91 and 92 = the window id, field 51 =
/// its number, and the window-LOCAL location (screen point minus the window's bounds origin) on the public
/// route; SkyLight's route keeps the screen point.
final class WindowTargetedEventTests: XCTestCase {
    private func synth(_ poster: RecordingPoster, spi: Bool = true) -> CUEventSynth {
        var s = CUEventSynth(poster: poster, skyLight: recordingSkyLight())
        s.sleep = { _ in }
        s.windowOrigin = { $0 == 77 ? CGPoint(x: 100, y: 120) : nil }
        s.windowSPI = spi
        return s
    }

    override func setUp() { SPIRecord.reset() }

    func testThePublicRouteAddressesTheWindowWithItsLocalPoint() throws {
        let poster = RecordingPoster()
        try synth(poster).click(pid: 9, windowFor: { _ in 77 }, at: CGPoint(x: 130, y: 155), button: .left, count: 1,
                                flags: [], route: .publicPid)
        XCTAssertEqual(poster.entries.map(\.type), [.leftMouseDown, .leftMouseUp])
        XCTAssertTrue(poster.entries.allSatisfy { $0.window == 77 && $0.window2 == 77 }, "fields 91 and 92")
        XCTAssertTrue(poster.entries.allSatisfy { $0.subtype == 3 }, "field 7 = 3, the synthesized-mouse subtype (as cua-driver stamps it)")
        XCTAssertTrue(poster.entries.allSatisfy { $0.location == CGPoint(x: 130, y: 155) }, "the event's own location stays global")
        XCTAssertEqual(SPIRecord.locations, [CGPoint(x: 30, y: 35), CGPoint(x: 30, y: 35)], "window-local: point − origin")
        XCTAssertEqual(SPIRecord.fields.map(\.field), [51, 51])
        XCTAssertEqual(SPIRecord.fields.map(\.value), [77, 77])
    }

    func testWheelAndDragAreAddressedTheSameWay() throws {
        let poster = RecordingPoster()
        try synth(poster).scroll(pid: 9, windowFor: { _ in 77 }, at: CGPoint(x: 200, y: 220), deltaX: 0, deltaY: -100, route: .publicPid)
        XCTAssertEqual(SPIRecord.locations.first, CGPoint(x: 100, y: 100))
        SPIRecord.reset()
        try synth(poster).drag(pid: 9, windowFor: { _ in 77 }, from: CGPoint(x: 100, y: 120), to: CGPoint(x: 300, y: 120),
                               route: .publicPid, steps: 2)
        XCTAssertEqual(SPIRecord.locations.first, .zero, "the window's own top-left")
        XCTAssertEqual(SPIRecord.locations.last, CGPoint(x: 200, y: 0))
    }

    func testSkyLightKeepsTheScreenPointAndThePrivatePathOffUsesNoSetter() throws {
        let poster = RecordingPoster()
        try synth(poster).click(pid: 9, windowFor: { _ in 77 }, at: CGPoint(x: 130, y: 155), button: .right, count: 1,
                                flags: [], route: .skyLight)
        XCTAssertTrue(SPIRecord.locations.allSatisfy { $0 == CGPoint(x: 130, y: 155) }, "WindowServer derives the local point there")
        SPIRecord.reset()
        try synth(poster, spi: false).click(pid: 9, windowFor: { _ in 77 }, at: CGPoint(x: 130, y: 155), button: .left, count: 1,
                                            flags: [], route: .publicPid)
        XCTAssertTrue(SPIRecord.locations.isEmpty && SPIRecord.fields.isEmpty, "no private setter with the private path off")
        XCTAssertEqual(poster.entries.last?.window2, 77, "the public fields 91/92 still name the window")
    }

    func testWindowLocalIsAPlainOffset() {
        XCTAssertEqual(CUEventSynth.windowLocal(CGPoint(x: 130, y: 155), origin: CGPoint(x: 100, y: 120)), CGPoint(x: 30, y: 35))
        XCTAssertEqual(CUEventSynth.windowLocal(CGPoint(x: -1, y: -1), origin: CGPoint(x: 1920, y: 0)), CGPoint(x: -1921, y: -1),
                       "a window on a display to the right")
    }
}
