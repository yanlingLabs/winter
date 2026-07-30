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

        /// `{...}` JSON response step.
        static func json(_ object: [String: Any], status: Int = 200) -> Step {
            .ok(status: status, body: try! JSONSerialization.data(withJSONObject: object))
        }

        static func text(_ body: String, status: Int) -> Step {
            .ok(status: status, body: Data(body.utf8))
        }
    }

    private let lock = NSLock()
    private var steps: [Step]
    private(set) var requests: [URLRequest] = []

    init(_ steps: [Step] = []) { self.steps = steps }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let next: Step? = lock.withLock {
            requests.append(request)
            return steps.isEmpty ? nil : steps.removeFirst()
        }
        guard let step = next else {
            throw ScriptedHTTPMisuse.noStepsLeft(request.url?.absoluteString ?? "<nil>")
        }
        switch step {
        case .failure(let error):
            throw error
        case .ok(let status, let body):
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                           httpVersion: "HTTP/1.1", headerFields: nil)!
            return (body, response)
        }
    }

    // MARK: - assertions helpers

    var requestCount: Int { lock.withLock { requests.count } }

    func bodyString(_ index: Int = 0) -> String {
        guard let data = lock.withLock({ requests[index].httpBody }) else { return "<no body>" }
        return String(decoding: data, as: UTF8.self)
    }
}

enum ScriptedHTTPMisuse: Error, Equatable {
    case noStepsLeft(String)
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
