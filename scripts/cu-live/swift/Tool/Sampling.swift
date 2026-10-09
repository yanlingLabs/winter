import AppKit
import Darwin
import IOKit

// What cu-live-tool reads. Every source here needs NO TCC grant: NSWorkspace, the window server's Space query
// (private SkyLight, resolved at run time), IOKit's HID idle time.

enum Sampling {
    static func nowMs() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }

    /// A reading now. `app` overrides the frontmost application — used on an activation notification, where
    /// `frontmostApplication` can lag the notification by a tick but the notification itself names the new app.
    @MainActor
    static func sample(front app: NSRunningApplication? = nil) -> Sample {
        let running = app ?? NSWorkspace.shared.frontmostApplication
        return Sample(t: nowMs(),
                      front: running?.bundleIdentifier,
                      frontPid: running.map { Int($0.processIdentifier) },
                      space: activeSpace(),
                      hidIdleMs: hidIdleMs(),
                      mouse: pointer())
    }

    /// The real pointer's location (CGEvent with no source reads the current one; no TCC grant).
    static func pointer() -> (x: Int, y: Int)? {
        guard let p = CGEvent(source: nil)?.location else { return nil }
        return (Int(p.x.rounded()), Int(p.y.rounded()))
    }

    // MARK: Active Space

    private typealias ConnectionFn = @convention(c) () -> Int32
    private typealias ActiveSpaceFn = @convention(c) (Int32) -> UInt64

    /// SkyLight's names first (what the window server's own clients use), CoreGraphics' older CGS names as the
    /// fallback. nil when neither resolves — the rig then simply has no Space signal.
    private static let spaceQuery: (() -> Int?)? = {
        let skylight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        let pairs = [("SLSMainConnectionID", "SLSGetActiveSpace"), ("CGSMainConnectionID", "CGSGetActiveSpace")]
        for (connectionName, spaceName) in pairs {
            let handle = skylight ?? UnsafeMutableRawPointer(bitPattern: -2) // RTLD_DEFAULT
            guard let connectionSymbol = dlsym(handle, connectionName), let spaceSymbol = dlsym(handle, spaceName) else { continue }
            let connection = unsafeBitCast(connectionSymbol, to: ConnectionFn.self)
            let activeSpace = unsafeBitCast(spaceSymbol, to: ActiveSpaceFn.self)
            return {
                let id = activeSpace(connection())
                return id == 0 ? nil : Int(truncatingIfNeeded: id)
            }
        }
        return nil
    }()

    static func activeSpace() -> Int? { spaceQuery?() }

    // MARK: HID idle

    /// Milliseconds since the last keyboard/mouse input anywhere (IORegistry IOHIDSystem `HIDIdleTime`, in ns).
    static func hidIdleMs() -> Int? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        guard let property = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() else {
            return nil
        }
        if let number = property as? NSNumber { return Int(number.uint64Value / 1_000_000) }
        if let data = property as? Data, data.count >= 8 {
            let nanoseconds = data.prefix(8).enumerated().reduce(UInt64(0)) { $0 | (UInt64($1.element) << (8 * UInt64($1.offset))) }
            return Int(nanoseconds / 1_000_000)
        }
        return nil
    }
}

// MARK: - stdout

enum Out {
    /// One write(2) per line: stdout to a pipe is fully buffered under stdio, and a rig reading `monitor` must see
    /// each line the moment it exists. A closed reader (EPIPE) ends the process quietly instead of crashing.
    static func line(_ text: String) {
        var bytes = Array((text + "\n").utf8)
        var offset = 0
        while offset < bytes.count {
            let n = bytes.withUnsafeMutableBufferPointer { write(STDOUT_FILENO, $0.baseAddress! + offset, $0.count - offset) }
            if n < 0 {
                if errno == EINTR { continue }
                exit(0)
            }
            offset += n
        }
    }

    static func error(_ text: String) {
        FileHandle.standardError.write(Data((text + "\n").utf8))
    }
}
