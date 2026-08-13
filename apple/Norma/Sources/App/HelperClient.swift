import Foundation
import ServiceManagement
import SwiftUI

// -----------------------------------------------------------------------------------------------
// HelperApprovalStatus / helperStatusDisplay — the testable core of this file (Task 4, Phase 4c).
// -----------------------------------------------------------------------------------------------

/// This codebase's own bridge type for `SMAppService.Status` (ServiceManagement, macOS 13+) —
/// kept independent of the OS enum so every call site (the dashboard row, `HardwareBridge`'s
/// approval gate) pattern-matches a closed, `Equatable` case set this file owns, rather than
/// reaching into `ServiceManagement` directly. `@unknown default` maps to `.unknown` so a future
/// SDK-added case degrades gracefully instead of a non-exhaustive-switch compile error rippling
/// through every consumer.
enum HelperApprovalStatus: Equatable {
    case notRegistered
    case enabled
    case requiresApproval
    case notFound
    case unknown

    init(_ status: SMAppService.Status) {
        switch status {
        case .notRegistered: self = .notRegistered
        case .enabled: self = .enabled
        case .requiresApproval: self = .requiresApproval
        case .notFound: self = .notFound
        @unknown default: self = .unknown
        }
    }
}

/// One `HelperApprovalStatus`'s dashboard-row rendering — state text + whether the "Open System
/// Settings" button (`PeripheralPane`, spec: Task 4's helper-approval row) should show. Shown
/// whenever the helper ISN'T cleanly `.enabled`: `.requiresApproval` is the expected "needs a
/// click in System Settings > Login Items" state (Task 6's live gate); `.unknown` is a forward-
/// compat safety net that's equally worth surfacing the shortcut for. `.notRegistered` (before
/// `HelperClient.register()` has run/succeeded) and `.notFound` (bundle/plist problem, not
/// something Login Items can fix) don't offer the button — there's nothing there yet to approve.
struct HelperStatusDisplay: Equatable {
    let stateText: String
    let showsOpenSettingsButton: Bool
}

func helperStatusDisplay(_ status: HelperApprovalStatus) -> HelperStatusDisplay {
    switch status {
    case .notRegistered:
        return HelperStatusDisplay(stateText: "Helper not registered", showsOpenSettingsButton: false)
    case .enabled:
        return HelperStatusDisplay(stateText: "Helper approved", showsOpenSettingsButton: false)
    case .requiresApproval:
        return HelperStatusDisplay(stateText: "Helper needs approval — open System Settings", showsOpenSettingsButton: true)
    case .notFound:
        return HelperStatusDisplay(stateText: "Helper not found", showsOpenSettingsButton: false)
    case .unknown:
        return HelperStatusDisplay(stateText: "Helper status unknown", showsOpenSettingsButton: true)
    }
}

/// The helper-approval status row's SwiftUI rendering — state text + "Open System Settings" button
/// (shown only when `helperStatusDisplay` says there's something actionable). Extracted (Phase
/// 4d-iii Task 4) from `PeripheralPane`'s original private `helperStatusRow` computed property so
/// the Plugin Manager pane's own helper-approval row can REUSE this exact component instead of
/// reimplementing it — `PeripheralPane` now instantiates this too, in place of its old inline body.
struct HelperApprovalRow: View {
    @ObservedObject var helperClient: HelperClient

    var body: some View {
        let display = helperStatusDisplay(helperClient.status)
        return HStack {
            Text(display.stateText)
                .font(Typography.label())
                .foregroundStyle(.secondary)
            Spacer()
            if display.showsOpenSettingsButton {
                Button("Open System Settings") {
                    SMAppService.openSystemSettingsLoginItems()
                }
                .font(Typography.label())
            }
        }
    }
}

// -----------------------------------------------------------------------------------------------
// HelperClient — SMAppService lifecycle + the app-side half of the NormaHelperProtocol XPC contract.
// -----------------------------------------------------------------------------------------------

/// Owns the app-side half of the `com.norma.helper` XPC contract (Task 4, Phase 4c): `SMAppService`
/// registration lifecycle for the privileged `NormaHelper` daemon (`HelperResources/
/// com.norma.helper.plist`, Label/mach-service `com.norma.helper` — see `normaHelperMachServiceName`
/// in `HelperShared/NormaHelperProtocol.swift`) and a lazy, invalidation-resilient
/// `NSXPCConnection` for the two `NormaHelperProtocol` calls.
///
/// LIVE-GATE: `register()`/`refreshStatus()` drive real `SMAppService` state, and
/// `setChargeLimit`/`getChargeLimit` drive a real XPC round-trip to a real `NormaHelper` process —
/// neither is meaningful under XCTest (no daemon to register/approve/connect to in CI, and the
/// `NormaAppTests` bundle loader is the real `Norma.app`, so a REAL `service.register()` call here
/// would attempt to register an actual privileged daemon from the test process — see
/// `AppDelegate.boot()`'s `!isRunningUnitTests` gate on `helperClient.register()`, mirroring the
/// same gate `MultitouchTrigger`/`peripheral.registerPanicSurfaces()` already use). `status` itself
/// is safe to read anytime (a plain property read, no prompt/registration side effect — same
/// posture as `PeripheralProvider.currentClasses()`'s TCC preflights), so `init()` refreshes it
/// unconditionally. `helperStatusDisplay` above is this file's unit-tested core; this class is
/// deliberately thin around it, same posture as `SMCController` in `HelperSources/SMCController.swift`.
@MainActor
final class HelperClient: ObservableObject {
    @Published private(set) var status: HelperApprovalStatus = .notRegistered

    private let service = SMAppService.daemon(plistName: "com.norma.helper.plist")
    private var connection: NSXPCConnection?

    init() {
        refreshStatus()
    }

    /// Snapshots `service.status` into the published enum. Called on init, after register, and
    /// available for the dashboard row's own manual/periodic refresh.
    func refreshStatus() {
        status = HelperApprovalStatus(service.status)
    }

    /// Registers the daemon. A fresh registration typically lands in `.requiresApproval` until the
    /// user approves it in System Settings > General > Login Items (Task 6's live gate) — this
    /// call itself never blocks on that approval; it only kicks off registration and refreshes
    /// `status` with whatever `SMAppService` reports immediately after.
    func register() {
        do {
            try service.register()
        } catch {
            NSLog("[HelperClient] register failed: \(error)")
        }
        refreshStatus()
    }

    // MARK: - XPC calls (NormaHelperProtocol)

    /// Lazy + invalidation-resilient: `invalidationHandler`/`interruptionHandler` both nil out
    /// `connection` so the NEXT call reconnects fresh instead of reusing a dead `NSXPCConnection`
    /// forever. `.privileged` matches the standard SMAppService-daemon connection pattern (the
    /// modern replacement for the old SMJobBless privileged-helper XPC setup).
    private func remoteProxy(errorHandler: @escaping (Error) -> Void) -> NormaHelperProtocol? {
        let c: NSXPCConnection
        if let existing = connection {
            c = existing
        } else {
            let fresh = NSXPCConnection(machServiceName: normaHelperMachServiceName, options: .privileged)
            fresh.remoteObjectInterface = NSXPCInterface(with: NormaHelperProtocol.self)
            fresh.invalidationHandler = { [weak self] in
                Task { @MainActor in self?.connection = nil }
            }
            fresh.interruptionHandler = { [weak self] in
                Task { @MainActor in self?.connection = nil }
            }
            fresh.resume()
            connection = fresh
            c = fresh
        }
        return c.remoteObjectProxyWithErrorHandler(errorHandler) as? NormaHelperProtocol
    }

    /// `{"code":"xpc_error","message":...}` — this file's own synthesized error for connection-
    /// level failures (no proxy, or the error handler fired instead of the reply block), kept in
    /// the SAME `{code, message}` envelope `HelperService.errorJson` already uses daemon-side, so
    /// `HardwareBridge` can pass either straight through to `hardwareRespond` uniformly.
    private static func xpcErrorJson(_ message: String) -> String {
        errorJson(code: "xpc_error", message: message)
    }

    private struct ErrorPayload: Encodable { let code: String; let message: String }

    private static func errorJson(code: String, message: String) -> String {
        guard let data = try? JSONEncoder().encode(ErrorPayload(code: code, message: message)),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }

    func setChargeLimit(_ percent: Int) async -> (resultJson: String?, errorJson: String?) {
        await call { proxy, reply in proxy.setChargeLimit(percent, reply: reply) }
    }

    func getChargeLimit() async -> (resultJson: String?, errorJson: String?) {
        await call { proxy, reply in proxy.getChargeLimit(reply: reply) }
    }

    /// The shared XPC-call body: a checked continuation resumed EXACTLY ONCE by whichever fires
    /// first — the method's reply block, the proxy's connection-level error handler, or (Task 4,
    /// Phase 4d-cleanup) an 8s fallback timer. XPC guarantees one of the first two per call, but
    /// a wedged/silent `NormaHelper` (hung, deadlocked, killed mid-call without the connection
    /// noticing) satisfies neither, so the timer is a THIRD race participant, not a replacement
    /// for the other two. 8s is deliberately under norma-core's `HardwareBroker` 10s timeout, so
    /// this typed error resolves first and the broker never has to fire its own. All three arrive
    /// on non-main queues/timers, so the once-latch is a real lock (`ResumeOnce`), not a bare Bool.
    private func call(_ invoke: (NormaHelperProtocol, @escaping (String?, String?) -> Void) -> Void) async -> (resultJson: String?, errorJson: String?) {
        await withCheckedContinuation { continuation in
            let once = ResumeOnce()
            let resume: (String?, String?) -> Void = { result, error in
                guard once.claim() else { return }
                continuation.resume(returning: (result, error))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                resume(nil, Self.errorJson(code: "timeout", message: "helper did not reply within 8s"))
            }
            guard let proxy = remoteProxy(errorHandler: { error in
                resume(nil, Self.xpcErrorJson("\(error)"))
            }) else {
                resume(nil, Self.xpcErrorJson("no NormaHelper connection"))
                return
            }
            invoke(proxy) { result, error in resume(result, error) }
        }
    }
}

/// Lock-backed once-latch for `HelperClient.call` — `claim()` returns true exactly once, no matter
/// which queue the winning caller arrives on.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !claimed else { return false }
        claimed = true
        return true
    }
}
