import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

function setup(script: ProviderEvent[][], policy: "ask" | "auto" = "auto", extraRoots: string[] = [], opts: { grantDeniedPrefixes?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "norma-engine-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd, ...extraRoots]);
  // Default assembler — these tests don't exercise context assembly (see engine-context.test.ts).
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }) });
  // Default compactor — these tests don't exercise compaction (see engine-compaction.test.ts).
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    grantDeniedPrefixes: opts.grantDeniedPrefixes,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: policy });
  return { engine, store, hub, broker, sessionId, cwd, provider, dirs };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

function types(events: SessionEvent[]): string[] { return events.map((e) => e.type); }

describe("AgentEngine", () => {
  test("simple text turn: turn_started, assistant_message, turn_completed", async () => {
    const { engine, store, sessionId } = setup([text("hello there")]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(types(events)).toEqual(["session_created", "turn_started", "assistant_message", "turn_completed"]);
    expect(events.find((e) => e.type === "assistant_message")).toMatchObject({ text: "hello there", threadId: "main" });
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "end_turn", inputTokens: 10, outputTokens: 2 });
  });

  test("tool round-trip: model calls write, engine executes (auto policy) and loops to completion", async () => {
    const { engine, store, sessionId, cwd, provider } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: '{"path":"hello.txt","content":"norma was here"}' }, done("tool_calls")],
      text("wrote it!"),
    ]);
    await engine.runTurn(sessionId);
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("norma was here");
    const events = store.read(sessionId);
    expect(types(events)).toEqual([
      "session_created", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed",
    ]);
    // second provider call got the call + result in its input:
    const second = provider.requests[1]!;
    expect(second.input.some((i) => i.type === "function_call" && i.callId === "c1")).toBe(true);
    expect(second.input.some((i) => i.type === "tool_result" && i.callId === "c1")).toBe(true);
  });

  test("ask policy: approval_requested is appended; denial produces an error tool_result", async () => {
    // SP-policies Task 7: an in-root write under `ask` is now SILENT (in-project-silent flip), so
    // this uses an OUT-OF-ROOT write as the still-carding vehicle (it rides the grant-flavored
    // approval card). What this test checks is the ask-policy approval FLOW — card appended →
    // denial → error tool_result — which is identical whichever card shape triggers it.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-oor-")));
    const { engine, store, hub, broker, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: join(outside, "x.txt"), content: "y" }) }, done("tool_calls")],
      text("ok, not writing"),
    ], "ask");
    // watcher answers the approval as soon as it sees it:
    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(types(events)).toEqual(expect.arrayContaining(["approval_requested", "approval_resolved", "tool_result"]));
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "auto-denier" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    expect((events.find((e) => e.type === "tool_result") as any).output).toMatch(/denied/);
  });

  test("approval timeout auto-denies", async () => {
    // SP-policies Task 7: in-root writes/edits are silent now, so use an OUT-OF-ROOT write to raise
    // a real card (grant seam) and leave it unanswered to exercise the timeout auto-deny path.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-oor-")));
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: join(outside, "a.txt"), content: "y" }) }, done("tool_calls")],
      text("gave up"),
    ], "ask");
    await engine.runTurn(sessionId);
    expect(store.read(sessionId).find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "timeout" });
  });

  test("provider error yields agent_error + turn_completed(error)", async () => {
    const { engine, store, sessionId } = setup([[{ type: "error", code: "auth", message: "not signed in — run: norma login" }]]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(types(events)).toEqual(["session_created", "turn_started", "agent_error", "turn_completed"]);
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "error" });
  });

  test("history: prior user/assistant messages are included as input", async () => {
    const { engine, store, hub, sessionId, provider } = setup([text("first"), text("second")]);
    const client: HubClient = { clientName: "u", deliver() { return true; } };
    hub.attach(client, sessionId, 0);
    hub.send(client, sessionId, "question one");
    await engine.runTurn(sessionId);
    hub.send(client, sessionId, "question two");
    await engine.runTurn(sessionId);
    const req = provider.requests[1]!;
    const messages = req.input.filter((i) => i.type === "message");
    expect(messages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "question one"],
      ["assistant", "first"],
      ["user", "question two"],
    ]);
  });

  test("concurrent runTurn on the same session is refused (one turn at a time)", async () => {
    const { engine, sessionId } = setup([text("slow")]);
    const first = engine.runTurn(sessionId);
    await expect(engine.runTurn(sessionId)).rejects.toThrow(/turn already running/);
    await first;
  });

  test("tool-iteration cap ends the turn with agent_error", async () => {
    const looping: ProviderEvent[] = [
      { type: "tool_call", callId: "loop", name: "glob", argsJson: '{"pattern":"*"}' },
      { type: "done", stopReason: "tool_calls" },
    ];
    const { engine, store, sessionId } = setup([looping]); // script repeats: same entry every iteration
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "agent_error" && (e as any).message.includes("iteration cap"))).toBe(true);
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "error" });
  });

  test("engine threads allowed roots into tools; write in an additional root succeeds", async () => {
    const extraRoot = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-extra-")));
    const target = join(extraRoot, "in-extra.txt");
    const { engine, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "norma was here" }) }, done("tool_calls")],
      text("wrote it!"),
    ], "auto", [extraRoot]);
    await engine.runTurn(sessionId);
    expect(readFileSync(target, "utf8")).toBe("norma was here");
  });

  test("a turn on a cwd-less session fails closed (no fallback to daemon cwd)", async () => {
    const { engine, store } = setup([text("should not run")]);
    const sessionId = store.createSession("global"); // no cwd, default policy
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "agent_error" && (e as any).message.includes("working directory"))).toBe(true);
    expect(events.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "error" });
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });

  // write-permission-flow (task 24, CC parity): request_directory is DELETED — an out-of-root
  // write/edit now carries its own grant flow through the engine's dispatch loop (engine.ts's
  // `dirGrant` branch), riding the SAME ApprovalBroker/requestApproval seam bash/worktree already
  // use. cc-expert findings (real CC): an out-of-scope edit gets exactly ONE prompt, the ordinary
  // tool-permission one — not a first generic card plus a second "grant this directory" card — so
  // these tests assert exactly one approval_requested for the whole call, shaped like a write/edit
  // card (toolName "write"/"edit"), not a bespoke "request_directory" name.
  describe("out-of-root write/edit grant flow", () => {
    test("ask policy: approve grants the directory and the write lands; a follow-up write to the SAME directory rides the existing grant SILENTLY (no SECOND directory_added, no second card at all — SP-policies Task 7)", async () => {
      const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-outside-")));
      const target1 = join(outsideDir, "file1.txt");
      const target2 = join(outsideDir, "file2.txt");
      const { engine, store, hub, broker, sessionId, dirs } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target1, content: "one" }) }, done("tool_calls")],
        [{ type: "tool_call", callId: "c2", name: "write", argsJson: JSON.stringify({ path: target2, content: "two" }) }, done("tool_calls")],
        text("wrote both"),
      ], "ask");
      const watcher: HubClient = {
        clientName: "auto-approver",
        deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
      };
      hub.attach(watcher, sessionId, 0);
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      const approvalRequests = events.filter((e) => e.type === "approval_requested") as any[];
      // SP-policies Task 7: an in-root write under `ask` is now SILENT (the in-project-silent flip).
      // c1 is genuinely out-of-root, so it still raises exactly ONE grant-flavored card; approving
      // it adds `outsideDir` to the session roots. c2 targets the SAME (now-granted, i.e. in-root)
      // directory, so it rides the grant with NO card at all — not a second grant request, and not
      // an "ordinary" write card either (that ordinary card is retired). So there is exactly ONE
      // card total, and it is the grant card.
      expect(approvalRequests.length).toBe(1);
      expect(approvalRequests[0]).toMatchObject({ toolName: "write" });
      expect(approvalRequests[0].summary).toContain(outsideDir);
      expect(approvalRequests[0].summary).toContain("outside the allowed directories");
      expect(dirs.has(sessionId, outsideDir)).toBe(true);
      const grants = events.filter((e) => e.type === "directory_added");
      expect(grants.length).toBe(1); // granted exactly ONCE, not once per write
      expect(grants[0]).toMatchObject({ path: outsideDir, persisted: false });
      expect(readFileSync(target1, "utf8")).toBe("one"); // c1: approved grant → write lands
      expect(readFileSync(target2, "utf8")).toBe("two"); // c2: silent (rides the grant) → write lands
      const results = events.filter((e) => e.type === "tool_result");
      expect(results.every((r: any) => r.isError === false)).toBe(true);
    });

    test("ask policy: denial produces a clean error tool_result (not a crash) — nothing is written, nothing is granted", async () => {
      const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-outside-deny-")));
      const target = join(outsideDir, "nope.txt");
      const { engine, store, hub, broker, sessionId, dirs } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "x" }) }, done("tool_calls")],
        text("ok, not writing"),
      ], "ask");
      const watcher: HubClient = {
        clientName: "auto-denier",
        deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
      };
      hub.attach(watcher, sessionId, 0);
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "auto-denier" });
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
      expect(existsSync(target)).toBe(false);
      expect(dirs.has(sessionId, outsideDir)).toBe(false);
      expect(events.some((e) => e.type === "directory_added")).toBe(false);
    });

    test("auto policy: no approval prompt at all (mirrors bash's own auto semantics) — silently granted ONCE, directory_added emitted for observability but not re-emitted for a same-directory follow-up, write lands", async () => {
      const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-outside-auto-")));
      const target1 = join(outsideDir, "auto1.txt");
      const target2 = join(outsideDir, "auto2.txt");
      const { engine, store, sessionId, dirs } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target1, content: "auto-granted" }) }, done("tool_calls")],
        [{ type: "tool_call", callId: "c2", name: "write", argsJson: JSON.stringify({ path: target2, content: "auto-granted-2" }) }, done("tool_calls")],
        text("wrote both"),
      ], "auto");
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      expect(events.some((e) => e.type === "approval_requested")).toBe(false); // never, under auto — matches bash
      const grants = events.filter((e) => e.type === "directory_added");
      expect(grants.length).toBe(1); // granted once for c1; c2 rides the SAME grant, no re-grant
      expect(grants[0]).toMatchObject({ path: outsideDir, persisted: false });
      expect(dirs.has(sessionId, outsideDir)).toBe(true);
      expect(readFileSync(target1, "utf8")).toBe("auto-granted");
      expect(readFileSync(target2, "utf8")).toBe("auto-granted-2");
    });

    test("in-root writes never trigger the grant flow (no directory_added) — and are now fully SILENT under ask (SP-policies Task 7: no card at all)", async () => {
      const { engine, store, sessionId, cwd } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: "in-root.txt", content: "y" }) }, done("tool_calls")],
        text("wrote it"),
      ], "ask");
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      // SP-policies Task 7: an in-root write under `ask` is silenced by the in-project-silent flip —
      // no approval card of ANY kind (the old "ordinary generic write card" is retired), and it
      // still never touches the out-of-root grant flow, so no directory_added either. The write just
      // lands silently.
      expect(events.some((e) => e.type === "approval_requested")).toBe(false);
      expect(events.some((e) => e.type === "directory_added")).toBe(false);
      expect(readFileSync(join(cwd, "in-root.txt"), "utf8")).toBe("y");
    });

    test("grants are session-scoped: a brand-new session sharing the SAME SessionDirectories store does not inherit a prior session's grant", async () => {
      const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-outside-iso-")));
      const target1 = join(outsideDir, "s1.txt");
      const target2 = join(outsideDir, "s2.txt");
      const { engine, store, hub, broker, sessionId, dirs, cwd } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target1, content: "one" }) }, done("tool_calls")],
        text("wrote it"),
        [{ type: "tool_call", callId: "c2", name: "write", argsJson: JSON.stringify({ path: target2, content: "two" }) }, done("tool_calls")],
        text("wrote it too"),
      ], "ask");
      const watcher: HubClient = {
        clientName: "auto-approver",
        deliver(e) { if (e.type === "approval_requested") broker.resolve((e as any).sessionId, e.callId, true, "auto-approver"); return true; },
      };
      hub.attach(watcher, sessionId, 0);
      await engine.runTurn(sessionId);
      expect(dirs.has(sessionId, outsideDir)).toBe(true);

      // A NEW session, same store/dirs/engine instance — must NOT inherit session 1's grant.
      const sessionId2 = store.createSession("global", { cwd, approvalPolicy: "ask" });
      hub.attach(watcher, sessionId2, 0);
      expect(dirs.has(sessionId2, outsideDir)).toBe(false); // not inherited
      await engine.runTurn(sessionId2);
      const events2 = store.read(sessionId2);
      expect(events2.some((e) => e.type === "approval_requested")).toBe(true); // re-prompted — no free ride off session 1
      expect(dirs.has(sessionId2, outsideDir)).toBe(true); // approved again, granted for THIS session too
      expect(readFileSync(target2, "utf8")).toBe("two");
    });

    // task-24 review F2: the control plane (daemon.ts passes ~/.norma/run — the run dir holding
    // the IPC socket/lock/plugin PID files, the SAME denylist the read tools get) must NEVER be
    // grantable: hard tool error, no card, no directory_added — under BOTH policies. bash's
    // seatbelt shares the session roots, so a grant would open the dir to bash too.
    for (const policy of ["ask", "auto"] as const) {
      test(`denied-prefix (control-plane) target under ${policy}: hard error, no approval card, no grant`, async () => {
        const runDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-rundir-")));
        const target = join(runDir, "core.sock.d", "evil.txt");
        const { engine, store, sessionId, dirs } = setup([
          [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "x" }) }, done("tool_calls")],
          text("blocked"),
        ], policy, [], { grantDeniedPrefixes: [runDir] });
        await engine.runTurn(sessionId);
        const events = store.read(sessionId);
        expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card, even under ask
        expect(events.some((e) => e.type === "directory_added")).toBe(false);
        const result = events.find((e) => e.type === "tool_result") as any;
        expect(result.isError).toBe(true);
        expect(result.output).toMatch(/control plane/);
        expect(result.output).toMatch(/never be granted/);
        expect(existsSync(target)).toBe(false);
        expect(dirs.has(sessionId, runDir)).toBe(false);
      });
    }

    test("denied-prefix hardening also blocks granting an ANCESTOR of the control plane (subtree containment would open it through the fence)", async () => {
      const outer = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-outer-")));
      const runDir = join(outer, "run"); // the denied prefix lives INSIDE the would-be grant dir
      const target = join(outer, "adjacent.txt"); // grant dir would be `outer` itself
      const { engine, store, sessionId, dirs } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "x" }) }, done("tool_calls")],
        text("blocked"),
      ], "auto", [], { grantDeniedPrefixes: [runDir] });
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      expect(events.some((e) => e.type === "directory_added")).toBe(false);
      expect((events.find((e) => e.type === "tool_result") as any).isError).toBe(true);
      expect(existsSync(target)).toBe(false);
      expect(dirs.has(sessionId, outer)).toBe(false);
    });

    // task-24 review F3: a grant whose directory does NOT yet exist (deep new subtree). The fence
    // realpaths roots (SessionDirectories.canon + resolveWithinAny both tolerate-and-SKIP a root
    // that doesn't resolve), so a granted-but-nonexistent dir silently dropped out and the
    // just-approved write still failed. The grant now mkdirs the approved directory first.
    test("deep not-yet-existing target dirs under auto: grant mkdirs the directory, directory_added emitted, the write lands (task-24 review F3)", async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-deep-auto-")));
      const target = join(outside, "newsub", "deeper", "file.txt"); // nothing below `outside` exists
      const grantDir = join(outside, "newsub", "deeper");
      const { engine, store, sessionId, dirs } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "deep" }) }, done("tool_calls")],
        text("wrote it"),
      ], "auto");
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      expect(events.some((e) => e.type === "directory_added" && (e as any).path === grantDir)).toBe(true);
      expect((events.find((e) => e.type === "tool_result") as any).isError).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("deep"); // the approved write actually LANDED
      expect(dirs.has(sessionId, grantDir)).toBe(true);
    });

    test("deep not-yet-existing target dirs under ask+approve: same — grant mkdirs, write lands (task-24 review F3)", async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-deep-ask-")));
      const target = join(outside, "newsub", "deeper", "file.txt");
      const grantDir = join(outside, "newsub", "deeper");
      const { engine, store, hub, broker, sessionId, dirs } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "deep-ask" }) }, done("tool_calls")],
        text("wrote it"),
      ], "ask");
      const watcher: HubClient = {
        clientName: "auto-approver",
        deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
      };
      hub.attach(watcher, sessionId, 0);
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      expect(events.some((e) => e.type === "directory_added" && (e as any).path === grantDir)).toBe(true);
      expect((events.find((e) => e.type === "tool_result") as any).isError).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("deep-ask");
      expect(dirs.has(sessionId, grantDir)).toBe(true);
    });

    // task-24 review F4 (engine half — the fence half is pinned in paths.test.ts): an in-root
    // DANGLING symlink aimed at a nonexistent file in an existing OUTSIDE dir used to write
    // through silently (reviewer-less, card-less escape). The fence now resolves the leaf's link
    // chain, so the call classifies as out-of-root and takes the GRANT flow for the REAL target
    // directory — never a silent escape.
    test("in-root dangling symlink → outside dir: no longer a silent escape — grant-flows for the REAL (outside) directory under auto", async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-symlink-out-")));
      const { engine, store, sessionId, cwd, dirs } = setup([
        [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: "innocent.txt", content: "PWNED" }) }, done("tool_calls")],
        text("done"),
      ], "auto");
      const { symlinkSync } = await import("node:fs");
      symlinkSync(join(outside, "pwned.txt"), join(cwd, "innocent.txt")); // dangling — target doesn't exist
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);
      // The grant names the REAL destination directory (the outside dir), not the in-root spelling:
      expect(events.some((e) => e.type === "directory_added" && (e as any).path === outside)).toBe(true);
      expect(dirs.has(sessionId, outside)).toBe(true);
      // The write went through the link INTO the granted dir — visible, granted, never silent:
      expect(readFileSync(join(outside, "pwned.txt"), "utf8")).toBe("PWNED");
    });
  });
});
