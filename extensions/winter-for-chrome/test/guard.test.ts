// The CDP guard: the allowlist and the "winter"-world rules, enforced before anything reaches the browser.
import { describe, expect, test } from "bun:test";
import { CDP_ALLOWED_METHODS } from "../../../packages/core/src/computer-use/browser/cdp-allowlist";
import { isAllowedEvent, isAllowedMethod, strippedParams, TabGuard } from "../src/guard";

const send = { kind: "send" } as const;
const refused = (g: TabGuard, method: string, params: Record<string, unknown>, session?: string) => g.check(method, params, session).kind === "refuse";

/** Runtime enabled, then a "winter" world created by THIS guard's own call (context 7, announced as unique "U7"), and
 *  one object minted in it. */
function primed(session?: string): TabGuard {
  const g = new TabGuard();
  enableRuntime(g, session);
  expect(g.check("Page.createIsolatedWorld", { frameId: "F", worldName: "winter" }, session)).toEqual(send);
  g.observeResult("Page.createIsolatedWorld", { frameId: "F", worldName: "winter" }, { executionContextId: 7 }, session);
  g.observeEvent("Runtime.executionContextCreated", { context: { id: 7, uniqueId: "U7", name: "winter", auxData: { type: "isolated", frameId: "F", isDefault: false } } }, session);
  g.observeResult("Runtime.evaluate", { contextId: 7, expression: "document.body" }, { result: { type: "object", objectId: "obj-1" } }, session);
  return g;
}
function enableRuntime(g: TabGuard, session?: string): void {
  expect(g.check("Runtime.enable", {}, session)).toEqual(send);
  g.observeResult("Runtime.enable", {}, {}, session);
}

describe("the allowlist", () => {
  test("every listed method passes the method check; anything else is refused", () => {
    const g = new TabGuard();
    for (const m of CDP_ALLOWED_METHODS) expect(isAllowedMethod(m)).toBe(true);
    for (const m of ["Network.getCookies", "Network.getAllCookies", "Network.getRequestPostData", "Storage.getCookies", "DOMStorage.getDOMStorageItems",
      "IndexedDB.requestData", "Runtime.getProperties", "Runtime.compileScript", "Page.addScriptToEvaluateOnNewDocument", "Target.sendMessageToTarget",
      "Target.attachToTarget", "Target.createTarget", "Browser.close", "Fetch.fulfillRequest", "Input.synthesizeTapGesture", "Debugger.enable"]) {
      expect(isAllowedMethod(m)).toBe(false);
      expect(g.check(m, {})).toMatchObject({ kind: "refuse" });
    }
    expect(isAllowedEvent("Page.frameNavigated")).toBe(true);
    expect(isAllowedEvent("Network.responseReceivedExtraInfo")).toBe(false);
    expect(isAllowedEvent("Network.requestWillBeSentExtraInfo")).toBe(false);
  });

  test("events leave reduced by cdpEventParams: a request's method and URL, never its headers; Set-Cookie never", () => {
    expect(strippedParams("Network.requestWillBeSent", { requestId: "1", timestamp: 3, type: "XHR", request: { url: "https://x/?token=1", method: "GET", headers: { Cookie: "a=b" } }, initiator: {} }))
      .toEqual({ requestId: "1", timestamp: 3, type: "XHR", request: { url: "https://x/?token=1", method: "GET" } });
    expect(JSON.stringify(strippedParams("Fetch.requestPaused", { requestId: "i", responseStatusCode: 200, responseHeaders: [{ name: "Set-Cookie", value: "s=1" }, { name: "content-type", value: "text/csv" }] })))
      .not.toContain("Set-Cookie");
    expect(strippedParams("Page.frameNavigated", { frame: { url: "https://x/" } })).toEqual({ frame: { url: "https://x/" } });
  });
});

describe("Phase 3's rules", () => {
  test("Network.enable: no post data, capped buffers — every cap stated (left out, the browser's defaults apply)", () => {
    const g = new TabGuard();
    expect(refused(g, "Network.enable", {})).toBe(true);
    expect(refused(g, "Network.enable", { maxResourceBufferSize: 1_048_576, maxTotalBufferSize: 8_388_608 })).toBe(true);
    expect(refused(g, "Network.enable", { maxPostDataSize: 0 })).toBe(true);
    expect(g.check("Network.enable", { maxResourceBufferSize: 1_048_576, maxTotalBufferSize: 8_388_608, maxPostDataSize: 0 })).toEqual(send);
    expect(g.check("Network.enable", { maxResourceBufferSize: 0, maxTotalBufferSize: 0, maxPostDataSize: 0 })).toEqual(send); // a Phase 2 daemon's
    expect(refused(g, "Network.enable", { maxPostDataSize: 1 })).toBe(true);
    expect(refused(g, "Network.enable", { maxResourceBufferSize: 1_048_577 })).toBe(true);
    expect(refused(g, "Network.enable", { maxTotalBufferSize: 100_000_000 })).toBe(true);
  });

  test("a response body is cut before it leaves", () => {
    const g = new TabGuard();
    const big = { body: "a".repeat(1_048_576 + 10), base64Encoded: false };
    const out = g.filterResult("Network.getResponseBody", big) as { body: string; truncated?: boolean };
    expect(out.body.length).toBe(1_048_576);
    expect(out.truncated).toBe(true);
    const small = { body: "ok", base64Encoded: false };
    expect(g.filterResult("Network.getResponseBody", small)).toBe(small);
    expect(g.filterResult("Page.getLayoutMetrics", big)).toBe(big);
  });

  test("Fetch pauses responses only, changes nothing, stops with Aborted, never answers auth", () => {
    const g = new TabGuard();
    const patterns = [{ urlPattern: "*", requestStage: "Response", resourceType: "Document" }];
    expect(g.check("Fetch.enable", { patterns })).toEqual(send);
    expect(refused(g, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] })).toBe(true);
    expect(refused(g, "Fetch.enable", { patterns: [{ urlPattern: "*" }] })).toBe(true);
    expect(refused(g, "Fetch.enable", { patterns, handleAuthRequests: true })).toBe(true);
    expect(refused(g, "Fetch.enable", {})).toBe(true);
    expect(g.check("Fetch.continueRequest", { requestId: "r" })).toEqual(send);
    for (const extra of [{ url: "https://evil/" }, { method: "POST" }, { postData: "x" }, { headers: [] }, { interceptResponse: true }]) {
      expect(refused(g, "Fetch.continueRequest", { requestId: "r", ...extra })).toBe(true);
    }
    expect(g.check("Fetch.failRequest", { requestId: "r", errorReason: "Aborted" })).toEqual(send);
    expect(refused(g, "Fetch.failRequest", { requestId: "r", errorReason: "Failed" })).toBe(true);
    expect(g.check("Fetch.disable", {})).toEqual(send);
  });

  test("a body is read only for a response paused at the Response stage, through a stream this guard saw opened", () => {
    const g = new TabGuard();
    expect(refused(g, "Fetch.takeResponseBodyAsStream", { requestId: "r1" })).toBe(true);
    g.observeEvent("Fetch.requestPaused", { requestId: "r0", request: { url: "https://x/" } }); // the Request stage: never
    expect(refused(g, "Fetch.takeResponseBodyAsStream", { requestId: "r0" })).toBe(true);
    g.observeEvent("Fetch.requestPaused", { requestId: "r1", responseStatusCode: 200 });
    expect(refused(g, "Fetch.takeResponseBodyAsStream", { requestId: "r1" }, "child")).toBe(true); // another session
    expect(g.check("Fetch.takeResponseBodyAsStream", { requestId: "r1" })).toEqual(send);
    expect(refused(g, "IO.read", { handle: "blob:1234" })).toBe(true);
    g.observeResult("Fetch.takeResponseBodyAsStream", { requestId: "r1" }, { stream: "7" });
    expect(refused(g, "Fetch.takeResponseBodyAsStream", { requestId: "r1" })).toBe(true); // once
    expect(g.check("IO.read", { handle: "7", size: 1_048_576 })).toEqual(send);
    expect(refused(g, "IO.read", { handle: "7", size: 1_048_577 })).toBe(true);
    expect(refused(g, "IO.read", { handle: "7", offset: 0, size: 10 })).toBe(true);
    expect(refused(g, "IO.read", { handle: "7" })).toBe(true); // no size: the browser would pick it
    expect(refused(g, "IO.read", { handle: "8" })).toBe(true);
    expect(g.check("IO.close", { handle: "7" })).toEqual(send);
    g.observeResult("IO.close", { handle: "7" }, {});
    expect(refused(g, "IO.read", { handle: "7" })).toBe(true);
  });

  test("Emulation.setDeviceMetricsOverride takes a screen size and nothing else", () => {
    const g = new TabGuard();
    expect(g.check("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })).toEqual(send);
    expect(g.check("Emulation.clearDeviceMetricsOverride", {})).toEqual(send);
    expect(refused(g, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, screenOrientation: { type: "portraitPrimary", angle: 0 } })).toBe(true);
    expect(refused(g, "Emulation.setDeviceMetricsOverride", { width: 5000, height: 844 })).toBe(true);
    expect(refused(g, "Emulation.setDeviceMetricsOverride", { width: 390.5, height: 844 })).toBe(true);
    expect(refused(g, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 9 })).toBe(true);
  });
});

describe("the page's own world is never reached", () => {
  test("Page.reload never with scriptToEvaluateOnLoad", () => {
    const g = new TabGuard();
    expect(g.check("Page.reload", { ignoreCache: true })).toEqual(send);
    expect(refused(g, "Page.reload", { scriptToEvaluateOnLoad: "document.cookie" })).toBe(true);
    expect(refused(g, "Page.reload", { ignoreCache: false, scriptToEvaluateOnLoad: "" })).toBe(true);
  });

  test("Page.navigate only to http, https or exactly about:blank", () => {
    const g = new TabGuard();
    for (const url of ["https://example.com/", "http://127.0.0.1:8080/x", "about:blank"]) expect(g.check("Page.navigate", { url })).toEqual(send);
    for (const url of ["javascript:alert(document.cookie)", "JavaScript:void(0)", "file:///etc/passwd", "data:text/html,<script>1</script>", "blob:https://x/1",
      "filesystem:https://x/temporary/a", "chrome://settings", "about:srcdoc", "view-source:https://x/", "", 5, undefined]) {
      expect({ url, refused: refused(g, "Page.navigate", { url }) }).toEqual({ url, refused: true });
    }
  });
});

describe("the winter world", () => {
  test("Runtime.evaluate runs only in a winter context this guard created", () => {
    const g = primed();
    expect(g.check("Runtime.evaluate", { contextId: 7, expression: "1" })).toEqual(send);
    expect(refused(g, "Runtime.evaluate", { expression: "document.cookie" })).toBe(true);
    expect(refused(g, "Runtime.evaluate", { contextId: 1, expression: "1" })).toBe(true);
    expect(refused(g, "Runtime.evaluate", { contextId: "7", expression: "1" })).toBe(true);
  });

  test("a context announced with the winter name is never trusted by its name alone (another extension's world could share it)", () => {
    const g = new TabGuard();
    enableRuntime(g);
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 2, uniqueId: "U2", name: "winter", auxData: { isDefault: false, type: "isolated", frameId: "F" } } });
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "U1", name: "", auxData: { isDefault: true, type: "default", frameId: "F" } } });
    for (const id of [1, 2]) expect(refused(g, "Runtime.evaluate", { contextId: id, expression: "1" })).toBe(true);
    expect(refused(g, "Runtime.evaluate", { uniqueContextId: "U2", expression: "1" })).toBe(true);
    // …but when OUR createIsolatedWorld answers with that id (the event came first), it is ours, unique id included.
    g.observeResult("Page.createIsolatedWorld", { frameId: "F", worldName: "winter" }, { executionContextId: 2 });
    expect(g.check("Runtime.evaluate", { uniqueContextId: "U2", expression: "1" })).toEqual(send);
  });

  test("contexts are matched by uniqueContextId; a contextId and a uniqueContextId must name the same one", () => {
    const g = primed();
    expect(g.check("Runtime.evaluate", { uniqueContextId: "U7", expression: "1" })).toEqual(send);
    expect(g.check("Runtime.evaluate", { contextId: 7, uniqueContextId: "U7", expression: "1" })).toEqual(send);
    expect(refused(g, "Runtime.evaluate", { uniqueContextId: "U-other", expression: "1" })).toBe(true);
    expect(refused(g, "Runtime.evaluate", { uniqueContextId: 7, expression: "1" })).toBe(true);
    g.observeResult("Page.createIsolatedWorld", { frameId: "G", worldName: "winter" }, { executionContextId: 9 });
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 9, uniqueId: "U9", name: "winter", auxData: { type: "isolated", frameId: "G" } } });
    expect(refused(g, "Runtime.evaluate", { contextId: 7, uniqueContextId: "U9", expression: "1" })).toBe(true);
    expect(g.check("Runtime.callFunctionOn", { uniqueContextId: "U9", functionDeclaration: "() => 1" })).toEqual(send);
  });

  test("a contextId handed out again (a cross-process navigation) stops being winter at once", () => {
    const g = primed();
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 7, uniqueId: "U-main", name: "", auxData: { type: "default", isDefault: true, frameId: "F" } } });
    expect(refused(g, "Runtime.evaluate", { contextId: 7, expression: "document.cookie" })).toBe(true);
    expect(refused(g, "Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "f" })).toBe(true);
    // The same id announced as a winter-named world with ANOTHER unique id is not ours either.
    const h = primed();
    h.observeEvent("Runtime.executionContextCreated", { context: { id: 7, uniqueId: "U-impostor", name: "winter", auxData: { type: "isolated", frameId: "F" } } });
    expect(refused(h, "Runtime.evaluate", { contextId: 7, expression: "1" })).toBe(true);
  });

  test("the Runtime domain must be on: no world is created, and none is used, without its events", () => {
    const g = new TabGuard();
    expect(refused(g, "Page.createIsolatedWorld", { frameId: "F", worldName: "winter" })).toBe(true);
    g.observeResult("Page.createIsolatedWorld", { frameId: "F", worldName: "winter" }, { executionContextId: 3 }); // even if it got through
    expect(refused(g, "Runtime.evaluate", { contextId: 3, expression: "1" })).toBe(true);
    const h = primed();
    h.observeResult("Runtime.disable", {}, {});
    expect(refused(h, "Runtime.evaluate", { contextId: 7, expression: "1" })).toBe(true);
    expect(refused(h, "Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "f" })).toBe(true);
  });

  test("a new document in the world's frame, contextsCleared, or destruction by unique id ends it", () => {
    const g = primed();
    g.observeEvent("Page.frameNavigated", { frame: { id: "OTHER", url: "https://x/" } });
    expect(g.check("Runtime.evaluate", { contextId: 7, expression: "1" })).toEqual(send);
    g.observeEvent("Page.frameNavigated", { frame: { id: "F", url: "https://x/" } });
    expect(refused(g, "Runtime.evaluate", { contextId: 7, expression: "1" })).toBe(true);
    const h = primed();
    h.observeEvent("Runtime.executionContextsCleared", {});
    expect(h.knownContexts()).toEqual([]);
    const k = primed();
    k.observeEvent("Runtime.executionContextDestroyed", { executionContextId: 99, executionContextUniqueId: "U7" });
    expect(refused(k, "Runtime.evaluate", { contextId: 7, expression: "1" })).toBe(true);
    const m = primed();
    m.observeEvent("Runtime.executionContextDestroyed", { executionContextId: 7 });
    expect(refused(m, "Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "f" })).toBe(true);
  });

  test("a winter world that ENDED is refused in the browser's own words (the daemon retries in a fresh world); one that never was is not", () => {
    // The daemon's tab driver retries a page-runtime call once in a fresh world when the error reads like this — the
    // same test it applies to the browser's own answer. A command it sent before it saw the ending must get it.
    const contextGone = (reason: string): boolean => /Cannot find context|context was destroyed|Execution context|No frame|Cannot find default execution context|uniqueContextId/i.test(reason);
    const reasonOf = (g: TabGuard, method: string, params: Record<string, unknown>, session?: string): string => {
      const d = g.check(method, params, session);
      if (d.kind !== "refuse") throw new Error(`${method} was not refused`);
      return d.reason;
    };
    const endings: Array<[string, (g: TabGuard) => void]> = [
      ["a new document in its frame", (g) => g.observeEvent("Page.frameNavigated", { frame: { id: "F", url: "https://x/" } })],
      ["destroyed by id", (g) => g.observeEvent("Runtime.executionContextDestroyed", { executionContextId: 7 })],
      ["destroyed by unique id", (g) => g.observeEvent("Runtime.executionContextDestroyed", { executionContextId: 99, executionContextUniqueId: "U7" })],
      ["contextsCleared", (g) => g.observeEvent("Runtime.executionContextsCleared", {})],
      ["its id handed out again", (g) => g.observeEvent("Runtime.executionContextCreated", { context: { id: 7, uniqueId: "U-main", name: "", auxData: { type: "default", isDefault: true, frameId: "F" } } })],
    ];
    for (const [why, end] of endings) {
      const g = primed();
      end(g);
      for (const [method, params] of [
        ["Runtime.evaluate", { contextId: 7, expression: "1" }],
        ["Runtime.evaluate", { uniqueContextId: "U7", expression: "1" }],
        ["Runtime.callFunctionOn", { executionContextId: 7, functionDeclaration: "f" }],
        ["DOM.resolveNode", { backendNodeId: 1, executionContextId: 7 }],
      ] as const) {
        const reason = reasonOf(g, method, params);
        expect({ why, method, gone: contextGone(reason) }).toEqual({ why, method, gone: true });
      }
      // An object minted in it is still just refused (the driver re-reads its refs on a new document anyway).
      expect(refused(g, "Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "f" })).toBe(true);
    }
    // After Runtime.disable the domain sentence comes first — the driver turns it back on when it attaches again.
    const d = primed();
    d.observeResult("Runtime.disable", {}, {});
    expect(contextGone(reasonOf(d, "Runtime.evaluate", { contextId: 7, expression: "1" }))).toBe(false);
    // A context that was never winter (the page's own, or another extension's) gets the plain refusal, never "gone".
    const g = primed();
    for (const [method, params] of [
      ["Runtime.evaluate", { contextId: 1, expression: "document.cookie" }],
      ["Runtime.evaluate", { uniqueContextId: "U-main", expression: "1" }],
      ["Runtime.callFunctionOn", { executionContextId: 2, functionDeclaration: "f" }],
      ["DOM.resolveNode", { backendNodeId: 1, executionContextId: 3 }],
    ] as const) {
      expect({ method, gone: contextGone(reasonOf(g, method, params)) }).toEqual({ method, gone: false });
    }
    // A fresh world that is handed the ended id again is winter again.
    const r = primed();
    r.observeEvent("Page.frameNavigated", { frame: { id: "F", url: "https://x/" } });
    r.observeResult("Page.createIsolatedWorld", { frameId: "F", worldName: "winter" }, { executionContextId: 7 });
    expect(r.check("Runtime.evaluate", { contextId: 7, expression: "1" })).toEqual(send);
  });

  test("Runtime.callFunctionOn: a winter context or a winter object, and winter objects as arguments", () => {
    const g = primed();
    expect(g.check("Runtime.callFunctionOn", { executionContextId: 7, functionDeclaration: "() => 1" })).toEqual(send);
    expect(g.check("Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "function () {}" })).toEqual(send);
    expect(g.check("Runtime.callFunctionOn", { executionContextId: 7, functionDeclaration: "(a) => a", arguments: [{ objectId: "obj-1" }, { value: 3 }] })).toEqual(send);
    expect(refused(g, "Runtime.callFunctionOn", { functionDeclaration: "() => 1" })).toBe(true);
    expect(refused(g, "Runtime.callFunctionOn", { executionContextId: 1, functionDeclaration: "() => 1" })).toBe(true);
    expect(refused(g, "Runtime.callFunctionOn", { objectId: "page-obj", functionDeclaration: "() => 1" })).toBe(true);
    expect(refused(g, "Runtime.callFunctionOn", { objectId: "obj-1", executionContextId: 1, functionDeclaration: "() => 1" })).toBe(true);
    expect(refused(g, "Runtime.callFunctionOn", { executionContextId: 7, functionDeclaration: "(a) => a", arguments: [{ objectId: "page-obj" }] })).toBe(true);
    expect(refused(g, "Runtime.callFunctionOn", { executionContextId: 7, functionDeclaration: "(a) => a", arguments: "x" })).toBe(true);
  });

  test("objects a call mints in the winter world become usable; an exception's object too", () => {
    const g = primed();
    g.observeResult("Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "f" }, { result: { objectId: "obj-2" } });
    g.observeResult("Runtime.callFunctionOn", { executionContextId: 7, functionDeclaration: "f" }, { result: { value: 1 }, exceptionDetails: { exception: { objectId: "err-1" } } });
    expect(g.check("Runtime.callFunctionOn", { objectId: "obj-2", functionDeclaration: "f" })).toEqual(send);
    expect(g.check("Runtime.callFunctionOn", { objectId: "err-1", functionDeclaration: "f" })).toEqual(send);
    // A result from a context that is not ours mints nothing.
    g.observeResult("Runtime.evaluate", { contextId: 1, expression: "document" }, { result: { objectId: "page-doc" } });
    expect(refused(g, "Runtime.callFunctionOn", { objectId: "page-doc", functionDeclaration: "f" })).toBe(true);
  });

  test("DOM.resolveNode resolves only into the winter world, and its object is the winter world's", () => {
    const g = primed();
    expect(refused(g, "DOM.resolveNode", { backendNodeId: 5 })).toBe(true);
    expect(refused(g, "DOM.resolveNode", { backendNodeId: 5, executionContextId: 1 })).toBe(true);
    expect(g.check("DOM.resolveNode", { backendNodeId: 5, executionContextId: 7 })).toEqual(send);
    g.observeResult("DOM.resolveNode", { backendNodeId: 5, executionContextId: 7 }, { object: { objectId: "node-5" } });
    expect(g.check("DOM.getBoxModel", { objectId: "node-5" })).toEqual(send);
  });

  test("Page.createIsolatedWorld only as \"winter\", never with universal access", () => {
    const g = new TabGuard();
    enableRuntime(g);
    expect(refused(g, "Page.createIsolatedWorld", { frameId: "F", worldName: "other" })).toBe(true);
    expect(refused(g, "Page.createIsolatedWorld", { frameId: "F" })).toBe(true);
    expect(refused(g, "Page.createIsolatedWorld", { frameId: "F", worldName: "winter", grantUniveralAccess: true })).toBe(true);
    expect(refused(g, "Page.createIsolatedWorld", { frameId: "F", worldName: "winter", grantUniversalAccess: true })).toBe(true);
    expect(g.check("Page.createIsolatedWorld", { frameId: "F", worldName: "winter", grantUniveralAccess: false })).toEqual(send);
  });

  test("any other method's objectId must be a winter object; node ids are fine", () => {
    const g = primed();
    expect(g.check("DOM.describeNode", { objectId: "obj-1" })).toEqual(send);
    expect(g.check("DOM.describeNode", { backendNodeId: 9 })).toEqual(send);
    expect(refused(g, "DOM.describeNode", { objectId: "page-obj" })).toBe(true);
    expect(refused(g, "DOM.setFileInputFiles", { objectId: "page-obj", files: ["/etc/hosts"] })).toBe(true);
    expect(refused(g, "DOM.focus", { objectId: "page-obj" })).toBe(true);
  });

  test("releasing an object the world no longer holds is answered here, never sent", () => {
    const g = primed();
    expect(g.check("Runtime.releaseObject", { objectId: "obj-1" })).toEqual(send);
    g.observeResult("Runtime.releaseObject", { objectId: "obj-1" }, {});
    expect(g.check("Runtime.releaseObject", { objectId: "obj-1" })).toEqual({ kind: "answer", result: {} });
    expect(refused(g, "Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "f" })).toBe(true);
  });

  test("contexts are per CDP session: an out-of-process iframe's are its own", () => {
    const g = primed();
    enableRuntime(g, "S1");
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 7, uniqueId: "S1-main", name: "", auxData: { type: "default" } } }, "S1");
    expect(refused(g, "Runtime.evaluate", { contextId: 7, expression: "1" }, "S1")).toBe(true);
    expect(g.check("Runtime.evaluate", { contextId: 7, expression: "1" })).toEqual(send); // the tab's own session is unaffected
    g.observeResult("Page.createIsolatedWorld", { frameId: "C", worldName: "winter" }, { executionContextId: 3 }, "S1");
    expect(g.check("Runtime.evaluate", { contextId: 3, expression: "1" }, "S1")).toEqual(send);
    expect(refused(g, "Runtime.evaluate", { contextId: 3, expression: "1" })).toBe(true);
    g.observeEvent("Target.detachedFromTarget", { sessionId: "S1" });
    expect(refused(g, "Runtime.evaluate", { contextId: 3, expression: "1" }, "S1")).toBe(true);
  });
});
