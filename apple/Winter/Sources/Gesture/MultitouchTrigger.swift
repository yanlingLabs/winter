import Foundation
import Darwin
import simd
import AppKit

@MainActor
final class MultitouchTrigger {
    static let shared = MultitouchTrigger()

    private typealias MTDeviceCreateListFn = @convention(c) () -> CFMutableArray?
    private typealias MTDeviceStartFn = @convention(c) (UnsafeMutableRawPointer?, Int32) -> Void
    private typealias MTDeviceStopFn = @convention(c) (UnsafeMutableRawPointer?) -> Void
    private typealias MTRegisterCbFn = @convention(c) (UnsafeMutableRawPointer?, MTContactCallbackFunction?) -> Void
    private typealias MTUnregisterCbFn = @convention(c) (UnsafeMutableRawPointer?, MTContactCallbackFunction?) -> Void

    private var handle: UnsafeMutableRawPointer?
    private var devices: [UnsafeMutableRawPointer] = []
    private var mtCreateList: MTDeviceCreateListFn?
    private var mtStart: MTDeviceStartFn?
    private var mtStop: MTDeviceStopFn?
    private var mtRegister: MTRegisterCbFn?
    private var mtUnregister: MTUnregisterCbFn?
    /// True once the user has called `start()`. Used when re-starting the
    /// frame callback after wake / trackpad reconnect so we only re-arm if
    /// the feature is actually meant to be on.
    private var shouldBeRunning = false
    private var lifecycleObservers: [NSObjectProtocol] = []

    func start() {
        shouldBeRunning = true
        installLifecycleObservers()
        attachToDevices()
    }

    /// Tear down device registrations + frame callbacks, but keep the
    /// `shouldBeRunning` intent flag and the lifecycle observers in place so
    /// we can re-attach on wake / screen-unlock without the caller having to
    /// flip the feature toggle off and back on.
    private func detachFromDevices() {
        for device in devices {
            mtUnregister?(device, Self.contactCallback)
            mtStop?(device)
        }
        devices.removeAll()

        mtCreateList = nil
        mtStart = nil
        mtStop = nil
        mtRegister = nil
        mtUnregister = nil

        if let handle {
            dlclose(handle)
            self.handle = nil
        }

        // NOTE: no recognizer reset here — the MT callback thread is the recognizer's ONLY
        // toucher (a main-thread reset would race the in-flight frame callback). The recognizer
        // self-resets on every all-lift frame; after a detach mid-gesture the next lift clears
        // any stale armed state (worst case: one deliberately-missed tap after wake).
    }

    /// Open the private MultitouchSupport framework and register the frame
    /// callback on every connected multitouch device. Called both at initial
    /// start() and after wake/unlock, because MultitouchSupport silently
    /// stops delivering frames when the Mac sleeps or a USB trackpad
    /// disconnects and reconnects.
    private func attachToDevices() {
        guard handle == nil else { return }

        let path = "/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport"
        guard let openedHandle = dlopen(path, RTLD_NOW) else {
            let message = dlerror().map { String(cString: $0) } ?? "unknown error"
            NSLog("[MultitouchTrigger] dlopen failed: \(message)")
            return
        }

        func sym<T>(_ name: String) -> T? {
            guard let symbol = dlsym(openedHandle, name) else { return nil }
            return unsafeBitCast(symbol, to: T.self)
        }

        guard
            let createList: MTDeviceCreateListFn = sym("MTDeviceCreateList"),
            let startFn: MTDeviceStartFn = sym("MTDeviceStart"),
            let stopFn: MTDeviceStopFn = sym("MTDeviceStop"),
            let registerFn: MTRegisterCbFn = sym("MTRegisterContactFrameCallback"),
            let unregisterFn: MTUnregisterCbFn = sym("MTUnregisterContactFrameCallback"),
            let list = createList()
        else {
            NSLog("[MultitouchTrigger] symbol resolution failed")
            dlclose(openedHandle)
            return
        }

        handle = openedHandle
        mtCreateList = createList
        mtStart = startFn
        mtStop = stopFn
        mtRegister = registerFn
        mtUnregister = unregisterFn

        let count = CFArrayGetCount(list)
        for index in 0..<count {
            let pointer = CFArrayGetValueAtIndex(list, index)
            guard let device = UnsafeMutableRawPointer(mutating: pointer) else { continue }
            registerFn(device, Self.contactCallback)
            startFn(device, 0)
            devices.append(device)
        }
    }

    func stop() {
        shouldBeRunning = false
        removeLifecycleObservers()
        detachFromDevices()
    }

    // MARK: - Wake / reconnect handling

    /// Subscribe to wake, screen-unlock, and session-active notifications so
    /// we can rebuild the MultitouchSupport registration. Without this, the
    /// four-finger tap "randomly stops working" — what actually happens is
    /// the private framework stops delivering frames across sleep / lock /
    /// trackpad reconnect and needs to be re-armed.
    private func installLifecycleObservers() {
        guard lifecycleObservers.isEmpty else { return }

        let workspace = NSWorkspace.shared.notificationCenter
        let sink: (Notification) -> Void = { [weak self] _ in
            Task { @MainActor in
                self?.reattachIfNeeded()
            }
        }

        lifecycleObservers = [
            workspace.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil, queue: .main, using: sink
            ),
            workspace.addObserver(
                forName: NSWorkspace.screensDidWakeNotification,
                object: nil, queue: .main, using: sink
            ),
            workspace.addObserver(
                forName: NSWorkspace.sessionDidBecomeActiveNotification,
                object: nil, queue: .main, using: sink
            )
        ]
    }

    private func removeLifecycleObservers() {
        let workspace = NSWorkspace.shared.notificationCenter
        for token in lifecycleObservers {
            workspace.removeObserver(token)
        }
        lifecycleObservers.removeAll()
    }

    private func reattachIfNeeded() {
        guard shouldBeRunning else { return }
        detachFromDevices()
        attachToDevices()
    }

    nonisolated(unsafe) private static var recognizer = TapRecognizer()

    nonisolated(unsafe) private static let contactCallback: MTContactCallbackFunction = { _, touches, nFingers, timestamp, _ in
        guard let touches else { return 0 }
        var active: [TouchSample] = []
        for index in 0..<Int(nFingers) {
            let touch = touches[index]
            guard touch.state == 4 || touch.state == 5 else { continue }
            let id = Int(touch.identifier != 0 ? touch.identifier : touch.fingerID)
            active.append(TouchSample(id: id, pos: SIMD2<Float>(touch.normalized.pos.x, touch.normalized.pos.y)))
        }
        if recognizer.ingest(active: active, at: CFAbsoluteTimeGetCurrent()) {
            DispatchQueue.main.async { TriggerHub.shared.fire(from: "multitouch") }
        }
        return 0
    }
}
