import Foundation

/// Accepts new `NSXPCConnection`s for the `com.winter.helper` mach service and pins each one to
/// processes signed by team 37N77U9RSZ, per task-3-brief.md's exact requirement string.
///
/// Owns the ONE shared `ChargeManager` for the daemon's lifetime (per Task 6 of the gate-fix
/// plan) and hands the same instance to every `HelperService` it exports — the manager's target
/// state, timer, and SMC connection must not be duplicated per-connection.
final class HelperServiceDelegate: NSObject, NSXPCListenerDelegate {
    private static let codeSigningRequirement =
        "anchor apple generic and certificate leaf[subject.OU] = \"37N77U9RSZ\""

    private let chargeManager: ChargeManager

    init(chargeManager: ChargeManager) {
        self.chargeManager = chargeManager
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection newConnection: NSXPCConnection) -> Bool {
        newConnection.exportedInterface = NSXPCInterface(with: WinterHelperProtocol.self)
        newConnection.exportedObject = HelperService(chargeManager: chargeManager)
        // `NSXPCConnection.setCodeSigningRequirement(_:)` (macOS 13+) has no synchronous
        // "reject" return value — the only failure mode it can raise is an NSException for a
        // malformed requirement *string*, which can't happen here since the string above is a
        // hardcoded constant. A connecting peer that doesn't satisfy the requirement isn't
        // rejected at accept time; instead the OS invalidates the connection the moment the peer
        // sends its first message, which is the "reject on failure" behavior described in the
        // brief, just enforced slightly later in the connection's lifecycle than
        // `shouldAcceptNewConnection` itself. Must be set before `resume()` (XPC error otherwise).
        newConnection.setCodeSigningRequirement(Self.codeSigningRequirement)
        newConnection.resume()
        return true
    }
}

/// The exported XPC object. Translates `ChargeManager`/`ChargeLimitPlan` decisions into
/// (resultJson, errorJson) replies. Holds no state of its own — the shared `ChargeManager`
/// (owned by `HelperServiceDelegate`, one per daemon, not per-connection) does all the work.
final class HelperService: NSObject, WinterHelperProtocol {
    private let chargeManager: ChargeManager

    init(chargeManager: ChargeManager) {
        self.chargeManager = chargeManager
    }

    func setChargeLimit(_ percent: Int, reply: @escaping (String?, String?) -> Void) {
        do {
            // `setTarget` resolves (percent, enforcing, mechanism) atomically inside its own lock
            // and returns them directly — reading them back via a separate `getTarget()`/`mechanism`
            // call here would risk a concurrent `setChargeLimit` interleaving and reporting a
            // different request's result (TOCTOU).
            let result = try chargeManager.setTarget(percent)
            reply(Self.setResultJson(percent: result.percent, mechanism: result.mechanism, enforcing: result.enforcing), nil)
        } catch ChargeManager.ChargeManagerError.invalidRange {
            reply(nil, Self.errorJson(code: "invalid_range", message: "percent must be between 50 and 100"))
        } catch {
            reply(nil, Self.errorJson(code: "smc_error", message: "\(error)"))
        }
    }

    func getChargeLimit(reply: @escaping (String?, String?) -> Void) {
        let (percent, inhibitingNow, soc) = chargeManager.getTarget()
        reply(Self.getResultJson(percent: percent, inhibitingNow: inhibitingNow, soc: soc, mechanism: chargeManager.mechanism), nil)
    }

    // MARK: - JSON payloads

    private struct SetResultPayload: Encodable {
        let percent: Int
        let mechanism: String
        let enforcing: Bool
    }

    private struct GetResultPayload: Encodable {
        let percent: Int
        let inhibiting_now: Bool
        let soc: Int?
        let mechanism: String
    }

    private struct ErrorPayload: Encodable {
        let code: String
        let message: String
    }

    private static func setResultJson(percent: Int, mechanism: String, enforcing: Bool) -> String {
        encode(SetResultPayload(percent: percent, mechanism: mechanism, enforcing: enforcing))
    }

    private static func getResultJson(percent: Int, inhibitingNow: Bool, soc: Int?, mechanism: String) -> String {
        encode(GetResultPayload(percent: percent, inhibiting_now: inhibitingNow, soc: soc, mechanism: mechanism))
    }

    private static func errorJson(code: String, message: String) -> String {
        encode(ErrorPayload(code: code, message: message))
    }

    private static func encode<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value), let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }
}
