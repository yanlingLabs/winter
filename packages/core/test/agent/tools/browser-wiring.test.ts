import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../../../src/daemon";
import { FileSecretStore } from "../../../src/auth/secret-store";
import { FakeProvider } from "../../../src/agent/fake-provider";
import type { ToolContext } from "../../../src/agent/tools/registry";

/**
 * b2-agent-browser T4 — the browser tool's four deps, against the REAL `startDaemon()` wiring.
 *
 * `browser.test.ts` fakes those deps, which is the right way to test the tool's own logic but proves
 * nothing about `daemon.ts`'s `registerBrowserTool({ tabs, openTab, dispatch, harnesses })` block. A
 * dep pointed at the wrong thing — the fold of another session, a hub accessor that never sees the
 * attachment — would leave every one of those rows green. So this file walks the same path
 * mode-toolset-census.test.ts uses (boot for real, temp home, injected FakeProvider, read
 * `daemon.registry`) and drives the tool end to end short of the app.
 *
 * Deliberately small: the three claims that are pure WIRING, and nothing the fake already covers.
 */

/** Minimal raw NDJSON client — hello + `session.create` and nothing else. `RunningDaemon` exposes no
 *  `store`, and opening a SECOND `SessionStore` on the same sqlite file would be a different handle
 *  with its own view; sessions are therefore created the way every other client creates them. Each
 *  daemon-IPC test file in this repo carries its own copy of a client like this (the convention
 *  settings-hot-e2e.test.ts's doc comment records; there is no shared harness module). */
class MiniClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string, token: string): Promise<MiniClient> {
    const c = new MiniClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName: "browser-wiring" });
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async newSession(cwd: string): Promise<string> {
    const { result } = await this.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    return result.sessionId as string;
  }

  close(): void { this.socket.end(); }
}

describe("browser tool: the real daemon.ts wiring", () => {
  let daemon: RunningDaemon | undefined;
  let home: string | undefined;
  let client: MiniClient | undefined;

  afterEach(() => {
    client?.close();
    client = undefined;
    daemon?.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function boot(): Promise<RunningDaemon> {
    home = mkdtempSync(join(tmpdir(), "norma-browser-wiring-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({
      home, secrets, agentProvider: { provider: new FakeProvider([]), model: "fake-1" },
    });
    client = await MiniClient.connect(daemon.socketPath, daemon.tokens.harness);
    return daemon;
  }

  function newSession(): Promise<string> { return client!.newSession(home!); }

  function ctx(sessionId: string): ToolContext {
    return { cwd: home!, roots: [home!], sessionId, mode: "code" } as ToolContext;
  }

  test("open mints through the real store, and tabs reads the real fold back", async () => {
    const d = await boot();
    const sessionId = await newSession();

    const empty = await d.registry!.execute("browser", { verb: "tabs" }, ctx(sessionId));
    expect(empty.isError).toBe(false);
    expect(empty.output).toContain("no tabs are open");

    const opened = await d.registry!.execute(
      "browser", { verb: "open", url: "https://example.com", title: "Ex" }, ctx(sessionId),
    );
    expect(opened.isError).toBe(false);

    // The SAME fold `panel.list` serves — and the tab is ACTIVE, which is `mintPanelTab`'s second
    // append reaching a real store through a real hub.
    const listed = await d.registry!.execute("browser", { verb: "tabs" }, ctx(sessionId));
    expect(listed.output).toContain("https://example.com");
    expect(listed.output).toContain("(active)");
    expect(listed.output).toContain("Ex");

    // Per-session: a second session's fold is untouched by the first's tab.
    const other = await newSession();
    const otherList = await d.registry!.execute("browser", { verb: "tabs" }, ctx(other));
    expect(otherList.output).toContain("no tabs are open");
  });

  test("with nothing attached, a command verb is refused by the REAL hub read — no deadline burned", async () => {
    const d = await boot();
    const sessionId = await newSession();
    await d.registry!.execute("browser", { verb: "open", url: "https://example.com" }, ctx(sessionId));

    // The whole chain: daemon.ts's `harnesses` dep -> SessionHub.attachedHarnesses -> canHostPanel
    // -> refusal. If it waited on the app instead, this would take the full 20s `read` deadline.
    const started = Date.now();
    const res = await d.registry!.execute("browser", { verb: "read" }, ctx(sessionId));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("browser unavailable");
  });

  test("a tabId from ANOTHER session is refused against the real folds", async () => {
    const d = await boot();
    const mine = await newSession();
    const theirs = await newSession();
    await d.registry!.execute("browser", { verb: "open", url: "https://theirs.example" }, ctx(theirs));
    const theirTabs = await d.registry!.execute("browser", { verb: "tabs" }, ctx(theirs));
    const theirTabId = theirTabs.output.split(" ")[0]!;
    expect(theirTabId).not.toBe("");

    await d.registry!.execute("browser", { verb: "open", url: "https://mine.example" }, ctx(mine));
    const res = await d.registry!.execute("browser", { verb: "read", tabId: theirTabId }, ctx(mine));
    expect(res.isError).toBe(true);
    expect(res.output).toContain("does not belong to this session");
  });
});
