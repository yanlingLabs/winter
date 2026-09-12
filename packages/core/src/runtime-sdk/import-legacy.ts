// Winter Phase 8c (P8c-6, ruling): "engine-era sessions become continuable by IMPORT." An
// engine-era `RuntimeSessionRecord` (§17's boot backfill: `runtimeKind: "winter-agent"`, no
// `backendSessionId` — `leg.ts`'s `sessionLegOf` reads that as `"engine"`) has no Winter transcript
// to resume, ever — P8b-22's refusal is permanent for that record AS IT STANDS. This module is the
// other half of that refusal: `session.send` on such a session (the ONE call site, `ipc/server.ts`)
// converts the session's own `SessionEvent` log into Claude-dialect entries and appends them as a
// NEW backend transcript UNDER THE SAME NORMA SESSION ID, so the record can then genuinely resume on
// the Winter leg — never a resume of the ORIGINAL (there is nothing to resume), and never a new
// Norma session (the id, title and every other Norma-side fact survive untouched).
//
// WHAT NEVER CROSSES THIS DOOR. `reasoning_item` events are DROPPED, unconditionally — they carry
// opaque provider state (`itemJson`, CLAUDE.md's own "session JSONL is its only sink" rule) that
// means nothing outside the provider that emitted it, and converting one into a Claude-dialect block
// would be inventing content the model never produced. Every event outside the conversational set
// below (session_created, harness_attached/detached, turn_started/completed, assistant_delta,
// approval/plan/task/notification events, …) is silently skipped — it either has no Claude-dialect
// analogue or (assistant_delta) is a transient the source log never persisted either.
//
// THE COALESCING RULE. A real Claude turn is not "one event, one transcript entry" — a single
// assistant turn may emit narration text AND one or more tool calls together, and the tools that ran
// answer together before the model speaks again. Norma's own log records those as SEPARATE events
// (one `assistant_message` for the text, one `tool_call` per call, one `tool_result` per call), so a
// literal one-entry-per-event conversion would write consecutive same-role dialect entries — two
// "assistant" entries in a row with nothing from the "user" side between them, which is not the
// shape a resumed session's provider expects. This module instead BUFFERS same-role runs: every
// `assistant_message`/`tool_call` since the last flush accumulates into ONE assistant entry's
// content array (text blocks, then tool_use blocks, in event order), and every `tool_result` since
// the last flush accumulates into ONE user entry's content array — exactly the shape a real
// assistant turn (text + tool_use[]) and its answering user turn (tool_result[]) actually have. A
// genuine `user_message` always flushes first (it is a real user turn, never merged with a synthetic
// tool-result batch) and becomes its own plain-text entry.
//
// FIELD SHAPES ARE THE WINTER RUNTIME'S OWN (`../../winter-agent-sdk/packages/runtime/src/store/
// dialect.ts`'s `DialectEntryBase`/`userEntry`/`assistantEntry`, and `ContentBlock`'s `tool_use`/
// `tool_result` shapes, `engine.ts:265-297`) — mirrored here rather than imported (the sibling repo
// is read-only for 8c, Global Constraints: "neither sibling repo is modified"). `error` (not
// Anthropic's `is_error`) is the tool_result marker that shape defines; a `tool_result` this module
// writes carries it only when Norma's own `isError` was true, matching the ContentBlock's own
// "optional, set only when true" contract.
//
// THE WRITER-LEASE DISCOVERY (measured, real-binary e2e). `WinterCompatibilitySessionStore.append()`
// (`packages/sdk/src/store/session-store.ts`) unconditionally `acquireLease`s the session's
// `<projectKey>/<sessionId>.lock` on every call — durably, keyed by the CALLING PROCESS's pid, with
// no public release door (`leases.ts`'s exported surface is `isPidAlive`/`readLeaseInfo`/
// `acquireLease` only). Every ordinary Winter session's ONLY writer is its own spawned child, so
// same-pid re-entry has always made this invisible; THIS door is the first host-process (daemon)
// writer, and the daemon does not exit after writing — so without doing anything about it, the
// child `session-driver.ts` spawns moments later to actually run the imported session would resume
// into `ResumeTargetError("locked", "... is in use by another live process (pid <daemon>)")`,
// EVERY time, unconditionally. `acquireLease` only ever yields a lease to a DIFFERENT pid when the
// existing holder is DEAD (`isPidAlive` false) — which the daemon, obviously, is not. Since the
// sibling repo is read-only for 8c (no release API can be added there), this function best-effort
// REMOVES the lock file it just implicitly took, in the same `<home>/projects/<projectKey>/` layout
// `session-driver.ts`'s own `backendRoot` already names — nothing else can be racing this delete (no
// other process has ever touched this brand-new backend id), so the child's very next `acquireLease`
// finds no file at all and takes the fast, uncontested `createExclusive` path under its own pid.
// Never fatal: a failure to remove it degrades to the pre-fix behaviour (a real, typed refusal on
// the next send) rather than losing the imported transcript, which has already landed on disk by
// the time this runs.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { WinterCompatibilitySessionStore, transcriptProjectKey, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import type { SessionEvent } from "@norma/protocol";
import { MAIN_THREAD } from "../projector";
import { RuntimeSessionRecords, type RuntimeSessionState } from "../runtime-state/records";
import { sessionLegOf } from "./leg";

export interface ConvertEngineEraLogOpts {
  /** The Norma session id — becomes the dialect entries' OWN `sessionId` field is the BACKEND id
   *  (see `backendSessionId` below); this is carried only for callers that want it in scope. */
  sessionId: string;
  /** The fresh backend transcript uuid the converted log is written under (`Options.resume`'s
   *  target on the session's very next Winter-leg incarnation). */
  backendSessionId: string;
  cwd: string;
  /** The engine/producer version stamped onto every entry (`DialectEntryBase.version`) — informational
   *  only; nothing round-trips it back into behaviour. */
  version: string;
}

interface Chain {
  parentUuid: string | null;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; error?: true };

function baseFields(opts: ConvertEngineEraLogOpts, chain: Chain): {
  uuid: string; parentUuid: string | null; sessionId: string; timestamp: string; cwd: string; version: string; isSidechain: false;
} {
  return {
    uuid: randomUUID(),
    parentUuid: chain.parentUuid,
    sessionId: opts.backendSessionId,
    timestamp: new Date().toISOString(),
    cwd: opts.cwd,
    version: opts.version,
    isSidechain: false,
  };
}

function parseToolInput(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    // A tool_call whose argsJson didn't parse (a corrupt or truncated engine-era row) still gets a
    // block — the raw text, so nothing about the call is silently lost — rather than aborting the
    // whole import over one bad entry.
    return { raw: argsJson };
  }
}

/**
 * Converts one session's engine-era `SessionEvent` log into Claude-dialect `SessionStoreEntry`
 * objects, MAIN THREAD ONLY (`threadId === "main"`, or absent — `user_message`/`turn_started`/… on
 * the shared thread base never carry a subagent's id): a subagent's own thread has no analogue in
 * the imported conversation, and P8c-6 asks only that the main conversation become continuable.
 *
 * Pure and synchronous — every uuid this call mints is fresh, so calling it twice on the same log
 * produces two independent (but structurally identical) transcripts; callers own idempotency.
 */
export function convertEngineEraLog(events: readonly SessionEvent[], opts: ConvertEngineEraLogOpts): SessionStoreEntry[] {
  const entries: SessionStoreEntry[] = [];
  let parentUuid: string | null = null;
  let pending: { role: "assistant" | "user"; blocks: Block[] } | undefined;

  const flush = (): void => {
    if (pending === undefined) return;
    const { role, blocks } = pending;
    pending = undefined;
    if (blocks.length === 0) return;
    const entry: SessionStoreEntry = { type: role, ...baseFields(opts, { parentUuid }), message: { role, content: blocks } };
    entries.push(entry);
    parentUuid = entry.uuid as string;
  };

  const bufferInto = (role: "assistant" | "user", block: Block): void => {
    if (pending?.role !== role) {
      flush();
      pending = { role, blocks: [] };
    }
    pending.blocks.push(block);
  };

  for (const event of events) {
    const threadId = (event as { threadId?: string }).threadId;
    if (threadId !== undefined && threadId !== MAIN_THREAD) continue;
    switch (event.type) {
      case "user_message": {
        flush();
        const entry: SessionStoreEntry = { type: "user", ...baseFields(opts, { parentUuid }), message: { role: "user", content: event.text } };
        entries.push(entry);
        parentUuid = entry.uuid as string;
        break;
      }
      case "assistant_message": {
        if (event.text.length > 0) bufferInto("assistant", { type: "text", text: event.text });
        break;
      }
      case "tool_call": {
        bufferInto("assistant", { type: "tool_use", id: event.callId, name: event.name, input: parseToolInput(event.argsJson) });
        break;
      }
      case "tool_result": {
        const block: Block = { type: "tool_result", tool_use_id: event.callId, content: event.output };
        if (event.isError) block.error = true;
        bufferInto("user", block);
        break;
      }
      // reasoning_item: DROPPED — opaque provider state, never converted (this file's own header).
      // Every other event type: no Claude-dialect analogue; skipped without flushing (it does not
      // belong to either side of the conversation and must not break an in-progress buffer).
      default:
        break;
    }
  }
  flush();
  return entries;
}

export interface ImportLegacySessionStore {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
}

export interface ImportLegacyDeps {
  /** The daemon's `NORMA_HOME` — same value every other Winter-leg door in this package takes. */
  home: string;
  /** The product session's own event log + metadata. */
  store: {
    read(sessionId: string): SessionEvent[];
    meta(sessionId: string): { cwd?: string | null };
  };
  records: RuntimeSessionRecords;
  /** Test seam: defaults to `new WinterCompatibilitySessionStore({ winterHome: home })`. */
  compatStore?: ImportLegacySessionStore;
  /** The Winter SDK version to stamp on converted entries. Defaults to `"unknown"` — informational
   *  only (see `ConvertEngineEraLogOpts.version`'s own note). */
  version?: string;
}

/**
 * WS-16 §4's state machine (`records.ts`'s `ALLOWED_TRANSITIONS`) admits `ready` from exactly two
 * states: `creating` (not reachable here — the record already exists) and `unavailable`; there is
 * no `X -> X` self-transition for any state. Every state 8a's boot backfill could actually leave an
 * engine-era record resting in (`settlePathFor`: always `exited`, `unavailable`, or `archived`)
 * therefore walks through `unavailable` first — the shortest legal path, listed once so the
 * transition loop below always fires AT LEAST one transition (which is also where this function's
 * one write — the new backend id, health and `importedFrom` — actually lands: `transition()` has no
 * patch-with-no-state-change door). `ready`'s own "path to ready" is a real two-hop loop for the
 * same reason — 8a never actually rests a record there, but a hand-repaired home is not impossible.
 */
const PATH_TO_READY: Readonly<Record<RuntimeSessionState, readonly RuntimeSessionState[]>> = {
  creating: ["ready"],
  ready: ["unavailable", "ready"],
  running: ["idle", "unavailable", "ready"],
  idle: ["unavailable", "ready"],
  exited: ["unavailable", "ready"],
  failed: ["unavailable", "ready"],
  unavailable: ["ready"],
  archived: ["idle", "unavailable", "ready"],
};

export class ImportLegacySessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportLegacySessionError";
  }
}

/**
 * P8c-6's whole mechanism: convert `sessionId`'s engine-era log, append it as a fresh backend
 * transcript, and patch the SAME record so it resumes on the Winter leg from here on.
 *
 * NEVER MINTS A NEW RECORD. `records.create` is `session.create`'s door; this function only ever
 * `transition()`s the row that already exists — the Norma session id, its title, its working
 * directories and every other product-level fact are untouched. Idempotent is NOT claimed: calling
 * this twice on the same (now-imported) record throws, because the record is no longer `"engine"`
 * leg — `ipc/server.ts`'s own call site only ever reaches this once, on the `session_predates_
 * winter_leg` branch.
 */
/**
 * m2 (whole-branch review): TWO concurrent `session.send`s on the SAME engine-era session both
 * read `sessionLegOf(record) === "engine"` before either has written anything — `ipc/server.ts`'s
 * own gate re-checks the leg, not any in-flight state, so nothing there serialises them. Without
 * this map both calls would run `doImport` — converting the log and appending a SECOND backend
 * transcript, or (once the first's `records.transition` has landed) the second's own transition
 * throwing straight into `session_import_failed`. Keyed by the PRODUCT session id (never the
 * backend uuid, which does not exist until a call is already inside `doImport`): a second caller
 * for the same id awaits the FIRST's promise and gets its exact result, one real import either way.
 * Cleared once the promise settles (success or failure) — a later, non-concurrent call on an
 * already-imported session must reach `doImport` fresh and get its ordinary
 * "not an engine-era session" refusal, not a memoized success from a previous era.
 */
const inFlight = new Map<string, Promise<{ backendSessionId: string; entries: number }>>();

export function importEngineEraSession(deps: ImportLegacyDeps, sessionId: string): Promise<{ backendSessionId: string; entries: number }> {
  const existing = inFlight.get(sessionId);
  if (existing !== undefined) return existing;
  const promise = doImport(deps, sessionId).finally(() => {
    inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, promise);
  return promise;
}

async function doImport(deps: ImportLegacyDeps, sessionId: string): Promise<{ backendSessionId: string; entries: number }> {
  const record = deps.records.get(sessionId);
  if (record === undefined) {
    throw new ImportLegacySessionError(`importEngineEraSession: no runtime record for ${sessionId}`);
  }
  if (sessionLegOf(record) !== "engine") {
    throw new ImportLegacySessionError(`importEngineEraSession: ${sessionId} is not an engine-era session (leg: ${sessionLegOf(record) ?? "unrecorded"})`);
  }
  const meta = deps.store.meta(sessionId);
  // The SAME fallback 8a's own boot backfill uses for a workdir-less legacy session (`backfill.ts`):
  // `home`, never a fabricated path. In practice every engine-era CODE session has a real cwd and
  // every dispatch/chat one was minted with `cwd: homedir()` — this branch is a safety net, not the
  // common case.
  const cwd = meta.cwd ?? deps.home;
  // THE PROJECT KEY MUST MATCH WHAT THE RESUMED CHILD WILL RESOLVE FROM ITS OWN `cwd` AT OPEN TIME
  // (`session-driver.ts`'s `assemble()` passes `cwd` into `Options`, never a project key — the
  // Winter runtime derives its own from `cwd`) — so this recomputes it fresh from the LIVE cwd via
  // the identical function `session-driver.ts` uses, rather than trusting `record.transcriptProjectKey`
  // (the key at the ORIGINAL 8a backfill time, which a later `session.setDirs` could have moved on
  // from).
  const projectKey = transcriptProjectKey(cwd);
  const backendSessionId = randomUUID();
  const events = deps.store.read(sessionId);
  const entries = convertEngineEraLog(events, { sessionId, backendSessionId, cwd, version: deps.version ?? "unknown" });
  const usingRealStore = deps.compatStore === undefined;
  const compat = deps.compatStore ?? new WinterCompatibilitySessionStore({ winterHome: deps.home });
  if (entries.length > 0) {
    await compat.append({ projectKey, sessionId: backendSessionId }, entries);
    // See this file's header ("THE WRITER-LEASE DISCOVERY"): `append()` on the REAL store just took
    // an un-releasable, pid-durable lease under THIS (the daemon's) process — remove it so the
    // child `session-driver.ts` spawns next can freely acquire it under its own. `append([])` takes
    // no lease at all (the store's own doc), which is why this is gated on `entries.length > 0` too.
    if (usingRealStore) {
      try {
        unlinkSync(join(deps.home, "projects", projectKey, `${backendSessionId}.lock`));
      } catch {
        // Missing, unremovable, or a store whose lock layout has moved on — degrade to the
        // pre-fix behaviour (a typed refusal on the child's own resume) rather than lose the
        // transcript this call already wrote.
      }
    }
  }
  const path = PATH_TO_READY[record.state];
  path.forEach((to, i) => {
    deps.records.transition(sessionId, to, i > 0 ? {} : {
      backendSessionId,
      transcriptHealth: "clean",
      compatibilityLevel: "conversation",
      importedFrom: "engine-era",
    });
  });
  return { backendSessionId, entries: entries.length };
}
