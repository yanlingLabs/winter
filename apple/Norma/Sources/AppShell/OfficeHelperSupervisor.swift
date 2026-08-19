import Foundation
import Security

/// A completed office-helper request whose reply didn't match what was expected: a timeout, a
/// server-side refusal (`error{reason}`), or a structurally different frame than the one call
/// site's own request type ever produces in a correct implementation.
enum OfficeHelperClientError: Error, CustomStringConvertible, Equatable {
    case timedOut
    case serverError(reason: String)
    case unexpectedReply(OfficeWireFrame)

    var description: String {
        switch self {
        case .timedOut: return "office helper request timed out"
        case .serverError(let reason): return "office helper refused: \(reason)"
        case .unexpectedReply(let frame): return "office helper sent an unexpected reply: \(frame)"
        }
    }
}

/// The app-role verbs the brief specified as `OfficeHelperXPC` (`open`/`close`/`ping`), over the
/// live authenticated connection `OfficeHelperSupervisor` builds — see `OfficeWire.swift`'s header
/// for why this is a socket client, not an `NSXPCConnection`-vended protocol object. One
/// `OfficeWireSeqAllocator` per client keeps every outbound request on this connection uniquely
/// numbered, so a reply is always checked against the seq that provoked it before being trusted.
final class OfficeHelperClient {
    private let connection: OfficeWireConnection
    private let seqAllocator: OfficeWireSeqAllocator
    private let requestTimeout: TimeInterval

    init(connection: OfficeWireConnection, seqAllocator: OfficeWireSeqAllocator, requestTimeout: TimeInterval) {
        self.connection = connection
        self.seqAllocator = seqAllocator
        self.requestTimeout = requestTimeout
    }

    func ping() async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.ping(seq: seq))
        guard let reply = await connection.nextFrame(timeout: requestTimeout) else {
            throw OfficeHelperClientError.timedOut
        }
        switch reply {
        case .pong(let replySeq) where replySeq == seq: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Stage A bookkeeping only — see `OfficeWireFrame.open`'s own doc comment. LibreOfficeKit is
    /// not loaded until Task 3; this proves the round trip, nothing more.
    func open(docId: String, path: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.open(seq: seq, docId: docId, path: path))
        guard let reply = await connection.nextFrame(timeout: requestTimeout) else {
            throw OfficeHelperClientError.timedOut
        }
        switch reply {
        case .opened(let replySeq, _) where replySeq == seq: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    func close(docId: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.close(seq: seq, docId: docId))
        guard let reply = await connection.nextFrame(timeout: requestTimeout) else {
            throw OfficeHelperClientError.timedOut
        }
        switch reply {
        case .closed(let replySeq, _) where replySeq == seq: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }
}

/// The brief's own interface shape, kept as a top-level type (not nested inside
/// `OfficeHelperSupervisor`) exactly as named there — `events: AsyncStream<OfficeHelperEvent>` —
/// since Task 4 and later consumers are expected to match against it directly.
enum OfficeHelperEvent: Equatable, Sendable {
    case ready(lokVersion: String)
    case helperDied
    case helperUnavailable
}

/// Office Stage A Task 2 — supervises ONE `NormaOfficeHelper` process for as long as the app needs
/// it: spawns it directly (no launchd — see `OfficeWire.swift`'s header for why the brief's XPC
/// shape is deferred to Task 4), proves it alive with a `hello`/`helloOk` handshake, watches for
/// its death, and **never relaunches on its own**. "Relaunch on next demand only" (the brief's own
/// words): a helper that keeps dying must not become a hot loop competing with the user's machine
/// for CPU — the NEXT explicit `start()` call (whenever app code next needs the helper) gets its
/// own fresh 3-attempt budget, and that is the only door back in.
///
/// Renamed from the brief's `xpc: OfficeHelperXPC?` to `client: OfficeHelperClient?` — the
/// BEHAVIOR the brief specified (open/close/ping, callable once the helper is ready) is
/// unchanged; only the property name stopped implying a transport this task does not build.
@MainActor
final class OfficeHelperSupervisor {

    enum State: Equatable {
        case notStarted
        case starting
        case ready
        case stopped
    }

    struct Configuration {
        var helperExecutableURL: URL
        var socketDirectory: URL
        var handshakeTimeout: TimeInterval = 5.0
        var maxAttempts: Int = 3
        var backoff: TimeInterval = 0.25
        /// Forwarded to the helper as `--idle-exit-seconds` when set. `nil` (production) lets the
        /// helper keep its own 120s default — tests shorten this so a smoke test doesn't spend two
        /// real minutes proving idle-exit happens at all.
        var idleExitSeconds: Int?
        /// Appended verbatim after the standard `--socket-path`/`--state-path`/`--token` (and
        /// optional `--idle-exit-seconds`) arguments. Empty in production — a pure testability
        /// seam so `OfficeSupervisorTests` can pass `NormaOfficeHelperFixture`'s `--mode` flag
        /// without the supervisor itself needing any concept of "fixture modes."
        var extraArguments: [String] = []

        /// Helper at `Contents/MacOS/NormaOfficeHelper` — the same nested path `NormaHelper`'s own
        /// bare-tool product is embedded at (project.yml's "Embed NormaHelper" postCompileScript
        /// does `cp` into `Contents/MacOS/`; "Embed NormaOfficeHelper" mirrors it exactly for this
        /// target). Socket directory per the brief's interface: `NORMA_OFFICE_STATE_PATH` (DEBUG
        /// only — the same escape hatch `NormaCEFRuntime.rootCachePath()` already uses for
        /// `NORMA_CEF_CACHE_PATH`) else `~/Library/Application Support/<bundleid>/Office/`.
        static func production() -> Configuration {
            Configuration(
                helperExecutableURL: Bundle.main.bundleURL
                    .appendingPathComponent("Contents/MacOS/NormaOfficeHelper"),
                socketDirectory: defaultStateDirectory())
        }

        static func defaultStateDirectory() -> URL {
            #if DEBUG
            if let override = ProcessInfo.processInfo.environment["NORMA_OFFICE_STATE_PATH"],
               !override.isEmpty {
                return URL(fileURLWithPath: override, isDirectory: true)
            }
            #endif
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            let bundleId = Bundle.main.bundleIdentifier ?? "com.norma.app"
            return base.appendingPathComponent(bundleId, isDirectory: true)
                .appendingPathComponent("Office", isDirectory: true)
        }
    }

    private let configuration: Configuration
    private let eventsContinuation: AsyncStream<OfficeHelperEvent>.Continuation
    let events: AsyncStream<OfficeHelperEvent>

    private(set) var state: State = .notStarted
    private(set) var client: OfficeHelperClient?

    /// Bumped on every `start()` call. Every closure that can fire asynchronously after the fact
    /// (death detection, a superseded attempt's own late handshake reply) captures the generation
    /// it belongs to and checks it against the CURRENT generation before touching state — so a
    /// stale signal from an attempt this supervisor has already moved past can never clobber a
    /// newer one's result.
    private var generation = 0
    private var process: Process?
    private var connection: OfficeWireConnection?

    init(configuration: Configuration) {
        self.configuration = configuration
        var continuation: AsyncStream<OfficeHelperEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventsContinuation = continuation
    }

    /// Spawns the helper and proves it alive, up to `configuration.maxAttempts` times with
    /// `configuration.backoff` between a killed attempt and the next. Returns once ready or once
    /// every attempt has failed (`.helperUnavailable`) — see the type's own header for why nothing
    /// past that point retries on its own.
    func start() async {
        guard state != .starting else { return }
        state = .starting
        client = nil
        generation += 1
        let myGeneration = generation

        let attempts = max(1, configuration.maxAttempts)
        for attempt in 1...attempts {
            guard myGeneration == generation else { return } // superseded by a newer start()
            if await attemptOnce(generation: myGeneration) {
                return // attemptOnce already moved state to .ready and emitted .ready
            }
            guard myGeneration == generation else { return }
            if attempt < attempts {
                try? await Task.sleep(nanoseconds: UInt64(max(0, configuration.backoff) * 1_000_000_000))
            }
        }
        guard myGeneration == generation else { return }
        state = .stopped
        eventsContinuation.yield(.helperUnavailable)
    }

    /// One spawn -> wait-for-socket -> connect -> `hello` cycle. `true` (and `state == .ready`) on
    /// success; on any failure this tears down what it started (kills the process, closes the
    /// connection) and returns `false` so `start()` can back off and try again.
    private func attemptOnce(generation myGeneration: Int) async -> Bool {
        let token = Self.generateToken()
        let socketDirectory = configuration.socketDirectory
        let socketPath = socketDirectory.appendingPathComponent("office.sock").path

        do {
            try FileManager.default.createDirectory(at: socketDirectory, withIntermediateDirectories: true)
        } catch {
            return false
        }

        let process = Process()
        process.executableURL = configuration.helperExecutableURL
        var arguments = ["--socket-path", socketPath, "--state-path", socketDirectory.path, "--token", token]
        if let idleExitSeconds = configuration.idleExitSeconds {
            arguments += ["--idle-exit-seconds", String(idleExitSeconds)]
        }
        arguments += configuration.extraArguments
        process.arguments = arguments

        do {
            try process.run()
        } catch {
            return false
        }

        let deadline = Date().addingTimeInterval(configuration.handshakeTimeout)

        // Poll for the socket FILE rather than connecting immediately: the helper's own start()
        // (bind+listen) runs after process launch, and connecting against a path that doesn't
        // exist yet fails immediately rather than waiting for it to appear — polling absorbs that
        // startup race inside the same overall handshake budget instead of burning a whole
        // UnixSocketTransport connect-timeout on it.
        while !FileManager.default.fileExists(atPath: socketPath) {
            if Date() >= deadline || myGeneration != generation {
                process.terminate()
                return false
            }
            try? await Task.sleep(nanoseconds: 20_000_000) // 20ms
        }

        let connection = OfficeWireConnection(socketPath: socketPath)
        let helloSeq: UInt64 = 1
        var succeeded = false
        var lokVersion = ""

        do {
            try await connection.open()
            try await connection.send(.hello(seq: helloSeq, role: .app, token: token))
            let remaining = max(0, deadline.timeIntervalSinceNow)
            if let reply = await connection.nextFrame(timeout: remaining),
               case .helloOk(let replySeq, let replyLokVersion) = reply, replySeq == helloSeq {
                succeeded = true
                lokVersion = replyLokVersion
            }
        } catch {
            succeeded = false
        }

        guard succeeded else {
            connection.close()
            process.terminate()
            return false
        }
        guard myGeneration == generation else {
            // A newer start() superseded this attempt while the handshake was in flight — leave
            // the newer attempt's own process/connection alone; tear down only this stale one.
            connection.close()
            process.terminate()
            return false
        }

        self.process = process
        self.connection = connection
        self.client = OfficeHelperClient(connection: connection, seqAllocator: OfficeWireSeqAllocator(),
                                          requestTimeout: configuration.handshakeTimeout)
        self.state = .ready
        armDeathDetection(generation: myGeneration, process: process, connection: connection)
        eventsContinuation.yield(.ready(lokVersion: lokVersion))
        return true
    }

    /// Watches BOTH the process (`terminationHandler`) and the connection (`onClosed`) for the
    /// same underlying event — either can notice first depending on how the helper went away — and
    /// reports it exactly once, via `OnceFlag`, as `.helperDied`. Guarded by `generation` so a
    /// signal belonging to an attempt this supervisor has already moved past (e.g. a fresh
    /// `start()` already replaced it) is a no-op.
    private func armDeathDetection(generation myGeneration: Int, process: Process, connection: OfficeWireConnection) {
        let once = OnceFlag()
        let fire: @Sendable () -> Void = { [weak self] in
            guard once.trip() else { return }
            Task { @MainActor [weak self] in
                guard let self, myGeneration == self.generation else { return }
                self.state = .stopped
                self.client = nil
                self.eventsContinuation.yield(.helperDied)
            }
        }
        connection.onClosed = fire
        process.terminationHandler = { _ in fire() }
    }

    /// A per-launch capability token: 32 random bytes, hex-encoded. Known only to this process and
    /// whatever it hands the token to at spawn (the helper, via `--token`) — proof of "you are the
    /// process I just launched," not a security boundary against another local user (this machine
    /// already trusts anything running as the same uid; see `OfficeWireFrame.hello`'s own comment
    /// on the role/token simplification).
    private static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            // SecRandomCopyBytes failing on macOS would be a far bigger problem than this token —
            // this fallback exists so a supervisor start() never crashes over it, not because it's
            // expected to run.
            return UUID().uuidString + UUID().uuidString
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
