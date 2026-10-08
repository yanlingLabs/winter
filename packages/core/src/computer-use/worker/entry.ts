// ComputerV2 (2026-10-08) — `winter-core __automation-worker`: the per-session sandboxed process that runs the
// model's scripts. Sandboxed EXACTLY like `__workflow-worker`: the daemon wraps it in the same seatbelt profile
// (`workflows/sandbox.ts` — no writes, no network, exec of itself only, a short mach-lookup list) and it refuses
// to run, exit 77 before reading a byte of input, outside a sandbox that denies it the Keychain
// (`workflows/sandbox-guard.ts`). It holds no credentials and reaches nothing but its own stdio: every API
// function is a bridge request the daemon answers (`computer-use/service.ts`).
//
// DEV/TEST: the daemon spawns `bun <this file> __automation-worker`, and `import.meta.main` runs it. COMPILED:
// `packages/cli/src/main.ts` routes `argv[2] === "__automation-worker"` here through the core barrel.
import { refuseUnlessKeychainSandboxed } from "../../workflows/sandbox-guard";
import { BRIDGE_MAX_LINE, type HostToWorker, type WorkerToHost } from "./bridge";
import { createAutomationRuntime } from "./runtime";

/** The argv the daemon self-spawns the worker with (positional, `argv[2]`). */
export const AUTOMATION_WORKER_ARG = "__automation-worker";

export function runAutomationWorker(): void {
  // Before any input is read: outside a sandbox that denies the Keychain, never run a script.
  refuseUnlessKeychainSandboxed("automation worker");
  // The TypeScript stripper, captured BEFORE `Bun` is withheld below.
  const BunGlobal = (globalThis as { Bun?: { Transpiler?: new (o: { loader: string }) => { transformSync(code: string): string } } }).Bun;
  const transpiler = BunGlobal?.Transpiler === undefined ? undefined : new BunGlobal.Transpiler({ loader: "ts" });
  // Defense in depth under the seatbelt (the workflow worker's list). `process` stays — this entry needs stdio
  // — and the script's scope shadows it (`runtime.ts`'s SHADOWED).
  for (const g of ["Bun", "fetch", "XMLHttpRequest", "WebSocket"]) {
    try { (globalThis as Record<string, unknown>)[g] = undefined; } catch { /* non-configurable */ }
  }
  // Nothing of the environment reaches a script (the daemon spawns the worker with a minimal one already —
  // `computer-use/sandbox.ts`; this empties what is left, defense in depth: `process` is reachable from a script).
  for (const k of Object.keys(process.env)) { try { delete process.env[k]; } catch { /* read-only */ } }
  // A script's un-awaited rejection or a throw from its own timer must not take the runtime (and every
  // variable the session built) down with it.
  process.on("unhandledRejection", () => { /* the script's own business */ });
  process.on("uncaughtException", () => { /* the script's own business */ });

  const post = (m: WorkerToHost): void => { process.stdout.write(`${JSON.stringify(m)}\n`); };
  const runtime = createAutomationRuntime({
    post,
    ...(transpiler === undefined ? {} : { transpile: (code: string) => transpiler.transformSync(code) }),
  });

  let buf = "";
  process.stdin.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: HostToWorker;
      try { msg = JSON.parse(line) as HostToWorker; } catch { continue; }
      runtime.handle(msg);
    }
    if (buf.length > BRIDGE_MAX_LINE) buf = ""; // a runaway line from the host is dropped, never buffered forever
  });
  // The daemon closing our stdin is the end of the session's runtime.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  post({ op: "ready" });
}

if (import.meta.main) runAutomationWorker();
