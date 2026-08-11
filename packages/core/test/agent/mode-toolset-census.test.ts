import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { PermissionGate, isGateClassified } from "../../src/agent/gate";

/**
 * R-T3 whole-branch review, Important 1 (FIX 1). mode-toolset-equivalence.test.ts pins the EXACT
 * offered set per mode — strong, but only for the ~14 register* calls its own harness function
 * mirrors. daemon.ts makes ~24 register*Tool(s) calls; the reviewer proved by mutation that a
 * stray `modes` entry on any tool NOT in that harness (schedule, send_message, bash_output,
 * agent_list, agent_output, exit_plan_mode, enter_plan_mode, task_create/_update/_list/_get,
 * list_mcp_resources/read_mcp_resource) sails through the full 2701-test suite untouched — the
 * exact scenario the deleted CHAT_ALLOW_TOOLS/DISPATCH_ALLOW_TOOLS parity test WOULD have caught
 * (adding "schedule" to CHAT_ALLOW_TOOLS alone used to fail it).
 *
 * Two ways to close this were on the table: (a) grow mode-toolset-equivalence.test.ts's harness to
 * mirror every one of daemon.ts's register* calls, or (b) stop mirroring daemon.ts's registration
 * and instead walk it directly. (a) is a second hand-maintained list — exactly the shape this
 * whole refactor deletes elsewhere, and it silently re-opens the same hole the day daemon.ts grows
 * a 25th register* call nobody remembers to mirror into the test file too. (b) has no such gap by
 * construction: it boots `startDaemon()` for real — the SAME precedent server.test.ts,
 * ipc/remote-allowlist-parity.test.ts, and routines/e2e.test.ts already use for "prove it against
 * the real daemon, not a stand-in" coverage — with a temp NORMA_HOME and an injected FakeProvider
 * (no network/creds/API calls), then reads `daemon.registry`: literally the SAME ToolRegistry
 * instance every one of daemon.ts's register* calls populates at boot (threaded out via
 * RunningDaemon.registry — daemon.ts). There is no second harness to fall out of sync, because
 * there is no second harness — this IS daemon.ts's own registration path.
 *
 * The trade-off the reviewer flagged for (b) — "not a brittle snapshot nobody updates thoughtfully"
 * — is why the expected sets below are hand-written literals (mirroring
 * mode-toolset-equivalence.test.ts's own pins), not machine-generated: adding a 25th tool means a
 * human deliberately decides which of these three literals it belongs in, same review-friction the
 * deleted CHAT_ALLOW_TOOLS constant used to force, not a snapshot file nobody reads before
 * accepting.
 *
 * `computerUse.enabled: true` is set in this test's settings.json so `computer` (off by default)
 * joins the census too — every other tool below registers unconditionally inside daemon.ts's
 * `if (agentProvider)` gate regardless of settings. No mcpServers/plugins are configured, so no
 * `mcp__`/`plugin__` dynamic names appear — those are runtime-discovered, not `modes`-declared, and
 * out of scope for a static per-tool-file census.
 */
function tempHomeWithSettings(): string {
  const home = mkdtempSync(join(tmpdir(), "norma-tool-census-"));
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        // Never actually used to create a live provider — startDaemon's injected `agentProvider`
        // below (a FakeProvider) short-circuits createProvider() entirely. Present only because
        // Settings.provider is a required field.
        provider: { type: "codex-oauth", model: "gpt-5.4" },
        computerUse: { enabled: true },
      },
      null,
      2,
    ),
  );
  return home;
}

describe("daemon tool census (R-T3 whole-branch review FIX 1): real registration path pins each mode's derived set", () => {
  let daemon: RunningDaemon | undefined;
  let home: string | undefined;

  afterEach(() => {
    daemon?.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function boot(): Promise<RunningDaemon> {
    home = tempHomeWithSettings();
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({
      home,
      secrets,
      agentProvider: { provider: new FakeProvider([]), model: "fake-1" },
    });
    return daemon;
  }

  // b2-agent-browser T4: ADDED "browser" to ALL THREE literals (SANCTIONED pin move — spec §1 gives
  // every mode a browser: `modes: ["code","dispatch","chat"]`, deferred in code/dispatch and
  // immediate in chat where it is the primary web surface). This is the deliberate three-literal
  // decision this file's header asks a human to make, not a mechanical re-baseline: chat's set going
  // from 3 names to 4 is the whole point of the task, and the per-MODE difference that matters —
  // chat's schema carrying only the read verbs — is invisible to `namesForMode` (which reports
  // ELIGIBILITY, exactly as the dispatch block below records for deferral) and is pinned separately
  // in test/agent/tools/browser.test.ts.
  test("code mode is offered EXACTLY the full daemon tool surface (36 tools)", async () => {
    const d = await boot();
    expect(d.registry).not.toBeNull();
    const offered = [...d.registry!.namesForMode("code", { builtinDeferral: true })];
    expect(offered.sort()).toEqual(
      [
        "read", "ls", "glob", "grep",
        "write", "edit",
        "bash", "bash_output",
        "Skill", "ToolSearch",
        "ask_user",
        "task_create", "task_update", "task_list", "task_get",
        "exit_plan_mode", "enter_plan_mode",
        "notebook_edit",
        "push_notification",
        "enter_worktree", "exit_worktree",
        "web_fetch", "web_search",
        "spawn_agent",
        "send_message",
        "task_stop",
        "agent_list", "agent_output",
        "skill_write",
        "computer",
        "schedule",
        "lsp",
        "list_mcp_resources", "read_mcp_resource",
        "Workflow",
        "browser",
      ].sort(),
    );
  });

  // B2-T2: dispatch's immediate set gains "ReadPage" too (SANCTIONED pin move — task-2-brief.md's
  // "dispatch immediate set += ReadPage"): registered `modes: ["chat","dispatch"]`, NOT deferred.
  // D1-T2: dispatch's set changes here — deliberately, not a mechanical re-baseline:
  //   - REMOVED "ask_user": ask-user.ts drops "dispatch" from its own `modes` (dispatch now uses
  //     AskQuestion's simplified, header-less question card instead).
  //   - ADDED "AskQuestion": ask-question.ts gains "dispatch" in its `modes` (previously chat-only).
  //   `namesForMode` reports MODE ELIGIBILITY, not live specs()-visibility — it does not care that
  //   AskQuestion (like bash/task_stop/computer/send_message) is ALSO now `deferred: ["dispatch"]`
  //   there; a deferred tool is still an eligible member of the mode's allowTools ceiling, only
  //   hidden from a given round's specs() until ToolSearch-loaded. That's why bash/task_stop/
  //   computer (unchanged `modes`) do NOT move here even though their deferred status did — this
  //   list is still exactly 12 names, just AskQuestion in ask_user's old slot.
  // D1-T4: ADDED "send_message" — send-message.ts's `modes` was absent (defaulting to `["code"]`,
  //   registry.ts's own doc comment), which left its `deferred: ["dispatch"]` (set back in D1-T2)
  //   INERT for dispatch: a mode a tool isn't eligible for can never be "deferred" for it either,
  //   so dispatch's namesForMode simply never included it. Task 4 gives dispatch a real reason to
  //   call send_message (messaging the sessions it spawns via session_spawn), so `modes` widened
  //   to `["code", "dispatch"]` — making this list 13 names now, not a re-baseline of anything else.
  // session-activity-hygiene T8: ADDED "list_sessions" and "manage_session" — dispatch's management
  //   surface over the session lifecycle, both registered `modes: ["dispatch"]` in list-sessions.ts
  //   (never eligible for code or chat; the "no modes = code-only" default is what makes that an
  //   opt-in rather than an omission). 16 names now — a deliberate pin move for two new tools, not a
  //   re-baseline of anything else.
  // dispatch-tool-deferral: both are now ALSO `deferred: true` (list-sessions.ts) — loaded via
  //   ToolSearch like bash/task_stop/computer/AskQuestion/send_message, superseding this comment's
  //   original "NOT deferred" call. This list is UNCHANGED by that: `namesForMode` reports
  //   ELIGIBILITY, not deferred-vs-immediate (registry.ts's own doc comment — see the task_stop
  //   describe block below for the axis this list structurally can't see); the eligible-vs-loadable
  //   distinction is pinned separately, in dispatch-deferred.test.ts.
  test("dispatch mode is offered EXACTLY this set (17 tools)", async () => {
    const d = await boot();
    const offered = [...d.registry!.namesForMode("dispatch", { builtinDeferral: true })];
    expect(offered.sort()).toEqual(
      [
        "Search", "ReadPage", "ToolSearch", "AskQuestion", "bash", "computer", "glob", "grep", "ls",
        "push_notification", "read", "send_message", "session_spawn", "task_stop",
        "list_sessions", "manage_session", "browser",
      ].sort(),
    );
  });

  // B2-T2: chat's exact offered set becomes AskQuestion + ReadPage + Search (SANCTIONED pin move —
  // task-2-brief.md's "chat exact set -> [AskQuestion, ReadPage, Search]").
  test("chat mode is offered EXACTLY AskQuestion + ReadPage + Search + browser", async () => {
    const d = await boot();
    const offered = [...d.registry!.namesForMode("chat", { builtinDeferral: true })];
    expect(offered.sort()).toEqual(["AskQuestion", "ReadPage", "Search", "browser"].sort());
  });

  // B2-T2 forward guard (task-2-brief.md: "census must ALSO assert FetchPage appears in NO mode —
  // add that assertion now ... so Task 3 cannot accidentally register it"). FetchPage is the
  // research sub-agent's OWN tiny toolset (spec §6) and must never land in the daemon's shared
  // registry at all — not excluded from any mode, simply never registered, so `has()` is false and
  // every mode's derived set is unaffected by construction.
  test("FetchPage is registered in NO mode — the research sub-agent's tool never joins the daemon's shared registry (forward guard for Task 3)", async () => {
    const d = await boot();
    expect(d.registry!.has("FetchPage")).toBe(false);
    for (const mode of ["code", "dispatch", "chat"] as const) {
      expect(d.registry!.namesForMode(mode, { builtinDeferral: true }).has("FetchPage")).toBe(false);
    }
  });

  /**
   * THE GATE-CLASSIFICATION COMPLETENESS PIN (b2-agent-browser T7, the whole-branch structural carry).
   *
   * Registering a tool and CLASSIFYING it in `agent/gate.ts` are two independent edits, and nothing
   * has ever connected them. `modes` decides which sessions may see a tool; gate.ts decides what
   * happens when one calls it. A tool that has the first and not the second is registered, offered,
   * listed in every census literal above — and then fails CLOSED at the gate: denied under `plan`,
   * denied under `dont-ask` (engine.ts converts a still-"ask" call there), and carded on EVERY call
   * under `auto`, which in a dispatch session is a prompt nobody can answer.
   *
   * It happened TWICE on one branch. `browser` was unclassified until T6 measured it through the real
   * engine (dead in chat, its primary mode); T6's review then found `list_mcp_resources` /
   * `read_mcp_resource` in the same state, shipped that way for far longer. Neither was caught by a
   * green 3900-test suite, and the reason is structural rather than an oversight: every existing tool
   * test calls `registry.execute` with a hand-built ToolContext, so no exhaustive tool test crosses
   * the gate at all, and this file's own literals are about `modes`, a different axis entirely.
   *
   * THE SET WALKED is the union of the three modes' offered names — i.e. every tool any session can
   * call. A def eligible for no mode is deliberately out of scope: nothing can dispatch it, so what
   * the gate would say about it is moot. Dynamic `mcp__`/`plugin__` names are covered by
   * `isGateClassified`'s own external branch (they earn a real per-policy verdict), not by this walk,
   * which sees only what `startDaemon` registers.
   *
   * MUTATION-PROVEN by removing a name from its class in gate.ts: the tool stays registered, stays in
   * every literal above, and this row goes red alone.
   */
  test("COMPLETENESS: every tool the daemon registers resolves to a class in gate.ts — no silent fall-through to the fail-closed branch", async () => {
    const d = await boot();
    const offered = new Set<string>();
    for (const mode of ["code", "dispatch", "chat"] as const) {
      for (const name of d.registry!.namesForMode(mode, { builtinDeferral: true })) offered.add(name);
    }
    // Sanity: the walk is looking at a populated registry, not an empty one that would pass vacuously.
    expect(offered.size).toBeGreaterThan(30);
    const unclassified = [...offered].filter((name) => !isGateClassified(name)).sort();
    // Named in the failure, not just counted — the fix is "decide which class this tool belongs in",
    // and the message should say which tool.
    expect(unclassified).toEqual([]);
  });

  /**
   * The other half of the same claim, and the reason the pin above is worth having: for the two names
   * T7 classified, assert the VERDICTS rather than only the membership. `list_mcp_resources` /
   * `read_mcp_resource` are read-only listings over the user's own configured MCP servers, so they
   * must be free at this gate under every policy — most pointedly under `plan`, where a research
   * session's whole job is reading, and where they answered "deny" until this task.
   *
   * Compared CELL BY CELL against `ReadPage`'s row (the same NETWORK shape, classified since B2-T2),
   * so this pins "the same answer as an already-agreed member of the class" rather than a literal
   * transcribed from the implementation.
   */
  test("the two MCP resource tools are NETWORK-classified: their whole policy row matches ReadPage's, and `plan` allows them", () => {
    const gate = new PermissionGate();
    const policies = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass", "chat"] as const;
    for (const name of ["list_mcp_resources", "read_mcp_resource"]) {
      for (const policy of policies) {
        expect({ name, policy, verdict: gate.evaluate(name, policy) })
          .toEqual({ name, policy, verdict: gate.evaluate("ReadPage", policy) });
      }
      expect(gate.evaluate(name, "plan")).toBe("allow");
      expect(gate.evaluate(name, "auto")).toBe("allow");
    }
  });

  /**
   * The third name the completeness pin turned up — and the one it found ON ITS OWN, which is the
   * empirical case for the pin existing.
   *
   * `session_spawn` is MUTATING, not READ_ONLY beside `spawn_agent`: its child is created at a FIXED
   * `auto` policy (dispatch-children.ts), so the clause that earns spawn_agent its READ_ONLY (the
   * child inherits the caller's policy) does not hold. See gate.ts's own entry.
   *
   * Pinned as a WHOLE ROW rather than one cell, because the point is which cell MOVED: only `auto`
   * (an un-answerable card in a headless dispatch session → allow). `plan` still denies — a planning
   * session must not be able to start an unattended auto-policy session — and that is the cell a
   * careless "just make it READ_ONLY" fix would have silently opened.
   */
  test("session_spawn is MUTATING: `auto` allows (no un-answerable card), `plan` still DENIES (no unattended session started while planning)", () => {
    const gate = new PermissionGate();
    const row = Object.fromEntries(
      (["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass", "chat"] as const)
        .map((p) => [p, gate.evaluate("session_spawn", p)]),
    );
    expect(row).toEqual({
      plan: "deny", "dont-ask": "ask", ask: "ask", "accept-edits": "ask",
      auto: "allow", bypass: "allow", chat: "deny",
    });
    // The class it was NOT put in, asserted by contrast: spawn_agent allows under plan, session_spawn
    // must not.
    expect(gate.evaluate("spawn_agent", "plan")).toBe("allow");
  });
});

/**
 * Whole-branch review FIX 3: daemon.ts:665 quietly changed task_stop's registration from
 * `deferred: true` (deferred in every mode it's eligible for) to `deferred: ["dispatch"]`
 * (immediate in code) — an unrequested regression from CC parity (TaskStop is deferred there)
 * nobody named. `namesForMode` above reads ELIGIBILITY (`modes`), not deferral, so it can never
 * catch this — task_stop is eligible for ["code","dispatch"] either way. And
 * mode-toolset-equivalence.test.ts's own `offered()` unions specs()-visible names WITH the
 * deferred-bullet list, so task_stop being immediate-vs-deferred in code is invisible there too.
 * Every existing test was blind to this axis.
 *
 * This test closes the gap the way mode-toolset-census's own header comment argues for: no second
 * hand-maintained harness, drive the REAL `startDaemon()` registration path through REAL turns
 * (session.create + session.send over the actual IPC socket) and read the injected FakeProvider's
 * own captured `TurnRequest`s — the specs() list (`req.tools`) and the deferred-bullets list
 * (parsed from `req.instructions`) as DISTINCT assertions per mode, never unioned.
 */
describe("task_stop deferred flag (whole-branch review FIX 3): real turns through the REAL daemon wiring", () => {
  let daemon: RunningDaemon | undefined;
  let home: string | undefined;

  afterEach(() => {
    daemon?.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  /** Minimal raw NDJSON test client — each daemon-IPC test file in this repo carries its own copy
   *  (see settings-hot-e2e.test.ts's doc comment for the convention; no shared harness module
   *  exists). */
  class TestClient {
    private decoder = new LineDecoder();
    private nextId = 1;
    private pending = new Map<number, (msg: any) => void>();
    readonly notifications: any[] = [];
    private socket!: Awaited<ReturnType<typeof Bun.connect>>;
    private writer!: ConnWriter;

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
              } else if (msg.method) {
                c.notifications.push(msg);
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

    async hello(token: string, clientName: string): Promise<any> {
      return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
    }

    close(): void { this.socket.end(); }

    completedTurns(): number {
      return this.notifications.filter((n) => n.method === METHODS.event && n.params.type === "turn_completed").length;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function driveTurn(c: TestClient, sessionId: string, text: string, timeoutMs = 5000): Promise<void> {
    const before = c.completedTurns();
    await c.request(METHODS.sessionSend, { sessionId, text });
    const deadline = Date.now() + timeoutMs;
    while (c.completedTurns() <= before) {
      if (Date.now() > deadline) throw new Error("timed out waiting for turn_completed");
      await sleep(10);
    }
  }

  /** Names in the "# Deferred tools" bullet list (buildInstructionsFull's own `- ${name} —
   *  ${description}` format) — mirrors dispatch-deferred.test.ts's own `deferredBullets()` regex. */
  function bulletNames(instructions: string | undefined): string[] {
    return [...(instructions ?? "").matchAll(/^- (?!\*\*)(\S+) —/gm)].map((m) => m[1]!);
  }

  test("task_stop is deferred in BOTH code and dispatch, read as DISTINCT specs-list/bullets-list assertions", async () => {
    home = tempHomeWithSettings();
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    // Content-agnostic: every round just ends the turn — this test only inspects what the provider
    // was OFFERED (req.tools/req.instructions), never what it says back.
    const fake = new FakeProvider([[{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "task-stop-fix3");

    const cwd = mkdtempSync(join(tmpdir(), "norma-tool-census-taskstop-cwd-"));
    const { result: code } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: code.sessionId, fromSeq: 0 });
    const codeIdx = fake.requests.length;
    await driveTurn(c, code.sessionId, "hi");
    const codeReq = fake.requests[codeIdx]!;

    const { result: disp } = await c.request(METHODS.sessionDispatch, {});
    await c.request(METHODS.sessionAttach, { sessionId: disp.sessionId, fromSeq: 0 });
    const dispIdx = fake.requests.length;
    await driveTurn(c, disp.sessionId, "hi");
    const dispReq = fake.requests[dispIdx]!;

    // THE assertions: specs() list and bullets list, read SEPARATELY, per mode — the exact
    // distinction every prior test collapsed into one set.
    expect(codeReq.tools?.map((t) => t.name)).not.toContain("task_stop");
    expect(bulletNames(codeReq.instructions)).toContain("task_stop");
    expect(dispReq.tools?.map((t) => t.name)).not.toContain("task_stop");
    expect(bulletNames(dispReq.instructions)).toContain("task_stop");

    c.close();
  });
});
