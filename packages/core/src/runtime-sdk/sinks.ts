import type { NewSessionEvent } from "@norma/protocol";
import type { BridgeLogger } from "./bridge-common";
import type { RuntimeStateDb } from "../runtime-state/db";

/**
 * **Notification and schedule sinks** (P8c-11, Task 2.4) — the daemon's own effects for two of the
 * child's tool calls, observed off the PROJECTED `tool_call`/`tool_result` stream rather than
 * relied on from the child's own tool execution: "the child's own effects are not relied upon (a
 * child dies at idle)".
 *
 * ── `push_notification` (Winter's `PushNotification`) ───────────────────────────────────────────
 *
 * Mirrors the retired engine's `ctx.notify` bridge (`agent/engine.ts`'s `runTurn`, pre-8b) exactly:
 * emit `notification_requested` unconditionally, then fire the headless macOS fallback ONLY when
 * nobody is attached right now. Winter's OWN `PushNotification` executor
 * (`winter-agent-sdk/packages/runtime/src/tools/impl/push-notification.ts`) has an injectable
 * `configurePushNotifier` seam, but that seam lives INSIDE the spawned child process — Norma's
 * daemon cannot reach into a separate OS process to call it, so it is dead wiring from this side
 * regardless of what a future SDK does with it; the daemon's own path is this sink, driven off the
 * ordinary wire `tool_use`/`tool_result` the projector already turns into `tool_call`/`tool_result`
 * (`PushNotification` earns no special projector branch — see `event-coverage.ts`).
 *
 * Winter's args carry no `title` at all (`{message, status:"proactive"}`, unlike the retired
 * engine's own `{message, title?}`) — `NOTIFICATION_DEFAULT_TITLE` below is therefore not a
 * fallback for an omitted field, it is the ONLY title this leg can ever produce.
 *
 * ── `schedule` (Winter's `CronCreate`/`CronDelete`/`CronList`) ──────────────────────────────────
 *
 * All three Winter tool names collapse onto Norma's ONE `schedule` name (`tool-names.ts`'s
 * `WINTER_NORMA_TOOL_PAIRS`, "one tool, one gate decision") — which means the PROJECTED `tool_call`
 * this sink sees has already lost which of the three it was. The three input shapes are disjoint
 * by construction (create needs `cron`+`prompt`; delete needs only `id`; list needs neither), so
 * this sink disambiguates by ARGS SHAPE rather than by tool name — the only information left once
 * the rename has happened.
 *
 * Winter's `CronCreate`/`CronDelete` fully execute inside the child (an in-memory Map, or a
 * `<projectDir>/.winter/scheduled_tasks.json` file when `durable:true` — see the SDK's `cron.ts`),
 * but NOTHING ever turns a stored job into a running prompt at the right wall-clock moment except
 * Norma's own `routines/scheduler.ts` — and per P8c-11 that is the only mechanism this daemon may
 * rely on, since "a child dies at idle" makes the child's own store inert the moment nobody is
 * attached. So every `CronCreate` this sink observes becomes a REAL, persistent `RoutineStore` row
 * (mirroring the retired `schedule` tool's own `op:"create"` — see `git show
 * 1e732738^:packages/core/src/agent/tools/schedule.ts`), and `recurring`/`durable` are NOT carried
 * into that mirror: `RoutineStore` has no one-shot concept (a routine reruns per its spec until
 * deleted/disabled), so a `recurring:false` request has no honest mirror and is deliberately NOT
 * mirrored at all (logged, not silently dropped) rather than misrepresented as a repeating job —
 * a documented gap, not an oversight; `durable` is irrelevant to the mirror's OWN persistence
 * (the daemon-side `RoutineStore` row is always durable, because it is the only copy anything ever
 * reads back).
 *
 * **The id-space mismatch, and why creation happens on the RESULT, not the call.** `CronCreate`
 * mints its OWN job id inside the child (`randomUUID()`) and returns it in the tool_result; a later
 * `CronDelete(id=<that id>)` from the model addresses THAT id, never Norma's `RoutineStore`'s own.
 * Mirroring on the CALL (before the child's own validation has run) would risk creating an orphaned
 * Norma routine for an input the child's `validateCronExpression` was about to reject — so this
 * sink stashes the parsed create args on the CALL and only actually calls `routines.create` once
 * the matching RESULT confirms the child accepted it (an `isError` result is never mirrored), at
 * which point the child's minted id is read from the result and mapped to the freshly-created
 * Norma routine id. `CronDelete` has no equivalent risk (deleting is idempotent) and fires at the
 * call.
 *
 * ── IDEMPOTENCY (P8c-11's own obligation: "a replay never re-fires") ────────────────────────────
 *
 * A `seen` set keyed by `sessionId:callId` guards every side effect this module performs (the
 * notification fire, the create-args stash, the delete) — the FAST path, in-memory, for the
 * lifetime of this `sinksFor(...)` instance. It protects a live session against the projector
 * re-handing it the same accepted message (a resume that mis-tracks its cursor, a driver bug),
 * which is the failure mode the projector's own idempotency contract is about.
 *
 * P8d-13 adds the DURABLE half: `SinkCallStore` (`createSinkCallStore`, backed by
 * `runtime-state.db`'s `runtime_sink_calls` table — now a lane-2 file, unlike when this obligation
 * was first carried) — consulted only when `seen` does not already know the call, so a restarted
 * daemon (a fresh `sinksFor(...)` instance, empty `seen`) still recognizes a call it fired before
 * going down. `generation` is part of the durable key (`ProjectedToolCall.generation`, optional —
 * every real event carries it once the caller supplies one; see `SinkCallStore`'s own doc) because
 * the router mints a fresh `call_id` space per generation, and a replayed call from an EARLIER
 * generation must never collide with the same id minted fresh in a later one.
 */

const NOTIFICATION_DEFAULT_TITLE = "Norma";

export interface ProjectedToolCall {
  sessionId: string;
  threadId: string;
  callId: string;
  /** The NORMA name (post-`renameTool`) — `"push_notification"` or `"schedule"`; anything else is
   *  ignored by both sinks. */
  name: string;
  argsJson: string;
  /** P8d-13: which GENERATION this call belongs to, for the durable dedupe key. Absent when the
   *  caller cannot supply one — the durable door is then simply skipped and the in-memory `seen`
   *  set is this call's only guard, exactly this module's pre-8d behaviour. */
  generation?: number;
}

export interface ProjectedToolResult {
  sessionId: string;
  threadId: string;
  callId: string;
  output: string;
  isError: boolean;
  /** P8d-13, mirrors `ProjectedToolCall.generation` — see there. */
  generation?: number;
}

/**
 * P8d-13's durable half of the sink dedupe. `hasSeen`/`markSeen` never throw: a durable-store
 * failure (a closed db mid-shutdown, say) costs only the durable guard for that one call — the
 * in-memory `seen` set is still this process's guard for the rest of its life, and a real duplicate
 * missed here is caught by the SAME restart-survival property one boot later at worst (the row
 * would then already exist and `hasSeen` would answer true).
 */
export interface SinkCallStore {
  hasSeen(winterSessionId: string, generation: number, callId: string): boolean;
  markSeen(winterSessionId: string, generation: number, callId: string): void;
}

/** The production `SinkCallStore`, over `runtime-state.db`'s `runtime_sink_calls` table (schema
 *  v6, P8d-13). `at` is epoch milliseconds — the same unit `retention.ts`'s `pruneSinkCalls` cutoff
 *  uses, so the two never disagree about what "old" means. */
export function createSinkCallStore(rs: RuntimeStateDb): SinkCallStore {
  return {
    hasSeen(winterSessionId, generation, callId) {
      try {
        return (
          rs.db
            .query<{ one: number }, [string, number, string]>(
              "SELECT 1 AS one FROM runtime_sink_calls WHERE winter_session_id = ? AND generation = ? AND call_id = ?",
            )
            .get(winterSessionId, generation, callId) != null
        );
      } catch {
        return false; // never let a durable-store READ failure suppress a real notification
      }
    },
    markSeen(winterSessionId, generation, callId) {
      try {
        rs.db.run("INSERT OR IGNORE INTO runtime_sink_calls (winter_session_id, generation, call_id, at) VALUES (?, ?, ?, ?)", [
          winterSessionId,
          generation,
          callId,
          Date.now(),
        ]);
      } catch {
        /* best-effort: the in-memory `seen` set is still this process's guard */
      }
    },
  };
}

/** The structural subset of `RoutineStore` this module calls. */
export interface RoutineSink {
  create(input: { spec: string; prompt: string; cwd?: string }): { id: string };
  delete(id: string): boolean;
}

export interface SinksDeps {
  routines: RoutineSink;
  /** Appends + broadcasts `notification_requested` (mirrors `CanUseToolDeps.emit` elsewhere in
   *  `runtime-sdk/`). */
  emit: (event: NewSessionEvent) => void;
  /** `SessionHub.attachedCount` — the SAME headless-fallback trigger the retired engine used. */
  attachedCount: (sessionId: string) => number;
  /** `notify-fallback.ts`'s `notifyHeadless`, or a test spy. Defaults to a no-op — a daemon that
   *  omits this dependency simply never raises the OS notification (still emits the event). */
  notifyFallback?: (title: string, message: string) => void;
  /** The session's own working directory, for a mirrored routine's `cwd` (retired tool: "cwd is
   *  optional and defaults to this session's working directory"). Omitted ⇒ `RoutineStore.create`'s
   *  own default (`process.cwd()`). */
  cwdFor?: (sessionId: string) => string | undefined;
  log?: BridgeLogger;
  /** P8d-13's durable dedupe store (`createSinkCallStore`, over `runtime-state.db`). Optional —
   *  omitted (every test that never exercises restart-survival, and any daemon whose runtime spine
   *  could not open) leaves the in-memory `seen` set as the only guard, exactly this module's
   *  pre-8d behaviour. */
  durable?: SinkCallStore;
}

export interface Sinks {
  onToolCall(event: ProjectedToolCall): void;
  onToolResult(event: ProjectedToolResult): void;
}

interface PendingCronCreate { cron: string; prompt: string }

/** P8d-13: GENERATION-SCOPED when available. The router mints a fresh `call_id` space per
 *  generation, and `sinksFor` is constructed ONCE per daemon boot (`hub.addObserver` routes every
 *  session's, every generation's, projected events through the SAME instance) — so without
 *  `generation` in the key, a call id reused across two generations of the SAME session would
 *  collide in the in-memory `seen` set exactly as this module's own header warns it must not for
 *  the durable store. Falls back to the un-scoped form when the caller cannot supply a generation
 *  (this module's pre-8d behaviour), so an existing caller that never sets `generation` is
 *  unaffected. */
function key(sessionId: string, callId: string, generation?: number): string {
  return generation === undefined ? `${sessionId}:${callId}` : `${sessionId}:${generation}:${callId}`;
}

function parsePushNotificationArgs(argsJson: string): { message: string } | undefined {
  try {
    const raw = JSON.parse(argsJson) as Record<string, unknown>;
    const message = raw.message;
    return typeof message === "string" && message.length > 0 ? { message } : undefined;
  } catch {
    return undefined;
  }
}

function parseCronCreateArgs(argsJson: string): PendingCronCreate | undefined {
  try {
    const raw = JSON.parse(argsJson) as Record<string, unknown>;
    const cron = raw.cron;
    const prompt = raw.prompt;
    return typeof cron === "string" && cron.length > 0 && typeof prompt === "string" && prompt.length > 0
      ? { cron, prompt }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCronDeleteArgs(argsJson: string): { id: string } | undefined {
  try {
    const raw = JSON.parse(argsJson) as Record<string, unknown>;
    const id = raw.id;
    // Disjoint from create by construction: a delete-shaped call carries `id` and neither
    // `cron` nor `prompt`. Checked explicitly (not just "id is present") so a future shape that
    // happens to carry both an `id` and a `cron` — unlikely, but this is a collapsed tool name —
    // is read as a create, never silently deleted.
    return typeof id === "string" && id.length > 0 && raw.cron === undefined && raw.prompt === undefined
      ? { id }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Winter's `CronCreate` result — pinned shape per `cron.ts`'s T8 note 1: `{id, humanSchedule,
 *  recurring, durable?}`, `durable` omitted when false. Only `id` is read here. */
function parseCronCreateResultId(output: string): string | undefined {
  try {
    const raw = JSON.parse(output) as Record<string, unknown>;
    const id = raw.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function sinksFor(deps: SinksDeps): Sinks {
  const log = deps.log;
  const seen = new Set<string>();

  /** P8d-13: `seen` first (the fast path — a hit never even reaches the durable store), then
   *  `deps.durable` when a `generation` was supplied. A hit there ALSO warms `seen`, so the second
   *  and later replays of the same call in this SAME process skip the durable round-trip too. */
  function alreadySeen(sessionId: string, generation: number | undefined, callId: string): boolean {
    const k = key(sessionId, callId, generation);
    if (seen.has(k)) return true;
    if (generation !== undefined && deps.durable?.hasSeen(sessionId, generation, callId)) {
      seen.add(k);
      return true;
    }
    return false;
  }

  /** The mirror of `alreadySeen`: records the call as seen in BOTH the fast path and (when a
   *  generation is available) the durable one. */
  function markSeen(sessionId: string, generation: number | undefined, callId: string): void {
    seen.add(key(sessionId, callId, generation));
    if (generation !== undefined) deps.durable?.markSeen(sessionId, generation, callId);
  }
  /** `sessionId:callId` of a create call → its parsed args, awaiting the matching tool_result. */
  const pendingCreates = new Map<string, PendingCronCreate>();
  /** Winter's minted job id → the mirrored `RoutineStore` id, so a later `CronDelete` (which
   *  addresses the CHILD's id, never Norma's) can resolve the row to remove. Not scoped per
   *  session: Winter mints these with `randomUUID()`, which is unique enough on its own, and a
   *  `CronDelete` carries no session-scoping information beyond the id it was handed. */
  // carry: never pruned — an entry only leaves via a matching CronDelete. Bounded by the number of
  // routines ever mirrored in this daemon process's lifetime, not by session count or time; fine
  // at today's scale, but a long-lived daemon with many one-off schedule creates and few deletes
  // would grow this unboundedly. Revisit alongside the durable-dedupe carry (sinks.ts's own header
  // doc comment) if that ever matters in practice.
  const winterToNormaRoutineId = new Map<string, string>();

  function fireNotification(sessionId: string, threadId: string, message: string): void {
    const title = NOTIFICATION_DEFAULT_TITLE;
    try {
      deps.emit({ type: "notification_requested", sessionId, threadId, title, message });
    } catch (err) {
      log?.error(`push_notification sink: failed to emit notification_requested session=${sessionId}: ${(err as Error).message}`);
      return;
    }
    if (deps.attachedCount(sessionId) === 0) {
      try {
        deps.notifyFallback?.(title, message);
      } catch (err) {
        // Best-effort, matching notify-fallback.ts's own contract: a broken osascript must never
        // be treated as a sink failure.
        log?.error(`push_notification sink: headless fallback threw session=${sessionId}: ${(err as Error).message}`);
      }
    }
  }

  function commitCronCreate(sessionId: string, args: PendingCronCreate, winterJobId: string): void {
    let created: { id: string };
    try {
      created = deps.routines.create({ spec: args.cron, prompt: args.prompt, cwd: deps.cwdFor?.(sessionId) });
    } catch (err) {
      // A spec Norma's own parser rejects (grammar drift from Winter's `validateCronExpression`,
      // however unlikely) or an invalid policy default — logged, never mirrored, never thrown:
      // the child's own CronCreate already succeeded and answered the model, so a mirror failure
      // here must not surface as a tool error the model never actually got.
      log?.error(`schedule sink: RoutineStore.create failed for winter job ${winterJobId} session=${sessionId}: ${(err as Error).message}`);
      return;
    }
    winterToNormaRoutineId.set(winterJobId, created.id);
    log?.info(`schedule sink: mirrored CronCreate winterJob=${winterJobId} → routine=${created.id} session=${sessionId}`);
  }

  return {
    onToolCall(event: ProjectedToolCall): void {
      const k = key(event.sessionId, event.callId, event.generation);
      if (event.name === "push_notification") {
        if (alreadySeen(event.sessionId, event.generation, event.callId)) return;
        markSeen(event.sessionId, event.generation, event.callId);
        const parsed = parsePushNotificationArgs(event.argsJson);
        if (parsed === undefined) {
          log?.error(`push_notification sink: unparseable args session=${event.sessionId} call=${event.callId}`);
          return;
        }
        fireNotification(event.sessionId, event.threadId, parsed.message);
        return;
      }

      if (event.name !== "schedule") return;

      const create = parseCronCreateArgs(event.argsJson);
      if (create !== undefined) {
        if (alreadySeen(event.sessionId, event.generation, event.callId)) return;
        markSeen(event.sessionId, event.generation, event.callId);
        pendingCreates.set(k, create);
        return;
      }

      const del = parseCronDeleteArgs(event.argsJson);
      if (del !== undefined) {
        if (alreadySeen(event.sessionId, event.generation, event.callId)) return;
        markSeen(event.sessionId, event.generation, event.callId);
        const normaId = winterToNormaRoutineId.get(del.id);
        if (normaId === undefined) {
          // Unknown to this daemon process — could be a durable job created by an earlier daemon
          // run (this map is in-memory only), or the model passing a bogus id. CronDelete's own
          // contract treats an unknown id as a normal, non-error lookup (see cron.ts's T8 note 2);
          // mirrored here the same way — a no-op, not a failure.
          log?.info(`schedule sink: CronDelete for an id this daemon never mirrored (id=${del.id}) — no routine to remove`);
          return;
        }
        winterToNormaRoutineId.delete(del.id);
        deps.routines.delete(normaId);
        log?.info(`schedule sink: mirrored CronDelete winterJob=${del.id} → deleted routine=${normaId} session=${event.sessionId}`);
        return;
      }

      // Neither create- nor delete-shaped: a CronList call (`{}` input). Nothing to mirror — see
      // the module doc comment on why CronList's own (weaker) view is a documented gap, not fixed
      // here: the child has already answered the model by the time this sink sees the call.
    },

    onToolResult(event: ProjectedToolResult): void {
      const k = key(event.sessionId, event.callId, event.generation);
      const pending = pendingCreates.get(k);
      if (pending === undefined) return;
      pendingCreates.delete(k);
      if (event.isError) {
        log?.info(`schedule sink: CronCreate errored on the child — not mirrored session=${event.sessionId} call=${event.callId}`);
        return;
      }
      const winterJobId = parseCronCreateResultId(event.output);
      if (winterJobId === undefined) {
        log?.error(`schedule sink: CronCreate result had no id — not mirrored session=${event.sessionId} call=${event.callId}`);
        return;
      }
      commitCronCreate(event.sessionId, pending, winterJobId);
    },
  };
}
