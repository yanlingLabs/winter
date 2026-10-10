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
    private var terminationSource: DispatchSourceSignal?
    private var log = HelperLog(subsystem: Bundle.main.bundleIdentifier ?? "com.winter.computeruse")

    public init(testHooks: HelperTestHooks?) {
        self.testHooks = testHooks
        super.init()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // A daemon that drops its connection mid-write must not take the helper down with SIGPIPE.
        signal(SIGPIPE, SIG_IGN)
        // SIGTERM (a logout, `kill`) quits the way the idle timer does, so the socket file goes with it.
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { MainActor.assumeIsolated { NSApp.terminate(nil) } }
        term.resume()
        terminationSource = term
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
        log.info("Winter Computer Use \(version) (\(identity.profile.rawValue)) serving \(identity.home) [\(identity.homeSource)]\(identity.liveTest ? " — a live-test instance: it accepts only the live suite's test daemon and probe" : "")")

        let authenticator: CodeSigningPeerAuthenticator
        do {
            authenticator = try CodeSigningPeerAuthenticator(requirements: [.daemon: identity.daemonRequirement, .app: identity.appRequirement])
        } catch {
            fail("cannot start: \(error)")
        }

        let (presentation, escapeTap) = WinterCUPresentationFactory.make()
        let viewHub = ViewHub(capture: LiveFrameCaptureFactory(), geometry: LiveWindowGeometry(), snapshotter: LiveWindowSnapshotter(),
                              clock: LiveViewClock())
        let coordinator = HelperCoordinator(presentation: presentation, escapeTap: escapeTap, viewHub: viewHub)
        let core = CUCore(events: coordinator)
        // Esc closes the open desktop visit at once (the user returned), before the daemon hears it.
        coordinator.onEscape = { [weak core] in Task { await core?.closeAllVisits() } }
        let inFlight = InFlightRegistry()
        let dispatcher = RPCDispatcher(core: core, coordinator: coordinator, viewHub: viewHub, inFlight: inFlight, liveTest: identity.liveTest,
                                       capturer: identity.liveTest ? TestCapture(home: identity.home) : nil)
        let server = HelperServer(
            configuration: .init(socketPath: identity.socketPath, home: identity.home, helperVersion: version),
            authenticator: authenticator, dispatcher: dispatcher, coordinator: coordinator, inFlight: inFlight, log: log)
        coordinator.notify = { [weak server] notification in server?.broadcast(notification) }
        viewHub.sendEvent = { [weak server] connection, line in server?.sendEvent(to: connection, line) }
        viewHub.sendFrame = { [weak server] connection, key, line in server?.sendFrame(to: connection, key: key, line) }
        viewHub.log = { [log] in log.notice($0) } // persisted: the view lifecycle is what a live gate needs to read back

        do {
            try server.start()
        } catch {
            fail("cannot listen: \(error)")
        }
        let idle = IdleQuitTimer(interval: identity.idleQuitSeconds, scheduler: MainQueueIdleScheduler()) { [weak self, weak coordinator] in
            // A request outside any script (`status`, `apps.list`) still in flight: not now.
            guard inFlight.isEmpty else {
                coordinator?.restartIdleCountdown()
                return
            }
            self?.log.info("idle for \(Int(identity.idleQuitSeconds)) s with no bound target and no running script — quitting")
            NSApp.terminate(nil) // closes every connection; the daemon relaunches the helper on its next call
        }
        coordinator.attach(idleTimer: idle)

        self.server = server
        self.coordinator = coordinator
        self.core = core
        self.idleTimer = idle
    }

    /// LaunchServices re-opening the running helper (the daemon's `open -g`) is a cue to make sure the socket
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
