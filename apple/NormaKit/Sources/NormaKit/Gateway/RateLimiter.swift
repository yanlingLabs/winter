import Foundation

/// A pure token-bucket rate limiter for the gateway's inbound `rpcRequest` flow (SP2a gate G4a).
///
/// The clock is INJECTED per `allow(now:)` call — the limiter itself does no timekeeping, holds no
/// timers, and touches no global state, so its refill/drain behavior is deterministically testable
/// with a frozen or hand-advanced `now`. One instance is kept per paired phone (`PhoneSession`),
/// consulted before the gateway forwards a phone's request to the daemon: a phone that floods
/// faster than `ratePerSec` (after burning `burst` credit) gets its excess frames rejected with a
/// gateway error rather than relayed, bounding the load a single misbehaving/hostile phone can put
/// on the least-privileged `remote` daemon connection.
///
/// `@unchecked Sendable`: every read/mutation happens only from within `Gateway`-actor-isolated
/// code (each instance lives inside a `PhoneSession`, itself actor-confined), so access is already
/// serialized by the actor even though the compiler can't prove it for this reference type — the
/// same rationale `PhoneSession` documents.
public final class RateLimiter: @unchecked Sendable {
    private let ratePerSec: Double
    private let burst: Double
    private var tokens: Double
    /// `nil` until the first `allow` — the first call establishes the clock origin (no phantom
    /// refill from an undefined "previous" time) and always succeeds against the full `burst`.
    private var last: TimeInterval?

    public init(ratePerSec: Int, burst: Int) {
        self.ratePerSec = Double(ratePerSec)
        self.burst = Double(burst)
        self.tokens = Double(burst)
    }

    /// Refill by the elapsed time since the previous call (capped at `burst`), then spend one
    /// token if available. Returns `true` when the request is admitted, `false` when the bucket is
    /// dry. Monotonic `now` is assumed (a non-decreasing wall clock); a backwards jump simply
    /// contributes no refill (elapsed clamps at 0 via the `max`).
    public func allow(now: TimeInterval) -> Bool {
        if let last {
            let elapsed = max(0, now - last)
            tokens = min(burst, tokens + elapsed * ratePerSec)
        }
        last = now
        if tokens >= 1 {
            tokens -= 1
            return true
        }
        return false
    }
}
