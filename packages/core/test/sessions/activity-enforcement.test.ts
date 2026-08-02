import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { DispatchChildren } from "../../src/agent/dispatch-children";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { ACTIVE_DEMOTION_MS, activityFor, type Activity, type ActivityRow } from "../../src/sessions/activity";
import {
  AUTO_BACKGROUND_GRACE_MS, createActivityEnforcement, harnessKindOf, type ActivityEnforcement,
} from "../../src/sessions/activity-enforcement";

// session-activity-hygiene T5: the ENFORCEMENT that makes the lifecycle real — what actually
// happens when the last harness lets go of a session.
//
// T2 derived the state, T3 let a user write it, T4 broadcast it. None of them DID anything: a turn
// whose only terminal was closed kept burning tokens into a log nobody would read, and a session
// somebody left open a week ago still called itself "active".
//
// Three seams under test, in three layers:
//   1. `harnessKindOf`     — pure: which clients may have their turn killed by a detach
//   2. the enforcement obj — the policy, against fake deps (no socket, no engine, no real clocks)
//   3. the IPC server      — that the policy is actually WIRED, and that `session.list` never
//                            disagrees with the emitted `session_activity` stream
//
// Timer discipline: every clock here is injected. `now` is a plain counter and grace timers are
// captured, never scheduled — there is not one real sleep in this file.

// ---------------------------------------------------------------------------------------------
// Layer 1: harness kinds
// ---------------------------------------------------------------------------------------------

describe("harness kinds (session-activity-hygiene T5)", () => {
  // The strings below are VERBATIM from the real clients, with the source of each recorded — this
  // test is the tripwire for a client that renames itself, since a rename silently changes whether
  // that client's detach kills a running turn.
  test("every terminal-kind client the repo actually ships classifies as 'terminal'", () => {
    // packages/cli/src/main.ts:613 — `connect(chat ? "cli-chat" : "cli-p")`
    expect(harnessKindOf("cli-p", "harness")).toBe("terminal");   // norma -p (one-shot)
    expect(harnessKindOf("cli-chat", "harness")).toBe("terminal"); // the interactive Ink TUI
    // …and the other 22 literals, all `cli-`-prefixed (main.ts `connect("cli-…")`)
    expect(harnessKindOf("cli-resume", "harness")).toBe("terminal");
    expect(harnessKindOf("cli-watch", "harness")).toBe("terminal");
    // The two the CLI builds by template string (main.ts:274, :1412) — the reason this is a PREFIX
    // rule and not a list of literals.
    expect(harnessKindOf("cli-plugin-revoke-battery-limiter", "harness")).toBe("terminal");
    expect(harnessKindOf("cli-plugin-restart-battery-limiter", "harness")).toBe("terminal");
  });

  test("every app-kind client the repo actually ships classifies as 'app'", () => {
    // apple/Norma/Sources/Model/AppModel.swift:70 — `static let ownClientName = "orb"`, shared by
    // the menu-bar harness AND every detached window (`makeDetachedFeed`, :145).
    expect(harnessKindOf("orb", "harness")).toBe("app");
    // apple/NormaKit/.../RemoteHost.swift:365/:369 — the Mac gateway's daemon-facing client, one
    // per phone session.
    expect(harnessKindOf("iphone-gateway", "remote")).toBe("app");
    // apple/NormaKit/Sources/norma-probe/main.swift:48 — the debug streamer.
    expect(harnessKindOf("norma-probe", "harness")).toBe("app");
  });

  test("the REMOTE role outranks the name — the phone is never terminal-kind however it is called", () => {
    // The ruling: role is the stronger detector. A gateway that someday renames itself `cli-phone`
    // must still never have a turn killed by a connection blip — the transport churns by design.
    expect(harnessKindOf("cli-phone", "remote")).toBe("app");
  });

  test("an UNKNOWN client is app-kind — terminal is an allowlist, because terminal is what kills turns", () => {
    // Same reasoning ACTIVITY_MODES records for participation: a client that ships later must opt
    // INTO turn-killing behaviour deliberately, never inherit it by omission. Getting this backwards
    // costs a user their in-flight work.
    expect(harnessKindOf("some-future-client", "harness")).toBe("app");
    expect(harnessKindOf("", null)).toBe("app");
    expect(harnessKindOf("clip-art", "harness")).toBe("app"); // "cli" is not the prefix; "cli-" is
  });
});

// ---------------------------------------------------------------------------------------------
// Layer 2: the policy, against fake deps
// ---------------------------------------------------------------------------------------------

/** Captured, never scheduled — `fireAll()` is the only thing that runs a grace callback. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    api: {
      setTimeout(fn: () => void, ms: number): unknown { const id = nextId++; pending.set(id, { fn, ms }); return id; },
      clearTimeout(handle: unknown): void { pending.delete(handle as number); },
    },
    count: (): number => pending.size,
    delays: (): number[] => [...pending.values()].map((p) => p.ms),
    fireAll(): void {
      const all = [...pending.values()];
      pending.clear();
      for (const p of all) p.fn();
    },
  };
}

/** A miniature of ipc/server.ts's `deriveActivity`: the same `activityFor` call, fed the same
 *  signals — including the two the enforcement itself owns. Having the fake `emit` DERIVE (rather
 *  than record a bare session id) is what lets these tests read as state trajectories, and is what
 *  would catch an enforcement that mutates its bookkeeping in the wrong order relative to the emit. */
function harness(rows: Record<string, ActivityRow> = { s1: { mode: "code" } }) {
  const meta = new Map<string, ActivityRow>(Object.entries(rows));
  const running = new Set<string>();
  const wakeup = new Set<string>();
  const attached = new Map<string, number>();
  const emitted: (Activity | "none")[] = [];
  const aborted: string[] = [];
  const timers = fakeTimers();
  let clock = 1_700_000_000_000;
  let enf: ActivityEnforcement;

  enf = createActivityEnforcement({
    meta: (id) => {
      const row = meta.get(id);
      if (!row) throw new Error(`unknown session ${id}`);
      return row;
    },
    emit: (id) => {
      const row = meta.get(id);
      if (!row) throw new Error(`unknown session ${id}`);
      emitted.push(activityFor(row, {
        turnRunning: running.has(id),
        attachedCount: attached.get(id) ?? 0,
        bgWork: wakeup.has(id),
        lastEventTs: 0,
        activeSince: enf.activeSince(id),
        autoBackground: enf.autoBackgrounded(id),
      }, clock) ?? "none");
    },
    turnRunning: (id) => running.has(id),
    abortTurn: (id) => { aborted.push(id); },
    scheduledWakeup: (id) => wakeup.has(id),
    now: () => clock,
    timers: timers.api,
  });

  return {
    enf, meta, running, wakeup, emitted, aborted, timers,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    attach(id: string): void {
      attached.set(id, (attached.get(id) ?? 0) + 1);
      enf.onAttached(id, attached.get(id)!);
    },
    /** `SessionHub.attach`'s early return: a client whose socket died during the replay drain is
     *  never registered — and never detaches either. */
    attachThatDidNotTake(id: string): void {
      enf.onAttached(id, attached.get(id) ?? 0);
    },
    detach(id: string, clientName = "cli-p", role: string | null = "harness"): void {
      const remaining = Math.max(0, (attached.get(id) ?? 0) - 1);
      attached.set(id, remaining);
      enf.onDetached(id, { clientName, role }, remaining);
    },
  };
}

describe("last-detach enforcement (session-activity-hygiene T5)", () => {
  test("a TERMINAL harness letting go of a running turn aborts it — the ESC path, nothing new", () => {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "cli-p");
    expect(h.aborted).toEqual(["s1"]);
  });

  test("an APP harness letting go of a running turn does NOT abort — it auto-backgrounds instead", () => {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "orb");
    expect(h.aborted).toEqual([]);
    expect(h.enf.autoBackgrounded("s1")).toBe(true);
  });

  test("a REMOTE harness detaching mid-turn never aborts — the phone's transport churns by design", () => {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "iphone-gateway", "remote");
    expect(h.aborted).toEqual([]);
    expect(h.enf.autoBackgrounded("s1")).toBe(true);
  });

  test("a BACKGROUNDED session survives a terminal detach un-aborted — that flag means 'keep running unattended'", () => {
    const h = harness({ s1: { mode: "code", backgrounded: true } });
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "cli-p");
    expect(h.aborted).toEqual([]);
    // …and no provisional mark either: the stored flag already says background, and clearing it is
    // the user's business, not a grace timer's.
    expect(h.enf.autoBackgrounded("s1")).toBe(false);
  });

  test("an ARCHIVED session survives a terminal detach un-aborted", () => {
    const h = harness({ s1: { mode: "code", archived: true } });
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "cli-p");
    expect(h.aborted).toEqual([]);
  });

  test("a detach that is NOT the last one never aborts — someone is still watching", () => {
    const h = harness();
    h.attach("s1");
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "cli-p");
    expect(h.aborted).toEqual([]);
    expect(h.enf.autoBackgrounded("s1")).toBe(false);
  });

  test("a last detach with NO turn running aborts nothing and announces idle", () => {
    const h = harness();
    h.attach("s1");
    h.detach("s1", "cli-p");
    expect(h.aborted).toEqual([]);
    expect(h.emitted).toEqual(["active", "idle"]);
  });

  test("chat and dispatch are untouched — no lifecycle means no enforcement", () => {
    const h = harness({ chat: { mode: "chat" }, disp: { mode: "dispatch" } });
    for (const id of ["chat", "disp"]) {
      h.attach(id);
      h.running.add(id);
      h.detach(id, "cli-p");
    }
    expect(h.aborted).toEqual([]);
    expect(h.emitted).toEqual([]);          // the derivation has nothing to say about them
    expect(h.enf.activeSince("chat")).toBeUndefined();
  });

  test("a session whose row vanished mid-detach never throws out of the hook, and is forgotten", () => {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "orb");                       // leaves a span AND a provisional background
    h.attach("s1");
    h.meta.delete("s1");
    expect(() => h.detach("s1", "cli-p")).not.toThrow();
    expect(() => h.enf.onAttached("s1", 1)).not.toThrow();
    expect(() => h.enf.onTurnSettled("s1")).not.toThrow();
    // Nothing about a session that no longer exists may outlive it — the detach that would
    // normally clear this bookkeeping is exactly what never comes.
    expect(h.enf.activeSince("s1")).toBeUndefined();
    expect(h.enf.autoBackgrounded("s1")).toBe(false);
  });

  test("an attach that did NOT take opens no span — a dead-on-replay client never detaches either", () => {
    const h = harness();
    h.attachThatDidNotTake("s1");
    // Left open, this span could never be closed, and 24h later the sweep would demote a session
    // with no harness on it at all.
    expect(h.enf.activeSince("s1")).toBeUndefined();
    expect(h.emitted).toEqual([]);
  });

  test("every transition announces — the change memo only means anything if nothing skips the emit", () => {
    const h = harness();
    h.attach("s1");                 // idle -> active
    h.running.add("s1");
    h.detach("s1", "orb");          // -> background (running, nobody attached)
    h.running.delete("s1");
    h.enf.onTurnSettled("s1");      // grace armed; still background
    h.timers.fireAll();             // -> idle
    expect(h.emitted).toEqual(["active", "background", "background", "idle"]);
  });
});

describe("post-turn grace (session-activity-hygiene T5)", () => {
  /** app-kind detach mid-turn, then the turn ends — the state this whole block is about. */
  function autoBackgrounded() {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "orb");
    h.running.delete("s1");
    return h;
  }

  test("the turn settling arms a 2-minute grace timer", () => {
    const h = autoBackgrounded();
    h.enf.onTurnSettled("s1");
    expect(h.timers.count()).toBe(1);
    expect(h.timers.delays()).toEqual([AUTO_BACKGROUND_GRACE_MS]);
    expect(AUTO_BACKGROUND_GRACE_MS).toBe(2 * 60_000);
  });

  test("DURING the grace window the session still derives 'background', not 'idle'", () => {
    const h = autoBackgrounded();
    h.enf.onTurnSettled("s1");
    // Nothing running, nothing attached, no background work — without the auto-background signal
    // the derivation would say "idle" here and `session.list` would contradict the live stream.
    expect(h.enf.autoBackgrounded("s1")).toBe(true);
    expect(h.emitted.at(-1)).toBe("background");
  });

  test("the grace expiring drops the mark and announces idle", () => {
    const h = autoBackgrounded();
    h.enf.onTurnSettled("s1");
    h.advance(AUTO_BACKGROUND_GRACE_MS);
    h.timers.fireAll();
    expect(h.enf.autoBackgrounded("s1")).toBe(false);
    expect(h.emitted.at(-1)).toBe("idle");
  });

  test("a RE-ATTACH during the grace window cancels the timer and restores 'active'", () => {
    const h = autoBackgrounded();
    h.enf.onTurnSettled("s1");
    expect(h.timers.count()).toBe(1);

    h.attach("s1");
    expect(h.timers.count()).toBe(0);            // cancelled, not merely ignored when it fires
    expect(h.enf.autoBackgrounded("s1")).toBe(false);
    expect(h.emitted.at(-1)).toBe("active");

    h.timers.fireAll();                          // nothing left to fire
    expect(h.emitted.at(-1)).toBe("active");
  });

  test("a SCHEDULED WAKE-UP suppresses the grace — the session is not going idle, it is waiting", () => {
    const h = autoBackgrounded();
    h.wakeup.add("s1");                          // a detached bash task / background agent still running
    h.enf.onTurnSettled("s1");
    expect(h.timers.count()).toBe(0);
    // …and no flicker to idle: the work itself already derives "background".
    expect(h.emitted.at(-1)).toBe("background");
  });

  test("a drained FOLLOW-UP turn defers the grace to the turn that really is the last one", () => {
    const h = autoBackgrounded();
    h.running.add("s1");                         // the engine's between-turns drain restarted it
    h.enf.onTurnSettled("s1");
    expect(h.timers.count()).toBe(0);            // not the last turn — nothing to grace yet
    expect(h.enf.autoBackgrounded("s1")).toBe(true);

    h.running.delete("s1");
    h.enf.onTurnSettled("s1");
    expect(h.timers.count()).toBe(1);
  });

  test("a turn settling on a session nobody auto-backgrounded arms nothing", () => {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.running.delete("s1");
    h.enf.onTurnSettled("s1");
    expect(h.timers.count()).toBe(0);
    expect(h.emitted).toEqual(["active", "active"]); // still attached; the memo swallows the repeat
  });

  test("an ABORTED turn's own settle is what announces idle — the abort itself only stops the work", () => {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "cli-p");                     // aborts; the turn is still unwinding
    expect(h.emitted.at(-1)).toBe("background"); // honest: work running, nobody attached
    h.running.delete("s1");                      // …the engine's finally
    h.enf.onTurnSettled("s1");
    expect(h.emitted.at(-1)).toBe("idle");
  });
});

describe(">24h demotion (session-activity-hygiene T5)", () => {
  test("the active span is stamped at attach and dropped at the LAST detach", () => {
    const h = harness();
    expect(h.enf.activeSince("s1")).toBeUndefined();
    h.attach("s1");
    expect(h.enf.activeSince("s1")).toBe(h.now());
    h.detach("s1", "cli-p");
    expect(h.enf.activeSince("s1")).toBeUndefined();
  });

  test("a SECOND harness does not restart the span — 'continuously active' means continuously", () => {
    const h = harness();
    h.attach("s1");
    const started = h.enf.activeSince("s1");
    h.advance(60_000);
    h.attach("s1");
    expect(h.enf.activeSince("s1")).toBe(started!);
    h.detach("s1", "cli-p");                      // one left: the span is still open
    expect(h.enf.activeSince("s1")).toBe(started!);
  });

  test("the sweep announces a session continuously active for more than 24h", () => {
    const h = harness();
    h.attach("s1");
    expect(h.emitted).toEqual(["active"]);

    h.advance(ACTIVE_DEMOTION_MS);                // exactly 24h is NOT over the window
    h.enf.sweep();
    expect(h.emitted).toEqual(["active"]);

    h.advance(1);
    h.enf.sweep();
    expect(h.emitted).toEqual(["active", "background"]);
  });

  test("the sweep only EMITS — the derivation is what decides, and the memo eats the repeats", () => {
    const h = harness();
    h.attach("s1");
    h.advance(ACTIVE_DEMOTION_MS + 1);
    h.enf.sweep();
    h.enf.sweep();
    h.enf.sweep();
    // No stored flag was written: the demotion lives entirely in `activeSince`.
    expect(h.meta.get("s1")!.backgrounded).toBeUndefined();
    // Three sweeps, three emits — deduping is `SessionHub.emitActivity`'s job, not the sweep's, and
    // duplicating it here would be a second change filter to keep in sync.
    expect(h.emitted).toEqual(["active", "background", "background", "background"]);
  });

  test("the sweep skips sessions with no open span, and forgets a vanished row instead of retrying it", () => {
    const h = harness({ s1: { mode: "code" }, s2: { mode: "code" } });
    h.attach("s1");
    h.attach("s2");
    h.advance(ACTIVE_DEMOTION_MS + 1);
    h.meta.delete("s2");                       // deleted while still attached: no detach ever comes
    expect(() => h.enf.sweep()).not.toThrow();
    expect(h.emitted).toEqual(["active", "active", "background"]);
    // …and the sweep is the only thing that can garbage-collect that span.
    expect(h.enf.activeSince("s2")).toBeUndefined();
  });

  test("stop() cancels the sweep and every pending grace timer", () => {
    const h = harness();
    h.attach("s1");
    h.running.add("s1");
    h.detach("s1", "orb");
    h.running.delete("s1");
    h.enf.onTurnSettled("s1");
    expect(h.timers.count()).toBe(1);
    h.enf.stop();
    expect(h.timers.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Layer 3: the wiring — is any of this actually reachable from a real socket?
// ---------------------------------------------------------------------------------------------

/** Minimal raw NDJSON JSON-RPC client that records both responses and pushed events (this
 *  codebase's convention: no shared test-harness module — cf. session-activity-event.test.ts). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: any[] = [];

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.method === METHODS.event) {
              c.events.push(msg.params);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  activities(): string[] {
    return this.events.filter((e) => e.type === "session_activity").map((e) => e.activity);
  }

  close(): void { this.socket.end(); }
}

/** Records what the DAEMON emitted, independent of who was listening. Needed because the states
 *  this task is about happen when NOTHING is attached — a socket-side listener would have to be
 *  attached to hear them, and being attached is precisely what stops the enforcement from firing. */
function recordEmissions(hub: SessionHub): string[] {
  const seen: string[] = [];
  const real = hub.emitActivity.bind(hub);
  hub.emitActivity = (sessionId, activity) => {
    const event = real(sessionId, activity);
    if (event) seen.push(activity!);
    return event;
  };
  return seen;
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("wired into the IPC server (session-activity-hygiene T5)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "norma-activity-enforce-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const running = new Set<string>();
    const bgWork = new Set<string>();
    const interrupted: string[] = [];
    const engine: any = {
      isRunning: (id: string) => running.has(id),
      hasBackgroundWork: (id: string) => bgWork.has(id),
      interrupt: (id: string) => { interrupted.push(id); running.delete(id); return { wasRunning: true }; },
    };
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, engine });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, harnessToken: tokens.harness, running, bgWork, interrupted, engine };
  }

  async function listActivity(c: TestClient, sessionId: string): Promise<string | undefined> {
    const res = await c.request(METHODS.sessionList, {});
    return res.result.sessions.find((s: any) => s.sessionId === sessionId)?.activity;
  }

  test("attaching announces 'active' — the transition T4 deliberately left to this task", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "orb");
    await viewer.request(METHODS.sessionAttach, { sessionId });
    await waitFor(() => viewer.activities().length === 1, "the attach announcement");
    expect(viewer.activities()).toEqual(["active"]);
    expect(await listActivity(viewer, sessionId)).toBe("active");
    viewer.close();
  });

  test("a TERMINAL client's socket dying mid-turn aborts the turn through the real detach path", async () => {
    const { store, socketPath, harnessToken, running, interrupted } = await boot();
    const sessionId = store.createSession("global");
    const cli = await TestClient.connect(socketPath);
    await cli.hello(harnessToken, "cli-p");
    await cli.request(METHODS.sessionAttach, { sessionId });
    running.add(sessionId);

    cli.close();
    await waitFor(() => interrupted.length === 1, "the abort");
    expect(interrupted).toEqual([sessionId]);
  });

  test("the MAC APP's socket dying mid-turn leaves the turn running", async () => {
    const { store, hub, socketPath, harnessToken, running, interrupted } = await boot();
    const emitted = recordEmissions(hub);
    const sessionId = store.createSession("global");
    const app = await TestClient.connect(socketPath);
    await app.hello(harnessToken, "orb");
    await app.request(METHODS.sessionAttach, { sessionId });
    running.add(sessionId);

    app.close();
    await waitFor(() => emitted.length === 2, "the auto-background");
    expect(emitted).toEqual(["active", "background"]);
    expect(interrupted).toEqual([]);
    expect(running.has(sessionId)).toBe(true);
  });

  test("session.list AGREES with the stream through the grace window — 'background', never an early 'idle'", async () => {
    const { store, hub, socketPath, harnessToken, running, engine } = await boot();
    const emitted = recordEmissions(hub);
    const sessionId = store.createSession("global");
    const app = await TestClient.connect(socketPath);
    await app.hello(harnessToken, "orb");
    await app.request(METHODS.sessionAttach, { sessionId });

    running.add(sessionId);
    app.close();                                     // app-kind, mid-turn → auto-background
    await waitFor(() => emitted.length === 2, "the auto-background");

    // The turn ends. Neither surface may flip to idle while the grace window is open — an early
    // idle on either is exactly the disagreement that makes the change memo a liar.
    running.delete(sessionId);
    engine.onTurnSettled(sessionId);                 // the hook startIpcServer wired onto the engine
    const observer = await TestClient.connect(socketPath);
    await observer.hello(harnessToken, "cli-sessions");
    expect(await listActivity(observer, sessionId)).toBe("background");
    expect(emitted).toEqual(["active", "background"]);
    observer.close();
  });

  test("session.list reports a freshly-attached session as 'active' — the span is a real instant, never epoch", async () => {
    // The failure this pins: wiring `activeSince` as `?? 0` instead of `undefined`, which
    // (`activity.ts`'s own warning) "would demote every session on earth" to background.
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "orb");
    await c.request(METHODS.sessionAttach, { sessionId });
    expect(await listActivity(c, sessionId)).toBe("active");
    c.close();
  });
});

describe("dispatch-spawned children default to background (session-activity-hygiene T5)", () => {
  test("a dispatch child is backgrounded at creation — it runs unattended by construction", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-activity-dispatch-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const registry = new DispatchChildren({
      store, hub,
      runTurn: async () => {},
      isRunning: () => false,
      interrupt: () => {},
    });
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    expect(store.meta(childId).backgrounded).toBe(true);
    // A dispatch child is an ordinary CODE session, so the flag actually means something on it —
    // and it means the one true thing: nobody is going to attach to this.
    expect(store.meta(childId).mode).toBe("code");
    store.close();
  });
});
