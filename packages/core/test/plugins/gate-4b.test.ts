import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "../../src/plugins/supervisor";
import {
  bootSupervisedServer,
  buildSpawnablePlugins,
  createSupervisedInstance,
  installSampleEcho,
  isPidAlive,
  kill9,
  pidFilePath,
  realSpawn,
  unlinkStaleSocket,
  waitFor,
  writeAndLoadSettings,
  writePidFile,
  type SupervisedInstance,
} from "./supervised-fixtures";

/**
 * Phase 4b Task 7 — the 4b consolidated gate: chained against the REAL sample-echo child process
 * throughout (no scripted/fake connection anywhere in this file — see supervised-fixtures.ts's
 * doc comment, shared with Task 6's supervised-e2e.test.ts). Three scenarios, matching the plan
 * (docs/superpowers/plans/2026-07-08-phase-4b-supervisor-sdk.md, "Task 7"):
 *
 *  1. Kill-9 mid-call: `sleep {ms:5000}` in flight, `kill -9` the real child pid mid-call -> the
 *     invoke resolves as a typed isError ("crashed during sleep") and supervisor status hits
 *     "backoff" -> with a short backoff override the child restarts, re-registers, and echo works
 *     again on a NEW pid.
 *  2. Circuit: 5 fast REAL crashes (forced by killing each freshly-spawned real child the instant
 *     it appears, so the circuit's failure accounting is exercised by genuine process deaths, not
 *     a scripted stand-in) -> "circuit-open", no further spawn attempts, tools unregistered.
 *  3. Orphan reclaim across instances: a child spawned by instance A survives a simulated core
 *     restart (a fresh instance B, same runDir/socketPath) with no signal ever sent to it — B's
 *     `reclaimOrphans` adopts the live, identity-verified pid and the child's own SDK reconnect
 *     loop re-registers against B, unmodified (same OS process throughout); separately, a dead
 *     pid's abandoned file is cleaned up by reclaim without ever adopting or signalling anything.
 */

const ECHO_TOOL = (id: string) => `plugin__${id}__echo`;
const SLEEP_TOOL = (id: string) => `plugin__${id}__sleep`;
const CTX = { cwd: "/", roots: ["/"], sessionId: "gate-4b" };

async function echoRoundTrip(
  registry: Awaited<ReturnType<typeof bootSupervisedServer>>["registry"],
  pluginId: string,
  text: string,
): Promise<{ echo: string; pluginPid: number }> {
  const outcome = await registry.execute(ECHO_TOOL(pluginId), { text }, CTX);
  expect(outcome.isError).toBe(false);
  return JSON.parse(outcome.output) as { echo: string; pluginPid: number };
}

// -------------------------------------------------------------------------------------------
// 1. Kill-9 mid-call: typed crash + backoff + real restart.
// -------------------------------------------------------------------------------------------

describe("4b gate: kill-9 mid-call recovery", () => {
  let srv: Awaited<ReturnType<typeof bootSupervisedServer>> | null = null;
  afterEach(() => { srv?.stop(); srv = null; });

  test(
    "sleep{ms:5000} kill -9 mid-call -> typed 'crashed during sleep' isError + status backoff -> short-backoff restart -> echo round-trips on a NEW pid",
    async () => {
      const pluginId = "sample-echo";
      srv = await bootSupervisedServer(pluginId, {
        // registrationTimeoutMs stays generous (the FIRST real spawn+register must succeed
        // reliably) — only the backoff cap is shortened, so the post-crash restart is fast without
        // racing the initial boot.
        supervisorSettings: { registrationTimeoutMs: 60_000, backoffCapMs: 500, killGraceMs: 1_500 },
      });

      await waitFor(() => srv?.supervisor.status(pluginId) === "running", 30_000, "initial registration");
      await waitFor(
        () => !!(srv?.registry.has(ECHO_TOOL(pluginId)) && srv?.registry.has(SLEEP_TOOL(pluginId))),
        5_000,
        "initial tool registration",
      );

      const first = await echoRoundTrip(srv.registry, pluginId, "hi");
      const childPid = first.pluginPid;
      expect(isPidAlive(childPid)).toBe(true);

      // Invoke sleep{ms:5000} WITHOUT awaiting — a real request over the real socket to the real
      // child, which starts an actual 5s setTimeout before it would ever reply.
      const sleepPromise = srv.registry.execute(SLEEP_TOOL(pluginId), { ms: 5000 }, CTX);
      // Generous margin (not a race) for the real wire round trip to land on the child before we
      // kill it — local unix sockets are near-instant.
      await new Promise((r) => setTimeout(r, 300));

      kill9(childPid);

      const outcome = await sleepPromise;
      expect(outcome.isError).toBe(true);
      expect(outcome.output).toBe(`plugin ${pluginId} crashed during sleep`);
      // Deterministic, not a poll: PluginSupervisor#failAttempt resolves every pending invoke
      // (failPendingInvokes) strictly BEFORE it assigns rt.status = "backoff", in the same
      // synchronous function body (supervisor.ts) — by the time our `await` above resumes, the
      // status flip has already happened, on either trigger path (proc.exited or the socket's
      // own close -> notifyDisconnected).
      expect(srv.supervisor.status(pluginId)).toBe("backoff");

      // Short backoff (backoffCapMs: 500) -> automatic real respawn -> re-registration -> running.
      await waitFor(() => srv?.supervisor.status(pluginId) === "running", 30_000, "status running again after backoff restart");
      await waitFor(
        () => !!(srv?.registry.has(ECHO_TOOL(pluginId)) && srv?.registry.has(SLEEP_TOOL(pluginId))),
        5_000,
        "tool re-registration after restart",
      );

      const second = await echoRoundTrip(srv.registry, pluginId, "back");
      expect(second.echo).toBe("back");
      expect(second.pluginPid).not.toBe(childPid); // a NEW OS process, not the one we killed
      expect(isPidAlive(second.pluginPid)).toBe(true);
      expect(isPidAlive(childPid)).toBe(false); // the killed pid stays dead — no zombie/orphan
    },
    90_000, // 60s registration budget + margin (real child spawn under load)
  );
});

// -------------------------------------------------------------------------------------------
// 2. Circuit breaker: 5 fast REAL crashes.
// -------------------------------------------------------------------------------------------

describe("4b gate: circuit breaker (5 real crashes)", () => {
  let inst: SupervisedInstance | null = null;
  afterEach(() => {
    if (inst) { inst.supervisor.stopAll(); inst.server.stop(); inst.store.close(); inst = null; }
  });

  test(
    "5 rapid REAL-child crashes trip the circuit; no 6th spawn attempt ever follows; tools unregistered",
    async () => {
      const pluginId = "sample-echo";
      const home = mkdtempSync(join(tmpdir(), "norma-gate-4b-circuit-"));
      installSampleEcho(home, pluginId);
      const settings = writeAndLoadSettings(home, pluginId);
      const socketPath = join(home, "core.sock");
      const spawnable = buildSpawnablePlugins(home, settings);

      // Wraps the REAL production spawn (still a genuine `bun index.ts` OS process every time) so
      // the test can learn each attempt's pid the instant it appears, and count total attempts —
      // the injectable `spawn` seam exists in PluginSupervisor precisely for this kind of
      // instrumentation (supervisor.ts's own doc comment), not to fake anything.
      const spawnedPids: number[] = [];
      let spawnCalls = 0;
      const spawn: SpawnFn = (cmd, opts) => {
        spawnCalls++;
        const proc = realSpawn(cmd, opts);
        spawnedPids.push(proc.pid);
        return proc;
      };

      inst = await createSupervisedInstance({
        home, socketPath, spawn,
        supervisorSettings: {
          registrationTimeoutMs: 60_000, backoffCapMs: 80, killGraceMs: 500,
          circuitFailures: 5, circuitWindowMs: 600_000,
        },
      });
      inst.supervisor.startAll(spawnable);

      // Force 5 fast, REAL crashes: as soon as each new attempt's real OS process appears, kill -9
      // it — whether it's still "starting" (never got to register) or briefly reached "running"
      // doesn't matter; PluginSupervisor#failAttempt records a circuit failure either way (only
      // `attempt`, the backoff exponent, resets on a successful registration — `failures`, the
      // circuit-breaker's own history, never does; see supervisor.ts's PluginRuntime doc comment).
      // PluginSupervisor only ever has one attempt in flight per plugin id (single generation,
      // strictly serialized spawn -> fail -> backoff -> respawn), so this loop can never race
      // itself into killing the wrong generation's pid.
      for (let i = 0; i < 5; i++) {
        await waitFor(() => spawnedPids.length > i, 30_000, `real spawn attempt #${i + 1}`);
        kill9(spawnedPids[i]!);
      }

      await waitFor(() => inst?.supervisor.status(pluginId) === "circuit-open", 30_000, "circuit-open after 5 real crashes");
      expect(spawnedPids).toHaveLength(5);
      const callsAtOpen = spawnCalls;

      // No 6th spawn attempt ever follows — the whole point of the breaker.
      await new Promise((r) => setTimeout(r, 400));
      expect(spawnCalls).toBe(callsAtOpen);
      expect(spawnedPids).toHaveLength(5);

      // onCircuitOpen (wired in supervised-fixtures.ts, mirroring daemon.ts's own wiring)
      // unregisters the plugin's tools out of the ToolRegistry the instant the breaker trips.
      expect(inst.registry.has(ECHO_TOOL(pluginId))).toBe(false);
      expect(inst.registry.has(SLEEP_TOOL(pluginId))).toBe(false);

      // No orphan processes: every one of the 5 real children we killed is actually dead.
      for (const pid of spawnedPids) {
        await waitFor(() => !isPidAlive(pid), 3_000, `spawned pid ${pid} to be dead`);
      }
    },
    90_000, // 60s registration budget + margin (real child spawn under load)
  );
});

// -------------------------------------------------------------------------------------------
// 3. Orphan reclaim across instances.
// -------------------------------------------------------------------------------------------

describe("4b gate: orphan reclaim across a simulated core restart", () => {
  test(
    "a live, PID-verified child spawned by instance A re-registers against a fresh instance B (same runDir/socketPath) — the SAME OS process, never respawned",
    async () => {
      const pluginId = "sample-echo";
      const home = mkdtempSync(join(tmpdir(), "norma-gate-4b-reclaim-"));
      installSampleEcho(home, pluginId);
      const settings = writeAndLoadSettings(home, pluginId);
      const socketPath = join(home, "core.sock");
      const spawnable = buildSpawnablePlugins(home, settings);

      // Instance A: real boot, real spawn, real registration — `signalPid` neutered from
      // construction (irrelevant to this normal startup path; it only matters for the deliberate
      // teardown dance below). This instance's whole purpose is to prove the ORIGINAL child
      // process outlives it.
      const a = await createSupervisedInstance({
        home, socketPath,
        supervisorSettings: { registrationTimeoutMs: 60_000, killGraceMs: 1_500 },
        signalPid: () => {},
      });
      a.supervisor.startAll(spawnable);
      await waitFor(() => a.supervisor.status(pluginId) === "running", 30_000, "instance A initial registration");
      await waitFor(() => a.registry.has(ECHO_TOOL(pluginId)), 5_000, "instance A tool registration");

      const first = await echoRoundTrip(a.registry, pluginId, "hi");
      const childPid = first.pluginPid;
      expect(isPidAlive(childPid)).toBe(true);

      // --- Simulate a core restart, WITHOUT ever touching the real child process. ---
      //
      // A real core crash never gets the chance to run ANY of its own cleanup code — the pid file
      // it wrote at spawn time is simply abandoned, live process and all. We can't literally crash
      // our own test process, so we reproduce that end state deliberately: back up the pid file's
      // exact bytes (every PluginSupervisor-internal teardown path, stopAll() included,
      // unconditionally deletes it — exactly wrong for what we're simulating), then call
      // stopAll() on instance A with `signalPid` neutered so its "kill the process" reflex is a
      // no-op (a real SIGTERM would make the plugin-sdk's own signal handler close() + exit(0)
      // immediately — there is no grace period long enough to dodge that, it must never be sent).
      // stopAll() also flips rt.status to "stopped" and marks the current generation settled,
      // which is what makes the socket-close below inert on instance A's side (notifyDisconnected
      // no-ops outside status "running" — see supervisor.ts) instead of scheduling a stray
      // respawn.
      const pidFileBackup = readFileSync(pidFilePath(home, pluginId), "utf8");
      a.supervisor.stopAll();
      expect(isPidAlive(childPid)).toBe(true); // proof the neutered signalPid really didn't touch it
      writeFileSync(pidFilePath(home, pluginId), pidFileBackup); // restore the "abandoned" file

      // NOW sever the transport: force-close instance A's connections (the child's own SDK-side
      // socket sees "close" and schedules its reconnect-with-backoff — this is the ONLY thing that
      // needs to happen on instance A's side, and thanks to the dance above it is now a no-op
      // there), close its SessionStore handle (mirrors the old core process being gone), and
      // unlink the stale socket path so a fresh listener can bind it (Bun.listen does not
      // auto-unlink a leftover unix socket file — same precedent as lock.ts#acquireLock).
      a.server.stop();
      a.store.close();
      unlinkStaleSocket(socketPath);

      // Instance B: a completely fresh SupervisedInstance — fresh SessionStore (re-opens the SAME
      // on-disk sqlite file, so the plugin token hash instance A minted still verifies), fresh
      // ToolRegistry/PluginSupervisor — bound to the SAME runDir/socketPath, simulating exactly
      // what a restarted core process does.
      const b = await createSupervisedInstance({
        home, socketPath,
        supervisorSettings: { registrationTimeoutMs: 60_000, killGraceMs: 1_500 },
      });

      // Boot-time orphan reclaim: the (restored) pid file names a live, identity-verified process
      // (real `ps -o lstart=` match) -> adopted into "starting" with a fresh re-registration
      // window, no new spawn.
      b.supervisor.reclaimOrphans(spawnable);
      expect(b.supervisor.status(pluginId)).toBe("starting");

      // The still-running child's OWN SDK reconnect loop (1s·2^n backoff) notices its connection
      // dropped and re-hellos/re-registers against the SAME socketPath, now served by instance B.
      await waitFor(() => b.supervisor.status(pluginId) === "running", 30_000, "instance B adopts the reclaimed child");
      await waitFor(() => b.registry.has(ECHO_TOOL(pluginId)), 5_000, "instance B tool re-registration");

      const second = await echoRoundTrip(b.registry, pluginId, "still me");
      expect(second.echo).toBe("still me");
      expect(second.pluginPid).toBe(childPid); // the EXACT SAME OS process — never respawned

      b.supervisor.stopAll();
      b.server.stop();
      b.store.close();
      await waitFor(() => !isPidAlive(childPid), 5_000, "reclaimed child exits after instance B's real teardown");
    },
    90_000, // 60s registration budget + margin (real child spawn under load)
  );

  test(
    "a dead pid's abandoned file is cleaned up by a fresh instance's reclaim — never adopted, no signal sent to anything",
    async () => {
      const pluginId = "sample-echo-dead";
      const home = mkdtempSync(join(tmpdir(), "norma-gate-4b-reclaim-dead-"));
      const dir = installSampleEcho(home, pluginId);
      const settings = writeAndLoadSettings(home, pluginId);
      const socketPath = join(home, "core.sock");
      const spawnable = buildSpawnablePlugins(home, settings);

      // A real, once-alive sample-echo process, spawned directly (bypassing the supervisor
      // entirely — this one never needs to register with anything), killed with a real `kill -9`,
      // and confirmed dead: an abandoned pid file naming a process that is simply gone (the
      // ordinary case a core crash leaves behind, alongside the still-alive case above) is exactly
      // what reclaimOrphans exists to recognize and discard.
      const proc = Bun.spawn(["bun", "index.ts"], {
        cwd: dir,
        env: {
          ...process.env,
          NORMA_SOCKET: join(home, "unused.sock"), NORMA_PLUGIN_TOKEN: "unused",
          NORMA_PLUGIN_ID: pluginId, NORMA_PLUGIN_DIR: dir,
        },
        stdout: "ignore", stderr: "ignore", stdin: "ignore",
      });
      const deadPid = proc.pid;
      kill9(deadPid);
      await proc.exited;
      await waitFor(() => !isPidAlive(deadPid), 5_000, "throwaway process to be confirmed dead");

      // reclaimOrphans checks liveness FIRST, before ever touching the identity (startedAt)
      // verification — the recorded startedAt value is irrelevant on the dead branch, so any
      // plausible string proves the point.
      writePidFile(home, pluginId, deadPid, "irrelevant — the dead branch never reaches the identity check");
      expect(existsSync(pidFilePath(home, pluginId))).toBe(true);

      const inst = await createSupervisedInstance({
        home, socketPath,
        // Belt-and-braces: reclaimOrphans must never spawn anything on any branch — if it somehow
        // did, this makes the test fail loudly instead of silently starting a stray real process.
        spawn: () => { throw new Error("reclaimOrphans must never spawn"); },
        supervisorSettings: { registrationTimeoutMs: 60_000 },
      });

      inst.supervisor.reclaimOrphans(spawnable);
      expect(existsSync(pidFilePath(home, pluginId))).toBe(false); // cleaned up
      expect(inst.supervisor.status(pluginId)).toBe("stopped"); // never tracked/adopted

      inst.server.stop();
      inst.store.close();
    },
    15_000,
  );
});
