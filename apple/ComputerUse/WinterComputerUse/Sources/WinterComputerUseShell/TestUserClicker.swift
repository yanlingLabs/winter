import AppKit
import ApplicationServices
import WinterCUCore

/// TEST-ONLY (`test.userClick`, a live-test instance's route — see `RPCDispatcher.init`'s `liveTest`): the live suite's
/// "user" clicks a named element of an app with a REAL click — posted at the HID level, so it reaches every session tap
/// as the user's would, moving the pointer there and back — stamped `CUWatchTestStamp`. A live-test instance's watches
/// (and only theirs: `CUWatcher.countsTestInput`) count that stamp as the user's own input; nothing else counts it. The
/// suite's runner has no Accessibility grant of its own, and must never ask for one.
@MainActor
public enum TestUserClicker {
    /// The most elements searched for the name.
    static let maxNodes = 3_000

    public static func click(_ p: TestUserClickParams) -> TestUserClickResult {
        guard let point = center(of: p.name, pid: p.pid) else { return TestUserClickResult(clicked: false) }
        let back = CGEvent(source: nil)?.location
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
                return TestUserClickResult(clicked: false)
            }
            e.setIntegerValueField(.eventSourceUserData, value: CUWatchTestStamp.value)
            e.post(tap: .cghidEventTap)
            usleep(30_000)
        }
        if let back { CGWarpMouseCursorPosition(back) }
        return TestUserClickResult(clicked: true)
    }

    /// The centre (screen points) of the first element of the app's windows whose title or description is `name`.
    static func center(of name: String, pid: Int32) -> CGPoint? {
        var queue: [AXUIElement] = []
        var windows: CFTypeRef?
        if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &windows) == .success,
           let list = windows as? [AXUIElement] { queue = list }
        var next = 0
        while next < queue.count, next < maxNodes {
            let e = queue[next]
            next += 1
            if string(e, kAXTitleAttribute) == name || string(e, kAXDescriptionAttribute) == name, let f = frame(e), f.width > 0, f.height > 0 {
                return CGPoint(x: f.midX, y: f.midY)
            }
            var kids: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids) == .success, let k = kids as? [AXUIElement] {
                queue.append(contentsOf: k)
            }
        }
        return nil
    }

    private static func string(_ e: AXUIElement, _ name: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success else { return nil }
        return v as? String
    }

    private static func frame(_ e: AXUIElement) -> CGRect? {
        var p: CFTypeRef?
        var s: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &s) == .success,
              let pv = p, let sv = s else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &point), AXValueGetValue(sv as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
}
