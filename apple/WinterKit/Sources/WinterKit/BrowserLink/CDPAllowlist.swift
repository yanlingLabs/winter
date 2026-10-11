import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 Phase 2 — the ONLY CDP the browser engine may send or subscribe to, Winter.app's copy.
//
// The source of truth is the daemon's `packages/core/src/computer-use/browser/cdp-allowlist.ts`; this
// is the Swift copy the browser link enforces before anything reaches CEF (`CDPTabGate`), kept equal to
// it — element for element, in order — by `CDPAllowlistParityTests`, which reads the TypeScript file.
// Change it only together with that file, and only through the controller: the allowlist is the
// extension's store justification as much as a guard. Nothing here reads cookies, storage, credentials
// or response bodies.
// -----------------------------------------------------------------------------------------------

public enum CDPAllowlist {
    public static let methods: [String] = [
        "Page.enable", "Page.disable", "Page.getFrameTree", "Page.navigate", "Page.reload", "Page.stopLoading",
        "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Page.captureScreenshot", "Page.getLayoutMetrics",
        "Page.handleJavaScriptDialog", "Page.createIsolatedWorld", "Page.setLifecycleEventsEnabled",
        "Page.setInterceptFileChooserDialog",
        "Runtime.enable", "Runtime.disable", "Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.releaseObject",
        "Runtime.releaseObjectGroup",
        "DOM.enable", "DOM.disable", "DOM.getDocument", "DOM.describeNode", "DOM.resolveNode", "DOM.requestNode",
        "DOM.getBoxModel", "DOM.getContentQuads", "DOM.scrollIntoViewIfNeeded", "DOM.focus", "DOM.setFileInputFiles",
        "DOM.getFrameOwner",
        "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
        "Network.enable", "Network.disable",
        "Target.setAutoAttach", "Target.getTargetInfo",
        "Emulation.setFocusEmulationEnabled",
    ]

    public static let events: [String] = [
        "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.domContentEventFired", "Page.loadEventFired",
        "Page.lifecycleEvent", "Page.frameAttached", "Page.frameDetached", "Page.frameStartedLoading",
        "Page.frameStoppedLoading", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened",
        "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
        "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed",
        "Target.attachedToTarget", "Target.detachedFromTarget", "Inspector.detached", "Inspector.targetCrashed",
    ]

    /// Network events leave the app reduced to these params (idle detection needs nothing else).
    public static let networkEventParams: [String] = ["requestId", "timestamp", "type"]

    /// Code runs only in an isolated world with this name (the world rules, `CDPTabGate`).
    public static let worldName = "winter"

    public static let methodSet: Set<String> = Set(methods)
    public static let eventSet: Set<String> = Set(events)
    static let networkEventParamSet: Set<String> = Set(networkEventParams)
}
