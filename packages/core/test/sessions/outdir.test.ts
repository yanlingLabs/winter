import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { outdirPath, ensureOutdir } from "../../src/sessions/outdir";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBashTool } from "../../src/agent/tools/bash";
import { sandboxAvailable } from "../../src/agent/sandbox";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest, TurnInputItem } from "../../src/providers/types";

// working-directories T4: `$OUTDIR` — the delivery-folder primitive, `<normaHome>/outputs/<sessionId>`.
//
// outdirPath/ensureOutdir are pure path/mkdir helpers (unit-tested directly below). Everything else
// in this file proves the BLESSING end to end through a REAL engine turn — never registry.execute
// directly for a grant/deny decision (the "direct-registry blindness" class: engine.ts's dispatch
// loop, not registry.execute, is what decides whether a write cards/hard-denies/lands silent — this
// project has been bitten twice by a test that only proved the tool itself works, not the gate in
// front of it). The bash-tool-in-isolation tests below are the one deliberate exception: bash.ts's
// own ctx-consuming logic (the env splice, the seatbelt writable-set union) is self-contained and
// does not depend on the dispatch loop's decision at all — only on what ctx it was handed.

describe("outdirPath", () => {
  test("<home>/outputs/<sessionId>", () => {
    expect(outdirPath("/home/.norma", "s_abc123")).toBe(join("/home/.norma", "outputs", "s_abc123"));
  });

  test("rejects a sessionId outside the session-tmp.ts alphanumeric/-/_ shape (path-injection guard)", () => {
    expect(() => outdirPath("/home/.norma", "../../etc")).toThrow();
    expect(() => outdirPath("/home/.norma", "s/abc")).toThrow();
    expect(() => outdirPath("/home/.norma", "")).toThrow();
    expect(() => outdirPath("/home/.norma", "s abc")).toThrow();
    expect(() => outdirPath("/home/.norma", "/etc/passwd")).toThrow();
  });

  test("accepts a UUID (the synced-session id shape)", () => {
    expect(() => outdirPath("/home/.norma", "550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  test("accepts a daemon-minted id (s_<hex>)", () => {
    expect(() => outdirPath("/home/.norma", "s_deadbeef1234")).not.toThrow();
  });
});

describe("ensureOutdir", () => {
  test("mkdir -p's and returns the path", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-outdir-unit-"));
    const dir = ensureOutdir(home, "s_test1");
    expect(dir).toBe(outdirPath(home, "s_test1"));
    expect(existsSync(dir)).toBe(true);
  });

  test("idempotent — calling twice for the same session does not throw", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-outdir-unit-"));
    ensureOutdir(home, "s_test2");
    expect(() => ensureOutdir(home, "s_test2")).not.toThrow();
  });
});

const darwin = sandboxAvailable();

describe("bash tool: $OUTDIR (direct — bash.ts's own ctx-consuming logic, not the grant/deny flow)", () => {
  function reg(): ToolRegistry { const r = new ToolRegistry(); registerBashTool(r); return r; }

  (darwin ? test : test.skip)("OUTDIR is spliced beside TMPDIR, and the sandbox lets bash physically write there", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "norma-outdir-bash-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "norma-outdir-bash-home-"));
    const outDir = ensureOutdir(home, "s_bashtest");
    const res = await reg().execute(
      "bash",
      { command: 'echo "$OUTDIR" && echo delivered > "$OUTDIR/result.txt" && cat "$OUTDIR/result.txt"' },
      { cwd, roots: [cwd], sessionId: "s_bashtest", outDir },
    );
    expect(res.isError).toBe(false);
    expect(res.output).toContain(outDir);
    expect(res.output).toContain("delivered");
    expect(existsSync(join(outDir, "result.txt"))).toBe(true);
    expect(readFileSync(join(outDir, "result.txt"), "utf8")).toBe("delivered\n");
  });

  (darwin ? test : test.skip)("without ctx.outDir wired, $OUTDIR is simply unset — no crash, byte-identical to pre-feature", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "norma-outdir-bash-cwd2-"));
    const res = await reg().execute("bash", { command: 'echo "[$OUTDIR]"' }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[]");
  });
});

// -----------------------------------------------------------------------------------------------
// Real-engine-turn harness (memdir-write-root-e2e.test.ts's own convention: each *.test.ts carries
// its own copy rather than sharing one — see that file for the identical TestClient shape).
// -----------------------------------------------------------------------------------------------

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

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }

  completedTurns(): number {
    return this.notifications.filter((n) => n.method === METHODS.event && n.params.type === "turn_completed").length;
  }

  toolResult(callId: string): any {
    return this.notifications.find((n) => n.method === METHODS.event && n.params.type === "tool_result" && n.params.callId === callId)?.params;
  }

  hasEventType(type: string): boolean {
    return this.notifications.some((n) => n.method === METHODS.event && n.params.type === type);
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

function writeSettingsFile(home: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      titles: { enabled: false },
      toolSearch: { enabled: false },
      reviewer: { enabled: false },
      ...overrides,
    }, null, 2) + "\n",
  );
}

/** A provider driven by the USER's own message rather than a fixed script — `driveTurn` sends
 *  `JSON.stringify({callId, name, argsJson})`, replayed here as a single tool_call. Needed because
 *  every one of this file's targets is `outdirPath(home, sessionId)`, and `sessionId` is minted
 *  SERVER-SIDE by `session.create` — unknowable at FakeProvider-construction time (which must
 *  happen before `startDaemon`, which must happen before any session exists). Once that call's
 *  tool_result appears in a later round's input, this degrades to a plain text reply instead of
 *  replaying the same call forever. */
class ScriptedToolProvider implements Provider {
  readonly id = "fake";
  models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    const lastUser = [...req.input].reverse().find(
      (i): i is Extract<TurnInputItem, { type: "message" }> => i.type === "message" && i.role === "user",
    );
    if (lastUser) {
      try {
        const parsed = JSON.parse(lastUser.content) as { callId: string; name: string; argsJson: string };
        const alreadyDone = req.input.some((i) => i.type === "tool_result" && i.callId === parsed.callId);
        if (!alreadyDone) {
          yield { type: "tool_call", callId: parsed.callId, name: parsed.name, argsJson: parsed.argsJson };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
      } catch { /* not a scripted call — fall through to a plain text reply */ }
    }
    yield { type: "text_delta", delta: "done" };
    yield { type: "done", stopReason: "end_turn" };
  }
}

function scriptWrite(callId: string, path: string, content: string): string {
  return JSON.stringify({ callId, name: "write", argsJson: JSON.stringify({ path, content }) });
}

function scriptBash(callId: string, command: string): string {
  return JSON.stringify({ callId, name: "bash", argsJson: JSON.stringify({ command }) });
}

describe("outdir blessing — real engine turn (working-directories T4)", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(() => daemon?.stop());

  test("a write into the session's OWN outputs dir is silent-legal: no card, no reviewer flag, lands on disk (pre-fix: the SAME target hard-errors — see task-4-report.md for the pinned pre-fix shape)", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-"));
    writeSettingsFile(home);
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const cwd = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-cwd-"));
    const provider = new ScriptedToolProvider();

    daemon = await startDaemon({ home, secrets, agentProvider: { provider, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "outdir-e2e");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    const sessionId = created.sessionId as string;
    await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    const target = join(outdirPath(home, sessionId), "deliverable.txt");
    await driveTurn(c, sessionId, scriptWrite("w1", target, "final output"));

    const result = c.toolResult("w1");
    expect(result?.isError).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("final output");
    // silent-legal, both ways: no approval card, and no fs-reviewer flag for the `.norma`
    // dot-directory segment (Norma-owned space, unlike a user dotfile) — under `ask` policy the fs
    // reviewer branch never even runs (auto-policy-only), so this also structurally proves it.
    expect(c.hasEventType("approval_requested")).toBe(false);
    expect(c.hasEventType("tool_review")).toBe(false);
    c.close();
  });

  test("~/.norma OUTSIDE the blessed outputs subdir still refuses — the blessing is narrow, not a `.norma` blanket", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-narrow-"));
    writeSettingsFile(home);
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const cwd = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-narrow-cwd-"));
    const provider = new ScriptedToolProvider();

    daemon = await startDaemon({ home, secrets, agentProvider: { provider, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "outdir-e2e-narrow");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    const sessionId = created.sessionId as string;
    await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    const target = join(home, "not-blessed.txt"); // directly under normaHome, never under outputs/<sid>
    await driveTurn(c, sessionId, scriptWrite("w1", target, "should not land"));

    const result = c.toolResult("w1");
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain("control plane");
    expect(existsSync(target)).toBe(false);
    c.close();
  });

  test("ANOTHER session's outputs dir is NOT writable — the blessing is keyed by THIS session's own id, not the bare outputs/ prefix", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-cross-"));
    writeSettingsFile(home);
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const cwdA = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-cross-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-cross-b-"));
    const provider = new ScriptedToolProvider();

    daemon = await startDaemon({ home, secrets, agentProvider: { provider, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "outdir-e2e-cross");
    const { result: createdA } = await c.request(METHODS.sessionCreate, { scope: "global", cwd: cwdA, approvalPolicy: "ask" });
    const { result: createdB } = await c.request(METHODS.sessionCreate, { scope: "global", cwd: cwdB, approvalPolicy: "ask" });
    const sessionA = createdA.sessionId as string;
    const sessionB = createdB.sessionId as string;
    await c.request(METHODS.sessionAttach, { sessionId: sessionA, fromSeq: 0 });

    // Session A tries to write into session B's outputs dir.
    const target = join(outdirPath(home, sessionB), "leak.txt");
    await driveTurn(c, sessionA, scriptWrite("w1", target, "should not land"));

    const result = c.toolResult("w1");
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain("control plane");
    expect(existsSync(target)).toBe(false);

    // Sanity, other direction: session A CAN still write its OWN outputs dir in the same run —
    // proves the denial above is per-session scoping, not a wholesale outputs/ lockout.
    const ownTarget = join(outdirPath(home, sessionA), "mine.txt");
    await driveTurn(c, sessionA, scriptWrite("w2", ownTarget, "mine"));
    const own = c.toolResult("w2");
    expect(own?.isError).toBe(false);
    expect(existsSync(ownTarget)).toBe(true);

    c.close();
  });

  (darwin ? test : test.skip)("a real bash tool call: $OUTDIR is set and physically writable under the session's seatbelt", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-bash-"));
    writeSettingsFile(home);
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const cwd = mkdtempSync(join(tmpdir(), "norma-outdir-e2e-bash-cwd-"));
    const provider = new ScriptedToolProvider();

    daemon = await startDaemon({ home, secrets, agentProvider: { provider, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "outdir-e2e-bash");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    const sessionId = created.sessionId as string;
    await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    await driveTurn(c, sessionId, scriptBash("b1", 'echo delivered > "$OUTDIR/via-bash.txt"'));

    const result = c.toolResult("b1");
    expect(result?.isError).toBe(false);
    expect(result?.output).toContain("[exit 0]");
    const expectedFile = join(outdirPath(home, sessionId), "via-bash.txt");
    expect(existsSync(expectedFile)).toBe(true);
    expect(readFileSync(expectedFile, "utf8")).toBe("delivered\n");
    c.close();
  });
});
