/**
 * ComputerV2 (2026-10-08) — the compiled-binary proof for the AUTOMATION worker (`winter-core
 * __automation-worker`), the per-session sandboxed process that runs a model's ComputerV2 scripts.
 *
 * `bun test` drives the worker through its DEV path (`bun computer-use/worker/entry.ts`), which says nothing
 * about the shipped artifact: the entry must also survive `bun build --compile`, route through `main.ts`'s
 * positional `__automation-worker` branch, boot under the workflow seatbelt and keep Bun's transpiler (it
 * strips TypeScript) after the worker withholds `Bun` from scripts. This script checks exactly that, on a
 * freshly compiled `dist/winter-core`:
 *
 *   1. `bun run --filter '@yanlinglabs/winter-cli' compile:core` → dist/winter-core (gitignored).
 *   2. A ROUND TRIP under `buildWorkflowSeatbeltProfile(dist/winter-core)` — the profile the daemon uses —
 *      speaking the bridge by hand: `ready`, a run whose `apps.list()` call is answered here, a TypeScript
 *      annotation, a top-level declaration read back by a SECOND run (persistence), a typed error class caught
 *      by `instanceof`, and a clean exit when stdin closes.
 *   3. The REFUSAL legs: run bare, and under the profile plus an allowance for either Keychain mach service,
 *      the worker must exit 77 with nothing on stdout and its input unread (`workflows/sandbox-guard.ts`).
 *
 * Standalone, never part of `bun test` (a real compile). Run: `bun run verify:automation-worker`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowSeatbeltProfile, sandboxAvailable } from "../packages/core/src/workflows/sandbox";
import type { HostToWorker, WorkerToHost } from "../packages/core/src/computer-use/worker/bridge";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_BINARY = join(REPO_ROOT, "dist", "winter-core");
const ARG = "__automation-worker";
const TIMEOUT_MS = 30_000;

const log = (line: string): void => { console.log(line); };
function fail(message: string): never {
  console.error(`\nRESULT: FAIL — ${message}`);
  process.exit(1);
}

async function roundTrip(profile: string): Promise<Array<[string, boolean]>> {
  const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, DIST_BINARY, ARG], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  const messages: WorkerToHost[] = [];
  let stderr = "";
  let buf = "";
  const waiters: Array<() => void> = [];
  const send = (m: HostToWorker): void => { child.stdin!.write(`${JSON.stringify(m)}\n`); log(`  -> ${JSON.stringify(m)}`); };
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      log(`  <- ${line}`);
      const msg = JSON.parse(line) as WorkerToHost;
      messages.push(msg);
      if (msg.op === "call") {
        if (msg.primitive === "apps.list") send({ op: "reply", id: msg.id, ok: true, value: [{ name: "Notes", bundleId: "com.apple.Notes", running: true }] });
        else send({ op: "reply", id: msg.id, ok: false, error: { kind: "StaleRef", message: "[12] is gone — call state()" } });
      }
      for (const w of waiters.splice(0)) w();
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (!pred()) {
      if (Date.now() > deadline) {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
        if (stderr.trim()) log(`[stderr]\n${stderr.trim()}`);
        fail(`timed out waiting for ${what}`);
      }
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 200); });
    }
  };
  const doneOf = (runId: string) => messages.find((m) => m.op === "done" && m.runId === runId) as Extract<WorkerToHost, { op: "done" }> | undefined;
  const printsOf = (runId: string) => messages.filter((m) => m.op === "print" && m.runId === runId).map((m) => (m as { text: string }).text);

  await waitFor(() => messages.some((m) => m.op === "ready"), "ready");
  send({ op: "run", runId: "r1", code: "const apps1 = await apps.list()\nconst count: number = apps1.length\nprint('apps', count, apps1[0].name)\nprint(typeof fetch, typeof Bun, typeof process)" });
  await waitFor(() => doneOf("r1") !== undefined, "run r1 done");
  send({ op: "run", runId: "r2", code: "print('kept', count)\ntry { await apps.open('x') } catch (e) { print('typed', e instanceof StaleRef) }" });
  await waitFor(() => doneOf("r2") !== undefined, "run r2 done");
  child.stdin!.end();
  const code = await Promise.race([exited, new Promise<number | null>((r) => setTimeout(() => r(-1), TIMEOUT_MS))]);
  if (stderr.trim()) log(`[stderr]\n${stderr.trim()}`);
  return [
    ["the compiled worker booted under the workflow seatbelt (ready)", messages.some((m) => m.op === "ready")],
    ["run 1 answered over the bridge and stripped TypeScript", doneOf("r1")?.error === undefined && printsOf("r1")[0] === "apps 1 Notes"],
    ["the worker withholds fetch, Bun and process from scripts", printsOf("r1")[1] === "undefined undefined undefined"],
    ["run 2 read run 1's top-level declaration (persistent runtime)", printsOf("r2")[0] === "kept 1"],
    ["a typed error crossed the bridge as its class (instanceof StaleRef)", printsOf("r2")[1] === "typed true" && doneOf("r2")?.error === undefined],
    ["the worker exited 0 when its stdin closed", code === 0],
  ];
}

async function main(): Promise<void> {
  log("=== verify:automation-worker — the compiled automation worker ===");
  if (!sandboxAvailable()) { log("SKIPPED — sandbox-exec unavailable on this host (macOS only)."); process.exit(0); }

  log("\n--- Step 1: compile dist/winter-core ---");
  const compile = spawnSync(process.execPath, ["run", "--filter", "@yanlinglabs/winter-cli", "compile:core"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000 });
  if (compile.stdout?.trim()) log(compile.stdout.trim());
  if (compile.stderr?.trim()) log(`[stderr]\n${compile.stderr.trim()}`);
  if (compile.status !== 0 || !existsSync(DIST_BINARY)) fail(`compile:core failed (exit ${compile.status ?? compile.signal})`);

  const profile = buildWorkflowSeatbeltProfile(DIST_BINARY);
  log("\n--- Step 2: round trip under the workflow seatbelt ---");
  const checks = await roundTrip(profile);

  log("\n--- Step 3: the Keychain-sandbox guard ---");
  const runLine = `${JSON.stringify({ op: "run", runId: "nope", code: "print('must-not-run')" })}\n`;
  const legs: Array<[string, string | null]> = [
    ["no sandbox", null],
    ["the workflow profile + com.apple.SecurityServer allowed", `${profile}(allow mach-lookup (global-name "com.apple.SecurityServer"))\n`],
    ["the workflow profile + com.apple.securityd.xpc allowed", `${profile}(allow mach-lookup (global-name "com.apple.securityd.xpc"))\n`],
  ];
  for (const [leg, sandbox] of legs) {
    const argv = sandbox === null ? [DIST_BINARY, ARG] : ["/usr/bin/sandbox-exec", "-p", sandbox, DIST_BINARY, ARG];
    const r = spawnSync(argv[0]!, argv.slice(1), { input: runLine, encoding: "utf8", timeout: TIMEOUT_MS });
    log(`  ${leg}: exit=${r.status} stdout=${JSON.stringify((r.stdout ?? "").slice(0, 120))} stderr=${JSON.stringify((r.stderr ?? "").trim().slice(0, 200))}`);
    checks.push([`the worker REFUSES under ${leg} (exit 77, no output)`, r.status === 77 && (r.stdout ?? "") === "" && (r.stderr ?? "").includes("refuses to run")]);
  }

  log("\n--- Assertions ---");
  for (const [name, ok] of checks) log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!checks.every(([, ok]) => ok)) fail("the compiled automation worker misbehaved — see the transcript above");
  log("\nRESULT: PASS — dist/winter-core runs ComputerV2 scripts in its sandboxed automation worker and refuses to run outside it.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
