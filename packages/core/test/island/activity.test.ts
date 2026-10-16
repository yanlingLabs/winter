// The Winter island's activity (phase 2, `island/activity.ts`): the sessions driving ComputerV2 now, the turns that
// ended with their session idle, the armed wake triggers, and the `island.activity` / `island.activityChanged` doors.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, CLIENT_CAPABILITY_ISLAND, ISLAND_ACTIVITY_CHANGED_NOTIFICATION,
  IslandActivityResult, type SessionEvent, type WritableSocket,
} from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { IslandRegistry } from "../../src/island/registry";
import {
  IslandActivity, computerV2Facts, islandResultSummary, ISLAND_RESULT_SUMMARY_MAX, ISLAND_NO_RESULT_ORIGINS, type IslandActivityDeps,
} from "../../src/island/activity";

let seq = 0;
const ev = (e: Record<string, unknown>): SessionEvent =>
  ({ seq: ++seq, ts: 1_000_000 + seq, threadId: "main", ...e }) as unknown as SessionEvent;
const flush = () => new Promise<void>((r) => queueMicrotask(r));

/** An activity with a hand-run settle timer and a client counting its notifications. */
function harness(deps: Partial<IslandActivityDeps> = {}) {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  const activity = new IslandActivity({
    facts: (sid) => ({ mode: "code", title: `Title ${sid}` }),
    hosts: () => [{ clientName: "tui", role: "harness", tty: "/dev/ttys004" }],
    now: () => 1_000_000,
    setTimer: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    ...deps,
  });
  let told = 0;
  activity.addClient({ notify: () => {}, notifyActivity: () => { told++; } });
  const settle = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };
  return { activity, told: () => told, settle, timers };
}

const cuCall = (sid: string, callId: string, args: Record<string, unknown>, threadId = "main") =>
  ev({ type: "tool_call", sessionId: sid, threadId, callId, name: "computer_v2", argsJson: JSON.stringify(args) });

describe("IslandActivity — computer use", () => {
  test("a session uses the computer from its turn's first ComputerV2 call to the turn's end, labelled by the latest script", async () => {
    const { activity, told } = harness();
    activity.observe(ev({ type: "turn_started", sessionId: "s1" }));
    expect(activity.list().computerUse).toEqual([]);
    activity.observe(cuCall("s1", "c1", { code: `const n = await apps.open("com.apple.Notes"); await n.click("New")` }));
    await flush();
    expect(told()).toBe(1);
    let [item] = activity.list().computerUse;
    expect(item).toMatchObject({ sessionId: "s1", running: true, apps: ["Notes"], session: { title: "Title s1" } });
    expect(item!.title).toBeUndefined();
    expect(item!.hosts[0]!.tty).toBe("/dev/ttys004");
    // Its result: the script is done, the session still uses the computer (the model thinks between scripts).
    activity.observe(ev({ type: "tool_result", sessionId: "s1", callId: "c1", output: "", isError: false }));
    [item] = activity.list().computerUse;
    expect(item!.running).toBe(false);
    // The next script names no app: the turn's app is kept; its title labels it.
    activity.observe(cuCall("s1", "c2", { title: "Publishing the post", code: "await n.click('Publish')" }));
    [item] = activity.list().computerUse;
    expect(item).toMatchObject({ running: true, title: "Publishing the post", apps: ["Notes"] });
    // Some other tool is not computer use.
    activity.observe(ev({ type: "tool_call", sessionId: "s2", callId: "b1", name: "Bash", argsJson: "{}" }));
    expect(activity.list().computerUse.map((c) => c.sessionId)).toEqual(["s1"]);
    // The turn ends: it stops.
    activity.observe(ev({ type: "turn_completed", sessionId: "s1", stopReason: "end_turn", inputTokens: 0, outputTokens: 0 }));
    expect(activity.list().computerUse).toEqual([]);
    await flush();
    expect(told()).toBe(2); // one notice per burst
  });

  test("several sessions at once, a subagent's call counts for its session, and a stale entry goes", () => {
    let now = 1_000_000;
    const { activity } = harness({ now: () => now });
    activity.observe(cuCall("s1", "c1", { code: "browsers.open('https://example.com/a')" }));
    activity.observe(cuCall("s2", "c2", { code: "apps.open('/Applications/Safari.app')" }, "agent-1"));
    const list = activity.list().computerUse;
    expect(list.map((c) => [c.sessionId, c.apps])).toEqual([["s1", ["example.com"]], ["s2", ["Safari"]]]);
    activity.observe(ev({ type: "tool_result", sessionId: "s1", callId: "c1", output: "", isError: false }));
    now += 11 * 60_000;
    // Ten minutes without a ComputerV2 call or result: stale, running or not (a child that died mid-script).
    expect(activity.list().computerUse).toEqual([]);
  });

  test("a failed turn ends its computer use, and a quiet one goes stale by itself: one timer, a notice, then none", async () => {
    let now = 1_000_000;
    const { activity, told, timers } = harness({ now: () => now });
    activity.observe(cuCall("s1", "c1", {}));
    activity.observe(ev({ type: "agent_error", sessionId: "s1", message: "the runtime exited" }));
    expect(activity.list().computerUse).toEqual([]);

    activity.observe(cuCall("s2", "c2", {}));
    const live = timers.filter((t) => !t.cancelled);
    expect(live.length).toBe(1); // one stale check while anything is listed
    await flush();
    const before = told();
    now += 11 * 60_000;
    live[0]!.fn();
    expect(activity.list().computerUse).toEqual([]);
    await flush();
    expect(told()).toBe(before + 1);
    expect(timers.filter((t) => !t.cancelled && t !== live[0]).length).toBe(0); // nothing listed: no timer left
  });

  test("the facts read off a script: title first, apps and sites in order, bounded", () => {
    expect(computerV2Facts(JSON.stringify({ title: "  Filing   the  form ", code: "" }))).toEqual({ title: "Filing the form", apps: [] });
    expect(computerV2Facts(JSON.stringify({ code: `apps.open("Mail"); browsers.open("https://a.example.org/x"); apps.open("Mail"); apps.open("Xcode"); apps.open("Notes")` })))
      .toEqual({ apps: ["Mail", "a.example.org", "Xcode"] });
    expect(computerV2Facts("not json")).toEqual({ apps: [] });
    expect(computerV2Facts(JSON.stringify({ code: "apps.open(`${name}`)" }))).toEqual({ apps: [] });
  });
});

describe("IslandActivity — turn results", () => {
  const userTurn = (a: IslandActivity, sid: string, clientName = "orb") => {
    a.observe(ev({ type: "user_message", sessionId: sid, text: "do it", clientName }));
    a.observe(ev({ type: "turn_started", sessionId: sid }));
  };
  const end = (a: IslandActivity, sid: string, stopReason = "end_turn") =>
    a.observe(ev({ type: "turn_completed", sessionId: sid, stopReason, inputTokens: 1, outputTokens: 1 }));

  test("a turn that ends with the session idle publishes its last assistant text after the settle", async () => {
    const { activity, settle, told } = harness();
    userTurn(activity, "s1");
    activity.observe(ev({ type: "assistant_message", sessionId: "s1", text: "Working on it." }));
    activity.observe(ev({ type: "assistant_message", sessionId: "s1", text: "**Done.** The build is `green` now.\n\n- 3 tests fixed" }));
    activity.observe(ev({ type: "assistant_message", sessionId: "s1", threadId: "agent-1", text: "subagent words" }));
    end(activity, "s1");
    expect(activity.list().results).toEqual([]); // not before the settle
    settle();
    const [r] = activity.list().results;
    expect(r).toMatchObject({ sessionId: "s1", summary: "Done. The build is green now. 3 tests fixed", session: { title: "Title s1" } });
    expect(r!.id.startsWith("s1:")).toBe(true);
    await flush();
    expect(told()).toBe(1);
    // The session's next turn: the result is no longer the news.
    userTurn(activity, "s1");
    expect(activity.list().results).toEqual([]);
  });

  test("an intermediate turn of a loop publishes nothing: another turn starts within the settle", () => {
    const { activity, settle } = harness();
    userTurn(activity, "s1");
    activity.observe(ev({ type: "assistant_message", sessionId: "s1", text: "step one" }));
    end(activity, "s1");
    userTurn(activity, "s1", "computer-wake"); // the loop's next turn
    settle();
    expect(activity.list().results).toEqual([]);
    activity.observe(ev({ type: "assistant_message", sessionId: "s1", text: "all done" }));
    end(activity, "s1");
    settle();
    // A wake turn's own end, with the session idle, IS shown.
    expect(activity.list().results.map((r) => r.summary)).toEqual(["all done"]);
  });

  test("no result for an aborted or failed turn, a silent turn, an automated door's turn, a workflow child or routine, a card still waiting, or no island client", () => {
    const pendingCard = new Set<string>();
    const origins: Record<string, string> = { w1: "workflow-child", r1: "routine/nightly-triage", r2: "routine" };
    const { activity, settle, timers } = harness({
      hasPendingCard: (sid) => pendingCard.has(sid),
      facts: (sid) => ({ mode: "code", ...(origins[sid] === undefined ? {} : { origin: origins[sid] }) }),
    });
    for (const [sid, reason] of [["s1", "aborted"], ["s2", "error"]] as const) {
      userTurn(activity, sid);
      activity.observe(ev({ type: "assistant_message", sessionId: sid, text: "partial" }));
      end(activity, sid, reason);
    }
    userTurn(activity, "s3");
    end(activity, "s3"); // nothing said
    // Every automated door: another agent's message, Dispatch's spawn prompt, a Workflow agent() child's turn
    // (`runTurn(…, "workflow")`), a scheduled routine (`runTurn(…, "routine")`), the embedded runtime's self-check.
    for (const origin of ["messaging", "dispatch", "workflow", "routine", "embedded-probe"]) {
      expect(ISLAND_NO_RESULT_ORIGINS.has(origin)).toBe(true);
      userTurn(activity, `o-${origin}`, origin);
      activity.observe(ev({ type: "assistant_message", sessionId: `o-${origin}`, text: "reply" }));
      end(activity, `o-${origin}`);
    }
    expect(timers.length).toBe(0);
    // A Workflow's child or a routine's session, even on a turn a person typed into it.
    for (const sid of ["w1", "r1", "r2"]) {
      userTurn(activity, sid);
      activity.observe(ev({ type: "assistant_message", sessionId: sid, text: "done" }));
      end(activity, sid);
    }
    expect(timers.length).toBe(0);
    userTurn(activity, "s6");
    activity.observe(ev({ type: "assistant_message", sessionId: "s6", text: "asking" }));
    end(activity, "s6");
    pendingCard.add("s6");
    settle();
    expect(activity.list().results).toEqual([]);
    // A dispatch-wake turn (Dispatch reporting its children) is shown.
    userTurn(activity, "s7", "dispatch-wake");
    activity.observe(ev({ type: "assistant_message", sessionId: "s7", text: "Both children finished." }));
    end(activity, "s7");
    settle();
    expect(activity.list().results.map((r) => r.sessionId)).toEqual(["s7"]);

    const lonely = new IslandActivity({ facts: () => ({}), hosts: () => [], setTimer: () => { throw new Error("no timer without a client"); } });
    userTurn(lonely, "s1");
    lonely.observe(ev({ type: "assistant_message", sessionId: "s1", text: "done" }));
    end(lonely, "s1");
    expect(lonely.settling).toBe(0);
  });

  test("results age out after their time, one per session, and the summary is bounded", () => {
    let now = 1_000_000;
    const { activity, settle } = harness({ now: () => now });
    userTurn(activity, "s1");
    activity.observe(ev({ type: "assistant_message", sessionId: "s1", text: "x".repeat(1_000) }));
    end(activity, "s1");
    settle();
    const [r] = activity.list().results;
    expect(r!.summary.length).toBe(ISLAND_RESULT_SUMMARY_MAX);
    expect(r!.summary.endsWith("…")).toBe(true);
    now = r!.at + 11 * 60_000;
    expect(activity.list().results).toEqual([]);
    expect(islandResultSummary("```ts\nlet a = 1\n```\n# Title\n[link](https://x.y) ok")).toBe("Title link ok");
  });
});

describe("IslandActivity — watches", () => {
  test("lists every armed trigger with its session's facts, and tells the clients when one arms or ends", async () => {
    const armed = [{ sessionId: "s1", wakeId: "w_1", condition: "clicked", targetLabel: "Chrome — Dashboard", elementLabel: "“Submit”", armedAt: 5, expiresAt: 9 }];
    const { activity, told } = harness({ watches: () => armed });
    expect(activity.list().watches).toEqual([{ ...armed[0]!, session: { mode: "code", title: "Title s1" } }]);
    activity.observe(ev({ type: "wake_ended", sessionId: "s1", wakeId: "w_1", reason: "cancelled", at: 7, woken: false }));
    await flush();
    expect(told()).toBe(1);
    const broken = harness({ watches: () => { throw new Error("gone"); } });
    expect(broken.activity.list().watches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The doors, over a real IPC server.

/** Minimal raw NDJSON JSON-RPC client that also records notifications (`registry.test.ts`'s). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly notifications: string[] = [];

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
            } else if (typeof msg.method === "string" && msg.method !== METHODS.event) {
              c.notifications.push(msg.method);
            }
          }
        },
        drain() { c.writer.onDrain(); },
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

  hello(token: string, clientName: string, extra: Record<string, unknown> = {}, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName, ...extra });
  }

  close(): void { this.socket.end(); }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("island.activity over the socket", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  test("an island client is told on change and reads the activity; a remote or plugin connection is refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-island-activity-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const island = new IslandRegistry({ pending: { approval: () => false, question: () => false, elicitation: () => false }, facts: () => ({}), hosts: () => [] });
    const activity = new IslandActivity({ facts: () => ({ mode: "code" }), hosts: () => [] });
    hub.addObserver((e) => activity.observe(e));
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, island, islandActivity: activity });
    stop = () => { server.stop(); store.close(); };
    const sid = store.createSession("global", { cwd: tmpdir() });

    const app = await TestClient.connect(socketPath);
    expect((await app.hello(tokens.harness, "orb", { capabilities: [CLIENT_CAPABILITY_ISLAND] })).result.ok).toBe(true);
    hub.append(sid, { type: "tool_call", sessionId: sid, threadId: "main", callId: "c1", name: "computer_v2", argsJson: JSON.stringify({ title: "Filing it" }) } as never);
    await until(() => app.notifications.includes(ISLAND_ACTIVITY_CHANGED_NOTIFICATION));
    const parsed = IslandActivityResult.parse((await app.request(METHODS.islandActivity, {})).result);
    expect(parsed.computerUse.map((c) => [c.sessionId, c.title])).toEqual([[sid, "Filing it"]]);
    expect(parsed.results).toEqual([]);
    expect(parsed.watches).toEqual([]);

    expect(REMOTE_ALLOWED_METHODS.has(METHODS.islandActivity)).toBe(false);
    const remote = await TestClient.connect(socketPath);
    await remote.hello(tokens.remote, "iphone-gateway", { capabilities: [CLIENT_CAPABILITY_ISLAND] }, "remote");
    expect((await remote.request(METHODS.islandActivity, {})).error?.code).toBe(ERR.UNAUTHORIZED);
    const pluginToken = store.mintPluginToken("example-plugin");
    const plugin = await TestClient.connect(socketPath);
    expect((await plugin.hello(pluginToken, "example-plugin", { pluginId: "example-plugin", capabilities: [CLIENT_CAPABILITY_ISLAND] }, "plugin")).result.ok).toBe(true);
    expect((await plugin.request(METHODS.islandActivity, {})).error?.code).toBe(ERR.UNAUTHORIZED);
    const plain = await TestClient.connect(socketPath);
    expect((await plain.hello(tokens.harness, "tui")).result.ok).toBe(true);

    // A change now: only the island client hears of it — never the phone, a plugin or a harness without the capability.
    const heard = app.notifications.filter((n) => n === ISLAND_ACTIVITY_CHANGED_NOTIFICATION).length;
    hub.append(sid, { type: "tool_result", sessionId: sid, threadId: "main", callId: "c1", output: "", isError: false } as never);
    await until(() => app.notifications.filter((n) => n === ISLAND_ACTIVITY_CHANGED_NOTIFICATION).length > heard);
    await new Promise((r) => setTimeout(r, 30));
    for (const other of [remote, plugin, plain]) expect(other.notifications).not.toContain(ISLAND_ACTIVITY_CHANGED_NOTIFICATION);
    app.close();
    remote.close();
    plugin.close();
    plain.close();
  });
});
