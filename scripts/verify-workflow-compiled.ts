/**
 * Task A-verify — MANDATORY compiled-binary end-to-end proof that C1 is fixed.
 *
 * C1 (Critical, pre-re-plumb): workflows worked under `bun test` (dev subprocess) but were DEAD in
 * the shipped `bun build --compile` Release binary — invisible to every dev test, because the OLD
 * transport spawned a `Worker` pointing at a `.ts` file that does not exist inside a compiled binary
 * (there is no filesystem to point at — everything lives in `/$bunfs`). The re-plumb
 * (A-sandbox/A-entry'/A3'/A-main) fixed this via a self-spawned sandboxed subprocess that re-execs
 * `process.execPath` with a static `__workflow-worker` argv route (main.ts), so the entry ships
 * INSIDE the compiled binary instead of being loaded from a path that only exists in dev.
 *
 * This script is the ONLY check that exercises the true bundler + the real Release artifact
 * (dist/norma-core). `packages/core/src/workflows/subprocess-entry.test.ts` covers the stdio bridge
 * protocol under `bun test`, but that spawns `bun subprocess-entry.ts` directly (the DEV path) — it
 * never touches `bun build --compile` at all, so it could not have caught C1 and cannot regress-guard
 * it either. Only running the compiled binary itself can.
 *
 * Standalone — NOT part of the `bun test` sweep (it runs a full `bun build --compile`, which takes
 * real wall-clock time and writes a build artifact to `dist/`, which is gitignored). Run manually or
 * from a phase gate:
 *
 *   bun run scripts/verify-workflow-compiled.ts
 *   bun run verify:workflow   (package.json alias, if present)
 *
 * Steps (per .superpowers/sdd/task-Averify-brief.md):
 *   1. `bun run compile:core` -> dist/norma-core. NOTE: packages/cli/package.json is the only place
 *      `compile:core` is defined; plain `bun run compile:core` from the repo root fails with
 *      "Script not found" because bun does not search workspace packages without `--filter`. This
 *      script invokes it as `bun run --filter '@norma/cli' compile:core` with cwd = the repo root —
 *      the repo-root-relative invocation the brief calls for, that actually resolves the script.
 *   2. Build the tight seatbelt profile via buildWorkflowSeatbeltProfile(dist/norma-core) — NOT
 *      exported from `@norma/core`'s barrel, so imported directly from its source file (same as
 *      sandbox.test.ts does).
 *   3. spawn("/usr/bin/sandbox-exec", ["-p", profile, dist/norma-core, "__workflow-worker"], ...) —
 *      exactly the shape runtime.ts's `launch()` uses for a real daemon.
 *   4. Speak the NDJSON bridge (bridge.ts) by hand: one WorkerInit line in, reply to the single
 *      {op:"agent"} request, and assert {op:"phase"} then {op:"done", result:"[hi]"} come back before
 *      the child exits 0. The run completing at all IS the C1 regression check (step 7 of the brief):
 *      under the OLD Worker transport this could not even start on a compiled binary.
 *
 * If this ever fails again: STOP, do not weaken these assertions — see the diagnosis hints printed
 * alongside FAIL below.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowSeatbeltProfile, sandboxAvailable } from "../packages/core/src/workflows/sandbox";
import type { BridgeRequest, WorkerInit } from "../packages/core/src/workflows/bridge";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DIST_BINARY = join(REPO_ROOT, "dist", "norma-core");
/** Generous margin: the spike found the round-trip fast (sub-second); this only guards against a
 *  genuine hang (e.g. the reply never reaching the child) rather than normal cold-start variance. */
const ROUNDTRIP_TIMEOUT_MS = 30_000;
const COMPILE_TIMEOUT_MS = 180_000;

function log(line: string): void { console.log(line); }

function fail(message: string): never {
  console.error(`\nRESULT: FAIL — ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  log("=== Task A-verify: compiled-binary workflow end-to-end ===");
  log(`repo root   : ${REPO_ROOT}`);
  log(`dist binary : ${DIST_BINARY}`);

  if (!sandboxAvailable()) {
    // Not a PASS or a FAIL — this host simply cannot run the check (macOS + sandbox-exec only).
    log("\nSKIPPED — sandbox-exec unavailable on this host (this check is macOS-only).");
    process.exit(0);
  }

  // ---- Step 1: compile the REAL Release artifact -----------------------------------------------
  log("\n--- Step 1: compiling dist/norma-core (bun run --filter '@norma/cli' compile:core) ---");
  const compileStart = Date.now();
  const compile = spawnSync(
    process.execPath, // the running bun binary itself — avoids any PATH/version ambiguity
    ["run", "--filter", "@norma/cli", "compile:core"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: COMPILE_TIMEOUT_MS },
  );
  const compileMs = Date.now() - compileStart;
  log(`compile:core exit=${compile.status ?? "null"} signal=${compile.signal ?? "none"} (${compileMs}ms)`);
  if (compile.stdout?.trim()) log(compile.stdout.trim());
  if (compile.stderr?.trim()) log(`[stderr]\n${compile.stderr.trim()}`);
  if (compile.error) fail(`compile:core failed to spawn: ${compile.error.message}`);
  if (compile.status !== 0) fail(`compile:core exited ${compile.status ?? `signal ${compile.signal}`} — see output above`);
  if (!existsSync(DIST_BINARY)) fail(`compile:core reported success but ${DIST_BINARY} was not produced`);

  const st = statSync(DIST_BINARY);
  log(`binary produced: ${DIST_BINARY} (${st.size} bytes, mtime ${st.mtime.toISOString()})`);

  // Bonus/non-fatal signal: the compiled binary is a single self-contained blob; a coarse grep for
  // the workflow subcommand literal is an independent (if weak) hint the workflow code is actually
  // IN there. This is NOT the real proof — a missing/renamed string proves nothing either way — the
  // round-trip below is the only thing that can actually catch a bundling gap C1-style.
  const grep = spawnSync("grep", ["-ac", "__workflow-worker", DIST_BINARY], { encoding: "utf8" });
  log(`(info) literal "__workflow-worker" occurrences in binary: ${grep.stdout?.trim() || "0"}`);

  // ---- Step 2: build the tight seatbelt profile for THIS binary --------------------------------
  log("\n--- Step 2: buildWorkflowSeatbeltProfile(dist/norma-core) ---");
  const profile = buildWorkflowSeatbeltProfile(DIST_BINARY);
  log(profile);

  // ---- Step 3+4: spawn under sandbox-exec, speak the NDJSON bridge protocol by hand -------------
  log("--- Step 3: spawn /usr/bin/sandbox-exec -p <profile> dist/norma-core __workflow-worker ---");
  const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, DIST_BINARY, "__workflow-worker"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  log(`spawned pid=${child.pid ?? "?"}`);

  const messages: BridgeRequest[] = [];
  let stdoutBuf = "";
  let stderr = "";

  const write = (m: WorkerInit | { callId: number; ok: true; value: unknown }) =>
    child.stdin!.write(`${JSON.stringify(m)}\n`);

  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString("utf8");
    let i: number;
    while ((i = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, i);
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: BridgeRequest;
      try { msg = JSON.parse(line); } catch { log(`  <- [unparsable line] ${line}`); continue; }
      log(`  <- ${line}`);
      messages.push(msg);
      if (msg.op === "agent") {
        const reply = { callId: msg.callId, ok: true as const, value: `[${msg.prompt}]` };
        log(`  -> ${JSON.stringify(reply)}`);
        write(reply);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

  // Step 4: the one init NDJSON line, verbatim per the brief.
  const init: WorkerInit = {
    source: "phase('p'); const a = await agent('hi'); return a;",
    args: null,
    concurrency: 4,
  };
  log(`  -> ${JSON.stringify(init)}`);
  write(init);

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
        reject(new Error(`timed out after ${ROUNDTRIP_TIMEOUT_MS}ms waiting for the child to exit (no done/error+close)`));
      }, ROUNDTRIP_TIMEOUT_MS);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => { clearTimeout(timer); resolve(code); });
    });
  } catch (err) {
    if (stderr.trim()) log(`\n[stderr from child]\n${stderr.trim()}`);
    log(`\nmessages received before failure: ${JSON.stringify(messages, null, 2)}`);
    fail((err as Error).message);
  }

  log(`\nchild exited: ${exitCode}`);
  if (stderr.trim()) log(`[stderr from child]\n${stderr.trim()}`);

  // ---- Assertions --------------------------------------------------------------------------
  const phaseIdx = messages.findIndex((m) => m.op === "phase");
  const doneIdx = messages.findIndex((m) => m.op === "done");
  const doneMsg = doneIdx >= 0 ? (messages[doneIdx] as Extract<BridgeRequest, { op: "done" }>) : undefined;
  const hasError = messages.some((m) => m.op === "error");
  const errorMsg = messages.find((m) => m.op === "error") as Extract<BridgeRequest, { op: "error" }> | undefined;

  const checks: Array<[string, boolean]> = [
    ["bun booted under the tight seatbelt and the child produced NDJSON output", messages.length > 0],
    ['no {op:"error"} message emitted', !hasError],
    ['a {op:"phase"} message arrived', phaseIdx >= 0],
    ['{op:"phase"} arrived BEFORE {op:"done"}', phaseIdx >= 0 && doneIdx >= 0 && phaseIdx < doneIdx],
    ['{op:"done", result:"[hi]"} arrived', doneMsg !== undefined && doneMsg.result === "[hi]"],
    ["child exited with code 0", exitCode === 0],
  ];

  log("\n--- Assertions ---");
  for (const [name, ok] of checks) log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);

  const allPass = checks.every(([, ok]) => ok);
  if (!allPass) {
    log(`\nall messages received: ${JSON.stringify(messages, null, 2)}`);
    if (errorMsg) log(`\nchild-reported error: ${errorMsg.message}`);
    fail(
      "one or more assertions failed — the compiled binary did NOT successfully run the workflow " +
      "subprocess to completion. Diagnose before touching the assertions: " +
      "(a) bundling gap — no NDJSON at all + child stderr mentions a missing module/file -> the " +
      "workflow entry did not make it into dist/norma-core (this IS what C1 looked like); " +
      "(b) sandbox profile issue specific to the real binary — sandbox-exec exits 65 (profile " +
      "failed to load) or 71 (execvp denied) or stderr mentions 'Operation not permitted' around " +
      "process start -> buildWorkflowSeatbeltProfile's self-exec literal may not match the real " +
      "binary's canonicalized path; (c) argv/routing issue — process spawns and runs but never " +
      "emits {op:\"agent\"}/{op:\"phase\"} -> main.ts's `__workflow-worker` argv check or the compiled " +
      "binary's process.argv shape may differ from what runtime.ts's defaultWorkerCommand() assumes."
    );
  }

  log(
    "\nRESULT: PASS — dist/norma-core (the real `bun build --compile` Release artifact) self-spawned " +
    "a sandboxed __workflow-worker subprocess, ran the workflow script, round-tripped one agent() " +
    "call over the NDJSON stdio bridge, and exited 0. C1 (workflows dead in the compiled binary) is " +
    "fixed on the actual shipped artifact."
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
