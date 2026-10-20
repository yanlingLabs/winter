import WinterProtocol

extension WinterSessionClient {
    /// Paired calls require current host workspace scopes. Local-only typed methods remain denied
    /// by the Gateway/daemon allowlists; a phone cannot create a Mac folder selection or grant.
    public func cowork<Result>(_ request: CoworkRequest<Result>) async throws -> Result {
        try request.decode(await send(method: request.method, params: request.params))
    }
}
