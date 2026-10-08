import ApplicationServices
import CoreGraphics
import Foundation

/// An `AXUIElement` as a dictionary key: equality is `CFEqual`, hashing `CFHash` — the identity the ref
/// cache keys on (spine §4: refs are stable for the same element across snapshots).
struct AXIdentity: Hashable, @unchecked Sendable {
    let element: AXUIElement

    static func == (a: AXIdentity, b: AXIdentity) -> Bool { CFEqual(a.element, b.element) }
    func hash(into h: inout Hasher) { h.combine(CFHash(element)) }
}

/// Thin, typed wrappers over the AX C API. Every call is synchronous IPC to the target app, bounded by the
/// process-wide messaging timeout `CUCore` sets at startup; callers run them on the target's pid queue.
enum AX {
    static let messagingTimeout: Float = 1.0

    /// Applies the 1 s messaging timeout to every AX call this process makes.
    static func configureProcessTimeout() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), messagingTimeout)
    }

    static func app(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

    static func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(e, name as CFString, &v)
        return err == .success ? v : nil
    }

    static func string(_ e: AXUIElement, _ name: String) -> String? {
        guard let v = attribute(e, name) else { return nil }
        return stringValue(v)
    }

    static func bool(_ e: AXUIElement, _ name: String) -> Bool? {
        guard let v = attribute(e, name) else { return nil }
        return boolValue(v)
    }

    static func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
        guard let v = attribute(e, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func elements(_ e: AXUIElement, _ name: String) -> [AXUIElement] {
        guard let v = attribute(e, name), CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
        return (v as! [AnyObject]).compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
        }
    }

    static func count(_ e: AXUIElement, _ name: String) -> Int? {
        var n: CFIndex = 0
        return AXUIElementGetAttributeValueCount(e, name as CFString, &n) == .success ? n : nil
    }

    static func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = attribute(e, kAXPositionAttribute), let s = attribute(e, kAXSizeAttribute) else { return nil }
        guard let pt = pointValue(p), let sz = sizeValue(s) else { return nil }
        return CGRect(origin: pt, size: sz)
    }

    /// One round trip for many attributes. Missing or failing attributes are simply absent.
    static func copyMultiple(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef]? {
        var values: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(e, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        guard err == .success, let arr = values as [AnyObject]?, arr.count == names.count else {
            if err == .invalidUIElement || err == .cannotComplete || err == .apiDisabled { return nil }
            return [:]
        }
        var out: [String: CFTypeRef] = [:]
        for (i, v) in arr.enumerated() {
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
            if v is NSNull { continue }
            out[names[i]] = v
        }
        return out
    }

    static func actions(_ e: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(e, &names) == .success, let arr = names as? [String] else { return [] }
        return arr
    }

    static func isSettable(_ e: AXUIElement, _ name: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, name as CFString, &settable) == .success && settable.boolValue
    }

    static func set(_ e: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
        try check(AXUIElementSetAttributeValue(e, name as CFString, value), "set \(name)")
    }

    static func perform(_ e: AXUIElement, _ action: String) throws {
        try check(AXUIElementPerformAction(e, action as CFString), action)
    }

    static func pid(_ e: AXUIElement) -> pid_t? {
        var p: pid_t = 0
        return AXUIElementGetPid(e, &p) == .success ? p : nil
    }

    /// Alive = it still answers for its role.
    static func isAlive(_ e: AXUIElement) -> Bool {
        var v: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &v)
        return err != .invalidUIElement
    }

    // MARK: window ids

    private typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    /// `_AXUIElementGetWindow` (HIServices SPI, read-only). Resolved by `dlsym`; nil → frame matching.
    private static let getWindow: GetWindowFn? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(sym, to: GetWindowFn.self)
    }()

    static func windowID(_ window: AXUIElement) -> CGWindowID? {
        guard let f = getWindow else { return nil }
        var id: CGWindowID = 0
        return f(window, &id) == .success && id != 0 ? id : nil
    }

    // MARK: value conversion

    static func stringValue(_ v: CFTypeRef) -> String? {
        let t = CFGetTypeID(v)
        if t == CFStringGetTypeID() { return (v as! String) }
        if t == CFAttributedStringGetTypeID() { return (v as! NSAttributedString).string }
        if t == CFNumberGetTypeID() {
            let n = v as! NSNumber
            if n.doubleValue.rounded() == n.doubleValue, abs(n.doubleValue) < 1e15 { return String(n.int64Value) }
            return String(n.doubleValue)
        }
        if t == CFBooleanGetTypeID() { return (v as! Bool) ? "1" : "0" }
        if t == CFURLGetTypeID() { return (v as! URL).absoluteString }
        return nil
    }

    static func boolValue(_ v: CFTypeRef) -> Bool? {
        let t = CFGetTypeID(v)
        if t == CFBooleanGetTypeID() { return (v as! Bool) }
        if t == CFNumberGetTypeID() { return (v as! NSNumber).boolValue }
        return nil
    }

    static func pointValue(_ v: CFTypeRef) -> CGPoint? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func sizeValue(_ v: CFTypeRef) -> CGSize? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    static func rangeValue(_ v: CFTypeRef) -> CFRange? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r : nil
    }

    static func makeRange(location: Int, length: Int) -> AXValue? {
        var r = CFRange(location: location, length: length)
        return AXValueCreate(.cfRange, &r)
    }

    // MARK: errors

    static func check(_ err: AXError, _ what: String) throws {
        switch err {
        case .success: return
        case .apiDisabled: throw CUError.permissionMissing(.accessibility)
        case .invalidUIElement: throw CUError(code: "stale_element", message: "\(what): the element is gone")
        case .cannotComplete:
            throw CUError(code: "busy", message: "\(what): the app did not answer in time — retry",
                          data: ["retryable": .bool(true)])
        case .attributeUnsupported, .actionUnsupported, .notImplemented, .parameterizedAttributeUnsupported:
            throw CUError.unsupported("\(what) is not supported by this element")
        case .illegalArgument: throw CUError.invalidParams("\(what): illegal argument")
        default: throw CUError.unsupported("\(what) failed (AXError \(err.rawValue))")
        }
    }
}
