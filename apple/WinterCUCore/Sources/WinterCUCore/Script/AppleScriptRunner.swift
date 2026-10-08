import AppKit
import Carbon
import Foundation
import OSAKit

/// Runs one AppleScript inside the helper (its own Automation grant: macOS asks the user once per app), with
/// the source checked before and after compiling and EVERY Apple Event it sends checked by an OSA send hook
/// (`CUAppleScriptPolicy`). Each run has its own language instance on its own thread; a run past its timeout is
/// abandoned (its events are already capped to the time that was left) and its instance never reused.
enum CUAppleScriptRunner {
    /// What the send hook knows: whose events pass, the run's deadline, the original send proc, and the first
    /// refusal (to name it in the error).
    final class HookState {
        let ownPid = getpid()
        let boundPid: pid_t
        let boundName: String
        let deadline: Date
        var original: OSASendUPP?
        var originalRefCon: UnsafeMutableRawPointer?
        private let lock = NSLock()
        private var _refused: String?
        var refused: String? { lock.withLock { _refused } }
        func refuse(_ why: String) { lock.withLock { if _refused == nil { _refused = why } } }
        init(boundPid: pid_t, boundName: String, deadline: Date) {
            self.boundPid = boundPid
            self.boundName = boundName
            self.deadline = deadline
        }
    }

    static func fourCC(_ v: UInt32) -> String {
        let bytes = [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
        return String(bytes: bytes, encoding: .macOSRoman) ?? String(v)
    }

    /// The process an event is addressed to: a pid, a PSN (coerced), a bundle id or an app URL of a running
    /// app. nil when it can't be told (the event is then refused).
    static func targetPid(of event: UnsafePointer<AppleEvent>) -> pid_t? {
        var addr = AEDesc()
        guard AEGetAttributeDesc(event, AEKeyword(keyAddressAttr), DescType(typeWildCard), &addr) == noErr else { return nil }
        defer { AEDisposeDesc(&addr) }
        var pidDesc = AEDesc()
        if AECoerceDesc(&addr, DescType(typeKernelProcessID), &pidDesc) == noErr {
            defer { AEDisposeDesc(&pidDesc) }
            var pid: pid_t = 0
            if AEGetDescData(&pidDesc, &pid, MemoryLayout<pid_t>.size) == noErr, pid > 0 { return pid }
        }
        let size = AEGetDescDataSize(&addr)
        guard size > 0, size < 4096 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard AEGetDescData(&addr, &bytes, size) == noErr else { return nil }
        let text = String(decoding: bytes, as: UTF8.self)
        switch addr.descriptorType {
        case DescType(typeApplicationBundleID):
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: text)
            return apps.count == 1 ? apps[0].processIdentifier : nil
        case DescType(typeApplicationURL):
            guard let url = URL(string: text), url.isFileURL else { return nil }  // never a remote (eppc) machine
            let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.standardizedFileURL == url.standardizedFileURL }
            return apps.count == 1 ? apps[0].processIdentifier : nil
        default:
            return nil
        }
    }

    /// The send hook: every event the script sends passes here. Refused events never leave the helper.
    static let sendHook: OSASendProcPtr = { event, reply, mode, priority, timeout, idle, filter, refCon in
        guard let event, let refCon else { return OSErr(errAEEventNotPermitted) }
        let state = Unmanaged<HookState>.fromOpaque(refCon).takeUnretainedValue()
        var cls = AEEventClass(0), id = AEEventID(0), type = DescType(0), size = 0
        _ = AEGetAttributePtr(event, AEKeyword(keyEventClassAttr), DescType(typeType), &type, &cls, MemoryLayout<AEEventClass>.size, &size)
        _ = AEGetAttributePtr(event, AEKeyword(keyEventIDAttr), DescType(typeType), &type, &id, MemoryLayout<AEEventID>.size, &size)
        let verdict = CUAppleScriptPolicy.verdict(eventClass: fourCC(cls), eventID: fourCC(id), targetPid: targetPid(of: event),
                                                  ownPid: state.ownPid, boundPid: state.boundPid, boundName: state.boundName)
        guard verdict == .allow else {
            if case .refuse(let why) = verdict { state.refuse(why) }
            return OSErr(errAEEventNotPermitted)
        }
        // Never wait past the run's own deadline.
        let left = Int32(max(1, state.deadline.timeIntervalSinceNow * 60))
        let ticks = timeout < 0 || timeout > left ? left : timeout
        if let original = state.original {
            return original(event, reply, mode, priority, ticks, idle, filter, state.originalRefCon)
        }
        guard let reply else { return OSErr(errAEEventNotPermitted) }
        return OSErr(AESendMessage(event, reply, mode, Int(ticks)))
    }

    /// Runs `source` against `bound` (pid `boundPid`); the display value of its result (nil for none).
    static func run(_ source: String, bound: CUAppleScriptPolicy.BoundApp, boundPid: pid_t, timeoutMs: Int) throws -> String? {
        final class Box: @unchecked Sendable { var result: Result<String?, Error> = .success(nil) }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        let thread = Thread {
            box.result = Result { try execute(source, bound: bound, boundPid: boundPid, deadline: deadline) }
            done.signal()
        }
        thread.stackSize = 8 << 20
        thread.name = "Winter AppleScript"
        thread.start()
        guard done.wait(timeout: .now() + .milliseconds(timeoutMs + 250)) == .success else {
            throw CUError(code: "wait_timeout",
                          message: "the AppleScript did not finish within \(timeoutMs) ms and was abandoned — \(bound.name) may still be busy with it; pass a longer timeoutMs for slow work")
        }
        return try box.result.get()
    }

    private static func execute(_ source: String, bound: CUAppleScriptPolicy.BoundApp, boundPid: pid_t, deadline: Date) throws -> String? {
        guard let language = OSALanguage(forName: "AppleScript") else { throw CUError.unsupported("AppleScript is not available on this Mac") }
        let instance = OSALanguageInstance(language: language)
        let component = instance.componentInstance
        let state = HookState(boundPid: boundPid, boundName: bound.name, deadline: deadline)
        var original: OSASendUPP?
        var originalRefCon: UnsafeMutableRawPointer?
        _ = OSAGetSendProc(component, &original, &originalRefCon)
        state.original = original
        state.originalRefCon = originalRefCon
        let retained = Unmanaged.passRetained(state)
        defer { retained.release() }
        guard OSASetSendProc(component, sendHook, retained.toOpaque()) == noErr else {
            throw CUError.unsupported("the AppleScript was not run: its Apple Events could not be checked")
        }
        let script = OSAScript(source: source, from: nil, languageInstance: instance, using: [])
        var error: NSDictionary?
        guard script.compileAndReturnError(&error) else {
            throw CUError.invalidParams("the AppleScript does not compile: \(message(error))")
        }
        // The compiled script's own text, checked again: it undoes continuations and spelling tricks.
        try CUAppleScriptPolicy.checkSource(script.richTextSource?.string ?? script.source, bound: bound)
        var display: NSAttributedString?
        let value = script.executeAndReturnDisplayValue(&display, error: &error)
        if let refused = state.refused {
            throw CUError.notAllowed("applescript", "the AppleScript was stopped: \(refused)")
        }
        guard let value else { throw CUError.unsupported("the AppleScript failed: \(message(error))") }
        if value.descriptorType == DescType(typeNull) { return nil }
        return display?.string ?? value.stringValue
    }

    private static func message(_ error: NSDictionary?) -> String {
        let text = (error?[OSAScriptErrorMessage] as? String) ?? (error?[OSAScriptErrorBriefMessage] as? String) ?? "unknown error"
        let number = (error?[OSAScriptErrorNumber] as? NSNumber).map { " (\($0))" } ?? ""
        return text + number
    }

    /// Whether this helper may send Apple Events to `pid`, never asking: noErr = granted, -1744 = macOS would
    /// ask the user, -1743 = the user said no.
    static func automationPermission(pid: pid_t) -> OSStatus {
        var p = pid
        var addr = AEAddressDesc()
        guard AECreateDesc(DescType(typeKernelProcessID), &p, MemoryLayout<pid_t>.size, &addr) == noErr else { return OSStatus(procNotFound) }
        defer { AEDisposeDesc(&addr) }
        return AEDeterminePermissionToAutomateTarget(&addr, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
    }
}
