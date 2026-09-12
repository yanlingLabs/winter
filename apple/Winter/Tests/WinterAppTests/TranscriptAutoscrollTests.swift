import XCTest
@testable import Winter

final class TranscriptAutoscrollTests: XCTestCase {
    func testAutoscrollOnlyWhenNearBottomAndGrew() {
        XCTAssertTrue(shouldAutoscroll(nearBottom: true, contentGrew: true))
        XCTAssertFalse(shouldAutoscroll(nearBottom: false, contentGrew: true))
        XCTAssertFalse(shouldAutoscroll(nearBottom: true, contentGrew: false))
    }

    @MainActor
    func testAdapterTranscriptAndStreamingAccessors() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        XCTAssertTrue(adapter.transcript.isEmpty)
        XCTAssertNil(adapter.liveStreamingText)

        // Drive one user message + turn + delta via the session's test seam (mirrors
        // StoppedFlashTests' event-driving idiom).
        session.applyForTesting { s in
            s.turnRunning = true
            s.exchanges = [Exchange(prompt: "hi", reply: "")]
        }
        session.applyForTesting { s in
            s.streamingText = "partial…"
        }

        XCTAssertEqual(adapter.transcript.count, 1)
        XCTAssertEqual(adapter.liveStreamingText, "partial…")

        // Task-4 review fix: discriminate liveStreamingText from visibleResponse — a regression
        // aliasing one to the other (the exact bug the doc comment warns against) must FAIL here.
        // After the turn finalizes, streamingText clears but a stored reply exists:
        // visibleResponse falls through to the reply while liveStreamingText must be nil.
        session.applyForTesting { s in
            s.streamingText = ""
            s.turnRunning = false
            s.exchanges = [Exchange(prompt: "hi", reply: "final answer")]
        }
        XCTAssertNil(adapter.liveStreamingText, "no live stream after finalization")
        XCTAssertEqual(adapter.visibleResponse, "final answer", "visibleResponse falls through to the stored reply — the two accessors must diverge here")
    }
}
