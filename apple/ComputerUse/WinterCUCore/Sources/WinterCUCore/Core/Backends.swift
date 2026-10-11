import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The AX calls the action path, the floors and the menu walk make. Injectable, so every safety gate in
/// `targetAct` can be driven by a fake element tree in tests; the live one forwards to `AX`.
protocol CUAXBackend: AnyObject {
    func isTrusted() -> Bool
    func application(_ pid: pid_t) -> AXUIElement
    func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef?
    func copyMultiple(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef]?
    func actions(_ e: AXUIElement) -> [String]
    func isSettable(_ e: AXUIElement, _ name: String) -> Bool
    func set(_ e: AXUIElement, _ name: String, _ value: CFTypeRef) throws
    func perform(_ e: AXUIElement, _ action: String) throws
    func isAlive(_ e: AXUIElement) -> Bool
    func windowID(_ e: AXUIElement) -> CGWindowID?
    /// The AX elements of windows `kAXWindowsAttribute` omits (another Space, full screen), by window id, in
    /// one remote-token walk that may stop at the first it finds; private.
    func remoteWindows(pid: pid_t, windowIDs: [CGWindowID]) -> [CGWindowID: AXUIElement]
}

extension CUAXBackend {
    func string(_ e: AXUIElement, _ name: String) -> String? { attribute(e, name).flatMap(AX.stringValue) }
    func bool(_ e: AXUIElement, _ name: String) -> Bool? { attribute(e, name).flatMap(AX.boolValue) }

    func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
        guard let v = attribute(e, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    func elements(_ e: AXUIElement, _ name: String) -> [AXUIElement] {
        guard let v = attribute(e, name), CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
        return (v as! [AnyObject]).compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    }

    func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = attribute(e, kAXPositionAttribute).flatMap(AX.pointValue),
              let s = attribute(e, kAXSizeAttribute).flatMap(AX.sizeValue) else { return nil }
        return CGRect(origin: p, size: s)
    }

    func focusedElement(pid: pid_t) -> AXUIElement? {
        element(application(pid), kAXFocusedUIElementAttribute)
    }
}

final class CULiveAX: CUAXBackend {
    func isTrusted() -> Bool { AXIsProcessTrusted() }
    func application(_ pid: pid_t) -> AXUIElement { AX.app(pid) }
    func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? { AX.attribute(e, name) }
    func copyMultiple(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef]? { AX.copyMultiple(e, names) }
    func actions(_ e: AXUIElement) -> [String] { AX.actions(e) }
    func isSettable(_ e: AXUIElement, _ name: String) -> Bool { AX.isSettable(e, name) }
    func set(_ e: AXUIElement, _ name: String, _ value: CFTypeRef) throws { try AX.set(e, name, value) }
    func perform(_ e: AXUIElement, _ action: String) throws { try AX.perform(e, action) }
    func isAlive(_ e: AXUIElement) -> Bool { AX.isAlive(e) }
    func windowID(_ e: AXUIElement) -> CGWindowID? { AX.windowID(e) }
    func remoteWindows(pid: pid_t, windowIDs: [CGWindowID]) -> [CGWindowID: AXUIElement] {
        AX.windowsByRemoteToken(pid: pid, wanted: Set(windowIDs), stopAtFirst: true).found
    }
}

/// Process and window-server facts (and the few global effects of rung 4), injectable for tests.
protocol CUSystemBackend: AnyObject {
    func appRunning(_ pid: pid_t) -> Bool
    func bundleId(pid: pid_t) -> String?
    func processName(pid: pid_t) -> String?
    func window(id: UInt32) -> CUWindowServerWindow?
    /// The pid's normal (layer 0) windows, on screen or not, front to back.
    func windows(pid: pid_t) -> [CUWindowServerWindow]
    /// On-screen windows of every layer, front to back.
    func windowStack() -> [CUWindowServerWindow]
    /// Moves a window to the active Space (SkyLight, private); true only when verified.
    func moveWindowToActiveSpace(_ id: UInt32) -> Bool
    /// The app the user is in: the window server's front process (NSWorkspace's answer when that can't be read).
    func frontmostPid() -> pid_t?
    /// The desktop the user is looking at (the active Space), when it can be read.
    func activeSpace() -> UInt64?
    /// Activates an app. Only the consented foreground rung and the restores of the user's own app call it.
    func activate(pid: pid_t) -> Bool
    /// Brings `pid`'s window forward the way macOS follows to its desktop (measured on macOS 26.6, 2026-10-10): the
    /// window's element raised — made its app's main window first when `makeMain` — then the app made frontmost over
    /// accessibility (`AXFrontmost`). With no element, the app alone: macOS then goes to a desktop with its windows
    /// only when it has none on the user's. (Bringing a window forward by its id — `_SLPSSetFrontProcessWithOptions`
    /// with the key-window records — never switched desktops there, and the records reach the window as a mouse
    /// down and up.) Only a desktop visit — there and back — calls it. `windowID` names the window for the log.
    func bringForward(pid: pid_t, windowID: UInt32, window: AXUIElement?, makeMain: Bool) -> Bool
    /// Whether macOS follows an app coming forward to a desktop with its windows (System Settings › Desktop & Dock ›
    /// "When switching to an application, switch to a Space with open windows for the application": `com.apple.dock`
    /// `workspaces-auto-swoosh`, absent = on). Nil when it can't be read.
    func spacesFollowActivation() -> Bool?
    /// `pid` is a content process serving part of `appPid`'s UI — Safari's WebContent, an XPC service — not a
    /// regular app of its own (nor this helper): key events for what it shows go to it.
    func isContentProcess(_ pid: pid_t, of appPid: pid_t) -> Bool
    /// Stage Manager is on (windows of other stage sets sit off stage on this Space).
    func stageManagerEnabled() -> Bool
    /// Whether the window is on any Space (false for a closed window the server still lists); nil = unknown.
    func windowOnAnySpace(_ id: UInt32) -> Bool?
    /// The Spaces a window is on; nil = unknown.
    func windowSpaces(_ id: UInt32) -> Set<UInt64>?
    /// Each display's current Space, by display identifier; nil = unknown.
    func displaySpaces() -> [String: UInt64]?
    func cursorLocation() -> CGPoint?
    func warpCursor(to: CGPoint)
    /// How long ago `pid`'s process started (seconds); nil when it can't be read. Read only while the agent has a
    /// launch pending (an app started after it is the agent's).
    func processAge(pid: pid_t) -> TimeInterval?
    /// Whether `pid` is a regular app (one with a Dock icon, whose windows a click activates) — not an agent, a
    /// background app or a system UI server (Notification Center, the menu extras, Picture in Picture). Nil = unknown.
    func isRegularApp(_ pid: pid_t) -> Bool?
    /// The running app with this bundle id (Finder, for a click on the empty desktop), if any.
    func runningPid(bundleId: String) -> pid_t?
    /// The running app whose Dock tile is under `point` (the Dock, `dockPid`, read over accessibility: the tile's
    /// `AXURL` is the app's bundle), if any — so a Dock click is input for THAT app.
    func dockItemApp(at point: CGPoint, dockPid: pid_t) -> pid_t?
}

extension CUSystemBackend {
    func processAge(pid: pid_t) -> TimeInterval? { nil }
    func isRegularApp(_ pid: pid_t) -> Bool? { nil }
    func runningPid(bundleId: String) -> pid_t? { nil }
    func dockItemApp(at point: CGPoint, dockPid: pid_t) -> pid_t? { nil }
}

final class CULiveSystem: CUSystemBackend {
    func dockItemApp(at point: CGPoint, dockPid: pid_t) -> pid_t? {
        let dock = AXUIElementCreateApplication(dockPid)
        AXUIElementSetMessagingTimeout(dock, 0.1)  // the session tap's thread: never held up by a busy Dock
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(dock, Float(point.x), Float(point.y), &hit) == .success, let item = hit else { return nil }
        AXUIElementSetMessagingTimeout(item, 0.1)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(item, "AXURL" as CFString, &raw) == .success, let v = raw else { return nil }
        let url: URL? = CFGetTypeID(v) == CFURLGetTypeID() ? (v as! URL) : (v as? String).flatMap(URL.init(string:))
        guard let bundle = url?.standardizedFileURL.resolvingSymlinksInPath() else { return nil }
        return NSWorkspace.shared.runningApplications.first {
            !$0.isTerminated && $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == bundle
        }?.processIdentifier
    }

    func isRegularApp(_ pid: pid_t) -> Bool? {
        NSRunningApplication(processIdentifier: pid).map { $0.activationPolicy == .regular }
    }
    func runningPid(bundleId: String) -> pid_t? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first { !$0.isTerminated }?.processIdentifier
    }
    func processAge(pid: pid_t) -> TimeInterval? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let start = info.kp_proc.p_starttime
        let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
        return max(0, Date().timeIntervalSince1970 - started)
    }
    func appRunning(_ pid: pid_t) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
        return !app.isTerminated
    }
    func bundleId(pid: pid_t) -> String? { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier }
    func processName(pid: pid_t) -> String? {
        let app = NSRunningApplication(processIdentifier: pid)
        return app?.executableURL?.lastPathComponent ?? app?.localizedName
    }
    func window(id: UInt32) -> CUWindowServerWindow? { CUWindowServer.window(id: id) }
    func windows(pid: pid_t) -> [CUWindowServerWindow] {
        // Every Space, on screen or not; desktop elements are not excluded here (they belong to Finder anyway,
        // and the flag must not cost an app its windows elsewhere).
        CUWindowServer.windows(excludeDesktop: false).filter { $0.pid == pid && $0.frame.width > 1 && $0.frame.height > 1 }
    }
    func windowStack() -> [CUWindowServerWindow] { CUWindowServer.windows(onScreenOnly: true, includeOtherLayers: true) }
    func moveWindowToActiveSpace(_ id: UInt32) -> Bool { CUSkyLight.system.moveWindowToActiveSpace(windowID: id) }
    func windowOnAnySpace(_ id: UInt32) -> Bool? { CUSkyLight.system.isOnAnySpace(windowID: id) }
    func windowSpaces(_ id: UInt32) -> Set<UInt64>? { CUSkyLight.system.spacesOf(windowID: id) }
    func displaySpaces() -> [String: UInt64]? { CUSkyLight.system.currentSpacesByDisplay() }
    func frontmostPid() -> pid_t? {
        // The window server's front process changes the moment an app activates; NSWorkspace hears of it later,
        // on the main run loop — too late for the check right after an act.
        CUSkyLight.system.frontProcessPid() ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
    func activeSpace() -> UInt64? { CUSkyLight.system.activeSpace() }
    func activate(pid: pid_t) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
        return DispatchQueue.main.sync { app.activate() }
    }
    func bringForward(pid: pid_t, windowID: UInt32, window: AXUIElement?, makeMain: Bool) -> Bool {
        if let window {
            if makeMain { try? AX.set(window, kAXMainAttribute, kCFBooleanTrue) }
            try? AX.perform(window, kAXRaiseAction)
        }
        return (try? AX.set(AX.app(pid), kAXFrontmostAttribute, kCFBooleanTrue)) != nil
    }
    func spacesFollowActivation() -> Bool? {
        guard let v = CFPreferencesCopyAppValue("workspaces-auto-swoosh" as CFString, "com.apple.dock" as CFString) else { return true }
        return (v as? NSNumber)?.boolValue
    }
    func stageManagerEnabled() -> Bool {
        UserDefaults(suiteName: "com.apple.WindowManager")?.bool(forKey: "GloballyEnabled") ?? false
    }
    func isContentProcess(_ pid: pid_t, of appPid: pid_t) -> Bool {
        guard pid > 0, appPid > 0, pid != appPid, pid != getpid(), kill(pid, 0) == 0 || errno == EPERM else { return false }
        // A TRUE part of the app only (review of round 11, HIGH #2: any non-regular process passed — Spotlight, a
        // launcher, the emoji picker, a status item — so typing into their panel was work in the front app): the app is
        // responsible for it (Safari's WebContent, an XPC service launchd started — measured), it is the app's child
        // (Chrome's renderer helpers — measured: their responsible process can be whatever launched Chrome), or its
        // executable lies inside the app's bundle.
        return CUProcessFacts.isPart(pid, of: appPid, responsible: CUProcessFacts.responsiblePid(pid),
                                     parent: CUProcessFacts.parentPid(pid), executable: CUProcessFacts.executablePath(pid),
                                     appBundle: NSRunningApplication(processIdentifier: appPid)?.bundleURL?.resolvingSymlinksInPath().path)
    }
    func cursorLocation() -> CGPoint? { CGEvent(source: nil)?.location }
    func warpCursor(to p: CGPoint) {
        CGWarpMouseCursorPosition(p)
        CGAssociateMouseAndMouseCursorPosition(1)
    }
}

/// The rung-4 hit test (spec §8): before every foreground press, drag step and release, the window under
/// the point must belong to the target. The helper's own windows (mirror, cursor overlay) are click-through
/// and skipped; invisible and zero-size windows are skipped. Pure.
enum CUHitTest {
    struct Covered: Error, Equatable {
        var pid: pid_t
        var owner: String
    }

    /// The front-most window that would receive a click at `point`.
    static func topWindow(at point: CGPoint, stack: [CUWindowServerWindow], ownPid: pid_t) -> CUWindowServerWindow? {
        stack.first { w in
            w.pid != ownPid && w.alpha > 0 && w.frame.width > 0 && w.frame.height > 0 && w.frame.contains(point)
        }
    }

    /// Throws the refusal for a point the target does not own.
    static func check(point: CGPoint, targetPid: pid_t, appName: String, stack: [CUWindowServerWindow], ownPid: pid_t,
                      bundleId: (pid_t) -> String?, processName: (pid_t) -> String?) throws {
        guard let top = topWindow(at: point, stack: stack, ownPid: ownPid) else {
            throw CUError.unsupported("nothing of \(appName) is on screen at that point")
        }
        guard top.pid != targetPid else { return }
        let b = bundleId(top.pid)
        if CUFloors.isAuthOrSystemDialog(bundleId: b, processName: processName(top.pid) ?? top.ownerName) {
            throw CUError.refused(.authDialog, "a system dialog covers that point — ask the user to handle it")
        }
        if let b, CUFloors.isWinterBundle(b) {
            throw CUError.refused(.winterItself, "a Winter window covers that point")
        }
        let owner = top.ownerName.isEmpty ? "another window" : "“\(top.ownerName)”"
        throw CUError.unsupported("\(owner) covers that point in front of \(appName) — use a ref or ask the user to move it")
    }
}


/// Process facts the content-process check reads.
enum CUProcessFacts {
    /// `pid` is a true part of `appPid`: the app is responsible for it, it is the app's child, or its executable lies
    /// inside the app's bundle. Pure — the live check and the tests' fake both decide by it.
    static func isPart(_ pid: pid_t, of appPid: pid_t, responsible: pid_t?, parent: pid_t?, executable: String?,
                       appBundle: String?) -> Bool {
        guard pid > 0, appPid > 0, pid != appPid else { return false }
        if responsible == appPid || parent == appPid { return true }
        guard let exe = executable, let bundle = appBundle, !bundle.isEmpty else { return false }
        return exe.hasPrefix(bundle.hasSuffix("/") ? bundle : bundle + "/")
    }

    private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
    /// libsystem's `responsibility_get_pid_responsible_for_pid` (private; looked up, never linked): nil when absent.
    private static let responsible: ResponsibleFn? = {
        guard let h = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
        return unsafeBitCast(h, to: ResponsibleFn.self)
    }()

    static func responsiblePid(_ pid: pid_t) -> pid_t? {
        guard let f = responsible else { return nil }
        let r = f(pid)
        return r > 0 ? r : nil
    }

    static func parentPid(_ pid: pid_t) -> pid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let ppid = info.kp_eproc.e_ppid
        return ppid > 1 ? ppid : nil
    }

    static func executablePath(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
        return URL(fileURLWithPath: String(cString: buf)).resolvingSymlinksInPath().path
    }
}
