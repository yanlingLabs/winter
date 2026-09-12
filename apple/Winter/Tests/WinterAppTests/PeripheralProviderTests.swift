import XCTest
import WinterProtocol
import WinterKit
@testable import Winter

/// Task 4 (2f): `shouldServe` (the pure decision core) + `PeripheralProvider`'s activeLeases
/// tracking / respond / panic behavior. Deliberately does NOT exercise hotkey registration,
/// screen-lock observation, or TCC polling — those are LIVE-GATE items (`registerPanicSurfaces()`/
/// `startTCCPolling()` are never called here), matching the brief's "Pure helpers unit-tested;
/// UI/registration paths noted for the live gate."
///
/// `SessionEvent`'s nested structs (`LeaseGranted`/`Holder`/etc.) have no PUBLIC memberwise
/// initializer (WinterProtocol relies on `Codable` synthesis only, matching every other test file
/// in this codebase — see `SessionFeedTests`/`AppModelTests`), so test events are built the SAME
/// way production code receives them: JSON-decoded, not struct-literal-constructed.
@MainActor
final class PeripheralProviderTests: XCTestCase {
    private func holder(kind: String = "session", id: String = "s_1") -> SessionEvent.Holder {
        try! JSONDecoder().decode(SessionEvent.Holder.self, from: Data(#"{"kind":"\#(kind)","id":"\#(id)"}"#.utf8))
    }

    private func sessionEvent(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    // Jan 1 2100 UTC in ms — genuinely far in the future (NOT `999_999_999_999`, which is only
    // ~2001: a real bug caught by running these tests, left as a comment so it isn't reintroduced).
    private static let farFutureMs = 4_102_444_800_000

    /// The default token every test's `callRequestedEvent()` uses ("tok_1") hashed — kept as a
    /// single source of truth so `leaseGrantedEvent()`'s default `tokenHash` and
    /// `callRequestedEvent()`'s default `token` stay a matching pair without hardcoding the hex
    /// digest twice. `sha256Hex` is the SAME function `shouldServe` uses in production
    /// (`@testable import Winter`), so this doubles as a light round-trip check of that helper.
    private static let defaultTokenHash = sha256Hex("tok_1")

    private func leaseGrantedEvent(leaseId: String = "lease_1", class cls: String = "noop", expiresAt: Int = PeripheralProviderTests.farFutureMs, tokenHash: String = PeripheralProviderTests.defaultTokenHash) -> SessionEvent {
        sessionEvent(#"{"type":"lease_granted","seq":1,"sessionId":"s_1","ts":0,"threadId":"main","leaseId":"\#(leaseId)","class":"\#(cls)","holder":{"kind":"session","id":"s_1"},"expiresAt":\#(expiresAt),"tokenHash":"\#(tokenHash)"}"#)
    }

    private func leaseLostEvent(leaseId: String = "lease_1", class cls: String = "noop", reason: String = "released") -> SessionEvent {
        sessionEvent(#"{"type":"lease_lost","seq":2,"sessionId":"s_1","ts":1,"threadId":"main","leaseId":"\#(leaseId)","class":"\#(cls)","holder":{"kind":"session","id":"s_1"},"reason":"\#(reason)"}"#)
    }

    private func callRequestedEvent(requestId: String = "req_1", leaseId: String = "lease_1", token: String = "tok_1", class cls: String = "noop", payloadJson: String = #"{"ping":1}"#) -> SessionEvent {
        sessionEvent(#"{"type":"peripheral_call_requested","seq":3,"sessionId":"s_1","ts":2,"threadId":"main","requestId":"\#(requestId)","leaseId":"\#(leaseId)","token":"\#(token)","class":"\#(cls)","payloadJson":\#(JSONEncodedString(payloadJson))}"#)
    }

    /// `payloadJson` is itself a STRING field on the wire (a JSON string containing JSON) —
    /// double-encode it so the outer literal is valid JSON.
    private func JSONEncodedString(_ s: String) -> String {
        let data = try! JSONEncoder().encode(s)
        return String(data: data, encoding: .utf8)!
    }

    private func makeProvider(capabilities: ComputerCapabilities? = nil) -> PeripheralProvider {
        PeripheralProvider(client: WinterClient(makeTransport: { FeedScriptedTransport() }, token: "tok", clientName: "provider-test"), capabilities: capabilities)
    }

    private func connectedProvider(capabilities: ComputerCapabilities? = nil) async throws -> (PeripheralProvider, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "provider-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (PeripheralProvider(client: client, capabilities: capabilities), t)
    }

    // MARK: - Pure decision core: shouldServe

    func testShouldServeServesNoopWhenLeaseValid() {
        // Also exercises the "valid-token serve" path (spec §A1): the call's token hashes to
        // exactly the lease's tokenHash.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .serve)
    }

    func testShouldServeDeniesUnknownLease() {
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_ghost", token: "tok_1", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("lease_not_found"))
    }

    func testShouldServeDeniesTokenMismatchWithAGarbageToken() {
        // Spec §A1 defect fix: a garbage token with a VALID leaseId must be rejected, not served
        // — a right leaseId alone is not enough, per "no token, no service."
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_garbage_totally_wrong", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("token_mismatch"))
    }

    func testShouldServeDeniesEmptyToken() {
        // An empty token must not accidentally satisfy the hash comparison (sha256("") is itself
        // a valid-looking 64-char hex digest — this asserts it still doesn't match a real lease's
        // tokenHash).
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("token_mismatch"))
    }

    func testShouldServeDeniesClassMismatchAgainstTheGrantedLease() {
        // Granted for "noop"; the call claims a different class for the SAME leaseId. Token
        // matches the lease so this exercises class_mismatch specifically, not token_mismatch.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "screenshot", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("class_mismatch"))
    }

    func testShouldServeDeniesExpiredLeaseInclusiveBoundary() {
        // nowMs == expiresAt counts as expired (matches core's expiredLeases inclusive boundary).
        // Token matches so this exercises the expiry check specifically.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "noop", holder: holder(), expiresAt: 500, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "noop", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("expired"))
    }

    func testShouldServeDeniesGenuinelyUnsupportedClass() {
        // Phase 5 CU widened the served set to {noop, screenshot, ax-read, input-drive}. A class
        // outside that set — even with a real, valid, unexpired, correctly-tokened lease — is still
        // denied unsupported_class.
        let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: "bogus", holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
        let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: "bogus", payloadJson: "{}")
        XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .deny("unsupported_class"))
    }

    func testShouldServeNowServesTheThreeRealClasses() {
        // Phase 5 CU: screenshot/ax-read/input-drive are implemented — a valid lease serves.
        for cls in ["screenshot", "ax-read", "input-drive"] {
            let lease = PeripheralLeaseInfo(leaseId: "lease_1", class: cls, holder: holder(), expiresAt: 1000, tokenHash: Self.defaultTokenHash)
            let call = PeripheralCallRequest(requestId: "req_1", leaseId: "lease_1", token: "tok_1", class: cls, payloadJson: "{}")
            XCTAssertEqual(shouldServe(call, leases: [lease], nowMs: 500), .serve, "\(cls) should now serve")
        }
    }

    // MARK: - handle(): activeLeases tracking (no network)

    func testHandleLeaseGrantedAddsToActiveLeases() async {
        let provider = makeProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.map(\.leaseId), ["lease_1"])
        XCTAssertEqual(provider.activeLeases.first?.class, "noop")
    }

    func testHandleLeaseGrantedIsIdempotentOnRedelivery() async {
        // Both broadcastTransient's session fan-out AND the provider-direct push can land the
        // SAME grant when this connection is also attached to the leasing session — must not
        // duplicate the entry (daemon.ts's emitTransient fix, see Task 4's core-side change).
        let provider = makeProvider()
        let granted = leaseGrantedEvent()
        await provider.handle(granted)
        await provider.handle(granted)
        XCTAssertEqual(provider.activeLeases.count, 1)
    }

    func testHandleLeaseLostRemovesFromActiveLeases() async {
        let provider = makeProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.count, 1)
        await provider.handle(leaseLostEvent())
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }

    func testHandleLeaseLostForUnknownLeaseIsANoOp() async {
        let provider = makeProvider()
        await provider.handle(leaseLostEvent(leaseId: "lease_ghost"))
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }

    func testHandleIgnoresUnrelatedSessionEventTypes() async {
        let provider = makeProvider()
        await provider.handle(sessionEvent(#"{"type":"turn_started","seq":1,"sessionId":"s_1","ts":0,"threadId":"main"}"#))
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }

    // MARK: - handle(peripheral_call_requested) → peripheral.respond over the wire

    /// `WinterClient`'s `request()` blocks until a matching `id` response arrives (or a 5s
    /// timeout) — feed one immediately after asserting on the outbound bytes so these tests don't
    /// eat the full timeout, mirroring WinterKitTests' `MethodWrapperTests.roundTrip` pattern.
    private func ackLastSent(_ t: FeedScriptedTransport, index: Int) {
        let req = feedLineJSON(t.sent[index])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)
    }

    func testPeripheralCallRequestedServesNoopWithEcho() async throws {
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())

        async let handled: Void = provider.handle(callRequestedEvent())

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        XCTAssertEqual(respond["method"] as? String, "peripheral.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["requestId"] as? String, "req_1")
        XCTAssertNil(params?["error"])
        let resultJson = params?["resultJson"] as? String
        XCTAssertNotNil(resultJson, "expected a resultJson for a served noop call")
        let echoed = feedLineJSON(resultJson!)
        XCTAssertEqual((echoed["echo"] as? [String: Any])?["ping"] as? Int, 1)

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedDeniesWhenNoMatchingLocalLease() async throws {
        let (provider, t) = try await connectedProvider()
        // No lease_granted ever delivered — the local activeLeases set is empty.
        async let handled: Void = provider.handle(callRequestedEvent())

        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake.
        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        XCTAssertEqual(respond["method"] as? String, "peripheral.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "lease_not_found")
        XCTAssertNil(params?["resultJson"])

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedDeniesTokenMismatchOverTheWire() async throws {
        // End-to-end version of testShouldServeDeniesTokenMismatchWithAGarbageToken: a real
        // lease_granted lands (tokenHash for "tok_1"), then a peripheral_call_requested carries a
        // DIFFERENT token for the same, otherwise-valid leaseId — must be denied, not served.
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())

        async let handled: Void = provider.handle(callRequestedEvent(token: "tok_wrong_guess"))

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "token_mismatch")
        XCTAssertNil(params?["resultJson"])

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedServesScreenshotViaCapability() async throws {
        // Phase 5 CU: a valid screenshot lease + a well-formed payload routes through the capability
        // seam and ships the encoded result over the wire.
        let fake = FakeComputerCapabilities()
        fake.result = .screenshot(CUScreenshot(dataUrl: "data:image/png;base64,ABC", width: 1512, height: 982, scaledWidth: 1280, scaledHeight: 831))
        let (provider, t) = try await connectedProvider(capabilities: fake)
        await provider.handle(leaseGrantedEvent(class: "screenshot"))

        async let handled: Void = provider.handle(callRequestedEvent(class: "screenshot", payloadJson: #"{"op":"screenshot"}"#))

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        let params = respond["params"] as? [String: Any]
        XCTAssertNil(params?["error"])
        let resultJson = params?["resultJson"] as? String
        XCTAssertNotNil(resultJson)
        // Parse the inner resultJson (JSONEncoder escapes `/` in the data-URL — valid JSON the JS
        // core parses back cleanly — so compare the decoded field, not a raw substring).
        let result = feedLineJSON(resultJson!)
        XCTAssertEqual(result["dataUrl"] as? String, "data:image/png;base64,ABC")
        XCTAssertEqual(result["scaledWidth"] as? Int, 1280)
        XCTAssertEqual(fake.performed.count, 1)

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedDeniesGenuinelyUnsupportedClass() async throws {
        // A lease for a class the provider doesn't implement is still denied at call time.
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent(class: "bogus"))

        async let handled: Void = provider.handle(callRequestedEvent(class: "bogus"))

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "unsupported_class")

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedSurfacesCapabilityErrorAsWireError() async throws {
        let fake = FakeComputerCapabilities()
        fake.error = ComputerError(message: "screen recording permission not granted")
        let (provider, t) = try await connectedProvider(capabilities: fake)
        await provider.handle(leaseGrantedEvent(class: "screenshot"))

        async let handled: Void = provider.handle(callRequestedEvent(class: "screenshot", payloadJson: #"{"op":"screenshot"}"#))

        await feedWaitUntil { t.sent.count >= 2 }
        let params = feedLineJSON(t.sent[1])["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "screen recording permission not granted")

        ackLastSent(t, index: 1)
        await handled
    }

    func testPeripheralCallRequestedRejectsMalformedPayloadBeforeCapability() async throws {
        let fake = FakeComputerCapabilities()
        let (provider, t) = try await connectedProvider(capabilities: fake)
        await provider.handle(leaseGrantedEvent(class: "input-drive"))
        // click with no target → parse failure, capability never called.
        async let handled: Void = provider.handle(callRequestedEvent(class: "input-drive", payloadJson: #"{"op":"click"}"#))

        await feedWaitUntil { t.sent.count >= 2 }
        let params = feedLineJSON(t.sent[1])["params"] as? [String: Any]
        XCTAssertEqual(params?["error"] as? String, "click needs a target (element_id or x,y)")
        XCTAssertEqual(fake.performed.count, 0)

        ackLastSent(t, index: 1)
        await handled
    }

    func testLeaseLostForAxReadClearsElementCache() async throws {
        let fake = FakeComputerCapabilities()
        let provider = makeProvider(capabilities: fake)
        await provider.handle(leaseGrantedEvent(class: "ax-read"))
        await provider.handle(leaseLostEvent(class: "ax-read", reason: "expired"))
        XCTAssertEqual(fake.cacheCleared, 1)
    }

    func testPanicClearsElementCache() async throws {
        let fake = FakeComputerCapabilities()
        let provider = makeProvider(capabilities: fake)
        await provider.handle(leaseGrantedEvent(class: "input-drive"))
        provider.panic()
        XCTAssertGreaterThanOrEqual(fake.cacheCleared, 1)
    }

    // MARK: - panic()

    func testPanicClearsActiveLeasesSynchronouslyAndRevokesAllOverTheWire() async throws {
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.count, 1)

        provider.panic()
        XCTAssertTrue(provider.activeLeases.isEmpty, "panic() must clear the local set synchronously, not wait on the network round trip")

        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake; the
        // leaseGranted-tracking handle() above never touches the wire either. panic()'s revoke
        // RPC runs on its own unstructured Task (not awaited by panic() itself) — ack it so it
        // doesn't linger past this test on a 5s timeout.
        await feedWaitUntil { t.sent.count >= 2 }
        let revoke = feedLineJSON(t.sent[1])
        XCTAssertEqual(revoke["method"] as? String, "peripheral.revoke")
        let params = revoke["params"] as? [String: Any]
        XCTAssertEqual(params?["all"] as? Bool, true)
        XCTAssertEqual(params?["reason"] as? String, "panic")
        ackLastSent(t, index: 1)
    }

    // MARK: - currentClasses() / advertiseIfConnected()

    func testCurrentClassesAlwaysIncludesAllFourWithNoopGranted() {
        let classes = PeripheralProvider.currentClasses()
        XCTAssertEqual(Set(classes.map(\.class)), Set(["noop", "screenshot", "ax-read", "input-drive"]))
        XCTAssertEqual(classes.first(where: { $0.class == "noop" })?.tccGranted, true)
    }

    func testAdvertiseIfConnectedSendsAllFourClasses() async throws {
        let (provider, t) = try await connectedProvider()
        async let handled: Void = provider.advertiseIfConnected()
        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake.
        await feedWaitUntil { t.sent.count >= 2 }
        let advertise = feedLineJSON(t.sent[1])
        XCTAssertEqual(advertise["method"] as? String, "peripheral.advertise")
        let classes = (advertise["params"] as? [String: Any])?["classes"] as? [[String: Any]]
        XCTAssertEqual(classes?.count, 4)
        ackLastSent(t, index: 1)
        await handled
    }

    /// FINAL-REVIEW FIX (M1): `advertiseIfConnected()` is the exact closure `AppDelegate` wires to
    /// `AppModel.onClientConnected` — fired on the app's initial connect AND (since this fix) on
    /// every subsequent reconnect. On a daemon restart/socket drop, core's `PeripheralBroker` state
    /// dies with it; without clearing here first, the app would keep ghost `activeLeases` from the
    /// dead connection. `activeLeases.isEmpty` is exactly the signal both panic surfaces key off —
    /// `AppDelegate`'s `peripheral.$activeLeases` subscription mounts/unmounts the red menu item on
    /// it, and `updatePanicRegistration()` (called synchronously here) does the same for the Carbon
    /// hotkey — so asserting it's empty IS asserting both panic surfaces are unmounted.
    func testAdvertiseIfConnectedClearsGhostLeasesBeforeReadvertising() async throws {
        let (provider, t) = try await connectedProvider()
        await provider.handle(leaseGrantedEvent())
        XCTAssertEqual(provider.activeLeases.count, 1)

        // Simulates the reconnect callback: AppModel.onClientConnected fires this SAME method
        // again after a reconnect (see AppModel.handle's `.connection(.connected)` case).
        async let handled: Void = provider.advertiseIfConnected()

        // t.sent[0] is already "protocol.hello" from connectedProvider()'s own handshake.
        await feedWaitUntil { t.sent.count >= 2 }
        // Cleared BEFORE the advertise round-trip resolves — the clear is synchronous, at the top
        // of advertiseIfConnected(), strictly ahead of the (async) network call.
        XCTAssertTrue(provider.activeLeases.isEmpty, "reconnect must clear ghost leases from a dead broker's state, not just leave them until the next lease_lost")

        let advertise = feedLineJSON(t.sent[1])
        XCTAssertEqual(advertise["method"] as? String, "peripheral.advertise")
        ackLastSent(t, index: 1)
        await handled

        // Still empty after the round-trip completes — the fresh advertise doesn't resurrect them.
        XCTAssertTrue(provider.activeLeases.isEmpty)
    }
}

/// A scriptable ComputerCapabilities for the dispatch tests — the seam that keeps PeripheralProvider
/// unit-testable without TCC (no real capture/AX/CGEvent).
@MainActor
final class FakeComputerCapabilities: ComputerCapabilities {
    var result: CUResult = .detail("ok")
    var error: ComputerError?
    var performed: [ComputerOp] = []
    var cacheCleared = 0
    func perform(_ op: ComputerOp) async throws -> CUResult {
        performed.append(op)
        if let error { throw error }
        return result
    }
    func clearElementCache() { cacheCleared += 1 }
}

/// Pure-core tests (Phase 5 CU) — no TCC, no provider: payload parsing, formatting, downscale math,
/// chord parsing, result encoding.
final class ComputerCapabilitiesPureTests: XCTestCase {
    func testParsePayloadValidatesOpAgainstClass() {
        XCTAssertEqual(try? parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"screenshot"}"#).get(), .screenshot(maxDim: nil))
        XCTAssertEqual(try? parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"screenshot","maxDim":1024}"#).get(), .screenshot(maxDim: 1024))
        XCTAssertEqual(try? parseComputerPayload(cls: "ax-read", payloadJson: #"{"op":"ax_snapshot"}"#).get(), .axSnapshot)
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"elementId":3},"button":"left","clicks":1}"#).get(),
                       .click(target: .element(3), button: "left", clicks: 1, modifiers: []))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"x":10,"y":20},"button":"right","clicks":2}"#).get(),
                       .click(target: .point(x: 10, y: 20), button: "right", clicks: 2, modifiers: []))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"type","text":"hi"}"#).get(), .type(text: "hi"))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"key","keys":"cmd+s"}"#).get(), .key(keys: "cmd+s"))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"scroll","dy":-120}"#).get(), .scroll(target: nil, dx: 0, dy: -120))
    }

    func testParseClickModifiersTripleAndMiddle() {
        // modifier-click: tokens fold into CGEventFlags; unknown tokens are a typed error.
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"elementId":2},"modifiers":["shift","cmd"]}"#).get(),
                       .click(target: .element(2), button: "left", clicks: 1, modifiers: [.maskShift, .maskCommand]))
        if case .success = parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"elementId":2},"modifiers":["hyper"]}"#) {
            XCTFail("unknown modifier should fail")
        }
        // triple-click accepted; clicks clamp to 1...3 defensively.
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"elementId":1},"clicks":3}"#).get(),
                       .click(target: .element(1), button: "left", clicks: 3, modifiers: []))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"elementId":1},"clicks":9}"#).get(),
                       .click(target: .element(1), button: "left", clicks: 3, modifiers: []))
        // middle button accepted; unknown buttons rejected.
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"x":1,"y":2},"button":"middle"}"#).get(),
                       .click(target: .point(x: 1, y: 2), button: "middle", clicks: 1, modifiers: []))
        if case .success = parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"x":1,"y":2},"button":"back"}"#) {
            XCTFail("unknown button should fail")
        }
    }

    func testParseDrag() {
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"drag","from":{"elementId":3},"to":{"x":500,"y":300}}"#).get(),
                       .drag(from: .element(3), to: .point(x: 500, y: 300), modifiers: []))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"drag","from":{"x":1,"y":2},"to":{"elementId":9},"modifiers":["shift"]}"#).get(),
                       .drag(from: .point(x: 1, y: 2), to: .element(9), modifiers: [.maskShift]))
        if case .success = parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"drag","from":{"elementId":3}}"#) {
            XCTFail("drag without `to` should fail")
        }
        if case .success = parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"drag","from":{"elementId":3},"to":{"elementId":4}}"#) {
            XCTFail("drag on the screenshot class should fail")
        }
    }

    func testParseZoom() {
        XCTAssertEqual(try? parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"zoom","x":850,"y":400,"width":400,"height":300,"maxDim":1280}"#).get(),
                       .zoom(x: 850, y: 400, width: 400, height: 300, maxDim: 1280))
        if case .success = parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"zoom","x":850,"y":400,"width":400}"#) {
            XCTFail("zoom without a full region should fail")
        }
        if case .success = parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"zoom","x":0,"y":0,"width":-5,"height":10}"#) {
            XCTFail("negative region should fail")
        }
        if case .success = parseComputerPayload(cls: "ax-read", payloadJson: #"{"op":"zoom","x":0,"y":0,"width":10,"height":10}"#) {
            XCTFail("zoom on the ax-read class should fail")
        }
    }

    func testEncodeZoomResultCarriesRegionOrigin() {
        let s = encodeCUResult(.screenshot(CUScreenshot(dataUrl: "data:z", width: 400, height: 300, scaledWidth: 400, scaledHeight: 300, originX: 850, originY: 400)))!
        XCTAssertTrue(s.contains("\"originX\":850"))
        XCTAssertTrue(s.contains("\"originY\":400"))
        // full-screen capture: no origin fields at all
        let full = encodeCUResult(.screenshot(CUScreenshot(dataUrl: "data:f", width: 100, height: 50, scaledWidth: 100, scaledHeight: 50)))!
        XCTAssertFalse(full.contains("originX"))
    }

    func testModifierFlagsHelper() {
        XCTAssertEqual(cuModifierFlags(from: ["shift", "cmd"]), [.maskShift, .maskCommand])
        XCTAssertEqual(cuModifierFlags(from: nil), [])
        XCTAssertEqual(cuModifierFlags(from: []), [])
        XCTAssertNil(cuModifierFlags(from: ["nope"]))
    }

    func testScrollDeltasAreClampedNotTrapped() {
        // Int(_: Double) is a trapping conversion — a model-controlled absurd delta must clamp,
        // never fatalError the app.
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"scroll","dy":1e40}"#).get(),
                       .scroll(target: nil, dx: 0, dy: 100_000))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"scroll","dx":-1e40,"dy":50}"#).get(),
                       .scroll(target: nil, dx: -100_000, dy: 50))
    }

    func testCuSafeIntNeverTraps() {
        // Every coordinate/delta Int() conversion (scroll deltas, click/move/drag detail strings,
        // zoom error message) routes through this — it must survive the model's worst input without
        // a fatalError. Bare `Int(1e40)`/`Int(.infinity)`/`Int(.nan)` all TRAP; cuSafeInt clamps.
        XCTAssertEqual(cuSafeInt(1e40), 100_000)
        XCTAssertEqual(cuSafeInt(-1e40), -100_000)
        XCTAssertEqual(cuSafeInt(.infinity), 100_000)
        XCTAssertEqual(cuSafeInt(-.infinity), -100_000)
        XCTAssertEqual(cuSafeInt(.nan), 0)
        XCTAssertEqual(cuSafeInt(42.9), 42) // ordinary values pass through (truncated)
        XCTAssertEqual(cuSafeInt(-7.2), -7)
    }

    func testAbsurdCoordinatesParseWithoutTrapping() {
        // The gate's crash vector: model-controlled .point coordinates flow into Int() display/error
        // sites (drag/click/move detail strings, zoom out-of-bounds error). Parsing an absurd
        // coordinate must NOT trap, and the enum must carry the raw finite Double through (the live
        // detail/error strings then use cuSafeInt, verified above).
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"drag","from":{"x":1,"y":2},"to":{"x":1e40,"y":1e40}}"#).get(),
                       .drag(from: .point(x: 1, y: 2), to: .point(x: 1e40, y: 1e40), modifiers: []))
        XCTAssertEqual(try? parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click","target":{"x":1e40,"y":-1e40}}"#).get(),
                       .click(target: .point(x: 1e40, y: -1e40), button: "left", clicks: 1, modifiers: []))
        XCTAssertEqual(try? parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"zoom","x":1e40,"y":1e40,"width":10,"height":10}"#).get(),
                       .zoom(x: 1e40, y: 1e40, width: 10, height: 10, maxDim: nil))
    }

    func testParsePayloadRejectsMismatchAndMissingFields() {
        // op valid for a DIFFERENT class
        if case .success = parseComputerPayload(cls: "screenshot", payloadJson: #"{"op":"click"}"#) { XCTFail("class/op mismatch should fail") }
        // click without a target
        if case .success = parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"click"}"#) { XCTFail("missing target should fail") }
        // type without text
        if case .success = parseComputerPayload(cls: "input-drive", payloadJson: #"{"op":"type"}"#) { XCTFail("missing text should fail") }
        // malformed json
        if case .success = parseComputerPayload(cls: "screenshot", payloadJson: "not json") { XCTFail("malformed json should fail") }
    }

    func testDownscaleCapsLongestSideAndNeverUpscales() {
        XCTAssertEqual(cuDownscaledSize(width: 3024, height: 1964, maxDim: 1280).width, 1280)
        let (w, h) = cuDownscaledSize(width: 2000, height: 1000, maxDim: 1000)
        XCTAssertEqual(w, 1000); XCTAssertEqual(h, 500)
        // already within cap → unchanged (no upscale)
        XCTAssertEqual(cuDownscaledSize(width: 800, height: 600, maxDim: 1280).width, 800)
    }

    func testFormatAXElements() {
        let els = [
            CUAXElement(id: 0, role: "AXWindow", label: "Doc", value: nil, x: 0, y: 0, width: 1000, height: 800),
            CUAXElement(id: 1, role: "AXButton", label: "Save", value: nil, x: 820, y: 610, width: 40, height: 20),
            CUAXElement(id: 2, role: "AXTextField", label: "Name", value: "Jane", x: 100, y: 200, width: 200, height: 24),
        ]
        let text = formatAXElements(els)
        XCTAssertTrue(text.contains("#1 AXButton \"Save\" @ (840,620)"))
        XCTAssertTrue(text.contains("#2 AXTextField \"Name\" = \"Jane\" @ (200,212)"))
        XCTAssertEqual(formatAXElements([]), "(no accessible elements found in the frontmost window)")
    }

    func testParseChord() {
        XCTAssertEqual(parseChord("cmd+s"), CUChord(flags: .maskCommand, keyCode: 1))
        XCTAssertEqual(parseChord("return"), CUChord(flags: [], keyCode: 36))
        XCTAssertEqual(parseChord("cmd+shift+4"), CUChord(flags: [.maskCommand, .maskShift], keyCode: 21))
        XCTAssertNil(parseChord("cmd+notakey"))
        XCTAssertNil(parseChord("cmd")) // modifier only, no key
    }

    func testEncodeCUResult() {
        let s = encodeCUResult(.screenshot(CUScreenshot(dataUrl: "data:x", width: 100, height: 50, scaledWidth: 100, scaledHeight: 50)))!
        XCTAssertTrue(s.contains("\"dataUrl\":\"data:x\""))
        XCTAssertTrue(encodeCUResult(.text("hello"))!.contains("\"text\":\"hello\""))
        XCTAssertTrue(encodeCUResult(.detail("clicked"))!.contains("\"detail\":\"clicked\""))
    }
}
