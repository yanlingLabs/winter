import Foundation

/// Host admission owns the durable reservation. Native code may abort it only
/// after launch has quiesced and the actual didCreate boundary is absent.
/// This port cannot stand in for constructed-VM termination/flush proof.
actor UnstartedReservation {
    private let descriptor: HostLaunchDescriptor
    private let admission: any HostLaunchAdmission
    private(set) var acquired = false
    private(set) var abortWaiterCount = 0
    private var abortInFlight: (UUID, Task<Void, any Error>)?
    init(descriptor: HostLaunchDescriptor, admission: any HostLaunchAdmission) {
        self.descriptor = descriptor; self.admission = admission
    }
    func acquire() async throws {
        try await admission.authorize(descriptor)
        acquired = true
    }
    func abort(didConstruct: Bool) async throws {
        guard !didConstruct else { throw NativeFailure("reservation_abort_denied", "A constructed VM requires termination proof, never reservation abort") }
        guard acquired else { return }
        let attempt: (UUID, Task<Void, any Error>)
        if let pending = abortInFlight { attempt = pending }
        else {
            let descriptor = self.descriptor, admission = self.admission
            attempt = (UUID(), Task { try await admission.abortUnstartedReservation(descriptor) })
            abortInFlight = attempt
        }
        abortWaiterCount += 1
        defer { abortWaiterCount -= 1 }
        do {
            try await attempt.1.value
            if abortInFlight?.0 == attempt.0 { acquired = false; abortInFlight = nil }
        } catch {
            if abortInFlight?.0 == attempt.0 { abortInFlight = nil }
            throw error
        }
    }
}
