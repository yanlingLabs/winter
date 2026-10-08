import AppKit
import XCTest
@testable import WinterCUCore

/// The clipboard dance around `paste`, the per-pid queues and `cancel {callId}`.
final class PasteAndQueueTests: XCTestCase {
    /// An in-memory pasteboard. `externalWriteDuringPaste` simulates the user copying while the target reads.
    final class FakePasteboard: CUPasteboardIO {
        var items: [[String: Data]]
        var changeCount = 0
        var failWrites = false
        var log: [String] = []
        init(_ items: [[String: Data]]) { self.items = items }
        func save() -> [[String: Data]] { log.append("save"); return items }
        func write(_ new: [[String: Data]]) -> Int {
            log.append("write")
            if !failWrites { items = new }
            changeCount += 1
            return changeCount
        }
        func readString() -> String? {
            items.first?[NSPasteboard.PasteboardType.string.rawValue].flatMap { String(data: $0, encoding: .utf8) }
        }
    }

    private let userClip: [[String: Data]] = [[NSPasteboard.PasteboardType.string.rawValue: Data("user's own".utf8)]]

    func testPasteRestoresTheUsersClipboard() throws {
        let pb = FakePasteboard(userClip)
        var pasted: String?
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: { pasted = pb.readString() }, sleep: { _ in })
        let r = try seq.run(items: CUPasteSequence.items(text: "hello", format: .text), plain: "hello")
        XCTAssertEqual(r, .restored)
        XCTAssertEqual(pasted, "hello", "the target saw our text")
        XCTAssertEqual(pb.readString(), "user's own", "and the user's clipboard came back")
        XCTAssertEqual(pb.log, ["save", "write", "write"])
    }

    func testAClipboardChangedMeanwhileIsLeftAlone() throws {
        let pb = FakePasteboard(userClip)
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: {}, sleep: { _ in
            pb.items = [[NSPasteboard.PasteboardType.string.rawValue: Data("copied meanwhile".utf8)]]
            pb.changeCount += 1
        })
        XCTAssertEqual(try seq.run(items: CUPasteSequence.items(text: "x", format: .text), plain: "x"), .leftAlone)
        XCTAssertEqual(pb.readString(), "copied meanwhile")
    }

    func testAFailedWriteIsNeverPasted() {
        let pb = FakePasteboard(userClip)
        pb.failWrites = true
        var sent = false
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: { sent = true }, sleep: { _ in })
        XCTAssertThrowsError(try seq.run(items: CUPasteSequence.items(text: "x", format: .text), plain: "x"))
        XCTAssertFalse(sent)
    }

    func testAFailedPasteStillRestores() {
        let pb = FakePasteboard(userClip)
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: { throw CUError.cancelled }, sleep: { _ in })
        XCTAssertThrowsError(try seq.run(items: CUPasteSequence.items(text: "x", format: .text), plain: "x"))
        XCTAssertEqual(pb.readString(), "user's own")
    }

    func testRichFormats() {
        let md = CUPasteSequence.items(text: "**bold** and _it_", format: .markdown)[0]
        XCTAssertNotNil(md[NSPasteboard.PasteboardType.rtf.rawValue], "markdown also travels as RTF")
        XCTAssertEqual(md[NSPasteboard.PasteboardType.string.rawValue], Data("**bold** and _it_".utf8))
        let html = CUPasteSequence.items(text: "<p>a &amp; b</p><p>c</p>", format: .html)[0]
        XCTAssertNotNil(html[NSPasteboard.PasteboardType.html.rawValue])
        XCTAssertEqual(CUPasteSequence.plain(text: "<p>a &amp; b</p><p>c</p>", format: .html), "a & b\nc")
        XCTAssertEqual(CUPasteSequence.plainFromHTML("x<br/>y"), "x\ny")
    }

    // MARK: queues

    func testQueueRunsWorkAndRefusesWhenOverloaded() async throws {
        let queues = CUPidQueues(maxPending: 2)
        let first = try await queues.run(5) { 41 + 1 }
        XCTAssertEqual(first, 42)
        let gate = DispatchSemaphore(value: 0)
        let a = Task { try await queues.run(5) { gate.wait(); return 1 } }
        let b = Task { try await queues.run(5) { 2 } }
        // Wait until both are pending.
        for _ in 0..<200 where queues.pendingCount(5) < 2 { try await Task.sleep(nanoseconds: 5_000_000) }
        do {
            _ = try await queues.run(5) { 3 }
            XCTFail("expected busy")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "busy")
            XCTAssertEqual(e.data?["retryable"], .bool(true))
        }
        gate.signal()
        let (ra, rb) = try await (a.value, b.value)
        XCTAssertEqual(ra + rb, 3)
        XCTAssertEqual(queues.pendingCount(5), 0)
        // Another pid is unaffected by the first's backlog.
        let other = try await queues.run(6) { 7 }
        XCTAssertEqual(other, 7)
    }

    func testQueuePropagatesErrors() async {
        let queues = CUPidQueues()
        do {
            _ = try await queues.run(1) { () throws -> Int in throw CUError.staleRef(3) }
            XCTFail()
        } catch {
            XCTAssertEqual((error as? CUError)?.code, "stale_ref")
        }
    }

    // MARK: cancellation

    func testCancelReachesInFlightWorkAndSticks() {
        let c = CUCancellation()
        let t = c.begin("call-1")
        XCTAssertFalse(t.isCancelled)
        c.cancel("call-1")
        XCTAssertTrue(t.isCancelled)
        XCTAssertThrowsError(try t.check())
        c.end("call-1")
        // A later primitive of the same cancelled run stops at once.
        XCTAssertTrue(c.begin("call-1").isCancelled)
        XCTAssertFalse(c.begin("call-2").isCancelled)
        XCTAssertFalse(c.begin(nil).isCancelled)
    }

    func testCancelArrivingFirstStillStopsTheCall() {
        let c = CUCancellation()
        c.cancel("early")
        XCTAssertTrue(c.begin("early").isCancelled)
    }

    func testConcurrentRequestsOfOneCallShareTheToken() {
        let c = CUCancellation()
        let a = c.begin("x")
        let b = c.begin("x")
        c.end("x")
        c.cancel("x")
        XCTAssertTrue(a.isCancelled && b.isCancelled)
    }
}
