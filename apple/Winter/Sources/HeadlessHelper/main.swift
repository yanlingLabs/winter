import AppKit
import Foundation

// ComputerV2 Phase 4 — **Winter Headless**: Winter's private, invisible browser for the agent's background reading.
//
// A background-only app (`LSBackgroundOnly`): no Dock tile, no menu bar, no window — only windowless CEF browsers,
// one in-memory request context per Winter session. The daemon spawns it directly (never through LaunchServices)
// with a pipe on fds 3 and 4 and drives it with the browser-link op set (`HeadlessWire`); it exits when the pipe
// closes. See `HeadlessHost` for what a headless tab is.

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("WinterHeadless: \(message)\n".utf8))
    exit(code)
}

private func log(_ message: String) {
    FileHandle.standardError.write(Data("WinterHeadless: \(message)\n".utf8))
}

let processStartedAt = Date()

// The pipe, before anything can spawn a child: close-on-exec, so no GPU or renderer process inherits either end and a
// daemon that dies still takes this process with it (the EOF on fd 3).
signal(SIGPIPE, SIG_IGN)
for fd: Int32 in [3, 4] {
    let flags = fcntl(fd, F_GETFD)
    guard flags != -1 else { fail("started without its pipe (fds 3 and 4) — only Winter starts this", code: 2) }
    _ = fcntl(fd, F_SETFD, flags | FD_CLOEXEC)
}

guard let arguments = HeadlessArguments.parse(CommandLine.arguments) else {
    fail("started without --winter-cache-root=<absolute directory>", code: 2)
}
guard let layout = HeadlessLayout.resolve(bundleURL: Bundle.main.bundleURL) else {
    fail("Winter's Chromium is not where this helper expects it — reinstall Winter", code: 3)
}
do {
    try FileManager.default.createDirectory(atPath: arguments.cacheRoot, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
} catch {
    fail("could not create its cache directory", code: 3)
}

// The app, before CEF: it must be the CefAppProtocol subclass, it never activates, and no window it holds can ever be
// ordered in. App Nap stays off while the helper runs (its pump runs on timers a nap would stretch to seconds); the
// helper exits after a few idle minutes anyway, and idle system sleep is unaffected.
_ = WinterHeadlessApplication.shared
NSApp.setActivationPolicy(.prohibited)
WinterHeadlessApplication.installWindowGuard()
let napActivity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep],
                                                        reason: "Winter's headless browser is working")

// Chromium's argv, kept alive for the process's life.
let chromiumArguments = arguments.chromiumArguments(program: CommandLine.arguments.first ?? "Winter Headless")
let chromiumArgv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?> = {
    let argv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: chromiumArguments.count + 1)
    for (i, argument) in chromiumArguments.enumerated() { argv[i] = strdup(argument) }
    argv[chromiumArguments.count] = nil
    return argv
}()

guard WinterCEFInitializeHeadless(Int32(chromiumArguments.count), chromiumArgv, layout.frameworkDir,
                                  layout.mainBundle, layout.subprocessPath, arguments.cacheRoot) else {
    fail("CEF did not start: \(String(cString: WinterCEFLastError()))", code: 4)
}

MainActor.assumeIsolated { HeadlessMain.start() }

NSApp.run()

/// Everything after CEF is up, on the main actor (where CEF's UI thread is).
@MainActor
enum HeadlessMain {
    static let host = HeadlessHost(driver: .production)
    static let link = HeadlessLink(readFD: 3, writeFD: 4, log: { log($0) })
    private static var shuttingDown = false
    private static var termSource: DispatchSourceSignal?

    static func start() {
        host.output = link
        link.onClosed = { reason in shutdown(reason) }
        link.onCommand = { inbound in handle(inbound) }

        // SIGTERM is a stop like the pipe closing.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { shutdown("SIGTERM") } }
        source.resume()
        termSource = source

        link.start()
        // Hello once CEF's global context is up (the daemon sends nothing before it).
        DispatchQueue.main.async { MainActor.assumeIsolated { announceWhenReady() } }
    }

    private static func handle(_ inbound: HeadlessWire.Inbound) {
        switch inbound {
        case .ignored(let reason):
            log("ignored \(reason)")
        case .unreadable(let linkId, let cmdId, let reason):
            log("unreadable command — \(reason)")
            if let cmdId, linkId == link.linkId {
                link.reply(cmdId: cmdId, .failure(code: .notAllowed, message: reason))
            }
        case .contextDispose(let linkId, let cmdId, let sessionId):
            guard linkId == link.linkId else { return }
            let closed = host.disposeContext(sessionId: sessionId)
            link.reply(cmdId: cmdId, .ok(.object(["closed": .number(Double(closed))])))
        case .command(let command):
            guard command.linkId == link.linkId else { return }
            guard WinterCEFHeadlessReady() else {
                link.reply(cmdId: command.cmdId, .failure(code: .notLive, message: "Winter's headless browser is starting"))
                return
            }
            let cmdId = command.cmdId
            let link = link
            host.handle(command, reply: HeadlessReplier { link.reply(cmdId: cmdId, $0) })
        }
    }

    private static func announceWhenReady() {
        if WinterCEFHeadlessReady() {
            log("ready in \(Int(Date().timeIntervalSince(processStartedAt) * 1000)) ms")
            link.hello()
            return
        }
        if Date().timeIntervalSince(processStartedAt) > 30 {
            fail("CEF's context did not come up within 30 s", code: 5)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { MainActor.assumeIsolated { announceWhenReady() } }
    }

    static func shutdown(_ reason: String) {
        guard !shuttingDown else { return }
        shuttingDown = true
        log("exiting: \(reason)")
        // Bounded: a CEF that will not finish closing must not keep the helper alive past the daemon's grace.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2.5) { _exit(0) }
        host.closeEverything()
        WinterCEFHeadlessDisposeAllContexts()
        WinterCEFShutdown()
        ProcessInfo.processInfo.endActivity(napActivity)
        exit(0)
    }
}
