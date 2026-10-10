import Foundation

/// One connection to the daemon, already verified. Lines go out with `send` (the newline added by the link).
public protocol DaemonLink: AnyObject {
    func send(_ line: Data) -> Bool
    func close()
}

public enum DaemonConnectResult {
    case connected(DaemonLink)
    /// Nothing answered on the socket (no daemon, or not running yet).
    case unavailable(String)
    /// Something answered, but it is not Winter's daemon: closed with nothing sent.
    case unverified(String)
}

/// Opens and verifies a daemon connection. `onLine` and `onClose` must be called on the relay's queue.
public protocol DaemonConnecting {
    func connect(onLine: @escaping (Data) -> Void, onClose: @escaping () -> Void) -> DaemonConnectResult
}

public protocol RelayScheduler {
    func after(_ seconds: TimeInterval, _ block: @escaping () -> Void)
}

/// The host's whole behaviour between Chrome and the daemon (PROTOCOL.md §3–§4), on one serial queue:
///  - connect to `browser.sock`, verify it is the daemon, say `host.hello`; until that is answered nothing else crosses;
///  - then relay every JSON-RPC object unchanged in both directions, reading only its size and envelope;
///  - tell the extension how the daemon link stands with `host.status` (never sent to the daemon);
///  - no daemon: try again every 2 s; refused or unverified: every 30 s.
/// A request from the extension that cannot reach the daemon is answered `disconnected` here; anything else is dropped.
public final class HostRelay {
    public struct Hello: Equatable {
        public var origin: String
        public var browserBundleId: String
        public var browserPid: Int32
        public var hostVersion: String
        public var hostPid: Int32

        public init(origin: String, browserBundleId: String, browserPid: Int32, hostVersion: String, hostPid: Int32) {
            self.origin = origin
            self.browserBundleId = browserBundleId
            self.browserPid = browserPid
            self.hostVersion = hostVersion
            self.hostPid = hostPid
        }
    }

    public enum Phase: Equatable {
        case idle
        case helloSent
        case relaying
    }

    private let hello: Hello
    private let connector: DaemonConnecting
    private let scheduler: RelayScheduler
    private let toExtension: (Data) -> Void
    private let log: (String) -> Void
    private let retrySeconds: TimeInterval
    private let refusedRetrySeconds: TimeInterval

    public private(set) var phase: Phase = .idle
    private var link: DaemonLink?
    /// Bumped per connection: a callback from an older one is ignored.
    private var generation = 0
    private var helloCount = 0
    private var helloId: String?
    private var retryPending = false
    private var lastStatus: [String: String]?

    public init(hello: Hello, connector: DaemonConnecting, scheduler: RelayScheduler,
                toExtension: @escaping (Data) -> Void, log: @escaping (String) -> Void = { _ in },
                retrySeconds: TimeInterval = HostProtocol.retrySeconds,
                refusedRetrySeconds: TimeInterval = HostProtocol.refusedRetrySeconds) {
        self.hello = hello
        self.connector = connector
        self.scheduler = scheduler
        self.toExtension = toExtension
        self.log = log
        self.retrySeconds = retrySeconds
        self.refusedRetrySeconds = refusedRetrySeconds
    }

    public func start() {
        attempt()
    }

    // MARK: - The daemon side

    private func attempt() {
        guard link == nil else { return }
        generation += 1
        let gen = generation
        switch connector.connect(onLine: { [weak self] line in self?.daemonLine(line, generation: gen) },
                                 onClose: { [weak self] in self?.daemonClosed(generation: gen) }) {
        case .connected(let l):
            link = l
            helloCount += 1
            let id = "h\(helloCount)"
            helloId = id
            phase = .helloSent
            let params: [String: Any] = [
                "protocol": HostProtocol.browserHost, "client": "browser-host", "hostVersion": hello.hostVersion,
                "hostPid": Int(hello.hostPid), "origin": hello.origin, "browserBundleId": hello.browserBundleId,
                "browserPid": Int(hello.browserPid),
            ]
            if !send(["jsonrpc": "2.0", "id": id, "method": "host.hello", "params": params]) {
                dropLink()
                status(["daemon": "unavailable"])
                retry(after: retrySeconds)
            }
        case .unavailable(let why):
            log("no daemon on the socket (\(why))")
            status(["daemon": "unavailable"])
            retry(after: retrySeconds)
        case .unverified(let why):
            log("the process on the socket is not Winter's daemon (\(why)) — nothing sent")
            status(["daemon": "unverified"])
            retry(after: refusedRetrySeconds)
        }
    }

    private func send(_ object: [String: Any]) -> Bool {
        guard let link, let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return false }
        return link.send(LineEncoder.line(data))
    }

    private func daemonLine(_ line: Data, generation gen: Int) {
        guard gen == generation, link != nil else { return }
        switch phase {
        case .helloSent:
            guard let object = try? JSONSerialization.jsonObject(with: line, options: []) as? [String: Any],
                  object["id"] as? String == helloId else { return }
            helloId = nil
            if object["result"] != nil {
                phase = .relaying
                log("connected to the daemon")
                lastStatus = nil
                status(["daemon": "connected"])
                return
            }
            let error = object["error"] as? [String: Any] ?? [:]
            let data = error["data"] as? [String: Any] ?? [:]
            var refused: [String: String] = ["daemon": "refused", "reason": (error["message"] as? String) ?? "Winter refused the browser host"]
            if let code = data["code"] as? String { refused["code"] = code }
            log("the daemon refused host.hello (\(refused["code"] ?? "?"))")
            dropLink()
            status(refused)
            retry(after: refusedRetrySeconds)
        case .relaying:
            guard Envelope.parse(line) != nil else {
                log("dropped a daemon line that is not a JSON-RPC 2.0 object")
                return
            }
            guard let framed = NativeMessageEncoder.frame(line) else {
                log("dropped a daemon message over 1 MiB")
                return
            }
            toExtension(framed)
        case .idle:
            return
        }
    }

    private func daemonClosed(generation gen: Int) {
        guard gen == generation, link != nil else { return }
        link = nil
        phase = .idle
        helloId = nil
        log("the daemon connection closed")
        status(["daemon": "unavailable"])
        retry(after: retrySeconds)
    }

    private func dropLink() {
        let l = link
        link = nil
        phase = .idle
        helloId = nil
        generation += 1 // its close callback is now stale
        l?.close()
    }

    private func retry(after seconds: TimeInterval) {
        guard !retryPending else { return }
        retryPending = true
        scheduler.after(seconds) { [weak self] in
            guard let self else { return }
            self.retryPending = false
            self.attempt()
        }
    }

    // MARK: - The extension side

    /// One native message's JSON from the extension.
    public func fromExtension(_ payload: Data) {
        guard let envelope = Envelope.parse(payload) else {
            log("dropped an extension message that is not a JSON-RPC 2.0 object")
            return
        }
        if phase == .relaying, let link {
            if !link.send(LineEncoder.line(payload)) { log("could not write to the daemon") }
            return
        }
        // Winter is not reachable: a request still gets its answer, so the extension never waits on it.
        if case .request(let id, _) = envelope {
            let reply: [String: Any] = ["jsonrpc": "2.0", "id": id, "error": [
                "code": -32000, "message": "Winter is not reachable", "data": ["code": "disconnected"],
            ] as [String: Any]]
            if let data = try? JSONSerialization.data(withJSONObject: reply, options: []), let framed = NativeMessageEncoder.frame(data) {
                toExtension(framed)
            }
        }
    }

    /// `host.status` to the extension, only when it changes (a "connected" is always sent: it asks for a new hello).
    private func status(_ params: [String: String]) {
        if params["daemon"] != "connected", params == lastStatus { return }
        lastStatus = params
        let message: [String: Any] = ["jsonrpc": "2.0", "method": "host.status", "params": params]
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]),
              let framed = NativeMessageEncoder.frame(data) else { return }
        toExtension(framed)
    }
}
