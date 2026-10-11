// ComputerV2 — the ONLY CDP the browser engine may send or subscribe to. Every transport refuses anything else before it
// reaches a browser (`not_allowed`): Winter.app's link (a Swift copy, kept equal by a repo test) and the Winter for
// Chrome extension (which imports this file at build time). Nothing here reads cookies, storage, credentials, request
// bodies or headers. A RESPONSE body crosses only when the model asks for one (`Network.getResponseBody`, cut at
// CDP_RESPONSE_BODY_MAX_CHARS) or saves a download (`Fetch.takeResponseBodyAsStream` and `IO.read`). This file is DATA
// only; `cdp-reduce.ts` applies CDP_EVENT_PARAMS. Change it only through the controller.

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
  // Phase 3
  "Log.enable", "Log.disable",                                    // console(): the browser's own page messages (failed loads, CSP, interventions)
  "Network.getResponseBody",                                      // networkBody(): one response the model asks for, cut and redacted
  "Fetch.enable", "Fetch.disable",                                // download(): catch the file a page offers, in the background, with no save dialog
  "Fetch.continueRequest", "Fetch.failRequest",                   //   …let every other response through; stop the browser saving the caught one
  "Fetch.takeResponseBodyAsStream", "IO.read", "IO.close",        //   …read the caught file's bytes into Winter's folder
  "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride", // viewport(): test a page at a phone or tablet size
];

export const CDP_ALLOWED_EVENTS: readonly string[] = [
  "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.domContentEventFired", "Page.loadEventFired",
  "Page.lifecycleEvent", "Page.frameAttached", "Page.frameDetached", "Page.frameStartedLoading",
  "Page.frameStoppedLoading", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened",
  "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
  "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed",
  "Target.attachedToTarget", "Target.detachedFromTarget", "Inspector.detached", "Inspector.targetCrashed",
  // Phase 3
  "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded",  // console()
  "Network.responseReceived",                                               // network(): status, type, MIME
  "Fetch.requestPaused",                                                    // download()
  "Page.downloadWillBegin",                                                 // say that a click started a download Winter did not catch
];

/** The params EVERY Network event keeps whatever else it carries (idle detection needs nothing more). */
export const CDP_NETWORK_EVENT_PARAMS: readonly string[] = ["requestId", "timestamp", "type"];

/**
 * Which params of an event leave the browser's process: dotted paths, `[]` = every element of an array. An event not
 * listed here leaves whole. Strings are cut at CDP_EVENT_STRING_MAX chars, arrays at CDP_EVENT_ARRAY_MAX elements.
 * Headers, cookies, post data and page objects (`objectId`, `preview`, `customPreview`) appear on no list: a console
 * call's or an exception's page objects never cross (only their `value`/`description`).
 *
 * `Fetch.requestPaused`'s `responseHeaders`: every entry whose `name` (in any case) is not in
 * CDP_FETCH_RESPONSE_HEADERS is dropped BEFORE the paths are picked — `Set-Cookie`, like every other header, never
 * crosses.
 */
export const CDP_EVENT_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "Network.requestWillBeSent": ["requestId", "timestamp", "wallTime", "type", "frameId", "request.url", "request.method", "redirectResponse.status"],
  "Network.responseReceived": ["requestId", "timestamp", "type", "frameId", "response.url", "response.status", "response.statusText",
    "response.mimeType", "response.protocol", "response.fromDiskCache", "response.fromServiceWorker", "response.encodedDataLength"],
  "Network.loadingFinished": ["requestId", "timestamp", "type", "encodedDataLength"],
  "Network.loadingFailed": ["requestId", "timestamp", "type", "errorText", "canceled", "blockedReason"],
  "Runtime.consoleAPICalled": ["type", "timestamp", "executionContextId", "args[].type", "args[].subtype", "args[].value",
    "args[].unserializableValue", "args[].description", "args[].className",
    "stackTrace.callFrames[].url", "stackTrace.callFrames[].lineNumber", "stackTrace.callFrames[].columnNumber"],
  "Runtime.exceptionThrown": ["timestamp", "exceptionDetails.text", "exceptionDetails.url", "exceptionDetails.lineNumber",
    "exceptionDetails.columnNumber", "exceptionDetails.executionContextId", "exceptionDetails.exception.description",
    "exceptionDetails.exception.className"],
  "Log.entryAdded": ["entry.source", "entry.level", "entry.text", "entry.url", "entry.lineNumber", "entry.timestamp", "entry.networkRequestId"],
  "Fetch.requestPaused": ["requestId", "frameId", "resourceType", "request.url", "request.method", "responseStatusCode",
    "responseErrorReason", "responseHeaders[].name", "responseHeaders[].value"],
  "Page.downloadWillBegin": ["frameId", "guid", "url", "suggestedFilename"],
};
export const CDP_EVENT_STRING_MAX = 4096;
export const CDP_EVENT_ARRAY_MAX = 32;
/** `Fetch.requestPaused`'s `responseHeaders` keep only these, by name in any case (a download's type, name and size). */
export const CDP_FETCH_RESPONSE_HEADERS: readonly string[] = ["content-type", "content-disposition", "content-length"];
/** `Network.enable`: every cap stated — request bodies never kept (`maxPostDataSize: 0`), response buffers at most these. */
export const CDP_NETWORK_BUFFER_MAX: Readonly<{ resource: number; total: number }> = { resource: 1_048_576, total: 8_388_608 };
/** `Network.getResponseBody`'s `body` is cut here before it leaves the browser's process (`truncated: true` added). */
export const CDP_RESPONSE_BODY_MAX_CHARS = 1_048_576;
/** `IO.read`'s `size` at most this. */
export const CDP_IO_READ_MAX = 1_048_576;

/**
 * The world rules: code runs only in an isolated world named "winter". A transport refuses (`not_allowed`):
 *  - `Runtime.evaluate` without a `contextId` it saw created (`Runtime.executionContextCreated`) with name "winter";
 *  - `Runtime.callFunctionOn` without such an `executionContextId` or an `objectId` it saw minted in such a context;
 *  - `DOM.resolveNode` without such an `executionContextId`;
 *  - `Page.createIsolatedWorld` with a `worldName` other than "winter", or with `grantUniveralAccess: true`;
 *  - `Page.reload` carrying `scriptToEvaluateOnLoad` (it runs in the page's main world);
 *  - `Page.navigate` to any URL whose scheme is not http, https, or exactly `about:blank` (a `javascript:` URL runs
 *    in the page's main world).
 * Execution contexts are matched by `uniqueContextId` where the browser reports one: a process-local `contextId`
 * can repeat after a cross-process navigation. A context counts as "winter" only when THIS transport saw it
 * returned by its own `Page.createIsolatedWorld` call (or created in a frame for that world it made) — never by
 * its name alone, which another extension's world could share.
 *
 * Phase 3's rules, refused the same way:
 *  - `Network.enable` without `maxPostDataSize: 0`, or without a `maxResourceBufferSize` / `maxTotalBufferSize` that is
 *    an integer from 0 to CDP_NETWORK_BUFFER_MAX's (a cap left out means the browser's own, far larger, defaults);
 *  - `Network.getResponseBody`: not refused, but its answer's `body` is cut at CDP_RESPONSE_BODY_MAX_CHARS (base64 or
 *    not) with `truncated: true`;
 *  - `Fetch.enable` with `handleAuthRequests: true`, or a pattern whose `requestStage` is not "Response";
 *  - `Fetch.continueRequest` with anything but `requestId` (no url, method, postData, headers, interceptResponse);
 *  - `Fetch.failRequest` with anything but `requestId` and `errorReason: "Aborted"`;
 *  - `Fetch.takeResponseBodyAsStream` for a `requestId` this transport did not see paused at the Response stage (a
 *    `Fetch.requestPaused` carrying `responseStatusCode` or `responseErrorReason`) in that CDP session;
 *  - `IO.read` / `IO.close` on a `handle` this transport did not see returned by its own
 *    `Fetch.takeResponseBodyAsStream`, an `IO.read` `size` above CDP_IO_READ_MAX, or any `offset` (`IO.read` also
 *    reads `blob:<uuid>` handles: the rule keeps it to caught downloads);
 *  - `Emulation.setDeviceMetricsOverride` with keys other than `width`, `height` (integers 0–4096), `deviceScaleFactor`
 *    (0–4) and `mobile` (a boolean).
 * A transport may refuse more: Winter.app's link refuses `Fetch.*` and `IO.*` outright — the built-in browser saves
 * downloads itself (`CdpTransport.armDownloads`).
 * Not on the list, by design: `Fetch.fulfillRequest` / `continueWithAuth` / `getResponseBody` (they could write a page
 * or answer an auth challenge), `Network.getRequestPostData`, every `*ExtraInfo` event (headers and cookies),
 * `Network.getCookies`, `Storage.*`, `Browser.*`, `IO.resolveBlob`, `Runtime.getProperties`.
 */
export const CDP_WORLD_NAME = "winter";
