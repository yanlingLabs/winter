import Foundation

/// `WebFetch`'s "self-cleaning cache" (the tool description's own phrase) — the Swift port of the
/// agent SDK's `packages/runtime/src/tools/impl/_web-fetch-cache.ts`.
///
/// 15-minute TTL, 50 MiB weighted by the CONVERTED CONTENT's own byte length, LRU, keyed on the
/// ORIGINAL input URL string (before the http→https upgrade and before any redirect walk).
///
/// **THE PAGE IS CACHED, NEVER THE ANSWER.** A hit re-runs the digest pass over the stored content,
/// because the same page and a different `prompt` are a different question. Storing the answer would
/// make a second prompt about a cached page silently return the first prompt's answer.
///
/// Redirects and non-2xx responses are never cached; only the caller knows that distinction, so this
/// type never sees them — it has no "outcome" concept at all, only "here is a successful fetch's
/// converted content, remember it".
///
/// SCOPE. The SDK partitions by `ctx.sessionId` inside one process-wide instance; on the phone a chat
/// session already owns its objects, so this is an `actor` the CALLER holds one of per session —
/// exactly the shape `PageCache` already has. A session that goes away drops its cache with it, so
/// there is no `forgetSession` to call and nothing to leak.
///
/// An `actor` rather than a lock for the same reason `PageCache` is one: the SDK relied on JS's
/// run-to-completion for the LRU order and the running byte total, and both are shared mutable state
/// reachable from concurrent tasks here.
public actor WebFetchCache {
    public static let defaultTTL: TimeInterval = 15 * 60
    public static let defaultMaxBytes = 50 * 1024 * 1024

    /// One remembered fetch.
    public struct Entry: Sendable, Equatable {
        /// The CONVERTED content (markdown, or raw text) — never the digest model's answer.
        public let content: String
        public let contentType: String
        /// The URL actually fetched (after the https upgrade and any auto-followed same-host
        /// redirect) — may differ from the cache key, which is why the executor re-checks the floor
        /// and the address policy against it on a hit.
        public let finalURL: String
        public let status: Int
        public let statusText: String

        public init(content: String, contentType: String, finalURL: String, status: Int, statusText: String) {
            self.content = content
            self.contentType = contentType
            self.finalURL = finalURL
            self.status = status
            self.statusText = statusText
        }

        /// The cache's weight unit: the converted content's own UTF-8 byte length.
        var bytes: Int { content.utf8.count }
    }

    private struct Stored {
        let entry: Entry
        let storedAt: Date
    }

    private var entries: [String: Stored] = [:]
    /// Insertion order, oldest first — the Swift stand-in for JS `Map`'s ordered iteration, which the
    /// LRU touch and every eviction pass walk.
    private var order: [String] = []
    private var weight = 0

    private let ttl: TimeInterval
    private let maxBytes: Int

    public init(ttl: TimeInterval = WebFetchCache.defaultTTL, maxBytes: Int = WebFetchCache.defaultMaxBytes) {
        self.ttl = ttl
        self.maxBytes = maxBytes
    }

    /// SELF-CLEANING, earned literally: every `get`/`set` first sweeps this cache's own expired
    /// entries. `now` is passed in (never read from a clock here), exactly as in the TS — so one call
    /// site's `now` governs its whole get/set pair and a test drives the TTL with a plain `Date`.
    public func get(_ url: String, now: Date) -> Entry? {
        sweep(now)
        guard let stored = entries[url] else { return nil }
        touch(url) // LRU recency
        return stored.entry
    }

    public func set(_ url: String, _ entry: Entry, now: Date) {
        sweep(now)
        if let existing = entries.removeValue(forKey: url) {
            weight -= existing.entry.bytes
            order.removeAll { $0 == url }
        }
        // A single entry heavier than the whole budget is never cached — there is no eviction order
        // that could make room for it, and admitting it would evict everything else for a "hit" that
        // itself blows the budget on the very next entry.
        let bytes = entry.bytes
        if bytes > maxBytes { return }
        while weight + bytes > maxBytes, let oldest = order.first {
            remove(oldest)
        }
        entries[url] = Stored(entry: entry, storedAt: now)
        order.append(url)
        weight += bytes
    }

    public var count: Int { entries.count }
    public var bytes: Int { weight }

    private func sweep(_ now: Date) {
        for key in order where now.timeIntervalSince(entries[key]?.storedAt ?? now) >= ttl {
            remove(key)
        }
    }

    private func remove(_ key: String) {
        if let stored = entries.removeValue(forKey: key) { weight -= stored.entry.bytes }
        order.removeAll { $0 == key }
    }

    private func touch(_ key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }
}
