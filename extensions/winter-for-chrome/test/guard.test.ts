// The CDP guard: the allowlist and the "winter"-world rules, enforced before anything reaches the browser.
import { describe, expect, test } from "bun:test";
import { CDP_ALLOWED_METHODS } from "../../../packages/core/src/computer-use/browser/cdp-allowlist";
import { isAllowedEvent, isAllowedMethod, strippedParams, TabGuard } from "../src/guard";

const send = { kind: "send" } as const;
const refused = (g: TabGuard, method: string, params: Record<string, unknown>, session?: string) => g.check(method, params, session).kind === "refuse";

/** A guard that knows one "winter" context (7, from createIsolatedWorld) and one object minted in it. */
function primed(): TabGuard {
  const g = new TabGuard();
  expect(g.check("Page.createIsolatedWorld", { frameId: "F", worldName: "winter" })).toEqual(send);
  g.observeResult("Page.createIsolatedWorld", { frameId: "F", worldName: "winter" }, { executionContextId: 7 });
  g.observeResult("Runtime.evaluate", { contextId: 7, expression: "document.body" }, { result: { type: "object", objectId: "obj-1" } });
  return g;
}

describe("the allowlist", () => {
  test("every listed method passes the method check; anything else is refused", () => {
    const g = new TabGuard();
    for (const m of CDP_ALLOWED_METHODS) expect(isAllowedMethod(m)).toBe(true);
    for (const m of ["Network.getCookies", "Network.getAllCookies", "Network.getResponseBody", "Storage.getCookies", "DOMStorage.getDOMStorageItems",
      "IndexedDB.requestData", "Runtime.getProperties", "Runtime.compileScript", "Page.addScriptToEvaluateOnNewDocument", "Target.sendMessageToTarget",
      "Target.attachToTarget", "Target.createTarget", "Browser.close", "Fetch.enable", "Input.synthesizeTapGesture", "Debugger.enable"]) {
      expect(isAllowedMethod(m)).toBe(false);
      expect(g.check(m, {})).toMatchObject({ kind: "refuse" });
    }
    expect(isAllowedEvent("Page.frameNavigated")).toBe(true);
    expect(isAllowedEvent("Network.responseReceived")).toBe(false);
    expect(isAllowedEvent("Runtime.consoleAPICalled")).toBe(false);
  });

  test("Network events leave reduced to requestId, timestamp and type", () => {
    expect(strippedParams("Network.requestWillBeSent", { requestId: "1", timestamp: 3, type: "XHR", request: { url: "https://x/?token=1", headers: { Cookie: "a=b" } }, initiator: {} }))
      .toEqual({ requestId: "1", timestamp: 3, type: "XHR" });
    expect(strippedParams("Page.frameNavigated", { frame: { url: "https://x/" } })).toEqual({ frame: { url: "https://x/" } });
  });
});

describe("the winter world", () => {
  test("Runtime.evaluate runs only in a winter context", () => {
    const g = primed();
    expect(g.check("Runtime.evaluate", { contextId: 7, expression: "1" })).toEqual(send);
    expect(refused(g, "Runtime.evaluate", { expression: "document.cookie" })).toBe(true);
    expect(refused(g, "Runtime.evaluate", { contextId: 1, expression: "1" })).toBe(true);
    expect(refused(g, "Runtime.evaluate", { contextId: 7, uniqueContextId: "main", expression: "1" })).toBe(true);
    expect(refused(g, "Runtime.evaluate", { contextId: "7", expression: "1" })).toBe(true);
  });

  test("a context announced as the winter isolated world counts; the page's main world and look-alikes never do", () => {
    const g = new TabGuard();
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 1, name: "", auxData: { isDefault: true, type: "default", frameId: "F" } } });
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 2, name: "winter", auxData: { isDefault: false, type: "isolated", frameId: "F" } } });
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 3, name: "winter", auxData: { isDefault: true, type: "default", frameId: "F" } } });
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 4, name: "Winter for Chrome", auxData: { type: "isolated" } } });
    expect(g.check("Runtime.evaluate", { contextId: 2, expression: "1" })).toEqual(send);
    for (const id of [1, 3, 4]) expect(refused(g, "Runtime.evaluate", { contextId: id, expression: "1" })).toBe(true);
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

  test("a destroyed context takes its objects with it; contextsCleared clears the session", () => {
    const g = primed();
    g.observeEvent("Runtime.executionContextDestroyed", { executionContextId: 7 });
    expect(refused(g, "Runtime.evaluate", { contextId: 7, expression: "1" })).toBe(true);
    expect(refused(g, "Runtime.callFunctionOn", { objectId: "obj-1", functionDeclaration: "f" })).toBe(true);
    const h = primed();
    h.observeEvent("Runtime.executionContextsCleared", {});
    expect(h.knownContexts()).toEqual([]);
  });

  test("contexts are per CDP session: an out-of-process iframe's are its own", () => {
    const g = primed();
    g.observeEvent("Runtime.executionContextCreated", { context: { id: 7, name: "", auxData: { type: "default" } } }, "S1");
    expect(refused(g, "Runtime.evaluate", { contextId: 7, expression: "1" }, "S1")).toBe(true);
    g.observeResult("Page.createIsolatedWorld", { frameId: "C", worldName: "winter" }, { executionContextId: 3 }, "S1");
    expect(g.check("Runtime.evaluate", { contextId: 3, expression: "1" }, "S1")).toEqual(send);
    expect(refused(g, "Runtime.evaluate", { contextId: 3, expression: "1" })).toBe(true);
    g.observeEvent("Target.detachedFromTarget", { sessionId: "S1" });
    expect(refused(g, "Runtime.evaluate", { contextId: 3, expression: "1" }, "S1")).toBe(true);
    expect(g.check("Runtime.evaluate", { contextId: 7, expression: "1" })).toEqual(send);
  });
});
