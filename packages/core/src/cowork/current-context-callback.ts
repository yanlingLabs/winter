import { CoworkCurrentContextResolver, type CoworkCurrentContextResolverDeps, type CoworkCurrentContextSnapshot } from "./current-context-resolver";
import type { CoworkContextLookup } from "./current-context";

/** Structural copy of the public SDK8603 RuntimeContextHandler contract. Winter's
 * pinned SDK predates it; do not import a mutable candidate checkout or change pins.
 * The candidate's compile-only fixture must check assignability before wiring. */
export interface CoworkRuntimeContextRequest {
  readonly bindingId: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly cwd: string;
  readonly purpose: "generation" | "compaction";
  readonly attempt: number;
}
export type CoworkRuntimeContextHandler = (request: Readonly<CoworkRuntimeContextRequest>, options: {
  signal: AbortSignal; trustedQuerySessionId: string;
}) => Promise<Readonly<CoworkCurrentContextSnapshot>>;

const unavailable = (): never => { throw new Error("required_context_unavailable"); };
const identity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(property => !("value" in property))) return unavailable();
  return Object.fromEntries(Object.entries(descriptors).map(([key, property]) => [key, property.value]));
}
function parentLookup(value: unknown): CoworkContextLookup {
  const v = closed(value, ["bindingId", "sessionId", "cwd", "purpose", "attempt"], ["agentId"]);
  // bindingId is bounded correlation only. The fixed host query and canonical
  // resolver authorize ownership, never this guest-controlled string.
  if (!identity(v.bindingId) || !identity(v.sessionId) || Object.hasOwn(v, "agentId")
    || typeof v.cwd !== "string" || v.cwd.length === 0 || v.cwd.includes("\0") || Buffer.byteLength(v.cwd, "utf8") > 4096
    || (v.purpose !== "generation" && v.purpose !== "compaction")
    || !Number.isSafeInteger(v.attempt) || (v.attempt as number) < 1 || (v.attempt as number) > 1_000_000) return unavailable();
  return Object.freeze({ sessionId: v.sessionId, cwd: v.cwd, purpose: v.purpose, attempt: v.attempt as number });
}

/** Unwired parent callback. Host deps must come from canonical owning registration;
 * constructing this callback is neither guest/native admission nor registration.
 * Every invocation uses the actual resolver, including its final authority guard. */
export function createCoworkRuntimeContextHandler(deps: CoworkCurrentContextResolverDeps): CoworkRuntimeContextHandler {
  const trustedQuerySessionId = deps.trustedQuerySessionId;
  if (!identity(trustedQuerySessionId)) return unavailable();
  const resolver = new CoworkCurrentContextResolver({ ...deps, trustedQuerySessionId });
  return async (request, options) => {
    try {
      const own = closed(options, ["signal", "trustedQuerySessionId"]);
      if (own.trustedQuerySessionId !== trustedQuerySessionId || !(own.signal instanceof AbortSignal) || own.signal.aborted) return unavailable();
      const lookup = parentLookup(request);
      // Backend/cwd authority stays with the current canonical resolver. Return
      // its primitive-only bounded snapshot directly: no fallback/cache and no
      // external result inspection after its final authority recheck.
      return await resolver.resolve(lookup, { signal: own.signal });
    } catch {
      return unavailable(); // Do not expose authority/reader failures over SDK transport.
    }
  };
}
