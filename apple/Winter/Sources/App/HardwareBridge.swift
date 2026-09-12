import Foundation
import WinterKit
import WinterProtocol

// -----------------------------------------------------------------------------------------------
// Pure decision core: hardwarePlan (Task 4, Phase 4c) — mirrors chargeLimitPlan's role in
// HelperSources/SMCController.swift: no XPC, no network, no state; the single source of truth
// `HardwareBridge` only ever *executes*.
// -----------------------------------------------------------------------------------------------

/// What `HardwareBridge` should do with one `hardware_requested` verb call, decided without
/// touching XPC or the network. `.error(code:message:)` becomes the (JSON-encoded) `error` string
/// `hardwareRespond` sends back, in the SAME `{code, message}` envelope `HelperService.errorJson`
/// already uses daemon-side (see `HardwareBridge.errorJson` below) — a caller sees one consistent
/// shape regardless of whether the app or the helper produced the failure.
enum HardwarePlan: Equatable {
    case setChargeLimit(percent: Int)
    case getChargeLimit
    case error(code: String, message: String)
}

private struct SetChargeLimitArgs: Decodable { let percent: Int }

/// Verb + argsJson + live helper-approval state → what to do. THE testable core of this file —
/// mirrors `chargeLimitPlan(percent:appleSilicon:)`'s pure "decision table, two inputs" shape.
///
/// Ordering: unknown-verb is checked FIRST, ahead of approval — a caller sending a verb this
/// bridge has never heard of is a caller bug, independent of whether WinterHelper happens to be
/// approved right now. Unknown-verb here is defense-in-depth only: core's own
/// `HardwareBroker.request()` (`packages/core/src/peripheral/hardware.ts`'s `verbClass`) already
/// resolves unknown verbs SYNCHRONOUSLY, before a `hardware_requested` event is ever pushed to this
/// provider — so this branch should be unreachable in production. Same precedent as `shouldServe`'s
/// own `unsupported_class` branch in `PeripheralProvider.swift`, which core also pre-filters via
/// leases, yet is still checked here.
///
/// `helperApproved` is an explicit Bool (not read from a live `HelperClient`/`SMAppService`
/// directly) so this function stays fully pure and table-testable — `HardwareBridge.handle()`
/// passes `helperClient.status == .enabled` in production.
func hardwarePlan(verb: String, argsJson: String, helperApproved: Bool) -> HardwarePlan {
    guard verb == "setChargeLimit" || verb == "getChargeLimit" else {
        return .error(code: "unknown_verb", message: "unknown hardware verb: \(verb)")
    }
    guard helperApproved else {
        return .error(code: "helper_not_approved", message: "WinterHelper is not approved — open System Settings > General > Login Items")
    }
    if verb == "setChargeLimit" {
        guard let args = try? JSONDecoder().decode(SetChargeLimitArgs.self, from: Data(argsJson.utf8)) else {
            return .error(code: "invalid_args", message: "expected {\"percent\": <int>} argsJson for setChargeLimit")
        }
        return .setChargeLimit(percent: args.percent)
    }
    return .getChargeLimit
}

// -----------------------------------------------------------------------------------------------
// HardwareBridge — thin shell around hardwarePlan, composed alongside PeripheralProvider.
// -----------------------------------------------------------------------------------------------

/// The slice of `HelperClient` that `HardwareBridge` actually consumes — a seam, not an
/// abstraction for its own sake: constructing a REAL `HelperClient` under XCTest queries live
/// `SMAppService` state (a backgroundtaskmanagementd round-trip per construction), which
/// measurably destabilized this suite's 60Hz-timer animation tests (`SurfaceWindowTests` went
/// ~16s → ~74s, intermittently timing out, with two in-test constructions running ahead of it —
/// observed while landing this task, not hypothetical). Production conforms via the real
/// `HelperClient` below; `HardwareBridgeTests` stubs this and never touches ServiceManagement.
@MainActor
protocol HelperCalling: AnyObject {
    var status: HelperApprovalStatus { get }
    func setChargeLimit(_ percent: Int) async -> (resultJson: String?, errorJson: String?)
    func getChargeLimit() async -> (resultJson: String?, errorJson: String?)
}

extension HelperClient: HelperCalling {}

/// Winter.app's hardware-verb bridge (Task 4, Phase 4c, spec §5): answers `hardware_requested`
/// pushes by routing through `HelperClient`'s XPC calls to `WinterHelper`. `hardware_requested`
/// arrives on the SAME provider connection / feed-hook path `peripheral_call_requested` uses
/// (`AppModel.onPeripheralEvent`, fired for every raw `.session` event) — `AppDelegate.boot()`
/// composes this instance's `handle` ALONGSIDE `PeripheralProvider.handle` on that SAME hook,
/// exactly like `PeripheralProvider`/`SessionDirectory` are already composed together there; this
/// type does not restructure that plumbing.
///
/// LIVE-GATE: `handle()`'s own `HelperClient.setChargeLimit`/`getChargeLimit` calls are a real XPC
/// round-trip to a real daemon — not meaningful under XCTest. `hardwarePlan` above is the
/// unit-tested core; this class is deliberately thin around it, same posture as `HelperService` in
/// `HelperSources/HelperService.swift` relative to `chargeLimitPlan`.
@MainActor
final class HardwareBridge {
    private let client: WinterClient
    private let helperClient: HelperCalling

    init(client: WinterClient, helperClient: HelperCalling) {
        self.client = client
        self.helperClient = helperClient
    }

    /// Side-observer of the raw `SessionEvent` stream — every case other than `.hardwareRequested`
    /// is a no-op, same posture as `PeripheralProvider.handle`'s own `default: break`.
    func handle(_ event: SessionEvent) async {
        guard case .hardwareRequested(let req) = event else { return }
        switch hardwarePlan(verb: req.verb, argsJson: req.argsJson, helperApproved: helperClient.status == .enabled) {
        case .error(let code, let message):
            await respond(requestId: req.requestId, resultJson: nil, error: Self.errorJson(code: code, message: message))
        case .setChargeLimit(let percent):
            let (result, error) = await helperClient.setChargeLimit(percent)
            await respond(requestId: req.requestId, resultJson: result, error: error)
        case .getChargeLimit:
            let (result, error) = await helperClient.getChargeLimit()
            await respond(requestId: req.requestId, resultJson: result, error: error)
        }
    }

    private func respond(requestId: String, resultJson: String?, error: String?) async {
        do {
            try await client.hardwareRespond(requestId: requestId, resultJson: resultJson, error: error)
        } catch {
            NSLog("[HardwareBridge] respond failed: \(error)")
        }
    }

    private struct ErrorPayload: Encodable { let code: String; let message: String }

    private static func errorJson(code: String, message: String) -> String {
        guard let data = try? JSONEncoder().encode(ErrorPayload(code: code, message: message)),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }
}
