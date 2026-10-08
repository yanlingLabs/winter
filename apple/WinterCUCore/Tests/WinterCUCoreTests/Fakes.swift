import ApplicationServices
import CoreGraphics
import Foundation
@testable import WinterCUCore

/// A fake element: `AXUIElementCreateApplication(token)` is a local token (no IPC, no permission), unique per
/// token and CFEqual to itself — exactly what the identity cache keys on.
func fakeElement(_ token: Int32) -> AXUIElement { AXUIElementCreateApplication(token) }

/// An in-memory AX tree for driving `targetAct`'s gates.
final class FakeAX: CUAXBackend {
    var trusted = true
    private var attrs: [AXIdentity: [String: CFTypeRef]] = [:]
    private var actionNames: [AXIdentity: [String]] = [:]
    private var settable: Set<String> = []
    var dead = Set<AXIdentity>()
    var windowIDs: [AXIdentity: CGWindowID] = [:]
    /// Every perform, as "token:action".
    private(set) var performed: [String] = []
    /// Every write, as "token:attribute".
    private(set) var written: [String] = []
    /// Thrown by the next perform / write when set.
    var performError: CUError?
    var setError: CUError?

    private func token(_ e: AXUIElement) -> Int32 {
        var pid: pid_t = 0
        AXUIElementGetPid(e, &pid)
        return pid
    }

    func put(_ e: AXUIElement, _ values: [String: Any]) {
        var d = attrs[AXIdentity(element: e)] ?? [:]
        for (k, v) in values { d[k] = Self.cf(v) }
        attrs[AXIdentity(element: e)] = d
    }

    func setActions(_ e: AXUIElement, _ names: [String]) { actionNames[AXIdentity(element: e)] = names }
    func makeSettable(_ e: AXUIElement, _ attribute: String) { settable.insert("\(token(e)):\(attribute)") }

    /// An element with a role, a frame and optional extras.
    func add(_ e: AXUIElement, role: String, subrole: String? = nil, title: String? = nil, frame: CGRect? = nil,
             extra: [String: Any] = [:]) {
        var v: [String: Any] = [kAXRoleAttribute: role]
        if let subrole { v[kAXSubroleAttribute] = subrole }
        if let title { v[kAXTitleAttribute] = title }
        if let f = frame {
            var o = f.origin, s = f.size
            v[kAXPositionAttribute] = AXValueCreate(.cgPoint, &o)!
            v[kAXSizeAttribute] = AXValueCreate(.cgSize, &s)!
        }
        for (k, x) in extra { v[k] = x }
        put(e, v)
    }

    func focus(pid: pid_t, on e: AXUIElement?) {
        let app = application(pid)
        if let e { put(app, [kAXFocusedUIElementAttribute: e]) } else {
            attrs[AXIdentity(element: app)]?[kAXFocusedUIElementAttribute] = nil
        }
    }

    static func cf(_ v: Any) -> CFTypeRef {
        switch v {
        case let s as String: return s as CFString
        case let b as Bool: return (b ? kCFBooleanTrue : kCFBooleanFalse)!
        case let n as Int: return NSNumber(value: n)
        case let n as Double: return NSNumber(value: n)
        case let a as [AXUIElement]: return a as CFArray
        default: return v as CFTypeRef
        }
    }

    // MARK: CUAXBackend

    func isTrusted() -> Bool { trusted }
    func application(_ pid: pid_t) -> AXUIElement { fakeElement(pid) }
    func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? { attrs[AXIdentity(element: e)]?[name] }
    func copyMultiple(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef]? {
        let d = attrs[AXIdentity(element: e)] ?? [:]
        var out: [String: CFTypeRef] = [:]
        for n in names { if let v = d[n] { out[n] = v } }
        return out
    }
    func actions(_ e: AXUIElement) -> [String] { actionNames[AXIdentity(element: e)] ?? [] }
    func isSettable(_ e: AXUIElement, _ name: String) -> Bool { settable.contains("\(token(e)):\(name)") }
    /// "token:attribute" writes the app accepts and ignores (the value stays what it was).
    var ignoresWrites: Set<String> = []
    func set(_ e: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
        written.append("\(token(e)):\(name)")
        if let err = setError { throw err }
        if ignoresWrites.contains("\(token(e)):\(name)") { return }
        attrs[AXIdentity(element: e), default: [:]][name] = value
    }
    /// "token:action" pairs the app refuses as unsupported (an AX error, like Finder's AXOpen).
    var refuses: Set<String> = []
    /// Runs after each perform that went through ("token:action"), to change the fake world.
    var onPerform: ((String) -> Void)?
    func perform(_ e: AXUIElement, _ action: String) throws {
        performed.append("\(token(e)):\(action)")
        defer { if performError == nil, !refuses.contains("\(token(e)):\(action)") { onPerform?("\(token(e)):\(action)") } }
        if let err = performError { throw err }
        if refuses.contains("\(token(e)):\(action)") {
            throw CUError(code: "unsupported", message: "\(action) is not supported by this element",
                          data: ["axError": .int(Int(AXError.actionUnsupported.rawValue))])
        }
    }
    func isAlive(_ e: AXUIElement) -> Bool { !dead.contains(AXIdentity(element: e)) }
    func windowID(_ e: AXUIElement) -> CGWindowID? { windowIDs[AXIdentity(element: e)] }
    /// Windows reachable only by remote token (another Space, full screen), by window id.
    var remoteWindows: [CGWindowID: AXUIElement] = [:]
    private(set) var remoteAsked: [CGWindowID] = []
    /// One remote-token walk per call, for all the ids asked.
    private(set) var remoteWalks = 0
    func remoteWindows(pid: pid_t, windowIDs: [CGWindowID]) -> [CGWindowID: AXUIElement] {
        remoteWalks += 1
        remoteAsked += windowIDs
        return remoteWindows.filter { windowIDs.contains($0.key) }
    }
}

/// The process and window-server world for the same tests.
final class FakeSystem: CUSystemBackend {
    var running: Set<pid_t> = []
    var bundles: [pid_t: String] = [:]
    var names: [pid_t: String] = [:]
    var windows: [UInt32: CUWindowServerWindow] = [:]
    /// Front to back.
    var stack: [CUWindowServerWindow] = []
    var front: pid_t?
    private(set) var activated: [pid_t] = []
    var cursor: CGPoint? = CGPoint(x: 5, y: 5)
    private(set) var warpedTo: [CGPoint] = []

    func appRunning(_ pid: pid_t) -> Bool { running.contains(pid) }
    func bundleId(pid: pid_t) -> String? { bundles[pid] }
    func processName(pid: pid_t) -> String? { names[pid] }
    func window(id: UInt32) -> CUWindowServerWindow? { windows[id] }
    func windows(pid: pid_t) -> [CUWindowServerWindow] {
        windows.values.filter { $0.pid == pid && $0.layer == 0 }.sorted { $0.id < $1.id }
    }
    /// Whether a SkyLight move "works"; on success the window comes on screen and `onMove` runs.
    var moveSucceeds = false
    var onMove: ((UInt32) -> Void)?
    private(set) var moved: [UInt32] = []
    func moveWindowToActiveSpace(_ id: UInt32) -> Bool {
        moved.append(id)
        guard moveSucceeds else { return false }
        windows[id]?.onScreen = true
        onMove?(id)
        return true
    }
    func windowStack() -> [CUWindowServerWindow] { stack }
    func frontmostPid() -> pid_t? { front }
    func activate(pid: pid_t) -> Bool { activated.append(pid); front = pid; return true }
    var stageManager = false
    func stageManagerEnabled() -> Bool { stageManager }
    func cursorLocation() -> CGPoint? { cursor }
    func warpCursor(to p: CGPoint) { warpedTo.append(p) }

    static func window(_ id: UInt32, pid: pid_t, _ frame: CGRect, owner: String = "App", layer: Int = 0) -> CUWindowServerWindow {
        CUWindowServerWindow(id: id, pid: pid, ownerName: owner, title: "", frame: frame, layer: layer, onScreen: true, alpha: 1)
    }
}

/// Records every posted event; `onPost` lets a test change the fake world as input arrives.
final class RecordingPoster: CUEventPoster, @unchecked Sendable {
    struct Entry {
        var type: CGEventType
        var route: CURoute
        var location: CGPoint
        var keycode: Int64
        var unicode: String
        var flags: CGEventFlags
        var window: Int64
        var window2: Int64 = 0
        var subtype: Int64 = 0
    }
    private let lock = NSLock()
    private(set) var entries: [Entry] = []
    var onPost: ((Entry) -> Void)?

    func post(_ event: CGEvent, pid: pid_t, route: CURoute, authenticate: Bool) -> CURoute {
        var length = 0
        var chars = [UniChar](repeating: 0, count: 8)
        event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &chars)
        let e = Entry(type: event.type, route: route, location: event.location,
                      keycode: event.getIntegerValueField(.keyboardEventKeycode),
                      unicode: String(utf16CodeUnits: chars, count: length), flags: event.flags,
                      window: event.getIntegerValueField(.mouseEventWindowUnderMousePointer),
                      window2: event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent),
                      subtype: event.getIntegerValueField(.mouseEventSubtype))
        lock.withLock { entries.append(e) }
        onPost?(e)
        return route == .skyLight ? .publicPid : route
    }

    var keyDowns: [Entry] { lock.withLock { entries.filter { $0.type == .keyDown } } }
}
