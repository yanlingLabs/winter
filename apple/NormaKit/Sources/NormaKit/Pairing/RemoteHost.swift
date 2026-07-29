import Foundation
import IrohLib
import NormaProtocol
import NormaSessionKit
import os

/// Errors `RemoteHost` itself can throw — distinct from whatever `IrohListener.start`/
/// `MacIdentity.loadOrCreate`/`KeychainToken.readRemoteToken` throw (those propagate unchanged).
public enum RemoteHostError: Error, Equatable {
    /// `openPairingWindow` couldn't establish a running `PairingManager` — defensive: `startIfNeeded`
    /// unconditionally starts once a pairing window is requested, so this should be unreachable in
    /// practice (kept as a clear failure mode rather than a force-unwrap).
    case notRunning
}

/// The composition root the app (menu-bar UI, first-pair flow) drives: owns this Mac's persisted
/// paired-device allowlist (`PairingStore`), starts/stops the whole remote stack — `IrohListener` ->
/// `PairingRouter` (the real allowlist gate, PairingRouter.swift) -> `Gateway` (the daemon bridge,
/// Gateway.swift) — on demand, and exposes the pairing ceremony (`PairingManager`) for a QR sheet to
/// drive. `@MainActor` (mirrors this codebase's own `DaemonSupervisor` convention, apple/Norma/
/// Sources/App/DaemonSupervisor.swift): a UI-facing controller, single-threaded by construction, so
/// `pairingManager`/`macEndpointID` can stay plain synchronous-read properties instead of needing
/// `async` getters.
///
/// **Lifecycle policy:** the whole stack is torn down (not merely idle) whenever there's nothing
/// for it to do — zero paired devices AND no pairing window requested — since an always-on iroh
/// listener/gateway is needless attack surface and battery/network cost for a Mac nobody has ever
/// paired a phone with. `startIfNeeded`/`stopIfIdle` are the ONLY two places that decide this; every
/// other method just changes state and lets the caller (or itself, where noted) re-evaluate.
@MainActor
public final class RemoteHost {
    public struct Config {
        /// Where `PairingStore` persists its allowlist file. Defaults to `~/.norma/remote/
        /// paired-devices.json`'s parent — never `~/.norma` itself (CLAUDE.md's own read-denylist
        /// precedent for that directory).
        public var storeDir: URL
        /// The daemon's own unix socket — `NormaClient`'s `UnixSocketTransport` target.
        public var socketPath: String
        /// Shown to the phone during pairing (`PairAccepted`/QR display) — e.g. "My Mac".
        public var hostLabel: String
        /// The signed relay list handed to a pairing phone inside its QR payload.
        public var relayConfig: SignedRelayConfig
        /// Relay URLs `IrohListener.start` itself connects through (extracted from `relayConfig`
        /// by the caller — `RemoteHost` doesn't re-derive one from the other, since a verified
        /// `SignedRelayConfig`'s `config.relays` and "what this Mac's OWN listener should dial
        /// through" are allowed to differ, e.g. staging vs. production relay fleets).
        public var relayURLs: [String]
        /// Reachability probe `start()` uses (CN-T1) to decide whether ANY custom relay in
        /// `relayURLs` is actually alive before pinning the listener to the whole fleet — see
        /// `start()`'s own "Relay selection" comment for the full three-regime precedence.
        /// Defaulted to `defaultRelayProbe` so every construction site that predates this field
        /// (production, every existing test) compiles and behaves unchanged. Tests inject a
        /// scripted closure instead, so selection/fallback behavior is provable without the
        /// probe ever touching a real network.
        public var relayProbe: @Sendable (String) async -> Bool
        /// Keychain service `start()` reads its `remote-token` from (`KeychainToken.
        /// readRemoteToken(service:)`) — must match the TARGET daemon's `profile.ts`
        /// `keychainService()` (dist `"com.norma.core"` vs. dev `"com.norma.core.dev"`; devfix:
        /// before this field existed, EVERY profile read the dist service, so a dev-profile app
        /// silently authenticated against the dist daemon's token instead of its own dev daemon's).
        /// Defaulted to the dist literal so every construction site that predates this field
        /// (production's own former behavior, every existing test) compiles and behaves unchanged.
        public var keychainService: String

        public init(
            storeDir: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".norma/remote", isDirectory: true),
            socketPath: String,
            hostLabel: String,
            relayConfig: SignedRelayConfig,
            relayURLs: [String],
            relayProbe: @escaping @Sendable (String) async -> Bool = RemoteHost.defaultRelayProbe,
            keychainService: String = "com.norma.core"
        ) {
            self.storeDir = storeDir
            self.socketPath = socketPath
            self.hostLabel = hostLabel
            self.relayConfig = relayConfig
            self.relayURLs = relayURLs
            self.relayProbe = relayProbe
            self.keychainService = keychainService
        }
    }

    private let config: Config
    private let secretStore: EndpointSecretStore
    private let store: PairingStore

    #if DEBUG
    /// Test-only seam (`@testable`): overrides HOW the transport listener is constructed —
    /// production always binds a real `IrohListener`; `RemoteHostTests`' lifecycle tests inject a
    /// scripted `RemoteListener` instead so `startIfNeeded()`/`stopIfIdle()` can be driven without
    /// any real networking. `nil` (the public initializer's only path) means "use the real thing."
    private let makeListener: (@Sendable () async throws -> RemoteListener)?
    /// Test-only seam: overrides the gateway's daemon-facing bridge client construction —
    /// production reads `KeychainToken.readRemoteToken()` (CLAUDE.md: never in a test). Both
    /// `RemoteHostTests` (lifecycle only, never actually connects) and `PairingE2ETests` (a REAL
    /// `RealDaemon`, whose token is minted per-run, never Keychain-resident) supply this instead.
    private let makeDaemonFactory: (@Sendable () -> NormaClient)?
    #endif

    private var listener: RemoteListener?
    private var router: PairingRouter?
    private var gateway: Gateway?
    private var runTask: Task<Void, Never>?
    private var pairingWindowRequested = false
    /// In-flight `start()` guard (T4 review fix 1). `startIfNeeded`'s `listener == nil` gate alone
    /// is NOT re-entrancy-safe: this class is `@MainActor`, but `startIfNeeded` suspends (at
    /// `store.all()` and throughout `start()`) BEFORE `listener` is assigned — so two overlapping
    /// callers (e.g. app-launch `startIfNeeded()` racing a user's `openPairingWindow()`) could both
    /// pass the gate and bind TWO `IrohListener`s from the SAME secret, leaking the first
    /// gateway/runTask forever. Instead the first caller creates ONE start task and every
    /// overlapping caller awaits that same task; cleared on completion and in `stop()`.
    private var startTask: Task<Void, Error>?

    public private(set) var pairingManager: PairingManager?
    /// This Mac's iroh identity string — `nil` until `startIfNeeded()` has actually started the
    /// stack, populated from `identity.secret` the moment it does (see `start()`'s own comment on
    /// why this is a pure derivation rather than a read off the listener itself).
    public private(set) var macEndpointID: String?
    /// The relay selection `start()` actually chose (CN-T1) — `.custom`/`.n0Default`, captured
    /// the moment `start()` decides so tests can observe the outcome of the probe/fallback logic
    /// without needing a `RelaySelection` accessor on `RemoteListener` itself (the `#if DEBUG`
    /// scripted listener isn't a real `IrohListener` and exposes none of its bind arguments).
    /// `nil` until a start has actually run; cleared on `stop()` like every other started-state
    /// property here. `internal`, not `public` (CN-T1 review — narrowed: zero consumers outside
    /// NormaKit; `RemoteHostTests` reaches it via `@testable import NormaKit`, which needs no
    /// more than `internal` visibility).
    private(set) var lastRelaySelection: RelaySelection?

    public init(config: Config, secretStore: EndpointSecretStore = KeychainEndpointSecretStore()) {
        self.config = config
        self.secretStore = secretStore
        self.store = PairingStore(fileURL: config.storeDir.appendingPathComponent("paired-devices.json"))
        #if DEBUG
        self.makeListener = nil
        self.makeDaemonFactory = nil
        #endif
    }

    #if DEBUG
    /// Test-only initializer (reachable via `@testable import NormaKit`) — see `makeListener`/
    /// `makeDaemonFactory`'s own doc comments.
    init(
        config: Config,
        secretStore: EndpointSecretStore,
        makeListener: (@Sendable () async throws -> RemoteListener)?,
        makeDaemonFactory: (@Sendable () -> NormaClient)? = nil
    ) {
        self.config = config
        self.secretStore = secretStore
        self.store = PairingStore(fileURL: config.storeDir.appendingPathComponent("paired-devices.json"))
        self.makeListener = makeListener
        self.makeDaemonFactory = makeDaemonFactory
    }
    #endif

    // MARK: - Lifecycle

    /// Starts the whole stack (listener -> router -> gateway) if it isn't already running AND
    /// there's a reason to: at least one paired device, or a pairing window has been requested.
    /// A no-op if already running, or if neither condition holds. Re-entrancy-safe: overlapping
    /// callers all await the SAME in-flight start (see `startTask`'s own doc comment on why the
    /// bare `listener == nil` check isn't enough).
    public func startIfNeeded() async throws {
        guard listener == nil else { return }
        if let inFlight = startTask {
            return try await inFlight.value
        }
        let deviceCount = await store.all().count
        guard deviceCount > 0 || pairingWindowRequested else { return }
        // Re-check both gates after the suspension above: an overlapping caller may have created
        // (or even completed) a start while `store.all()` was awaited.
        guard listener == nil else { return }
        if let inFlight = startTask {
            return try await inFlight.value
        }
        // `Task { @MainActor ... }` (not a detached task): `start()` is MainActor-isolated, and the
        // task handle must be visible to overlapping callers BEFORE start's first suspension —
        // assigning `startTask` synchronously right here (no `await` between the checks above and
        // this line) is what closes the double-start window.
        let task = Task { @MainActor in
            try await self.start()
        }
        startTask = task
        defer { startTask = nil }
        try await task.value
    }

    /// Stops the whole stack if it's running AND there's no more reason to keep it up: zero paired
    /// devices AND no pairing window requested. A no-op otherwise (including if already stopped).
    public func stopIfIdle() async {
        // T4 review-2 fix 2: a start may still be mid-flight (`listener` not yet assigned) —
        // without settling it first, the `listener != nil` guard below would no-op and this
        // idleness signal would be silently LOST: the stack finishes starting moments later with
        // nobody left to stop it. Await the in-flight start (error discarded — a FAILED start
        // left nothing running to stop anyway), then evaluate idleness against the settled state.
        _ = try? await startTask?.value
        guard listener != nil else { return }
        let deviceCount = await store.all().count
        guard deviceCount == 0, !pairingWindowRequested else { return }
        stop()
    }

    // MARK: - Relay selection (CN-T1)

    /// `RemoteAccessCoordinator.swift`'s own loud-log idiom (`Logger(subsystem: "com.norma.app",
    /// category: ...)`, `.fault` for "this needs a human's attention right now") — mirrored here,
    /// not shared, since that type lives in the app target and `RemoteHost` (NormaKit) can't
    /// import it.
    private static let log = Logger(subsystem: "com.norma.app", category: "remote-host")

    /// Default `Config.relayProbe` (CN-T1): "is anything answering at that URL at all" — a HEAD
    /// request RACED against a GET fallback (some HTTP servers don't implement HEAD), both sharing
    /// the same 3s per-request timeout, first HTTP response of either wins. ANY response — 2xx,
    /// 4xx, 5xx, whatever — counts as reachable: this asks "is a listener up there," never "is it
    /// healthy," so it can't be fooled into declaring an emergency by, say, a relay that's alive
    /// but momentarily 503ing.
    ///
    /// CN-T1 review fix: HEAD and GET used to run SEQUENTIALLY (GET only attempted after HEAD's
    /// own `try?` gave up) — a black-holed host that never answers either one cost ~2x the 3s
    /// per-request timeout, ~6s, double the documented ≤3s "declare the whole fleet dead" contract
    /// on exactly the emergency path this feature exists for. Racing them via `raceProbes` bounds
    /// the WHOLE per-URL probe to the same 3s the individual requests are already configured with.
    public static func defaultRelayProbe(_ urlString: String) async -> Bool {
        guard let url = URL(string: urlString) else { return false }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        let session = URLSession(configuration: configuration)

        return await raceProbes({
            var head = URLRequest(url: url)
            head.httpMethod = "HEAD"
            if let response = try? await session.data(for: head).1, response is HTTPURLResponse {
                return true
            }
            return false
        }, {
            var get = URLRequest(url: url)
            get.httpMethod = "GET"
            if let response = try? await session.data(for: get).1, response is HTTPURLResponse {
                return true
            }
            return false
        })
    }

    /// Races two async probes and resolves `true` the instant EITHER does, cancelling the other —
    /// never waits for both. `defaultRelayProbe` uses this to race its HEAD and GET attempts so a
    /// single dead host costs one shared 3s timeout, not two sequential ones (CN-T1 review — see
    /// `defaultRelayProbe`'s own doc comment for the ~6s bug this fixes).
    ///
    /// `internal`, not `private`: this is the one piece of the probe's TIMING contract that's
    /// actually unit-testable without real networking — `RemoteHostTests` pins the bound directly
    /// with `Task.sleep`-based fake probes (a real black-holed-host test would need a live server
    /// and wouldn't be reliable in CI); `@testable import NormaKit` reaches it from there.
    static func raceProbes(_ first: @escaping @Sendable () async -> Bool, _ second: @escaping @Sendable () async -> Bool) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { await first() }
            group.addTask { await second() }
            for await reachable in group {
                if reachable {
                    group.cancelAll()
                    return true
                }
            }
            return false
        }
    }

    /// Probes every URL CONCURRENTLY (a TaskGroup, never a serial loop — serially probing N dead
    /// relays at 3s each would take up to N*3s; this bounds total probe time to ~3s regardless of
    /// fleet size) and resolves `true` the instant ANY one answers, cancelling the rest rather than
    /// waiting out the slower/dead ones. Only `false` if every single probe comes back `false`.
    private static func anyRelayReachable(_ urls: [String], probe: @escaping @Sendable (String) async -> Bool) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            for url in urls {
                group.addTask { await probe(url) }
            }
            for await reachable in group {
                if reachable {
                    group.cancelAll()
                    return true
                }
            }
            return false
        }
    }

    private func start() async throws {
        let identity = try MacIdentity.loadOrCreate(store: secretStore)
        // Pure key derivation, no networking (`SecretKey.public()` is synchronous) — equals
        // whatever a REAL `IrohListener.start(secret: identity.secret, ...)` will itself bind to
        // (iroh derives a node's id deterministically from its secret key), so this holds for both
        // the production listener AND the `#if DEBUG` scripted-listener test path uniformly,
        // without either needing to expose an `endpointID` through the bare `RemoteListener`
        // protocol.
        let macID = try SecretKey.fromBytes(bytes: identity.secret).public().description

        // Relay provenance: EVERY build config — Debug ("Norma Dev") included — embeds the
        // production-signed Oracle relay config at build time (`apple/Norma/Resources/
        // relay-config.signed.json`) and `RemoteAccessCoordinator.loadVerifiedRelayConfig`
        // verifies it before this Mac ever sees it — `config.relayURLs` there is
        // `signed.config.relays`. Verified against project.yml + the generated pbxproj (CN-T1
        // review): the `Resources` build phase that carries this file is NOT configuration-gated
        // (unlike the Release-only "Embed norma-core" script), and `RelayConfigTrust` carries no
        // `#if DEBUG` gate either — so a Debug build embeds and successfully verifies the exact
        // SAME signed relay list as Release. `directOnlyFallback` (empty `relayConfig`/
        // `relayURLs`) fires only if that resource is missing, unreadable, malformed, or fails
        // signature verification — never merely because a build happens to be Debug. Practical
        // consequence: every build, Debug included, now probes the PRODUCTION relay hosts at
        // `start()` below — deliberate: a dev Mac should exercise the same fallback behavior a
        // shipped one would, not silently diverge from it. Either way `config.relayURLs` arrives
        // here already resolved; `start()` never re-derives one from the other.
        //
        // Relay selection (CN-T1). Three regimes, in precedence order:
        //   custom relays, ≥1 reachable  -> .custom(all)   (reachable-any wins; iroh handles
        //                                                    per-relay failure among customs)
        //   custom relays, ALL unreachable -> .n0Default    (EMERGENCY fallback — logged at
        //                                                    fault level; this is an incident,
        //                                                    not a mode: fix the fleet)
        //   no custom relays (verification failure on ANY build config — resource missing,
        //   unreadable, malformed, or unverifiable — lands here via directOnlyFallback; there is
        //   no Debug-only route) -> .n0Default, silent, as always.
        let relaySelection: RelaySelection
        if config.relayURLs.isEmpty {
            relaySelection = .n0Default
        } else if await Self.anyRelayReachable(config.relayURLs, probe: config.relayProbe) {
            relaySelection = .custom(config.relayURLs)
        } else {
            Self.log.fault("EMERGENCY relay fallback: every custom relay unreachable (\(self.config.relayURLs.joined(separator: ", "), privacy: .public)) — homing on n0 public relays. Custom relays are re-evaluated only at listener start: restart Norma once the fleet is back.")
            relaySelection = .n0Default
        }
        let boundListener: RemoteListener
        #if DEBUG
        if let makeListener {
            boundListener = try await makeListener()
        } else {
            boundListener = try await IrohListener.start(secret: identity.secret, relays: relaySelection)
        }
        #else
        boundListener = try await IrohListener.start(secret: identity.secret, relays: relaySelection)
        #endif

        // SP3.2c: read the listener's HOMED address (SP3.2b already `online()`d it inside
        // `IrohListener.start`, so `endpointAddr` now carries the relay home + direct candidates)
        // and hand its relay URL + direct addresses to the pairing manager, which embeds them in
        // every QR — so a scanning phone dials the FULL `EndpointAddr` and needs NO DNS/pkarr
        // discovery (which fails on iOS). Only the real `IrohListener` exposes `endpointAddr`; the
        // `#if DEBUG` scripted test listener (RemoteHostTests, lifecycle-only, never pairs) isn't
        // an `IrohListener`, so the cast yields nil → nil/[] hints, which decode cleanly.
        let hostAddr = (boundListener as? IrohListener)?.endpointAddr
        let manager = PairingManager(
            store: store, macEndpointID: macID, hostLabel: config.hostLabel, relayConfig: config.relayConfig,
            macRelayURL: hostAddr?.relayUrl(), macDirectAddresses: hostAddr?.directAddresses() ?? []
        )
        let router = PairingRouter(base: boundListener, directory: store, manager: manager)

        let socketPath = config.socketPath
        let daemonFactory: @Sendable () -> NormaClient
        #if DEBUG
        if let makeDaemonFactory {
            daemonFactory = makeDaemonFactory
        } else {
            let token = try KeychainToken.readRemoteToken(service: config.keychainService)
            daemonFactory = { NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: token, clientName: "iphone-gateway") }
        }
        #else
        let token = try KeychainToken.readRemoteToken(service: config.keychainService)
        daemonFactory = { NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: token, clientName: "iphone-gateway") }
        #endif

        let gateway = Gateway(listener: router, daemonFactory: daemonFactory, hostID: macID, directory: store)

        self.listener = boundListener
        self.router = router
        self.gateway = gateway
        self.pairingManager = manager
        self.macEndpointID = macID
        self.lastRelaySelection = relaySelection
        self.runTask = Task { await gateway.run() }
    }

    private func stop() {
        runTask?.cancel()
        // `router.stop()` forwards to the base listener AND finishes the router's own
        // `connections` stream, which is what actually ends `Gateway.run()`'s `for await` loop —
        // `runTask.cancel()` above is a defensive extra, matching this codebase's own
        // `IrohListener.stop()` idiom (cancel + tear down the underlying resource, don't rely on
        // cancellation alone).
        router?.stop()
        listener = nil
        router = nil
        gateway = nil
        pairingManager = nil
        macEndpointID = nil
        lastRelaySelection = nil
        runTask = nil
        // Belt-and-braces alongside `startIfNeeded`'s own `defer` — a stale in-flight handle must
        // never outlive a stop (a later `startIfNeeded` should start FRESH, not await a start
        // whose product was just torn down).
        startTask?.cancel()
        startTask = nil
    }

    // MARK: - Pairing window

    /// Ensures the stack is running (force-starting it even at zero paired devices — that's the
    /// whole point of a pairing window), then begins a fresh pairing offer. Returns the QR payload
    /// to display.
    public func openPairingWindow() async throws -> QRPayload {
        pairingWindowRequested = true
        try await startIfNeeded()
        guard let pairingManager else { throw RemoteHostError.notRunning }
        return await pairingManager.beginPairing()
    }

    /// Closes the current pairing offer (if any) and drops the "keep running for pairing" request.
    /// Does NOT itself stop the stack — call `stopIfIdle()` afterward if that's also wanted; kept
    /// separate so a caller can batch multiple state changes before re-evaluating idleness once.
    public func closePairingWindow() async {
        pairingWindowRequested = false
        await pairingManager?.endPairing()
    }

    // MARK: - Device management

    /// Revokes a paired phone: removes its `PairingStore` record (so `PairingRouter` refuses its
    /// very next reconnect as `not_paired`) and tears down its live gateway footprint (pump
    /// cancelled, daemon client closed, transport connection dropped — `Gateway.revoke(peerID:)`'s
    /// own doc comment). A no-op (both calls are themselves idempotent) if `phoneEndpointID` isn't
    /// currently paired. Does NOT itself call `stopIfIdle()` — same reasoning as
    /// `closePairingWindow`.
    ///
    /// Throws if the store revoke fails to persist (T4 review fix 5 — `PairingStore.revoke`'s own
    /// contract: a revocation the caller was told happened must actually be durable, and it rolls
    /// its in-memory state back on a persist failure). On that throw the gateway is deliberately
    /// NOT touched: the device is then STILL AUTHORIZED (its store record survives, the router
    /// would re-admit its very next reconnect), so tearing down its live session would only
    /// half-revoke — the phone drops, reconnects, and is right back in, while the UI shows an
    /// error. Propagating BEFORE any gateway side effect keeps the failure atomic: either the
    /// device is fully revoked (store + gateway), or observably not revoked at all.
    public func revoke(phoneEndpointID: String) async throws {
        try await store.revoke(phoneEndpointID: phoneEndpointID)
        await gateway?.revoke(peerID: phoneEndpointID)
    }

    public func pairedDevices() async -> [PairRecord] {
        await store.all()
    }
}
