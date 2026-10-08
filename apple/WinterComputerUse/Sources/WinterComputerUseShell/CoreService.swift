import WinterCUCore

/// The automation engine as the dispatcher sees it: exactly `CUCore`'s pinned methods, one per helper RPC
/// method that the engine answers (method `a.bName` → `aBName(_: ABNameParams) → ABNameResult`). `CUCore`
/// conforms below; tests drive the dispatcher with a fake.
///
/// `status` and `permissions.request` are not here: the shell answers them itself (it owns the grants and the
/// onboarding), as it does `hello` and `script.active`.
public protocol CoreService: AnyObject {
    func appsList(_ params: AppsListParams) async throws -> AppsListResult
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
    func screenScreenshot(_ params: ScreenScreenshotParams) async throws -> ScreenScreenshotResult
    func screenAppAt(_ params: ScreenAppAtParams) async throws -> ScreenAppAtResult
    func cancel(_ params: CancelParams) async throws -> CancelResult
    func turnEnded(_ params: TurnEndedParams) async throws -> TurnEndedResult
    func sessionEnded(_ params: SessionEndedParams) async throws -> SessionEndedResult
}

extension CUCore: CoreService {}
