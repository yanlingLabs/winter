import Foundation
import Darwin

private struct ControllerOptions: Decodable {
    let backend: String?
    let scope: NativeScope
    let fakeStopUncertain: Bool?
    let fakeDelayMilliseconds: UInt32?
}
private final class ControllerReference {
    let controller: NativeController
    init(_ controller: NativeController) { self.controller = controller }
}
private func reference(_ handle: UnsafeMutableRawPointer?) -> ControllerReference? {
    guard let handle else { return nil }
    return Unmanaged<ControllerReference>.fromOpaque(handle).takeUnretainedValue()
}
@_cdecl("winter_cowork_native_protocol_version")
public func nativeProtocolVersion() -> UInt32 { 1 }

/// Host registration only. No serialized request can select the real backend.
/// The actual VZWorkspaceBackend requires injected HostLaunchAdmission authority.
@_cdecl("winter_cowork_native_create")
public func nativeCreate(_ json: UnsafePointer<CChar>?, _ length: UInt32) -> UnsafeMutableRawPointer? {
    guard let json, length <= 64 * 1024 else { return nil }
    do {
        let options = try JSONDecoder().decode(ControllerOptions.self, from: Data(bytes: json, count: Int(length)))
        let backend: any NativeWorkspaceBackend
        switch options.backend ?? "production" {
        case "fake": backend = FakeWorkspaceBackend(stopUncertain: options.fakeStopUncertain ?? false,
                delayMilliseconds: min(options.fakeDelayMilliseconds ?? 5, 100))
        case "production": backend = BlockedWorkspaceBackend()
        default: return nil
        }
        let controller = try NativeController(scope: options.scope, backend: backend)
        return Unmanaged.passRetained(ControllerReference(controller)).toOpaque()
    } catch { return nil }
}
@_cdecl("winter_cowork_native_submit")
public func nativeSubmit(_ handle: UnsafeMutableRawPointer?, _ json: UnsafePointer<CChar>?, _ length: UInt32) -> UInt64 {
    guard let context = reference(handle), let json, length <= 64 * 1024,
          let text = String(data: Data(bytes: json, count: Int(length)), encoding: .utf8) else { return 0 }
    return context.controller.submit(text)
}
@_cdecl("winter_cowork_native_event_fd")
public func nativeEventFD(_ handle: UnsafeMutableRawPointer?) -> Int32 { reference(handle)?.controller.events.eventFD ?? -1 }
@_cdecl("winter_cowork_native_poll")
public func nativePoll(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>? {
    reference(handle)?.controller.events.pollAllocated { strdup($0) }
}
@_cdecl("winter_cowork_native_string_free")
public func nativeStringFree(_ pointer: UnsafeMutablePointer<CChar>?) { free(pointer) }
@_cdecl("winter_cowork_native_shutdown")
public func nativeShutdown(_ handle: UnsafeMutableRawPointer?, _ budgetMilliseconds: UInt32) -> UInt64 {
    guard let context = reference(handle) else { return 0 }
    defer { context.controller.requestCleanup() }
    do {
        let encodedScope = try JSONEncoder().encode(context.controller.scope)
        let scope = try JSONSerialization.jsonObject(with: encodedScope)
        let request = try JSONSerialization.data(withJSONObject: ["scope": scope, "kind": "shutdown", "stopBudgetMilliseconds": budgetMilliseconds])
        return context.controller.submit(String(decoding: request, as: UTF8.self))
    } catch { return 0 }
}
@_cdecl("winter_cowork_native_release")
public func nativeRelease(_ handle: UnsafeMutableRawPointer?) -> Int32 {
    guard let handle, nativeCanRelease(handle) == 1 else { return 0 }
    Unmanaged<ControllerReference>.fromOpaque(handle).release()
    return 1
}
@_cdecl("winter_cowork_native_can_release")
public func nativeCanRelease(_ handle: UnsafeMutableRawPointer?) -> Int32 {
    guard let context = reference(handle), context.controller.lifetime.canRelease(), context.controller.events.counts().operations == 0 else { return 0 }
    return 1
}
