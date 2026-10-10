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
    typealias GetProcessPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32
    typealias SetAuthMessage = @convention(c) (CGEvent, UnsafeMutableRawPointer) -> Void
    typealias AuthFactory = @convention(c) (AnyClass, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> UnsafeMutableRawPointer?
    typealias MainConnection = @convention(c) () -> UInt32
    typealias ActiveSpace = @convention(c) (UInt32) -> UInt64
    typealias CopySpacesForWindows = @convention(c) (UInt32, Int32, CFArray) -> Unmanaged<CFArray>?
    typealias WindowsSpaces = @convention(c) (UInt32, CFArray, CFArray) -> Void
    typealias SpaceType = @convention(c) (UInt32, UInt64) -> Int32
    typealias CaptureInRect = @convention(c) (UInt32, UnsafeMutablePointer<UInt32>, Int32, UInt32, CGRect) -> Unmanaged<CFArray>?
    typealias CaptureList = @convention(c) (UInt32, UnsafeMutablePointer<UInt32>, Int32, UInt32) -> Unmanaged<CFArray>?
    typealias UpdateFn = @convention(c) (UInt32) -> Int32
    typealias GetKeyFocus = @convention(c) (UnsafeMutableRawPointer) -> Int32
    typealias ReleaseKeyFocus = @convention(c) (Int32) -> Int32
    typealias ProcessPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32
    typealias SetFrontProcessWithOptions = @convention(c) (UnsafeRawPointer, UInt32, UInt32) -> Int32

    var postToPidFn: PostToPid?
    var setIntFieldFn: SetIntField?
    var setWindowLocationFn: SetWindowLocation?
    var postEventRecordToFn: PostEventRecordTo?
    var getFrontProcessFn: GetFrontProcess?
    var getProcessForPIDFn: GetProcessForPID?
    var getProcessPIDFn: GetProcessPID?
    var setAuthMessageFn: SetAuthMessage?
    var authFactoryFn: AuthFactory?
    var mainConnectionFn: MainConnection?
    var activeSpaceFn: ActiveSpace?
    var copySpacesFn: CopySpacesForWindows?
    var addToSpacesFn: WindowsSpaces?
    var removeFromSpacesFn: WindowsSpaces?
    var spaceTypeFn: SpaceType?
    var captureInRectFn: CaptureInRect?
    var captureListFn: CaptureList?
    var disableUpdateFn: UpdateFn?
    var reenableUpdateFn: UpdateFn?
    var getKeyFocusFn: GetKeyFocus?
    var releaseKeyFocusFn: ReleaseKeyFocus?
    var processPIDFn: ProcessPID?
    var setFrontProcessWithOptionsFn: SetFrontProcessWithOptions?

    /// `SLEventPostToPid` resolved: rung 3 is possible.
    public var isAvailable: Bool { postToPidFn != nil }
    /// `CGEventSetWindowLocation` resolved: an event can be addressed to a window by its local point.
    public var canSetWindowLocation: Bool { setWindowLocationFn != nil }
    /// Focus-without-raise resolved.
    public var canFocusWithoutRaise: Bool {
        postEventRecordToFn != nil && getFrontProcessFn != nil && getProcessForPIDFn != nil
    }

    /// A specific window can be brought to the front by id (`_SLPSSetFrontProcessWithOptions`), taking the user to
    /// the Space it is on — a desktop visit's way there and back.
    public var canFrontWindow: Bool { setFrontProcessWithOptionsFn != nil && getProcessForPIDFn != nil }

    /// A window can be captured wherever it is (`SLSHWCaptureWindowListInRect`, or the list call).
    public var canCaptureWindows: Bool { mainConnectionFn != nil && (captureInRectFn != nil || captureListFn != nil) }
    /// WindowServer updates can be suspended around a focus change (an `SLSDisableUpdate` bracket, so the change is never drawn half-done).
    public var canSuspendUpdates: Bool { mainConnectionFn != nil && disableUpdateFn != nil && reenableUpdateFn != nil }

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
        s.getProcessPIDFn = fn("GetProcessPID", GetProcessPID.self)
        s.setAuthMessageFn = fn("SLEventSetAuthenticationMessage", SetAuthMessage.self)
        s.authFactoryFn = fn("objc_msgSend", AuthFactory.self)
        s.mainConnectionFn = fn("SLSMainConnectionID", MainConnection.self) ?? fn("CGSMainConnectionID", MainConnection.self)
        s.activeSpaceFn = fn("SLSGetActiveSpace", ActiveSpace.self) ?? fn("CGSGetActiveSpace", ActiveSpace.self)
        s.copySpacesFn = fn("SLSCopySpacesForWindows", CopySpacesForWindows.self)
            ?? fn("CGSCopySpacesForWindows", CopySpacesForWindows.self)
        s.addToSpacesFn = fn("SLSAddWindowsToSpaces", WindowsSpaces.self) ?? fn("CGSAddWindowsToSpaces", WindowsSpaces.self)
        s.removeFromSpacesFn = fn("SLSRemoveWindowsFromSpaces", WindowsSpaces.self)
            ?? fn("CGSRemoveWindowsFromSpaces", WindowsSpaces.self)
        s.spaceTypeFn = fn("SLSSpaceGetType", SpaceType.self) ?? fn("CGSSpaceGetType", SpaceType.self)
        s.captureInRectFn = fn("SLSHWCaptureWindowListInRect", CaptureInRect.self)
            ?? fn("CGSHWCaptureWindowListInRect", CaptureInRect.self)
        s.captureListFn = fn("SLSHWCaptureWindowList", CaptureList.self) ?? fn("CGSHWCaptureWindowList", CaptureList.self)
        s.disableUpdateFn = fn("SLSDisableUpdate", UpdateFn.self) ?? fn("CGSDisableUpdate", UpdateFn.self)
        s.reenableUpdateFn = fn("SLSReenableUpdate", UpdateFn.self) ?? fn("CGSReenableUpdate", UpdateFn.self)
        s.getKeyFocusFn = fn("CPSGetKeyFocusProcess", GetKeyFocus.self)
        s.releaseKeyFocusFn = fn("CPSReleaseKeyFocusWithID", ReleaseKeyFocus.self)
        s.processPIDFn = fn("GetProcessPID", ProcessPID.self)
        s.setFrontProcessWithOptionsFn = fn("_SLPSSetFrontProcessWithOptions", SetFrontProcessWithOptions.self)
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

    /// Makes `pid`'s `windowID` key without raising it: the current front process gets a defocus record, the
    /// target a focus record, and the front process stays frontmost. Nothing proves in advance that an app
    /// takes it quietly, so the caller checks every use (`CUCore.keyWithoutRaise`).
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

    // MARK: a specific window to the front (a desktop visit)

    /// `kCPSUserGenerated`: the front-process change is treated as the user's own, so the window server switches to
    /// the Space the window is on (the way window managers focus a window on another Space).
    static let cpsUserGenerated: UInt32 = 0x200

    /// The 248-byte record that makes a window its process's key window (posted twice, phases 1 and 2).
    static func keyWindowRecord(windowID: UInt32, phase: UInt8) -> [UInt8] {
        var buf = [UInt8](repeating: 0, count: 0xF8)
        buf[0x04] = 0xF8
        buf[0x08] = phase
        buf[0x3A] = 0x10
        withUnsafeBytes(of: windowID.littleEndian) { bytes in
            for (i, b) in bytes.enumerated() { buf[0x3C + i] = b }
        }
        for i in 0x20..<0x30 { buf[i] = 0xFF }
        return buf
    }

    /// Brings `pid`'s window `windowID` to the front BY ID and makes it key: the window server takes the user to the
    /// Space it is on — even when the app has other windows on the current desktop (activating the app would then
    /// stay here), and for a window accessibility never exposed (nothing to raise). Only a desktop visit the user
    /// allowed calls it. False when the symbols are missing or the call failed.
    @discardableResult
    func frontWindow(pid: pid_t, windowID: UInt32) -> Bool {
        guard let setFrontProcessWithOptionsFn, let getProcessForPIDFn else { return false }
        var psn = [UInt8](repeating: 0, count: 8)
        guard psn.withUnsafeMutableBytes({ getProcessForPIDFn(pid, $0.baseAddress!) }) == 0 else { return false }
        let fronted = psn.withUnsafeBytes { setFrontProcessWithOptionsFn($0.baseAddress!, windowID, Self.cpsUserGenerated) } == 0
        if let postEventRecordToFn {
            for phase: UInt8 in [0x01, 0x02] {
                let record = Self.keyWindowRecord(windowID: windowID, phase: phase)
                _ = psn.withUnsafeBytes { p in record.withUnsafeBufferPointer { postEventRecordToFn(p.baseAddress!, $0.baseAddress!) } }
            }
        }
        return fronted
    }

    // MARK: what the user is looking at

    /// The window server's front process, as a pid: the app the user is in. Read straight from the window
    /// server, so an activation shows at once (NSWorkspace learns of it later, on the main run loop).
    public func frontProcessPid() -> pid_t? {
        guard let getFrontProcessFn, let getProcessPIDFn else { return nil }
        var psn = [UInt8](repeating: 0, count: 8)
        guard psn.withUnsafeMutableBytes({ getFrontProcessFn($0.baseAddress!) }) == 0 else { return nil }
        var pid: pid_t = 0
        guard psn.withUnsafeBytes({ getProcessPIDFn($0.baseAddress!, &pid) }) == 0, pid > 0 else { return nil }
        return pid
    }

    /// The active Space (of the display with the menu bar): the desktop the user is looking at.
    public func activeSpace() -> UInt64? {
        guard let mainConnectionFn, let activeSpaceFn else { return nil }
        let space = activeSpaceFn(mainConnectionFn())
        return space == 0 ? nil : space
    }

    // MARK: Spaces

    /// Every Space a window is on.
    func spaces(ofWindow id: UInt32, connection cid: UInt32) -> [UInt64] {
        guard let copySpacesFn,
              let arr = copySpacesFn(cid, 0x7, [NSNumber(value: id)] as CFArray)?.takeRetainedValue() as? [NSNumber]
        else { return [] }
        return arr.map(\.uint64Value).filter { $0 != 0 }
    }

    /// Whether a window is on any Space at all (an ordered-out — closed but still allocated — window is on
    /// none); nil when it can't be read.
    public func isOnAnySpace(windowID id: UInt32) -> Bool? {
        guard let mainConnectionFn, copySpacesFn != nil else { return nil }
        return !spaces(ofWindow: id, connection: mainConnectionFn()).isEmpty
    }

    /// Moves a window to the active Space without activating anything: added to the active Space first,
    /// verified, and only then removed from its old ones, so a refused move changes nothing. Windows in a
    /// full-screen Space are left alone (they are sized for it). False when any symbol is missing, the
    /// window server refuses (moving another process's window may need rights a regular app lacks), or the
    /// window is already there.
    func moveWindowToActiveSpace(windowID id: UInt32) -> Bool {
        guard let mainConnectionFn, let activeSpaceFn, let addToSpacesFn, let removeFromSpacesFn else { return false }
        let cid = mainConnectionFn()
        let active = activeSpaceFn(cid)
        guard active != 0 else { return false }
        let before = spaces(ofWindow: id, connection: cid)
        guard !before.isEmpty, !before.contains(active) else { return false }
        if let spaceTypeFn, before.contains(where: { spaceTypeFn(cid, $0) == 1 }) { return false }  // 1 = full screen
        let windows = [NSNumber(value: id)] as CFArray
        addToSpacesFn(cid, windows, [NSNumber(value: active)] as CFArray)
        guard spaces(ofWindow: id, connection: cid).contains(active) else { return false }
        removeFromSpacesFn(cid, windows, before.map { NSNumber(value: $0) } as CFArray)
        return true
    }

    // MARK: window capture

    /// `kCGSCaptureIgnoreGlobalClipShape` (0x800): the window's own content, not clipped to what is visible on
    /// screen. The only option the off-screen capture needs; the image comes back at the display's
    /// backing scale (two pixels per point on a Retina display).
    public static let captureIgnoreGlobalClipShape: UInt32 = 0x800

    /// The window server's own image of each window, wherever it is: on another Space, in full screen
    /// elsewhere, minimized — current for an app that keeps drawing there (measured live: a working full-screen
    /// Terminal on another Space changed in every capture), older for one that stops drawing while hidden
    /// (App Nap, some browsers). Stills of a window that is not on screen take it
    /// this way (`SLSHWCaptureWindowListInRect`, options 0x800, the first image); AltTab's thumbnails too.
    /// Needs Screen Recording. Moves, raises and focuses nothing.
    ///
    /// `rect` is in GLOBAL screen points (top-left origin), like a window's frame: pass the frame for the
    /// whole window, or part of it for a region; the image is exactly that rect. nil is the whole window as
    /// the window server clips it, which cuts off any part beyond a display's edge. Without the InRect
    /// symbol, the list call's whole-window image is cropped to `rect` when that image is exactly the
    /// window's frame (`frameOf`), and left out otherwise: an image clipped at a display edge cannot be
    /// mapped onto the window. Empty when a symbol is missing or the window server returns nothing.
    public func captureWithSkyLight(windowIDs: [UInt32], rect: CGRect? = nil,
                                    frameOf: (UInt32) -> CGRect? = { CUWindowLookup.frame(of: $0) }) -> [CGImage] {
        guard let mainConnectionFn, !windowIDs.isEmpty else { return [] }
        let options = Self.captureIgnoreGlobalClipShape
        let cid = mainConnectionFn()
        var ids = windowIDs
        let count = Int32(ids.count)
        if let captureInRectFn {
            let array = ids.withUnsafeMutableBufferPointer { captureInRectFn(cid, $0.baseAddress!, count, options, rect ?? .null) }
            return (array?.takeRetainedValue() as? [CGImage]) ?? []
        }
        guard let captureListFn else { return [] }
        let array = ids.withUnsafeMutableBufferPointer { captureListFn(cid, $0.baseAddress!, count, options) }
        let images = (array?.takeRetainedValue() as? [CGImage]) ?? []
        guard let rect else { return images }
        return zip(windowIDs, images).compactMap { id, image in
            frameOf(id).flatMap { Self.crop(wholeWindow: image, frame: $0, to: rect) }
        }
    }

    /// The part of a whole-window image under `rect` (global points), or nil when the image is not the
    /// window's whole frame at one scale (clipped at a display edge) or `rect` misses the window.
    static func crop(wholeWindow image: CGImage, frame: CGRect, to rect: CGRect) -> CGImage? {
        guard frame.width >= 1, frame.height >= 1 else { return nil }
        let scale = Double(image.width) / frame.width
        guard scale > 0, abs(Double(image.height) - frame.height * scale) <= max(1, scale) else { return nil }
        let local = rect.intersection(frame).offsetBy(dx: -frame.minX, dy: -frame.minY)
        guard !local.isNull, local.width >= 1, local.height >= 1 else { return nil }
        if local.size == frame.size { return image }
        let pixels = CGRect(x: local.minX * scale, y: local.minY * scale, width: local.width * scale,
                            height: local.height * scale).integral
        return image.cropping(to: pixels)
    }

    // MARK: focus enforcement (the SLSDisableUpdate bracket)

    /// Suspends WindowServer drawing on the main connection while a focus change is set up, so a synthetic
    /// activation never shows as a flash or a Space jump. Pair every `disableUpdate()` with `reenableUpdate()`.
    /// Returns the connection to re-enable on, or nil when the symbols are missing (the caller then skips both).
    public func disableUpdate() -> UInt32? {
        guard let mainConnectionFn, let disableUpdateFn else { return nil }
        let cid = mainConnectionFn()
        guard cid != 0 else { return nil }
        _ = disableUpdateFn(cid)
        return cid
    }

    public func reenableUpdate(_ cid: UInt32) {
        _ = reenableUpdateFn?(cid)
    }

    /// The pid that holds the window server's KEY focus now (`CPSGetKeyFocusProcess` → `GetProcessPID`), or nil.
    public func keyFocusPid() -> pid_t? {
        guard let getKeyFocusFn, let processPIDFn else { return nil }
        var psn = [UInt8](repeating: 0, count: 8)
        guard psn.withUnsafeMutableBytes({ getKeyFocusFn($0.baseAddress!) }) == 0 else { return nil }
        var pid: pid_t = 0
        guard psn.withUnsafeBytes({ processPIDFn($0.baseAddress!, &pid) }) == 0, pid > 0 else { return nil }
        return pid
    }

    /// Releases a key-focus theft by its token (a type-21 notification's field 71). False when unavailable.
    @discardableResult
    public func releaseKeyFocus(id: Int32) -> Bool {
        guard let releaseKeyFocusFn else { return false }
        return releaseKeyFocusFn(id) == 0
    }
}
