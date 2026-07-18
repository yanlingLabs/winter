import Foundation
import Combine
import NormaProtocol

/// Pure, AppKit-free state machine backing the Mac's pairing QR sheet (SP2b Task 5). Lives in
/// NormaKit (not the app target) specifically so it's testable in `NormaKitTests` — the app has
/// no unit-test bundle for this feature (SP2b T5 global constraint: "the app-side coordinator/
/// views get NO unit tests ... ALL testable logic goes in the NormaKit model"). The app's
/// `PairingSheetView` only ever reads `state` and forwards taps to `confirmTapped`/`denyTapped`/
/// `regenerate` — it owns no state of its own beyond the label `TextField`'s live text.
///
/// Driven by two inputs: the Mac's `PairingManager.events` stream (`PairingUIEvent`) and a 1s
/// countdown tick (`sleepTick`, injectable so tests never depend on real wall-clock time) that
/// recomputes `secondsLeft` from the injected `now()` clock against the current QR's own
/// `expiresAt` — no TTL constant is duplicated here; whatever `PairingManager` actually put in
/// the QR is the only source of truth for when it expires.
@MainActor
public final class PairingSheetModel: ObservableObject {
    public enum State: Equatable {
        case showingQR(payload: String, secondsLeft: Int)
        case confirming(words: [String], label: String)
        case done(PairRecord)
        case failed(String)
    }

    @Published public private(set) var state: State

    private let events: AsyncStream<PairingUIEvent>
    private let beginPairing: @Sendable () async throws -> QRPayload
    private let confirmCeremony: @Sendable (String) async -> Void
    private let denyCeremony: @Sendable () async -> Void
    private let now: @Sendable () -> Int
    private let sleepTick: @Sendable () async -> Void

    private var expiresAt: Int = 0
    private var eventTask: Task<Void, Never>?
    private var countdownTask: Task<Void, Never>?
    /// Latched by `stop()` — guards every restart path (`startFreshOffer`) so a teardown that
    /// races an in-flight countdown tick / `begin()` can never resurrect a fresh offer (and with
    /// it a new countdown task) after the sheet is gone.
    private var stopped = false

    public init(
        events: AsyncStream<PairingUIEvent>,
        beginPairing: @escaping @Sendable () async throws -> QRPayload,
        confirm: @escaping @Sendable (String) async -> Void,
        deny: @escaping @Sendable () async -> Void,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
        sleepTick: @escaping @Sendable () async -> Void = { try? await Task.sleep(for: .seconds(1)) }
    ) {
        self.events = events
        self.beginPairing = beginPairing
        self.confirmCeremony = confirm
        self.denyCeremony = deny
        self.now = now
        self.sleepTick = sleepTick
        self.state = .showingQR(payload: "", secondsLeft: 0)
    }

    /// Starts the sheet: mints the first offer and begins consuming `events`. Call once, right
    /// after the sheet is presented. Safe to call only once — a second call would start a second
    /// overlapping event-consuming loop; nothing in this type guards that (the view/window
    /// controller that owns this model's lifetime is the one place that calls it).
    public func begin() async {
        if eventTask == nil {
            eventTask = Task { [weak self] in await self?.consumeEvents() }
        }
        await startFreshOffer()
    }

    /// User-requested (or countdown-triggered) fresh QR — supersedes whatever offer/pending the
    /// Mac's `PairingManager` currently holds.
    public func regenerate() async {
        await startFreshOffer()
    }

    /// Tears the model down when the sheet closes: cancels + drops BOTH background tasks and
    /// latches `stopped` so no restart path can resurrect them. The window controller's owner
    /// (`AppDelegate`'s `onClosed`) MUST call this — `deinit` can't be relied on for it (it runs
    /// off the MainActor, and the very tasks being cancelled here retain `self` for the duration
    /// of their in-flight `self?.consumeEvents()`/`self?.runCountdown()` calls — `[weak self]` on
    /// the closure only helps until that call starts — so without an explicit `stop()` the
    /// countdown would keep ticking, and auto-`beginPairing()`-ing against a manager the
    /// coordinator may be tearing down, forever).
    public func stop() {
        stopped = true
        eventTask?.cancel()
        eventTask = nil
        countdownTask?.cancel()
        countdownTask = nil
    }

    /// Test-only inspection hook (internal, reachable via `@testable import`): `stop()` has run —
    /// both tasks cancelled+dropped, all restart paths latched shut.
    var isStoppedForTesting: Bool {
        stopped && eventTask == nil && countdownTask == nil
    }

    public func confirmTapped(label: String) async {
        guard case .confirming = state else { return }
        await confirmCeremony(label)
    }

    public func denyTapped() async {
        guard case .confirming = state else { return }
        await denyCeremony()
    }

    // MARK: - Offer lifecycle

    private func startFreshOffer() async {
        guard !stopped else { return } // a stopped sheet must never mint a fresh offer/countdown
        countdownTask?.cancel()
        countdownTask = nil
        do {
            let qr = try await beginPairing()
            // Re-check after the suspension above: a `stop()` that landed while `beginPairing`
            // was awaited must win — assigning a fresh countdown task here would resurrect
            // exactly the leak `stop()` exists to close.
            guard !stopped else { return }
            expiresAt = qr.expiresAt
            state = .showingQR(payload: qr.encodeBase64URL(), secondsLeft: max(0, expiresAt - now()))
            countdownTask = Task { [weak self] in await self?.runCountdown() }
        } catch {
            state = .failed("couldn't start pairing — try again")
        }
    }

    private func runCountdown() async {
        while !Task.isCancelled {
            await sleepTick()
            if Task.isCancelled { return }
            guard case .showingQR(let payload, _) = state else { return } // left showingQR — nothing left to tick
            let remaining = expiresAt - now()
            if remaining <= 0 {
                await startFreshOffer() // auto-regenerate; spawns its own fresh countdown task
                return
            }
            state = .showingQR(payload: payload, secondsLeft: remaining)
        }
    }

    // MARK: - Event reducer

    private func consumeEvents() async {
        for await event in events {
            apply(event)
        }
    }

    private func apply(_ event: PairingUIEvent) {
        switch event {
        case .requestReceived(let words, let requestedLabel):
            countdownTask?.cancel()
            countdownTask = nil
            state = .confirming(words: words, label: requestedLabel)

        case .completed(let record):
            countdownTask?.cancel()
            countdownTask = nil
            state = .done(record)

        case .failed(let reason):
            // T3 review's binding rule: `PairingUIEvent.failed` carries NO ceremony
            // discriminator. `PairingManager.beginPairing()`'s own doc comment: superseding a
            // still-pending confirm orphans it and rejects it with code "expired" — deliberately
            // the SAME code a stale/consumed offer gets, with no separate "superseded" reason.
            // "expired" is therefore the ONE reason that can EVER arrive here for a ceremony
            // OTHER than the one currently reflected in `state` — every other reason
            // ("denied"/"timeout"/"cap_reached"/"internal_error") is only ever emitted in direct
            // response to the CURRENTLY pending confirm (our own `confirmTapped`/`denyTapped`, or
            // the confirm-timeout watchdog), so it always belongs to whatever `state` shows right
            // now. Concretely: if we're already `.confirming` (a NEWER request already promoted
            // past the old, now-superseded offer) and an "expired" arrives, it can only be that
            // stale orphan's own rejection catching up — ignore it rather than kill a live prompt.
            if case .confirming = state, reason == "expired" {
                return
            }
            countdownTask?.cancel()
            countdownTask = nil
            state = .failed("\(reason) — open a fresh QR")
        }
    }
}
