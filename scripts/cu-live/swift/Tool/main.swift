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
case .success(.imageStats(let path)):
    // Pure ImageIO: no window server, no NSApplication.
    switch ImageStats.analyze(path: path) {
    case .success(let report):
        Out.line(report.json)
        exit(0)
    case .failure(let error):
        Out.line("{\"error\":\(JSONOut.quote(error.message))}")
        exit(2)
    }
case .success(.windows(let owner)):
    let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerName as String] as? String) == owner {
        let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        func n(_ k: String) -> Int { (b[k] as? NSNumber)?.intValue ?? 0 }
        Out.line("{\"id\":\((w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0),\"layer\":\((w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0),"
            + "\"onScreen\":\((w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false),\"bounds\":[\(n("X")),\(n("Y")),\(n("Width")),\(n("Height"))]}")
    }
    exit(0)
case .success(.freshDecode(let layoutPath, let files)):
    // Pure ImageIO, like image-stats.
    guard let data = FileManager.default.contents(atPath: layoutPath), let layout = try? JSONDecoder().decode(FreshLayout.self, from: data) else {
        Out.error("cu-live-tool: fresh-decode: cannot read the layout \(layoutPath)")
        exit(2)
    }
    for file in files { Out.line(FreshDecode.decode(path: file, layout: layout)) }
    exit(0)
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
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("dev.cu-live.fixture.command"),
                                                                 object: run, userInfo: info, deliverImmediately: true)
    // The post is an XPC hand-off to distnoted; exiting this instant can drop it. A short run-loop turn flushes it.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
    exit(0)
}
