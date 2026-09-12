import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import CryptoKit
import Foundation
import WinterKit
import WinterProtocol

// -----------------------------------------------------------------------------------------------
// Pure decision core (spec §A4/A3 posture, mirrored from `packages/core/src/peripheral/broker.ts`'s
// `leaseDecision`/`expiredLeases`): neither type below touches the network, the clock (`nowMs` is
// an explicit argument), or Carbon/AppKit — `shouldServe` is the one function this task's tests
// exercise directly.
// -----------------------------------------------------------------------------------------------

/// The provider's own local view of one active lease — built entirely from `lease_granted`/
/// `lease_lost` events (`PeripheralProvider.handle`). Drives both `shouldServe`'s validation and
/// (later, Task 5) the dashboard's Peripheral pane (class/holder/age).
///
/// `tokenHash` (sha256 hex of the raw token, carried by `lease_granted` — spec §A1: "no token, no
/// service") is what `shouldServe` compares `sha256(call.token)` against; the raw token itself is
/// never stored here or anywhere else provider-side.
struct PeripheralLeaseInfo: Identifiable, Equatable {
    var id: String { leaseId }
    let leaseId: String
    let `class`: String
    let holder: SessionEvent.Holder
    let expiresAt: Int
    let tokenHash: String
}

/// A `peripheral_call_requested` event narrowed to exactly the fields `shouldServe` needs —
/// decoupled from `SessionEvent.PeripheralCallRequested` so the pure function has no dependency
/// beyond plain field shapes.
struct PeripheralCallRequest: Equatable {
    let requestId: String
    let leaseId: String
    let token: String
    let `class`: String
    let payloadJson: String
}

/// What the provider should do with an incoming capability call, decided without touching the
/// network. `.serve` means "the lease checks out AND this provider implements the class"
/// (Phase 5 CU: `noop` + `screenshot` + `ax-read` + `input-drive`). `.deny(code)` carries a short
/// typed-error code string sent back verbatim as `peripheral.respond`'s `error` field.
enum PeripheralServeDecision: Equatable {
    case serve
    case deny(String)
}

/// Capability classes this provider actually implements (Phase 5 CU widened this from just `noop`).
/// A lease for a class outside this set is denied `unsupported_class` at call time.
let cuSupportedClasses: Set<String> = ["noop", "screenshot", "ax-read", "input-drive"]

/// sha256 hex digest of `token`, lowercase — matches `hashToken()` in
/// `packages/core/src/peripheral/broker.ts` (`createHash("sha256").update(token).digest("hex")`)
/// byte-for-byte, so a token minted by core hashes to the same string here.
func sha256Hex(_ token: String) -> String {
    SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// Validates `call` against the provider's locally-tracked `leases` (from `lease_granted`/
/// `lease_lost`) at `nowMs`. Spec §A1: "the provider validates token+class+expiry on EVERY call —
/// no token, no service" — this function IS that check; core validating the same triple in
/// `PeripheralBroker.call()` (`packages/core/src/peripheral/broker.ts`) before ever pushing
/// `peripheral_call_requested` does not make this optional here, since a leaseId alone (with a
/// garbage/guessed token) must never be served. `call.token` is hashed and compared against
/// `lease.tokenHash` (carried by `lease_granted`, never the raw token) — the two hashing
/// implementations must stay byte-identical (see `sha256Hex` above). The provider never trusts
/// `call.class` over what it was actually granted for `call.leaseId`: a mismatch is
/// `class_mismatch`, not a silent reclassification.
func shouldServe(_ call: PeripheralCallRequest, leases: [PeripheralLeaseInfo], nowMs: Int) -> PeripheralServeDecision {
    guard let lease = leases.first(where: { $0.leaseId == call.leaseId }) else {
        return .deny("lease_not_found")
    }
    guard sha256Hex(call.token) == lease.tokenHash else {
        return .deny("token_mismatch")
    }
    guard lease.class == call.class else {
        return .deny("class_mismatch")
    }
    guard nowMs < lease.expiresAt else {
        return .deny("expired")
    }
    guard cuSupportedClasses.contains(call.class) else {
        return .deny("unsupported_class")
    }
    return .serve
}

// -----------------------------------------------------------------------------------------------
// PeripheralProvider — thin, stateful shell around the decision core above (spec §A4).
// -----------------------------------------------------------------------------------------------

/// Winter.app's peripheral capability provider: advertises TCC-derived capability state, tracks
/// its own active-lease set from `lease_granted`/`lease_lost`, serves `peripheral_call_requested`
/// (only `noop` in 2f), and hard-stops on panic (hotkey, menu item, screen lock, termination).
///
/// Owned by `AppDelegate` (constructed against the app's MAIN `AppModel` feed client — the daemon
/// rule is THE provider = the most-recent-advertiser CONNECTION, so advertise/respond/revoke must
/// all go through that SAME socket). `AppModel.onPeripheralEvent`/`onClientConnected` compose this
/// instance into the main feed's hooks exactly like `SessionDirectory.handle` — a side-observer
/// that never gates the feed's own event application.
@MainActor
final class PeripheralProvider: ObservableObject {
    @Published private(set) var activeLeases: [PeripheralLeaseInfo] = []

    private let client: WinterClient
    /// The computer-use capability implementation (Phase 5 CU) — the LIVE one in production, a fake
    /// in tests (the seam that keeps the provider's dispatch unit-testable without TCC).
    private let capabilities: ComputerCapabilities

    /// Set only by `registerPanicSurfaces()` (real app boot, never under unit tests — mirrors
    /// `MultitouchTrigger`/`HotkeyTrigger.shared.start()`'s own `!isRunningUnitTests` gating in
    /// `AppDelegate.boot()`). Gates the ACTUAL Carbon hotkey register/unregister calls that
    /// `handle()` would otherwise trigger on every lease_granted/lease_lost — a test driving
    /// `handle()` directly against a scripted transport must never touch Carbon.
    private var panicSurfacesEnabled = false
    private var hotKeyRef: EventHotKeyRef?
    private var hotKeyHandlerRef: EventHandlerRef?
    private var lockObserver: NSObjectProtocol?

    /// Single-instance routing seam: a Carbon `EventHandlerUPP` is `@convention(c)` and cannot
    /// capture `self` (same constraint `HotkeyTrigger.shared` works around with its own true
    /// singleton). `PeripheralProvider` isn't a singleton — `AppDelegate` owns the instance — so
    /// this weak static is set by `registerPanicSurfaces()` and cleared by `unregisterPanicSurfaces()`.
    private static weak var current: PeripheralProvider?

    private static let signature = "NmPn".fourCharCodeValue

    /// `PeripheralProvider`'s panic `InstallEventHandler` sits on the same shared
    /// `GetApplicationEventTarget()` dispatch chain as `HotkeyTrigger`'s summon handler and
    /// `ShortcutRegistry`'s plugin-shortcut handler, so it can be handed hotkey-pressed events
    /// that aren't its own. Verify the fired `EventHotKeyID.signature` before panicking, and
    /// return `eventNotHandledErr` (not `noErr`) for anything not `"NmPn"`, so the chain's other
    /// handlers still get a chance at it — same pattern as `ShortcutRegistry.handler`.
    private static let hotkeyHandler: EventHandlerUPP = { _, eventRef, _ in
        guard let eventRef else { return OSStatus(eventNotHandledErr) }
        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
            eventRef,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        guard status == noErr else { return status }
        guard hotKeyID.signature == PeripheralProvider.signature else {
            return OSStatus(eventNotHandledErr)
        }
        DispatchQueue.main.async {
            PeripheralProvider.current?.panic()
        }
        return noErr
    }

    init(client: WinterClient, capabilities: ComputerCapabilities? = nil) {
        self.client = client
        self.capabilities = capabilities ?? LiveComputerCapabilities()
    }

    // MARK: - Advertise (spec §A4: "advertises on connect ... and on TCC change")

    /// TCC preflights: `CGPreflightScreenCaptureAccess()`/`AXIsProcessTrusted()` — NEITHER prompts
    /// (only the `Request*`/`WithOptions` variants do), so this is safe to call at any time,
    /// including from unit tests. `noop` is always available (the v1 stub, no OS permission of its
    /// own); `input-drive` mirrors accessibility in v1 (real input-drive is Phase 5g).
    nonisolated static func currentClasses() -> [(class: String, tccGranted: Bool)] {
        let screenshotGranted = CGPreflightScreenCaptureAccess()
        let axGranted = AXIsProcessTrusted()
        return [
            (class: "noop", tccGranted: true),
            (class: "screenshot", tccGranted: screenshotGranted),
            (class: "ax-read", tccGranted: axGranted),
            (class: "input-drive", tccGranted: axGranted),
        ]
    }

    /// Called on client connect AND reconnect (`AppModel.onClientConnected` — fired once for the
    /// initial connect, and again for every subsequent reconnect; see `AppModel.handle`'s
    /// `.connection(.connected)` case) and by the TCC-change poll below. Best-effort: a failed
    /// advertise (e.g. not actually connected yet) just logs — the next connect/poll tick retries.
    ///
    /// FINAL-REVIEW FIX (M1): a daemon restart or socket drop kills core's `PeripheralBroker`
    /// state entirely (fresh process, empty lease table) — but WITHOUT this, the app kept ghost
    /// `activeLeases` from the OLD connection: the red panic menu item stayed mounted, the
    /// ⌃⌥⌘Esc hotkey stayed grabbed, and the dashboard's Peripheral pane kept showing dead leases,
    /// none of which core has any record of anymore. Clear the local set (and its derived UI
    /// state, via `updatePanicRegistration()`) BEFORE re-advertising — mirrors `panic()`'s own
    /// "local hard-stop first" ordering, just without the `revoke(all)` round-trip back to core:
    /// there is nothing there left to revoke against.
    func advertiseIfConnected() async {
        activeLeases.removeAll()
        updatePanicRegistration()
        do {
            try await client.peripheralAdvertise(classes: Self.currentClasses())
        } catch {
            NSLog("[PeripheralProvider] advertise failed: \(error)")
        }
    }

    private var tccPollTimer: Timer?
    private var lastTCCSnapshot: (screenshot: Bool, ax: Bool)?

    /// There is no OS notification for "Accessibility/Screen Recording grant changed" — periodic
    /// preflight is the only way to notice (spec §A4). Mirrors `MenuBarController`'s own 2s refresh
    /// cadence in `AppDelegate.boot()`. LIVE-GATE ITEM: exercised by hand (grant/revoke in System
    /// Settings while Winter is running), not unit-tested — a real TCC preflight call is what's
    /// under test here, not a fake.
    func startTCCPolling(intervalSeconds: TimeInterval = 2.0) {
        stopTCCPolling()
        tccPollTimer = Timer.scheduledTimer(withTimeInterval: intervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollTCC() }
        }
    }

    func stopTCCPolling() {
        tccPollTimer?.invalidate()
        tccPollTimer = nil
    }

    private func pollTCC() {
        let snapshot = (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted())
        guard lastTCCSnapshot == nil || lastTCCSnapshot! != snapshot else { return }
        lastTCCSnapshot = snapshot
        Task { await advertiseIfConnected() }
    }

    // MARK: - Event handling (lease_granted / lease_lost / peripheral_call_requested)

    /// Side-observer composed into `AppModel`'s main feed alongside `SessionDirectory.handle` (same
    /// posture: never gates the feed's own focused-session filtering). Handles exactly the three
    /// peripheral-shaped `SessionEvent` cases; every other case is a no-op. Lease events arrive on
    /// the REQUESTER's session, which this AppModel's own focus may be anywhere else entirely — that
    /// is expected, not a bug (see `daemon.ts`'s `emitTransient` fix: it pushes lease_granted/
    /// lease_lost to the provider connection directly, not just to the requester session's
    /// attachments).
    func handle(_ event: SessionEvent) async {
        switch event {
        case .leaseGranted(let g):
            // Idempotent on re-delivery (e.g. this connection is ALSO attached to the leasing
            // session — broadcastTransient's fan-out and the provider-direct push can both land
            // the same grant): drop any existing entry for this leaseId before appending.
            activeLeases.removeAll { $0.leaseId == g.leaseId }
            activeLeases.append(PeripheralLeaseInfo(leaseId: g.leaseId, class: g.class, holder: g.holder, expiresAt: g.expiresAt, tokenHash: g.tokenHash))
            updatePanicRegistration()
        case .leaseLost(let l):
            activeLeases.removeAll { $0.leaseId == l.leaseId }
            // Computer use (Phase 5 CU): the AX element-id cache is only valid while the ax-read
            // lease is held — a lost ax-read lease means the cached AXUIElement handles are stale,
            // so drop them (a later click must re-run ax_snapshot to get fresh ids).
            if l.class == "ax-read" { capabilities.clearElementCache() }
            updatePanicRegistration()
        case .peripheralCallRequested(let call):
            await respond(to: call)
        default:
            break
        }
    }

    private func respond(to call: SessionEvent.PeripheralCallRequested) async {
        let request = PeripheralCallRequest(requestId: call.requestId, leaseId: call.leaseId, token: call.token, class: call.class, payloadJson: call.payloadJson)
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        switch shouldServe(request, leases: activeLeases, nowMs: nowMs) {
        case .serve:
            if call.class == "noop" {
                await serveNoop(requestId: call.requestId, payloadJson: call.payloadJson)
            } else {
                await serveComputer(call)
            }
        case .deny(let code):
            await sendRespond(requestId: call.requestId, resultJson: nil, error: code)
        }
    }

    /// Computer use (Phase 5 CU): serve a screenshot / ax-read / input-drive call. Parses the
    /// payload against the lease class (pure `parseComputerPayload`), runs it through the capability
    /// seam, and encodes the result — every failure (bad payload, missing TCC, unknown element) is a
    /// typed `error` string the core `computer` tool surfaces to the model. Never throws across its
    /// surface (mirrors serveNoop).
    private func serveComputer(_ call: SessionEvent.PeripheralCallRequested) async {
        switch parseComputerPayload(cls: call.class, payloadJson: call.payloadJson) {
        case .failure(let e):
            await sendRespond(requestId: call.requestId, resultJson: nil, error: e.message)
        case .success(let op):
            do {
                let result = try await capabilities.perform(op)
                guard let json = encodeCUResult(result) else {
                    await sendRespond(requestId: call.requestId, resultJson: nil, error: "encode_failed")
                    return
                }
                await sendRespond(requestId: call.requestId, resultJson: json, error: nil)
            } catch let e as ComputerError {
                await sendRespond(requestId: call.requestId, resultJson: nil, error: e.message)
            } catch {
                await sendRespond(requestId: call.requestId, resultJson: nil, error: "computer_use_failed")
            }
        }
    }

    /// The `noop` contract: echo the payload back wrapped as `{"echo": <payload>}`. Round-trips
    /// `payloadJson` through `JSONValue` (rather than raw string concatenation) so a malformed
    /// payload is rejected with a typed error instead of shipping invalid JSON as a "result."
    private func serveNoop(requestId: String, payloadJson: String) async {
        guard let payload = try? JSONDecoder().decode(JSONValue.self, from: Data(payloadJson.utf8)) else {
            await sendRespond(requestId: requestId, resultJson: nil, error: "invalid_payload")
            return
        }
        let echoed = JSONValue.object(["echo": payload])
        guard let data = try? JSONEncoder().encode(echoed), let json = String(data: data, encoding: .utf8) else {
            await sendRespond(requestId: requestId, resultJson: nil, error: "encode_failed")
            return
        }
        await sendRespond(requestId: requestId, resultJson: json, error: nil)
    }

    private func sendRespond(requestId: String, resultJson: String?, error: String?) async {
        do {
            try await client.peripheralRespond(requestId: requestId, resultJson: resultJson, error: error)
        } catch {
            NSLog("[PeripheralProvider] respond failed: \(error)")
        }
    }

    // MARK: - Panic (spec §A1/A4: BOTH surfaces — hotkey + menu item — hard-stop + revoke(all))

    /// The panic action itself: local hard-stop FIRST (clear `activeLeases`, so a
    /// `peripheral_call_requested` racing the network revoke is denied `lease_not_found` by
    /// `shouldServe` immediately — no window where a call could still be served), then best-effort
    /// tell core to revoke every lease this provider holds. Fired by BOTH panic surfaces (the
    /// Carbon hotkey handler above and `MenuBarController`'s red menu item, wired in `AppDelegate`).
    func panic() {
        revokeAllLocally(reason: "panic")
    }

    /// Screen lock and app termination are additional hard-stop triggers (context brief), distinct
    /// from the two spec-pinned "panic" surfaces above — `reason: "revoked"` (a valid
    /// `LeaseLostReason`) rather than `"panic"`, since the user didn't hit a panic control; the
    /// environment changed out from under an active lease and Winter is being defensive. Safe to
    /// call with zero active leases (a cheap no-op `peripheral.revoke(all)` server-side).
    private func revokeAllLocally(reason: String) {
        activeLeases.removeAll()
        capabilities.clearElementCache() // Phase 5 CU: all control released — drop stale AX handles
        updatePanicRegistration()
        let client = self.client
        Task {
            do {
                try await client.peripheralRevoke(leaseId: nil, reason: reason)
            } catch {
                NSLog("[PeripheralProvider] revoke(all, reason: \(reason)) failed: \(error)")
            }
        }
    }

    /// `AppDelegate.applicationWillTerminate` — best-effort revoke-all before the process exits.
    func terminate() {
        revokeAllLocally(reason: "revoked")
        unregisterPanicSurfaces()
    }

    /// `DistributedNotificationCenter` "com.apple.screenIsLocked" handler.
    private func handleScreenLocked() {
        revokeAllLocally(reason: "revoked")
    }

    // MARK: - Panic surface registration (hotkey + screen-lock observer) — LIVE-GATE ITEMS.
    //
    // Neither RegisterEventHotKey nor DistributedNotificationCenter is safe/meaningful to exercise
    // under XCTest (a real global hotkey grab in CI, a real distributed notification observer with
    // no real screen-lock event to drive it) — `AppDelegate.boot()` calls `registerPanicSurfaces()`
    // only when `!Self.isRunningUnitTests`, the same gate `MultitouchTrigger`/`HotkeyTrigger.shared`
    // already use for exactly this reason. `handle()`/`panic()`/`shouldServe` above are fully
    // unit-tested without ever touching this section (`panicSurfacesEnabled` stays false).

    /// Call once from `AppDelegate.boot()` (production only). Wires the always-on screen-lock
    /// observer and flips on hotkey register/unregister for subsequent `handle()` calls.
    func registerPanicSurfaces() {
        Self.current = self
        panicSurfacesEnabled = true
        if lockObserver == nil {
            lockObserver = DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.handleScreenLocked() }
            }
        }
        updatePanicRegistration() // catch up in case leases already exist at registration time
    }

    func unregisterPanicSurfaces() {
        if let lockObserver {
            DistributedNotificationCenter.default().removeObserver(lockObserver)
        }
        lockObserver = nil
        unregisterHotkey()
        if let hotKeyHandlerRef {
            RemoveEventHandler(hotKeyHandlerRef)
        }
        hotKeyHandlerRef = nil
        panicSurfacesEnabled = false
        if Self.current === self { Self.current = nil }
    }

    /// Registered ONLY while `activeLeases` is non-empty (spec §A1), unregistered as soon as it's
    /// empty again — including right after `panic()`/`revokeAllLocally` clears it.
    private func updatePanicRegistration() {
        guard panicSurfacesEnabled else { return }
        if activeLeases.isEmpty {
            unregisterHotkey()
        } else {
            registerHotkeyIfNeeded()
        }
    }

    /// ⌃⌥⌘Esc — `kVK_Escape` with `controlKey | optionKey | cmdKey` (context brief). Mirrors
    /// `HotkeyTrigger.swift`'s `RegisterEventHotKey`/`InstallEventHandler` shape; the handler here
    /// is installed once (idempotent) and only the hotkey itself toggles with `activeLeases`.
    private func registerHotkeyIfNeeded() {
        guard hotKeyRef == nil else { return }
        if hotKeyHandlerRef == nil {
            var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: OSType(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), Self.hotkeyHandler, 1, &eventSpec, nil, &hotKeyHandlerRef)
        }
        let hotKeyID = EventHotKeyID(signature: Self.signature, id: 1)
        let modifiers = UInt32(controlKey | optionKey | cmdKey)
        let status = RegisterEventHotKey(UInt32(kVK_Escape), modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr {
            NSLog("[PeripheralProvider] panic hotkey registration failed status=\(status)")
        }
    }

    private func unregisterHotkey() {
        guard let hotKeyRef else { return }
        UnregisterEventHotKey(hotKeyRef)
        self.hotKeyRef = nil
    }
}

/// Deliberate duplicate of `HotkeyTrigger.swift`'s private `String.fourCharCodeValue` extension
/// (that one is `private` to its own file, not visible here) — a four-line helper, not worth
/// widening an unrelated gesture-trigger file's access level for.
private extension String {
    var fourCharCodeValue: UInt32 {
        var result: UInt32 = 0
        for scalar in utf8.prefix(4) {
            result = (result << 8) + UInt32(scalar)
        }
        return result
    }
}
