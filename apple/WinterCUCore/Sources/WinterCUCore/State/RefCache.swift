import Foundation

/// Assigns the model's `[n]` refs. One cache per target:
/// - refs are integers, monotonic, never reused;
/// - the same element keeps its ref across snapshots for as long as it exists. Identity is the key's
///   `Hashable` conformance — for AX, `AXIdentity` (CFEqual/CFHash on the `AXUIElement`);
/// - an element unseen for `retainGenerations` observations is forgotten, so its ref then reads stale.
///
/// Not thread-safe: a target's cache is only touched on that target's pid queue.
public final class CURefCache<Key: Hashable> {
    private var byKey: [Key: Int] = [:]
    private var byRef: [Int: Key] = [:]
    private var lastSeen: [Int: Int] = [:]
    private var nextRef: Int
    private(set) public var generation = 0
    public let retainGenerations: Int

    public init(firstRef: Int = 1, retainGenerations: Int = 8) {
        self.nextRef = firstRef
        self.retainGenerations = max(1, retainGenerations)
    }

    /// Starts an observation; refs assigned or touched until the next call belong to it.
    public func beginGeneration() {
        generation += 1
    }

    /// The ref for `key`: its existing one, or the next new one.
    @discardableResult
    public func ref(for key: Key) -> Int {
        if let r = byKey[key] {
            lastSeen[r] = generation
            return r
        }
        let r = nextRef
        nextRef += 1
        byKey[key] = r
        byRef[r] = key
        lastSeen[r] = generation
        return r
    }

    /// The ref `key` already has, without assigning one.
    public func existingRef(for key: Key) -> Int? { byKey[key] }

    public func key(for ref: Int) -> Key? { byRef[ref] }

    /// Forgets elements not seen in the last `retainGenerations` observations.
    public func prune() {
        let floor = generation - retainGenerations
        for (r, seen) in lastSeen where seen <= floor {
            if let k = byRef[r] { byKey[k] = nil }
            byRef[r] = nil
            lastSeen[r] = nil
        }
    }

    /// Forgets one ref (its element is known to be gone). The number is never handed out again.
    public func forget(_ ref: Int) {
        if let k = byRef[ref] { byKey[k] = nil }
        byRef[ref] = nil
        lastSeen[ref] = nil
    }

    public var count: Int { byRef.count }
    public var highestRef: Int { nextRef - 1 }
}
