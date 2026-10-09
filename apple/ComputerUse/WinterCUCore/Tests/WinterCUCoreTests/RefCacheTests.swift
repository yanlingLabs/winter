import ApplicationServices
import XCTest
@testable import WinterCUCore

/// Ref identity (spine §4): monotonic, never reused, stable for the same element while it exists.
final class RefCacheTests: XCTestCase {
    /// A fake element whose identity is its `token`, like CFEqual on two AXUIElement objects that name the
    /// same UI element — distinct instances, equal identity.
    final class FakeElement: Hashable {
        let token: Int
        init(_ token: Int) { self.token = token }
        static func == (a: FakeElement, b: FakeElement) -> Bool { a.token == b.token }
        func hash(into h: inout Hasher) { h.combine(token) }
    }

    func testSameElementKeepsItsRefAcrossObservations() {
        let cache = CURefCache<FakeElement>()
        cache.beginGeneration()
        let a = cache.ref(for: FakeElement(7))
        let b = cache.ref(for: FakeElement(8))
        cache.beginGeneration()
        // New instances, same identity.
        XCTAssertEqual(cache.ref(for: FakeElement(8)), b)
        XCTAssertEqual(cache.ref(for: FakeElement(7)), a)
        XCTAssertEqual([a, b], [1, 2])
    }

    func testRefsAreMonotonicAndNeverReused() {
        let cache = CURefCache<FakeElement>()
        cache.beginGeneration()
        let first = cache.ref(for: FakeElement(1))
        cache.forget(first)
        XCTAssertNil(cache.key(for: first))
        // The same element comes back: it gets a NEW number, never the forgotten one.
        let again = cache.ref(for: FakeElement(1))
        XCTAssertGreaterThan(again, first)
        XCTAssertEqual(cache.ref(for: FakeElement(2)), again + 1)
        XCTAssertEqual(cache.highestRef, again + 1)
    }

    func testUnseenElementsArePrunedAfterTheRetentionWindow() {
        let cache = CURefCache<FakeElement>(retainGenerations: 2)
        cache.beginGeneration()
        let gone = cache.ref(for: FakeElement(1))
        let stays = cache.ref(for: FakeElement(2))
        for _ in 0..<3 {
            cache.beginGeneration()
            cache.ref(for: FakeElement(2))
            cache.prune()
        }
        XCTAssertNil(cache.key(for: gone), "unseen for longer than the window → stale")
        XCTAssertNotNil(cache.key(for: stays))
        XCTAssertEqual(cache.existingRef(for: FakeElement(2)), stays)
        XCTAssertNil(cache.existingRef(for: FakeElement(1)))
    }

    func testExistingRefDoesNotAssign() {
        let cache = CURefCache<FakeElement>()
        XCTAssertNil(cache.existingRef(for: FakeElement(3)))
        XCTAssertEqual(cache.count, 0)
    }

    /// The real key: two separately created AXUIElements for the same application are CFEqual and hash
    /// alike. (Creating an element is a local token — no IPC, no permission, no UI.)
    func testAXIdentityUsesCFEqual() {
        let a = AXIdentity(element: AXUIElementCreateApplication(getpid()))
        let b = AXIdentity(element: AXUIElementCreateApplication(getpid()))
        let other = AXIdentity(element: AXUIElementCreateApplication(1))
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.hashValue, b.hashValue)
        XCTAssertNotEqual(a, other)
        let cache = CURefCache<AXIdentity>()
        cache.beginGeneration()
        XCTAssertEqual(cache.ref(for: a), cache.ref(for: b))
        XCTAssertNotEqual(cache.ref(for: a), cache.ref(for: other))
    }
}
