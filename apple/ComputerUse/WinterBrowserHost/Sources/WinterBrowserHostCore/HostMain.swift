import Darwin
import Foundation

/// The host's process: everything `main.swift` does after reading its test hooks. Chrome talks to it over stdin/stdout
/// (native messaging), so nothing but framed messages may ever go to stdout; every log line goes to stderr, which Chrome
/// keeps in its own log.
public enum HostMain {
    /// Runs the host until Chrome closes its stdin. Returns only on a refusal at startup (exit status 1).
    public static func run(arguments: [String], testHooks: HostTestHooks?) -> Int32 {
        let executable = ParentBrowser.executablePath(pid: getpid()) ?? arguments.first ?? ""
        let identity: HostIdentity
        do {
            identity = try HostIdentity.resolve(executablePath: executable, userHome: userHome(), testHooks: testHooks)
        } catch {
            say("\(error)")
            return 1
        }
        // Chrome names the caller as the first argument. `allowed_origins` already restricts who can start the host; this
        // is the second look, against the host's own list.
        let origin = arguments.dropFirst().first ?? ""
        guard ExtensionIds.originAllowed(origin, allowed: identity.allowedExtensionIds) else {
            say("refused: \(origin.isEmpty ? "no caller" : origin) is not Winter for Chrome")
            return 1
        }
        let browser = ParentBrowser.resolve(pid: getppid())
        let queue = DispatchQueue(label: "winter-browser-host.relay")
        let relay = HostRelay(
            hello: HostRelay.Hello(origin: origin, browserBundleId: browser.bundleId, browserPid: browser.pid,
                                   hostVersion: identity.hostVersion, hostPid: getpid()),
            connector: UnixDaemonConnector(socketPath: identity.socketPath, requirement: identity.daemonRequirement, queue: queue),
            scheduler: QueueScheduler(queue: queue),
            toExtension: { writeOut($0) },
            log: { say($0) }
        )
        say("serving \(identity.profile.rawValue) (\(identity.socketPath)) for \(browser.bundleId.isEmpty ? "an unknown browser" : browser.bundleId)")

        let reader = Thread {
            var decoder = NativeMessageDecoder()
            var buffer = [UInt8](repeating: 0, count: 256 * 1024)
            while true {
                let n = read(STDIN_FILENO, &buffer, buffer.count)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { break }
                for item in decoder.push(Data(buffer[0 ..< n])) {
                    switch item {
                    case .message(let payload): queue.async { relay.fromExtension(payload) }
                    case .oversized(let length): say("refused a \(length)-byte message from the extension (over 16 MiB)")
                    }
                }
            }
            // Chrome closed the port: the host's work is over.
            queue.async { exit(0) }
        }
        reader.name = "winter-browser-host.stdin"
        reader.start()
        queue.async { relay.start() }
        dispatchMain()
    }

    private static func userHome() -> String {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
        return NSHomeDirectory()
    }

    private static func say(_ line: String) {
        FileHandle.standardError.write(Data("winter-browser-host: \(line)\n".utf8))
    }

    /// One framed native message to Chrome, written whole (stdout carries nothing else).
    private static func writeOut(_ frame: Data) {
        frame.withUnsafeBytes { raw in
            guard var p = raw.baseAddress else { return }
            var left = raw.count
            while left > 0 {
                let n = write(STDOUT_FILENO, p, left)
                if n < 0 {
                    if errno == EINTR { continue }
                    exit(0) // Chrome is gone
                }
                left -= n
                p = p.advanced(by: n)
            }
        }
    }
}
