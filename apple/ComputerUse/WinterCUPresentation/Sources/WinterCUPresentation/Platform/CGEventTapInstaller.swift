import CoreGraphics
import Foundation

/// Installs an active, session-level CGEventTap for key-down/key-up on the main run loop. Creating an active keyboard
/// tap needs the Accessibility grant; without it `CGEvent.tapCreate` returns nil and so does `install`.
@MainActor struct CGEventTapInstaller: EscapeTapInstaller {
    func install(handler: @escaping @MainActor (EscapeKeyEvent) -> Bool) -> EscapeTapHandle? {
        let box = TapBox(handler: handler)
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue) | CGEventMask(1 << CGEventType.keyUp.rawValue)
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: escapeTapCallback,
            userInfo: Unmanaged.passUnretained(box).toOpaque()
        ) else { return nil }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            CFMachPortInvalidate(port)
            return nil
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: false)
        box.port = port
        return CGEventTapHandle(box: box, source: source)
    }
}

/// Owns the tap's port and run-loop source; the box it hands the C callback lives as long as this handle.
@MainActor final class CGEventTapHandle: EscapeTapHandle {
    private let box: TapBox
    private let source: CFRunLoopSource

    init(box: TapBox, source: CFRunLoopSource) {
        self.box = box
        self.source = source
    }

    func setEnabled(_ on: Bool) {
        box.enabled = on
        if let port = box.port { CGEvent.tapEnable(tap: port, enable: on) }
    }

    deinit {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        if let port = box.port { CFMachPortInvalidate(port) }
    }
}

/// The C callback's context. Touched only on the main thread (the tap's source is on the main run loop).
final class TapBox {
    let handler: @MainActor (EscapeKeyEvent) -> Bool
    var port: CFMachPort?
    var enabled = false

    init(handler: @escaping @MainActor (EscapeKeyEvent) -> Bool) {
        self.handler = handler
    }
}

private func escapeTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
                               refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let box = Unmanaged<TapBox>.fromOpaque(refcon).takeUnretainedValue()
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        // The system turns a slow or interrupted tap off; turn it back on if we still want it.
        if box.enabled, let port = box.port { CGEvent.tapEnable(tap: port, enable: true) }
        return Unmanaged.passUnretained(event)
    case .keyDown, .keyUp:
        let flags = event.flags
        let key = EscapeKeyEvent(
            isKeyDown: type == .keyDown,
            keyCode: event.getIntegerValueField(.keyboardEventKeycode),
            isAutorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
            hasModifiers: flags.contains(.maskCommand) || flags.contains(.maskControl)
                || flags.contains(.maskAlternate) || flags.contains(.maskShift),
            sourcePID: pid_t(truncatingIfNeeded: event.getIntegerValueField(.eventSourceUnixProcessID))
        )
        // Not Escape: hand it straight back without touching any state.
        guard key.keyCode == EscapeKeyEvent.escapeKeyCode else { return Unmanaged.passUnretained(event) }
        let swallow = MainActor.assumeIsolated { box.handler(key) }
        return swallow ? nil : Unmanaged.passUnretained(event)
    default:
        return Unmanaged.passUnretained(event)
    }
}
