import WinterCUCore

/// The automation engine as the dispatcher sees it: exactly `CUCore`'s pinned methods, one per helper RPC
/// method that the engine answers (method `a.bName` → `aBName(_: ABNameParams) → ABNameResult`). `CUCore`
/// conforms below; tests drive the dispatcher with a fake. `hello` and `script.active` are the shell's alone.
public protocol CoreService: AnyObject {
    func status(_ params: StatusParams) async throws -> StatusResult
    func permissionsRequest(_ params: PermissionsRequestParams) async throws -> PermissionsRequestResult
    func appsList(_ params: AppsListParams) async throws -> AppsListResult
    func openDocuments(_ params: OpenDocumentsParams) async throws -> OpenDocumentsResult
    func defaultOpener(_ params: DefaultOpenerParams) async throws -> DefaultOpenerResult
    func screenWindows(_ params: ScreenWindowsParams) async throws -> ScreenWindowsResult
    func targetBind(_ params: TargetBindParams) async throws -> TargetBindResult
    func targetUseWindow(_ params: TargetUseWindowParams) async throws -> TargetUseWindowResult
    func targetWindows(_ params: TargetWindowsParams) async throws -> TargetWindowsResult
    func targetRelease(_ params: TargetReleaseParams) async throws -> TargetReleaseResult
    func targetSnapshot(_ params: TargetSnapshotParams) async throws -> TargetSnapshotResult
    func targetFind(_ params: TargetFindParams) async throws -> TargetFindResult
    func targetScreenshot(_ params: TargetScreenshotParams) async throws -> TargetScreenshotResult
    func targetAct(_ params: TargetActParams) async throws -> TargetActResult
    func targetWaitIdle(_ params: TargetWaitIdleParams) async throws -> TargetWaitIdleResult
    func targetWaitFor(_ params: TargetWaitForParams) async throws -> TargetWaitForResult
    func targetAppleScript(_ params: TargetAppleScriptParams) async throws -> TargetAppleScriptResult
    func targetScriptingDictionary(_ params: TargetScriptingDictionaryParams) async throws -> TargetScriptingDictionaryResult
    func screenScreenshot(_ params: ScreenScreenshotParams) async throws -> ScreenScreenshotResult
    func screenAppAt(_ params: ScreenAppAtParams) async throws -> ScreenAppAtResult
    func cancel(_ params: CancelParams) async throws -> CancelResult
    func turnEnded(_ params: TurnEndedParams) async throws -> TurnEndedResult
    func sessionEnded(_ params: SessionEndedParams) async throws -> SessionEndedResult
    /// A session's script started or ended (`script.active`): the engine's Focus Guardian runs only meanwhile.
    func scriptActivity(sessionId: String, active: Bool)
}

public extension CoreService {
    func scriptActivity(sessionId: String, active: Bool) {}
}

extension CUCore: CoreService {}
