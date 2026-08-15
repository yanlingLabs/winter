import AppKit
import XCTest
@testable import Norma

// MARK: - Doubles

/// Stands in for the process-global bridge slot: keeps the handler the hub installed, counts the
/// install/clear pairs, and records every answer that went back to a page.
///
/// **Queries are delivered through the STORED HANDLER**, never by reaching into the hub — which is
/// what makes these tests exercise the real path (`NormaCEFSetBridgeHandler`'s block is the only way
/// a query ever arrives) rather than a private method that happens to be shaped like it.
@MainActor
final class EditorSlotRecorder {
    private(set) var handler: (@MainActor @Sendable (Int32, UInt64, String) -> Void)?
    private(set) var installCount = 0
    private(set) var clearCount = 0
    private(set) var answers: [(queryId: UInt64, success: Bool, json: String)] = []

    var slot: EditorBridgeHub.Slot {
        EditorBridgeHub.Slot(
            install: { [unowned self] handler in
                self.installCount += 1
                self.handler = handler
            },
            clear: { [unowned self] in
                self.clearCount += 1
                self.handler = nil
            },
            respond: { [unowned self] queryId, success, json in
                self.answers.append((queryId, success, json))
            })
    }

    /// Deliver one query exactly as CEF's router would.
    func deliver(browserId: Int32, queryId: UInt64, request: String) {
        handler?(browserId, queryId, request)
    }

    var answerCount: Int { answers.count }
}

// MARK: - The hub

/// editor-product Task 3 — **the slot's sole owner, and the demux behind it.**
///
/// What these cannot cover is the same thing `BrowserRuntimeTests` names: `Slot.production` itself,
/// three one-line forwards to a C surface no test may cross. The live harness executes those (drill
/// 11 in particular, which now runs THROUGH this object).
@MainActor
final class EditorBridgeHubTests: XCTestCase {

    private func readyFrame() -> String { #"{"type":"ready"}"# }
    private func saveFrame(_ path: String) -> String {
        #"{"type":"saveRequested","path":"\#(path)"}"#
    }

    // MARK: The demux

    func testEachRegisteredBrowserOnlyEverSeesItsOwnMessages() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var first: [EditorBridgeInbound] = []
        var second: [EditorBridgeInbound] = []
        hub.register(browserId: 11) { message, respond in first.append(message); respond(true, "{}") }
        hub.register(browserId: 22) { message, respond in second.append(message); respond(true, "{}") }

        recorder.deliver(browserId: 11, queryId: 1, request: readyFrame())
        recorder.deliver(browserId: 22, queryId: 2, request: saveFrame("/tmp/b.txt"))
        recorder.deliver(browserId: 11, queryId: 3, request: saveFrame("/tmp/a.txt"))

        XCTAssertEqual(first, [.ready, .saveRequested(path: "/tmp/a.txt")])
        XCTAssertEqual(second, [.saveRequested(path: "/tmp/b.txt")])
        XCTAssertEqual(recorder.answers.map(\.success), [true, true, true])
    }

    func testAQueryFromAnUnregisteredBrowserIsRefusedAndNeverReachesAnyClient() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var seen: [EditorBridgeInbound] = []
        hub.register(browserId: 11) { message, respond in seen.append(message); respond(true, "{}") }

        recorder.deliver(browserId: 99, queryId: 7, request: readyFrame())

        XCTAssertTrue(seen.isEmpty, "a foreign browser's query must never reach a client")
        XCTAssertEqual(recorder.answers.count, 1, "refused, never IGNORED — an ignored query strands "
                       + "a CEF callback for the life of the browser")
        XCTAssertEqual(recorder.answers[0].queryId, 7)
        XCTAssertFalse(recorder.answers[0].success)
        XCTAssertTrue(recorder.answers[0].json.contains("message"),
                      "the failure body is a {\"message\": …} object, matching the CDP door's shape")
    }

    /// Drill 11's exact shape: the foreign page sends a WELL-FORMED editor message. If the hub
    /// discriminated by shape rather than by browser this would sail through.
    func testAWellFormedEditorMessageFromAForeignBrowserIsStillRefused() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var seen: [EditorBridgeInbound] = []
        hub.register(browserId: 11) { message, respond in seen.append(message); respond(true, "{}") }

        recorder.deliver(browserId: 12, queryId: 5,
                         request: saveFrame("/tmp/not-the-editors-file"))

        XCTAssertTrue(seen.isEmpty)
        XCTAssertEqual(recorder.answers.count, 1)
        XCTAssertFalse(recorder.answers[0].success)
    }

    func testAnUndecodableFrameFromARegisteredBrowserIsRefusedRatherThanGuessedAt() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var seen: [EditorBridgeInbound] = []
        hub.register(browserId: 11) { message, respond in seen.append(message); respond(true, "{}") }

        recorder.deliver(browserId: 11, queryId: 9, request: "{not json")
        recorder.deliver(browserId: 11, queryId: 10, request: #"{"type":"whoKnows"}"#)
        recorder.deliver(browserId: 11, queryId: 11, request: #"{"type":"saveRequested"}"#)

        XCTAssertTrue(seen.isEmpty)
        XCTAssertEqual(recorder.answers.count, 3)
        XCTAssertEqual(recorder.answers.map(\.success), [false, false, false])
    }

    func testARefusalIsReportedToTheObserverWithItsBrowserReasonAndACappedRequest() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var refusals: [EditorBridgeHub.Refusal] = []
        hub.onRefusal = { refusals.append($0) }
        hub.register(browserId: 11) { _, respond in respond(true, "{}") }

        let huge = String(repeating: "x", count: EditorBridgeHub.refusalRequestPrefix * 3)
        recorder.deliver(browserId: 77, queryId: 1, request: huge)
        recorder.deliver(browserId: 11, queryId: 2, request: "{not json")

        XCTAssertEqual(refusals.map(\.browserId), [77, 11])
        XCTAssertEqual(refusals.map(\.reason), [.unknownBrowser, .undecodableFrame])
        XCTAssertEqual(refusals[0].request.count, EditorBridgeHub.refusalRequestPrefix,
                       "a refused frame is untrusted input that ends up in transcripts — capped")
    }

    // MARK: Slot ownership

    func testTheSlotIsTakenOnTheFirstRegisterAndGivenBackOnlyOnTheLastUnregister() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        XCTAssertEqual(recorder.installCount, 0, "a hub nobody registered with holds no slot")

        hub.register(browserId: 11) { _, respond in respond(true, "{}") }
        hub.register(browserId: 22) { _, respond in respond(true, "{}") }
        XCTAssertEqual(recorder.installCount, 1, "ONE registration for the whole process")
        XCTAssertTrue(hub.isInstalled)

        hub.unregister(browserId: 11)
        XCTAssertEqual(recorder.clearCount, 0, "a client remains — the slot must stay held")
        XCTAssertTrue(hub.isInstalled)

        hub.unregister(browserId: 22)
        XCTAssertEqual(recorder.clearCount, 1)
        XCTAssertFalse(hub.isInstalled)
        XCTAssertEqual(hub.registeredBrowserIds, [])

        hub.register(browserId: 33) { _, respond in respond(true, "{}") }
        XCTAssertEqual(recorder.installCount, 2, "and it is taken again for the next registrant")
    }

    func testBrowserIdZeroNeverRegistersAndNeverTakesTheSlot() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var seen: [EditorBridgeInbound] = []

        hub.register(browserId: 0) { message, respond in seen.append(message); respond(true, "{}") }

        XCTAssertEqual(hub.registeredBrowserIds, [], "0 is the \"no browser\" sentinel")
        XCTAssertEqual(recorder.installCount, 0)
        // And the sentinel does not become a wildcard: a query that arrives with 0 (a container with
        // no browser at all) is refused like any other unknown.
        hub.register(browserId: 11) { _, respond in respond(true, "{}") }
        recorder.deliver(browserId: 0, queryId: 1, request: readyFrame())
        XCTAssertTrue(seen.isEmpty)
        XCTAssertEqual(recorder.answers.map(\.success), [false])
    }

    func testRegisteringTheSameBrowserTwiceReplacesTheClient() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var old = 0
        var new = 0
        hub.register(browserId: 11) { _, respond in old += 1; respond(true, "{}") }
        hub.register(browserId: 11) { _, respond in new += 1; respond(true, "{}") }

        recorder.deliver(browserId: 11, queryId: 1, request: readyFrame())

        XCTAssertEqual(old, 0, "the replaced client must never hear another message")
        XCTAssertEqual(new, 1)
        XCTAssertEqual(recorder.installCount, 1, "a replacement is not a second slot")
    }

    func testUnregisteringABrowserNobodyRegisteredLeavesTheSlotAlone() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        hub.register(browserId: 11) { _, respond in respond(true, "{}") }

        hub.unregister(browserId: 999)
        hub.unregister(browserId: 999)

        XCTAssertEqual(recorder.clearCount, 0)
        XCTAssertEqual(hub.registeredBrowserIds, [11])
    }

    // MARK: Exactly once

    func testADeliveredQueryIsAnsweredExactlyOnceEvenWhenTheClientAnswersNothing() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        hub.register(browserId: 11) { _, _ in /* answers nothing, deliberately */ }

        recorder.deliver(browserId: 11, queryId: 4, request: readyFrame())

        XCTAssertEqual(recorder.answers.count, 1, "the page's promise must settle either way")
        XCTAssertEqual(recorder.answers[0].queryId, 4)
        XCTAssertTrue(recorder.answers[0].success)
    }

    func testAClientThatAnswersTwiceSettlesTheQueryOnce() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        hub.register(browserId: 11) { _, respond in
            respond(true, #"{"first":true}"#)
            respond(false, #"{"message":"second"}"#)
        }

        recorder.deliver(browserId: 11, queryId: 6, request: readyFrame())

        XCTAssertEqual(recorder.answers.count, 1)
        XCTAssertTrue(recorder.answers[0].success)
        XCTAssertEqual(recorder.answers[0].json, #"{"first":true}"#)
    }

    /// A client may legitimately answer LATER (an asynchronous decision). The latch must survive
    /// that too — the hub's own fallback has already answered by then.
    func testALateAnswerFromAClientIsANoOp() {
        let recorder = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: recorder.slot)
        var captured: EditorBridgeHub.Respond?
        hub.register(browserId: 11) { _, respond in captured = respond }

        recorder.deliver(browserId: 11, queryId: 8, request: readyFrame())
        XCTAssertEqual(recorder.answers.count, 1)
        captured?(false, #"{"message":"too late"}"#)
        XCTAssertEqual(recorder.answers.count, 1)
    }
}
