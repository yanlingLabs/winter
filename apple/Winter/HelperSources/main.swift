import Foundation

// WinterHelper entry point. A privileged (SMAppService.daemon) XPC service — no UI, no run loop
// work beyond servicing the com.winter.helper mach service.
//
// One ChargeManager for the daemon's lifetime: load any persisted charge-limit target and start
// enforcing it immediately, so a launchd restart re-applies the user's limit (CHTE itself is
// volatile and resets to 0 on reboot/power loss — see .superpowers/sdd/4c-m4-charge-limit-research.md).
let chargeManager = ChargeManager()
chargeManager.loadPersistedTargetAndStart()

let delegate = HelperServiceDelegate(chargeManager: chargeManager)
let listener = NSXPCListener(machServiceName: winterHelperMachServiceName)
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
