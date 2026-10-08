import Foundation
import os

/// The helper's log: unified logging (`log stream --predicate 'subsystem BEGINSWITH "com.winter.computeruse"'`)
/// plus a stderr echo for a binary run by hand. Lines name methods, ids, pids and error codes — never request
/// content (typed text, screen text, images).
public struct HelperLog: Sendable {
    private let logger: Logger
    private let echo: Bool
    private let enabled: Bool

    public init(subsystem: String, echoToStderr: Bool = true) {
        self.init(subsystem: subsystem.isEmpty ? "com.winter.computeruse" : subsystem, echoToStderr: echoToStderr, enabled: true)
    }

    private init(subsystem: String, echoToStderr: Bool, enabled: Bool) {
        logger = Logger(subsystem: subsystem, category: "helper")
        echo = echoToStderr
        self.enabled = enabled
    }

    /// Discards everything (tests).
    public static let silent = HelperLog(subsystem: "com.winter.computeruse.tests", echoToStderr: false, enabled: false)

    public func info(_ message: String) {
        guard enabled else { return }
        logger.info("\(message, privacy: .public)")
        if echo { FileHandle.standardError.write(Data("[computer-use] \(message)\n".utf8)) }
    }

    public func error(_ message: String) {
        guard enabled else { return }
        logger.error("\(message, privacy: .public)")
        if echo { FileHandle.standardError.write(Data("[computer-use] error: \(message)\n".utf8)) }
    }
}
