// Winter for Chrome — the CDP guard, one per attached tab. It is where Winter's CDP allowlist and world rules are
// ENFORCED: this extension is the last hop before the browser. `cdp-allowlist.ts` is the daemon's pinned file, bundled
// in at build time, so the two can never disagree.
//
// The world rules: page code runs only in an isolated world named "winter".
//  - `Runtime.evaluate` needs a `contextId` seen created as a "winter" world (and no `uniqueContextId`).
//  - `Runtime.callFunctionOn` needs such an `executionContextId`, or an `objectId` minted in such a context; every
//    argument's `objectId` must be one too.
//  - `DOM.resolveNode` needs such an `executionContextId`.
//  - `Page.createIsolatedWorld` only with `worldName: "winter"` and never with universal access.
//  - Any other method's `objectId` must be one minted in a "winter" world (the page's own objects are never reachable).
// A "winter" context is one `Page.createIsolatedWorld` answered for, or one `Runtime.executionContextCreated` announced
// with name "winter" and type "isolated". Contexts, and the objects minted in them, are per CDP session (the tab's own,
// or a flattened child target's).
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS, CDP_NETWORK_EVENT_PARAMS, CDP_WORLD_NAME } from "../../../packages/core/src/computer-use/browser/cdp-allowlist";

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

interface SessionWorlds {
  contexts: Set<number>;
  /** objectId → the "winter" context it was minted in. */
  objects: Map<string, number>;
}

/** What `check` decided: send it, answer `{}` without sending, or refuse with a sentence. */
export type GuardDecision = { kind: "send" } | { kind: "answer"; result: Record<string, unknown> } | { kind: "refuse"; reason: string };

export class TabGuard {
  private readonly sessions = new Map<string, SessionWorlds>();

  private worlds(cdpSessionId: string | undefined): SessionWorlds {
    const key = cdpSessionId ?? "";
    let w = this.sessions.get(key);
    if (w === undefined) {
      w = { contexts: new Set(), objects: new Map() };
      this.sessions.set(key, w);
    }
    return w;
  }

  /** Before a command is sent. */
  check(method: string, params: Record<string, unknown>, cdpSessionId?: string): GuardDecision {
    if (!METHODS.has(method)) return { kind: "refuse", reason: `${method} is not in Winter's CDP allowlist` };
    const w = this.worlds(cdpSessionId);
    const ourContext = (v: unknown): boolean => typeof v === "number" && w.contexts.has(v);
    const ourObject = (v: unknown): boolean => typeof v === "string" && w.objects.has(v);
    switch (method) {
      case "Runtime.evaluate":
        if ("uniqueContextId" in params) return { kind: "refuse", reason: "Runtime.evaluate takes a contextId, never a uniqueContextId" };
        if (!ourContext(params.contextId)) return { kind: "refuse", reason: `Runtime.evaluate runs only in the "${CDP_WORLD_NAME}" world (its contextId)` };
        break;
      case "Runtime.callFunctionOn": {
        const hasObject = params.objectId !== undefined;
        const hasContext = params.executionContextId !== undefined;
        if (!hasObject && !hasContext) return { kind: "refuse", reason: `Runtime.callFunctionOn needs a "${CDP_WORLD_NAME}"-world executionContextId or objectId` };
        if (hasObject && !ourObject(params.objectId)) return { kind: "refuse", reason: `Runtime.callFunctionOn's objectId is not from the "${CDP_WORLD_NAME}" world` };
        if (hasContext && !ourContext(params.executionContextId)) return { kind: "refuse", reason: `Runtime.callFunctionOn runs only in the "${CDP_WORLD_NAME}" world` };
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
      case "DOM.resolveNode":
        if (!ourContext(params.executionContextId)) return { kind: "refuse", reason: `DOM.resolveNode resolves only into the "${CDP_WORLD_NAME}" world (its executionContextId)` };
        break;
      case "Page.createIsolatedWorld":
        if (params.worldName !== CDP_WORLD_NAME) return { kind: "refuse", reason: `Page.createIsolatedWorld only creates the "${CDP_WORLD_NAME}" world` };
        if (params.grantUniveralAccess === true || params.grantUniversalAccess === true) return { kind: "refuse", reason: "the winter world never gets universal access" };
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
  observeResult(method: string, params: Record<string, unknown>, result: unknown, cdpSessionId?: string): void {
    if (!isRecord(result)) return;
    const w = this.worlds(cdpSessionId);
    const mint = (remote: unknown, context: number | undefined): void => {
      if (context === undefined || !isRecord(remote) || typeof remote.objectId !== "string") return;
      w.objects.set(remote.objectId, context);
    };
    switch (method) {
      case "Page.createIsolatedWorld":
        if (typeof result.executionContextId === "number") w.contexts.add(result.executionContextId);
        break;
      case "Runtime.evaluate": {
        const ctx = typeof params.contextId === "number" ? params.contextId : undefined;
        mint(result.result, ctx);
        if (isRecord(result.exceptionDetails)) mint(result.exceptionDetails.exception, ctx);
        break;
      }
      case "Runtime.callFunctionOn": {
        const ctx = typeof params.executionContextId === "number"
          ? params.executionContextId
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
        if (isRecord(c) && typeof c.id === "number" && c.name === CDP_WORLD_NAME && isRecord(c.auxData) && c.auxData.type === "isolated") {
          this.worlds(cdpSessionId).contexts.add(c.id);
        }
        break;
      }
      case "Runtime.executionContextDestroyed": {
        const id = p.executionContextId;
        if (typeof id !== "number") break;
        const w = this.worlds(cdpSessionId);
        w.contexts.delete(id);
        for (const [obj, ctx] of w.objects) if (ctx === id) w.objects.delete(obj);
        break;
      }
      case "Runtime.executionContextsCleared":
        this.sessions.delete(cdpSessionId ?? "");
        break;
      case "Target.detachedFromTarget":
        if (typeof p.sessionId === "string") this.sessions.delete(p.sessionId);
        break;
    }
  }

  /** Test seam: the contexts known for a session. */
  knownContexts(cdpSessionId?: string): number[] {
    return [...this.worlds(cdpSessionId).contexts];
  }
}
