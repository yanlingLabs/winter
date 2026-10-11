import Foundation
import Darwin

private let events = EventQueue()
private let controller = ProbeController()

@_cdecl("winter_cowork_vm_abi_version")
public func winterCoworkVMABIVersion() -> UInt32 { 1 }

@_cdecl("winter_cowork_vm_submit")
public func winterCoworkVMSubmit(_ json: UnsafePointer<CChar>?) -> UInt64 {
    guard let json, let opID = events.reserve() else { return 0 }
    // The caller owns this pointer; never capture it in asynchronous work.
    let data = Data(bytes: json, count: strnlen(json, 64 * 1024 + 1))
    Task {
        var event: [String: Any] = ["schema": 1, "opId": opID]
        var fixtureRoot: URL?
        do {
            guard data.count <= 64 * 1024 else { throw ProbeFailure(code: "request_too_large", message: "request exceeds 64 KiB") }
            let request = try JSONDecoder().decode(Request.self, from: data)
            fixtureRoot = try? FixturePaths.root(request.fixtureRoot)
            event["method"] = request.method
            let result = try await controller.perform(request)
            event["result"] = try JSONSerialization.jsonObject(with: Data(result.utf8))
            event["status"] = "completed"
        } catch {
            let failure = error as? ProbeFailure
            event["status"] = "failed"
            event["error"] = ["code": failure?.code ?? "native_error",
                              "message": NativeDiagnostics.safeMessage(error.localizedDescription, fixtureRoot: fixtureRoot),
                              "nativeChain": NativeDiagnostics.chain(error, fixtureRoot: fixtureRoot)]
        }
        do {
            let encoded = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
            events.finish(String(decoding: encoded, as: UTF8.self))
        } catch {
            events.finish("{\"schema\":1,\"opId\":\(opID),\"status\":\"failed\",\"error\":{\"code\":\"event_encoding_failed\",\"message\":\"native event encoding failed\"}}")
        }
    }
    return opID
}

@_cdecl("winter_cowork_vm_poll")
public func winterCoworkVMPoll() -> UnsafeMutablePointer<CChar>? {
    events.pollAllocated { strdup($0) }
}

@_cdecl("winter_cowork_vm_string_free")
public func winterCoworkVMStringFree(_ value: UnsafeMutablePointer<CChar>?) { free(value) }
