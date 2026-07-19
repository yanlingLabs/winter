import XCTest
import IrohLib
@testable import NormaKit
@testable import NormaSessionKit

/// SP3.2: `RelaySelection` maps onto iroh's `RelayMode` and resolves the new explicit `relays`
/// override against the legacy `relayURLs` seam. Fully HERMETIC — constructing a `RelayMode` and
/// reading its `description` (the binding's `Display` impl) is pure, local, no-network work: no
/// endpoint is ever bound and no relay is ever dialed. This is the CI-safe proof that `.n0Default`
/// selects n0's production relay map (`RelayMode.defaultMode()`); the actual live cross-network
/// dial through those relays is a live-gate concern (`IrohRelayE2ETests`), never a normal test.
final class RelaySelectionTests: XCTestCase {

    func testDisabledMapsToDisabledRelayMode() throws {
        XCTAssertEqual(
            try RelaySelection.disabled.relayMode().description,
            RelayMode.disabled().description
        )
    }

    func testN0DefaultMapsToDefaultRelayMode() throws {
        XCTAssertEqual(
            try RelaySelection.n0Default.relayMode().description,
            RelayMode.defaultMode().description,
            ".n0Default must select n0's production relay fleet"
        )
        // Guard against a silent mis-map to disabled — the exact regression that would leave the
        // Mac unreachable across networks despite opting into `.n0Default`.
        XCTAssertNotEqual(
            try RelaySelection.n0Default.relayMode().description,
            RelayMode.disabled().description
        )
    }

    func testCustomMapsToCustomFromUrls() throws {
        let url = "https://relay-1.yanlinglabs.com./"
        XCTAssertEqual(
            try RelaySelection.custom([url]).relayMode().description,
            try RelayMode.customFromUrls(urls: [url]).description
        )
    }

    func testFromLegacyURLs() throws {
        // Empty → disabled; non-empty → custom. This is the exact behavior every pre-SP3.2 call
        // site had, so a caller passing only `relayURLs` keeps its old relay mode verbatim.
        XCTAssertEqual(
            try RelaySelection.fromLegacyURLs([]).relayMode().description,
            RelayMode.disabled().description
        )
        let url = "https://relay-1.yanlinglabs.com./"
        XCTAssertEqual(
            try RelaySelection.fromLegacyURLs([url]).relayMode().description,
            try RelayMode.customFromUrls(urls: [url]).description
        )
    }

    func testResolvePrecedence() throws {
        let url = "https://relay-1.yanlinglabs.com./"
        // Explicit `relays` wins over the legacy seam, even an empty one.
        XCTAssertEqual(
            try RelaySelection.resolve(relays: .n0Default, legacyURLs: []).description,
            RelayMode.defaultMode().description
        )
        // `nil` falls back to legacy: empty → disabled (keeps hermetic loopback tests hermetic).
        XCTAssertEqual(
            try RelaySelection.resolve(relays: nil, legacyURLs: []).description,
            RelayMode.disabled().description
        )
        // `nil` falls back to legacy: non-empty → custom (keeps the live-gate relay test working).
        XCTAssertEqual(
            try RelaySelection.resolve(relays: nil, legacyURLs: [url]).description,
            try RelayMode.customFromUrls(urls: [url]).description
        )
        // Explicit `.disabled` is DISTINCT from `nil` (unspecified): it wins over a non-empty legacy
        // seam, proving the sentinel isn't overloaded.
        XCTAssertEqual(
            try RelaySelection.resolve(relays: .disabled, legacyURLs: [url]).description,
            RelayMode.disabled().description
        )
    }

    // MARK: - SP3.2b: online()-gating (`isEnabled`)

    func testIsEnabled() {
        // `.disabled` MUST be not-enabled: it's the flag every bind site gates `online()` on, and
        // with no relay to home to, online() would hang — the hermetic loopback suite depends on
        // this being false.
        XCTAssertFalse(RelaySelection.disabled.isEnabled)
        XCTAssertTrue(RelaySelection.n0Default.isEnabled)
        XCTAssertTrue(RelaySelection.custom(["https://relay-1.yanlinglabs.com./"]).isEnabled)
        // `.custom([])` has no relay to home to either (normally unreachable — `fromLegacyURLs`
        // maps empty to `.disabled` — but must not hang if constructed directly).
        XCTAssertFalse(RelaySelection.custom([]).isEnabled)
        // The legacy fallbacks every existing hermetic call site resolves through:
        XCTAssertFalse(RelaySelection.effective(relays: nil, legacyURLs: []).isEnabled)
        XCTAssertTrue(RelaySelection.effective(relays: nil, legacyURLs: ["https://relay-1.yanlinglabs.com./"]).isEnabled)
        XCTAssertFalse(RelaySelection.effective(relays: .disabled, legacyURLs: ["https://relay-1.yanlinglabs.com./"]).isEnabled)
    }

    /// SP3.2b regression guard: a relay-disabled loopback listener must start (near-)instantly —
    /// i.e. `IrohListener.start` must NOT `await endpoint.online()` when relays are `.disabled`.
    /// If the gating ever regressed, online() would block on a home relay that doesn't exist until
    /// its 15s bound expired, and this deadline would trip. Hermetic: loopback bind, no relay, no
    /// network. (The real n0 online() can't be unit-tested in CI — that's the live gate.)
    func testDisabledListenerStartsWithoutOnline() async throws {
        let started = Date()
        let listener = try await IrohListener.start(
            secret: SecretKey.generate().toBytes(),
            relays: .disabled,
            bindAddr: "127.0.0.1:0"
        )
        defer { listener.stop() }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(
            elapsed, 5.0,
            "relay-disabled loopback start took \(elapsed)s — online() must be skipped for .disabled (its bound alone is 15s)"
        )
    }
}
