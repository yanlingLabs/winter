import AppKit
import Foundation

// A closed reader must end us quietly (Out.line handles EPIPE), not kill us with SIGPIPE mid-write.
signal(SIGPIPE, SIG_IGN)

// Parsing and the self-test come first: neither may touch NSApplication.
switch ArgParser.parse(Array(CommandLine.arguments.dropFirst())) {
case .failure(let error):
    Out.error("cu-live-tool: \(error.message)\n\(ArgParser.usage)")
    exit(2)
case .success(.help):
    print(ArgParser.usage)
    exit(0)
case .success(.selfTest):
    exit(runToolSelfTest())
case .success(.front):
    MainActor.assumeIsolated { Monitor.front() }
case .success(.monitor(let intervalMs)):
    MainActor.assumeIsolated { Monitor.run(intervalMs: intervalMs) }
case .success(.post(let run, let role, let cmd, let args, let seq)):
    // Property-list values only (a distributed notification's userInfo is serialised): all Strings. `seq` goes
    // out as the argv String, so the fixture echoes it back as a string.
    var info: [String: String] = ["role": role, "cmd": cmd]
    if let args { info["args"] = args }
    if let seq { info["seq"] = seq }
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.winter.cu-fixture.command"),
                                                                 object: run, userInfo: info, deliverImmediately: true)
    // The post is an XPC hand-off to distnoted; exiting this instant can drop it. A short run-loop turn flushes it.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
    exit(0)
}
