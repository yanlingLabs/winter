import Foundation

/// The kit's ONLY egress. Every component in NormaChatKit (CodexAuth, PageFetcher, Search,
/// ResponsesClient in later tasks) speaks through this one seam, which is what lets the whole kit
/// be tested on macOS with a scripted double and never touch the network in CI.
public protocol ChatHTTP: Sendable {
    /// Ordinary request/response. Redirects are followed by the transport and the body is buffered
    /// whole — right for small, trusted JSON endpoints (the OAuth token exchange), wrong for
    /// model-chosen page URLs, which must use `sendCapped`.
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)

    /// ONE hop, with the body streamed and hard-capped. Two requirements, both load-bearing:
    ///
    /// 1. **It MUST NOT follow redirects.** `PageFetcher` re-runs `ssrfGuard` and the
    ///    dangerous-domain check on EVERY hop, and it cannot do that for hops the transport
    ///    swallowed silently. A conformer that follows redirects turns a guarded fetch into an
    ///    unguarded one — which is why this is a required protocol member with no default
    ///    implementation, rather than something a conformer can forget to think about.
    /// 2. **It must stop reading at `maxBytes`**, during collection — never read-then-slice. A
    ///    hostile multi-GB response must not be buffered before the cap applies.
    ///
    /// The body of a non-2xx response is never read at all (mirroring `web.ts`'s `followRedirects`,
    /// which only calls `readCapped` on the success path): `body` comes back empty for a redirect or
    /// an error status.
    func sendCapped(_ request: URLRequest, maxBytes: Int) async throws -> CappedResponse
}

/// One hop's outcome. `truncated` records that the cap cut the body short — the page is still usable
/// (this is exactly what the daemon does at `MAX_FETCH_BYTES`), just incomplete.
public struct CappedResponse: Sendable {
    public let response: HTTPURLResponse
    public let body: Data
    public let bytesRead: Int
    public let truncated: Bool

    public init(response: HTTPURLResponse, body: Data, bytesRead: Int, truncated: Bool) {
        self.response = response
        self.body = body
        self.bytesRead = bytesRead
        self.truncated = truncated
    }
}

public enum ChatHTTPError: Error, Equatable {
    /// URLSession handed back a non-HTTP response (only reachable for non-http(s) schemes).
    case nonHTTPResponse
}

/// Collects at most `maxBytes` from an async byte sequence, stopping the moment the cap is reached.
///
/// Truncation happens DURING collection, never read-then-slice — the port of `web.ts`'s `readCapped`
/// (`web.ts:272-301`), and the same discipline `bash.ts`'s output capture already has. Factored out
/// of the transport so the abort behaviour is testable without a network: the scripted double runs
/// its bodies through this exact function, so a test can hand it a pull-counting sequence and prove
/// the producer was never asked for byte `maxBytes + 1`.
func collectCapped<S: AsyncSequence>(_ bytes: S, maxBytes: Int) async throws -> (body: Data, truncated: Bool)
    where S.Element == UInt8 {
    guard maxBytes > 0 else { return (Data(), true) }
    var buffer = [UInt8]()
    buffer.reserveCapacity(min(maxBytes, 1 << 16))
    var truncated = false
    for try await byte in bytes {
        buffer.append(byte)
        if buffer.count >= maxBytes {
            truncated = true
            break
        }
    }
    return (Data(buffer), truncated)
}

/// The production implementation. Transport failures propagate as URLSession's own `URLError`s —
/// callers distinguish "the network is down" (retry) from a typed protocol error (don't).
public struct URLSessionChatHTTP: ChatHTTP {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ChatHTTPError.nonHTTPResponse }
        return (data, http)
    }

    public func sendCapped(_ request: URLRequest, maxBytes: Int) async throws -> CappedResponse {
        let (bytes, response) = try await session.bytes(for: request, delegate: NoRedirectDelegate.shared)
        guard let http = response as? HTTPURLResponse else {
            bytes.task.cancel()
            throw ChatHTTPError.nonHTTPResponse
        }
        // A redirect or an error status: the caller only wants the status and the headers, so never
        // pull the body at all (a redirect chain must not be able to stream `maxBytes` per hop).
        guard (200 ..< 300).contains(http.statusCode) else {
            bytes.task.cancel()
            return CappedResponse(response: http, body: Data(), bytesRead: 0, truncated: false)
        }
        let (body, truncated) = try await collectCapped(bytes, maxBytes: maxBytes)
        if truncated { bytes.task.cancel() } // stop the transfer; we already have all we will use
        return CappedResponse(response: http, body: body, bytesRead: body.count, truncated: truncated)
    }
}

/// Refuses every redirect so `PageFetcher` can guard each hop itself. Returning `nil` from this
/// delegate callback makes URLSession deliver the 3xx response as the task's own result instead of
/// transparently chasing it.
///
/// The completion-handler spelling (rather than the newer `async` one) is deliberate: this is an
/// `@objc` optional protocol requirement, and the completion-handler form is the one that is
/// unambiguously picked up on every SDK the kit builds against.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = NoRedirectDelegate()

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
