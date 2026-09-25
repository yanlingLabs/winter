// WS-23 (ruling R1): the daemon's embedded-session host — chat and dispatch run the Winter runtime in
// a Bun Worker per session. These drive REAL Workers (the SDK's own Worker entry, through this
// package's `embedded-worker-entry.ts`) on `winter-test/*` doubles and temp homes; no binary, no
// network, no Keychain.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, SDK_VERSION, type SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { RUNTIME_VERSION } from "@yanlinglabs/winter-agent-runtime/version";
import {
  COMPILED_EMBEDDED_WORKER_ENTRY,
  createEmbeddedSessionHost,
  EMBEDDED_SHUTDOWN_BUDGET_MS,
  EmbeddedRuntimeUnavailable,
  embeddedVersionCheck,
  embeddedWorkerEntry,
  LINKED_EMBEDDED_VERSIONS,
  RUNTIME_WORKFLOW_WORKER_ARG,
  runsEmbedded,
  runtimeWorkflowWorkerCommand,
} from "../../src/runtime-sdk/embedded";
import { SHUTDOWN_QUERY_GRACE_MS } from "../../src/runtime-sdk/create";
import { RUNTIME_SHUTDOWN_DRAIN_MS } from "../../src/runtime-state";
import { REQUIRED_WINTER_AGENT_SDK } from "../../src/runtime-sdk/versions";

const TEMP: string[] = [];
afterAll(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
function temp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `winter-embedded-${label}-`));
  TEMP.push(d);
  return d;
}
function sessionEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: temp("home"), WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_KEYCHAIN_SERVICE: process.env.WINTER_KEYCHAIN_SERVICE ?? "com.winter.core.test-isolated" };
}
async function drain(gen: AsyncIterable<SdkMessage>): Promise<SdkMessage[]> {
  const out: SdkMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}
const resultOf = (ms: SdkMessage[]) => ms.find((m) => (m as { type?: string }).type === "result") as { subtype?: string; result?: string } | undefined;

describe("the topology", () => {
  test("chat and dispatch run embedded; code does not (dispatch's children are code sessions, so they stay subprocesses)", () => {
    expect(runsEmbedded("chat")).toBe(true);
    expect(runsEmbedded("dispatch")).toBe(true);
    expect(runsEmbedded("code")).toBe(false);
  });

  test("the Worker entry: the compiled binary's plain relative path, or this package's own file in dev", () => {
    expect(embeddedWorkerEntry(true)).toBe(COMPILED_EMBEDDED_WORKER_ENTRY);
    expect(COMPILED_EMBEDDED_WORKER_ENTRY).toBe("./embedded-worker.ts");
    const dev = embeddedWorkerEntry(false);
    expect(dev.startsWith("/")).toBe(true);
    expect(existsSync(dev)).toBe(true);
  });

  test("the workflow worker command never names `__workflow-worker` (winter-core routes that token to its OWN worker)", () => {
    const compiled = runtimeWorkflowWorkerCommand(true, "/Applications/Winter.app/Contents/Resources/winter-core");
    expect(compiled).toEqual({ file: "/Applications/Winter.app/Contents/Resources/winter-core", args: [RUNTIME_WORKFLOW_WORKER_ARG, "--bridge"] });
    const dev = runtimeWorkflowWorkerCommand(false, process.execPath);
    expect(dev.file).toBe(process.execPath);
    expect(existsSync(dev.args[0]!)).toBe(true);
    expect(dev.args.slice(1)).toEqual([RUNTIME_WORKFLOW_WORKER_ARG, "--bridge"]);
    for (const c of [compiled, dev]) expect(c.args).not.toContain("__workflow-worker");
  });

  test("the dev workflow command really reaches the RUNTIME's worker: undriven (no --bridge), it answers its own not-driven code", () => {
    const dev = runtimeWorkflowWorkerCommand(false, process.execPath);
    const run = Bun.spawnSync([dev.file, ...dev.args.filter((a) => a !== "--bridge")], { stdout: "pipe", stderr: "pipe" });
    // 78 = WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE: "the dispatch works, nothing is driving the bridge".
    expect(run.exitCode).toBe(78);
    expect(run.stderr.toString()).toContain("was invoked without --bridge");
  });
});

describe("the version lock", () => {
  test("THIS build's linked runtime, wrapper and pin agree (the values the boot assert and every spawn check)", () => {
    expect(LINKED_EMBEDDED_VERSIONS).toEqual({ runtime: RUNTIME_VERSION, sdk: SDK_VERSION, required: REQUIRED_WINTER_AGENT_SDK });
    expect(embeddedVersionCheck()).toBeUndefined();
  });

  test("any disagreement refuses typed, naming all three versions — whichever one drifted", () => {
    for (const versions of [
      { runtime: "0.0.25", sdk: "0.0.24", required: "0.0.24" },
      { runtime: "0.0.24", sdk: "0.0.25", required: "0.0.24" },
      { runtime: "0.0.24", sdk: "0.0.24", required: "0.0.25" },
    ]) {
      const refusal = embeddedVersionCheck(versions);
      expect(refusal).toBeInstanceOf(EmbeddedRuntimeUnavailable);
      expect(refusal!.code).toBe("embedded_runtime_unavailable");
      for (const v of Object.values(versions)) expect(refusal!.message).toContain(v);
    }
  });
});

describe("the shutdown budget", () => {
  test("query grace + the embedded drain + the runtime-state drain still fit the app's 5.0 s graceful exit", () => {
    // `daemon.ts`'s `stop()` runs the three in sequence; past 5.0 s the app SIGKILLs the daemon and the
    // lock/socket are left behind (P8b-32). Editing any of the three trips this.
    expect(SHUTDOWN_QUERY_GRACE_MS + EMBEDDED_SHUTDOWN_BUDGET_MS + RUNTIME_SHUTDOWN_DRAIN_MS).toBeLessThan(5000);
  });
});

describe("createEmbeddedSessionHost — workerProcess() over a real Worker", () => {
  test("a session runs in its own Worker: pid null, listed live while it runs, gone once it ends", async () => {
    const host = createEmbeddedSessionHost();
    let pid: number | null | undefined;
    const sessionId = crypto.randomUUID();
    let liveDuring: string[] = [];
    const messages = await drain(
      query({
        prompt: "go",
        options: {
          model: "winter-test/tooluse",
          sessionId,
          cwd: temp("cwd"),
          env: sessionEnv(),
          spawnClaudeCodeProcess: (o) => {
            const p = host.spawn(o);
            pid = p.pid;
            liveDuring = host.live();
            return p;
          },
        },
      }),
    );
    expect(resultOf(messages)).toMatchObject({ subtype: "success", result: "tool round done" });
    expect(pid).toBeNull();
    expect(liveDuring).toEqual([sessionId]);
    const t0 = Date.now();
    while (host.live().length > 0 && Date.now() - t0 < 5000) await Bun.sleep(20);
    expect(host.live()).toEqual([]);
  }, 30_000);

  test("shutdown() ends a HANGING session inside its budget, and no session can start afterwards", async () => {
    const logged: string[] = [];
    const host = createEmbeddedSessionHost({ log: (l) => logged.push(l) });
    const sessionId = crypto.randomUUID();
    const q = query({ prompt: "hang please", options: { model: "winter-test/hang", sessionId, cwd: temp("cwd"), env: sessionEnv(), spawnClaudeCodeProcess: (o) => host.spawn(o) } });
    const draining = drain(q).catch((e: unknown) => e);
    const t1 = Date.now();
    while (host.live().length === 0 && Date.now() - t1 < 5000) await Bun.sleep(20);
    expect(host.live()).toEqual([sessionId]);
    await Bun.sleep(300); // the turn is in flight
    const t0 = Date.now();
    await host.shutdown();
    expect(Date.now() - t0).toBeLessThan(EMBEDDED_SHUTDOWN_BUDGET_MS + 500);
    expect(host.live()).toEqual([]);
    // The query sees its runtime end without a terminal result (a spawned child killed mid-turn looks the same).
    await draining;
    expect(() => host.spawn({ command: "winter-embedded", args: ["--run", "--config-json", "{}"], cwd: "/", env: {} })).toThrow(EmbeddedRuntimeUnavailable);
  }, 30_000);

  test("two concurrent sessions each get their own Worker, and both complete", async () => {
    const host = createEmbeddedSessionHost();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const seenLive: string[][] = [];
    const run = (id: string): Promise<SdkMessage[]> =>
      drain(query({ prompt: "go", options: { model: "winter-test/tooluse", sessionId: id, cwd: temp("cwd"), env: sessionEnv(), spawnClaudeCodeProcess: (o) => { const p = host.spawn(o); seenLive.push(host.live()); return p; } } }));
    const [a, b] = await Promise.all(ids.map(run));
    expect(resultOf(a!)?.result).toBe("tool round done");
    expect(resultOf(b!)?.result).toBe("tool round done");
    // The second spawn saw BOTH Workers live at once.
    expect(seenLive.at(-1)!.sort()).toEqual([...ids].sort());
  }, 30_000);
});
