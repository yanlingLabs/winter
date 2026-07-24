import Foundation

/// XPC contract between Norma.app (client) and NormaHelper (privileged SMAppService daemon).
///
/// This file is compiled directly into BOTH the `Norma` app target and the `NormaHelper` daemon
/// target (source-file-level dual membership via project.yml, not a shared framework), so both
/// sides always agree on the exact same protocol shape and mach service name.
@objc protocol NormaHelperProtocol {
    /// Sets the battery charge limit. Exactly one of the reply's two values is non-nil:
    /// - `resultJson` on success, e.g. `{"percent":80,"mechanism":"CHWA"}`
    /// - `errorJson` on failure, e.g. `{"code":"unsupported_value","message":"..."}`
    ///
    /// Known `errorJson.code` values: "invalid_range", "unsupported_value", "smc_error".
    func setChargeLimit(_ percent: Int, reply: @escaping (String?, String?) -> Void)

    /// Reads the current battery charge limit. Same (resultJson, errorJson) contract as
    /// `setChargeLimit`.
    func getChargeLimit(reply: @escaping (String?, String?) -> Void)
}

/// Stable mach service name shared by the helper's `NSXPCListener` and the app's
/// `NSXPCConnection`. Must match the `MachServices` key in the embedded launchd plist and that
/// plist's `Label` — both are `sed`-rewritten to this same value per build config by the app
/// target's "Embed NormaHelper" script (dist: `com.norma.helper`; dev: `com.norma.helper.dev`).
///
/// This file compiles into BOTH the app and the helper, so the `#if DEBUG` branch keeps the two
/// sides in lockstep as long as they build in the same configuration — which the scheme guarantees.
#if DEBUG
let normaHelperMachServiceName = "com.norma.helper.dev"
#else
let normaHelperMachServiceName = "com.norma.helper"
#endif
