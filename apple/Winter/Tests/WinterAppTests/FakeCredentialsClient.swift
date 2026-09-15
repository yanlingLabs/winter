import Foundation
import WinterKit

/// Hand-written `CredentialsClient` test double — Winter Phase 10b amendment (c), WS-19 B-6.
/// Scripts every call by hand (no socket/transport involved): `CredentialsSectionModel` is built
/// around the `CredentialsClient` PROTOCOL precisely so its tests don't need `WinterClient`'s own
/// `FeedScriptedTransport` machinery. Same posture and same `@unchecked Sendable` rationale as
/// `FakeAnthropicAuthClient` beside it (every mutation happens on the main actor, under `await`).
///
/// `listResults` is a QUEUE rather than a single value, because the behaviour under test is mostly
/// about the SECOND list: "save clears the field and refreshes" is only proved if the refresh can
/// return something different from the first read. When the queue runs dry the last value repeats,
/// so a test that doesn't care about sequencing can set one value and forget it.
final class FakeCredentialsClient: CredentialsClient, @unchecked Sendable {
    struct SimpleError: Error, Equatable {}

    // list()
    var listResults: [Result<[CredentialRow], Error>] = [.success([])]
    private(set) var listCallCount = 0

    // set(providerId:apiKey:)
    var setResult: Result<Void, Error> = .success(())
    /// Every `(providerId, apiKey)` pair the model sent, in order. The apiKey is captured HERE so
    /// tests can assert the exact bytes crossed the seam unmodified (untrimmed) — a test double is
    /// the one place that inspection is legitimate.
    private(set) var setCalls: [(providerId: String, apiKey: String)] = []

    // remove(providerId:)
    var removeResult: Result<Bool, Error> = .success(true)
    private(set) var removeCalls: [String] = []

    func list() async throws -> [CredentialRow] {
        listCallCount += 1
        let result = listResults.count > 1 ? listResults.removeFirst() : (listResults.first ?? .success([]))
        return try result.get()
    }

    func set(providerId: String, apiKey: String) async throws {
        setCalls.append((providerId: providerId, apiKey: apiKey))
        try setResult.get()
    }

    func remove(providerId: String) async throws -> Bool {
        removeCalls.append(providerId)
        return try removeResult.get()
    }

    // MARK: - construction helpers

    /// A typed refusal shaped exactly like the daemon's: a JSON-RPC error whose `data` carries
    /// `code` and (optionally) `door` — the two fields `RpcError.credentialCode`/`.credentialDoor`
    /// read (WS-19 §5).
    static func refusal(code: String, door: String? = nil, message: String = "refused") -> RpcError {
        var data: [String: JSONValue] = ["code": .string(code)]
        if let door { data["door"] = .string(door) }
        return RpcError(code: -32000, message: message, data: .object(data))
    }

    static func row(
        providerId: String,
        displayName: String? = nil,
        group: String = "provider",
        authKinds: [String] = ["api-key"],
        manageable: Bool = true,
        present: Bool = false,
        kind: String? = "api-key",
        risk: String = "approved",
        door: String = "credential.set"
    ) -> CredentialRow {
        CredentialRow(
            providerId: providerId,
            displayName: displayName ?? providerId,
            group: group,
            authKinds: authKinds,
            manageable: manageable,
            present: present,
            kind: kind,
            risk: risk,
            door: door
        )
    }
}
