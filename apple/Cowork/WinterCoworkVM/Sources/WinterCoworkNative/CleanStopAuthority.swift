import Foundation

/// A raw VZ state is only one part of stop proof. A failed guest flush must not
/// invoke the host release callback, even if the hardware is already stopped.
enum CleanStopAuthority {
    static func confirm(_ descriptor: HostLaunchDescriptor, admission: any HostLaunchAdmission,
                        terminationConfirmed: Bool, flushConfirmed: Bool) async -> BackendStopResult {
        guard terminationConfirmed && flushConfirmed else {
            await admission.retainUncertainOwnership(descriptor, reason: "Termination/flush or recovery proof remains incomplete")
            return .init(terminationConfirmed: terminationConfirmed, flushConfirmed: flushConfirmed)
        }
        do { try await admission.confirmStopped(descriptor) }
        catch {
            await admission.retainUncertainOwnership(descriptor, reason: "Host backing termination/ownership/effect proof incomplete")
            return .init(terminationConfirmed: false, flushConfirmed: flushConfirmed)
        }
        return .init(terminationConfirmed: true, flushConfirmed: true)
    }
}
