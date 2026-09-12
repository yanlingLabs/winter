import AppKit
import IOKit

/// Haptics via private trackpad actuator (MTActuator*) from MultitouchSupport.framework.
/// Ported from v1 Winter/Gesture/TrackpadHorizontalSwipe.swift (lines 318-524).
/// On macOS, NSHapticFeedbackManager is suppressed outside drag contexts;
/// this actuator provides consistent haptic feedback by directly interfacing
/// with the trackpad hardware, falling back to NSHapticFeedbackManager if unavailable.

enum TrackpadSwipeHaptics {
    static func performAcceptedSwipe() {
        if TrackpadActuatorHaptics.shared.performAcceptedSwipe() {
            return
        }

        perform(.alignment, performanceTime: .now)
    }

    static func perform(
        _ pattern: NSHapticFeedbackManager.FeedbackPattern = .alignment,
        performanceTime: NSHapticFeedbackManager.PerformanceTime = .now
    ) {
        if Thread.isMainThread {
            NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: performanceTime)
        } else {
            DispatchQueue.main.async {
                NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: performanceTime)
            }
        }
    }
}

private final class TrackpadActuatorHaptics {
    static let shared = TrackpadActuatorHaptics()

    private typealias MTActuatorCreateFromDeviceIDFn = @convention(c) (UInt64) -> Unmanaged<CFTypeRef>?
    private typealias MTActuatorOpenFn = @convention(c) (CFTypeRef) -> IOReturn
    private typealias MTActuatorCloseFn = @convention(c) (CFTypeRef) -> IOReturn
    private typealias MTActuatorActuateFn = @convention(c) (CFTypeRef, Int32, UInt32, Float32, Float32) -> IOReturn
    private typealias MTActuatorIsOpenFn = @convention(c) (CFTypeRef) -> Bool

    private let lock = NSLock()
    private var handle: UnsafeMutableRawPointer?
    private var actuator: CFTypeRef?
    private var createFromDeviceID: MTActuatorCreateFromDeviceIDFn?
    private var open: MTActuatorOpenFn?
    private var close: MTActuatorCloseFn?
    private var actuate: MTActuatorActuateFn?
    private var isOpen: MTActuatorIsOpenFn?
    private var didLogFailure = false
    private var didLogSuccess = false

    func performAcceptedSwipe() -> Bool {
        performActuation(id: 3)
    }

    private func performActuation(id actuationID: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard ensureReady(),
              let actuator,
              let actuate else {
            return false
        }

        let result = actuate(actuator, actuationID, 0, 0, 0)
        if result != kIOReturnSuccess {
            logFailure("MTActuatorActuate failed: 0x\(String(result, radix: 16))")
            return false
        }
        logSuccessIfNeeded()
        return true
    }

    private func ensureReady() -> Bool {
        if let actuator,
           isOpen?(actuator) == true {
            return true
        }

        guard loadSymbols(),
              let deviceID = Self.findActuatorDeviceID(),
              let createFromDeviceID,
              let open else {
            return false
        }

        guard let nextActuator = createFromDeviceID(deviceID)?.takeRetainedValue() else {
            logFailure("MTActuatorCreateFromDeviceID failed for 0x\(String(deviceID, radix: 16))")
            return false
        }

        let result = open(nextActuator)
        guard result == kIOReturnSuccess else {
            logFailure("MTActuatorOpen failed: 0x\(String(result, radix: 16))")
            return false
        }

        actuator = nextActuator
        return true
    }

    private func loadSymbols() -> Bool {
        if handle != nil {
            return createFromDeviceID != nil && open != nil && actuate != nil
        }

        let path = "/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport"
        guard let openedHandle = dlopen(path, RTLD_NOW | RTLD_LOCAL) else {
            let message = dlerror().map { String(cString: $0) } ?? "unknown error"
            logFailure("dlopen failed: \(message)")
            return false
        }

        func sym<T>(_ name: String) -> T? {
            guard let symbol = dlsym(openedHandle, name) else { return nil }
            return unsafeBitCast(symbol, to: T.self)
        }

        guard
            let create: MTActuatorCreateFromDeviceIDFn = sym("MTActuatorCreateFromDeviceID"),
            let openFn: MTActuatorOpenFn = sym("MTActuatorOpen"),
            let closeFn: MTActuatorCloseFn = sym("MTActuatorClose"),
            let actuateFn: MTActuatorActuateFn = sym("MTActuatorActuate")
        else {
            dlclose(openedHandle)
            logFailure("MTActuator symbol resolution failed")
            return false
        }

        handle = openedHandle
        createFromDeviceID = create
        open = openFn
        close = closeFn
        actuate = actuateFn
        isOpen = sym("MTActuatorIsOpen")
        return true
    }

    private static func findActuatorDeviceID() -> UInt64? {
        let matching = IOServiceMatching("AppleMultitouchDevice")
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS else {
            return nil
        }
        defer { IOObjectRelease(iterator) }

        var fallbackID: UInt64?
        while true {
            let service = IOIteratorNext(iterator)
            guard service != 0 else { break }
            defer { IOObjectRelease(service) }

            guard let multitouchID = Self.uint64Property("Multitouch ID", service: service) else {
                continue
            }

            if Self.boolProperty("ActuationSupported", service: service) == true ||
                Self.boolProperty("ForceSupported", service: service) == true {
                return multitouchID
            }

            fallbackID = fallbackID ?? multitouchID
        }

        return fallbackID
    }

    private static func uint64Property(_ key: String, service: io_service_t) -> UInt64? {
        guard let property = IORegistryEntryCreateCFProperty(
            service,
            key as CFString,
            kCFAllocatorDefault,
            0
        )?.takeRetainedValue() else {
            return nil
        }

        if let number = property as? NSNumber {
            return number.uint64Value
        }
        return nil
    }

    private static func boolProperty(_ key: String, service: io_service_t) -> Bool? {
        guard let property = IORegistryEntryCreateCFProperty(
            service,
            key as CFString,
            kCFAllocatorDefault,
            0
        )?.takeRetainedValue() else {
            return nil
        }

        if let bool = property as? Bool {
            return bool
        }
        if let number = property as? NSNumber {
            return number.boolValue
        }
        return nil
    }

    private func logFailure(_ message: String) {
        guard !didLogFailure else { return }
        didLogFailure = true
        NSLog("[TrackpadActuatorHaptics] \(message); falling back to NSHapticFeedbackManager")
    }

    private func logSuccessIfNeeded() {
        guard !didLogSuccess else { return }
        didLogSuccess = true
        NSLog("[TrackpadActuatorHaptics] using MultitouchSupport actuator haptics")
    }
}
