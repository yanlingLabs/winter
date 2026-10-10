// Winter for Chrome — the CDP guard, one per attached tab. It is where Winter's CDP allowlist and world rules are
// ENFORCED: this extension is the last hop before the browser. `cdp-allowlist.ts` is the daemon's pinned file, bundled
// in at build time, so the two can never disagree.
//
// The world rules (cdp-allowlist.ts): page code runs only in an isolated world named "winter" that THIS extension saw
// created by its own `Page.createIsolatedWorld` call — never one recognised by its name alone, which another
// extension's world could share.
//  - `Runtime.evaluate` needs such a context, named by `contextId` and/or `uniqueContextId` (both must then be the same
//    context).
//  - `Runtime.callFunctionOn` needs such a context, or an `objectId` minted in one; every argument's `objectId` too.
//  - `DOM.resolveNode` needs such an `executionContextId`.
//  - `Page.createIsolatedWorld` only with `worldName: "winter"` and never with universal access.
//  - `Page.reload` never with `scriptToEvaluateOnLoad`, and `Page.navigate` only to http(s) or exactly `about:blank`
//    (both would otherwise run code in the page's own world).
//  - Any other method's `objectId` must be one minted in a "winter" world.
// A process-local `contextId` can be handed out again after a cross-process navigation, so a context is also known by
// the browser's `uniqueId` (from `Runtime.executionContextCreated`), and an id that turns up again for a different
// context stops being "winter" at once. So that every context's coming and going is seen, a session must have the
// Runtime domain enabled before a world is created or code runs in it; `Runtime.disable`, a cross-document navigation
// of the world's frame and `Runtime.executionContextsCleared` all end it. Contexts, and the objects minted in them, are
// per CDP session (the tab's own, or a flattened child target's).
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS, CDP_NETWORK_EVENT_PARAMS, CDP_WORLD_NAME } from "../../../packages/core/src/computer-use/browser/cdp-allowlist";
import { openable } from "./urls";

const METHODS = new Set(CDP_ALLOWED_METHODS);
const EVENTS = new Set(CDP_ALLOWED_EVENTS);
const NETWORK_PARAMS = new Set(CDP_NETWORK_EVENT_PARAMS);

export const isAllowedMethod = (method: string): boolean => METHODS.has(method);
export const isAllowedEvent = (method: string): boolean => EVENTS.has(method);

/** A Network event's params reduced to what idle detection needs (never headers, cookies, URLs or bodies). */
export function strippedParams(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> {
  const p = params ?? {};
  if (!method.startsWith("Network.")) return p;
  return Object.fromEntries(Object.entries(p).filter(([k]) => NETWORK_PARAMS.has(k)));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface WinterContext {
  frameId?: string;
  /** The browser's unique id for it, once `Runtime.executionContextCreated` announced it. */
  uniqueId?: string;
}

interface SessionWorlds {
  /** `Runtime.enable` passed (and no `Runtime.disable` since): context events are being reported. */
  runtime: boolean;
  /** contextId → a "winter" world THIS guard saw `Page.createIsolatedWorld` return. */
  contexts: Map<number, WinterContext>;
  /** objectId → the "winter" context it was minted in. */
  objects: Map<string, number>;
  /** Recently announced isolated "winter"-named contexts, by id — consulted only when our own createIsolatedWorld
   *  returns that id (the event can arrive before the answer), never trusted by themselves. */
  announced: Map<number, { uniqueId?: string; frameId?: string }>;
}

/** What `check` decided: send it, answer without sending, or refuse with a sentence. */
export type GuardDecision = { kind: "send" } | { kind: "answer"; result: Record<string, unknown> } | { kind: "refuse"; reason: string };

const MAX_ANNOUNCED = 64;

export class TabGuard {
  private readonly sessions = new Map<string, SessionWorlds>();

  private worlds(cdpSessionId: string | undefined): SessionWorlds {
    const key = cdpSessionId ?? "";
    let w = this.sessions.get(key);
    if (w === undefined) {
      w = { runtime: false, contexts: new Map(), objects: new Map(), announced: new Map() };
      this.sessions.set(key, w);
    }
    return w;
  }

  /**
   * The "winter" context `params` names through `idKey` and/or `uniqueKey`, or a refusal sentence. At least one must be
   * given; when both are, they must be the same context.
   */
  private context(w: SessionWorlds, params: Record<string, unknown>, idKey: string, uniqueKey: string, method: string): number | string {
    const id = params[idKey];
    const unique = params[uniqueKey];
    if (id === undefined && unique === undefined) return `${method} runs only in the "${CDP_WORLD_NAME}" world (name its context)`;
    if (!w.runtime) return `${method} needs the Runtime domain enabled in that session first`;
    let byId: number | undefined;
    if (id !== undefined) {
      if (typeof id !== "number" || !w.contexts.has(id)) return `${method} runs only in the "${CDP_WORLD_NAME}" world (its ${idKey})`;
      byId = id;
    }
    if (unique !== undefined) {
      const match = typeof unique === "string" ? [...w.contexts].find(([, c]) => c.uniqueId === unique)?.[0] : undefined;
      if (match === undefined) return `${method} runs only in the "${CDP_WORLD_NAME}" world (its ${uniqueKey})`;
      if (byId !== undefined && byId !== match) return `${method}'s ${idKey} and ${uniqueKey} name different contexts`;
      byId = match;
    }
    return byId!;
  }

  /** Before a command is sent. */
  check(method: string, params: Record<string, unknown>, cdpSessionId?: string): GuardDecision {
    if (!METHODS.has(method)) return { kind: "refuse", reason: `${method} is not in Winter's CDP allowlist` };
    const w = this.worlds(cdpSessionId);
    const ourObject = (v: unknown): boolean => typeof v === "string" && w.objects.has(v);
    switch (method) {
      case "Runtime.evaluate": {
        const ctx = this.context(w, params, "contextId", "uniqueContextId", method);
        if (typeof ctx === "string") return { kind: "refuse", reason: ctx };
        break;
      }
      case "Runtime.callFunctionOn": {
        const named = params.executionContextId !== undefined || params.uniqueContextId !== undefined;
        if (params.objectId === undefined && !named) return { kind: "refuse", reason: `Runtime.callFunctionOn needs a "${CDP_WORLD_NAME}"-world context or objectId` };
        if (params.objectId !== undefined && !ourObject(params.objectId)) return { kind: "refuse", reason: `Runtime.callFunctionOn's objectId is not from the "${CDP_WORLD_NAME}" world` };
        if (named) {
          const ctx = this.context(w, params, "executionContextId", "uniqueContextId", method);
          if (typeof ctx === "string") return { kind: "refuse", reason: ctx };
        }
        if (params.arguments !== undefined) {
          if (!Array.isArray(params.arguments)) return { kind: "refuse", reason: "Runtime.callFunctionOn's arguments must be a list" };
          for (const a of params.arguments) {
            if (isRecord(a) && a.objectId !== undefined && !ourObject(a.objectId)) {
              return { kind: "refuse", reason: `an argument's objectId is not from the "${CDP_WORLD_NAME}" world` };
            }
          }
        }
        break;
      }
      case "DOM.resolveNode": {
        const id = params.executionContextId;
        if (typeof id !== "number" || !w.contexts.has(id)) return { kind: "refuse", reason: `DOM.resolveNode resolves only into the "${CDP_WORLD_NAME}" world (its executionContextId)` };
        break;
      }
      case "Page.createIsolatedWorld":
        if (params.worldName !== CDP_WORLD_NAME) return { kind: "refuse", reason: `Page.createIsolatedWorld only creates the "${CDP_WORLD_NAME}" world` };
        if (params.grantUniveralAccess === true || params.grantUniversalAccess === true) return { kind: "refuse", reason: "the winter world never gets universal access" };
        if (!w.runtime) return { kind: "refuse", reason: "enable the Runtime domain in that session before creating the winter world" };
        break;
      case "Page.reload":
        if ("scriptToEvaluateOnLoad" in params) return { kind: "refuse", reason: "Page.reload never carries a script (it would run in the page's own world)" };
        break;
      case "Page.navigate":
        if (!openable(params.url)) return { kind: "refuse", reason: "Page.navigate goes only to http, https or about:blank pages" };
        break;
      case "Runtime.releaseObject":
        // An object already gone with its context: nothing to release, and nothing of the page's is ever named.
        if (!ourObject(params.objectId)) return { kind: "answer", result: {} };
        break;
      default:
        if (params.objectId !== undefined && !ourObject(params.objectId)) return { kind: "refuse", reason: `${method}'s objectId is not from the "${CDP_WORLD_NAME}" world` };
    }
    return { kind: "send" };
  }

  /** After a command succeeded: learn the contexts and objects it minted. */
  observeResult(method: string, params: Record<string, unknown>, answer: unknown, cdpSessionId?: string): void {
    const result = isRecord(answer) ? answer : {};
    const w = this.worlds(cdpSessionId);
    const mint = (remote: unknown, context: number | undefined): void => {
      if (context === undefined || !w.contexts.has(context) || !isRecord(remote) || typeof remote.objectId !== "string") return;
      w.objects.set(remote.objectId, context);
    };
    const contextOf = (idKey: string): number | undefined => {
      const r = this.context(w, params, idKey, "uniqueContextId", method);
      return typeof r === "number" ? r : undefined;
    };
    switch (method) {
      case "Runtime.enable":
        w.runtime = true;
        break;
      case "Runtime.disable":
        w.runtime = false;
        w.contexts.clear();
        w.objects.clear();
        break;
      case "Page.createIsolatedWorld": {
        if (!w.runtime) break;
        const id = result.executionContextId;
        if (typeof id !== "number") break;
        const frameId = typeof params.frameId === "string" ? params.frameId : undefined;
        const seen = w.announced.get(id);
        const uniqueId = seen !== undefined && seen.frameId === frameId ? seen.uniqueId : undefined;
        this.forget(w, id);
        w.contexts.set(id, { ...(frameId === undefined ? {} : { frameId }), ...(uniqueId === undefined ? {} : { uniqueId }) });
        break;
      }
      case "Runtime.evaluate": {
        const ctx = contextOf("contextId");
        mint(result.result, ctx);
        if (isRecord(result.exceptionDetails)) mint(result.exceptionDetails.exception, ctx);
        break;
      }
      case "Runtime.callFunctionOn": {
        const ctx = params.executionContextId !== undefined || params.uniqueContextId !== undefined
          ? contextOf("executionContextId")
          : typeof params.objectId === "string" ? w.objects.get(params.objectId) : undefined;
        mint(result.result, ctx);
        if (isRecord(result.exceptionDetails)) mint(result.exceptionDetails.exception, ctx);
        break;
      }
      case "DOM.resolveNode":
        mint(result.object, typeof params.executionContextId === "number" ? params.executionContextId : undefined);
        break;
      case "Runtime.releaseObject":
        if (typeof params.objectId === "string") w.objects.delete(params.objectId);
        break;
    }
  }

  /** Every event of the attached tab, subscribed or not: contexts come and go. */
  observeEvent(method: string, params: Record<string, unknown> | undefined, cdpSessionId?: string): void {
    const p = params ?? {};
    switch (method) {
      case "Runtime.executionContextCreated": {
        const c = p.context;
        if (!isRecord(c) || typeof c.id !== "number") break;
        const w = this.worlds(cdpSessionId);
        const aux = isRecord(c.auxData) ? c.auxData : {};
        const frameId = typeof aux.frameId === "string" ? aux.frameId : undefined;
        const uniqueId = typeof c.uniqueId === "string" ? c.uniqueId : undefined;
        const winterNamed = c.name === CDP_WORLD_NAME && aux.type === "isolated";
        const ours = w.contexts.get(c.id);
        if (ours !== undefined) {
          // Ours being announced (it learns its unique id), or the id handed out again to another context.
          const same = winterNamed && (ours.frameId === undefined || ours.frameId === frameId) && (ours.uniqueId === undefined || ours.uniqueId === uniqueId);
          if (same) {
            if (uniqueId !== undefined) ours.uniqueId = uniqueId;
          } else {
            this.forget(w, c.id);
          }
        }
        if (winterNamed) {
          w.announced.set(c.id, { ...(uniqueId === undefined ? {} : { uniqueId }), ...(frameId === undefined ? {} : { frameId }) });
          if (w.announced.size > MAX_ANNOUNCED) w.announced.delete(w.announced.keys().next().value!);
        }
        break;
      }
      case "Runtime.executionContextDestroyed": {
        const w = this.worlds(cdpSessionId);
        const id = p.executionContextId;
        const unique = p.executionContextUniqueId;
        for (const [cid, c] of [...w.contexts]) {
          if (cid === id || (typeof unique === "string" && c.uniqueId === unique)) this.forget(w, cid);
        }
        if (typeof id === "number") w.announced.delete(id);
        break;
      }
      case "Runtime.executionContextsCleared": {
        const w = this.worlds(cdpSessionId);
        w.contexts.clear();
        w.objects.clear();
        w.announced.clear();
        break;
      }
      case "Page.frameNavigated": {
        // A new document in that frame: its worlds went with the old one.
        const frame = isRecord(p.frame) ? p.frame : {};
        if (typeof frame.id !== "string") break;
        const w = this.worlds(cdpSessionId);
        for (const [cid, c] of [...w.contexts]) if (c.frameId === frame.id) this.forget(w, cid);
        break;
      }
      case "Target.detachedFromTarget":
        if (typeof p.sessionId === "string") this.sessions.delete(p.sessionId);
        break;
    }
  }

  private forget(w: SessionWorlds, contextId: number): void {
    w.contexts.delete(contextId);
    for (const [obj, ctx] of w.objects) if (ctx === contextId) w.objects.delete(obj);
  }

  /** Test seam: the "winter" contexts known for a session. */
  knownContexts(cdpSessionId?: string): number[] {
    return [...this.worlds(cdpSessionId).contexts.keys()];
  }
}
