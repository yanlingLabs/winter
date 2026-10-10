import Foundation

/// The numbers and limits of Winter for Chrome's wire (PROTOCOL.md). The two protocol numbers live in three places —
/// here, the daemon's `computer-use/browser/extension/protocol.ts` and the extension's `src/protocol.ts` — and a repo test
/// keeps them equal.
public enum HostProtocol {
    /// `host.hello`, the framing and the relay rules. Bump on any observable change to them.
    public static let browserHost = 1
    /// The extension's `hello` and every message after it (the host only relays them).
    public static let extensionProtocol = 1

    /// `<home>/run/<this>`.
    public static let socketName = "browser.sock"

    /// Extension → host: the host refuses a native message larger than this.
    public static let maxExtensionMessage = 16 * 1024 * 1024
    /// Host → extension: Chrome takes at most 1 MiB from a native host.
    public static let maxHostMessage = 1024 * 1024
    /// Daemon → host: one line becomes one native message, so the same 1 MiB.
    public static let maxDaemonLine = 1024 * 1024

    /// How often the host tries again while no daemon answers on the socket.
    public static let retrySeconds: TimeInterval = 2
    /// How long the host waits after the daemon refused it, or could not be verified, before trying again.
    public static let refusedRetrySeconds: TimeInterval = 30
}

/// The executable's name inside the helper bundle's `Contents/MacOS`.
public let browserHostExecutableName = "winter-browser-host"
