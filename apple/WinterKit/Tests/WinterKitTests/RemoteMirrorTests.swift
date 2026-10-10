import CoreGraphics
import ImageIO
import os
import XCTest
import WinterProtocol
import WinterSessionKit
@testable import WinterKit

/// ComputerV2 Phase 1b — the phone mirror's wire, its per-watch relay (order, coalescing, pacing) and the picture
/// fitter that keeps every frame inside the phone transport's cap.
final class RemoteMirrorTests: XCTestCase {

    // MARK: - Fixtures

    /// A real JPEG of `width × height`, filled with noise (`noise: true`, the worst case for size) or a flat grey.
    static func jpeg(width: Int, height: Int, noise: Bool = true, quality: Double = 0.95) -> Data {
        var bytes = [UInt8](repeating: 128, count: width * height * 4)
        if noise {
            // xorshift64*, eight bytes a step — fast enough in a debug build for a 2-megapixel fixture.
            var x: UInt64 = 0x9E37_79B9_7F4A_7C15 ^ UInt64(width * 31 + height)
            bytes.withUnsafeMutableBytes { raw in
                let words = raw.bindMemory(to: UInt64.self)
                for i in 0..<words.count {
                    x ^= x >> 12; x ^= x << 25; x ^= x >> 27
                    words[i] = x &* 0x2545_F491_4F6C_DD1D
                }
            }
        }
        for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        return MirrorFrameFitter.encodeJPEG(image, quality: quality)!
    }

    static func pixelSize(_ jpeg: Data) -> (Int, Int)? {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return (w, h)
    }

    // MARK: - The wire

    func testEveryUpdateRoundTripsThroughTheJSONPayload() {
        let frame = MirrorFrame(seq: 7, jpeg: Data([0xFF, 0xD8, 0xFF, 0x00, 0x2F, 0x2B]), width: 640, height: 400, windowSize: CGSize(width: 1280, height: 800))
        let updates: [MirrorUpdate] = [
            .show(app: "Safari", windowSize: CGSize(width: 1280, height: 800), others: 2, live: true),
            .show(app: "Notes", windowSize: .zero, others: 0, live: false),
            .reset,
            .frame(frame),
            .cursor(MirrorCursor(kind: "press", point: CGPoint(x: 10.5, y: 20), count: 2, button: "left")),
            .cursor(MirrorCursor(kind: "drag", point: CGPoint(x: 1, y: 2), dragTo: CGPoint(x: 3, y: 4), frame: CGRect(x: 5, y: 6, width: 7, height: 8), text: "⌘C")),
            .clear,
        ]
        for update in updates {
            XCTAssertEqual(MirrorWire.decode(MirrorWire.encode(update)), update, "\(update)")
        }
    }

    func testAnUnknownOrBrokenPayloadDecodesToNothing() {
        XCTAssertNil(MirrorWire.decode(Data(#"{"type":"teleport"}"#.utf8)))
        XCTAssertNil(MirrorWire.decode(Data(#"{"type":"frame","jpeg":"!!!"}"#.utf8)))
        XCTAssertNil(MirrorWire.decode(Data(#"{"type":"cursor","kind":"press","point":[1]}"#.utf8)))
        XCTAssertNil(MirrorWire.decode(Data("not json".utf8)))
    }

    func testCursorTextIsCappedOnTheWire() {
        let long = String(repeating: "x", count: 5000)
        guard case .cursor(let c)? = MirrorWire.decode(MirrorWire.encode(.cursor(MirrorCursor(kind: "caption", point: .zero, text: long)))) else {
            return XCTFail("expected a cursor")
        }
        XCTAssertEqual(c.text?.count, MirrorWire.maxTextLength)
    }

    /// The transport hard-fails on an oversized frame (1 MiB): the WORST picture the fitter can let through — exactly
    /// `maxJPEGBytes` of incompressible bytes — must still make an envelope well under the Gateway's own cap, and the
    /// phone's strict decode must take it.
    func testTheWorstCasePictureEnvelopeStaysWellUnderTheTransportCap() throws {
        var rng = SystemRandomNumberGenerator()
        let bytes = Data((0..<MirrorWire.maxJPEGBytes / 8).flatMap { _ in withUnsafeBytes(of: rng.next()) { Array($0) } })
        XCTAssertEqual(bytes.count, MirrorWire.maxJPEGBytes)
        let frame = MirrorFrame(seq: Int.max, jpeg: bytes, width: MirrorWire.maxLongEdge, height: MirrorWire.maxLongEdge,
                                windowSize: CGSize(width: 99999.5, height: 99999.5))
        let envelope = WireEnvelope(v: 1, pairingEpoch: Int.max, hostID: String(repeating: "h", count: 64), sessionID: "s_" + String(repeating: "x", count: 64),
                                    streamID: nil, seq: nil, kind: .mirror, timestamp: Int.max, payload: MirrorWire.encode(.frame(frame)))
        let encoded = try WireFrame.encode(envelope)
        XCTAssertLessThanOrEqual(encoded.count, MirrorWire.maxEnvelopeBytes)
        XCTAssertLessThan(MirrorWire.maxEnvelopeBytes, (1 << 20) / 2, "the Gateway's cap keeps a 2× margin under the transport's")
        let decoded = try WireFrame.decode(encoded, expectedEpoch: Int.max)
        XCTAssertEqual(decoded.kind, .mirror)
        XCTAssertNil(decoded.seq)
        XCTAssertNil(decoded.streamID)
        XCTAssertEqual(MirrorWire.decode(decoded.payload), .frame(frame))
    }

    // MARK: - Fitting a picture

    func testASmallPictureWithinBothCapsPassesThroughUntouched() {
        let jpeg = Self.jpeg(width: 320, height: 200, noise: false)
        let frame = MirrorFrame(seq: 1, jpeg: jpeg, width: 320, height: 200, windowSize: CGSize(width: 640, height: 400))
        XCTAssertEqual(MirrorFrameFitter.fit(frame), frame)
    }

    func testALargePictureIsCutToTheLongEdgeAndTheByteCapKeepingItsShape() throws {
        let jpeg = Self.jpeg(width: 1440, height: 900)
        XCTAssertGreaterThan(jpeg.count, MirrorWire.maxJPEGBytes, "the fixture must start over the cap")
        let frame = MirrorFrame(seq: 3, jpeg: jpeg, width: 1440, height: 900, windowSize: CGSize(width: 1440, height: 900))
        let fitted = try XCTUnwrap(MirrorFrameFitter.fit(frame))
        XCTAssertLessThanOrEqual(max(fitted.width, fitted.height), MirrorWire.maxLongEdge)
        XCTAssertEqual(fitted.width, MirrorWire.maxLongEdge)
        XCTAssertEqual(Double(fitted.height), 900.0 * Double(MirrorWire.maxLongEdge) / 1440.0, accuracy: 1)
        XCTAssertLessThanOrEqual(fitted.jpeg.count, MirrorWire.maxJPEGBytes)
        XCTAssertEqual(fitted.seq, 3)
        XCTAssertEqual(fitted.windowSize, frame.windowSize, "the window's size in points is the cursor's frame of reference — never rescaled")
        let size = try XCTUnwrap(Self.pixelSize(fitted.jpeg))
        XCTAssertEqual(size.0, fitted.width)
        XCTAssertEqual(size.1, fitted.height)
    }

    func testATallWindowIsCutOnItsLongEdge() throws {
        let frame = MirrorFrame(seq: 1, jpeg: Self.jpeg(width: 720, height: 1400, noise: false), width: 720, height: 1400, windowSize: CGSize(width: 720, height: 1400))
        let fitted = try XCTUnwrap(MirrorFrameFitter.fit(frame))
        XCTAssertEqual(fitted.height, MirrorWire.maxLongEdge)
        XCTAssertLessThan(fitted.width, fitted.height)
    }

    func testAPictureThatCannotMeetTheByteCapIsDroppedNotSent() {
        let frame = MirrorFrame(seq: 1, jpeg: Self.jpeg(width: 800, height: 600), width: 800, height: 600, windowSize: CGSize(width: 800, height: 600))
        XCTAssertNil(MirrorFrameFitter.fit(frame, maxLongEdge: 640, maxBytes: 200))
    }

    func testBrokenBytesAreDroppedNotSent() {
        let frame = MirrorFrame(seq: 1, jpeg: Data(repeating: 7, count: 200_000), width: 2000, height: 1000, windowSize: CGSize(width: 2000, height: 1000))
        XCTAssertNil(MirrorFrameFitter.fit(frame))
    }

    // MARK: - The relay

    /// Records what the relay sends, and can hold a write in flight (the phone's link being slow).
    final class Wire: @unchecked Sendable {
        private let state = OSAllocatedUnfairLock(initialState: (sent: [MirrorUpdate](), held: false, parked: [CheckedContinuation<Void, Never>]()))
        var sent: [MirrorUpdate] { state.withLock { $0.sent } }
        func hold() { state.withLock { $0.held = true } }
        func release() {
            let parked = state.withLock { s -> [CheckedContinuation<Void, Never>] in s.held = false; let p = s.parked; s.parked = []; return p }
            parked.forEach { $0.resume() }
        }
        func send(_ update: MirrorUpdate) async {
            let held = state.withLock { s -> Bool in s.sent.append(update); return s.held }
            guard held else { return }
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                let resumeNow = state.withLock { s -> Bool in if !s.held { return true }; s.parked.append(cont); return false }
                if resumeNow { cont.resume() }
            }
        }
    }

    final class Clock: @unchecked Sendable {
        private let t = OSAllocatedUnfairLock(initialState: 0.0)
        var now: TimeInterval { t.withLock { $0 } }
        func set(_ value: TimeInterval) { t.withLock { $0 = value } }
    }

    private func relay(_ wire: Wire, clock: Clock, fit: @escaping @Sendable (MirrorFrame) -> MirrorFrame? = { $0 }) -> RemoteMirrorRelay {
        RemoteMirrorRelay(send: { await wire.send($0) }, fit: fit, now: { clock.now },
                          sleep: { _ in try? await Task.sleep(nanoseconds: 5_000_000) })
    }

    private func frame(_ seq: Int) -> MirrorUpdate {
        .frame(MirrorFrame(seq: seq, jpeg: Data([UInt8(seq & 0xFF)]), width: 10, height: 10, windowSize: CGSize(width: 10, height: 10)))
    }

    private func until(_ timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return condition()
    }

    func testControlsGoFirstAndAClearDropsEverythingThatWaited() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock)
        defer { r.stop() }
        wire.hold()
        r.push(.show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true))
        _ = await until { wire.sent.count == 1 }
        r.push(.cursor(MirrorCursor(kind: "press", point: .zero)))
        r.push(frame(1))
        r.push(.clear)
        wire.release()
        _ = await until { wire.sent.count == 2 }
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(wire.sent, [.show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true), .clear])
    }

    func testOnlyTheNewestPictureWaitsWhileOneIsInFlight() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock)
        defer { r.stop() }
        wire.hold()
        r.push(frame(1))
        _ = await until { wire.sent.count == 1 }
        r.push(frame(2))
        r.push(frame(3))
        r.push(frame(4))
        clock.set(10) // long past any interval
        wire.release()
        _ = await until { wire.sent.count == 2 }
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(wire.sent, [frame(1), frame(4)], "a link that is behind gets the newest picture, never a backlog")
    }

    func testAShowOrResetDropsAPictureOfThePreviousTarget() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock)
        defer { r.stop() }
        wire.hold()
        r.push(.clear)
        _ = await until { wire.sent.count == 1 }
        r.push(frame(1))
        r.push(.reset)
        wire.release()
        _ = await until { wire.sent.count == 2 }
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(wire.sent, [.clear, .reset])
    }

    func testPicturesArePacedFiveASecondWhileTheAgentActsAndOneASecondIdle() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock)
        defer { r.stop() }
        clock.set(100)
        r.push(.cursor(MirrorCursor(kind: "press", point: .zero))) // the agent acts
        r.push(frame(1))
        _ = await until { wire.sent.count == 2 }
        clock.set(100.1)
        r.push(frame(2))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(wire.sent.count, 2, "within 1/5 s of the last picture nothing more goes")
        clock.set(100.21)
        let paced = await until { wire.sent.count == 3 }
        XCTAssertTrue(paced)
        XCTAssertEqual(wire.sent.last, frame(2))

        // Idle (no action for idleAfter): one a second.
        clock.set(110)
        r.push(frame(3))
        _ = await until { wire.sent.count == 4 } // last picture at 100.21, idle interval 1 s: due long ago
        clock.set(110.5)
        r.push(frame(4))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(wire.sent.count, 4, "idle: within a second of the last picture nothing more goes")
        clock.set(111.01)
        let idlePaced = await until { wire.sent.count == 5 }
        XCTAssertTrue(idlePaced)
        XCTAssertEqual(wire.sent.last, frame(4))
    }

    func testAnActionWakesTheFullRateAtOnce() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock)
        defer { r.stop() }
        clock.set(50)
        r.push(frame(1)) // idle: the first picture still goes at once
        _ = await until { wire.sent.count == 1 }
        clock.set(50.3)
        r.push(frame(2))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(wire.sent.count, 1, "idle pacing holds it")
        r.push(.cursor(MirrorCursor(kind: "type", point: .zero)))
        let woke = await until { wire.sent.count == 3 }
        XCTAssertTrue(woke, "an action restores 1/5 s pacing, and 0.3 s have passed: \(wire.sent)")
    }

    func testARunOfMovesKeepsItsLastAndWaitingCursorsAreBounded() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock)
        defer { r.stop() }
        wire.hold()
        r.push(.clear)
        _ = await until { wire.sent.count == 1 }
        for i in 0..<5 { r.push(.cursor(MirrorCursor(kind: "move", point: CGPoint(x: i, y: 0)))) }
        for i in 0..<40 { r.push(.cursor(MirrorCursor(kind: "key", point: .zero, text: "\(i)"))) }
        wire.release()
        _ = await until { wire.sent.count == 1 + RemoteMirrorRelay.maxPendingCursors }
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(wire.sent.count, 1 + RemoteMirrorRelay.maxPendingCursors)
        guard case .cursor(let last)? = wire.sent.last else { return XCTFail() }
        XCTAssertEqual(last.text, "39", "the newest are kept")

        let wire2 = Wire()
        let r2 = relay(wire2, clock: clock)
        defer { r2.stop() }
        wire2.hold()
        r2.push(.clear)
        _ = await until { wire2.sent.count == 1 }
        for i in 0..<5 { r2.push(.cursor(MirrorCursor(kind: "move", point: CGPoint(x: i, y: 0)))) }
        wire2.release()
        _ = await until { wire2.sent.count == 2 }
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(wire2.sent, [.clear, .cursor(MirrorCursor(kind: "move", point: CGPoint(x: 4, y: 0)))])
    }

    func testAPictureTheFitterRefusesIsDroppedAndCounted() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock, fit: { _ in nil })
        defer { r.stop() }
        r.push(frame(1))
        _ = await until { r.droppedFrames == 1 }
        r.push(.clear)
        _ = await until { wire.sent.count == 1 }
        XCTAssertEqual(wire.sent, [.clear], "the refused picture never went out")
        XCTAssertEqual(r.droppedFrames, 1)
    }

    func testTheRelaySendsTheFittedPictureNotTheOriginal() async throws {
        let wire = Wire(), clock = Clock()
        let r = RemoteMirrorRelay(send: { await wire.send($0) }, now: { clock.now }, sleep: { _ in try? await Task.sleep(nanoseconds: 5_000_000) })
        defer { r.stop() }
        let big = Self.jpeg(width: 1440, height: 900)
        r.push(.frame(MirrorFrame(seq: 1, jpeg: big, width: 1440, height: 900, windowSize: CGSize(width: 1440, height: 900))))
        _ = await until(5) { wire.sent.count == 1 }
        guard case .frame(let sent)? = wire.sent.first else { return XCTFail("\(wire.sent)") }
        XCTAssertEqual(sent.width, MirrorWire.maxLongEdge)
        XCTAssertLessThanOrEqual(sent.jpeg.count, MirrorWire.maxJPEGBytes)
    }

    func testAStoppedRelaySendsNothingMore() async {
        let wire = Wire(), clock = Clock()
        let r = relay(wire, clock: clock)
        r.push(.clear)
        _ = await until { wire.sent.count == 1 }
        r.stop()
        r.push(frame(1))
        r.push(.show(app: "X", windowSize: .zero, others: 0, live: true))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(wire.sent, [.clear])
        XCTAssertTrue(r.isStopped)
    }
}
