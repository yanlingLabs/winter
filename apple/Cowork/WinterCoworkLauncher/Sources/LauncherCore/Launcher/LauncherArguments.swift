import Foundation

/// What the daemon tells the launcher at spawn. Closed: an unknown argument is a refusal, not an ignored option.
///
///   winter-cowork-launcher --worker-path <absolute path> --receipt-dir <absolute directory>
///
/// There is no home argument (the home identity arrives in `begin`, its ONE source) and no profile argument (which daemon the
/// launcher serves comes from the launcher's own code signature, `LauncherProfile.ofRunningProcess`).
///
/// The test-build pin (a parent or a worker identified by code directory hash) is parsed ONLY when the compiler was given
/// `-DWINTER_COWORK_TEST_BUILD`; in every other build those argument names do not exist in the binary at all (the embed script and a
/// test look for the marker), so nothing at run time can switch the production requirement off.
public struct LauncherArguments: Equatable, Sendable {
    public var workerPath: String
    public var receiptDirectory: String
    #if WINTER_COWORK_TEST_BUILD
    public var testParentCDHash: String?
    public var testWorkerCDHash: String?
    #endif

    public struct Refusal: Error, Equatable, CustomStringConvertible, Sendable {
        public let reason: String
        public var description: String { reason }
    }

    public static func parse(_ arguments: [String]) throws -> LauncherArguments {
        var workerPath: String?, receiptDirectory: String?
        #if WINTER_COWORK_TEST_BUILD
        var parentHash: String?, workerHash: String?
        #endif
        var index = 0
        func value() throws -> String {
            index += 1
            guard index < arguments.count else { throw Refusal(reason: "\(arguments[index - 1]) needs a value") }
            return arguments[index]
        }
        while index < arguments.count {
            let name = arguments[index]
            switch name {
            case "--worker-path": workerPath = try value()
            case "--receipt-dir": receiptDirectory = try value()
            #if WINTER_COWORK_TEST_BUILD
            case "--WINTER_COWORK_TEST_PARENT_CDHASH": parentHash = try value()
            case "--WINTER_COWORK_TEST_WORKER_CDHASH": workerHash = try value()
            #endif
            default: throw Refusal(reason: "unknown argument")
            }
            index += 1
        }
        guard let workerPath, workerPath.hasPrefix("/"), !workerPath.contains("\0") else { throw Refusal(reason: "--worker-path must be absolute") }
        guard let receiptDirectory, receiptDirectory.hasPrefix("/"), !receiptDirectory.contains("\0") else { throw Refusal(reason: "--receipt-dir must be absolute") }
        #if WINTER_COWORK_TEST_BUILD
        for hash in [parentHash, workerHash].compactMap({ $0 }) where !V.isLowerHex(hash, count: 40) { throw Refusal(reason: "a test cdhash is 40 lowercase hex digits") }
        return LauncherArguments(workerPath: workerPath, receiptDirectory: receiptDirectory, testParentCDHash: parentHash, testWorkerCDHash: workerHash)
        #else
        return LauncherArguments(workerPath: workerPath, receiptDirectory: receiptDirectory)
        #endif
    }
}
