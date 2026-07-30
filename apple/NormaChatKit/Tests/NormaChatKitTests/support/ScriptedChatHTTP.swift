import Foundation
import XCTest
@testable import NormaChatKit

/// The ONLY HTTP any NormaChatKit test ever speaks to. Hands back scripted responses in order and
/// records every request verbatim (including `httpBody`, which survives because nothing here ever
/// goes near URLSession). A kit test that reaches the network is a bug in the test, not the kit —
/// `ChatHTTP` is the single seam and this double is its only test implementation.
final class ScriptedChatHTTP: ChatHTTP, @unchecked Sendable {
    enum Step {
        case ok(status: Int, body: Data)
        case failure(Error)
        /// Like `.ok`, plus the response HEADERS page fetching needs a double to control (the
        /// `Content-Type` that decides the HTML vs raw-text path).
        case response(status: Int, body: Data, headers: [String: String])
        /// A 3xx the fetcher must handle ITSELF. `location: nil` scripts the malformed
        /// redirect-with-no-Location case. (`ChatHTTP.sendCapped` is contractually non-following, so
        /// a redirect is always delivered to the caller rather than chased.)
        case redirect(status: Int, location: String?)
        /// A body produced ONE BYTE AT A TIME by a pull-counting source, so a test can prove the
        /// consumer stopped asking at the cap instead of buffering the whole thing.
        case generated(status: Int, contentType: String, byteCount: Int, byte: UInt8)
        /// Suspends until the CALLING task is cancelled, then throws `CancellationError` — the shape
        /// a stuck connection has from the fetcher's point of view. Drives timeout/abort tests.
        case hang
        /// Suspends until `gate.open()`, then delivers `then`. Lets a test hold a fetch in flight
        /// while it attaches a second, deduped caller.
        indirect case gated(TestGate, then: Step)

        /// `{...}` JSON response step.
        static func json(_ object: [String: Any], status: Int = 200) -> Step {
            .ok(status: status, body: try! JSONSerialization.data(withJSONObject: object))
        }

        static func text(_ body: String, status: Int) -> Step {
            .ok(status: status, body: Data(body.utf8))
        }

        static func html(_ body: String, status: Int = 200) -> Step {
            .response(status: status, body: Data(body.utf8),
                      headers: ["Content-Type": "text/html; charset=utf-8"])
        }

        static func plainText(_ body: String, status: Int = 200) -> Step {
            .response(status: status, body: Data(body.utf8),
                      headers: ["Content-Type": "text/plain; charset=utf-8"])
        }

        static func generatedHTML(byteCount: Int, byte: UInt8 = UInt8(ascii: "a")) -> Step {
            .generated(status: 200, contentType: "text/html; charset=utf-8", byteCount: byteCount, byte: byte)
        }
    }

    private let lock = NSLock()
    private var steps: [Step]
    private(set) var requests: [URLRequest] = []
    /// How many bytes a `.generated` body was actually PULLED for, across all steps. The proof that
    /// `collectCapped` aborts mid-stream rather than reading everything and slicing.
    let pulled = ByteCounter()

    init(_ steps: [Step] = []) { self.steps = steps }

    private func nextStep(for request: URLRequest) throws -> Step {
        let next: Step? = lock.withLock {
            requests.append(request)
            return steps.isEmpty ? nil : steps.removeFirst()
        }
        guard let step = next else {
            throw ScriptedHTTPMisuse.noStepsLeft(request.url?.absoluteString ?? "<nil>")
        }
        return step
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let resolved = try await resolve(nextStep(for: request), for: request)
        var body = Data()
        for try await byte in resolved.bytes { body.append(byte) }
        return (body, resolved.response)
    }

    func sendCapped(_ request: URLRequest, maxBytes: Int) async throws -> CappedResponse {
        let resolved = try await resolve(nextStep(for: request), for: request)
        // Mirror the real transport: a non-2xx body is never pulled at all.
        guard (200 ..< 300).contains(resolved.response.statusCode) else {
            return CappedResponse(response: resolved.response, body: Data(), bytesRead: 0, truncated: false)
        }
        let (body, truncated) = try await collectCapped(resolved.bytes, maxBytes: maxBytes)
        return CappedResponse(response: resolved.response, body: body, bytesRead: body.count, truncated: truncated)
    }

    private struct Resolved {
        let response: HTTPURLResponse
        let bytes: CountingByteStream
    }

    private func resolve(_ step: Step, for request: URLRequest) async throws -> Resolved {
        func make(_ status: Int, _ headers: [String: String]?, _ source: CountingByteStream.Source) -> Resolved {
            Resolved(response: HTTPURLResponse(url: request.url!, statusCode: status,
                                               httpVersion: "HTTP/1.1", headerFields: headers)!,
                     bytes: CountingByteStream(source: source, counter: pulled))
        }
        switch step {
        case .failure(let error):
            throw error
        case .ok(let status, let body):
            return make(status, nil, .data([UInt8](body)))
        case .response(let status, let body, let headers):
            return make(status, headers, .data([UInt8](body)))
        case .redirect(let status, let location):
            return make(status, location.map { ["Location": $0] } ?? [:], .data([]))
        case .generated(let status, let contentType, let byteCount, let byte):
            return make(status, ["Content-Type": contentType], .generated(count: byteCount, byte: byte))
        case .hang:
            try await Task.sleep(for: .seconds(3600)) // throws CancellationError the moment we're cancelled
            throw ScriptedHTTPMisuse.hangCompleted
        case .gated(let gate, let then):
            try await gate.wait()
            return try await resolve(then, for: request)
        }
    }

    // MARK: - assertions helpers

    var requestCount: Int { lock.withLock { requests.count } }
    var requestedURLs: [String] { lock.withLock { requests.map { $0.url?.absoluteString ?? "<nil>" } } }

    func bodyString(_ index: Int = 0) -> String {
        guard let data = lock.withLock({ requests[index].httpBody }) else { return "<no body>" }
        return String(decoding: data, as: UTF8.self)
    }
}

enum ScriptedHTTPMisuse: Error, Equatable {
    case noStepsLeft(String)
    case hangCompleted
    case gateTimedOut
}

/// A one-shot latch a test uses to hold a scripted response open. Polling (rather than continuation
/// bookkeeping) on purpose: `Task.sleep` throws `CancellationError` the instant the waiting task is
/// cancelled, which is exactly the behaviour a held-open connection needs, with no chance of a
/// leaked or double-resumed continuation. Every wait carries a deadline so a broken test fails
/// instead of hanging the suite.
final class TestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var arrived = false

    init() {}

    func open() { lock.withLock { opened = true } }

    var isOpen: Bool { lock.withLock { opened } }
    /// True once somebody is actually blocked on this gate — i.e. the request really is in flight.
    var hasArrived: Bool { lock.withLock { arrived } }

    func wait(deadline: Duration = .seconds(10)) async throws {
        lock.withLock { arrived = true }
        try await TestGate.poll(deadline: deadline) { self.isOpen }
    }

    func waitUntilArrived(deadline: Duration = .seconds(10)) async throws {
        try await TestGate.poll(deadline: deadline) { self.hasArrived }
    }

    /// Shared polling helper — also used by tests waiting on actor state (a joiner attaching to an
    /// in-flight fetch, say).
    static func poll(deadline: Duration = .seconds(10),
                     every interval: Duration = .milliseconds(1),
                     until condition: @Sendable () async -> Bool) async throws {
        let start = ContinuousClock.now
        while await !condition() {
            if ContinuousClock.now - start > deadline { throw ScriptedHTTPMisuse.gateTimedOut }
            try await Task.sleep(for: interval)
        }
    }
}

/// A transport-layer failure (the kind URLSession surfaces) — distinct from an HTTP error status.
struct FakeTransportError: Error, Equatable {}

// MARK: - shared fixtures

enum AuthFixture {
    /// A minimal unsigned JWT whose payload carries the ChatGPT account claim `decodeAccountId`
    /// reads — same construction as the TS test in `packages/core/test/providers/pkce.test.ts`.
    static func idToken(account: String) -> String {
        let payload = ["https://api.openai.com/auth": ["chatgpt_account_id": account]]
        let json = try! JSONSerialization.data(withJSONObject: payload)
        return "header.\(base64url(json)).signature"
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A deterministic config pointed at unroutable hosts: every test drives `ScriptedChatHTTP`,
    /// so even a bug that tried to dial would fail closed rather than reach OpenAI.
    static let testConfig = CodexConfig(
        clientId: "app_test",
        authorizeURL: URL(string: "https://auth.test.invalid/oauth/authorize")!,
        tokenURL: URL(string: "https://auth.test.invalid/oauth/token")!,
        redirectURI: "http://localhost:1455/auth/callback",
        scope: "openid profile email offline_access",
        backendURL: URL(string: "https://backend.test.invalid/codex")!,
        headers: ["OpenAI-Beta": "responses=experimental", "originator": "norma"]
    )
}


/// Counts every byte a consumer actually PULLS. Deliberately pull-based with no internal buffering —
/// an `AsyncStream` would let the producer run ahead of the consumer and blur exactly the thing this
/// exists to measure.
///
/// The counter is unsynchronised on the increment path: a scripted response has exactly one consumer,
/// and tests read `value` only after that consumer has finished (the `await` chain establishes the
/// ordering). Locking per byte would dominate the runtime of a multi-megabyte cap test.
final class ByteCounter: @unchecked Sendable {
    private var count = 0
    var value: Int { count }
    func reset() { count = 0 }
    fileprivate func bump() { count += 1 }
}

struct CountingByteStream: AsyncSequence, Sendable {
    typealias Element = UInt8

    enum Source: Sendable {
        case data([UInt8])
        case generated(count: Int, byte: UInt8)
    }

    let source: Source
    let counter: ByteCounter

    struct AsyncIterator: AsyncIteratorProtocol {
        let source: Source
        let counter: ByteCounter
        var index = 0

        mutating func next() async throws -> UInt8? {
            switch source {
            case .data(let bytes):
                guard index < bytes.count else { return nil }
                defer { index += 1 }
                counter.bump()
                return bytes[index]
            case .generated(let count, let byte):
                guard index < count else { return nil }
                index += 1
                counter.bump()
                return byte
            }
        }
    }

    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(source: source, counter: counter) }
}
