import type { CoworkContextRegistration, CoworkCurrentContextDeps } from "./current-context";
import { createCoworkRuntimeContextHandler, type CoworkRuntimeContextHandler } from "./current-context-callback";
import { COWORK_SHARED_INSTRUCTION_VIEW, type CoworkProtectedInstructionReader } from "./current-context-resolver";
import { coworkGuestSourceRoot } from "./guest-paths";
import { relativeCoworkPath, type CoworkRepository } from "./repository";
import { mapStructuredCoworkInstructions } from "./structured-instruction-mapper";

/*
 * Per-invocation guided reader adapter (Slice B).
 *
 * SOURCE ONLY. Nothing under src/ imports this module, it has no barrel export, and CoworkGuidedFramePort
 * has NO implementation anywhere in src/ (an anti-wiring test pins both), so production context
 * construction stays refused. Core cannot call the SDK's private guided reader and its SDK pin predates it:
 * whoever holds the SDK side supplies `readFrame(signal)`. A test with a fake port proves this module's
 * own logic. It never proves frame authenticity, native admission or Root reader cleanup.
 *
 * It is a SIBLING of createCoworkRuntimeContextHandler, not a change to it. Per SDK callback invocation it
 * composes a fresh copy of that existing handler (so parentLookup, the real resolver and its final
 * canonical guards run unchanged) with a protected reader that closes over THAT invocation's ORIGINAL
 * callback signal. Nothing stores a "current signal" on the factory, so overlapping invocations cannot
 * borrow each other's handle. The owner is consumed structurally (its registration port plus the capture's
 * plain data): the Slice A owning slot is deliberately not imported, and its brand cannot be verified from
 * here, so every call re-checks the live registration against the capture field by field.
 *
 * Refusal contract = the existing handler's: throw Error("required_context_unavailable"), never a partial
 * snapshot.
 */

/* ---- Frame definition: a COPY of the SDK-side reader frame. ----
 * Source of truth (read-only, not imported): yanlingLabs/winter-agent-sdk
 *   packages/runtime/src/guest/linux-guided-reader-protocol.ts  parseLinuxGuidedReaderMessage (echo keys, inner owner
 *     keys = the runtime owner without workspaceId, views keys, loader limits, the 320 KiB reader_result frame bound)
 *   packages/sdk/src/guided-reader-protocol.ts                  GUIDED_READER_FRAME_BYTES, single-line frame rules
 * as of origin/main 6a6425a14771d178439974b1dd434aef7d46d135. A drift test pins every value below against an
 * independent literal; change both together, after re-reading the SDK source. */
export const COWORK_GUIDED_FRAME_VERSION = 1;
export const COWORK_GUIDED_FRAME_KEYS = Object.freeze(["version", "readId", "owner", "views", "limits", "snapshot"] as const);
export const COWORK_GUIDED_FRAME_OWNER_KEYS = Object.freeze(["logicalSessionId", "backendSessionId", "incarnationId", "leaseEpoch", "bootId", "generation"] as const);
export const COWORK_GUIDED_FRAME_VIEW_KEYS = Object.freeze(["sourceRoot", "sourceCwd", "sharedRoot", "sharedPath"] as const);
export const COWORK_GUIDED_FRAME_SNAPSHOT_KEYS = Object.freeze(["blocks", "digest", "droppedImports", "files", "provenance", "skippedLinks", "text", "tiers"] as const);
export const COWORK_GUIDED_FRAME_LIMITS = Object.freeze({ maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 });
/** The runtime's reader_result frame bound (the SDK's own transport allows 1 MiB; the smaller one is the real ceiling). */
export const COWORK_GUIDED_FRAME_MAX_BYTES = 320 * 1024;
/** Real frames nest four deep (frame, snapshot, list, record); this leaves headroom, not room for attacks. */
export const COWORK_GUIDED_FRAME_MAX_DEPTH = 6;
/** The SDK bounds its per-query read-id sets at 4096 (`instructionReadIds` in packages/sdk/src/query.ts, and `consumed`
 * in packages/runtime/src/guest/linux-guided-reader-channel.ts). That is NOT the SDK's process-global `consumedBindings`,
 * which holds binding ids. When Core's own per-owner set is full, every further frame is refused. */
export const COWORK_GUIDED_READ_ID_CAPACITY = 4096;

const SHARED_PATH = `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md` as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];

/** ABSTRACT seam only: no implementation exists anywhere in src/. The holder of the SDK side closes over its own
 * exact preparation and returns the raw reader frame for THIS callback signal. One read per signal; the
 * returned string is guest-controlled bytes and is parsed here as such. */
export interface CoworkGuidedFramePort { readFrame(signal: AbortSignal): Promise<string> }

/** The plain data of the Slice A capture that this adapter compares against (the real capture is assignable).
 * The reader plan (`readerRegistrationId`, `views`, `limits`) is REQUIRED here: without it the frame's echo has
 * nothing to be compared with, so construction is refused. */
export interface CoworkGuidedReaderCapture {
  readonly workspaceId: string; readonly sessionId: string; readonly backendSessionId: string; readonly trustedQuerySessionId: string;
  readonly backendGeneration: number; readonly bootId: string; readonly incarnationId: string; readonly leaseEpoch: number;
  readonly source: Readonly<{ sourceId: string; revision: number; root: string; access: "read-only" | "read-write" }>;
  readonly cwd: string;
  readonly readerRegistrationId?: string;
  readonly views?: Readonly<{ sourceRoot: string; sourceCwd: string; sharedRoot: string; sharedPath: string }>;
  readonly limits?: Readonly<{ maxFileBytes: number; maxReadBytes: number; maxReadOccurrences: number; maxExpandedBytes: number }>;
}
export interface CoworkGuidedReaderDeps extends Pick<CoworkCurrentContextDeps, "records" | "grants" | "currentBootId"> {
  /** The owner's own registration port (the Slice A `registrationPort`). It is the only owner-liveness input. */
  registration(trustedQuerySessionId: string): CoworkContextRegistration | undefined;
  readonly capture: CoworkGuidedReaderCapture;
  readonly frames: CoworkGuidedFramePort;
  /** Passed through to the resolver (at most 5 seconds). */
  timeoutMs?: number;
}
/** What the frame's echo must equal. The owner mirror has SIX fields: the frame strips workspaceId. */
export interface CoworkGuidedFrameExpectation {
  /** Core's canonical read id. The SDK's read id is a different identity: the frame may never carry this one. */
  readonly canonicalReadId: string;
  readonly owner: Readonly<Record<typeof COWORK_GUIDED_FRAME_OWNER_KEYS[number], string | number>>;
  readonly views: Readonly<Record<typeof COWORK_GUIDED_FRAME_VIEW_KEYS[number], string>>;
  readonly limits: Readonly<typeof COWORK_GUIDED_FRAME_LIMITS>;
}

const unavailable = (): never => { throw new Error("required_context_unavailable"); };

/** Single-use read ids for ONE handler (one owner). Bounded: once full, every further id is refused. This is Core's own
 * per-owner replay set, not a cross-owner ledger. It mirrors the SDK's per-query read-id sets (`instructionReadIds`, and
 * `consumed` in the reader channel); it is unrelated to the SDK's process-global `consumedBindings` (binding ids). */
export class CoworkGuidedReadIdSet {
  readonly #seen = new Set<string>();
  readonly #capacity: number;
  constructor(capacity: number = COWORK_GUIDED_READ_ID_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > COWORK_GUIDED_READ_ID_CAPACITY) unavailable();
    this.#capacity = capacity;
  }
  /** True only the first time an id is seen while there is room. */
  claim(readId: string): boolean {
    if (this.#seen.size >= this.#capacity || this.#seen.has(readId)) return false;
    this.#seen.add(readId);
    return true;
  }
}
/** Exact key set, own DATA properties only, plain prototype. Returns a null-prototype copy of the listed keys. */
function closedKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unavailable();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return unavailable();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return unavailable();
    copy[key] = descriptor.value;
  }
  return copy;
}
/** One own data property of a (possibly larger) trusted object; accessors and inherited fields are refused. */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : unavailable();
}
const text = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : unavailable();
const counter = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : unavailable();
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (actual: Record<string, unknown>, expected: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => keys.every(key => actual[key] === expected[key]);

/** Conservative nesting bound over the RAW text, string-aware, before any parser or serializer recurses. */
function nestsWithin(body: string, max: number): boolean {
  let depth = 0, inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (inString) { if (c === 0x5c) i++; else if (c === 0x22) inString = false; continue; }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) { if (++depth > max) return false; }
    else if (c === 0x7d || c === 0x5d) { if (--depth < 0) return false; }
  }
  return depth === 0 && !inString;
}
/** No own key that could be mistaken for a prototype slot and no ill-formed string (a lone surrogate that arrived as an
 * escape, which the raw UTF-8 check cannot see and the re-serialization round trip preserves), at any level, keys
 * included. Depth is already bounded. */
function cleanData(value: unknown): void {
  if (typeof value === "string") { if (!value.isWellFormed()) return unavailable(); return; }
  if (value === null || typeof value !== "object") return;
  if (!Array.isArray(value) && (DANGEROUS_KEYS.some(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !key.isWellFormed()))) return unavailable();
  for (const child of Object.values(value)) cleanData(child);
}

// F10: raw-byte parse in Core is the testable seam only; see contract doc F10.
/** Strict parse of GUEST-CONTROLLED reader-frame bytes. Returns ONLY the snapshot; the owner, views, limits and
 * read id are checked here and never travel on. `claim` consumes a read id (false = reused or the set is full).
 * Throws Error("required_context_unavailable") for anything else. The snapshot's own semantics belong to the
 * existing mapper; the closed key echo here is transport consistency, never read authority. */
export function parseCoworkGuidedReaderFrame(raw: unknown, expected: CoworkGuidedFrameExpectation, claim: (readId: string) => boolean): { readonly snapshot: unknown } {
  try {
    // One bounded line of valid UTF-8. UTF-16 length never exceeds the byte length, so check it first.
    if (typeof raw !== "string" || raw.length > COWORK_GUIDED_FRAME_MAX_BYTES || Buffer.byteLength(raw, "utf8") > COWORK_GUIDED_FRAME_MAX_BYTES
      || !raw.endsWith("\n") || raw.indexOf("\n") !== raw.length - 1 || Buffer.from(raw, "utf8").toString("utf8") !== raw) return unavailable();
    const body = raw.slice(0, -1);
    if (!nestsWithin(body, COWORK_GUIDED_FRAME_MAX_DEPTH)) return unavailable();
    const parsed: unknown = JSON.parse(body);
    // Exact re-serialization: JSON.parse keeps the LAST of duplicate keys, so a duplicate, whitespace, an
    // alternate escape or number spelling changes the text and is refused (the SDK applies the same rule).
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(parsed) !== body) return unavailable();
    cleanData(parsed);
    const frame = closedKeys(parsed, COWORK_GUIDED_FRAME_KEYS);
    if (frame.version !== COWORK_GUIDED_FRAME_VERSION) return unavailable();
    const readId = frame.readId;
    if (typeof readId !== "string" || !UUID_V4.test(readId) || readId === expected.canonicalReadId) return unavailable();
    // A read id is single use from the first time it is seen with a well-formed frame, whatever happens next.
    if (!claim(readId)) return unavailable();
    if (!same(closedKeys(frame.owner, COWORK_GUIDED_FRAME_OWNER_KEYS), expected.owner, COWORK_GUIDED_FRAME_OWNER_KEYS)
      || !same(closedKeys(frame.views, COWORK_GUIDED_FRAME_VIEW_KEYS), expected.views, COWORK_GUIDED_FRAME_VIEW_KEYS)
      || !same(closedKeys(frame.limits, Object.keys(COWORK_GUIDED_FRAME_LIMITS)), expected.limits, Object.keys(COWORK_GUIDED_FRAME_LIMITS))) return unavailable();
    closedKeys(frame.snapshot, COWORK_GUIDED_FRAME_SNAPSHOT_KEYS);
    return Object.freeze({ snapshot: frame.snapshot });
  } catch { return unavailable(); }
}

interface Captured {
  readonly trusted: string;
  readonly registration: Readonly<{ sessionId: string; workspaceId: string; backendSessionId: string; backendGeneration: number; bootId: string; incarnationId: string; leaseEpoch: number }>;
  readonly source: Readonly<{ sourceId: string; revision: number; root: string; access: "read-only" | "read-write" }>;
  readonly expected: Omit<CoworkGuidedFrameExpectation, "canonicalReadId">;
}
/** The conversation's canonical root and cwd, derived from the rows exactly as the Slice A capture derives them. */
function canonicalView(records: CoworkRepository, workspaceId: string, sessionId: string, sourceId: string): { root: string; cwd: string } {
  try {
    const binding = records.binding(sessionId);
    if (binding.workspaceId !== workspaceId || binding.sourceId !== sourceId) return unavailable();
    const root = coworkGuestSourceRoot(records.source(workspaceId, sourceId)), relative = relativeCoworkPath(binding.relativeCwd);
    return { root, cwd: `${root}${relative === "." ? "" : `/${relative}`}` };
  } catch { return unavailable(); }
}
/** Copy and validate the capture ONCE. Refuses a capture with no reader plan, one that disagrees with itself, or one whose
 * workspace, source, root and cwd are not what the canonical rows say for this conversation (a forged capture-shaped object
 * cannot widen or deepen the view). `readerRegistrationId` and `launchId` cannot be re-derived from rows and are taken
 * from the capture on trust: activation must pass only the capture the Slice A capture function returned. */
function captured(value: unknown, records: CoworkRepository): Captured {
  const trusted = text(field(value, "trustedQuerySessionId")), backendSessionId = text(field(value, "backendSessionId"));
  const sessionId = text(field(value, "sessionId")), workspaceId = text(field(value, "workspaceId")), incarnationId = text(field(value, "incarnationId"));
  const bootId = field(value, "bootId"), backendGeneration = counter(field(value, "backendGeneration")), leaseEpoch = counter(field(value, "leaseEpoch"));
  if (trusted !== backendSessionId || typeof bootId !== "string" || !BOOT.test(bootId)) return unavailable();
  const sourceData = closedKeys(field(value, "source"), ["sourceId", "revision", "root", "access"]);
  const source = Object.freeze({ sourceId: text(sourceData.sourceId), revision: counter(sourceData.revision), root: typeof sourceData.root === "string" ? sourceData.root : unavailable(),
    access: sourceData.access === "read-only" || sourceData.access === "read-write" ? sourceData.access : unavailable() });
  const cwd = field(value, "cwd");
  const canonical = canonicalView(records, workspaceId, sessionId, source.sourceId);
  if (canonical.root !== source.root || canonical.cwd !== cwd) return unavailable();
  // The reader plan is mandatory, and the registration id is only presence-checked: the frame carries no such field.
  if (typeof cwd !== "string" || typeof field(value, "readerRegistrationId") !== "string" || !ID.test(field(value, "readerRegistrationId") as string)) return unavailable();
  const views = closedKeys(field(value, "views"), COWORK_GUIDED_FRAME_VIEW_KEYS), limits = closedKeys(field(value, "limits"), Object.keys(COWORK_GUIDED_FRAME_LIMITS));
  if (views.sourceRoot !== source.root || views.sourceCwd !== cwd || !(cwd === source.root || cwd.startsWith(`${source.root}/`))
    || views.sharedRoot !== COWORK_SHARED_INSTRUCTION_VIEW || views.sharedPath !== SHARED_PATH
    || !same(limits, COWORK_GUIDED_FRAME_LIMITS, Object.keys(COWORK_GUIDED_FRAME_LIMITS))) return unavailable();
  return Object.freeze({ trusted, source, registration: Object.freeze({ sessionId, workspaceId, backendSessionId, backendGeneration, bootId, incarnationId, leaseEpoch }),
    expected: Object.freeze({
      owner: Object.freeze({ logicalSessionId: sessionId, backendSessionId, incarnationId, leaseEpoch, bootId, generation: backendGeneration }),
      views: Object.freeze({ sourceRoot: views.sourceRoot as string, sourceCwd: views.sourceCwd as string, sharedRoot: COWORK_SHARED_INSTRUCTION_VIEW, sharedPath: SHARED_PATH }),
      limits: COWORK_GUIDED_FRAME_LIMITS }) });
}

/** The live slot answer, cross-checked against the capture. Synchronous and cheap; any difference is a refusal. */
function liveRegistration(c: Captured, registration: CoworkGuidedReaderDeps["registration"]): CoworkContextRegistration {
  const live = registration(c.trusted);
  if (live === undefined) return unavailable();
  const r = c.registration, sources = field(live, "admittedSources");
  if (field(live, "trustedQuerySessionId") !== c.trusted || field(live, "state") !== "active" || !Array.isArray(sources) || sources.length !== 1
    || (Object.keys(r) as (keyof typeof r)[]).some(key => field(live, key) !== r[key])) return unavailable();
  const s = closedKeys(sources[0], ["sourceId", "revision", "root", "access"]);
  if (s.sourceId !== c.source.sourceId || s.revision !== c.source.revision || s.root !== c.source.root || s.access !== c.source.access) return unavailable();
  return live;
}

interface Shared { readonly captured: Captured; readonly registration: CoworkGuidedReaderDeps["registration"]; readonly frames: CoworkGuidedFramePort; readonly claim: (readId: string) => boolean }
/** One invocation's protected reader. `original` is the exact signal the SDK handed this callback; the resolver's
 * derived signal is used only to notice that the resolver stopped waiting. */
function guidedReader(shared: Shared, original: AbortSignal): CoworkProtectedInstructionReader {
  const { captured: c } = shared;
  let used = false;
  return { async read(request, { signal: derived }) {
    if (used) return unavailable();
    used = true;
    // 1. The canonical request and the registration the resolver used must still be this owner's, and the slot must still vouch.
    const before = liveRegistration(c, shared.registration), scopes = request.scopes;
    if (stable(before) !== stable(request.registration) || request.sharedImportRoot !== COWORK_SHARED_INSTRUCTION_VIEW || scopes.shared.path !== "/workspace/.winter/WINTER.md"
      || scopes.source.sourceId !== c.source.sourceId || scopes.source.root !== c.expected.views.sourceRoot || scopes.source.cwd !== c.expected.views.sourceCwd) return unavailable();
    // 2. The SDK is asked with the ORIGINAL callback signal, once. Its identity is correlation only.
    const raw = await shared.frames.readFrame(original);
    // A late or aborted reply is dropped before any parsing, so it cannot consume a read id or reach the mapper.
    if (original.aborted || derived.aborted) return unavailable();
    if (stable(liveRegistration(c, shared.registration)) !== stable(before)) return unavailable();
    // 3. Strict parse; ONLY the snapshot goes to the existing mapper, with the resolver's canonical request.
    const frame = parseCoworkGuidedReaderFrame(raw, { canonicalReadId: request.readId, ...c.expected }, shared.claim);
    return mapStructuredCoworkInstructions(frame.snapshot, request);
  } };
}

/** Unwired parent callback for ONE guided owner. Each SDK callback invocation gets its own copy of the existing
 * handler (and so its own resolver, planner and final guards) bound to its own original signal. The existing
 * handler's result is returned directly: nothing external runs after the resolver's final canonical guard. */
export function createCoworkGuidedRuntimeContextHandler(deps: CoworkGuidedReaderDeps): CoworkRuntimeContextHandler {
  const c = captured(deps.capture, deps.records), registration = deps.registration, frames = deps.frames;
  if (typeof registration !== "function" || frames === null || typeof frames !== "object" || typeof frames.readFrame !== "function") return unavailable();
  const ids = new CoworkGuidedReadIdSet();
  const shared: Shared = { captured: c, registration, frames, claim: readId => ids.claim(readId) };
  const base = { records: deps.records, grants: deps.grants, currentBootId: deps.currentBootId, ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) };
  return async (request, options) => {
    try {
      const own = closedKeys(options, ["signal", "trustedQuerySessionId"]), signal = own.signal;
      if (own.trustedQuerySessionId !== c.trusted || !(signal instanceof AbortSignal) || signal.aborted) return unavailable();
      if (registration(c.trusted) === undefined) return unavailable();
      const handler = createCoworkRuntimeContextHandler({ ...base, trustedQuerySessionId: c.trusted, currentRegistration: registration, reader: guidedReader(shared, signal) });
      return await handler(request, Object.freeze({ signal, trustedQuerySessionId: c.trusted }));
    } catch { return unavailable(); }
  };
}
