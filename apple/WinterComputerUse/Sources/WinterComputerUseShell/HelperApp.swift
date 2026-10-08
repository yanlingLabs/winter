import AppKit
import Foundation
import WinterCUCore
import WinterCUPresentation

/// The helper app's delegate: derives its identity, builds the engine, the presentation layer and the server,
/// and quits after the idle period. `App/main.swift` creates it; nothing else does.
@MainActor public final class HelperAppDelegate: NSObject, NSApplicationDelegate {
    private let testHooks: HelperTestHooks?
    private var server: HelperServer?
    private var coordinator: HelperCoordinator?
    private var core: CUCore?
    private var idleTimer: IdleQuitTimer?
    private var log = HelperLog(subsystem: Bundle.main.bundleIdentifier ?? "com.winter.computeruse")

    public init(testHooks: HelperTestHooks?) {
        self.testHooks = testHooks
        super.init()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // A daemon that drops its connection mid-write must not take the helper down with SIGPIPE.
        signal(SIGPIPE, SIG_IGN)
        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let identity: HelperIdentity
        do {
            identity = try HelperIdentity.resolve(
                bundleIdentifier: bundle.bundleIdentifier,
                bundlePath: bundle.bundlePath,
                environment: ProcessInfo.processInfo.environment,
                userHome: NSHomeDirectory(),
                helperVersion: version,
                testHooks: testHooks
            )
        } catch {
            fail("cannot start: \(error)")
        }
        log.info("Winter Computer Use \(version) (\(identity.profile.rawValue)) serving \(identity.home) [\(identity.homeSource)]")

        let authenticator: CodeSigningPeerAuthenticator
        do {
            authenticator = try CodeSigningPeerAuthenticator(requirement: identity.daemonRequirement)
        } catch {
            fail("cannot start: \(error)")
        }

        let permissions = LivePermissionSystem()
        let (presentation, escapeTap) = WinterCUPresentationFactory.make()
        let coordinator = HelperCoordinator(presentation: presentation, escapeTap: escapeTap, permissions: permissions)
        let core = CUCore(events: coordinator)
        let inFlight = InFlightRegistry()
        let dispatcher = RPCDispatcher(core: core, coordinator: coordinator, permissions: permissions,
                                       helperVersion: version, inFlight: inFlight)
        let server = HelperServer(
            configuration: .init(socketPath: identity.socketPath, home: identity.home, helperVersion: version),
            authenticator: authenticator, dispatcher: dispatcher, coordinator: coordinator, inFlight: inFlight, log: log)
        coordinator.notify = { [weak server] notification in server?.broadcast(notification) }

        do {
            try server.start()
        } catch {
            fail("cannot listen: \(error)")
        }
        let idle = IdleQuitTimer(interval: identity.idleQuitSeconds, scheduler: MainQueueIdleScheduler()) { [weak self] in
            self?.log.info("idle for \(Int(identity.idleQuitSeconds)) s with no connection and no bound target — quitting")
            NSApp.terminate(nil)
        }
        coordinator.attach(idleTimer: idle)

        self.server = server
        self.coordinator = coordinator
        self.core = core
        self.idleTimer = idle
    }

    /// LaunchServices re-opening the running helper (the daemon's `open -g -j`) is a cue to make sure the socket
    /// is still there.
    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        server?.ensureListening()
        return false
    }

    public func applicationWillTerminate(_ notification: Notification) {
        server?.stop()
    }

    private func fail(_ message: String) -> Never {
        log.error(message)
        exit(78) // EX_CONFIG
    }
}
