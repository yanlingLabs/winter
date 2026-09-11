import type { NewSessionEvent } from "@norma/protocol";
import type { BridgeLogger } from "./bridge-common";

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
 * notification fire, the create-args stash, the delete). It is **IN-MEMORY ONLY, for the lifetime
 * of this `sinksFor(...)` instance** — it protects a live session against the projector re-handing
 * it the same accepted message (a resume that mis-tracks its cursor, a driver bug), which is the
 * failure mode the projector's own idempotency contract is about. It does **NOT** survive a daemon
 * restart: a durable, persisted dedupe keyed by (winterSessionId, generation, callId) would need a
 * `runtime-state` schema addition, which is outside this lane's file ownership
 * (`runtime-state/records.ts` is not a lane-2 file) — carried to a later phase, and named plainly
 * in the lane report rather than silently left unstated.
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
}

export interface ProjectedToolResult {
  sessionId: string;
  threadId: string;
  callId: string;
  output: string;
  isError: boolean;
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
}

export interface Sinks {
  onToolCall(event: ProjectedToolCall): void;
  onToolResult(event: ProjectedToolResult): void;
}

interface PendingCronCreate { cron: string; prompt: string }

function key(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`;
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
  /** `sessionId:callId` of a create call → its parsed args, awaiting the matching tool_result. */
  const pendingCreates = new Map<string, PendingCronCreate>();
  /** Winter's minted job id → the mirrored `RoutineStore` id, so a later `CronDelete` (which
   *  addresses the CHILD's id, never Norma's) can resolve the row to remove. Not scoped per
   *  session: Winter mints these with `randomUUID()`, which is unique enough on its own, and a
   *  `CronDelete` carries no session-scoping information beyond the id it was handed. */
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
      const k = key(event.sessionId, event.callId);
      if (event.name === "push_notification") {
        if (seen.has(k)) return;
        seen.add(k);
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
        if (seen.has(k)) return;
        seen.add(k);
        pendingCreates.set(k, create);
        return;
      }

      const del = parseCronDeleteArgs(event.argsJson);
      if (del !== undefined) {
        if (seen.has(k)) return;
        seen.add(k);
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
      const k = key(event.sessionId, event.callId);
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
