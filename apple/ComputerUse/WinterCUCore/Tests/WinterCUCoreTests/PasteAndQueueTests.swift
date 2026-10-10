import AppKit
import ApplicationServices
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
        var waited = false
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: { pasted = pb.readString() },
                                  waitForEvidence: { waited = true; return true })
        let r = try seq.run(items: CUPasteSequence.items(text: "hello", format: .text), plain: "hello")
        XCTAssertEqual(r, .restored(evidence: true))
        XCTAssertTrue(waited, "the restore waits for evidence of the paste")
        XCTAssertEqual(pasted, "hello", "the target saw our text")
        XCTAssertEqual(pb.readString(), "user's own", "and the user's clipboard came back")
        XCTAssertEqual(pb.log, ["save", "write", "write"])
    }

    func testAClipboardChangedMeanwhileIsLeftAlone() throws {
        let pb = FakePasteboard(userClip)
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: {}, waitForEvidence: {
            pb.items = [[NSPasteboard.PasteboardType.string.rawValue: Data("copied meanwhile".utf8)]]
            pb.changeCount += 1
            return true
        })
        XCTAssertEqual(try seq.run(items: CUPasteSequence.items(text: "x", format: .text), plain: "x"), .leftAlone)
        XCTAssertEqual(pb.readString(), "copied meanwhile")
    }

    func testAFailedWriteIsNeverPasted() {
        let pb = FakePasteboard(userClip)
        pb.failWrites = true
        var sent = false
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: { sent = true }, waitForEvidence: { true })
        XCTAssertThrowsError(try seq.run(items: CUPasteSequence.items(text: "x", format: .text), plain: "x"))
        XCTAssertFalse(sent)
    }

    func testAFailedPasteStillRestores() {
        let pb = FakePasteboard(userClip)
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: { throw CUError.cancelled }, waitForEvidence: { true })
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

    func testUnconfirmedPasteStillRestoresButSaysSo() throws {
        let pb = FakePasteboard(userClip)
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: {}, waitForEvidence: { false })
        XCTAssertEqual(try seq.run(items: CUPasteSequence.items(text: "x", format: .text), plain: "x"), .restored(evidence: false))
        XCTAssertEqual(pb.readString(), "user's own")
    }

    func testWintersClipboardItemsAreMarkedTransientAndConcealed() throws {
        let pb = FakePasteboard(userClip)
        var during: [String: Data]?
        let seq = CUPasteSequence(pasteboard: pb, sendPaste: { during = pb.items.first }, waitForEvidence: { true })
        _ = try seq.run(items: CUPasteSequence.items(text: "x", format: .text), plain: "x")
        XCTAssertNotNil(during?[CUPasteboardMarkers.transient])
        XCTAssertNotNil(during?[CUPasteboardMarkers.concealed])
        XCTAssertNil(pb.items.first?[CUPasteboardMarkers.transient], "the user's restored clipboard is not marked")
    }

    func testPromisedFlavorFlag() {
        XCTAssertTrue(CUSystemPasteboard.isPromised(PasteboardFlavorFlags(rawValue: 1 << 9)))
        XCTAssertTrue(CUSystemPasteboard.isPromised(PasteboardFlavorFlags(rawValue: (1 << 9) | 1)))
        XCTAssertFalse(CUSystemPasteboard.isPromised(PasteboardFlavorFlags(rawValue: 1)))
    }

    func testEditEvidenceIsTheTextNotAChange() {
        var now = 0.0
        var value = "a"
        let ev = CUEditEvidence(readValue: { value }, nowMs: { now }, sleepMs: { ms in
            now += ms
            if now >= 100 { value = "a hello world" }
        })
        XCTAssertTrue(ev.wait(before: "a", expect: "hello world", capMs: 1500), "the pasted text appeared")
        XCTAssertGreaterThanOrEqual(now, 100)
        // No change at all: gives up at the cap.
        now = 0
        let still = CUEditEvidence(readValue: { "a" }, nowMs: { now }, sleepMs: { now += $0 })
        XCTAssertFalse(still.wait(before: "a", expect: "hello", capMs: 150))
        XCTAssertGreaterThanOrEqual(now, 150)
        // A value that changed, but not to the pasted text, is no proof.
        now = 0
        let other = CUEditEvidence(readValue: { "a b" }, nowMs: { now }, sleepMs: { now += $0 })
        XCTAssertFalse(other.wait(before: "a", expect: "hello", capMs: 100))
    }

    func testFillerOnlyBeforeAndAfterIsNeverAProof() {
        var now = 0.0
        var value = "\u{200B}\u{200B}"
        let ev = CUEditEvidence(readValue: { value }, nowMs: { now }, sleepMs: { ms in
            now += ms
            value = now > 50 ? "\u{200B}" : "\u{200B}\u{200B}\u{200B}"  // the filler flickers; the text never shows
        })
        XCTAssertFalse(ev.wait(before: "\u{200B}\u{200B}", expect: "The pasted body", capMs: 200), "unconfirmed, not success")
        XCTAssertEqual(CUEditEvidence.normalized("\u{200B}a \n\u{FEFF} b\u{2060}"), "a b")
        // The same text again: one more occurrence is the proof, not its mere presence.
        let again = CUEditEvidence(readValue: { "note note" }, nowMs: { now }, sleepMs: { now += $0 })
        XCTAssertTrue(again.wait(before: "note", expect: "note", capMs: 100))
        let same = CUEditEvidence(readValue: { "note " }, nowMs: { now }, sleepMs: { now += $0 })
        XCTAssertFalse(same.wait(before: "note", expect: "note", capMs: 100))
    }

    // MARK: queues

    func testQueueRunsWorkAndRefusesWhenOverloaded() async throws {
        let queues = CUPidQueues(maxPending: 2)
        let first = try await queues.run(5) { 41 + 1 }
        XCTAssertEqual(first, 42)
        let gate = DispatchSemaphore(value: 0)
        // Both wait on the gate: the tasks may start in either order, and one that ran straight through would
        // never leave two pending.
        let a = Task { try await queues.run(5) { gate.wait(); return 1 } }
        let b = Task { try await queues.run(5) { gate.wait(); return 2 } }
        // Wait until both are pending (generously: the machine may be busy). Without that the third call
        // would be accepted and queue behind the gate, so give up cleanly instead of deadlocking.
        var waited = 0
        while queues.pendingCount(5) < 2, waited < 2000 {
            try await Task.sleep(nanoseconds: 5_000_000)
            waited += 1
        }
        guard queues.pendingCount(5) == 2 else {
            gate.signal(); gate.signal()
            XCTFail("the two queued calls never became pending")
            return
        }
        do {
            _ = try await queues.run(5) { 3 }
            XCTFail("expected busy")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "busy")
            XCTAssertEqual(e.data?["retryable"], .bool(true))
        }
        gate.signal(); gate.signal()
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
