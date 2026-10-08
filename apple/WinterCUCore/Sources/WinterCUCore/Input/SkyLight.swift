import AppKit
import CoreGraphics
import Foundation

/// The private event path (ladder rung 3, behind `privatePath` / `computerUse.privateEventPath`).
///
/// Chromium and Electron renderers drop events posted with the public `CGEventPostToPid` as untrusted.
/// SkyLight's `SLEventPostToPid` routes through WindowServer's activity path, which they accept. Every
/// symbol is resolved with `dlsym` at first use; when one is missing the caller falls back to the public
/// route (rung 2) and logs once. Nothing here is linked against, so a macOS update that removes a symbol
/// degrades to rung 2 instead of failing to launch.
///
/// The recipe (pid-routed posting, the window-routing fields, the off-screen primer click and
/// focus-without-raise through `SLPSPostEventRecordTo`) follows cua-driver and yabai; see THIRD_PARTY.md.
public struct CUSkyLight: @unchecked Sendable {
    typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    typealias SetIntField = @convention(c) (CGEvent, UInt32, Int64) -> Void
    typealias SetWindowLocation = @convention(c) (CGEvent, CGFloat, CGFloat) -> Void
    typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
    typealias GetFrontProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
    typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
    typealias SetAuthMessage = @convention(c) (CGEvent, UnsafeMutableRawPointer) -> Void
    typealias AuthFactory = @convention(c) (AnyClass, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> UnsafeMutableRawPointer?

    var postToPidFn: PostToPid?
    var setIntFieldFn: SetIntField?
    var setWindowLocationFn: SetWindowLocation?
    var postEventRecordToFn: PostEventRecordTo?
    var getFrontProcessFn: GetFrontProcess?
    var getProcessForPIDFn: GetProcessForPID?
    var setAuthMessageFn: SetAuthMessage?
    var authFactoryFn: AuthFactory?

    /// `SLEventPostToPid` resolved: rung 3 is possible.
    public var isAvailable: Bool { postToPidFn != nil }
    /// Focus-without-raise resolved.
    public var canFocusWithoutRaise: Bool {
        postEventRecordToFn != nil && getFrontProcessFn != nil && getProcessForPIDFn != nil
    }

    /// Resolves every symbol through `lookup` (a `dlsym` stand-in, injectable for tests).
    public static func resolve(lookup: (String) -> UnsafeMutableRawPointer?) -> CUSkyLight {
        func fn<T>(_ name: String, _: T.Type) -> T? {
            guard let p = lookup(name) else { return nil }
            return unsafeBitCast(p, to: T.self)
        }
        var s = CUSkyLight()
        s.postToPidFn = fn("SLEventPostToPid", PostToPid.self)
        s.setIntFieldFn = fn("SLEventSetIntegerValueField", SetIntField.self)
        s.setWindowLocationFn = fn("CGEventSetWindowLocation", SetWindowLocation.self)
        s.postEventRecordToFn = fn("SLPSPostEventRecordTo", PostEventRecordTo.self)
        s.getFrontProcessFn = fn("_SLPSGetFrontProcess", GetFrontProcess.self)
        s.getProcessForPIDFn = fn("GetProcessForPID", GetProcessForPID.self)
        s.setAuthMessageFn = fn("SLEventSetAuthenticationMessage", SetAuthMessage.self)
        s.authFactoryFn = fn("objc_msgSend", AuthFactory.self)
        return s
    }

    /// The real symbols (SkyLight loaded into the process first). Resolved once.
    public static let system: CUSkyLight = {
        _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
        let defaultHandle = UnsafeMutableRawPointer(bitPattern: -2)  // RTLD_DEFAULT
        return resolve { dlsym(defaultHandle, $0) }
    }()

    /// Unavailable on purpose (tests, or the setting turned off).
    public static let none = CUSkyLight()

    // MARK: posting

    /// Posts through SkyLight. Keyboard events get an authentication envelope (needed by Chromium-class
    /// targets on macOS 14+), attached only when the runtime offers the factory. False → not posted.
    @discardableResult
    func post(_ event: CGEvent, to pid: pid_t, authenticate: Bool) -> Bool {
        guard let postToPidFn else { return false }
        if authenticate { attachAuthentication(event, pid: pid) }
        postToPidFn(pid, event)
        return true
    }

    /// Stamps raw integer fields the public `CGEventField` enum doesn't name (51, 58). Returns false when
    /// the setter is missing; the public fields are stamped by the caller either way.
    @discardableResult
    func setField(_ event: CGEvent, _ field: UInt32, _ value: Int64) -> Bool {
        guard let setIntFieldFn else { return false }
        setIntFieldFn(event, field, value)
        return true
    }

    @discardableResult
    func setWindowLocation(_ event: CGEvent, _ point: CGPoint) -> Bool {
        guard let setWindowLocationFn else { return false }
        setWindowLocationFn(event, point.x, point.y)
        return true
    }

    private func attachAuthentication(_ event: CGEvent, pid: pid_t) {
        guard let setAuthMessageFn, let authFactoryFn,
              let cls = NSClassFromString("SLSEventAuthenticationMessage") else { return }
        let sel = NSSelectorFromString("messageWithEventRecord:pid:version:")
        // The selector only exists on macOS 15+; calling it where it doesn't would raise.
        guard class_respondsToSelector(object_getClass(cls), sel) else { return }
        guard let record = eventRecord(event) else { return }
        autoreleasepool {
            if let msg = authFactoryFn(cls, sel, record, pid, 0) { setAuthMessageFn(event, msg) }
        }
    }

    /// The `SLSEventRecord *` inside a `CGEvent` (after the CF runtime header and a 32-bit field). Probed at
    /// the offsets known across releases, and only accepted when the word is a live malloc'd block — so a
    /// macOS layout change makes the envelope go missing (the event is still posted) instead of handing a
    /// garbage pointer to the runtime.
    private func eventRecord(_ event: CGEvent) -> UnsafeMutableRawPointer? {
        let base = Unmanaged.passUnretained(event).toOpaque()
        for offset in [24, 32, 16] {
            guard let p = base.load(fromByteOffset: offset, as: UnsafeMutableRawPointer?.self) else { continue }
            if Self.isHeapBlock(p) { return p }
        }
        return nil
    }

    /// Whether `p` points at the start of a block some malloc zone owns.
    static func isHeapBlock(_ p: UnsafeRawPointer) -> Bool {
        guard Int(bitPattern: p) & 0x7 == 0 else { return false }  // malloc blocks are 16-byte aligned
        return malloc_zone_from_ptr(p) != nil
    }

    // MARK: focus without raise

    /// The 248-byte event record that tells a process its window gained (`focus`) or lost key focus.
    static func focusRecord(windowID: UInt32, focus: Bool) -> [UInt8] {
        var buf = [UInt8](repeating: 0, count: 0xF8)
        buf[0x04] = 0xF8
        buf[0x08] = 0x0D
        withUnsafeBytes(of: windowID.littleEndian) { bytes in
            for (i, b) in bytes.enumerated() { buf[0x3C + i] = b }
        }
        buf[0x8A] = focus ? 0x01 : 0x02
        return buf
    }

    /// Makes `pid`'s `windowID` key without raising it or switching Spaces: the current front process gets a
    /// defocus record, the target a focus record. The front process stays frontmost for the user.
    @discardableResult
    func focusWithoutRaise(pid: pid_t, windowID: UInt32) -> Bool {
        guard let postEventRecordToFn, let getFrontProcessFn, let getProcessForPIDFn else { return false }
        var front = [UInt8](repeating: 0, count: 8)
        var target = [UInt8](repeating: 0, count: 8)
        let okFront = front.withUnsafeMutableBytes { getFrontProcessFn($0.baseAddress!) } == 0
        let okTarget = target.withUnsafeMutableBytes { getProcessForPIDFn(pid, $0.baseAddress!) } == 0
        guard okFront, okTarget else { return false }
        let defocus = Self.focusRecord(windowID: windowID, focus: false)
        let focus = Self.focusRecord(windowID: windowID, focus: true)
        let a = front.withUnsafeBytes { psn in defocus.withUnsafeBufferPointer { postEventRecordToFn(psn.baseAddress!, $0.baseAddress!) } }
        let b = target.withUnsafeBytes { psn in focus.withUnsafeBufferPointer { postEventRecordToFn(psn.baseAddress!, $0.baseAddress!) } }
        return a == 0 && b == 0
    }

    /// Undoes `focusWithoutRaise`: the target window loses key focus and the user's previous key window
    /// (`previousWindowID` of `previousPid`) gets it back, so their typing goes where it went before.
    @discardableResult
    func restoreFocus(previousPid: pid_t, previousWindowID: UInt32, targetPid: pid_t, targetWindowID: UInt32) -> Bool {
        guard let postEventRecordToFn, let getProcessForPIDFn else { return false }
        var prev = [UInt8](repeating: 0, count: 8)
        var target = [UInt8](repeating: 0, count: 8)
        guard prev.withUnsafeMutableBytes({ getProcessForPIDFn(previousPid, $0.baseAddress!) }) == 0,
              target.withUnsafeMutableBytes({ getProcessForPIDFn(targetPid, $0.baseAddress!) }) == 0
        else { return false }
        let defocus = Self.focusRecord(windowID: targetWindowID, focus: false)
        let focus = Self.focusRecord(windowID: previousWindowID, focus: true)
        let a = target.withUnsafeBytes { psn in defocus.withUnsafeBufferPointer { postEventRecordToFn(psn.baseAddress!, $0.baseAddress!) } }
        let b = prev.withUnsafeBytes { psn in focus.withUnsafeBufferPointer { postEventRecordToFn(psn.baseAddress!, $0.baseAddress!) } }
        return a == 0 && b == 0
    }
}
