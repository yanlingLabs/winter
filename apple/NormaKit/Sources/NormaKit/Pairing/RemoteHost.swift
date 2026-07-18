import Foundation
import IrohLib
import NormaProtocol

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
        /// Shown to the phone during pairing (`PairAccepted`/QR display) — e.g. "Alex's Mac".
        public var hostLabel: String
        /// The signed relay list handed to a pairing phone inside its QR payload.
        public var relayConfig: SignedRelayConfig
        /// Relay URLs `IrohListener.start` itself connects through (extracted from `relayConfig`
        /// by the caller — `RemoteHost` doesn't re-derive one from the other, since a verified
        /// `SignedRelayConfig`'s `config.relays` and "what this Mac's OWN listener should dial
        /// through" are allowed to differ, e.g. staging vs. production relay fleets).
        public var relayURLs: [String]

        public init(
            storeDir: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".norma/remote", isDirectory: true),
            socketPath: String,
            hostLabel: String,
            relayConfig: SignedRelayConfig,
            relayURLs: [String]
        ) {
            self.storeDir = storeDir
            self.socketPath = socketPath
            self.hostLabel = hostLabel
            self.relayConfig = relayConfig
            self.relayURLs = relayURLs
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

    public private(set) var pairingManager: PairingManager?
    /// This Mac's iroh identity string — `nil` until `startIfNeeded()` has actually started the
    /// stack, populated from `identity.secret` the moment it does (see `start()`'s own comment on
    /// why this is a pure derivation rather than a read off the listener itself).
    public private(set) var macEndpointID: String?

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
    /// A no-op if already running, or if neither condition holds.
    public func startIfNeeded() async throws {
        guard listener == nil else { return }
        let deviceCount = await store.all().count
        guard deviceCount > 0 || pairingWindowRequested else { return }
        try await start()
    }

    /// Stops the whole stack if it's running AND there's no more reason to keep it up: zero paired
    /// devices AND no pairing window requested. A no-op otherwise (including if already stopped).
    public func stopIfIdle() async {
        guard listener != nil else { return }
        let deviceCount = await store.all().count
        guard deviceCount == 0, !pairingWindowRequested else { return }
        stop()
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

        let boundListener: RemoteListener
        #if DEBUG
        if let makeListener {
            boundListener = try await makeListener()
        } else {
            boundListener = try await IrohListener.start(secret: identity.secret, relayURLs: config.relayURLs)
        }
        #else
        boundListener = try await IrohListener.start(secret: identity.secret, relayURLs: config.relayURLs)
        #endif

        let manager = PairingManager(
            store: store, macEndpointID: macID, hostLabel: config.hostLabel, relayConfig: config.relayConfig
        )
        let router = PairingRouter(base: boundListener, directory: store, manager: manager)

        let socketPath = config.socketPath
        let daemonFactory: @Sendable () -> NormaClient
        #if DEBUG
        if let makeDaemonFactory {
            daemonFactory = makeDaemonFactory
        } else {
            let token = try KeychainToken.readRemoteToken()
            daemonFactory = { NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: token, clientName: "iphone-gateway") }
        }
        #else
        let token = try KeychainToken.readRemoteToken()
        daemonFactory = { NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: token, clientName: "iphone-gateway") }
        #endif

        let gateway = Gateway(listener: router, daemonFactory: daemonFactory, hostID: macID, directory: store)

        self.listener = boundListener
        self.router = router
        self.gateway = gateway
        self.pairingManager = manager
        self.macEndpointID = macID
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
        runTask = nil
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
    public func revoke(phoneEndpointID: String) async {
        _ = try? await store.revoke(phoneEndpointID: phoneEndpointID)
        await gateway?.revoke(peerID: phoneEndpointID)
    }

    public func pairedDevices() async -> [PairRecord] {
        await store.all()
    }
}
