import CoreGraphics
import Foundation

// The user's REAL input, for the idle gate, the countdown's postpone and the mid-run abort: a listen-only SESSION
// event tap that counts only hardware-origin events — `eventSourceUnixProcessID == 0` — of the pointer, button,
// scroll and key types. Never HIDIdleTime or CGEventSourceSecondsSinceLastEventType: Unity apps (VRoid Studio)
// tickle the HID system every few seconds (`pmset -g assertions`: UserIsActive … iohideventsystem.queue.tickle),
// resetting both while no event reaches the session; and synthetic events from any process (the helper's,
// keep-awake apps') carry their poster's pid. Keys are watched only when this process already may listen to them
// (CGPreflightListenEventAccess — never a request, a test must never raise a TCC prompt); else the pointer,
// buttons and scrolls alone count, and the monitor says so (`hwKeys:false`).

enum HardwareInput {
    static let pointerTypes: [CGEventType] = [
        .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
        .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
    ]
    static let keyTypes: [CGEventType] = [.keyDown, .keyUp, .flagsChanged]

    /// Pure: whether an event is the user's hardware input — a watched type, and posted by no process.
    static func counts(type: CGEventType, sourcePid: Int64, keys: Bool) -> Bool {
        guard sourcePid == 0 else { return false }
        return pointerTypes.contains(type) || (keys && keyTypes.contains(type))
    }

    static func mask(keys: Bool) -> CGEventMask {
        (pointerTypes + (keys ? keyTypes : [])).reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    }

    // State, touched on the main run loop only (the tap's source is added there).
    private(set) static var tapping = false
    private(set) static var keys = false
    private(set) static var startedMs = 0
    private(set) static var count = 0
    private(set) static var lastMs: Int?
    private static var tap: CFMachPort?

    /// Starts the tap on the main run loop. False when the window server refused it (the monitor then reports no
    /// hardware fields, and the rig cannot tell input from none).
    @discardableResult
    static func start() -> Bool {
        keys = CGPreflightListenEventAccess()
        let callback: CGEventTapCallBack = { _, type, event, _ in
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap = HardwareInput.tap { CGEvent.tapEnable(tap: tap, enable: true) }
            } else if HardwareInput.counts(type: type, sourcePid: event.getIntegerValueField(.eventSourceUnixProcessID), keys: HardwareInput.keys) {
                HardwareInput.count += 1
                HardwareInput.lastMs = Sampling.nowMs()
            }
            return Unmanaged.passUnretained(event)
        }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                           eventsOfInterest: mask(keys: keys), callback: callback, userInfo: nil) else {
            return false
        }
        tap = port
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        startedMs = Sampling.nowMs()
        tapping = true
        return true
    }
}
