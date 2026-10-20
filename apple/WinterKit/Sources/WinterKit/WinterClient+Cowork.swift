import Foundation
import WinterProtocol

extension WinterClient {
    /// Metadata/control only. No call enables Cowork execution or creates host folder grants.
    public func cowork<Result>(_ request: CoworkRequest<Result>) async throws -> Result {
        let params = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(request.params))
        let result = try await self.request(request.method, params: params)
        return try JSONDecoder().decode(Result.self, from: JSONEncoder().encode(result))
    }
}
