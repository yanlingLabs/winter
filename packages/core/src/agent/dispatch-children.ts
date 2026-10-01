// Dispatch's children — the `session_spawn` door and everything that follows a spawned session.
//
// REBUILT on the Winter leg. The engine-era `DispatchChildren` (deleted with `agent/engine.ts` in
// Phase 8b Task 17) was driven by an engine BRIDGE that intercepted `session_spawn` before the tool
// registry ran; on the Winter leg the dispatch coordinator is a runtime child calling the daemon's
// `sessions` capability server (`capabilities/sessions.ts`), so the tool's own `run()` is the door
// and this file is what it calls. The behaviour is the old design's, re-seated on today's seams:
//
//   - **Spawn** (`spawn`) — a first-class CODE session in the requested dir, minted through the SAME
//     creation transaction `session.create` runs (`ipc/server.ts`'s `createSessionInternal`, handed in
//     as `deps.createSession`): own transcript, in `session.list`, `session_created` broadcast to every
//     harness, linked to its coordinator by `parentSessionId` + `origin: "dispatch-child"`, at the
//     fixed `auto` policy the old children ran at, backgrounded at birth (nobody has a harness on it, so
//     a later attach-then-detach must not be able to kill its turn). The prompt is its first message
//     through the session's own driver (`send`), and the tool returns as soon as the message is in —
//     it never waits for the child's turn. A `model` is stamped AT CREATION now (the engine-era code
//     could only append a `[model: …]` hint to the prompt, because the child's first turn raced a
//     later `setModel`).
//   - **Status** — a hub observer follows every tracked child: `turn_started` (running), an approval
//     or question (awaiting_approval / awaiting_input, and back to running when it resolves), the main
//     thread's last `assistant_message` and any `agent_error`. Each change lands on the COORDINATOR's
//     log as a `child_update` (what the Mac builds its child pills from), and a finished turn —
//     reported when the child's driver settles (`onTurnSettled`) — carries the result summary.
//   - **Relay** — a child's `approval_requested`/`approval_resolved`/`question_asked`/
//     `question_resolved` are MIRRORED onto the coordinator's log with `childSessionId`, so a client
//     watching only Dispatch sees the card and answers it at the CHILD's id (`approval.respond`/
//     `ask_user.respond` — the brokers are daemon-global, keyed by session + call). Loop-safe by
//     construction: a mirrored copy is appended under the coordinator's id, which is never a child.
//     The child raises the card at all because `runtime-sdk/approval-bridge.ts` relays a dispatch
//     child's "ask" instead of refusing it (with a 10-minute auto-deny), and Dispatch's OWN calls
//     still never prompt.
//   - **Wake** — a finished child queues a `<child_update>` for its coordinator. The queue is flushed
//     as ONE message (so several children finishing together wake Dispatch once — the old coalescing)
//     on a macrotask, and only while the coordinator is idle; a coordinator mid-turn gets it when that
//     turn settles. The message goes in through the coordinator's own driver `send`, so a resumable
//     (idle-ended) coordinator is resumed for it like any inbound message. It also lists the children
//     still at work — the old per-turn roster, carried where the model actually reads it.
//   - **Bounded roster** — a finished child stays tracked until the coordinator turn that was told
//     about it ends; then it is forgotten (the coordinator lives forever, so the map must not grow).
//     A forgotten child that runs again — or one spawned before a daemon restart — is picked back up
//     from its stored parent link at its next `turn_started`, so its next result still reaches Dispatch.
//   - **Restart** — a turn that was running when the daemon stopped did not survive it. `start()`
//     closes any child the coordinator's log still shows as in flight with a final `error` update
//     (otherwise its pill would read "running" forever); the session itself stays resumable.
//
// Stopping a child is the session's own interrupt — `session.interrupt` (the Mac's stop button on a
// child pill) and `manage_session stop` both reach the child's driver; the interrupted turn settles
// and is reported here like any other.
import { existsSync, statSync } from "node:fs";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";

/** The `clientName` on every message this file sends: the child's first prompt and the coordinator's
 *  wake. */
export const DISPATCH_CLIENT_NAME = "dispatch";
/** The status vocabulary of `child_update` (`packages/protocol/src/events.ts`). */
export type ChildStatus = "running" | "awaiting_approval" | "awaiting_input" | "completed" | "error";
/** A result summary (on `child_update` and in the wake) is the child's last main-thread message, cut. */
export const CHILD_RESULT_SUMMARY_MAX = 2000;
/** `notification_requested.title`'s own schema bound. */
const NOTIFICATION_TITLE_MAX = 100;

const TERMINAL: ReadonlySet<ChildStatus> = new Set(["completed", "error"]);

/** The arguments `session_spawn` takes (its zod schema, `agent/tools/session-spawn.ts`). */
export interface SessionSpawnArgs {
  dir: string;
  prompt: string;
  model?: string;
  type?: "code" | "cowork";
  title?: string;
}

/** The slice of a session's live driver this file uses (`LegSession`). */
export interface DispatchDriverHandle {
  readonly turnRunning: boolean;
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
}

export interface DispatchChildrenDeps {
  store: {
    meta(sessionId: string): { mode?: string; origin?: string; parentSessionId?: string };
    getTitle(sessionId: string): string | null;
    setBackgrounded(sessionId: string, on: boolean): void;
    dispatchSessionId(): string | undefined;
    read(sessionId: string, fromSeq?: number): SessionEvent[];
  };
  hub: {
    addObserver(fn: (event: SessionEvent) => void): () => void;
    append(sessionId: string, input: never): SessionEvent;
    attachedCount(sessionId: string): number;
  };
  /** THE creation transaction (`ipc/server.ts`'s `createSessionInternal`, published through
   *  `onSessionCreator`). Throws a typed `WinterLegRefusal` (`code`, `message`) or an `RpcFailure`
   *  (a model the catalog cannot resolve). Undefined until the IPC server is up. */
  createSession: () => ((input: {
    scope: string; cwd: string; approvalPolicy: "auto"; origin: "dispatch-child"; mode: "code";
    parentSessionId: string; model?: string;
  }) => Promise<{ sessionId: string }>) | undefined;
  /** The driver table (`WinterSessionDrivers`): `get` a live driver, `ensure` one (resuming a
   *  resumable session). */
  sessions: {
    get(sessionId: string): DispatchDriverHandle | undefined;
    ensure(sessionId: string): Promise<DispatchDriverHandle | undefined>;
  };
  /** The LIVE picker list (`pickerModels()` over the current credentials) — the authoritative model
   *  check; the tool schema's enum is a boot snapshot and only steers. Absent or empty: not checked. */
  models?: () => Promise<readonly string[]> | readonly string[];
  /** Announce a session's activity after its background flag changed (`hub.emitActivity` with the
   *  `session.list` derivation). Optional. */
  announceActivity?: (sessionId: string) => void;
  /** The headless notification fallback (`agent/notify-fallback.ts`) for an unattended coordinator. */
  notifyFallback?: (title: string, message: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** How a flush is deferred — a macrotask by default (tests may inject). */
  defer?: (fn: () => void) => void;
}

/** One tracked child. `status` is what the roster and every update read; the rest is the current
 *  turn's scratch state, reset each time a turn is reported. */
interface ChildState {
  dispatchId: string;
  title: string;
  dir: string;
  spawnedAt: number;
  status: ChildStatus;
  /** A turn began since the last report — what makes a settle a reportable turn end (a driver also
   *  settles when its idle child is ended, which reports nothing). */
  turnOpen: boolean;
  lastAssistant?: string;
  sawError?: boolean;
  aborted?: boolean;
  /** The coordinator has been sent the wake carrying this child's terminal status. */
  reported: boolean;
}

/** One queued wake entry. */
interface WakeEntry {
  childId: string;
  title: string;
  dir: string;
  status: ChildStatus;
  summary?: string;
}

/** A pre-flight refusal: the tool returns it as an error result, and nothing was created. */
export class SessionSpawnRefusal extends Error {
  constructor(message: string) { super(message); this.name = "SessionSpawnRefusal"; }
}

export class DispatchChildren {
  private readonly children = new Map<string, ChildState>();
  private readonly wakes = new Map<string, WakeEntry[]>();
  private readonly scheduled = new Set<string>();
  private readonly flushing = new Set<string>();
  private off?: () => void;
  private stopped = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly defer: (fn: () => void) => void;

  constructor(private readonly deps: DispatchChildrenDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.error(`dispatch-children: ${line}`));
    this.defer = deps.defer ?? ((fn) => { setTimeout(fn, 0); });
  }

  /** Subscribe to every session's events, then settle what a restart left in flight. */
  start(): void {
    this.off = this.deps.hub.addObserver((e) => this.onEvent(e));
    try { this.closeInterruptedChildren(); } catch (err) { this.log(`restart sweep failed: ${err instanceof Error ? err.name : "unknown"}`); }
  }

  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = undefined;
  }

  /** Test/diagnostic view: the tracked children, in spawn order. */
  roster(): Array<{ sessionId: string; dispatchId: string; title: string; status: ChildStatus }> {
    return [...this.children.entries()].map(([sessionId, c]) => ({ sessionId, dispatchId: c.dispatchId, title: c.title, status: c.status }));
  }

  /**
   * `session_spawn`, for the session `callerSessionId`. Resolves to the tool's result text; rejects
   * with an `Error` whose message IS the tool's error text (the registry turns a throw into an
   * `isError` result). Every pre-flight refusal happens before anything is created.
   */
  async spawn(callerSessionId: string, args: SessionSpawnArgs): Promise<string> {
    let caller: { mode?: string };
    try { caller = this.deps.store.meta(callerSessionId); } catch { throw new SessionSpawnRefusal("session_spawn is only available in the dispatch session."); }
    if (caller.mode !== "dispatch") throw new SessionSpawnRefusal("session_spawn is only available in the dispatch session.");
    const type = args.type ?? "code";
    if (type === "cowork") throw new SessionSpawnRefusal("type 'cowork' is not yet available — use 'code'.");
    const dir = typeof args.dir === "string" ? args.dir : "";
    if (!dir.startsWith("/") || dir === "/") throw new SessionSpawnRefusal("dir must be an absolute directory path (not '/').");
    if (!isDirectory(dir)) throw new SessionSpawnRefusal(`dir '${dir}' does not exist or is not a directory — pass the absolute path of an existing directory.`);
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) throw new SessionSpawnRefusal("prompt is required — write the child a complete, self-contained task.");
    const model = typeof args.model === "string" && args.model.trim() !== "" ? args.model.trim() : undefined;
    if (model !== undefined && this.deps.models !== undefined) {
      const known = await this.deps.models();
      if (known.length > 0 && !known.includes(model)) {
        throw new SessionSpawnRefusal(`unknown model '${model}' — available models: ${known.join(", ")}; omit \`model\` to inherit the default model`);
      }
    }
    const title = typeof args.title === "string" && args.title.trim() !== "" ? args.title.trim() : prompt.slice(0, 60);
    const create = this.deps.createSession();
    if (create === undefined) throw new SessionSpawnRefusal("session_spawn is not ready yet — the daemon is still starting; try again in a moment.");

    let childId: string;
    try {
      ({ sessionId: childId } = await create({
        scope: "global", cwd: dir, approvalPolicy: "auto", origin: "dispatch-child", mode: "code",
        parentSessionId: callerSessionId,
        ...(model === undefined ? {} : { model }),
      }));
    } catch (err) {
      throw new SessionSpawnRefusal(`could not start the child session: ${refusalText(err)}`);
    }
    // Unattended by construction: the flag is what keeps a harness that later attaches to inspect it
    // from killing its turn by detaching again (the last-detach abort skips a backgrounded session).
    try { this.deps.store.setBackgrounded(childId, true); this.deps.announceActivity?.(childId); } catch { /* the row is new; best effort */ }
    // Tracked BEFORE the send, so its `turn_started` and every later event find it.
    this.children.set(childId, { dispatchId: callerSessionId, title, dir, spawnedAt: this.now(), status: "running", turnOpen: false, reported: false });
    this.update(childId, "running");
    try {
      const driver = this.deps.sessions.get(childId) ?? await this.deps.sessions.ensure(childId);
      if (driver === undefined) throw new Error("the child session has no runtime driver");
      await driver.send(prompt, DISPATCH_CLIENT_NAME);
    } catch (err) {
      const why = refusalText(err);
      this.log(`the first message to child ${childId} failed: ${err instanceof Error ? err.name : "unknown"}`);
      const c = this.children.get(childId);
      if (c !== undefined) { c.status = "error"; c.reported = true; }
      this.update(childId, "error", `The child session was created but its first message could not be delivered: ${why}`);
      throw new SessionSpawnRefusal(`spawned session ${childId} ("${title}") in ${dir}, but its first message could not be delivered: ${why}`);
    }
    const modelNote = model === undefined ? "" : ` on ${model}`;
    return `spawned session ${childId} ("${title}") in ${dir}${modelNote} — it is working in the background; you'll be woken with a <child_update> when it finishes.`;
  }

  /** Every session's driver calls this when its turn queue goes idle (or its child ends). */
  onTurnSettled(sessionId: string): void {
    if (this.stopped) return;
    const child = this.children.get(sessionId);
    if (child !== undefined && child.turnOpen) this.reportTurnEnd(sessionId, child);
    // A coordinator's own turn ended: forget the children it has now been told about (the bounded
    // roster), then deliver anything that queued up while it was busy.
    if (this.isCoordinator(sessionId)) {
      for (const [id, c] of this.children) {
        if (c.dispatchId === sessionId && c.reported && TERMINAL.has(c.status)) this.children.delete(id);
      }
      this.scheduleFlush(sessionId);
    }
  }

  // ── the observer ─────────────────────────────────────────────────────────────────────────────

  private onEvent(e: SessionEvent): void {
    if (this.stopped) return;
    let c = this.children.get(e.sessionId);
    if (c === undefined) {
      // A forgotten (or pre-restart) child that starts a new turn is tracked again from its stored link.
      if (e.type !== "turn_started" || (e as { threadId?: string }).threadId !== "main") return;
      c = this.retrack(e.sessionId);
      if (c === undefined) return;
    }
    const main = (e as { threadId?: string }).threadId === "main";
    switch (e.type) {
      case "turn_started":
        if (!main) return;
        c.turnOpen = true;
        c.lastAssistant = undefined; c.sawError = false; c.aborted = false;
        if (c.status !== "running") { c.status = "running"; c.reported = false; this.update(e.sessionId, "running"); }
        return;
      case "assistant_message":
        if (main) c.lastAssistant = e.text;
        return;
      case "agent_error":
        if (main) c.sawError = true;
        return;
      case "turn_completed":
        if (main && e.stopReason === "aborted") c.aborted = true;
        if (main && e.stopReason === "error") c.sawError = true;
        return;
      case "approval_requested":
        this.mirror(c.dispatchId, e);
        this.setStatus(e.sessionId, c, "awaiting_approval");
        this.notifyUnattended(c, "needs your approval");
        return;
      case "question_asked":
        this.mirror(c.dispatchId, e);
        this.setStatus(e.sessionId, c, "awaiting_input");
        this.notifyUnattended(c, "has a question for you");
        return;
      case "approval_resolved":
      case "question_resolved":
        this.mirror(c.dispatchId, e);
        if (c.status === "awaiting_approval" || c.status === "awaiting_input") this.setStatus(e.sessionId, c, "running");
        return;
      default:
        return;
    }
  }

  private retrack(sessionId: string): ChildState | undefined {
    let meta: { origin?: string; parentSessionId?: string };
    try { meta = this.deps.store.meta(sessionId); } catch { return undefined; }
    if (meta.origin !== "dispatch-child" || meta.parentSessionId === undefined) return undefined;
    try { if (this.deps.store.meta(meta.parentSessionId).mode !== "dispatch") return undefined; } catch { return undefined; }
    let title = "child session";
    try { title = this.deps.store.getTitle(sessionId) ?? title; } catch { /* keep the fallback */ }
    const state: ChildState = { dispatchId: meta.parentSessionId, title, dir: "", spawnedAt: this.now(), status: "completed", turnOpen: false, reported: true };
    this.children.set(sessionId, state);
    return state;
  }

  private setStatus(childId: string, c: ChildState, status: ChildStatus): void {
    if (c.status === status) return;
    c.status = status;
    this.update(childId, status);
  }

  private reportTurnEnd(childId: string, c: ChildState): void {
    const status: ChildStatus = c.sawError ? "error" : "completed";
    const last = c.lastAssistant?.trim() ? c.lastAssistant.trim() : undefined;
    const summary = c.aborted
      ? `Stopped before it finished.${last ? ` Its last message: ${last}` : ""}`
      : last;
    const cut = summary === undefined ? undefined : summary.slice(0, CHILD_RESULT_SUMMARY_MAX);
    c.status = status;
    c.turnOpen = false;
    c.reported = false;
    c.lastAssistant = undefined; c.sawError = false; c.aborted = false;
    this.update(childId, status, cut);
    this.notifyUnattended(c, status === "error" ? "hit an error" : "finished");
    const queue = this.wakes.get(c.dispatchId) ?? [];
    // A second report for the same child before the coordinator was told replaces the first.
    const kept = queue.filter((w) => w.childId !== childId);
    kept.push({ childId, title: c.title, dir: c.dir, status, ...(cut === undefined ? {} : { summary: cut }) });
    this.wakes.set(c.dispatchId, kept);
    this.scheduleFlush(c.dispatchId);
  }

  // ── the wake ─────────────────────────────────────────────────────────────────────────────────

  private scheduleFlush(dispatchId: string): void {
    if (this.scheduled.has(dispatchId) || (this.wakes.get(dispatchId)?.length ?? 0) === 0) return;
    this.scheduled.add(dispatchId);
    this.defer(() => {
      this.scheduled.delete(dispatchId);
      void this.flush(dispatchId);
    });
  }

  private async flush(dispatchId: string): Promise<void> {
    if (this.stopped || this.flushing.has(dispatchId)) return;
    const queue = this.wakes.get(dispatchId);
    if (queue === undefined || queue.length === 0) return;
    // Mid-turn: its settle flushes. (A held send would also run after the turn, but one message per
    // finished child is not coalescing — the batch is taken only while the coordinator is idle.)
    if (this.deps.sessions.get(dispatchId)?.turnRunning) return;
    this.flushing.add(dispatchId);
    let batch: WakeEntry[] = [];
    try {
      const driver = this.deps.sessions.get(dispatchId) ?? await this.deps.sessions.ensure(dispatchId);
      if (driver === undefined) { this.log(`coordinator ${dispatchId} has no runtime driver — ${queue.length} child update(s) wait`); return; }
      if (driver.turnRunning) return;
      batch = queue.splice(0);
      for (const w of batch) {
        const c = this.children.get(w.childId);
        if (c !== undefined && TERMINAL.has(c.status)) c.reported = true;
      }
      await driver.send(this.wakeText(dispatchId, batch), DISPATCH_CLIENT_NAME);
    } catch (err) {
      this.log(`waking coordinator ${dispatchId} failed: ${err instanceof Error ? err.name : "unknown"} — the update(s) wait for its next turn`);
      const rest = this.wakes.get(dispatchId) ?? [];
      this.wakes.set(dispatchId, [...batch, ...rest]);
      for (const w of batch) { const c = this.children.get(w.childId); if (c !== undefined) c.reported = false; }
    } finally {
      this.flushing.delete(dispatchId);
    }
  }

  /** The wake message: one `<child_update>` block per finished child, then the children still at work. */
  private wakeText(dispatchId: string, batch: readonly WakeEntry[]): string {
    const blocks = batch.map((w) => [
      "<child_update>",
      `session: ${w.childId}`,
      `title: ${w.title}`,
      ...(w.dir ? [`dir: ${w.dir}`] : []),
      `status: ${w.status}`,
      ...(w.summary === undefined ? ["result: (the child ended its turn without a final message)"] : ["result:", w.summary]),
      "</child_update>",
    ].join("\n"));
    const batchIds = new Set(batch.map((w) => w.childId));
    const working = [...this.children.entries()]
      .filter(([id, c]) => c.dispatchId === dispatchId && !batchIds.has(id) && !TERMINAL.has(c.status))
      .map(([id, c]) => `- ${id} "${c.title}"${c.dir ? ` (${c.dir})` : ""} — ${c.status}, ${Math.max(0, Math.round((this.now() - c.spawnedAt) / 1000))}s`);
    const roster = working.length === 0 ? "No other child sessions are working." : `Still working:\n${working.join("\n")}`;
    return `${blocks.join("\n\n")}\n\n${roster}`;
  }

  // ── events onto the coordinator's log ────────────────────────────────────────────────────────

  private update(childId: string, status: ChildStatus, resultSummary?: string): void {
    const c = this.children.get(childId);
    if (c === undefined) return;
    this.safeAppend(c.dispatchId, {
      type: "child_update", sessionId: c.dispatchId, threadId: "main",
      childSessionId: childId, status, title: c.title,
      ...(resultSummary === undefined ? {} : { resultSummary }),
    });
  }

  /** A child's approval/question, re-stamped onto the coordinator's log with `childSessionId`. */
  private mirror(dispatchId: string, e: SessionEvent): void {
    const { seq: _seq, ts: _ts, ...rest } = e as SessionEvent & { seq: number; ts: number };
    this.safeAppend(dispatchId, { ...rest, sessionId: dispatchId, childSessionId: e.sessionId });
  }

  private notifyUnattended(c: ChildState, message: string): void {
    try {
      if (this.deps.hub.attachedCount(c.dispatchId) > 0) return;
    } catch { return; }
    const title = c.title.slice(0, NOTIFICATION_TITLE_MAX) || "Dispatch";
    this.safeAppend(c.dispatchId, { type: "notification_requested", sessionId: c.dispatchId, threadId: "main", title, message });
    try { this.deps.notifyFallback?.(title, message); } catch { /* a notification is best effort */ }
  }

  private safeAppend(sessionId: string, event: Record<string, unknown>): void {
    try {
      this.deps.hub.append(sessionId, event as never);
    } catch (err) {
      this.log(`could not append ${String(event.type)} to ${sessionId}: ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  private isCoordinator(sessionId: string): boolean {
    if (this.wakes.has(sessionId)) return true;
    for (const c of this.children.values()) if (c.dispatchId === sessionId) return true;
    return false;
  }

  /** Restart: a child the coordinator's log still shows in flight lost that turn with the old
   *  process. Close it on the log so no pill reads "running" forever. */
  private closeInterruptedChildren(): void {
    const dispatchId = this.deps.store.dispatchSessionId();
    if (dispatchId === undefined) return;
    const last = new Map<string, { status: ChildStatus; title: string }>();
    for (const e of this.deps.store.read(dispatchId)) {
      if (e.type === "child_update") last.set(e.childSessionId, { status: e.status, title: e.title });
    }
    for (const [childId, { status, title }] of last) {
      if (TERMINAL.has(status) || this.children.has(childId)) continue;
      this.safeAppend(dispatchId, {
        type: "child_update", sessionId: dispatchId, threadId: "main", childSessionId: childId, status: "error", title,
        resultSummary: "Winter restarted while this session was working, so that turn was stopped. The session is kept — open it or send it a message to continue.",
      });
    }
  }
}

function isDirectory(dir: string): boolean {
  try { return existsSync(dir) && statSync(dir).isDirectory(); } catch { return false; }
}

/** A refusal's words for the model: the message plus its typed code (never a stack). */
function refusalText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code ?? (err as { data?: { code?: unknown } }).data?.code;
    return typeof code === "string" && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}
