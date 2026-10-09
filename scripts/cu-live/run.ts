#!/usr/bin/env bun
/**
 * The LIVE ComputerV2 end-to-end suite: the real stack — a daemon → the sandboxed automation worker → the signed dev
 * helper → real windows — driven with no LLM and no human, asserting what is otherwise checked by eye.
 *
 *   WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live              # the fixture scenarios + perf (~2-3 min of screen)
 *   WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live --real-apps  # + Safari, TextEdit, Finder, Preview (temp docs only)
 *   bun run e2e:cu-live --dry-run                            # builds, self-tests, the no-screen plumbing check
 *   options: --only <text> (scenarios whose name contains it), --yes (no countdown), --keep-temp,
 *            --helper-app <path to "Winter Computer Use Dev.app"> (else $WINTER_COMPUTER_USE_APP, else dist/dev/)
 *
 * WHAT RUNS (all isolated — nothing touches ~/.winter*, the Keychain, or the user's own daemon and helper):
 *   - a temp home `$TMPDIR/winter-cu-live-*`, and `winter-core-live` on it: the real daemon, compiled from
 *     `daemon-entry.ts`, signed as the dev daemon (the helper accepts only that), with a FILE secret store;
 *   - a SECOND instance of the dev helper for that home (`open -n -g --env WINTER_CU_HOME=<home>`): the dev helper
 *     honours WINTER_CU_HOME, and TCC keys its Accessibility/Screen Recording grants on its designated requirement,
 *     so the instance already holds them — the runner itself needs no grant;
 *   - two fixture apps (`swift/Fixture`): "Winter CU Fixture" (the target, launched in the background, one window in
 *     full screen = on its own Space) and "Winter CU User App" (frontmost: the user's app);
 *   - `cu-live-tool monitor`: the frontmost app, the active Space and the HID idle time every 20 ms (+ every
 *     activation) — every scenario asserts the user's frontmost app and Space never change, from its start until 3 s
 *     after it, and a drop of the HID idle time (real input) aborts the run;
 *   - `cu-live-viewprobe`: the helper's mirror stream (`view.*`), checked for frames, blank frames and repeats;
 *   - two sessions on the agent SDK's prompt-scripted double (`winter-test/calls`): `bypass` (no cards) and `ask`
 *     (the per-app card, answered here).
 * Every window, Space and process it made is closed at the end, whatever happened.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHODS, type SessionEvent } from "../../packages/protocol/src/index";
import { resolvePlatformPackageWinter } from "../../packages/core/src/runtime-sdk/executable";
import { buildAll, REPO_ROOT, type Built } from "./build";
import { DaemonClient } from "./client";
import {
  check, computerV2Message, describeViolations, focusViolations, hidInputTimes, markerFacts, parseFixtureLog, parseMonitorLine, parseTopDelta,
  renderTable, statusOf, summarizeTop, type Check, type FixtureEvent, type FocusBaseline, type MonitorSample, type ScenarioResult,
} from "./lib";
import { REAL_APP_SCENARIOS, realAppsPreflight, type RealAppsRun } from "./real-apps";
import { expectedCardSummary, SCENARIOS, scriptOf, type ImageStats, type ProbeEvent, type Scenario } from "./scenarios";

// ── thresholds (env overrides) ───────────────────────────────────────────────────────────────────────────────────
const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const LIMITS = {
  idleCpu: num("CU_LIVE_IDLE_CPU_MAX", 1.0),          // % of one core, mean over the idle windows
  idleWakeups: num("CU_LIVE_IDLE_WAKEUPS_MAX", 50),    // per second, worst window
  streamCpu: num("CU_LIVE_STREAM_CPU_MAX", 30),        // the helper while a changing window is streamed
};
const WATCH_AFTER_MS = 3_000;
const MONITOR_INTERVAL_MS = 20;

interface Options { dryRun: boolean; realApps: boolean; only?: string; yes: boolean; keepTemp: boolean; helperApp?: string }

function parseOptions(argv: string[]): Options {
  const o: Options = { dryRun: false, realApps: false, yes: false, keepTemp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--real-apps") o.realApps = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--keep-temp") o.keepTemp = true;
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--helper-app") o.helperApp = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

const log = (line: string): void => { process.stderr.write(`e2e:cu-live: ${line}\n`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sh(cmd: string, args: string[], input?: string, env?: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, ...(env === undefined ? {} : { env }) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * The per-user temp dir (`getconf DARWIN_USER_TEMP_DIR`) — the one a LaunchServices-launched helper sees as its
 * `NSTemporaryDirectory()`. The run dir must live there: only a home inside `<it>/winter-cu-live-*` makes the dev
 * helper a live-test instance (`HelperIdentity.isLiveTestHome`), whatever `$TMPDIR` this shell has.
 */
function userTempDir(): string {
  const dir = sh("getconf", ["DARWIN_USER_TEMP_DIR"]).stdout.trim();
  return dir.length > 0 && existsSync(dir) ? realpathSync(dir) : realpathSync(tmpdir());
}

function makeRunDir(): string {
  return realpathSync(mkdtempSync(join(userTempDir(), "winter-cu-live-")));
}

/** A unix socket path is at most 103 bytes (`sockaddr_un`); the per-user temp dir alone is ~57, so the run dir's
 *  home is one letter and the helper's `<home>/run/computer-use.sock` still fits. Refused here, not by the helper. */
const SOCKET_PATH_MAX = 103;
function homeIn(root: string): string {
  const home = join(root, "h");
  const socket = join(home, "run", "computer-use.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`the helper's socket path would be ${Buffer.byteLength(socket)} bytes (limit ${SOCKET_PATH_MAX}): ${socket}`);
  return home;
}

/** `cu-live-tool image-stats` on every screenshot the live daemon wrote since `since` (`<home>/cu-live-shots`). */
function shotsSince(tool: string, home: string, since: number): ImageStats[] {
  const dir = join(home, "cu-live-shots");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => Number(f.split("-")[0]) >= since).sort(); } catch { return []; }
  return files.map((f) => {
    const r = sh(tool, ["image-stats", join(dir, f)]);
    try {
      const o = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as Partial<ImageStats> & { error?: string };
      if (o.error !== undefined || typeof o.width !== "number") return { file: f, width: 0, height: 0, stddevLuma: 0, blank: true, sentinelPixels: 0, error: o.error ?? "undecodable" };
      return { file: f, width: o.width, height: o.height ?? 0, stddevLuma: o.stddevLuma ?? 0, blank: o.blank === true, sentinelPixels: o.sentinelPixels ?? 0 };
    } catch {
      return { file: f, width: 0, height: 0, stddevLuma: 0, blank: true, sentinelPixels: 0, error: (r.stderr || r.stdout).trim().slice(0, 200) };
    }
  });
}

async function until<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out (${ms} ms) waiting for ${what}`);
    await sleep(25);
  }
}

/** Every running process whose executable is `exe` (`pgrep -f` on its full path). */
function pidsOf(exe: string): number[] {
  return sh("pgrep", ["-f", exe]).stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The dev helper app: the option, `$WINTER_COMPUTER_USE_APP`, else this checkout's `dist/dev`. Must be the DEV build. */
function helperAppPath(o: Options): string {
  const candidates = [o.helperApp, process.env.WINTER_COMPUTER_USE_APP, join(REPO_ROOT, "dist", "dev", "Winter Computer Use Dev.app")].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const id = sh("plutil", ["-extract", "CFBundleIdentifier", "raw", join(p, "Contents", "Info.plist")]).stdout.trim();
    if (id !== "com.winter.computeruse.dev") throw new Error(`${p} is ${id || "not an app"}, not the dev helper (com.winter.computeruse.dev)`);
    return p;
  }
  throw new Error("no dev helper found — run `bun run dev:helper` (and grant it Accessibility + Screen Recording once), or pass --helper-app");
}

// ── child processes the run owns ─────────────────────────────────────────────────────────────────────────────────

/** A line-producing child: every stdout line is parsed and kept with its arrival time. */
class LineProcess<T> {
  readonly items: T[] = [];
  readonly stderr: string[] = [];
  private buf = "";
  constructor(readonly child: ChildProcess, parse: (line: string) => T | undefined) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const v = parse(line);
        if (v !== undefined) this.items.push(v);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { this.stderr.push(...d.split("\n").filter(Boolean)); if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200); });
  }
  async stop(ms = 3_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { this.child.stdin?.end(); } catch { /* closed */ }
    this.child.kill("SIGTERM");
    const t0 = Date.now();
    while (this.child.exitCode === null && this.child.signalCode === null && Date.now() - t0 < ms) await sleep(25);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

interface Fixtures {
  runId: string;
  logPath: string;
  mainPid?: number;
  userPid?: number;
  seq: number;
}

function fixtureEvents(f: Fixtures): FixtureEvent[] {
  try { return parseFixtureLog(readFileSync(f.logPath, "utf8")); } catch { return []; }
}

function launchFixture(app: string, role: "main" | "user", f: Fixtures, background: boolean): void {
  const args = ["-n", ...(background ? ["-g"] : []), "--env", `WINTER_CU_FIXTURE_LOG=${f.logPath}`, "--env", `WINTER_CU_FIXTURE_ROLE=${role}`, "--env", `WINTER_CU_FIXTURE_RUN=${f.runId}`, "-a", app];
  const r = sh("open", args);
  if (r.status !== 0) throw new Error(`open ${app} failed: ${r.stderr.trim()}`);
}

async function postCommand(tool: string, f: Fixtures, role: "main" | "user", cmd: string, args: Record<string, unknown> = {}, ms = 5_000): Promise<FixtureEvent> {
  const seq = String(++f.seq);
  const r = sh(tool, ["post", "--run", f.runId, "--role", role, "--cmd", cmd, "--args", JSON.stringify(args), "--seq", seq]);
  if (r.status !== 0) throw new Error(`cu-live-tool post ${cmd} failed: ${r.stderr.trim()}`);
  return await until(`the ${role} fixture's ack of ${cmd}`, ms, () => fixtureEvents(f).find((e) => e.role === role && (e.ev === "cmd.ack" || e.ev === "cmd.error") && String(e.seq) === seq));
}

async function dumpState(tool: string, f: Fixtures): Promise<Record<string, unknown> | undefined> {
  const t0 = Date.now();
  await postCommand(tool, f, "main", "dump");
  const state = await until("the fixture's state dump", 5_000, () => fixtureEvents(f).filter((e) => e.role === "main" && e.ev === "state" && e.t >= t0 - 5).at(-1));
  return state as Record<string, unknown>;
}

async function topDelta(pid: number, windows: number, seconds: number): Promise<ReturnType<typeof parseTopDelta>> {
  const proc = Bun.spawn(["top", "-l", String(windows + 1), "-s", String(seconds), "-c", "d", "-pid", String(pid), "-stats", "pid,cpu,idlew"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parseTopDelta(out, pid);
}

// ── the dry run: builds, self-tests, and the plumbing with no screen ───────────────────────────────────────────

async function startLiveDaemon(built: Pick<Built, "daemon">, home: string): Promise<{ proc: LineProcess<Record<string, unknown>>; socket: string; pid: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WINTER_")) env[k] = v;
  const winter = process.env.WINTER_RUNTIME_EXECUTABLE ?? resolvePlatformPackageWinter();
  if (winter === undefined) throw new Error("no `winter` runtime (the npm platform package) — run `bun install`, or set WINTER_RUNTIME_EXECUTABLE");
  Object.assign(env, {
    WINTER_HOME: home, WINTER_PROFILE: "dev", WINTER_CU_LIVE_TESTS: "1", WINTER_RUNTIME_EXECUTABLE: winter, TMPDIR: `${userTempDir()}/`,
    WINTER_LOGIN_SHELL_PATH: "off", WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-cu-live",
  });
  const child = spawn(built.daemon, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  const proc = new LineProcess<Record<string, unknown>>(child, (l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } });
  const ready = await until("the live daemon to come up", 60_000, () => {
    if (child.exitCode !== null) throw new Error(`winter-core-live exited (${child.exitCode}): ${proc.stderr.slice(-5).join(" | ")}`);
    return proc.items.find((i) => i.ready === true);
  });
  return { proc, socket: String(ready.socket), pid: Number(ready.pid) };
}

async function openSession(client: DaemonClient, cwd: string, policy: "bypass" | "ask"): Promise<string> {
  const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "cu-live", mode: "code", cwd, model: "winter-test/calls", approvalPolicy: policy });
  await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
  return sessionId;
}

/** Send one scripted turn and wait for its end; answers the ComputerV2 cards with `answer` (ask sessions). */
async function runTurn(client: DaemonClient, sessionId: string, text: string, ms: number, answer?: Scenario["answer"]): Promise<{ output: string; isError: boolean; cards: SessionEvent[] }> {
  const from = client.events.length;
  const cards: SessionEvent[] = [];
  const answered = new Set<string>();
  await client.call(METHODS.sessionSend, { sessionId, text });
  await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && (e as { threadId?: string }).threadId === "main", ms, from, () => {
    for (let i = from; i < client.events.length; i++) {
      const e = client.events[i]! as SessionEvent & { callId?: string; toolName?: string };
      if (e.type !== "approval_requested" || e.sessionId !== sessionId || e.callId === undefined || answered.has(e.callId)) continue;
      answered.add(e.callId);
      cards.push(e);
      // Only the per-app card is approved; any other card (a foreground request would hand over the real pointer) is denied.
      const approved = answer !== undefined && answer !== false && (e as { summary?: string }).summary === expectedCardSummary();
      void client.call(METHODS.approvalRespond, { sessionId, callId: e.callId, approved, ...(approved ? { optionId: answer } : {}) }).catch(() => {});
    }
  });
  const events = client.events.slice(from).filter((e) => e.sessionId === sessionId);
  const call = events.find((e): e is Extract<SessionEvent, { type: "tool_call" }> => e.type === "tool_call" && /computer_?v2/i.test((e as { name: string }).name));
  const result = call === undefined ? undefined : events.find((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result" && e.callId === call.callId);
  if (result === undefined) return { output: `(no ComputerV2 result in the turn — ${call === undefined ? "the call was never made" : "no result"})`, isError: true, cards };
  return { output: result.output, isError: result.isError, cards };
}

async function dryRun(built: Built, o: Options): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const selfTest = (name: string, cmd: string, args: string[]): void => {
    const t0 = Date.now();
    const r = sh(cmd, args);
    results.push({ name, group: "self-test", status: r.status === 0 && /SELFTEST OK/.test(r.stdout) ? "pass" : "fail", ms: Date.now() - t0, checks: [check(name, r.status === 0, (r.stdout + r.stderr).trim().slice(-300))] });
  };
  selfTest("fixture --self-test", join(built.fixtureMain, "Contents", "MacOS", "WinterCUFixture"), ["--self-test"]);
  selfTest("cu-live-tool self-test", built.tool, ["self-test"]);
  selfTest("cu-live-viewprobe self-test", built.viewProbe, ["self-test"]);
  results.push(await plumbingCheck(built));
  results.push(await peerCheck(built, o));
  return results;
}

/**
 * Which dev helpers accept the suite's TEST identities — no screen, no script (so no Esc tap): the dev helper's
 * executable is run as a plain child on two temp homes, as `verify:computer-helper` does. On an ordinary home it must
 * close both the test daemon (`winter-core-live __peer-hello`) and the test probe unanswered; on a live-test home
 * (`<user temp>/winter-cu-live-*`) it must accept both. A helper built before the live-test rule fails the second
 * half — rebuild it from this branch (`bun run dev:helper`; its TCC grants survive, its requirement is stated).
 */
async function peerCheck(built: Built, o: Options): Promise<ScenarioResult> {
  const t0 = Date.now();
  const checks: Check[] = [];
  let helperApp: string;
  try { helperApp = helperAppPath(o); } catch (err) {
    return { name: "the dev helper accepts the test identities only on a live-test home", group: "identity", status: "skip", ms: 0, checks: [], note: err instanceof Error ? err.message : String(err) };
  }
  const exe = join(helperApp, "Contents", "MacOS", "Winter Computer Use Dev");
  const normalRoot = realpathSync(mkdtempSync(join(userTempDir(), "winter-cu-x-")));
  const liveRoot = makeRunDir();
  try {
    for (const [label, root, expectAccepted] of [["an ordinary temp home", normalRoot, false], ["a live-test home", liveRoot, true]] as const) {
      const home = homeIn(root);
      mkdirSync(home);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WINTER_")) env[k] = v;
      const helper = new LineProcess<string>(spawn(exe, [], { env: { ...env, WINTER_CU_HOME: home, TMPDIR: `${userTempDir()}/` }, stdio: ["ignore", "pipe", "pipe"] }), (l) => l);
      try {
        const socket = join(home, "run", "computer-use.sock");
        await until(`the helper's socket (${label})`, 10_000, () => {
          if (helper.child.exitCode !== null) throw new Error(`the dev helper exited (${helper.child.exitCode}): ${helper.stderr.slice(-3).join(" | ")}`);
          return existsSync(socket);
        });
        const hello = sh(built.daemon, ["__peer-hello", socket, home], undefined, { ...env, WINTER_CU_LIVE_TESTS: "1" });
        const daemonAnswer = JSON.parse(hello.stdout.trim() || "{}") as { accepted?: boolean };
        const probe = spawnSync(built.viewProbe, ["--socket", socket, "--home", home, "--session", "s_identitycheck"], { input: "", encoding: "utf8", timeout: 8_000 });
        const probeAccepted = probe.status === 0 && /"ev":"subscribed"/.test(probe.stdout ?? "");
        checks.push(check(`${label}: the test daemon is ${expectAccepted ? "accepted" : "refused"}`, daemonAnswer.accepted === expectAccepted, hello.stdout.trim().slice(0, 200)));
        checks.push(check(`${label}: the test probe is ${expectAccepted ? "accepted" : "refused"}`, probeAccepted === expectAccepted, `exit ${probe.status}: ${(probe.stdout ?? "").trim().slice(0, 160)}`));
      } finally {
        await helper.stop(5_000);
      }
    }
  } catch (err) {
    checks.push(check("the identity check ran", false, err instanceof Error ? err.message : String(err)));
  } finally {
    rmSync(normalRoot, { recursive: true, force: true });
    rmSync(liveRoot, { recursive: true, force: true });
  }
  return { name: "the dev helper accepts the test identities only on a live-test home", group: "identity", status: statusOf(checks), ms: Date.now() - t0, checks };
}

/**
 * The plumbing, with no helper and no window: the signed daemon on a temp home, the scripted double, ComputerV2 in the
 * sandboxed worker. `apps.list()` must fail as HelperUnavailable — proof that nothing was launched.
 */
export async function plumbingCheck(built: Pick<Built, "daemon">): Promise<ScenarioResult> {
  const t0 = Date.now();
  const root = makeRunDir();
  const home = homeIn(root);
  mkdirSync(home);
  let daemon: Awaited<ReturnType<typeof startLiveDaemon>> | undefined;
  const checks: Check[] = [];
  try {
    daemon = await startLiveDaemon(built, home);
    checks.push(check("the signed live daemon came up on a temp home", true));
    const client = await DaemonClient.connect(daemon.socket);
    await client.hello(readFileSync(join(home, "test-secrets", "harness-token"), "utf8").trim(), "cu-live");
    const sid = await openSession(client, root, "bypass");
    const code = `print("CULIVE " + JSON.stringify({ sum: 1 + 1 }));\nlet unavailable = null;\ntry { await apps.list({ emit: false }); } catch (e) { unavailable = e.name; }\nprint("CULIVE " + JSON.stringify({ unavailable }));`;
    const turn = await runTurn(client, sid, computerV2Message(code, 30_000), 90_000);
    const facts = markerFacts(turn.output);
    checks.push(check("the scripted double called ComputerV2, and the sandboxed worker ran the script", facts.sum === 2, turn.output.slice(-300)));
    checks.push(check("with no helper running, nothing was launched (HelperUnavailable)", facts.unavailable === "HelperUnavailable", String(facts.unavailable)));
    client.close();
  } catch (err) {
    checks.push(check("the plumbing ran", false, err instanceof Error ? err.message : String(err)));
  } finally {
    await daemon?.proc.stop();
    rmSync(root, { recursive: true, force: true });
  }
  return { name: "daemon + scripted model + worker (no screen)", group: "plumbing", status: statusOf(checks), ms: Date.now() - t0, checks };
}

// ── the live run ─────────────────────────────────────────────────────────────────────────────────────────────────

class Aborted extends Error {}

async function liveRun(built: Built, o: Options): Promise<ScenarioResult[]> {
  const helperApp = helperAppPath(o);
  const results: ScenarioResult[] = [];
  const root = makeRunDir();
  const home = homeIn(root);
  const work = join(root, "w");
  mkdirSync(home);
  mkdirSync(work);
  const f: Fixtures = { runId: `cu-live-${process.pid}-${Date.now()}`, logPath: join(root, "fixture.jsonl"), seq: 0 };
  writeFileSync(f.logPath, "");
  const clipboard = sh("pbpaste", []).stdout;   // text only; restored at the end (cmd+c in a scenario overwrites it)
  let monitor: LineProcess<MonitorSample> | undefined;
  let probe: LineProcess<ProbeEvent> | undefined;
  let daemon: Awaited<ReturnType<typeof startLiveDaemon>> | undefined;
  let helperPid: number | undefined;
  let client: DaemonClient | undefined;
  let realApps: RealAppsRun | undefined;
  let baseline: FocusBaseline | undefined;
  let offspaceMethod = "?";
  let inputWatchFrom = Number.POSITIVE_INFINITY;
  const abortIfInput = (): void => {
    const hits = monitor === undefined ? [] : hidInputTimes(monitor.items, inputWatchFrom, Date.now());
    if (hits.length > 0) throw new Aborted(`real keyboard/mouse input at ${new Date(hits[0]!).toISOString()} — the run was stopped so nothing acts against you`);
  };
  try {
    // ── setup ──────────────────────────────────────────────────────────────────────────────────────────────────
    monitor = new LineProcess<MonitorSample>(spawn(built.tool, ["monitor", "--interval-ms", String(MONITOR_INTERVAL_MS)], { stdio: ["pipe", "pipe", "pipe"] }), parseMonitorLine);
    await until("the monitor's first sample", 5_000, () => monitor!.items.length > 0);
    const spaceBefore = monitor.items.at(-1)!.space;
    log("launching the user's app and the fixture…");
    launchFixture(built.fixtureUser, "user", f, false);
    f.userPid = Number((await until("the user's app", 15_000, () => fixtureEvents(f).find((e) => e.role === "user" && e.ev === "launched"))).pid);
    launchFixture(built.fixtureMain, "main", f, true);
    f.mainPid = Number((await until("the fixture", 15_000, () => fixtureEvents(f).find((e) => e.role === "main" && e.ev === "launched"))).pid);
    await until("the user's app frontmost", 10_000, () => monitor!.items.at(-1)?.frontPid === f.userPid);
    // The off-Space window: the fixture moves its OWN window to another regular Space (an existing desktop, else one
    // it creates — private SkyLight, which may be allowed for one's own connection), falling back to full screen
    // (its own Space; macOS switches to it, and activating the user's app brings the user back).
    log("putting a fixture window on another Space…");
    await postCommand(built.tool, f, "main", "offspace", {}, 15_000);
    const placed = await until("the fixture's off-Space window", 15_000, () => fixtureEvents(f).find((e) => e.role === "main" && e.ev === "offspace"));
    offspaceMethod = String(placed.method);
    log(`off-Space window: ${offspaceMethod}${placed.error ? ` (earlier attempts: ${String(placed.error)})` : ""}`);
    await sleep(800);
    await postCommand(built.tool, f, "user", "activate");
    await until("your Space and the user's app back in front", 10_000, () => {
      const s = monitor!.items.at(-1);
      return s !== undefined && s.frontPid === f.userPid && (spaceBefore === null || s.space === spaceBefore) ? s : undefined;
    });
    await sleep(500);
    const now = monitor.items.at(-1)!;
    baseline = { frontPid: f.userPid, front: now.front, space: now.space };
    log(`baseline: frontmost ${baseline.front} (pid ${baseline.frontPid}), Space ${baseline.space ?? "?"}`);

    log("starting the live daemon and a dev helper instance for its temp home…");
    daemon = await startLiveDaemon(built, home);
    const socket = join(home, "run", "computer-use.sock");
    const helperExe = join(helperApp, "Contents", "MacOS", "Winter Computer Use Dev");
    const helpersBefore = new Set(pidsOf(helperExe));
    const opened = sh("open", ["-n", "-g", "-j", "--env", `WINTER_CU_HOME=${home}`, "-a", helperApp]);
    if (opened.status !== 0) throw new Error(`open the dev helper failed: ${opened.stderr.trim()}`);
    await until("the helper's socket", 15_000, () => existsSync(socket));
    helperPid = await until("the helper instance's pid", 5_000, () => {
      // The process holding the socket, confirmed as a dev helper; else the one dev helper that was not running before.
      const byPath = sh("lsof", ["-t", "--", socket]).stdout.trim().split("\n").map(Number).find((p) => Number.isInteger(p) && p > 0 && pidsOf(helperExe).includes(p));
      const fresh = pidsOf(helperExe).filter((p) => !helpersBefore.has(p));
      return byPath ?? (fresh.length === 1 ? fresh[0] : undefined);
    });
    log(`helper instance pid ${helperPid}`);
    client = await DaemonClient.connect(daemon.socket);
    await client.hello(readFileSync(join(home, "test-secrets", "harness-token"), "utf8").trim(), "cu-live");
    const mainSid = await openSession(client, work, "bypass");
    const askSid = await openSession(client, work, "ask");
    probe = new LineProcess<ProbeEvent>(spawn(built.viewProbe, ["--socket", socket, "--home", home, "--session", mainSid, "--max-fps", "10", "--max-width", "480"], { stdio: ["pipe", "pipe", "pipe"] }),
      (l) => { try { return JSON.parse(l) as ProbeEvent; } catch { return undefined; } });
    await until("the mirror probe's subscription", 10_000, () => {
      const err = probe!.items.find((p) => p.ev === "error");
      if (err !== undefined) throw new Error(`the view probe failed: ${JSON.stringify(err)}`);
      return probe!.items.some((p) => p.ev === "subscribed");
    });
    if (o.realApps) {
      realApps = realAppsPreflight(root, log);
      // Opening documents can bring an app forward (that is part of what is tested later): give the user back
      // their app before the scenarios start.
      await sleep(2_000);
      await postCommand(built.tool, f, "user", "activate");
      await until("the user's app frontmost again", 10_000, () => monitor!.items.at(-1)?.frontPid === baseline!.frontPid);
    }
    inputWatchFrom = Date.now();

    // ── scenarios ──────────────────────────────────────────────────────────────────────────────────────────────
    const scenarios = [...SCENARIOS, ...(o.realApps ? REAL_APP_SCENARIOS : [])].filter((s) => o.only === undefined || s.name.toLowerCase().includes(o.only.toLowerCase()));
    for (const s of scenarios) {
      const t0 = Date.now();
      try {
        abortIfInput();
        for (const c of s.before ?? []) await postCommand(built.tool, f, c.role, c.cmd, c.args ?? {});
        const since = Date.now();
        const sid = s.session === "ask" ? askSid : mainSid;
        const timeout = s.timeoutMs ?? 60_000;
        const turn = await runTurn(client, sid, computerV2Message(scriptOf(s), timeout), timeout + 60_000, s.answer);
        const t1 = Date.now();
        // HID input DURING the action is this scenario's failure (a rung-4 fallback took the real pointer — or it was
        // you); after it, it stops the run.
        const during = hidInputTimes(monitor.items, since, t1);
        inputWatchFrom = t1;
        while (Date.now() < t1 + WATCH_AFTER_MS) { abortIfInput(); await sleep(50); }
        const state = s.dump === true ? await dumpState(built.tool, f) : undefined;
        const events = fixtureEvents(f);
        const checks = s.verify({
          output: turn.output, isError: turn.isError, facts: markerFacts(turn.output), events, since,
          ...(state === undefined ? {} : { state }), probe: probe.items.filter((p) => p.t >= since), metrics: readMetrics(home, since),
          shots: shotsSince(built.tool, home, since),
        });
        if (s.session === "ask") checks.push(...cardChecks(turn.cards));
        checks.push(check("no keyboard/pointer input during the action (no rung-4 fallback)", during.length === 0, `HID input at +${during.map((t) => t - since).join(", +")} ms`));
        const focus = focusChecks(monitor.items, since, t1 + WATCH_AFTER_MS, baseline, s.allowExcursionMs);
        checks.push(...focus.checks);
        // Whether the deliberate self-activation REALLY took (macOS 14+ may refuse it) — else the scenario proves less.
        const steals = events.filter((e) => e.role === "main" && e.ev === "activated" && e.t >= since);
        const note = s.allowExcursionMs === undefined ? (s.name.startsWith("bind off-Space") ? `off-Space by ${offspaceMethod}` : undefined)
          : steals.length === 0 ? "no steal attempt was logged"
            : `steal ${steals.some((e) => e.took === true) ? "TOOK" : "did not take (macOS refused the activation)"}; your app was away ${focus.longestAwayMs} ms`;
        results.push({ name: s.name, group: s.group, status: statusOf(checks), ms: Date.now() - t0, checks, ...(note === undefined ? {} : { note }) });
      } catch (err) {
        if (err instanceof Aborted) throw err;
        results.push({ name: s.name, group: s.group, status: "fail", ms: Date.now() - t0, checks: [check("ran", false, err instanceof Error ? err.message : String(err))] });
      }
      // Never carry a stolen focus into the next scenario.
      if (monitor.items.at(-1)?.frontPid !== baseline.frontPid) {
        await postCommand(built.tool, f, "user", "activate").catch(() => undefined);
        await sleep(500);
      }
    }

    // ── performance ────────────────────────────────────────────────────────────────────────────────────────────
    if (o.only === undefined) results.push(...await perf(built, f, helperPid, daemon.pid, probe, monitor, baseline, abortIfInput));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: err instanceof Aborted ? "ABORTED" : "setup", group: "run", status: "fail", ms: 0, checks: [check(err instanceof Aborted ? "no real input during the run" : "the run's setup", false, message)] });
  } finally {
    log("cleaning up…");
    const cleanup: Check[] = [];
    const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
      try { await fn(); cleanup.push(check(name, true)); } catch (err) { cleanup.push(check(name, false, err instanceof Error ? err.message : String(err))); }
    };
    if (realApps !== undefined) await step("closed what the real-apps scenarios opened", () => realApps!.cleanup());
    for (const role of ["main", "user"] as const) {
      const pid = role === "main" ? f.mainPid : f.userPid;
      if (pid === undefined) continue;
      await step(`quit the ${role === "main" ? "fixture" : "user's app"}`, async () => {
        await postCommand(built.tool, f, role, "quit", {}, 5_000).catch(() => undefined);
        const t0 = Date.now();
        while (processAlive(pid) && Date.now() - t0 < 8_000) await sleep(50);
        if (processAlive(pid)) { process.kill(pid, "SIGTERM"); await sleep(500); }
        if (processAlive(pid)) throw new Error(`pid ${pid} is still running`);
      });
    }
    if (probe !== undefined) await step("stopped the mirror probe", () => probe!.stop());
    client?.close();
    if (daemon !== undefined) await step("stopped the live daemon", () => daemon!.proc.stop(10_000));
    if (helperPid !== undefined) await step("quit the helper instance", async () => {
      try { process.kill(helperPid!, "SIGTERM"); } catch { /* gone */ }
      const t0 = Date.now();
      while (processAlive(helperPid!) && Date.now() - t0 < 5_000) await sleep(50);
      if (processAlive(helperPid!)) throw new Error(`helper pid ${helperPid} is still running`);
    });
    if (clipboard.length > 0) await step("restored the clipboard's text", () => { sh("pbcopy", [], clipboard); });
    if (monitor !== undefined && baseline !== undefined) {
      await sleep(800);
      const last = monitor.items.at(-1);
      cleanup.push(check("you are back on your Space", last === undefined || baseline.space === null || last.space === baseline.space, `Space ${last?.space}`));
    }
    await monitor?.stop();
    if (!o.keepTemp) rmSync(root, { recursive: true, force: true });
    else log(`kept ${root}`);
    results.push({ name: "cleanup", group: "run", status: statusOf(cleanup), ms: 0, checks: cleanup });
  }
  return results;
}

function readMetrics(home: string, since: number): Record<string, unknown>[] {
  try {
    return readFileSync(join(home, "logs", "automation-metrics.jsonl"), "utf8").split("\n").flatMap((l) => {
      try { const o = JSON.parse(l) as Record<string, unknown>; return typeof o.ts === "number" && o.ts >= since ? [o] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function cardChecks(cards: readonly SessionEvent[]): Check[] {
  const c = cards[0] as (SessionEvent & { summary?: string; toolName?: string; options?: Array<{ id: string }> }) | undefined;
  return [
    check("the per-app card was raised", c !== undefined, "no approval_requested"),
    check("it names the app and its bundle id", c?.summary === expectedCardSummary(), String(c?.summary)),
    check("it offers once / this session / always", JSON.stringify((c?.options ?? []).map((x) => x.id)) === JSON.stringify(["once", "session", "always"]), JSON.stringify(c?.options)),
    check("one card for the call", cards.length === 1, `${cards.length} cards`),
  ];
}

/** The focus check: nothing changes — or, for a scenario that provokes a self-activation, one short excursion back. */
function focusChecks(samples: readonly MonitorSample[], from: number, to: number, base: FocusBaseline, allowExcursionMs?: number): { checks: Check[]; longestAwayMs: number } {
  const v = focusViolations(samples, from, to, base);
  const lastInWindow = samples.filter((s) => s.t >= from && s.t <= to).at(-1);
  if (allowExcursionMs === undefined) {
    return { checks: [check("your frontmost app and Space never changed (sampled every 20 ms, until 3 s after)", v.length === 0, describeViolations(v, from))], longestAwayMs: 0 };
  }
  let longest = 0;
  let start: number | undefined;
  let prevT: number | undefined;
  for (const s of samples.filter((x) => x.t >= from && x.t <= to)) {
    const bad = v.some((x) => x.t === s.t);
    if (bad && start === undefined) start = s.t;
    if (!bad && start !== undefined) { longest = Math.max(longest, s.t - start); start = undefined; }
    prevT = s.t;
  }
  if (start !== undefined && prevT !== undefined) longest = Math.max(longest, prevT - start + 1);
  return {
    checks: [
      check(`any jump away from your app was undone within ${allowExcursionMs} ms`, longest <= allowExcursionMs, `away for ${longest} ms: ${describeViolations(v, from)}`),
      check("your app is frontmost again afterwards", lastInWindow === undefined || lastInWindow.frontPid === base.frontPid, `frontmost pid ${lastInWindow?.frontPid}`),
    ],
    longestAwayMs: longest,
  };
}

async function perf(built: Built, f: Fixtures, helperPid: number, daemonPid: number, probe: LineProcess<ProbeEvent>, monitor: LineProcess<MonitorSample>, base: FocusBaseline, abortIfInput: () => void): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  // Streaming: the canvas animates, its window is bound, the probe subscribes to frames.
  let t0 = Date.now();
  await postCommand(built.tool, f, "main", "animate", { on: true });
  await sleep(2_000);
  const stream = summarizeTop(await topDelta(helperPid, 2, 5), 5);
  await postCommand(built.tool, f, "main", "animate", { on: false });
  abortIfInput();
  const framesWhileStreaming = probe.items.filter((p) => p.ev === "frame" && p.t >= t0).length;
  out.push({
    name: "helper CPU while streaming a changing window", group: "perf", ms: Date.now() - t0,
    status: stream !== undefined && stream.cpuMean <= LIMITS.streamCpu && framesWhileStreaming > 0 ? "pass" : "fail",
    checks: [check("frames streamed", framesWhileStreaming > 0, "no frames"), check(`helper CPU ≤ ${LIMITS.streamCpu}%`, stream !== undefined && stream.cpuMean <= LIMITS.streamCpu, JSON.stringify(stream))],
    note: stream === undefined ? undefined : `helper ${stream.cpuMean.toFixed(1)}% CPU (max ${stream.cpuMax.toFixed(1)}%), ${framesWhileStreaming} frames`,
  });
  // Idle: no subscriber, nothing running.
  await probe.stop();
  await sleep(5_000);
  t0 = Date.now();
  const [helperIdle, daemonIdle] = await Promise.all([topDelta(helperPid, 3, 5), topDelta(daemonPid, 3, 5)]);
  abortIfInput();
  for (const [who, samples] of [["helper", helperIdle], ["daemon", daemonIdle]] as const) {
    const s = summarizeTop(samples, 5);
    const checks = [
      check(`${who} idle CPU ≤ ${LIMITS.idleCpu}%`, s !== undefined && s.cpuMean <= LIMITS.idleCpu, JSON.stringify(s)),
      check(`${who} idle wakeups ≤ ${LIMITS.idleWakeups}/s`, s !== undefined && s.wakeupsPerSecondMax <= LIMITS.idleWakeups, JSON.stringify(s)),
    ];
    out.push({ name: `${who} idle after the scenarios`, group: "perf", ms: Date.now() - t0, status: statusOf(checks), checks, note: s === undefined ? undefined : `${s.cpuMean.toFixed(2)}% CPU, ${s.wakeupsPerSecondMax.toFixed(1)} wakeups/s` });
  }
  const v = focusViolations(monitor.items, t0, Date.now(), base);
  out.push({ name: "focus unchanged through the perf phase", group: "perf", ms: 0, status: v.length === 0 ? "pass" : "fail", checks: [check("unchanged", v.length === 0, describeViolations(v, t0))] });
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  if (process.platform !== "darwin") throw new Error("macOS only");
  if (!o.dryRun && process.env.WINTER_CU_LIVE_TESTS !== "1") {
    console.error("e2e:cu-live: refusing to start — this suite takes over the screen. Set WINTER_CU_LIVE_TESTS=1 to run it (or pass --dry-run).");
    process.exit(2);
  }
  const built = buildAll(log);
  const results = o.dryRun ? await dryRun(built, o) : await (async () => {
    console.error([
      "",
      "  ComputerV2 LIVE end-to-end suite",
      "  It uses the screen for about 2-3 minutes (longer with --real-apps): windows appear, one goes full screen on",
      "  its own Space and you are brought back to yours. DON'T type, click or move the mouse until it finishes —",
      "  real input stops the run. Your clipboard's text is restored at the end (rich clipboard content is not).",
      "  Start it from a regular desktop, not from a full-screen app (the user's app must open on your Space).",
      "  Nothing touches ~/.winter*, the Keychain, or your own Winter.",
      "",
    ].join("\n"));
    if (!o.yes) for (let i = 5; i > 0; i--) { process.stderr.write(`  starting in ${i}… (ctrl+C to cancel)\r`); await sleep(1_000); }
    process.stderr.write("\n");
    return await liveRun(built, o);
  })();
  console.log(renderTable(results));
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`e2e:cu-live: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
