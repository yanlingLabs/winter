import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import type { ToolContext } from "../../src/agent/tools/registry";

/**
 * b2-agent-browser T7 — **the live-gate walk, driven as far as a machine can drive it.**
 *
 * Spec §10 owes the user seven gates. Six of them have a daemon half, and until this file NOTHING in
 * the repo composed that half end to end: `browser.test.ts` fakes all four deps,
 * `browser-approvals.test.ts` fakes `dispatch` (so no command ever leaves the process),
 * `browser-wiring.test.ts` proves the deps point at the real daemon but never completes a round trip,
 * and the app-side tests (`PanelCommandConsumerTests`, `PanelCommandInteractionTests`) drive the
 * consumer against a fake CDP driver with no daemon in sight. The seam nobody crossed is the one in
 * the middle:
 *
 *   tool → PanelCommandRegistry.dispatch → hub.broadcastTransient → the socket → an ATTACHED CLIENT
 *   → `panel.commandResult` → PanelCommandRegistry.resolve → the tool's own outcome mapping.
 *
 * Every row below crosses it for real: a second process-local client connects over the daemon's own
 * unix socket, attaches to the session, receives the `panel_command` transient as a
 * `session.event` notification and answers it with the real RPC. What that client CANNOT be is CEF —
 * so it stands in for the consumer, and each row is careful to test only what the DAEMON is
 * responsible for on the far side of that answer (does the command arrive with the right shape; is
 * the app's verdict passed through untouched; does the tool fail fast when nobody can answer).
 *
 * The app's own half — CDP, the sensitive floor's field inspection, the scheme door — is pinned in
 * `apple/Norma/Tests/NormaAppTests`, and the composition of BOTH halves against real Chromium is the
 * human's gate. What is closed here is the gap between them.
 */

// ================================================================================================
// Harness
// ================================================================================================

/** Minimal raw NDJSON client, with the one addition this file needs over the copies in
 *  `browser-wiring.test.ts` / `session-list-signals.test.ts`: it can act as a PANEL CONSUMER —
 *  answering `panel_command` transients with `panel.commandResult`. (Each daemon-IPC test file in
 *  this repo carries its own client; the convention is recorded in settings-hot-e2e.test.ts.) */
class GateClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  /** Every `session.event` notification this client has been delivered, in order. */
  readonly events: any[] = [];
  /** Every `panel_command` it has seen — the wire shape, exactly as the Mac app would decode it. */
  readonly commands: any[] = [];
  /**
   * How this client answers a command. `null` means "say nothing" — the stand-in for an app that is
   * present but wedged, which is the only way to reach the tool's timeout branch without waiting out
   * a real 15–30s deadline.
   */
  answerWith: (cmd: any) => { ok: boolean; result?: string; imageBase64?: string } | null =
    () => ({ ok: true, result: "ok" });

  static async connect(socketPath: string, token: string, clientName: string): Promise<GateClient> {
    const c = new GateClient();
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
              if (msg.params?.type === "panel_command") c.onCommand(msg.params);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
    return c;
  }

  private onCommand(cmd: any): void {
    this.commands.push(cmd);
    const answer = this.answerWith(cmd);
    if (!answer) return;
    // Fire and forget, exactly as the app does (`PanelCommandConsumer.answer` sends and never awaits
    // the daemon's `{ok:true}`) — the tool is awaiting the REGISTRY, not this RPC's reply.
    void this.request(METHODS.panelCommandResult, {
      sessionId: cmd.sessionId, commandId: cmd.commandId,
      ok: answer.ok,
      ...(answer.result !== undefined && { result: answer.result }),
      ...(answer.imageBase64 !== undefined && { imageBase64: answer.imageBase64 }),
    });
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async newSession(cwd: string, extra?: Record<string, unknown>): Promise<string> {
    const { result } = await this.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto", ...extra });
    return result.sessionId as string;
  }

  attach(sessionId: string): Promise<any> {
    return this.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
  }

  eventsOfType(type: string): any[] { return this.events.filter((e) => e.type === type); }

  close(): void { this.socket.end(); }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Poll until `pred` holds or the budget runs out. Used only for facts that cross the socket, where
 *  "it happened" is observable but "it has arrived" is not synchronous. */
async function until(pred: () => boolean, budgetMs = 4_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a socket-delivered fact");
    await sleep(5);
  }
}

/** The async twin of `until`, for a fact that has to be ASKED for (an RPC) rather than observed on
 *  the event stream. Returns the first answer that satisfies `pred`. */
async function untilAnswer<T>(ask: () => Promise<T>, pred: (v: T) => boolean, budgetMs = 4_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await ask();
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for an RPC-observable fact");
    await sleep(10);
  }
}

/** One `browser` tool call, as a scripted turn: the call, then a plain text round to end the turn. */
function browserTurn(args: Record<string, unknown>, callId = "c1"): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId, name: "browser", argsJson: JSON.stringify(args) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

describe("b2-t7 gate walk: the composed command channel (daemon → panel_command → consumer → result)", () => {
  let daemon: RunningDaemon | undefined;
  let home: string | undefined;
  const clients: GateClient[] = [];

  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    daemon?.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function boot(script: ProviderEvent[][] = []): Promise<{ d: RunningDaemon; provider: FakeProvider }> {
    home = mkdtempSync(join(tmpdir(), "norma-b2t7-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const provider = new FakeProvider(script);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider, model: "fake-1" } });
    return { d: daemon, provider };
  }

  async function client(clientName: string): Promise<GateClient> {
    const c = await GateClient.connect(daemon!.socketPath, daemon!.tokens.harness, clientName);
    clients.push(c);
    return c;
  }

  /** A ToolContext of the shape `browser-wiring.test.ts` uses — enough for `registry.execute`, and
   *  deliberately NOT the engine's (no approval stamp, no vision flag): every row that needs the
   *  engine drives a real turn instead. */
  function ctx(sessionId: string, mode: "code" | "chat" | "dispatch" = "code"): ToolContext {
    return { cwd: home!, roots: [home!], sessionId, mode } as ToolContext;
  }

  // ----------------------------------------------------------------------------------------------
  // GATE 1 — "Agent opens a tab and browses while the user watches the strip."
  // ----------------------------------------------------------------------------------------------

  test("GATE 1: a REAL turn loads the deferred tool, opens a tab, and navigates it — and the command arrives at the attached consumer with the wire shape the app decodes", async () => {
    // The full engine path, not `registry.execute`: `browser` is `deferred: ["code","dispatch"]`, so a
    // code session must ToolSearch it first — which is also the round that would have caught T4's
    // unthreaded `ctx.mode` (a code session handed chat's read-only schema). Scripting it here means
    // this row fails if that threading ever regresses AND if the command channel ever breaks.
    await boot([
      [{ type: "tool_call", callId: "t0", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:browser" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "t1", name: "browser", argsJson: JSON.stringify({ verb: "open", url: "https://example.com", title: "Ex" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "t2", name: "browser", argsJson: JSON.stringify({ verb: "navigate", url: "https://example.com/next" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "t3", name: "browser", argsJson: JSON.stringify({ verb: "read" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "browsed" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const app = await client("orb");
    const sessionId = await app.newSession(home!);
    await app.attach(sessionId);
    app.answerWith = (cmd) => cmd.action === "read"
      ? { ok: true, result: "Example Domain\nThis domain is for use in illustrative examples." }
      : { ok: true, result: `did ${cmd.action}` };

    await app.request(METHODS.sessionSend, { sessionId, text: "browse example.com" });
    await until(() => app.eventsOfType("turn_completed").length > 0, 15_000);

    // What the model got back, in order — the ToolSearch load, then the three browser calls.
    const results = app.eventsOfType("tool_result");
    expect(results.map((r) => r.isError)).toEqual([false, false, false, false]);
    expect(results[1]!.output).toContain("opened tab ");
    expect(results[3]!.output).toContain("Example Domain");

    // THE SEAM: the commands really crossed the socket, in the app's own decode shape.
    expect(app.commands.map((c) => c.action)).toEqual(["navigate", "read"]);
    const nav = app.commands[0]!;
    expect(nav.sessionId).toBe(sessionId);
    expect(nav.url).toBe("https://example.com/next");
    expect(typeof nav.commandId).toBe("string");
    expect(nav.deadlineMs).toBe(30_000);
    // The tabId the daemon minted for `open` is the tab the later verbs drive — the agent never
    // named one, and the ACTIVE-tab default resolved it. This is the fact the user watches in the
    // strip: one tab, opened by the agent, then driven.
    const listed = await app.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs).toHaveLength(1);
    expect(nav.tabId).toBe(listed.result.tabs[0].tabId);
    expect(listed.result.activeTabId).toBe(nav.tabId);
  }, 30_000);

  // ----------------------------------------------------------------------------------------------
  // GATE 2 — "Same task with the window CLOSED — work completes headless; reopening shows the tabs."
  // ----------------------------------------------------------------------------------------------

  test("GATE 2: with the window closed, `open`/`tabs` still work and say so honestly; the fold survives, and a reopened window sees the same tabs", async () => {
    const { d } = await boot();
    const app = await client("orb");
    const sessionId = await app.newSession(home!);
    // No attach: the daemon's own record of "is anyone showing this session" is the attachment set,
    // which is exactly what a closed window drops.

    const opened = await d.registry!.execute("browser", { verb: "open", url: "https://example.com" }, ctx(sessionId));
    expect(opened.isError).toBe(false);
    // Spec §3's "honest and fast": the tab is REAL (it is in the fold below), and the model is told
    // plainly that nothing has loaded it — so it cannot read the success as "the page is ready".
    expect(opened.output).toContain("isn't showing this session");

    const tabs = await d.registry!.execute("browser", { verb: "tabs" }, ctx(sessionId));
    expect(tabs.isError).toBe(false);
    expect(tabs.output).toContain("https://example.com");

    // "Reopening shows the tabs": a window opening is a client attaching and replaying. The tab
    // events are PERSISTED (unlike `panel_command`, which is transient), so the fold the app builds
    // on open carries them.
    const reopened = await client("orb-reopened");
    await reopened.attach(sessionId);
    await until(() => reopened.eventsOfType("panel_tab_opened").length > 0);
    const fold = await reopened.request(METHODS.panelList, { sessionId });
    expect(fold.result.tabs.map((t: any) => t.url)).toEqual(["https://example.com"]);
  }, 20_000);

  // ----------------------------------------------------------------------------------------------
  // GATE 3 — "Chat session: read verbs work, interaction verbs are absent from the tool schema."
  // ----------------------------------------------------------------------------------------------

  test("GATE 3: in a CHAT session the tool's advertised schema carries only the read verbs, and an interaction verb is REJECTED even if the model calls it anyway", async () => {
    const { provider } = await boot([
      [{ type: "tool_call", callId: "c1", name: "browser", argsJson: JSON.stringify({ verb: "click", selector: "button" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const app = await client("orb");
    const sessionId = await app.newSession(home!, { mode: "chat" });
    await app.attach(sessionId);

    await app.request(METHODS.sessionSend, { sessionId, text: "click the button" });
    await until(() => app.eventsOfType("turn_completed").length > 0, 15_000);

    // (a) WHAT THE MODEL WAS SHOWN. `browser` is a DEFAULT tool in chat (not deferred there), so its
    // schema is in the very first request — and its verb enum is the read set and nothing else.
    const shown = provider.requests[0]!.tools?.find((t) => t.name === "browser");
    expect(shown).toBeDefined();
    const verbs = (shown!.parameters as any).properties.verb.enum as string[];
    expect(verbs.sort()).toEqual(["back", "navigate", "open", "read", "screenshot", "tabs"]);
    for (const interact of ["click", "type", "scroll", "submit", "wait"]) expect(verbs).not.toContain(interact);
    // The interaction OPERANDS are absent too — chat is not shown a `selector`/`text` it could not use.
    expect(Object.keys((shown!.parameters as any).properties).sort()).toEqual(["tabId", "title", "url", "verb"]);

    // (b) WHAT WAS ACCEPTED. Advertising is not enforcement: the provider ignored the schema and
    // called `click` regardless, and the registry's own `argsFor` rejected it at validation.
    const result = app.eventsOfType("tool_result")[0]!;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("invalid arguments for browser");
    // Nothing was sent: a rejected call never reaches the command channel at all.
    expect(app.commands).toHaveLength(0);
  }, 20_000);

  // ----------------------------------------------------------------------------------------------
  // GATE 5 — "The sensitive floor: an unattended `type` into a password field is refused, VISIBLY."
  // ----------------------------------------------------------------------------------------------

  test("GATE 5: the app's floor refusal arrives as the TOOL's own error result, word for word — the daemon neither softens it nor re-words it", async () => {
    const { d } = await boot();
    const app = await client("orb");
    const sessionId = await app.newSession(home!);
    await app.attach(sessionId);
    await d.registry!.execute("browser", { verb: "open", url: "https://example.com" }, ctx(sessionId));

    // The EXACT sentence `SensitiveFieldFloor.refusal(kind:evidence:)` builds
    // (apple/Norma/Sources/AppShell/BrowserInteractionPolicy.swift). Transcribed, not imported —
    // there is no cross-language constant, and inventing one would be a hand-mirrored pair. What this
    // row pins is NOT the wording (the app's own XCTests own that) but the daemon's PASS-THROUGH: the
    // floor's verdict is computed against a DOM this daemon has never seen, so any edit here is this
    // layer pretending to a judgement it did not make.
    const FLOOR_REFUSAL =
      "refused: that is a password field (type=\"password\"), and Norma never types into one. This is not a "
      + "retryable failure and no different selector will change it — ask the person to fill that "
      + "field in themselves.";
    app.answerWith = () => ({ ok: false, result: FLOOR_REFUSAL });

    const res = await d.registry!.execute(
      "browser", { verb: "type", selector: "input[name=\"pw\"]", text: "hunter2" }, ctx(sessionId),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toBe(FLOOR_REFUSAL);
    // And the command that earned it carried exactly the two operands, built field by field — no
    // approval key of any kind travels with a `type` (the T6 seam, observed here on the real wire
    // rather than against a fake dispatch).
    expect(app.commands).toHaveLength(1);
    expect(app.commands[0]!.args).toEqual({ selector: "input[name=\"pw\"]", text: "hunter2" });
  }, 20_000);

  // ----------------------------------------------------------------------------------------------
  // GATE 6 — "Mac app quit mid-task: the tool fails fast with the honest message; `tabs` still answers."
  // ----------------------------------------------------------------------------------------------

  test("GATE 6: the app goes away mid-task — the next command verb fails FAST with the honest message while `tabs` and `open` keep answering from the daemon's own record", async () => {
    const { d } = await boot();
    const app = await client("orb");
    const sessionId = await app.newSession(home!);
    await app.attach(sessionId);
    await d.registry!.execute("browser", { verb: "open", url: "https://example.com" }, ctx(sessionId));

    // One command that works, so the "after" is a change and not the initial state.
    app.answerWith = () => ({ ok: true, result: "page text" });
    const before = await d.registry!.execute("browser", { verb: "read" }, ctx(sessionId));
    expect(before.output).toBe("page text");

    // THE QUIT. Closing the socket is what the daemon actually observes when the app dies — the hub
    // drops the attachment on the connection's close, which is the sole input to the availability
    // gate. Teardown is close-driven and therefore not synchronous with this test's next line, so a
    // SEPARATE, never-attached observer waits for the daemon to have noticed before the timing
    // assertion below runs — otherwise "fast" could be measured against a daemon that still thought
    // the app was there.
    const observer = await client("observer");
    app.close();
    clients.splice(clients.indexOf(app), 1);
    await untilAnswer(
      () => observer.request(METHODS.sessionList),
      (list) => list.result.sessions.find((s: any) => s.sessionId === sessionId)?.signals?.attachedElsewhere === false,
    );

    const started = Date.now();
    const after = await d.registry!.execute("browser", { verb: "read" }, ctx(sessionId));
    // FAST: the `read` deadline is 20s, so anything under a second proves the refusal came from the
    // availability gate rather than from waiting the command out.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(after.isError).toBe(true);
    expect(after.output).toContain("browser unavailable");

    // …and the two daemon-answered verbs are untouched by the app being gone (spec §2: `tabs` is also
    // the drivability probe, which is only useful if it survives exactly this).
    const tabs = await d.registry!.execute("browser", { verb: "tabs" }, ctx(sessionId));
    expect(tabs.isError).toBe(false);
    expect(tabs.output).toContain("https://example.com");
    const opened = await d.registry!.execute("browser", { verb: "open", url: "https://second.example" }, ctx(sessionId));
    expect(opened.isError).toBe(false);
    expect(opened.output).toContain("isn't showing this session");
  }, 30_000);

  // ----------------------------------------------------------------------------------------------
  // GATE 6 (the other half) — a client that is attached but cannot answer.
  // ----------------------------------------------------------------------------------------------

  test("GATE 6b: a PHONE-only session refuses instantly rather than dispatching a command nothing can run", async () => {
    const { d } = await boot();
    const app = await client("orb");
    const sessionId = await app.newSession(home!);
    await d.registry!.execute("browser", { verb: "open", url: "https://example.com" }, ctx(sessionId));

    // A terminal client: `canHostPanel`'s second denial (TERMINAL_CLIENT_PREFIXES). The phone's
    // `role === "remote"` denial cannot be driven from here without a paired gateway, and is pinned
    // in browser.test.ts against the same predicate.
    const cli = await client("cli-abc123");
    await cli.attach(sessionId);
    await until(() => cli.eventsOfType("harness_attached").length > 0);

    const started = Date.now();
    const res = await d.registry!.execute("browser", { verb: "read" }, ctx(sessionId));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("a phone or a terminal has no browser to drive");
    expect(res.output).toContain("cli-abc123");
    // Nothing was dispatched — the CLI never saw a command it could not have run.
    expect(cli.commands).toHaveLength(0);
  }, 20_000);

  // ----------------------------------------------------------------------------------------------
  // GATE 7 — "an agent browsing in an unattached CHAT session survives past the linger."
  // ----------------------------------------------------------------------------------------------

  test("GATE 7: mid-browse, with the last client gone, a CHAT session's row still reports `working` — the signal the app's lifecycle holds the browser on", async () => {
    // The turn PARKS on a browser command (the consumer never answers), so the turn is genuinely
    // running while the observation is made — this is the real `AgentEngine.isRunning` feeding the
    // real `session.list` derivation, not a stubbed engine.
    const { d } = await boot(browserTurn({ verb: "read" }));
    const app = await client("orb");
    const sessionId = await app.newSession(home!, { mode: "chat" });
    await app.attach(sessionId);
    await d.registry!.execute("browser", { verb: "open", url: "https://example.com" }, ctx(sessionId, "chat"));
    app.answerWith = () => null; // present, but wedged: the command is never answered

    await app.request(METHODS.sessionSend, { sessionId, text: "read the page" });
    await until(() => app.commands.length > 0, 10_000);

    // The window closes mid-browse. A SECOND client asks the question, because
    // `attachedElsewhere` deliberately excludes the ASKER's own attachment — with only one client in
    // the room, the answer would be true for the wrong reason.
    const observer = await client("observer");
    app.close();
    clients.splice(clients.indexOf(app), 1);

    const list = await untilAnswer(
      () => observer.request(METHODS.sessionList),
      (l) => l.result.sessions.find((s: any) => s.sessionId === sessionId)?.signals?.attachedElsewhere === false,
    );
    const row = list.result.sessions.find((s: any) => s.sessionId === sessionId);
    // Both halves of spec §5's surface, on a CHAT row: nobody is holding it open, and it is working.
    // `working:true` with `attachedElsewhere:false` is precisely the pair the Mac app's
    // BrowserSignalsCoordinator needs to keep a headless agent's browser alive past the linger.
    expect(row.signals).toEqual({ attachedElsewhere: false, working: true });
    // …and chat still has no lifecycle LABEL (T1's other claim — the signals are not the label).
    expect(row.activity).toBeUndefined();
  }, 30_000);
});
