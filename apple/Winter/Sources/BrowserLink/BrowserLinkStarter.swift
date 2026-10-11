import Darwin
import Foundation
import WinterKit

/// ComputerV2 Phase 2 — **the app's one browser link**, started at launch and kept for the app's life.
///
/// It needs no window: the daemon's browser engine can drive Winter's built-in browser while Winter
/// sits in the menu bar with nothing open, which is the ordinary state of a menu-bar app. So it starts
/// in `AppDelegate.boot()` beside the main connection — not with the app window, whose wiring
/// (`summonAppWindow`) runs only the first time a window is shown.
@MainActor
final class BrowserLink {
    let host: BrowserLinkHost
    let client: BrowserLinkClient

    private init(host: BrowserLinkHost, client: BrowserLinkClient) {
        self.host = host
        self.client = client
    }

    /// Start the link against the daemon on `home`, authenticating with the app's harness token from
    /// `keychainService`.
    ///
    /// **The token is read here, by the link, rather than handed over by `AppModel`**: `AppModel`
    /// keeps its token private, and the item's ACL already trusts this app, so a second read is
    /// silent. It is read lazily, once, and again only after the daemon refused a `protocol.hello`
    /// (the daemon re-creates the item at its own boot, and may have minted a new one) — never once
    /// per reconnect attempt while the daemon is simply down.
    static func start(home: String, keychainService: String, runtime: BrowserRuntime? = nil) -> BrowserLink {
        let host = BrowserLinkHost(runtime: runtime ?? .shared)
        let socketPath = WinterPaths.socketPath(home: home)
        let tokens = HarnessTokenCache(service: keychainService)
        let appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
        var configuration = BrowserLinkClient.Configuration(appVersion: appVersion, pid: getpid())
        configuration.log = { NSLog("[BrowserLink] %@", $0) }
        let client = BrowserLinkClient(configuration: configuration, makeClient: { refreshCredentials in
            let token = try tokens.token(refresh: refreshCredentials)
            return WinterClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: token,
                                clientName: BrowserLinkProtocol.clientName,
                                // A result can carry a multi-megabyte screenshot; the default 5 s is
                                // for small requests.
                                requestTimeout: .seconds(30))
        }, handler: host)
        host.output = client
        client.start()
        return BrowserLink(host: host, client: client)
    }
}

/// The harness token, read from the Keychain once and again only on request.
private final class HarnessTokenCache: @unchecked Sendable {
    private let service: String
    private let lock = NSLock()
    private var cached: String?

    init(service: String) { self.service = service }

    func token(refresh: Bool) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        if !refresh, let cached { return cached }
        let fresh = try KeychainToken.readHarnessToken(service: service)
        cached = fresh
        return fresh
    }
}
