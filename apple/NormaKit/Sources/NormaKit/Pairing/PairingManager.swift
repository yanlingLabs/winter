import Foundation
import CryptoKit
import Security
import NormaProtocol

/// What the Mac's pairing UI (the menu-bar app's QR sheet) reacts to. `PairingManager` is the
/// sole producer; the app never touches ceremony state directly.
public enum PairingUIEvent: Sendable, Equatable {
    /// A phone presented a valid proof for the current offer — show the 4-word SAS and a
    /// Confirm/Deny prompt. `requestedLabel` is always `""` in v1 (the phone sends no label yet;
    /// the human types one at `confirm(label:)`) — the field is kept for SP3, which may let the
    /// phone suggest one.
    case requestReceived(words: [String], requestedLabel: String)
    case completed(record: PairRecord)
    /// `reason` is one of `"expired"`, `"denied"`, `"timeout"`, `"bad_proof"`, `"rate_limited"`,
    /// or `"cap_reached"` (the store is already at its 10-device cap when `confirm` tries to
    /// persist — not one of the brief's enumerated reasons, but a real failure `confirm` can hit;
    /// documented here rather than silently swallowed).
    case failed(reason: String)
}

/// The phone<->Mac pairing ceremony engine: owns the QR offer's lifetime, verifies a phone's
/// proof-of-possession, surfaces the SAS words for human confirmation, and — on confirm —
/// persists the new `PairRecord` and answers the phone. One instance per Mac; the app constructs
/// it once at daemon-gateway startup.
///
/// **State machine.** At most one `offer` (the current QR's secret + bookkeeping) and at most one
/// `pending` (a proof-verified request awaiting the human's confirm/deny) exist at a time. Both
/// live ONLY in memory — nothing about an in-flight ceremony ever touches disk until
/// `confirm(label:)` calls `store.add`.
///
/// **Atomicity.** Every mutation to `offer`/`pending` inside `handleConnection` happens in a
/// straight-line synchronous section with NO `await` in between (the checks-then-mutate is one
/// actor turn) — only after the state is already updated does the method `await` the outbound
/// `conn.send`/`close`. This is what makes "offer exists · unused · proof ok · consume" atomic
/// against a second connection racing in in what would otherwise be the gap while a reply sends.
public actor PairingManager {

    // MARK: - Injected dependencies

    private let store: PairingStore
    private let macEndpointID: String
    private let hostLabel: String
    private let relayConfig: SignedRelayConfig
    private let clock: @Sendable () -> Int
    private let rng: @Sendable (Int) -> Data
    /// The confirm-timeout watchdog's "wait a bit, then re-check the clock" step — real
    /// `Task.sleep` in production, an instant/no-op (typically `{ _ in await Task.yield() }`) in
    /// tests, so `PairingManagerTests` can drive the 2-minute timeout purely by advancing the
    /// injected `clock`, with zero real wall-clock delay. Not part of the public initializer (the
    /// brief's exact public API) — wired only through the internal initializer below, reachable
    /// from this package's own tests via `@testable import`.
    private let sleepHook: @Sendable (Duration) async -> Void

    // `nonisolated`: an `AsyncStream`/`Continuation` are themselves Sendable and safe to touch
    // from any context — mirrors `NormaClient.events`'s own `nonisolated let` (NormaClient.swift)
    // so callers can iterate `manager.events` without hopping onto the actor for every read.
    public nonisolated let events: AsyncStream<PairingUIEvent>
    private nonisolated let eventsContinuation: AsyncStream<PairingUIEvent>.Continuation

    // MARK: - Ceremony constants

    /// QR offer lifetime (SP2b global constraint: expiry ≤ 5 min).
    private static let offerTTLSeconds = 300
    /// How long a proof-verified request waits for the human's confirm/deny before it's treated
    /// as abandoned (SP2b global constraint).
    private static let confirmTTLSeconds = 120
    /// Bad-proof attempts allowed against one offer before it's killed (SP2b global constraint).
    private static let maxProofFailures = 5
    /// How often the confirm-timeout watchdog wakes to re-check the clock in production — a
    /// handful of wakeups over a 2-minute window costs nothing; irrelevant in tests, where
    /// `sleepHook` returns immediately regardless of the duration passed.
    private static let confirmPollInterval = Duration.seconds(1)
    /// v1 only ever grants exactly this capability.
    private static let sessionCaps = ["sessions"]

    // MARK: - In-memory ceremony state

    /// One open QR offer at a time — `beginPairing` replaces any prior one. Holds the FULL
    /// `pairSecret` in memory for its 5-minute life (needed to HMAC-verify/derive the SAS);
    /// nothing here ever touches disk.
    private struct Offer {
        let pairID: Data
        let pairSecret: Data
        let expiresAt: Int
        var unused: Bool = true
        var failCount: Int = 0
    }
    private var offer: Offer?

    /// A verdict-path success has consumed the offer and is waiting on the human's confirm/deny.
    private struct PendingConfirm {
        let conn: RemoteConn
        let pairID: Data
        let phoneEndpointID: String
        let caps: [String]
        var timeoutTask: Task<Void, Never>?
    }
    private var pending: PendingConfirm?

    // MARK: - Init

    public init(
        store: PairingStore,
        macEndpointID: String,
        hostLabel: String,
        relayConfig: SignedRelayConfig,
        clock: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
        rng: @escaping @Sendable (Int) -> Data = { PairingManager.systemRandom($0) }
    ) {
        self.init(
            store: store, macEndpointID: macEndpointID, hostLabel: hostLabel,
            relayConfig: relayConfig, clock: clock, rng: rng,
            sleepHook: { duration in try? await Task.sleep(for: duration) }
        )
    }

    /// Test-only seam (internal — reachable via `@testable import NormaKit`): identical to the
    /// public initializer, plus the injectable `sleepHook` the confirm-timeout watchdog uses (see
    /// that property's own doc comment).
    init(
        store: PairingStore,
        macEndpointID: String,
        hostLabel: String,
        relayConfig: SignedRelayConfig,
        clock: @escaping @Sendable () -> Int,
        rng: @escaping @Sendable (Int) -> Data,
        sleepHook: @escaping @Sendable (Duration) async -> Void
    ) {
        self.store = store
        self.macEndpointID = macEndpointID
        self.hostLabel = hostLabel
        self.relayConfig = relayConfig
        self.clock = clock
        self.rng = rng
        self.sleepHook = sleepHook
        var continuation: AsyncStream<PairingUIEvent>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.eventsContinuation = continuation
    }

    /// Default `rng` — real random bytes via `SecRandomCopyBytes` (used for `PairAccepted.sessionNonce`).
    public static func systemRandom(_ count: Int) -> Data {
        var bytes = Data(count: count)
        _ = bytes.withUnsafeMutableBytes { buf in
            SecRandomCopyBytes(kSecRandomDefault, count, buf.baseAddress!)
        }
        return bytes
    }

    // MARK: - Public API

    /// Starts a fresh pairing offer, retiring any prior one (a new QR sheet always supersedes an
    /// old one — only one can be on screen). Returns the payload to render as a QR code.
    public func beginPairing() -> QRPayload {
        pending?.timeoutTask?.cancel()
        pending = nil

        let pairID = PairingManager.systemRandom(16)
        let pairSecret = PairingManager.systemRandom(32)
        let now = clock()
        let expiresAt = now + Self.offerTTLSeconds
        offer = Offer(pairID: pairID, pairSecret: pairSecret, expiresAt: expiresAt)

        return QRPayload(
            v: 1, pairID: pairID, pairSecret: pairSecret, expiresAt: expiresAt,
            macEndpointID: macEndpointID, relayConfig: relayConfig,
            alpn: "norma/remote/1", hostLabel: hostLabel
        )
    }

    /// True while there's still something for the phone/human to act on: an unconsumed,
    /// unexpired, not-yet-rate-limited offer, OR a proof-verified request awaiting confirm/deny.
    public var isWindowOpen: Bool {
        if let offer, offer.unused, clock() < offer.expiresAt, offer.failCount < Self.maxProofFailures {
            return true
        }
        return pending != nil
    }

    /// Drops the current offer (the QR sheet was closed before anyone scanned it).
    public func endPairing() {
        offer = nil
    }

    /// Reads exactly one frame from `conn` (a JSON `PairRequest`) and runs the full verdict path.
    /// Every failure sends a `PairRejected` frame and closes `conn`; success instead retains
    /// `conn` on `pending` and emits `.requestReceived` for the human to act on.
    public func handleConnection(_ conn: RemoteConn) async {
        var iterator = conn.inbound.makeAsyncIterator()
        guard let frame = await iterator.next() else { return } // conn closed before sending anything

        guard let request = try? JSONDecoder().decode(PairRequest.self, from: frame) else {
            await reject(conn, code: "bad_request")
            return
        }

        guard var currentOffer = offer,
              currentOffer.pairID == request.pairID,
              clock() < currentOffer.expiresAt,
              currentOffer.unused,
              currentOffer.failCount < Self.maxProofFailures
        else {
            // Covers a missing offer, a pairID for a since-superseded/expired/already-consumed
            // offer, and a rate-limited-dead offer — the phone can't distinguish these anyway.
            await reject(conn, code: "expired")
            eventsContinuation.yield(.failed(reason: "expired"))
            return
        }

        guard request.caps == Self.sessionCaps else {
            await reject(conn, code: "bad_request")
            return
        }

        let transcript = PairingCrypto.transcript(
            v: 1, pairID: request.pairID, macEndpointID: macEndpointID,
            phoneEndpointID: request.phoneEndpointID, phoneInstallNonce: request.phoneInstallNonce,
            caps: request.caps
        )

        guard PairingCrypto.verifyProof(pairSecret: currentOffer.pairSecret, transcript: transcript, proof: request.proof) else {
            currentOffer.failCount += 1
            let rateLimited = currentOffer.failCount >= Self.maxProofFailures
            // Mutate BEFORE the first `await` below — the offer's failCount/kill must be visible
            // to any connection that races in while `reject` is suspended sending/closing.
            offer = rateLimited ? nil : currentOffer
            await reject(conn, code: "bad_proof")
            eventsContinuation.yield(.failed(reason: rateLimited ? "rate_limited" : "bad_proof"))
            return
        }

        // Success: consume the offer (single-use) before anything below can suspend.
        currentOffer.unused = false
        offer = currentOffer

        let words = PairingCrypto.sasWords(pairSecret: currentOffer.pairSecret, transcript: transcript)
        let now = clock()
        let deadline = now + Self.confirmTTLSeconds
        var newPending = PendingConfirm(
            conn: conn, pairID: request.pairID, phoneEndpointID: request.phoneEndpointID, caps: request.caps
        )
        let pairID = request.pairID
        newPending.timeoutTask = Task { [weak self] in
            await self?.confirmTimeoutLoop(pairID: pairID, deadline: deadline)
        }
        pending = newPending

        eventsContinuation.yield(.requestReceived(words: words, requestedLabel: ""))
    }

    /// The human tapped Confirm (having typed `label`): persists the new `PairRecord` at the next
    /// epoch for this phone, replies `PairAccepted`, and emits `.completed`. A no-op if nothing is
    /// pending (stale/duplicate UI action).
    public func confirm(label: String) async {
        guard let p = pending else { return }
        p.timeoutTask?.cancel()
        pending = nil

        let now = clock()
        let epoch = await store.nextEpoch(forPeer: p.phoneEndpointID)
        let record = PairRecord(
            phoneEndpointID: p.phoneEndpointID, label: label, createdAt: now,
            caps: p.caps, pairingEpoch: epoch, lastSeenAt: now
        )
        do {
            try await store.add(record)
        } catch {
            // Either the store is at its 10-device cap, or some other persistence failure
            // occurred (`PairingStore.add` rolls back its in-memory state on a failed write
            // either way) — nothing was persisted, so tell the phone pairing didn't complete.
            await reject(p.conn, code: "cap_reached")
            eventsContinuation.yield(.failed(reason: "cap_reached"))
            return
        }

        let accepted = PairAccepted(
            type: "pair_accepted", pairID: p.pairID, macEndpointID: macEndpointID,
            phoneEndpointID: p.phoneEndpointID, epoch: epoch, grantedCaps: p.caps,
            protoVersion: 1, sessionNonce: rng(16)
        )
        if let payload = try? JSONEncoder().encode(accepted) {
            await p.conn.send(payload)
        }
        eventsContinuation.yield(.completed(record: record))
    }

    /// The human tapped Deny. A no-op if nothing is pending.
    public func deny() async {
        guard let p = pending else { return }
        p.timeoutTask?.cancel()
        pending = nil
        await reject(p.conn, code: "denied")
        eventsContinuation.yield(.failed(reason: "denied"))
    }

    // MARK: - Confirm-timeout watchdog

    /// Polls the injected clock (via the injected `sleepHook` between checks — see that
    /// property's doc comment) until either `pending` no longer matches `pairID` (resolved by
    /// `confirm`/`deny`, or superseded by a fresh `beginPairing`/another ceremony — nothing left
    /// for this watchdog to do) or `deadline` has passed, at which point it rejects with
    /// `"timeout"` and emits `.failed("timeout")`.
    private func confirmTimeoutLoop(pairID: Data, deadline: Int) async {
        while !Task.isCancelled {
            await sleepHook(Self.confirmPollInterval)
            if Task.isCancelled { return }
            guard let p = pending, p.pairID == pairID else { return }
            if clock() >= deadline {
                pending = nil
                await reject(p.conn, code: "timeout")
                eventsContinuation.yield(.failed(reason: "timeout"))
                return
            }
        }
    }

    // MARK: - Wire helpers

    private func reject(_ conn: RemoteConn, code: String) async {
        let message = PairRejected(type: "pair_rejected", code: code)
        if let payload = try? JSONEncoder().encode(message) {
            await conn.send(payload)
        }
        conn.close()
    }
}
