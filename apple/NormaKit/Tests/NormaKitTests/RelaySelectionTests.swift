import XCTest
import IrohLib
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
}
