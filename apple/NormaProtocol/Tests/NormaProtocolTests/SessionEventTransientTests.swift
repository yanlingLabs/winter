import XCTest
@testable import NormaProtocol

/// The cross-language TRANSIENT-list tripwire (iOS remote-path T2).
///
/// The seven broadcast-only transient types had been hand-copied into four places — `NormaClient`
/// (Mac, as a case list), `NormaSessionClient` (phone, as a string set), that client's test mirror,
/// and now the daemon's remote live-stream filter — because `SessionEvent.Discriminator` is
/// `private`. The cost of a divergent copy is invisible: a transient missing from a client's list is
/// dropped 100% of the time by seq dedupe, and a transient missing from the daemon's live-stream
/// allowlist never leaves the Mac at all. That is exactly how iOS shipped with no streaming while
/// every suite stayed green.
///
/// `SessionEvent.transientTypes` is now the single Swift definition (mirroring
/// `TRANSIENT_EVENT_TYPES` in `packages/protocol/src/events.ts`), and this file is what stops it
/// drifting — from the TypeScript side, and from its own case-level twin `isTransient`.
final class SessionEventTransientTests: XCTestCase {

    /// The canonical eight, as literals. Deliberately NOT read from `transientTypes` — this is the
    /// remote-allowlist parity pattern: each side pins its own copy to the same literal list, so
    /// editing one side alone fails a test instead of silently diverging. The TypeScript half is
    /// `packages/core/test/ipc/remote-live-stream.test.ts`, which pins the identical eight strings.
    ///
    /// Growth log: 7 → 8 (session-activity-hygiene T4, `session_activity`).
    private static let eight: Set<String> = [
        "assistant_delta",
        "lease_granted",
        "lease_lost",
        "peripheral_call_requested",
        "plugin_tool_invoke",
        "hardware_requested",
        "plugin_tile_updated",
        "session_activity",
    ]

    func testTransientTypesIsExactlyTheEight() {
        XCTAssertEqual(SessionEvent.transientTypes, Self.eight,
                       "SessionEvent.transientTypes must stay in lockstep with TRANSIENT_EVENT_TYPES in packages/protocol/src/events.ts")
        XCTAssertEqual(SessionEvent.transientTypes.count, 8)
    }

    /// `isTransient` (the case switch, used by `NormaClient` on decoded events) and
    /// `transientTypes` (the string set, used by `NormaSessionClient` on opaque wire payloads) must
    /// classify EVERY event variant identically — otherwise the Mac and the phone disagree about
    /// which events are exempt from dedupe. Driven off the TS-generated fixtures, so the check
    /// covers every variant the protocol actually emits rather than a hand-picked sample, and a new
    /// variant's fixture is swept in automatically.
    func testIsTransientAgreesWithTransientTypesForEveryFixture() throws {
        let urls = Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "Fixtures") ?? []
        XCTAssertFalse(urls.isEmpty, "no fixtures found — regenerate via pnpm protocol:generate")

        var seenTypes: Set<String> = []
        for url in urls {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(SessionEvent.self, from: data)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String else {
                return XCTFail("fixture \(url.lastPathComponent) has no type discriminator")
            }
            seenTypes.insert(type)
            XCTAssertEqual(SessionEvent.transientTypes.contains(type), decoded.isTransient,
                           "\(type): the string set and the case switch disagree (\(url.lastPathComponent))")
        }

        // A typo in `transientTypes` would pass the check above vacuously (a string no fixture ever
        // carries is never tested). Every one of the seven must correspond to a real, emitted type.
        for t in SessionEvent.transientTypes {
            XCTAssertTrue(seenTypes.contains(t), "\(t) is in transientTypes but matches no protocol fixture — typo, or a removed event type")
        }
    }

    /// Spot-check the two ends of the classification on decoded values, independent of fixtures:
    /// the streaming type that the whole iOS remote path depends on, and a persisted type that must
    /// NEVER be treated as transient (misclassifying it would stop the cursor advancing at all).
    func testStreamingIsTransientAndPersistedIsNot() {
        let delta = SessionEvent.assistantDelta(.init(seq: 5, sessionId: "s1", ts: 0, threadId: "main", delta: "chunk"))
        XCTAssertTrue(delta.isTransient)
        XCTAssertTrue(SessionEvent.transientTypes.contains("assistant_delta"))

        let message = SessionEvent.assistantMessage(.init(seq: 6, sessionId: "s1", ts: 0, threadId: "main", text: "done"))
        XCTAssertFalse(message.isTransient)
        XCTAssertFalse(SessionEvent.transientTypes.contains("assistant_message"))

        let attached = SessionEvent.harnessAttached(.init(seq: 2, sessionId: "s1", ts: 0, clientName: "cli"))
        XCTAssertFalse(attached.isTransient, "harness_attached is PERSISTED bookkeeping — it consumes a real seq slot")

        // session-activity-hygiene T4: the lifecycle signal is transient for the same reason the
        // delta is — it borrows the store's lastSeq and is never appended, so a client that deduped
        // it on seq would drop every state flip, permanently and silently.
        let activity = SessionEvent.sessionActivity(.init(seq: 2, sessionId: "s1", ts: 0, activity: "background"))
        XCTAssertTrue(activity.isTransient)
        XCTAssertTrue(SessionEvent.transientTypes.contains("session_activity"))
    }
}
