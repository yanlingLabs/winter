// ComputerV2 Phase 2 — the ONLY CDP the browser engine may send or subscribe to. Every transport refuses
// anything else before it reaches a browser (`not_allowed`): Winter.app's link (a Swift copy, kept equal by a repo test)
// and the Winter for Chrome extension (which imports this file at build time). Nothing here reads cookies, storage,
// credentials or response bodies. Change it only through the controller.

export const CDP_ALLOWED_METHODS: readonly string[] = [
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
];

export const CDP_ALLOWED_EVENTS: readonly string[] = [
  "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.domContentEventFired", "Page.loadEventFired",
  "Page.lifecycleEvent", "Page.frameAttached", "Page.frameDetached", "Page.frameStartedLoading",
  "Page.frameStoppedLoading", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened",
  "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
  "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed",
  "Target.attachedToTarget", "Target.detachedFromTarget", "Inspector.detached", "Inspector.targetCrashed",
];

/** Network events leave the browser's process reduced to these params (idle detection needs nothing else). */
export const CDP_NETWORK_EVENT_PARAMS: readonly string[] = ["requestId", "timestamp", "type"];

/**
 * The world rules: code runs only in an isolated world named "winter". A transport refuses (`not_allowed`):
 *  - `Runtime.evaluate` without a `contextId` it saw created (`Runtime.executionContextCreated`) with name "winter";
 *  - `Runtime.callFunctionOn` without such an `executionContextId` or an `objectId` it saw minted in such a context;
 *  - `DOM.resolveNode` without such an `executionContextId`;
 *  - `Page.createIsolatedWorld` with a `worldName` other than "winter", or with `grantUniveralAccess: true`.
 */
export const CDP_WORLD_NAME = "winter";
