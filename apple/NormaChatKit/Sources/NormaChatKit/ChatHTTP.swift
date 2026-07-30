import Foundation

/// The kit's ONLY egress. Every component in NormaChatKit (CodexAuth here, PageFetcher, Search,
/// ResponsesClient in later tasks) speaks through this one seam, which is what lets the whole kit
/// be tested on macOS with a scripted double and never touch the network in CI.
public protocol ChatHTTP: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public enum ChatHTTPError: Error, Equatable {
    /// URLSession handed back a non-HTTP response (only reachable for non-http(s) schemes).
    case nonHTTPResponse
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
}
