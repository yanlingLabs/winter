import { randomUUID } from "node:crypto";
import type { NewSessionEvent, PANEL_COMMAND_ACTIONS, PanelCommandResultParams } from "@norma/protocol";

// ================================================================================================
// B2 Task 2 — the pending-command registry: the daemon's half of the `panel_command` /
// `panel.commandResult` round trip.
//
// **What Plan A left here.** Plan A shipped the `panel_command` transient with NO producer at all
// (verified by grep at the time of writing: outside test files, nothing in `packages/` constructed
// one) and no answer channel, and named the debt in the B2 spec §3: "result returns via
// `panel.commandResult`, **first result per `commandId` wins** (closing the broadcast-dedup
// obligation)". The obligation is real because `panel_command` is BROADCAST — `hub.broadcastTransient`
// fans out to every attached client — so two Mac windows attached to the same session both see the
// command and both may answer it. Whoever answers first is the answer.
//
// **Modeled on `HardwareBroker` (peripheral/hardware.ts), deliberately and closely**: pending map,
// injectable deadline, delete-then-resolve, never throws across the public surface. That broker
// solves the identical problem one layer over (push a request at the app, await the app's RPC
// answer, give up on a timer) and its shape has held since Phase 4c.
//
// **Why a module here rather than a closure inside `ipc/server.ts`.** The registry has TWO owners
// that must see the same map: the PRODUCER (B2 Task 4's browser tool, which reaches it through its
// own REGISTRATION deps — `registerBrowserTool`'s `dispatch`, wired in daemon.ts, not through
// `ToolContext`; the registry is daemon-global while a ToolContext is per-call) and the
// `panel.commandResult` HANDLER. A closure in server.ts would make the tool
// depend on the ipc server to dispatch a command — the wrong direction entirely, and the same
// reasoning that puts `HardwareBroker` in `peripheral/` with only its consent gate in server.ts. It
// sits beside `panel/store.ts` because it is panel-domain state; unlike that file it is not pure,
// which is exactly why it is a separate one.
// ================================================================================================

export type PanelCommandAction = (typeof PANEL_COMMAND_ACTIONS)[number];

/** How a dispatched command ended.
 *
 *  `timeout` is a SEPARATE KIND, not an `ok: false` result, because the two are different facts and
 *  Task 4's tool must say different things about them: `{kind:"result", ok:false}` is the app
 *  reporting that the verb ran and failed ("no element matched that selector", "the sensitive-field
 *  floor refused this type"), while `{kind:"timeout"}` means nothing is known — the app may be gone,
 *  may be busy, or may have executed the verb and lost the race back. Collapsing them would let the
 *  agent report "the button isn't there" when the truth is "the Mac app never answered".
 *
 *  B2 Task 3 built the app half, and two of its shapes produce a timeout DELIBERATELY rather than by
 *  accident: a command arriving during the app's quit beat, and a verb still running when the app's
 *  own copy of this deadline fires. Both are cases where the app has nothing true to say, so the
 *  timeout is the honest outcome — but it does mean "timed out" covers a slightly wider set of facts
 *  than "the Mac app is gone", which is worth knowing when wording the tool's own message. */
export type PanelCommandOutcome =
  | { kind: "result"; ok: boolean; result?: string; imageBase64?: string }
  | { kind: "timeout"; deadlineMs: number };

/** What `resolve` did with a result — returned rather than thrown, so the ipc handler decides the
 *  wire mapping (see its own comment there for why only `unknown` is an error). */
export type PanelCommandResolution = "accepted" | "dropped" | "unknown";

export interface PanelCommandRegistryDeps {
  /** Publish the command to whoever is attached. Wired to `hub.broadcastTransient` in daemon.ts —
   *  `NewSessionEvent` is exactly that method's `EventInput` (the event minus `seq`/`ts`, which the
   *  hub stamps). May THROW: the hub rejects an unknown session, and re-parses the event against the
   *  grown schema, so an over-cap `args` is refused there too rather than reaching a client.
   *  `dispatch` unwinds its pending entry if it does. */
  emit: (event: NewSessionEvent) => void;
  /** Injectable only so tests can read the drop lines back; defaults to the `console.error` this
   *  daemon uses everywhere else (ipc/server.ts's `[trust.remove]`, `[reaper]`, …). */
  log?: (line: string) => void;
}

interface PendingCommand {
  sessionId: string;
  resolve: (outcome: PanelCommandOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PanelCommandRegistry {
  /** How many settled `commandId`s are remembered, so a LATE result can be told apart from a
   *  never-issued one. Bounded because a long browsing session issues an unbounded number of
   *  commands and this must not become a leak keyed on session length; insertion-ordered, so the
   *  oldest key is always `.keys().next().value` — the cheap LRU `ConnState.seenCommands`
   *  (ipc/server.ts) already uses, at the same size. Overflowing it is harmless: the only cost is
   *  that a very late result for a very old command reports `unknown` instead of `dropped`. */
  static readonly SETTLED_MEMORY = 256;

  private pending = new Map<string, PendingCommand>();
  /** Insertion-ordered set of `commandId`s that were SETTLED — by a result or by deadline expiry.
   *  Spec §3 requires the distinction: "a timed-out command's late result is dropped by the dedup",
   *  which is only expressible if expiry leaves a record. A command whose emission FAILED is
   *  deliberately not in here (see `dispatch`'s catch): it never reached a client, so a result for
   *  it could only be fabricated, and `unknown` is the honest verdict. */
  private settled = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: PanelCommandRegistryDeps) {
    this.log = deps.log ?? ((line) => console.error(line));
  }

  get pendingCount(): number { return this.pending.size; }
  get settledCount(): number { return this.settled.size; }

  /** Push one command at the attached clients and register the pending entry that awaits its
   *  answer. The `commandId` is minted HERE, never supplied by the caller — the same rule
   *  `panel.openTab` follows for `tabId` ("exactly one code path creates one, and it always runs
   *  here"), and what makes it structurally impossible to emit a `panel_command` that nothing is
   *  waiting on.
   *
   *  Returns the id (for logging/correlation) alongside the promise. The promise NEVER rejects: it
   *  settles as a result or as a timeout, both of which the tool renders. */
  dispatch(cmd: {
    sessionId: string;
    action: PanelCommandAction;
    tabId?: string;
    url?: string;
    args?: Record<string, unknown>;
    deadlineMs: number;
  }): { commandId: string; settled: Promise<PanelCommandOutcome> } {
    const commandId = `pcmd_${randomUUID()}`;

    const settled = new Promise<PanelCommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        this.remember(commandId);
        resolve({ kind: "timeout", deadlineMs: cmd.deadlineMs });
      }, cmd.deadlineMs);
      this.pending.set(commandId, { sessionId: cmd.sessionId, resolve, timer });
    });

    try {
      this.deps.emit({
        type: "panel_command",
        sessionId: cmd.sessionId,
        commandId,
        ...(cmd.tabId !== undefined && { tabId: cmd.tabId }),
        action: cmd.action,
        ...(cmd.url !== undefined && { url: cmd.url }),
        ...(cmd.args !== undefined && { args: cmd.args }),
        deadlineMs: cmd.deadlineMs,
      });
    } catch (e) {
      // Nothing was published, so nothing can ever answer: drop the entry and its timer rather than
      // leaving a command that can only ever time out. The caller sees the throw.
      const p = this.pending.get(commandId);
      if (p) { clearTimeout(p.timer); this.pending.delete(commandId); }
      throw e;
    }

    return { commandId, settled };
  }

  /** The app's answer. FIRST RESULT PER commandId WINS — spec §3's dedup obligation, and the reason
   *  it exists: a broadcast command can be answered by every attached client.
   *
   *  Three outcomes, none of which throw:
   *   - `accepted` — this result settled a pending command;
   *   - `dropped`  — the command was already settled (a duplicate answer, or an answer that arrived
   *     after its deadline expired). Logged, and deliberately NOT an error: the loser of that race
   *     has no way to have known, exactly as a double `panel.closeTab` is tolerated rather than
   *     refused;
   *   - `unknown`  — no record of this `commandId` at all (or a `sessionId` that doesn't match the
   *     pending one). The sessionId check is what keeps that RPC field from being decorative: a
   *     buggy harness must not be able to settle another session's command. */
  resolve(r: PanelCommandResultParams): PanelCommandResolution {
    const p = this.pending.get(r.commandId);
    if (!p) {
      const late = this.settled.has(r.commandId);
      this.log(
        late
          ? `[panel.commandResult] ${r.commandId} already settled — result dropped (first result wins)`
          : `[panel.commandResult] ${r.commandId} is not a known command — result rejected`,
      );
      return late ? "dropped" : "unknown";
    }
    if (p.sessionId !== r.sessionId) {
      this.log(`[panel.commandResult] ${r.commandId} belongs to another session — result rejected`);
      return "unknown";
    }
    this.pending.delete(r.commandId);
    this.remember(r.commandId);
    clearTimeout(p.timer);
    p.resolve({
      kind: "result",
      ok: r.ok,
      ...(r.result !== undefined && { result: r.result }),
      ...(r.imageBase64 !== undefined && { imageBase64: r.imageBase64 }),
    });
    return "accepted";
  }

  private remember(commandId: string): void {
    this.settled.add(commandId);
    while (this.settled.size > PanelCommandRegistry.SETTLED_MEMORY) {
      const oldest = this.settled.values().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }
}
