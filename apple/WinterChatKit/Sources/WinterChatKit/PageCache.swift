import Foundation

/// Swift port of `packages/core/src/agent/tools/page-core.ts`'s `PageCache` — the in-memory TTL+LRU
/// cache of CLEANED pages behind chat mode's ReadPage and its research sub-agent.
///
/// IN-MEMORY ONLY, and that is a SECURITY posture rather than a performance choice: chat mode's
/// contract is that it leaves nothing behind. A disk cache would put fetched web content somewhere
/// readable outside the conversation that fetched it. Memory-only means the cache vanishes with the
/// process, same as everything else about a chat session.
///
/// An `actor` because the TS relied on JS's single-threaded event loop for every invariant here —
/// the LRU order, the running byte totals, and (especially) the in-flight dedupe map. On Swift those
/// are shared mutable state reachable from concurrent tasks; the actor is what replaces the run-to-
/// completion guarantee the port was written against.

// MARK: - model

/// The two cache-entry origins the reserved-share eviction discriminates between. `user` is a direct
/// ReadPage fetch — pages the user is actively working from. `research` is a fetch the ephemeral
/// research sub-agent made on its own initiative while exploring links: potentially many per run,
/// and NOT something the user necessarily asked to keep.
public enum PageOrigin: String, Sendable, Hashable, Codable {
    case user
    case research
}

/// One extracted link. Named `PageLink` rather than `Link` on purpose: a bare `Link` would collide
/// with `SwiftUI.Link` in any view file that imports both.
public struct PageLink: Sendable, Equatable, Codable {
    public let href: String
    public let text: String

    public init(href: String, text: String) {
        self.href = href
        self.text = text
    }
}

/// A fetched, cleaned page. `lines` is deterministic: the same input bytes always produce an
/// identical array, which is what makes a citation's `lines:N-M` range re-resolve to the same text
/// later — see `PageFetcher`'s determinism contract.
public struct CleanPage: Sendable, Equatable {
    /// The FINAL address after redirects — the cache key, and what a citation should cite.
    public let resolvedURL: String
    public let title: String
    public let lines: [String]
    /// Absolute, deduped, ad/tracker hosts dropped.
    public let links: [PageLink]
    public let fetchedAt: Date
    public var fromCache: Bool

    public init(resolvedURL: String, title: String, lines: [String], links: [PageLink],
                fetchedAt: Date, fromCache: Bool) {
        self.resolvedURL = resolvedURL
        self.title = title
        self.lines = lines
        self.links = links
        self.fetchedAt = fetchedAt
        self.fromCache = fromCache
    }

    /// Rough byte weight — good enough to govern LRU/byte-cap pressure; not an exact wire size and
    /// never security-relevant (the cap is a memory-hygiene knob, not a trust boundary).
    var estimatedBytes: Int {
        var total = resolvedURL.utf8.count + title.utf8.count
        for line in lines { total += line.utf8.count + 1 }
        for link in links { total += link.href.utf8.count + link.text.utf8.count }
        return total
    }
}

// MARK: - cache

public actor PageCache {
    /// ~1h (USER DESIGN, task-1-brief.md).
    public static let defaultTTL: TimeInterval = 60 * 60
    public static let defaultMaxEntries = 50
    /// 60MB. The original 20MB total was ~4–5 research-sized pages, so a single research run could
    /// fill nearly the whole cache and evict a user's own recently-read page well inside the TTL.
    /// Tripled, and combined with the reserved research share below: research keeps roughly its old
    /// effective headroom while the user's own reads get a fresh, separate share research can never
    /// encroach on.
    public static let defaultMaxBytes = 60 * 1024 * 1024
    /// The FRACTION of `maxBytes` research-tagged entries may occupy AT MOST.
    public static let defaultResearchByteShare = 1.0 / 3.0

    private struct Entry {
        var page: CleanPage
        var expiresAt: Date
        var bytes: Int
        var origin: PageOrigin
    }

    private var entries: [String: Entry] = [:]
    /// Insertion order, oldest first — the Swift stand-in for JS `Map`'s ordered iteration, which is
    /// what the TS's LRU refresh and every eviction pass walk.
    private var order: [String] = []
    private var totalBytes = 0
    private var researchBytes = 0

    private let ttl: TimeInterval
    private let maxEntries: Int
    private let maxBytes: Int
    private let researchByteCap: Double

    public init(ttl: TimeInterval = PageCache.defaultTTL,
                maxEntries: Int = PageCache.defaultMaxEntries,
                maxBytes: Int = PageCache.defaultMaxBytes,
                researchByteShare: Double = PageCache.defaultResearchByteShare) {
        self.ttl = ttl
        self.maxEntries = maxEntries
        self.maxBytes = maxBytes
        self.researchByteCap = Double(maxBytes) * researchByteShare
    }

    /// `now` is passed in (never read from a clock here) exactly as in the TS — one call site's
    /// `now` governs its whole get/put pair, and tests drive TTL with a plain `Date`, no sleeping.
    public func get(_ url: String, now: Date) -> CleanPage? {
        guard let entry = entries[url] else { return nil }
        if now >= entry.expiresAt {
            remove(url, entry)
            return nil
        }
        // Refresh recency (LRU): this key becomes the most-recently-used, and so the LAST one any
        // eviction pass would touch. `origin` rides along unchanged — a cache HIT never re-tags an
        // entry; only `put` decides origin.
        touch(url)
        var page = entry.page
        page.fromCache = true
        return page
    }

    /// `origin` defaults to `.user`, matching the TS: every plain ReadPage call site passes no
    /// origin at all, and only the research runner claims `.research` explicitly.
    public func put(_ page: CleanPage, now: Date, origin: PageOrigin = .user) {
        if let existing = entries[page.resolvedURL] {
            remove(page.resolvedURL, existing)
        }
        var stored = page
        stored.fromCache = false
        let bytes = stored.estimatedBytes
        entries[page.resolvedURL] = Entry(page: stored, expiresAt: now.addingTimeInterval(ttl),
                                          bytes: bytes, origin: origin)
        order.append(page.resolvedURL)
        totalBytes += bytes
        if origin == .research { researchBytes += bytes }
        evict()
    }

    // MARK: eviction

    /// Three origin-aware passes. The guarantee they produce, in BOTH the byte and the entry-count
    /// dimension: a `.user` entry is evicted ONLY once every `.research` entry has already been
    /// removed — no number or size of research-tagged entries can push a user's page out.
    ///
    /// (The TS learned that the hard way: pass 2 used to be origin-BLIND, and 1 user entry + 60 tiny
    /// research entries evicted the user's page purely on COUNT pressure with the byte budget
    /// nowhere near full — reachable in a single ReadPage call.)
    private func evict() {
        var dropped = Set<String>()

        // Pass 1 — research's OWN reserved BYTE share. Proactive: runs even when the overall caps
        // are nowhere near hit, so research's footprint never creeps into the user's headroom.
        if Double(researchBytes) > researchByteCap {
            for key in order {
                if Double(researchBytes) <= researchByteCap { break }
                guard let entry = entries[key], entry.origin == .research else { continue }
                drop(key, entry, &dropped)
            }
        }

        // Pass 2 — the ordinary combined cap (entry count + overall bytes), but origin-aware:
        // evict the oldest RESEARCH entry, never a user one, while either cap is still exceeded.
        for key in order {
            if entries.count <= maxEntries, totalBytes <= maxBytes { break }
            guard let entry = entries[key], entry.origin == .research else { continue }
            drop(key, entry, &dropped)
        }

        // Pass 3 — only once every research entry is gone does a user entry become evictable: the
        // ordinary oldest-first trim, in practice only ever reachable by the user's own entries.
        for key in order {
            if entries.count <= maxEntries, totalBytes <= maxBytes { break }
            guard let entry = entries[key] else { continue }
            drop(key, entry, &dropped)
        }

        if !dropped.isEmpty { order.removeAll { dropped.contains($0) } }
    }

    private func drop(_ key: String, _ entry: Entry, _ dropped: inout Set<String>) {
        entries.removeValue(forKey: key)
        totalBytes -= entry.bytes
        if entry.origin == .research { researchBytes -= entry.bytes }
        dropped.insert(key)
    }

    private func remove(_ key: String, _ entry: Entry) {
        entries.removeValue(forKey: key)
        order.removeAll { $0 == key }
        totalBytes -= entry.bytes
        if entry.origin == .research { researchBytes -= entry.bytes }
    }

    private func touch(_ key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }

    // MARK: introspection (tests + callers that want to report cache state)

    public var count: Int { entries.count }
    public var bytes: Int { totalBytes }
    /// Oldest-first, the order every eviction pass walks.
    public var keysOldestFirst: [String] { order }
    public func origin(of url: String) -> PageOrigin? { entries[url]?.origin }

    // MARK: - in-flight dedupe

    /// N identical urls requested CONCURRENTLY (ReadPage's or FetchPage's own batch, up to 8 entries)
    /// would otherwise each miss the cache — none has resolved yet — and fire N separate real
    /// fetches. `dedupe` makes every concurrent caller for the same url past the first ride the SAME
    /// in-flight result. Keyed purely by url and independent of the TTL/LRU bookkeeping above, which
    /// only ever sees the ONE eventual result (via the producer's own `put`).
    private var inFlight: [String: SharedFuture<CleanPage>] = [:]
    /// Every ORIGIN any caller has claimed for a url's CURRENTLY in-flight fetch. The producer reads
    /// this back right before it calls `put`, so the STORED tag reflects every joiner's origin, not
    /// just the initiator's. `.user` wins over `.research` — a stronger claim on protection from
    /// eviction never loses to a weaker one.
    private var inFlightOrigins: [String: Set<PageOrigin>] = [:]

    /// `producer` receives an `effectiveOrigin` callback (rather than a fixed origin) so it can read
    /// the MERGED origin at the moment it actually calls `put` — a joiner that attached after the
    /// producer started still counts.
    ///
    /// `signal` races only a JOINER's own return. The INITIATOR is deliberately excluded from that
    /// race: its signal is already combined into the real fetch's own abort inside `producer`, which
    /// is what produces the nicely classified `timeout` outcome. A second, independent race against
    /// the identical signal could win first and throw a generic abort instead, discarding the more
    /// specific classification. A joiner's abort detaches only that caller — the shared fetch keeps
    /// running untouched for the initiator and every other waiter.
    func dedupe(
        url: String,
        origin: PageOrigin,
        signal: ChatAbortSignal?,
        producer: @Sendable @escaping (_ effectiveOrigin: @Sendable @escaping () async -> PageOrigin) async throws -> CleanPage
    ) async throws -> CleanPage {
        if let existing = inFlight[url] {
            inFlightOrigins[url, default: []].insert(origin)
            return try await existing.get(signal: signal)
        }

        let future = SharedFuture<CleanPage>()
        inFlight[url] = future
        inFlightOrigins[url] = [origin]

        let effectiveOrigin: @Sendable () async -> PageOrigin = { [weak self] in
            await self?.mergedOrigin(url) ?? origin
        }

        do {
            let page = try await producer(effectiveOrigin)
            finish(url, future)
            future.resolve(.success(page))
            return page
        } catch {
            finish(url, future)
            future.resolve(.failure(error))
            throw error
        }
    }

    private func mergedOrigin(_ url: String) -> PageOrigin {
        (inFlightOrigins[url]?.contains(.user) ?? false) ? .user : .research
    }

    /// Clears only OUR OWN entry — a blind delete could race an already-superseding one.
    private func finish(_ url: String, _ future: SharedFuture<CleanPage>) {
        guard inFlight[url] === future else { return }
        inFlight[url] = nil
        inFlightOrigins[url] = nil
    }

    /// Test/introspection hooks. `inFlightWaiters` counts JOINERS only — the initiator awaits its
    /// own producer directly and never registers as a waiter — which is what makes "a second caller
    /// has attached to the shared fetch" a state a test can wait on deterministically instead of
    /// racing it.
    var inFlightCount: Int { inFlight.count }
    func inFlightWaiters(_ url: String) -> Int { inFlight[url]?.waiterCount ?? 0 }
}
