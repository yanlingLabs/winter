import XCTest
import os
import NormaProtocol
@testable import NormaKit

/// SP2b Task 5, Step 2: `PairingSheetModel` is pure (no AppKit) precisely so it's fully testable
/// here — the app's own `PairingSheetView`/`RemoteAccessCoordinator` get NO unit tests (SP2b T5
/// global constraint). Every seam (`beginPairing`/`confirm`/`deny`/`now`/`sleepTick`) is injected;
/// no test in this file depends on real wall-clock time.
final class PairingSheetModelTests: XCTestCase {

    // MARK: - Small Sendable test doubles

    private final class Box<T>: @unchecked Sendable {
        private let lock: OSAllocatedUnfairLock<T>
        init(_ value: T) { lock = OSAllocatedUnfairLock(initialState: value) }
        var value: T {
            get { lock.withLock { $0 } }
            set { lock.withLock { $0 = newValue } }
        }
    }

    /// A `sleepTick` a test fully controls: `wait()` genuinely suspends (no busy-spin) until the
    /// test calls `tick()` — `AsyncStream`'s default unbounded buffering makes this order-safe
    /// even if `tick()` is called before the countdown loop has reached its own `wait()`.
    private actor ManualTickSource {
        private let stream: AsyncStream<Void>
        private let continuation: AsyncStream<Void>.Continuation
        private var iterator: AsyncStream<Void>.AsyncIterator?

        init() {
            var cont: AsyncStream<Void>.Continuation!
            stream = AsyncStream { cont = $0 }
            continuation = cont
        }

        func tick() { continuation.yield(()) }

        func wait() async {
            // `next()` is a mutating async method — it can't be called directly on the
            // actor-isolated stored property (that would need exclusive access held across the
            // `await`). Pull it into a local var, await on that, then store the advanced
            // iterator back.
            var current = iterator ?? stream.makeAsyncIterator()
            _ = await current.next()
            iterator = current
        }
    }

    private struct Harness {
        let model: PairingSheetModel
        let eventsContinuation: AsyncStream<PairingUIEvent>.Continuation
        let clock: Box<Int>
        let beginCount: Box<Int>
        let confirmedLabels: Box<[String]>
        let denyCount: Box<Int>
        let ticker: ManualTickSource
    }

    private func makeQR(tag: UInt8, expiresAt: Int) -> QRPayload {
        QRPayload(
            v: 1, pairID: Data(repeating: tag, count: 16), pairSecret: Data(repeating: tag, count: 32),
            expiresAt: expiresAt, macEndpointID: "mac-test",
            relayConfig: SignedRelayConfig(config: RelayConfig(version: 1, relays: []), sig: Data()),
            alpn: "test/alpn/1", hostLabel: "Test Mac"
        )
    }

    @MainActor
    private func makeHarness(offerTTL: Int = 300) -> Harness {
        var eventsContinuation: AsyncStream<PairingUIEvent>.Continuation!
        let events = AsyncStream<PairingUIEvent> { eventsContinuation = $0 }
        let clock = Box<Int>(1_000)
        let beginCount = Box<Int>(0)
        let confirmedLabels = Box<[String]>([])
        let denyCount = Box<Int>(0)
        let ticker = ManualTickSource()

        let model = PairingSheetModel(
            events: events,
            beginPairing: { [self] in
                beginCount.value += 1
                return self.makeQR(tag: UInt8(beginCount.value), expiresAt: clock.value + offerTTL)
            },
            confirm: { label in confirmedLabels.value.append(label) },
            deny: { denyCount.value += 1 },
            now: { clock.value },
            sleepTick: { await ticker.wait() }
        )
        return Harness(
            model: model, eventsContinuation: eventsContinuation, clock: clock,
            beginCount: beginCount, confirmedLabels: confirmedLabels, denyCount: denyCount, ticker: ticker
        )
    }

    /// Bounded, condition-based wait for cross-task assertions (the model's event/countdown loops
    /// run as separate `Task`s) — never a fixed real-time sleep; gives up loudly via the caller's
    /// own assertion once `timeout` elapses instead of hanging the suite on a regression.
    private func waitUntil(timeout: TimeInterval = 2, _ predicate: @escaping () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate(), Date() < deadline {
            await Task.yield()
        }
    }

    /// A bounded, fixed-count yield — used ONLY to prove a NEGATIVE ("this must NOT have
    /// happened"), where no condition exists to poll for. `apply(_:)` is fully synchronous (no
    /// `await` inside its switch), so the one real hop (the event loop's `next()` picking up a
    /// freshly-yielded element) settles within a couple of scheduler turns.
    private func drain(_ times: Int = 20) async {
        for _ in 0..<times { await Task.yield() }
    }

    // MARK: - Tests

    @MainActor
    func testBegin_ShowsQRWithPayload() async {
        let h = makeHarness()
        await h.model.begin()
        guard case .showingQR(let payload, let secondsLeft) = h.model.state else {
            return XCTFail("expected showingQR, got \(h.model.state)")
        }
        XCTAssertFalse(payload.isEmpty)
        XCTAssertEqual(secondsLeft, 300)
        XCTAssertEqual(h.beginCount.value, 1)
    }

    @MainActor
    func testCountdownHitsZero_AutoRegenerates() async {
        let h = makeHarness(offerTTL: 5)
        await h.model.begin()
        guard case .showingQR(let firstPayload, _) = h.model.state else {
            return XCTFail("expected showingQR")
        }

        // Advance the injected clock past expiry, then let ONE countdown tick observe it.
        h.clock.value += 5
        await h.ticker.tick()

        await waitUntil { h.beginCount.value == 2 }
        guard case .showingQR(let secondPayload, let secondsLeft) = h.model.state else {
            return XCTFail("expected showingQR after auto-regenerate, got \(h.model.state)")
        }
        XCTAssertNotEqual(firstPayload, secondPayload, "auto-regenerate must mint a genuinely fresh payload")
        XCTAssertEqual(secondsLeft, 5, "the fresh offer's own countdown must restart from its own TTL")
    }

    @MainActor
    func testRequestReceived_TransitionsToConfirming() async {
        let h = makeHarness()
        await h.model.begin()

        h.eventsContinuation.yield(.requestReceived(words: ["alpha", "bravo", "charlie", "delta"], requestedLabel: ""))
        await waitUntil {
            if case .confirming = h.model.state { return true }
            return false
        }
        guard case .confirming(let words, let label) = h.model.state else {
            return XCTFail("expected confirming, got \(h.model.state)")
        }
        XCTAssertEqual(words, ["alpha", "bravo", "charlie", "delta"])
        XCTAssertEqual(label, "", "v1: the phone sends no label of its own")
    }

    @MainActor
    func testConfirmTapped_CompletedEvent_TransitionsToDone() async {
        let h = makeHarness()
        await h.model.begin()
        h.eventsContinuation.yield(.requestReceived(words: ["a", "b", "c", "d"], requestedLabel: ""))
        await waitUntil {
            if case .confirming = h.model.state { return true }
            return false
        }

        await h.model.confirmTapped(label: "Test iPhone")
        XCTAssertEqual(h.confirmedLabels.value, ["Test iPhone"], "confirmTapped must call through to the injected confirm ceremony")

        let record = PairRecord(
            phoneEndpointID: "phone-1", label: "Test iPhone", createdAt: 1_000,
            caps: ["sessions"], pairingEpoch: 1, lastSeenAt: 1_000
        )
        h.eventsContinuation.yield(.completed(record: record))
        await waitUntil { h.model.state == .done(record) }
        XCTAssertEqual(h.model.state, .done(record))
    }

    @MainActor
    func testDenyTapped_TransitionsToFailedWithOpenFreshQRMessage() async {
        let h = makeHarness()
        await h.model.begin()
        h.eventsContinuation.yield(.requestReceived(words: ["a", "b", "c", "d"], requestedLabel: ""))
        await waitUntil {
            if case .confirming = h.model.state { return true }
            return false
        }

        await h.model.denyTapped()
        XCTAssertEqual(h.denyCount.value, 1, "denyTapped must call through to the injected deny ceremony")

        // The QR is consumed once denied — NOT back to showingQR; the sheet shows a dead end with
        // an explicit "New QR" (regenerate()) escape hatch, per the brief.
        h.eventsContinuation.yield(.failed(reason: "denied"))
        await waitUntil { h.model.state == .failed("denied — open a fresh QR") }
        XCTAssertEqual(h.model.state, .failed("denied — open a fresh QR"))
    }

    @MainActor
    func testGenericFailedReason_TransitionsToFailed() async {
        let h = makeHarness()
        await h.model.begin()
        h.eventsContinuation.yield(.requestReceived(words: ["a", "b", "c", "d"], requestedLabel: ""))
        await waitUntil {
            if case .confirming = h.model.state { return true }
            return false
        }

        h.eventsContinuation.yield(.failed(reason: "timeout"))
        await waitUntil { h.model.state == .failed("timeout — open a fresh QR") }
        XCTAssertEqual(h.model.state, .failed("timeout — open a fresh QR"))
    }

    /// The reducer rule the T3 whole-branch review flagged: `PairingUIEvent.failed` carries NO
    /// ceremony discriminator. A stale "expired" (the code `PairingManager.beginPairing()` gives
    /// an orphaned prior pending — see that method's own doc comment) arriving AFTER a NEWER
    /// `.requestReceived` has already promoted the sheet into `.confirming` must NOT kill that
    /// newer, still-live prompt.
    @MainActor
    func testStaleExpiredAfterNewerRequestReceived_StateStaysConfirming() async {
        let h = makeHarness()
        await h.model.begin()

        let words = ["echo", "foxtrot", "golf", "hotel"]
        h.eventsContinuation.yield(.requestReceived(words: words, requestedLabel: ""))
        await waitUntil {
            if case .confirming = h.model.state { return true }
            return false
        }

        h.eventsContinuation.yield(.failed(reason: "expired"))
        await drain()

        XCTAssertEqual(
            h.model.state, .confirming(words: words, label: ""),
            "a stale 'expired' arriving while already confirming a NEWER request must be ignored, not kill the live prompt"
        )
    }

    /// T5 review (Important): closing the sheet in `.showingQR` — the MOST common path (open,
    /// look, close) — must genuinely stop the background tasks. Without `stop()` the countdown
    /// keeps ticking and auto-`beginPairing()`-ing against a manager the coordinator may already
    /// be tearing down: the tasks retain the model for the duration of their in-flight
    /// `consumeEvents()`/`runCountdown()` calls, so `[weak self]` on the closures alone never
    /// ends them.
    @MainActor
    func testStop_CancelsTasksAndCountdownNeverRegeneratesAgain() async {
        let h = makeHarness(offerTTL: 5)
        await h.model.begin()
        guard case .showingQR = h.model.state else {
            return XCTFail("expected showingQR")
        }
        XCTAssertEqual(h.beginCount.value, 1)

        h.model.stop()
        XCTAssertTrue(h.model.isStoppedForTesting, "stop() must cancel+drop both tasks and latch stopped")

        // Advance the injected clock PAST expiry and deliver a tick — a live countdown would
        // auto-regenerate here (exactly what testCountdownHitsZero_AutoRegenerates proves); a
        // stopped one must not.
        h.clock.value += 5
        await h.ticker.tick()
        await drain()

        XCTAssertEqual(h.beginCount.value, 1, "no further beginPairing calls may ever happen after stop()")
    }

    /// T5 review (minor): the `.failed` screen's "New QR" button — a manual `regenerate()` from
    /// `.failed` must mint a genuinely fresh offer and land back in `.showingQR`.
    @MainActor
    func testRegenerateFromFailed_ReturnsToShowingQRWithFreshPayload() async {
        let h = makeHarness()
        await h.model.begin()
        guard case .showingQR(let firstPayload, _) = h.model.state else {
            return XCTFail("expected showingQR")
        }
        h.eventsContinuation.yield(.requestReceived(words: ["a", "b", "c", "d"], requestedLabel: ""))
        await waitUntil {
            if case .confirming = h.model.state { return true }
            return false
        }
        h.eventsContinuation.yield(.failed(reason: "denied"))
        await waitUntil { h.model.state == .failed("denied — open a fresh QR") }

        await h.model.regenerate()

        guard case .showingQR(let freshPayload, let secondsLeft) = h.model.state else {
            return XCTFail("expected showingQR after regenerate, got \(h.model.state)")
        }
        XCTAssertNotEqual(freshPayload, firstPayload, "the New QR button must mint a genuinely fresh payload")
        XCTAssertEqual(secondsLeft, 300, "the fresh offer's countdown must restart from its own TTL")
        XCTAssertEqual(h.beginCount.value, 2)
    }
}
