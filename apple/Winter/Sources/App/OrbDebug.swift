import Foundation

/// stdout diagnostics, enabled by WINTER_ORB_DEBUG=1 (launch the binary directly to see them).
enum OrbDebug {
    static let enabled = ProcessInfo.processInfo.environment["WINTER_ORB_DEBUG"] == "1"
    static func log(_ msg: @autoclosure () -> String) {
        guard enabled else { return }
        FileHandle.standardOutput.write(Data("[orb-debug] \(msg())\n".utf8))
    }
}
